import assert from "node:assert/strict";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasH3Runner } from "./h3-runner.js";

test("单独运行下一段追加尾帧参考，保留保存模式且不启用潜空间续写", async (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const stores = createStores(db);
    const previous = stores.media.store(Buffer.from("previous-video"), { name: "previous.mp4", mimeType: "video/mp4", category: "output" });
    const tail = stores.media.store(Buffer.from("captured-image"), { name: "tail.png", mimeType: "image/png", category: "input" });
    db.createCanvasProject({ id: "tail-project", nodes: [{ id: "h3", type: "minimax-h3", metadata: { segments: [
        { id: "previous", mode: "t2v", prompt: "Previous shot", tailFrameContinuation: true, motionContextEnabled: false, result: stores.media.url(previous), resultStorageKey: previous.storageKey },
        { id: "next", mode: "t2v", prompt: "The next shot follows its own camera plan." },
    ] } }], connections: [] });
    const submitted: Array<{ input: Record<string, unknown>; params: Record<string, unknown> }> = [];
    const comfy = {
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
            submitted.push({ input, params });
            const child = stores.tasks.create(id!, "comfyui:minimax-h3", input, params);
            onCreated?.(child);
            const output = stores.media.store(Buffer.from("next-video"), { name: "next.mp4", mimeType: "video/mp4", category: "output" });
            return stores.tasks.update(child.id, { status: "succeeded", progress: 1, result: { media: [{ url: stores.media.url(output), storageKey: output.storageKey, mimeType: "video/mp4" }] } });
        },
        cancel() {},
    };
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, { ready: () => false } as never);
    Object.assign(runner, { captureTailFrame: async (source: string) => { assert.equal(source, previous.filePath); return tail; } });
    const parent = runner.start({ projectId: "tail-project", nodeId: "h3", segmentId: "next" }, "tail-parent");
    for (let i = 0; i < 100 && !["succeeded", "failed"].includes(db.getTask(parent.id)?.status || ""); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(db.getTask(parent.id)?.status, "succeeded", db.getTask(parent.id)?.error || "task did not finish");
    assert.equal(submitted.length, 1);
    assert.deepEqual(submitted[0].input.references, [tail.filePath]);
    assert.equal(submitted[0].params.mode, "ref2va");
    assert.equal(submitted[0].params.motionContextEnabled, false);
    assert.equal(submitted[0].input.video, undefined);
    assert.match(String(submitted[0].input.prompt), /follows its own camera plan/);
    assert.match(String(submitted[0].input.prompt), /tail frame takes priority for the first-frame state/);
    const log = stores.logs.list({ projectId: "tail-project", nodeId: "h3", segmentId: "next", limit: 1 })[0];
    assert.equal((log.params.submission as Record<string, any>).actualReferences[0].role, "motion_reference");
    assert.equal((log.params.submission as Record<string, any>).actualReferences[0].runtime, true);
    assert.deepEqual((log.params.submission as Record<string, any>).editableReferences, []);
    assert.equal((log.params.submission as Record<string, any>).authoredPrompt, "The next shot follows its own camera plan.");
    assert.equal((log.params.submission as Record<string, any>).continuation.requestedMode, "t2v");
    assert.equal((log.params.submission as Record<string, any>).continuation.runtimeMode, "ref2va");
    const next = (stores.projects.get("tail-project")!.nodes as any[])[0].metadata.segments[1];
    assert.equal(next.mode, "t2v");
    assert.equal(next.prompt, "The next shot follows its own camera plan.");
    assert.equal(next.referenceBindings?.length || 0, 0, "运行时尾帧不能回写为参考绑定");
    assert.equal(next.refItems?.length || 0, 0);
});
