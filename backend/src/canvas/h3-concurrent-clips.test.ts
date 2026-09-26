import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasH3Runner } from "./h3-runner.js";

test("同一 H3 节点的两个 Clip 可同时运行，并各自保存父任务与子任务绑定", async (t: TestContext) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        { id: "clip-a", prompt: "A", mode: "t2v" },
        { id: "clip-b", prompt: "B", mode: "t2v" },
    ] } }], connections: [] });
    const stores = createStores(db);
    const releases: Array<() => void> = [];
    const submitted: string[] = [];
    const comfy = {
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
            const task = stores.tasks.create(id || `child-${submitted.length + 1}`, "comfyui:minimax-h3", input, params);
            submitted.push(task.id);
            onCreated?.(task);
            await new Promise<void>((resolve) => releases.push(resolve));
            stores.media.store(Buffer.from("fake-video"), { name: `${task.id}.mp4`, storageKey: task.id, mimeType: "video/mp4", category: "output" });
            return stores.tasks.update(task.id, { status: "succeeded", progress: 1, result: { media: [{ url: `/media/${task.id}`, storageKey: task.id, mimeType: "video/mp4" }] } });
        },
        cancel() {},
    };
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, {} as never);
    const taskA = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-a" }, "parent-a");
    const taskB = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-b" }, "parent-b");
    for (let i = 0; i < 100 && releases.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(submitted.length, 2, "两个不同 Clip 应能同时提交");

    const segment = (id: string) => {
        const node = (db.getCanvasProject("p")!.nodes as unknown as Array<{ metadata: { segments: Array<Record<string, unknown>> } }>)[0];
        return node.metadata.segments.find((item) => item.id === id)!;
    };
    assert.equal(segment("clip-a").parentTaskId, taskA.id);
    assert.equal(segment("clip-b").parentTaskId, taskB.id);
    assert.notEqual(segment("clip-a").runtimeTaskId, segment("clip-b").runtimeTaskId);

    releases.splice(0).forEach((release) => release());
    for (const id of [taskA.id, taskB.id]) {
        for (let i = 0; i < 100 && !["succeeded", "failed", "cancelled"].includes(db.getTask(id)?.status || ""); i++) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(db.getTask(id)?.status, "succeeded", db.getTask(id)?.error || "任务未成功");
    }
    assert.equal(segment("clip-a").status, "success");
    assert.equal(segment("clip-b").status, "success");
    assert.equal(segment("clip-a").parentTaskId, "");
    assert.equal(segment("clip-b").parentTaskId, "");
});

test("父任务失败只清理自己仍在 loading 的 Clip，另一 Clip 可继续完成", async (t: TestContext) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        { id: "clip-a", prompt: "A", mode: "t2v", result: "old-a.mp4" },
        { id: "clip-b", prompt: "B", mode: "t2v" },
    ] } }], connections: [] });
    const stores = createStores(db);
    let releaseB!: () => void;
    const waitB = new Promise<void>((resolve) => { releaseB = resolve; });
    const comfy = {
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
            const task = stores.tasks.create(id || "child", "comfyui:minimax-h3", input, params);
            onCreated?.(task);
            if (String((params.canvasBinding as Record<string, unknown> | undefined)?.segmentId || "") === "clip-a") return stores.tasks.update(task.id, { status: "failed", error: "模拟失败" });
            await waitB;
            stores.media.store(Buffer.from("video-b"), { name: "b.mp4", storageKey: task.id, mimeType: "video/mp4", category: "output" });
            return stores.tasks.update(task.id, { status: "succeeded", progress: 1, result: { media: [{ url: `/media/${task.id}`, storageKey: task.id, mimeType: "video/mp4" }] } });
        },
        cancel() {},
    };
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, {} as never);
    runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-a", forceRegenerate: true }, "parent-a");
    runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-b" }, "parent-b");
    for (let i = 0; i < 100 && db.getTask("parent-a")?.status !== "failed"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(db.getTask("parent-a")?.status, "failed");
    const read = () => (db.getCanvasProject("p")!.nodes as Array<{ metadata: { runtimeTaskId?: string; segments: Array<Record<string, unknown>> } }>)[0].metadata;
    const clipA = read().segments.find((item) => item.id === "clip-a")!;
    const clipB = read().segments.find((item) => item.id === "clip-b")!;
    assert.equal(clipA.status, "error");
    assert.equal(clipA.parentTaskId, "");
    assert.equal(clipA.runtimeTaskId, "");
    assert.equal(clipA.result, "old-a.mp4", "失败不能删除旧结果");
    assert.equal(clipB.status, "loading");
    assert.equal(clipB.parentTaskId, "parent-b");
    assert.equal(read().runtimeTaskId, "parent-b");
    releaseB();
    for (let i = 0; i < 100 && db.getTask("parent-b")?.status !== "succeeded"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(db.getTask("parent-b")?.status, "succeeded");
});

test("一个 Clip 的参考素材绑定不完整时，只跳过它自己，其余 Clip 照常入队", async (t: TestContext) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        // clip-bad 是 I2V 但没有首帧图 → 编译期必然报 i2v_image_count。
        { id: "clip-bad", prompt: "没有首帧的镜头", mode: "i2v" },
        { id: "clip-ok", prompt: "正常镜头", mode: "t2v" },
    ] } }], connections: [] });
    const stores = createStores(db);
    const submitted: string[] = [];
    const releases: Array<() => void> = [];
    const comfy = {
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
            const task = stores.tasks.create(id || `child-${submitted.length + 1}`, "comfyui:minimax-h3", input, params);
            submitted.push(String(input.prompt || ""));
            onCreated?.(task);
            await new Promise<void>((resolve) => releases.push(resolve));
            stores.media.store(Buffer.from("fake-video"), { name: `${task.id}.mp4`, storageKey: task.id, mimeType: "video/mp4", category: "output" });
            return stores.tasks.update(task.id, { status: "succeeded", progress: 1, result: { media: [{ url: `/media/${task.id}`, storageKey: task.id, mimeType: "video/mp4" }] } });
        },
        cancel() {},
    };
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, {} as never);
    const task = runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-bad", runFromCurrent: true }, "parent-skip");
    const plans = (task.result?.plans || []) as Array<{ segmentId: string }>;
    assert.deepEqual(plans.map((plan) => plan.segmentId), ["clip-ok"], "只应把坏 Clip 排除出执行计划");

    for (let i = 0; i < 100 && releases.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(submitted.length, 1, "只应提交好 Clip");
    releases.splice(0).forEach((release) => release());
    for (let i = 0; i < 100 && !["succeeded", "failed", "cancelled"].includes(db.getTask(task.id)?.status || ""); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(db.getTask(task.id)?.status, "succeeded", db.getTask(task.id)?.error || "好 Clip 未成功");
});

test("单独生成坏 Clip 时错误使用前端 Clip 序号并给出具体原因", (t: TestContext) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        { id: "internal-first", prompt: "正常镜头", mode: "t2v" },
        { id: "internal-second", prompt: "缺少首帧", mode: "i2v" },
    ] } }], connections: [] });
    const runner = new CanvasH3Runner(createStores(db), new BackendEventBus(), {} as never, {} as never);
    assert.throws(() => runner.start({ projectId: "p", nodeId: "n", segmentId: "internal-second" }), (error: Error) => {
        assert.match(error.message, /Clip 2：/);
        assert.match(error.message, /首帧|图片/i);
        assert.doesNotMatch(error.message, /internal-second/);
        return true;
    });
});
