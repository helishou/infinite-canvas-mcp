import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { BackendDatabase, type RuntimeTask } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasH3Runner } from "./h3-runner.js";

type RunInput = Parameters<CanvasH3Runner["start"]>[0];
const request: RunInput = { projectId: "p", nodeId: "n", segmentId: "clip-a" };

async function waitFor(predicate: () => boolean, message: string) {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(predicate(), message);
    // Let the runner's finally/catch finish before closing a connection.
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function fixture(t: TestContext) {
    const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "h3-idempotency-"));
    const file = join(directory, "tasks.sqlite");
    let db = new BackendDatabase(file);
    let stores = createStores(db);
    let events = new BackendEventBus();
    const submitted: string[] = [];
    const releases: Array<() => void> = [];
    const runningParents = new Set<string>();
    stores.projects.create({ id: "p", nodes: ["n", "other"].map((id) => ({ id, type: "minimax-h3", metadata: { segments: [
        { id: "clip-a", prompt: "A bell.", mode: "t2v" },
        { id: "clip-b", prompt: "Another bell.", mode: "t2v" },
    ] } })), connections: [] });
    // Only the external execution boundary is replaced. Planning, task/log
    // persistence, binding, events and runner failure handling are all real.
    const comfy = {
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: RuntimeTask) => void) {
            const child = stores.tasks.create(id!, "comfyui:minimax-h3", input, params);
            submitted.push(child.id);
            runningParents.add(String(params.parentTaskId));
            onCreated?.(child);
            await new Promise<void>((resolve) => releases.push(resolve));
            return stores.tasks.update(child.id, { status: "failed", error: "isolated execution boundary: no generation" });
        },
        resume() { assert.fail("an idempotent start must not resume external execution"); },
        cancel() { assert.fail("an idempotent start must not cancel external execution"); },
    };
    const runner = () => new CanvasH3Runner(stores, events, comfy as never, {} as never);
    const settle = async () => {
        releases.splice(0).forEach((release) => release());
        for (const id of runningParents) await waitFor(() => stores.tasks.get(id)?.status === "failed", `parent ${id} did not settle`);
        runningParents.clear();
    };
    const snapshot = () => {
        const tasks = stores.tasks.list({ limit: 100 });
        assert.ok(tasks.length < 100, "fixture snapshot must include every task");
        return structuredClone({ projects: stores.projects.list(), tasks, logs: stores.logs.list(),
            taskEvents: tasks.map((task) => stores.tasks.events(task.id)), published: events.since(), media: stores.media.list() });
    };
    const reopen = () => {
        assert.equal(runningParents.size, 0, "settle the original runner before reopening its database");
        const originalConnection = db;
        db.close();
        assert.ok(statSync(file).size > 0, "must use a persisted file, not an in-memory database");
        db = new BackendDatabase(file);
        assert.notEqual(db, originalConnection);
        stores = createStores(db);
        events = new BackendEventBus();
        t.diagnostic(`closed and reopened file-backed BackendDatabase: ${file}`);
    };
    t.after(async () => {
        try { await settle(); } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
    });
    return { runner, submitted, settle, snapshot, reopen, get stores() { return stores; } };
}

function assertConflict(action: () => unknown, key: string) {
    assert.throws(action, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, "IDEMPOTENCY_CONFLICT");
        assert.equal(error.name, "H3IdempotencyConflictError");
        assert.ok(error.message.includes(key), "conflict must identify the reused key");
        return true;
    });
}

test("same key is at-most-once across runners and recovers frozen history after file DB reopen and draft changes", async (t) => {
    const f = fixture(t);
    const first = f.runner();
    const original = first.start(request, "persistent-key");
    await waitFor(() => f.submitted.length === 1, "first runner did not reach the execution boundary");
    const active = f.snapshot();
    // Missing params and {} are the same normalized caller intent. A fresh
    // runner has no in-memory dedup knowledge and must use the existing store.
    const second = f.runner();
    for (let i = 0; i < 3; i++) assert.deepEqual(second.start({ ...request, params: {} }, original.id), f.stores.tasks.get(original.id));
    assert.deepEqual(f.snapshot(), active, "active replay must not publish, bind, rewrite or create another task/log");
    assert.equal(f.submitted.length, 1);
    await f.settle();
    const historical = f.stores.tasks.get(original.id)!;
    assert.equal(historical.status, "failed");
    assert.ok(historical.input.runPlan, "caller intent is persisted alongside a frozen execution plan");
    const frozen = structuredClone(historical.input);
    f.stores.settings.set("plugin:minimax-h3:defaults:v1", { duration: 99, noiseSeedMode: "fixed", seed: 42 });
    f.stores.projects.applyOperations("p", undefined, [
        { type: "update_node", id: "n", metadata: { runtimeTaskId: "newer-parent", status: "loading" } },
        { type: "update_h3_segment", nodeId: "n", segmentId: "clip-a", patch: { prompt: "New draft, missing required image.", mode: "i2v", runtimeTaskId: "newer-child", parentTaskId: "newer-parent", status: "loading" } },
    ], { runtimeWrite: true });
    f.reopen();
    const restarted = f.runner();
    assert.deepEqual(f.stores.tasks.get(original.id), historical, "history survives a closed connection and fresh stores");
    let before = f.snapshot();
    assert.deepEqual(restarted.start(request, original.id), historical);
    assert.deepEqual(f.snapshot(), before, "changed defaults/draft/new binding must not be inspected or overwritten by historical replay");
    // Removing the original Clip makes today's preflight throw. Historical
    // recovery still succeeds and must not restore the removed Clip.
    f.stores.projects.applyOperations("p", undefined, [{ type: "delete_h3_segment", nodeId: "n", segmentId: "clip-a" }]);
    before = f.snapshot();
    assert.deepEqual(restarted.start({ ...request, params: {} }, original.id), historical);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.stores.tasks.get(original.id)!.input, frozen);
    assert.equal(f.submitted.length, 1);
    assert.equal(f.stores.tasks.list({ kind: "canvas-h3-run" }).length, 1);
    assert.equal(f.stores.tasks.list({ kind: "comfyui:minimax-h3" }).length, 1);
});

test("same key returns history even when its project no longer exists", async (t) => {
    const f = fixture(t);
    const original = f.runner().start(request, "deleted-project-key");
    await waitFor(() => f.submitted.length === 1, "execution boundary not reached");
    await f.settle();
    const historical = f.stores.tasks.get(original.id)!;
    f.stores.projects.delete("p");
    f.reopen();
    const before = f.snapshot();
    assert.deepEqual(f.runner().start(request, original.id), historical);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.submitted.length, 1);
});

test("same key with different target, params or request conflicts deterministically after file DB reopen", async (t) => {
    const f = fixture(t);
    const input: RunInput = { ...request, params: { duration: 4, custom: { a: 1, b: 2 } } };
    const original = f.runner().start(input, "conflict-key");
    await waitFor(() => f.submitted.length === 1, "execution boundary not reached");
    await f.settle();
    f.reopen();
    const restarted = f.runner();
    const before = f.snapshot();
    assert.deepEqual(restarted.start({ ...request, params: { custom: { b: 2, a: 1 }, duration: 4 } }, original.id), f.stores.tasks.get(original.id), "object key order does not change intent; frozen runPlan is not caller intent");
    const variants: Array<[string, RunInput]> = [
        ["different project, absent today", { ...input, projectId: "missing-project" }],
        ["different node", { ...input, nodeId: "other" }],
        ["different node selection", { ...input, nodeIds: ["n", "other"] }],
        ["different Clip", { ...input, segmentId: "clip-b" }],
        ["missing Clip", { ...input, segmentId: "missing-clip" }],
        ["different index", { ...input, segmentIndex: 1 }],
        ["run from current", { ...input, runFromCurrent: true }],
        ["skip completed", { ...input, skipCompleted: true }],
        ["force regenerate", { ...input, forceRegenerate: true }],
        ["different params", { ...input, params: { ...input.params, duration: 5 } }],
        ["different nested params", { ...input, params: { ...input.params, custom: { a: 1, b: 3 } } }],
        ["removed params", { ...input, params: undefined }],
        ["confirmation is not a replay", { ...input, params: { ...input.params, confirmSecondPass: true } }],
    ];
    for (const [name, variant] of variants) await t.test(name, () => {
        assertConflict(() => restarted.start(variant, original.id), original.id);
        assert.deepEqual(f.snapshot(), before, "conflict must preserve original task, plan, events, logs and both Clips");
        assert.equal(f.submitted.length, 1);
    });
});

test("key occupied by a non-H3 task rejects without returning or rewriting that task", (t) => {
    const f = fixture(t);
    const foreign = f.stores.tasks.create("foreign-key", "canvas-image", request, {});
    f.reopen();
    const before = f.snapshot();
    assertConflict(() => f.runner().start(request, foreign.id), foreign.id);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.stores.tasks.get(foreign.id), foreign);
    assert.equal(f.submitted.length, 0);
});

test("fresh confirmation submissions still require the original confirmation interface", (t) => {
    const f = fixture(t);
    const before = f.snapshot();
    assert.throws(() => f.runner().start({ ...request, params: { confirmSecondPass: true } }, "new-confirmation-key"), /确认接口/);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.submitted.length, 0);
});
