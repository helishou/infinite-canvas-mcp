import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasH3Runner } from "./h3-runner.js";
const localProvider = () => ({ ready: () => false, queue: { select: () => "local", unreserve() {} } });

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
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, localProvider() as never);
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
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, localProvider() as never);
    const parent = runner.start({ projectId: "style-default", nodeId: "n", segmentId: "clip" }, "style-parent");
    for (let i = 0; i < 100 && submitted.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].params.styleTemplateId, "soft-light");
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
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, localProvider() as never);
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
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, localProvider() as never);
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

test("潜空间续写从组首继承画幅尺寸，并在新链中重新生成潜变量", async (t: TestContext) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        { id: "clip-a", prompt: "A", mode: "t2v", aspectRatio: "9:16 (Portrait)", megapixels: 0.8, sizeMultiple: 32, latentUpscaleAlign: 2, motionContextEnabled: true, contextLength: "39", audioContextLength: 48, continuationAudioRefineEnabled: true },
        { id: "clip-b", prompt: "B", mode: "t2v", aspectRatio: "16:9 (Widescreen)", megapixels: 0.5, sizeMultiple: 64, latentUpscaleAlign: 4, motionContextEnabled: false, contextLength: "5", audioContextLength: 0, continuationAudioRefineEnabled: false },
    ] } }], connections: [] });
    const stores = createStores(db);
    const submitted: Array<{ segmentId: string; aspectRatio: unknown; megapixels: unknown; sizeMultiple: unknown; latentUpscaleAlign: unknown; contextLength: unknown; audioContextLength: unknown; continuationAudioRefineEnabled: unknown; continuationTask: unknown }> = [];
    const staged: Array<{ sourceRun: string; targetRun: string; previousIndex: number }> = [];
    const comfy = {
        async prepareH3ContinuationSeed(source: { run: string }, target: { run: string }, previousIndex: number) {
            staged.push({ sourceRun: source.run, targetRun: target.run, previousIndex });
        },
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
            const task = stores.tasks.create(id || `child-${submitted.length + 1}`, "comfyui:minimax-h3", input, params);
            onCreated?.(task);
            submitted.push({
                segmentId: String((params.canvasBinding as Record<string, unknown>).segmentId),
                aspectRatio: params.aspectRatio, megapixels: params.megapixels, sizeMultiple: params.sizeMultiple, latentUpscaleAlign: params.latentUpscaleAlign,
                contextLength: params.contextLength, audioContextLength: params.audioContextLength, continuationAudioRefineEnabled: params.continuationAudioRefineEnabled,
                continuationTask: params.continuationTask,
            });
            stores.media.store(Buffer.from("fake-video"), { name: `${task.id}.mp4`, storageKey: task.id, mimeType: "video/mp4", category: "output" });
            return stores.tasks.update(task.id, { status: "succeeded", progress: 1, result: { media: [{ url: `/media/${task.id}`, storageKey: task.id, mimeType: "video/mp4" }] } });
        },
        cancel() {},
    };
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, localProvider() as never);
    const runChain = async (id: string) => {
        runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-a", runFromCurrent: true, skipCompleted: false }, id);
        for (let i = 0; i < 200 && !["succeeded", "failed"].includes(db.getTask(id)?.status || ""); i++) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(db.getTask(id)?.status, "succeeded", db.getTask(id)?.error || "潜空间续写任务未成功");
    };
    await runChain("chain-1");
    assert.deepEqual(submitted.map(({ segmentId, aspectRatio, megapixels, sizeMultiple, latentUpscaleAlign }) => ({ segmentId, aspectRatio, megapixels, sizeMultiple, latentUpscaleAlign })), [
        { segmentId: "clip-a", aspectRatio: "9:16 (Portrait)", megapixels: 0.8, sizeMultiple: 32, latentUpscaleAlign: 2 },
        { segmentId: "clip-b", aspectRatio: "9:16 (Portrait)", megapixels: 0.8, sizeMultiple: 32, latentUpscaleAlign: 2 },
    ]);
    assert.deepEqual(submitted.map((item) => JSON.parse(String(item.continuationTask)).index), [1, 2]);
    assert.deepEqual(submitted.map(({ contextLength, audioContextLength, continuationAudioRefineEnabled }) => [contextLength, audioContextLength, continuationAudioRefineEnabled]), [["39", 48, false], ["39", 48, true]], "S01 的音频精修应作用于 S02，不应作用于自身");
    const segments = ((db.getCanvasProject("p")!.nodes as Array<{ metadata: { segments: Array<Record<string, unknown>> } }>)[0].metadata.segments);
    assert.equal(segments[1].megapixels, 0.8, "继承后的尺寸应同步写回画布 Clip");
    assert.equal(segments[1].aspectRatio, "9:16 (Portrait)");
    assert.equal(segments[1].sizeMultiple, 32);
    assert.equal(segments[1].latentUpscaleAlign, 2);
    await runChain("chain-2");
    assert.equal(submitted.length, 4, "新链必须重新生成潜变量，不能复用旧 MP4 缓存");
    assert.throws(() => runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-a", runFromCurrent: true, skipCompleted: true }), /不能跳过已完成 Clip/);
    runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-b", runFromCurrent: true, skipCompleted: false }, "resume-tail");
    for (let i = 0; i < 200 && !["succeeded", "failed"].includes(db.getTask("resume-tail")?.status || ""); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(db.getTask("resume-tail")?.status, "succeeded", db.getTask("resume-tail")?.error || "组中续跑未成功");
    assert.deepEqual(staged, [{ sourceRun: "chain-2", targetRun: "resume-tail", previousIndex: 1 }]);
    assert.deepEqual(JSON.parse(String(submitted.at(-1)?.continuationTask)), {
        workflow: "p", node: "nf_v15", group: "h3-chain:clip-a", run: "resume-tail", index: 2,
    });
    assert.equal(submitted.length, 5, "组中续跑只重新生成目标 Clip，不重跑组首");

    const changed = stores.projects.get("p")!;
    stores.projects.applyOperations("p", Number(changed.revision), [
        { type: "update_h3_segment", nodeId: "n", segmentId: "clip-a", patch: { resultStorageKey: "different-output" } },
    ], { runtimeWrite: true, source: { clientId: "test", kind: "task", label: "stale source" } });
    assert.throws(() => runner.start({ projectId: "p", nodeId: "n", segmentId: "clip-b", runFromCurrent: true, skipCompleted: false }), /找不到与上一段当前成片匹配/);
});

test("本段开关只控制通往下一段的边界，独立连续组不互相继承尺寸", async (t: TestContext) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        { id: "a", prompt: "A", mode: "t2v", aspectRatio: "9:16 (Portrait)", megapixels: 0.8, motionContextEnabled: false },
        { id: "b", prompt: "B", mode: "t2v", aspectRatio: "16:9 (Widescreen)", megapixels: 0.5, motionContextEnabled: true },
        { id: "c", prompt: "C", mode: "t2v", aspectRatio: "9:16 (Portrait)", megapixels: 0.3, motionContextEnabled: false },
        { id: "d", prompt: "D", mode: "t2v", aspectRatio: "4:3 (Standard)", megapixels: 0.6, motionContextEnabled: true },
        { id: "e", prompt: "E", mode: "t2v", aspectRatio: "9:16 (Portrait)", megapixels: 0.2, motionContextEnabled: false },
    ] } }], connections: [] });
    const stores = createStores(db);
    const submitted: Array<{ id: string; megapixels: unknown; continuationTask: unknown }> = [];
    const comfy = {
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
            const task = stores.tasks.create(id || `child-${submitted.length + 1}`, "comfyui:minimax-h3", input, params);
            onCreated?.(task);
            submitted.push({ id: String((params.canvasBinding as Record<string, unknown>).segmentId), megapixels: params.megapixels, continuationTask: params.continuationTask });
            stores.media.store(Buffer.from("fake-video"), { name: `${task.id}.mp4`, storageKey: task.id, mimeType: "video/mp4", category: "output" });
            return stores.tasks.update(task.id, { status: "succeeded", progress: 1, result: { media: [{ url: `/media/${task.id}`, storageKey: task.id, mimeType: "video/mp4" }] } });
        },
        cancel() {},
    };
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, localProvider() as never);
    const task = runner.start({ projectId: "p", nodeId: "n", segmentId: "a", runFromCurrent: true, skipCompleted: false }, "edge-chain");
    const plans = (task.result?.plans || []) as Array<{ segmentId: string; continuation?: { group: string; index: number } }>;
    assert.deepEqual(plans.map((plan) => [plan.segmentId, plan.continuation?.index ?? null]), [["a", null], ["b", 1], ["c", 2], ["d", 1], ["e", 2]]);
    assert.notEqual(plans[1].continuation?.group, plans[3].continuation?.group);
    for (let i = 0; i < 200 && !["succeeded", "failed"].includes(db.getTask(task.id)?.status || ""); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(db.getTask(task.id)?.status, "succeeded", db.getTask(task.id)?.error || "续写分组未成功");
    assert.deepEqual(submitted.map(({ id, megapixels }) => [id, megapixels]), [["a", 0.8], ["b", 0.5], ["c", 0.5], ["d", 0.6], ["e", 0.6]]);
    assert.equal(submitted[0].continuationTask, undefined, "S01 关闭时不应被下一段的开关拉进潜变量组");
});

test("Clip3 从当前 Clip2 的 AV 潜变量继续，拒绝尺寸不匹配", async (t: TestContext) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        { id: "s1", prompt: "A", mode: "t2v", aspectRatio: "9:16 (Portrait)", megapixels: 0.4, motionContextEnabled: true },
        { id: "s2", prompt: "B", mode: "t2v", aspectRatio: "9:16 (Portrait)", megapixels: 0.4, motionContextEnabled: true },
        { id: "s3", prompt: "C", mode: "t2v", aspectRatio: "9:16 (Portrait)", megapixels: 0.4, motionContextEnabled: false },
    ] } }], connections: [] });
    const stores = createStores(db);
    const submitted: Array<{ segmentId: string; continuationTask: Record<string, unknown> }> = [];
    const staged: Array<{ sourceRun: string; targetRun: string; previousIndex: number }> = [];
    const comfy = {
        async prepareH3ContinuationSeed(source: { run: string }, target: { run: string }, previousIndex: number) {
            staged.push({ sourceRun: source.run, targetRun: target.run, previousIndex });
        },
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
            const task = stores.tasks.create(id || `child-${submitted.length + 1}`, "comfyui:minimax-h3", input, params);
            onCreated?.(task);
            submitted.push({ segmentId: String((params.canvasBinding as Record<string, unknown>).segmentId), continuationTask: JSON.parse(String(params.continuationTask)) });
            stores.media.store(Buffer.from("fake-video"), { name: `${task.id}.mp4`, storageKey: task.id, mimeType: "video/mp4", category: "output" });
            return stores.tasks.update(task.id, { status: "succeeded", progress: 1, result: { media: [{ url: `/media/${task.id}`, storageKey: task.id, mimeType: "video/mp4" }] } });
        },
        cancel() {},
    };
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, localProvider() as never);
    const wait = async (id: string) => {
        for (let i = 0; i < 200 && !["succeeded", "failed"].includes(db.getTask(id)?.status || ""); i++) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(db.getTask(id)?.status, "succeeded", db.getTask(id)?.error || "H3 未成功");
    };
    runner.start({ projectId: "p", nodeId: "n", segmentId: "s1", runFromCurrent: true, skipCompleted: false }, "source-run");
    await wait("source-run");
    const patch = (megapixels: number) => {
        const current = stores.projects.get("p")!;
        stores.projects.applyOperations("p", Number(current.revision), [
            { type: "update_h3_segment", nodeId: "n", segmentId: "s3", patch: { megapixels } },
        ], { runtimeWrite: true, source: { clientId: "test", kind: "task", label: "size" } });
    };
    patch(0.5);
    assert.throws(() => runner.start({ projectId: "p", nodeId: "n", segmentId: "s3", runFromCurrent: true, skipCompleted: false }), /megapixels/);
    patch(0.4);
    runner.start({ projectId: "p", nodeId: "n", segmentId: "s3", runFromCurrent: true, skipCompleted: false }, "resume-from-s3");
    await wait("resume-from-s3");
    assert.deepEqual(submitted.map((item) => item.segmentId), ["s1", "s2", "s3", "s3"]);
    assert.deepEqual(staged, [{ sourceRun: "source-run", targetRun: "resume-from-s3", previousIndex: 2 }]);
    assert.equal(submitted[3].continuationTask.index, 3);
    assert.equal(submitted[3].continuationTask.run, "resume-from-s3");

    const project = stores.projects.get("p")!;
    const sourceNode = (project.nodes as Array<Record<string, unknown>>).find((node) => node.id === "n")!;
    stores.projects.applyOperations("p", Number(project.revision), [
        { type: "add_node", id: "n-copy", nodeType: "minimax-h3", metadata: structuredClone(sourceNode.metadata) },
    ], { source: { clientId: "test", kind: "task", label: "copy" } });
    runner.start({ projectId: "p", nodeId: "n-copy", segmentId: "s3", runFromCurrent: true, skipCompleted: false }, "resume-copy");
    await wait("resume-copy");
    assert.deepEqual(staged.at(-1), { sourceRun: "source-run", targetRun: "resume-copy", previousIndex: 2 }, "副本只能复用同项目同媒体 key 的来源");
    assert.equal(submitted.at(-1)?.continuationTask.index, 3);
});

test("潜空间续写不能绕过参考不完整的中间 Clip", (t: TestContext) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
        { id: "head", prompt: "A", mode: "t2v", aspectRatio: "9:16 (Portrait)", megapixels: 0.8, motionContextEnabled: true },
        { id: "missing-image", prompt: "B", mode: "i2v" },
        { id: "tail", prompt: "C", mode: "t2v" },
    ] } }], connections: [] });
    const runner = new CanvasH3Runner(createStores(db), new BackendEventBus(), {} as never, localProvider() as never);
    assert.throws(() => runner.start({ projectId: "p", nodeId: "n", segmentId: "head", runFromCurrent: true }), /不能跳过连续组中的 Clip/);
});
