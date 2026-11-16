/**
 * 原生 H3 本地链路（ComfyUI 子任务 / 潜空间续写 / RunningHub 分流）已下线：
 * H3 只通过「自选视频模型」出片，运行位置由引擎侧工作流参数决定。
 * 与原生续写相关的 6 个用例随能力一起删除，保留并发的编排/错误落点用例。
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasH3Runner } from "./h3-runner.js";

/**
 * H3 只走「自选视频模型」：把测试里的假 ComfyUI 后端适配成视频调度器。
 * 假 comfy 仍然负责建子任务与产出，断言基本保持原样。
 */
function dispatcherOf(stores: ReturnType<typeof createStores>, comfy: { run: (...args: any[]) => any }) {
    return {
        start(request: any, bind?: (task: any) => void) {
            const id = String(request?.clientTaskId || `video-${Math.random().toString(16).slice(2, 8)}`);
            // 同步抛错要冒泡给 runner（提交前失败只影响当前 Clip），异步结果自己收尾。
            const running = comfy.run("minimax-h3", { prompt: request?.prompt }, request?.params ?? {}, undefined, id, (task: any) => bind?.(task));
            void Promise.resolve(running).catch(() => undefined);
            return { taskId: id };
        },
        generationSettings() { return {}; },
        resume() { /* 无需恢复 */ },
        cancel() { /* 无需取消 */ },
    };
}

const localProvider = () => ({ ready: () => false, queue: { select: () => "local", unreserve() {} } });

test("连续运行在子任务创建前失败时，仅当前 Clip 显示错误并保留旧输出", async (t: TestContext) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "routing-failure", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        { id: "before", prompt: "Before", mode: "t2v", status: "success", result: "/media/before.mp4" },
        { id: "current", prompt: "Current", mode: "t2v", minimaxEngine: "runninghub", status: "success", result: "/media/current.mp4" },
        { id: "after", prompt: "After", mode: "t2v", status: "success", result: "/media/after.mp4" },
    ] } }], connections: [] });
    const stores = createStores(db);
    let submissions = 0;
    // 提交阶段就失败：同步抛出，模拟渠道在起子任务前就拒绝
    const comfy = { run() { submissions++; throw new Error("引擎渠道在提交前拒绝：输入准备失败"); } };
    const provider = { ready: () => false, queue: {
        select() { throw new Error("RunningHub 未配置 API Key、工作流 ID 或输入映射"); },
        unreserve() {},
    } };
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), dispatcherOf(stores, comfy) as never);
    const task = runner.start({ projectId: "routing-failure", nodeId: "n", segmentId: "current", runFromCurrent: true, forceRegenerate: true });
    for (let i = 0; i < 100 && db.getTask(task.id)?.status !== "failed"; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(db.getTask(task.id)?.status, "failed");
    const clips = (db.getCanvasProject("routing-failure")!.nodes[0] as any).metadata.segments;
    assert.equal(clips[1].status, "error");
    assert.match(clips[1].errorDetails, /输入准备失败/);
    assert.equal(clips[1].result, "/media/current.mp4");
    assert.equal(clips[1].parentTaskId, "");
    assert.equal(clips[1].runtimeTaskId, "");
    assert.equal(clips[0].status, "success");
    assert.equal(clips[2].status, "success");
    assert.equal(clips[2].result, "/media/after.mp4");
    assert.equal(submissions, 1);
});


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
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), dispatcherOf(stores, comfy) as never);
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

test("Backend 保存的视觉风格模板默认值进入实际 H3 提示词", async (t: TestContext) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "style-default", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        { id: "clip", mode: "t2v", taskMode: "t2v", prompt: "integrated_multimodal_description:\n人物在夜色中走过桥。", duration: 5 },
    ] } }], connections: [] });
    const stores = createStores(db);
    stores.settings.set("plugin:minimax-h3:defaults:v1", { megapixels: 0.6, styleTemplateId: "soft-light" });
    const submitted: Array<{ input: Record<string, unknown>; params: Record<string, unknown> }> = [];
    const comfy = {
        async status() { return { connected: false }; },
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
            const child = stores.tasks.create(id || "style-child", "comfyui:minimax-h3", input, params);
            onCreated?.(child);
            submitted.push({ input, params });
            return stores.tasks.update(child.id, { status: "failed", error: "测试仅捕获实际提交输入" });
        },
        cancel() {},
    };
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), dispatcherOf(stores, comfy) as never);
    const parent = runner.start({ projectId: "style-default", nodeId: "n", segmentId: "clip" }, "style-parent");
    for (let i = 0; i < 100 && submitted.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(submitted.length, 1);
    // 自选模型执行链不再下发 H3 原生参数；风格模板只体现在最终提示词里（下面这条断言）。
    assert.match(String(submitted[0].input.prompt), /gentle photographic diffusion/);
    for (let i = 0; i < 100 && !["failed", "succeeded", "cancelled"].includes(db.getTask(parent.id)?.status || ""); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(db.getTask(parent.id)?.status, "failed");
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
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), dispatcherOf(stores, comfy) as never);
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
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), dispatcherOf(stores, comfy) as never);
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
    const runner = new CanvasH3Runner(createStores(db), new BackendEventBus(), {} as never, localProvider() as never);
    assert.throws(() => runner.start({ projectId: "p", nodeId: "n", segmentId: "internal-second" }), (error: Error) => {
        assert.match(error.message, /Clip 2：/);
        assert.match(error.message, /首帧|图片/i);
        assert.doesNotMatch(error.message, /internal-second/);
        return true;
    });
});





