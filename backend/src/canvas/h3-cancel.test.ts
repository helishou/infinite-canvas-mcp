import assert from "node:assert/strict";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasH3Runner } from "./h3-runner.js";

test("取消连续父任务停止当前和后续Clip，不取消其他并发父任务", async (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [
        { id: "first", type: "minimax-h3", metadata: { segments: [{ id: "a", mode: "t2v", prompt: "A" }, { id: "b", mode: "t2v", prompt: "B" }] } },
        { id: "other", type: "minimax-h3", metadata: { segments: [{ id: "c", mode: "t2v", prompt: "C" }] } },
    ], connections: [] });
    const stores = createStores(db);
    const submitted: Array<{ id: string; nodeId: string }> = [];
    const cancelled: string[] = [];
    const comfy = {
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
            const child = stores.tasks.create(id!, "comfyui:minimax-h3", input, params);
            submitted.push({ id: child.id, nodeId: String((params.canvasBinding as Record<string, unknown>).nodeId) });
            onCreated?.(child);
            return stores.tasks.update(child.id, { status: "running" });
        },
        cancel(id: string) { cancelled.push(id); return stores.tasks.update(id, { status: "cancelled" }); },
    };
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, {} as never);
    const first = runner.start({ projectId: "p", nodeId: "first", segmentId: "a", runFromCurrent: true }, "parent-first");
    const other = runner.start({ projectId: "p", nodeId: "other", segmentId: "c" }, "parent-other");
    for (let i = 0; i < 100 && submitted.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(submitted.length, 2);
    const firstChild = submitted.find((item) => item.nodeId === "first")!;
    const otherChild = submitted.find((item) => item.nodeId === "other")!;
    assert.equal(runner.cancel(first.id).status, "cancelled");
    assert.deepEqual(cancelled, [firstChild.id]);
    assert.equal(db.getTask(other.id)?.status, "running");
    const media = stores.media.store(Buffer.from("test-video"), { name: "other.mp4", mimeType: "video/mp4", category: "output" });
    stores.tasks.update(otherChild.id, { status: "succeeded", progress: 1, result: { media: [{ url: stores.media.url(media), storageKey: media.storageKey, mimeType: "video/mp4" }] } });
    for (let i = 0; i < 200 && db.getTask(other.id)?.status !== "succeeded"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(db.getTask(other.id)?.status, "succeeded");
    assert.equal(db.getTask(first.id)?.status, "cancelled");
    assert.equal(submitted.length, 2, "取消不能提交后续Clip或重新生成");
});
