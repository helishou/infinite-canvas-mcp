import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasH3Runner } from "./h3-runner.js";
const localProvider = () => ({ ready: () => false, queue: { select: () => "local", unreserve() {} } });

/**
 * 画幅下发：段的 aspectRatio=16:9 + megapixels=1.8 必须换算成 width/height
 * 随生成请求提交给引擎。否则引擎按模型默认 9:16 出片，段上写 16:9 也不生效。
 */
function fixture(t: TestContext, aspectRatio: string, megapixels: number) {
    const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "h3-aspect-"));
    const file = join(directory, "tasks.sqlite");
    const db = new BackendDatabase(file);
    const stores = createStores(db);
    const events = new BackendEventBus();
    stores.projects.create({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        { id: "clip-a", prompt: "A bell.", mode: "t2v", duration: 4, aspectRatio, megapixels },
    ] } }], connections: [] });
    let captured: Record<string, unknown> | null = null;
    const dispatcher = {
        start(input: Record<string, unknown>) {
            captured = (input.params || {}) as Record<string, unknown>;
            const child = stores.tasks.create(String(input.clientTaskId), "canvas-video", {}, { parentTaskId: input.params?.parentTaskId });
            stores.media.store(Buffer.from("fake"), { name: "a.mp4", storageKey: "video:a", mimeType: "video/mp4", category: "output" });
            stores.tasks.update(child.id, { status: "succeeded", result: { media: [{ url: "/media/a.mp4", storageKey: "video:a" }] } });
            return { taskId: child.id };
        },
        generationSettings() { return {}; },
        resume() {}, cancel() {},
    };
    const runner = new CanvasH3Runner(stores, events, dispatcher as never, localProvider() as never);
    t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
    return { runner, stores, get captured() { return captured; } };
}

async function settle(f: ReturnType<typeof fixture>, taskId: string) {
    for (let i = 0; i < 200; i++) {
        const task = f.stores.tasks.get(taskId);
        if (task && ["succeeded", "failed", "cancelled"].includes(task.status)) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("task did not settle");
}

test("16:9 + 1.8MP 段的画幅换算成 width/height 提交给引擎", async (t) => {
    const f = fixture(t, "16:9", 1.8);
    const task = f.runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-a" } as never, "aspect-16x9");
    await settle(f, task.id);
    assert.ok(f.captured, "应捕获到提交给 dispatcher 的 params");
    assert.equal(f.captured!.width, 1824);
    assert.equal(f.captured!.height, 1024);
});

test("9:16 + 1.8MP 段换算成竖屏 width/height", async (t) => {
    const f = fixture(t, "9:16", 1.8);
    const task = f.runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-a" } as never, "aspect-9x16");
    await settle(f, task.id);
    assert.ok(f.captured);
    assert.equal(f.captured!.width, 1024);
    assert.equal(f.captured!.height, 1824);
});
