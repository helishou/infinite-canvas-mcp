import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasH3Runner } from "./h3-runner.js";
import { buildNativeNanFengV15Workflow } from "../comfyui/bridge.js";

function fixture(t: TestContext, segments: Array<Record<string, unknown>>) {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: segments.map((segment) => ({ prompt: "A bell.", mode: "t2v", ...segment })) } }], connections: [] });
    const stores = createStores(db);
    const submitted: Array<Record<string, unknown>> = [];
    const comfy = {
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
            const child = stores.tasks.create(id!, "comfyui:minimax-h3", input, params);
            submitted.push(structuredClone(params));
            onCreated?.(child);
            return stores.tasks.update(child.id, { status: "succeeded", progress: 1, result: { media: [{ url: `/media/${child.id}`, storageKey: child.id, mimeType: "video/mp4" }] } });
        },
    };
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, {} as never);
    const settle = async (id: string) => {
        for (let i = 0; i < 200 && !["succeeded", "failed"].includes(db.getTask(id)!.status); i++) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(db.getTask(id)?.status, "succeeded", db.getTask(id)?.error || "runner timeout");
    };
    const clips = () => (stores.projects.get("p")!.nodes as Array<{ metadata: { segments: Array<Record<string, unknown>> } }>)[0].metadata.segments;
    return { db, stores, runner, submitted, settle, clips };
}

test("random mode rerolls copied seeds per Clip and per new run, while duplicate requests keep the frozen seed", async (t) => {
    const { db, runner, submitted, settle, clips } = fixture(t, [
        { id: "a", noiseSeedMode: "random", seed: 123, noiseSeed: 123 },
        { id: "b", noiseSeedMode: "random", seed: 123, noiseSeed: 123 },
    ]);
    const input = { projectId: "p", nodeId: "n", segmentId: "a", runFromCurrent: true, skipCompleted: false, params: { noiseSeedMode: "random", seed: 123 } };
    const first = runner.start(input, "first");
    const frozen = structuredClone(db.getTask(first.id)!.input);
    assert.equal(runner.start(input, "duplicate").id, first.id);
    await settle(first.id);
    assert.equal(submitted.length, 2);
    assert.notEqual(submitted[0].seed, 123);
    assert.notEqual(submitted[0].seed, submitted[1].seed);
    assert.deepEqual(submitted.map((params) => params.seed), clips().map((clip) => clip.seed));
    for (const params of submitted) {
        assert.ok(Number.isSafeInteger(params.seed) && Number(params.seed) > 0);
        assert.equal(params.seed, params.noiseSeed);
        const graph = await buildNativeNanFengV15Workflow({ prompt: "A bell." }, params, async (value) => value, "http://comfy.local", new AbortController().signal);
        assert.equal(graph.nf_v15.inputs["随机种子"], params.seed);
    }
    const second = runner.start(input, "second");
    await settle(second.id);
    assert.equal(submitted.length, 4, "a new random run must not reuse the previous cached MP4");
    assert.notEqual(submitted[2].seed, submitted[0].seed);
    assert.notEqual(submitted[3].seed, submitted[1].seed);
    assert.deepEqual(db.getTask(first.id)!.input, frozen);
    assert.equal(runner.start(input, "first").id, first.id);
    assert.equal(submitted.length, 4);
});

test("fixed zero and legacy explicit seeds survive unrelated overrides and repeated runs", async (t) => {
    const { runner, submitted, settle, clips } = fixture(t, [
        { id: "a", noiseSeedMode: "fixed", seed: 0 },
        { id: "b", seed: 456 },
    ]);
    const input = { projectId: "p", nodeId: "n", segmentId: "a", runFromCurrent: true, skipCompleted: false, forceRegenerate: true, params: { loraSlots: [] } };
    await settle(runner.start(input, "first").id);
    await settle(runner.start(input, "second").id);
    assert.deepEqual(submitted.map((params) => params.seed), [0, 456, 0, 456]);
    assert.deepEqual(clips().map((clip) => clip.noiseSeedMode), ["fixed", "fixed"]);
});

test("default random mode resolves a seed separately for every Clip", async (t) => {
    const { stores, runner, submitted, settle, clips } = fixture(t, [{ id: "a" }, { id: "b" }]);
    stores.settings.set("plugin:minimax-h3:defaults:v1", { noiseSeedMode: "random", seed: 789 });
    await settle(runner.start({ projectId: "p", nodeId: "n", segmentId: "a", runFromCurrent: true }, "defaults").id);
    assert.notEqual(submitted[0].seed, 789);
    assert.notEqual(submitted[0].seed, submitted[1].seed);
    assert.deepEqual(submitted.map((params) => params.seed), clips().map((clip) => clip.seed));
});
