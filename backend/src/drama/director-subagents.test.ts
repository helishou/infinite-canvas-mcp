import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { BackendEventBus } from "../events.js";
import { DirectorSubagents } from "./director-subagents.js";
import type { ProductionAgentRequest } from "@basketikun/canvas-agent/agent/production";
import { EpisodeProductionService } from "./production.js";
import { compilationHash } from "@basketikun/canvas-agent/drama/compilation-scope";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";

const spawn = { action: "spawn", projectId: "canvas", parentThreadId: "director", operationId: "task-a", title: "核对连续性", role: "continuity", prompt: "只检查所提供的事实", context: "冻结源稿😀" } as const;
function fixture(t: test.TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "director-subagents-"));
    const db = new BackendDatabase(path.join(root, "fixture.sqlite"));
    db.createCanvasProject({ id: "canvas", title: "fixture", nodes: [], connections: [] });
    const stores = createStores(db), events = new BackendEventBus();
    const calls: ProductionAgentRequest[] = [];
    const settles: Array<(output: unknown) => void> = [];
    const service = new DirectorSubagents(stores, { run: request => { calls.push(request); return new Promise(resolve => settles.push(output => resolve({ threadId: "worker", output }))); } }, events, root);
    t.after(() => { db.close(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true }); });
    return { service, stores, events, calls, settles, db, root };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const read = (taskId: string) => ({ action: "get", projectId: "canvas", parentThreadId: "director", taskId });

function formalFixture(t: test.TestContext) {
    const fixtureValue = fixture(t), { db, events, root, stores, calls, settles } = fixtureValue;
    const production = new EpisodeProductionService(db, events, root, true, () => {});
    const source = { brief: "confirmed", script_scenes: [{ id: "A", scene_id: "ROOM" }, { id: "B", scene_id: "ROOM" }],
        shots: [{ id: "SA", source_scene_id: "A", scene_id: "ROOM", title: "A", start_frame: 0, end_frame: 120 }, { id: "SB", source_scene_id: "B", scene_id: "ROOM", title: "B", start_frame: 120, end_frame: 240 }], segments: [], asset_plan: [], asset_cards: [] };
    const director: DirectorProduction = { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "test" }, source, sourceHash: compilationHash(source), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], workflow: {}, unresolved: [], executionAuthorized: false };
    production.edit("canvas", { operationId: "seed", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const service = new DirectorSubagents(stores, { run: request => { calls.push(request); return new Promise(resolve => settles.push(output => resolve({ threadId: "worker", output }))); } }, events, root, undefined, () => production);
    const bound = { ...spawn, role: "shots" as const, production: { kind: "canvas" as const, id: "canvas", expectedRevision: production.get("canvas").revision, scope: { sceneId: "A" } } };
    return { ...fixtureValue, service, production, bound };
}
const complete = { status: "complete", summary: "done", content: "建议", unresolved: [], cursor: "" };
const patchShot = (id: string, title: string) => ({ type: "patch_director_source", entity: "shot", id, patch: { title } });

test("interactive continuation enforces frozen mode, original authorization and explicit intent", async t => {
    const { service, production, bound, stores, calls, settles } = formalFixture(t);
    production.edit("canvas", { operationId: "interactive", expectedRevision: production.get("canvas").revision, ops: [{ type: "set_director_workflow", patch: { contentDeliveryMode: "interactive_segment" } }] });
    const receipt = service.execute({ ...bound, production: { ...bound.production, expectedRevision: production.get("canvas").revision } }) as any;
    const taskId = receipt.task.taskId;
    calls[0].onThread("worker"); calls[0].onTurn?.("first"); settles[0]({ ...complete, status: "partial", cursor: "next" }); await tick();
    const policy = stores.tasks.get(taskId)!.input.policy as any;
    assert.equal(policy.authorization.id, bound.operationId); assert.equal(policy.authorization.purpose, "creative_advice");
    assert.equal(receipt.task.contentDeliveryMode, "interactive_segment");
    assert.throws(() => service.execute({ ...read(taskId), action: "continue", operationId: "automatic" }), /CONFIRMATION_REQUIRED/);
    const command = { ...read(taskId), action: "continue", operationId: "human-next", continuationIntent: "explicit" };
    service.execute(command); assert.equal(calls.length, 2); settles[1]({ ...complete, status: "partial", cursor: "next-2" }); await tick();
    assert.equal(service.execute(command).replayed, true);
    assert.throws(() => service.execute({ ...command, continuationIntent: "automatic" }), /REUSE_MISMATCH/);
    production.edit("canvas", { operationId: "change-mode", expectedRevision: production.get("canvas").revision, ops: [{ type: "set_director_workflow", patch: { contentDeliveryMode: "auto_file_batch" } }] });
    assert.throws(() => service.execute({ ...command, operationId: "later" }), /POLICY_CHANGED/);
    assert.equal(calls.length, 2);
});

test("bound packages freeze formal input and modules; adoption is atomic, replayable and preserves chunk identity", async t => {
    const { service, production, bound, stores, calls, settles } = formalFixture(t);
    const receipt = service.execute(bound) as any;
    const taskId = receipt.task.taskId;
    const packet = stores.tasks.get(taskId)!.input.workPackage as any;
    assert.equal(packet.owner.id, "canvas"); assert.equal(packet.director.workflow.sceneWorks, undefined);
    assert.ok(calls[0].readRoots?.length); assert.match(calls[0].prompt, /正式冻结工作包/);
    for (const module of ["shots", "performance", "effects"]) assert.ok(calls[0].prompt.replaceAll("\\", "/").includes(`modules/${module}/SKILL.md ---`), `mandatory ${module} contract is preloaded into the request`);
    settles[0](complete); await tick();
    const first = service.execute({ ...read(taskId), view: "result", chunkBytes: 25 }) as any;
    // Unrelated source changes advance revision without invalidating scene A.
    production.edit("canvas", { operationId: "other-scene", expectedRevision: production.get("canvas").revision, ops: [patchShot("SB", "changed B")] });
    assert.equal((service.execute(read(taskId)) as any).task.validity, "current");
    const edit = { operationId: "adopt", expectedRevision: production.get("canvas").revision, ops: [patchShot("SA", "changed A")], adoptions: [{ taskId, artifactHash: first.task.artifactHash }] };
    assert.throws(() => production.edit("canvas", edit, undefined, false, () => { throw new Error("rollback evidence"); }), /rollback evidence/);
    assert.equal(stores.tasks.get(taskId)!.result?.adoption, undefined);
    assert.equal(production.get("canvas").revision, edit.expectedRevision);
    const adopted = production.edit("canvas", edit);
    assert.equal((stores.tasks.get(taskId)!.result?.adoption as any).revision, adopted.revision);
    assert.equal(production.edit("canvas", edit).replayed, true);
    assert.equal(production.get("canvas").revision, adopted.revision);
    assert.throws(() => production.edit("canvas", { ...edit, operationId: "duplicate", expectedRevision: adopted.revision }), /ALREADY_APPLIED/);
    assert.doesNotThrow(() => service.execute({ ...read(taskId), view: "result", chunkBytes: 25, cursor: first.chunk.nextCursor }));
});

test("adoption refuses changed dependencies, foreign edits, incomplete and unbound suggestions", async t => {
    const { service, production, bound, settles } = formalFixture(t);
    const a = service.execute(bound) as any; settles[0](complete); await tick();
    const adoption = { taskId: a.task.taskId, artifactHash: (service.execute(read(a.task.taskId)) as any).task.artifactHash };
    const revision = production.get("canvas").revision;
    assert.throws(() => production.edit("canvas", { operationId: "foreign", expectedRevision: revision, ops: [patchShot("SB", "bad")], adoptions: [adoption] }), /OUTSIDE_SCOPE/);
    production.edit("canvas", { operationId: "change", expectedRevision: revision, ops: [patchShot("SA", "new input")] });
    assert.equal((service.execute(read(a.task.taskId)) as any).task.validity, "stale");
    assert.throws(() => production.edit("canvas", { operationId: "stale", expectedRevision: production.get("canvas").revision, ops: [patchShot("SA", "bad")], adoptions: [adoption] }), /INPUT_CHANGED/);
    assert.throws(() => service.execute({ ...bound, operationId: "wrong-revision" }), /REVISION_CHANGED/);
    const unbound = service.execute({ ...spawn, operationId: "unbound" }) as any; settles[1](complete); await tick();
    assert.throws(() => production.edit("canvas", { operationId: "unbound-adopt", expectedRevision: production.get("canvas").revision, ops: [patchShot("SA", "bad")], adoptions: [{ taskId: unbound.task.taskId, artifactHash: (service.execute(read(unbound.task.taskId)) as any).task.artifactHash }] }), /OWNER_MISMATCH/);
    const partial = service.execute({ ...bound, operationId: "partial", production: { ...bound.production, expectedRevision: production.get("canvas").revision } }) as any;
    settles[2]({ ...complete, status: "partial", cursor: "next" }); await tick();
    assert.throws(() => production.edit("canvas", { operationId: "partial-adopt", expectedRevision: production.get("canvas").revision, ops: [patchShot("SA", "bad")], adoptions: [{ taskId: partial.task.taskId, artifactHash: (service.execute(read(partial.task.taskId)) as any).task.artifactHash }] }), /INCOMPLETE/);
});

test("partial continuation retains original thread, cursor and immutable history without duplicate turns", async t => {
    const { service, calls, settles } = fixture(t);
    const taskId = (service.execute(spawn) as any).task.taskId;
    calls[0].onThread("worker"); calls[0].onTurn?.("turn-1");
    settles[0]({ ...complete, status: "partial", cursor: "scene-2" }); await tick();
    const artifactHash = (service.execute(read(taskId)) as any).task.artifactHash;
    const command = { ...read(taskId), action: "continue", operationId: "next" };
    service.execute(command); assert.equal(calls.length, 2); assert.equal(calls[1].threadId, "worker"); assert.match(calls[1].prompt, /scene-2/);
    assert.equal(service.execute(command).replayed, true); assert.equal(calls.length, 2);
    settles[1](complete); await tick();
    const old = service.execute({ ...read(taskId), view: "result", artifactHash }) as any;
    assert.equal(old.result.status, "partial");
    assert.equal((service.execute({ ...read(taskId), view: "result" }) as any).result.status, "complete");
    assert.throws(() => service.execute({ ...command, operationId: "extra" }), /NOT_PARTIAL/);
});

test("startup reconciles more than ten tasks and recover reads the exact original turn without spawning", async t => {
    const { stores, events } = fixture(t);
    for (let index = 0; index < 13; index++) {
        const task = stores.tasks.create(`orphan-${index}`, "director-subagent", { projectId: "canvas", parentThreadId: "director", title: "lost", role: "story", sourceRevision: 0 }, {});
        stores.tasks.update(task.id, { status: "running", result: { workerThreadId: `worker-${index}`, workerTurnId: `turn-${index}` } });
    }
    let reads = 0;
    const service = new DirectorSubagents(stores, { run: async request => { reads++; assert.equal(request.recoverOutput, true); assert.equal(request.threadId, "worker-0"); assert.equal(request.turnId, "turn-0"); return { threadId: "worker-0", output: complete }; } }, events);
    service.reconcileStartup(); assert.equal(reads, 0);
    assert.equal(stores.tasks.list({ kind: "director-subagent" }).filter(task => task.status === "failed").length, 13);
    const command = { ...read("orphan-0"), action: "recover", operationId: "recover-original" };
    service.execute(command); await tick();
    assert.equal(reads, 1); assert.equal(stores.tasks.get("orphan-0")!.status, "succeeded");
    assert.equal(service.execute(command).replayed, true); assert.equal(reads, 1);
});

test("delegation persists intent once, rejects changed replays, and publishes scoped summary events", async t => {
    const { service, stores, calls, settles, events } = fixture(t);
    const receipt = service.execute(spawn) as any;
    assert.equal(receipt.replayed, false);
    assert.equal(calls.length, 1);
    assert.equal(service.execute(spawn).replayed, true);
    assert.equal(calls.length, 1);
    assert.throws(() => service.execute({ ...spawn, prompt: "different" }), /OPERATION_REUSE_MISMATCH/);
    const task = stores.tasks.get(receipt.task.taskId)!;
    assert.equal(task.input.context, spawn.context);
    calls[0].onThread("worker");
    assert.equal((service.execute(read(task.id)) as any).task.status, "running");
    settles[0]({ status: "needs_human", summary: "有一项未决", content: "建议核对鸡蛋的数量", unresolved: ["缺少前镜事实"] });
    await tick();
    const summary = service.execute(read(task.id)) as any;
    assert.equal(summary.task.status, "succeeded");
    assert.equal(summary.task.outcome, "needs_human");
    assert.equal(summary.result, undefined);
    assert.ok(!JSON.stringify(summary).includes(spawn.context));
    const allEvents = events.since();
    assert.ok(allEvents.every(event => !JSON.stringify(event.payload).includes("冻结源稿")));
    assert.equal((allEvents.at(-1)!.payload as any).parentThreadId, "director");
    assert.equal(stores.projects.get("canvas")!.revision, 0, "delegation never mutates the canvas");
});

test("task queries isolate director/project before pagination and persisted results survive service recreation", async t => {
    const { service, stores, calls, settles, events } = fixture(t);
    const a = service.execute(spawn) as any;
    service.execute({ ...spawn, operationId: "foreign", parentThreadId: "other" });
    const b = service.execute({ ...spawn, operationId: "second" }) as any;
    const page = service.execute({ action: "list", projectId: "canvas", parentThreadId: "director", limit: 1 }) as any;
    const next = service.execute({ action: "list", projectId: "canvas", parentThreadId: "director", limit: 1, offset: page.nextOffset }) as any;
    assert.deepEqual(new Set([page.tasks[0].taskId, next.tasks[0].taskId]), new Set([a.task.taskId, b.task.taskId]));
    assert.throws(() => service.execute({ ...read(a.task.taskId), parentThreadId: "other" }), /不属于/);
    assert.throws(() => service.execute({ ...read(a.task.taskId), projectId: "other" }), /不属于/);
    settles[0]({ status: "complete", summary: "done", content: "完整结果", unresolved: [] }); await tick();
    const recreated = new DirectorSubagents(stores, { run: async () => { throw new Error("must not rerun"); } }, events);
    assert.equal((recreated.execute({ ...read(a.task.taskId), view: "result" }) as any).result.content, "完整结果");
    assert.equal(recreated.execute(spawn).replayed, true);
    assert.equal(calls.length, 3);
});

test("long Unicode results round trip through hash-bound chunks without leaking into default reads", async t => {
    const { service, settles } = fixture(t);
    const receipt = service.execute(spawn) as any;
    const content = "连续性证据😀".repeat(12000);
    const output = { status: "complete", summary: "长结果", content, unresolved: [] };
    settles[0](output); await tick();
    assert.ok(JSON.stringify(service.execute(read(receipt.task.taskId))).length < 2000);
    let cursor: string | undefined, joined = "";
    do {
        const result = service.execute({ ...read(receipt.task.taskId), view: "result", chunkBytes: 4096, cursor }) as any;
        joined += result.chunk.text; cursor = result.chunk.nextCursor || undefined;
    } while (cursor);
    assert.equal(JSON.parse(joined).content, content);
    const first = service.execute({ ...read(receipt.task.taskId), view: "result", chunkBytes: 100 }) as any;
    const wrong = JSON.parse(Buffer.from(first.chunk.nextCursor, "base64url").toString()); wrong.resultHash = "wrong";
    assert.throws(() => service.execute({ ...read(receipt.task.taskId), view: "result", chunkBytes: 100, cursor: Buffer.from(JSON.stringify(wrong)).toString("base64url") }), /INVALID_CURSOR/);
});

test("invalid worker output is retained as a failure and a replay cannot restart it", async t => {
    const { service, settles, calls } = fixture(t);
    const receipt = service.execute(spawn) as any;
    settles[0]({ content: "missing required fields" }); await tick();
    assert.equal((service.execute(read(receipt.task.taskId)) as any).task.status, "failed");
    assert.equal(service.execute(spawn).replayed, true);
    assert.equal(calls.length, 1);
    assert.throws(() => service.execute({ ...spawn, operationId: undefined }), /必须提供/);
});

test("captured parent channel remains stable when defaults change before replay", t => {
    const { stores, events } = fixture(t);
    let model = "parent-channel::model", executions = 0;
    const service = new DirectorSubagents(stores, { run: () => { executions++; return new Promise(() => {}); } }, events, process.cwd(), () => model);
    const initial = service.execute(spawn) as any;
    assert.equal(initial.task.model, model);
    model = "new-channel::model";
    assert.equal((service.execute(spawn) as any).task.model, "parent-channel::model");
    assert.equal(executions, 1);
});

test("a later parent turn recovers the original receipt without changing its association or restarting", t => {
    const { service, calls } = fixture(t);
    const first = service.execute({ ...spawn, parentTurnId: "original-turn" }) as any;
    const recovered = service.execute({ ...spawn, parentTurnId: "recovery-turn" }) as any;
    assert.equal(recovered.replayed, true);
    assert.equal(recovered.task.taskId, first.task.taskId);
    assert.equal(recovered.task.parentTurnId, "original-turn");
    assert.equal(calls.length, 1);
});
