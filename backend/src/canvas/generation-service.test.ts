import assert from "node:assert/strict";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { CanvasGenerationService } from "./generation-service.js";

function serviceWith(overrides: { image?: Record<string, unknown>; h3?: Record<string, unknown>; comfy?: Record<string, unknown>; stores?: Record<string, unknown>; video?: Record<string, unknown>; audio?: Record<string, unknown>; browser?: Record<string, unknown> } = {}) {
    return new CanvasGenerationService(
        (overrides.image || {}) as never,
        (overrides.h3 || {}) as never,
        (overrides.stores || {}) as never,
        {} as never,
        (overrides.comfy || {}) as never,
        {} as never,
        undefined,
        overrides.video as never,
        overrides.audio as never,
        overrides.browser as never,
    );
}

test("本地 ComfyUI 音频进入音频执行器并解析参考音频路径", async () => {
    let received: unknown;
    const task = { id: "audio-local", kind: "canvas-audio", status: "queued", progress: 0, input: {}, params: {}, createdAt: "", updatedAt: "" };
    const service = serviceWith({
        audio: { start: (input: unknown) => { received = input; return { taskId: task.id, executor: "comfyui" }; } },
        browser: { start: () => { throw new Error("不应进入浏览器音频执行器"); } },
        stores: {
            settings: { get: () => ({ channels: [{ id: "local", kind: "comfyui", models: [{ name: "IndexTTS 2.5 配音", capability: "audio" }] }] }) },
            media: { meta: (key: string) => key === "audio:key" ? { filePath: "C:/media/reference.wav" } : null },
            tasks: { get: () => task },
        },
    });
    const result = await service.start({ mode: "audio", model: "local::IndexTTS 2.5 配音", prompt: "你好", audioReferences: [{ storageKey: "audio:key" }], params: { speed: "1.2" } });
    assert.equal(result.executor, "comfyui");
    assert.deepEqual(received, { projectId: undefined, nodeId: undefined, sourceNodeId: undefined, model: "local::IndexTTS 2.5 配音", prompt: "你好", voice: "", format: "", speed: "1.2", instructions: "", executor: "comfyui", referenceAudio: "C:/media/reference.wav", params: { speed: "1.2" } });
});

test("挂载自定义脚本的模型先进入 Backend 浏览器任务而不是模式直连分支", async () => {
    let received: unknown;
    const task = { id: "browser-1", kind: "canvas-browser-script", status: "queued", progress: 0, input: {}, params: {}, createdAt: "", updatedAt: "" };
    const service = serviceWith({
        image: { start: () => { throw new Error("不应进入图片直连执行器"); } },
        browser: { start: (input: unknown, script: string) => { received = { input, script }; return { taskId: task.id, executor: "browser-script" }; } },
        stores: {
            settings: { get: () => ({ channels: [{ id: "c", models: [{ name: "custom", script: "return ['ok']" }] }] }) },
            tasks: { get: () => task },
        },
    });

    const command = { mode: "image" as const, model: "c::custom", prompt: "test", idempotencyKey: "browser-key" };
    const result = await service.start(command);

    assert.equal(result.executor, "browser-script");
    assert.equal(result.task, task);
    assert.deepEqual(received, { input: command, script: "return ['ok']" });
});

test("Backend 不原生支持的渠道协议也先建立浏览器权威任务", async () => {
    let received: unknown;
    const task = { id: "browser-provider-1", kind: "canvas-browser-script", status: "queued", progress: 0, input: {}, params: {}, createdAt: "", updatedAt: "" };
    const service = serviceWith({
        image: { start: () => { throw new Error("不应进入 Backend 图片执行器"); } },
        browser: { start: (input: unknown, script: string, executor: string) => { received = { input, script, executor }; return { taskId: task.id, executor }; } },
        stores: {
            settings: { get: () => ({ channels: [{ id: "gemini", kind: "api", apiFormat: "gemini", models: [{ name: "imagen-4", capability: "image" }] }] }) },
            tasks: { get: () => task },
        },
    });
    const command = { mode: "image" as const, model: "gemini::imagen-4", prompt: "test" };
    const result = await service.start(command);
    assert.equal(result.executor, "browser-provider");
    assert.deepEqual(received, { input: command, script: "", executor: "browser-provider" });
});

test("批量 H3 只传 nodeIds 也进入统一 runner", async () => {
    const calls: Array<{ input: unknown; idempotencyKey?: string }> = [];
    const task = { id: "h3-batch", kind: "canvas-h3", status: "queued", progress: 0, input: {}, params: {}, createdAt: "", updatedAt: "" };
    const service = serviceWith({ h3: { start: (input: unknown, idempotencyKey?: string) => { calls.push({ input, idempotencyKey }); return task; } } });

    const result = await service.start({
        mode: "video",
        operation: "h3-run",
        projectId: "project-1",
        nodeIds: ["clip-1", "clip-2"],
        runFromCurrent: true,
        idempotencyKey: "h3-batch-key",
    });

    assert.equal(result.taskId, "h3-batch");
    assert.equal(result.executor, "h3");
    assert.deepEqual(calls, [{ input: { projectId: "project-1", nodeIds: ["clip-1", "clip-2"], runFromCurrent: true }, idempotencyKey: "h3-batch-key" }]);
});

test("图片执行器结果只采用 Dispatcher 的单次解析", async () => {
    let received: unknown;
    const task = { id: "image-1", kind: "canvas-image", status: "queued", progress: 0, input: {}, params: {}, createdAt: "", updatedAt: "" };
    const service = serviceWith({
        image: { start: (input: unknown) => { received = input; return { taskId: task.id, logId: "log-1", executor: "comfy-workflow" }; } },
        stores: { tasks: { get: () => task } },
    });

    const command = { mode: "image" as const, model: "channel::model", prompt: "test", references: [{ storageKey: "image-1" }], params: { quality: "high" }, resultPolicy: "append" as const, idempotencyKey: "image-key" };
    const result = await service.start(command);

    assert.equal(result.executor, "comfy-workflow");
    assert.equal(result.task, task);
    assert.deepEqual(received, { ...command, clientTaskId: "image-key" });
});

test("文本命令进入统一文本执行器", async () => {
    let received: unknown;
    const task = { id: "text-1", kind: "canvas-text", status: "queued", progress: 0, input: {}, params: {}, createdAt: "", updatedAt: "" };
    const service = serviceWith({
        stores: {
            projects: { get: () => ({ id: "project-1", nodes: [{ id: "config-1", type: "config" }], connections: [] }) },
            tasks: { get: () => task },
        },
    });
    Object.assign(service, { text: { start: (input: unknown) => { received = input; return { taskId: task.id, executor: "direct-text" }; } } });

    const command = { mode: "text" as const, model: "channel::gpt-5-5", prompt: "分析参考图", projectId: "project-1", nodeId: "config-1" };
    const result = await service.start(command);

    assert.equal(result.taskId, task.id);
    assert.equal(result.executor, "direct-text");
    assert.deepEqual(received, { ...command, references: [] });
});

test("图片命令按源配置节点统一解析画布参考图", async () => {
    let received: Record<string, unknown> | undefined;
    const service = serviceWith({
        image: { start: (input: Record<string, unknown>) => { received = input; return { taskId: "image-2", logId: "log-2", executor: "direct-image" }; } },
        stores: {
            projects: {
                get: () => ({
                    id: "project-1",
                    nodes: [
                        { id: "config", type: "config" },
                        { id: "result", type: "image" },
                        { id: "scene", type: "image", title: "场景", metadata: { storageKey: "image:scene" } },
                        { id: "character", type: "image", title: "人物", metadata: { storageKey: "image:character" } },
                    ],
                    connections: [
                        { id: "scene-config", fromNodeId: "scene", toNodeId: "config", order: 0 },
                        { id: "character-config", fromNodeId: "character", toNodeId: "config", order: 1 },
                    ],
                }),
            },
            tasks: { get: () => null },
        },
    });

    await service.start({ mode: "image", projectId: "project-1", nodeId: "result", sourceNodeId: "config", model: "gpt-image-2", prompt: "test", references: [] });

    assert.deepEqual((received?.references as Array<{ id: string }>).map((reference) => reference.id), ["scene", "character"]);
});

test("蒙版局部修改以调用方参考图为准，不被智能节点上游参考图覆盖", async () => {
    let received: Record<string, unknown> | undefined;
    const service = serviceWith({
        image: { start: (input: Record<string, unknown>) => { received = input; return { taskId: "image-mask", logId: "log-mask", executor: "direct-image" }; } },
        stores: {
            projects: {
                get: () => ({
                    id: "project-1",
                    nodes: [
                        { id: "smart", type: "config", title: "智能生成", metadata: { smart: true, generationMode: "image", images: [{ id: "main", content: "smart.png", storageKey: "image:smart-main" }] } },
                        { id: "mask", type: "image", title: "遮罩标注", metadata: { storageKey: "image:mask", maskOverlay: true } },
                        { id: "result", type: "image", metadata: { generationType: "edit", status: "idle" } },
                        { id: "char", type: "character", title: "谢临渊", metadata: { characterImages: [{ storageKey: "image:char", url: "char.png", name: "char.png" }] } },
                    ],
                    connections: [
                        { id: "smart-result", fromNodeId: "smart", toNodeId: "result" },
                        { id: "mask-result", fromNodeId: "mask", toNodeId: "result" },
                        { id: "char-smart", fromNodeId: "char", toNodeId: "smart", role: "reference" },
                    ],
                }),
            },
            tasks: { get: () => null },
        },
    });

    await service.start({
        mode: "image",
        maskEdit: true,
        projectId: "project-1",
        nodeId: "result",
        sourceNodeId: "smart",
        model: "gpt-image-2",
        prompt: "参考图片1为原图，图片2是蓝色标注的待修改区域，把它改掉",
        count: 1,
        references: [
            { id: "source", name: "原图.png", storageKey: "image:source" },
            { id: "mask-node", name: "mask.png", storageKey: "image:mask" },
        ],
    });

    assert.deepEqual((received?.references as Array<{ id: string }>).map((reference) => reference.id), ["source", "mask-node"]);
});

test("普通改图结果节点在没有 maskEdit 标记时仍按画布图谱解析参考图", async () => {
    let received: Record<string, unknown> | undefined;
    const service = serviceWith({
        image: { start: (input: Record<string, unknown>) => { received = input; return { taskId: "image-edit", logId: "log-edit", executor: "direct-image" }; } },
        stores: {
            projects: {
                get: () => ({
                    id: "project-1",
                    nodes: [
                        { id: "smart", type: "config", metadata: { smart: true, generationMode: "image", images: [{ id: "main", content: "smart.png", storageKey: "image:smart-main" }] } },
                        { id: "mask", type: "image", title: "遮罩标注", metadata: { storageKey: "image:mask", maskOverlay: true } },
                        { id: "result", type: "image", metadata: { generationType: "edit" } },
                    ],
                    connections: [
                        { id: "smart-result", fromNodeId: "smart", toNodeId: "result" },
                        { id: "mask-result", fromNodeId: "mask", toNodeId: "result" },
                    ],
                }),
            },
            tasks: { get: () => null },
        },
    });

    await service.start({ mode: "image", projectId: "project-1", nodeId: "result", sourceNodeId: "result", model: "gpt-image-2", prompt: "重跑", count: 1, references: [] });

    assert.deepEqual((received?.references as Array<{ storageKey: string }>).map((reference) => reference.storageKey), ["image:smart-main", "image:mask"]);
});

test("局部修改未带 maskEdit 时按目标结果节点入边解析，不被智能节点上游覆盖", async () => {
    let received: Record<string, unknown> | undefined;
    const service = serviceWith({
        image: { start: (input: Record<string, unknown>) => { received = input; return { taskId: "image-mask-fallback", logId: "log-mask", executor: "direct-image" }; } },
        stores: {
            projects: {
                get: () => ({
                    id: "project-1",
                    nodes: [
                        { id: "smart", type: "config", title: "分镜图·S01-10", metadata: { smart: true, generationMode: "image", images: [{ id: "main", content: "frame.png", storageKey: "image:smart-main" }] } },
                        { id: "mask", type: "image", title: "遮罩标注", metadata: { storageKey: "image:mask", maskOverlay: true } },
                        { id: "result", type: "image", metadata: { generationType: "edit" } },
                        { id: "char", type: "character", title: "谢临渊", metadata: { characterImages: [{ storageKey: "image:char", url: "char.png", name: "char.png" }] } },
                    ],
                    connections: [
                        { id: "smart-result", fromNodeId: "smart", toNodeId: "result" },
                        { id: "mask-result", fromNodeId: "mask", toNodeId: "result" },
                        { id: "char-smart", fromNodeId: "char", toNodeId: "smart", role: "reference" },
                    ],
                }),
            },
            tasks: { get: () => null },
        },
    });

    await service.start({
        mode: "image",
        projectId: "project-1",
        nodeId: "result",
        sourceNodeId: "smart",
        model: "gpt-image-2",
        prompt: "参考图片1为原图，图片2是待修改区域",
        count: 1,
        references: [{ id: "source", name: "原图.png", storageKey: "image:source" }],
    });

    assert.deepEqual(
        (received?.references as Array<{ storageKey: string }>).map((reference) => reference.storageKey),
        ["image:smart-main", "image:mask"],
    );
});

test("智能节点形态的局部修改结果节点也按自身入边解析", async () => {
    let received: Record<string, unknown> | undefined;
    const service = serviceWith({
        image: { start: (input: Record<string, unknown>) => { received = input; return { taskId: "image-mask-smart", logId: "log-smart", executor: "comfy-workflow" }; } },
        stores: {
            projects: {
                get: () => ({
                    id: "project-1",
                    nodes: [
                        { id: "smart", type: "config", metadata: { smart: true, generationMode: "image", images: [{ id: "main", content: "frame.png", storageKey: "image:smart-main" }] } },
                        { id: "mask", type: "image", title: "遮罩标注", metadata: { storageKey: "image:mask", maskOverlay: true } },
                        { id: "result", type: "config", metadata: { smart: true, generationMode: "image", maskEdit: true, images: [{ id: "slot", status: "idle" }] } },
                    ],
                    connections: [
                        { id: "smart-result", fromNodeId: "smart", toNodeId: "result" },
                        { id: "mask-result", fromNodeId: "mask", toNodeId: "result" },
                    ],
                }),
            },
            tasks: { get: () => null },
        },
    });

    await service.start({ mode: "image", projectId: "project-1", nodeId: "result", sourceNodeId: "smart", model: "Flux2-Klein", prompt: "只改涂抹区域", count: 1, references: [] });

    assert.deepEqual(
        (received?.references as Array<{ storageKey: string }>).map((reference) => reference.storageKey),
        ["image:smart-main", "image:mask"],
    );
});

test("智能节点自身生成不会被局部修改兜底改写参考图", async () => {
    let received: Record<string, unknown> | undefined;
    const service = serviceWith({
        image: { start: (input: Record<string, unknown>) => { received = input; return { taskId: "image-smart-self", logId: "log-self", executor: "direct-image" }; } },
        stores: {
            projects: {
                get: () => ({
                    id: "project-1",
                    nodes: [
                        { id: "smart", type: "config", metadata: { smart: true, generationMode: "image" } },
                        { id: "char", type: "character", title: "谢临渊", metadata: { characterImages: [{ storageKey: "image:char", url: "char.png", name: "char.png" }] } },
                    ],
                    connections: [{ id: "char-smart", fromNodeId: "char", toNodeId: "smart", role: "reference" }],
                }),
            },
            tasks: { get: () => null },
        },
    });

    await service.start({ mode: "image", projectId: "project-1", nodeId: "smart", sourceNodeId: "smart", model: "gpt-image-2", prompt: "正常生成", count: 1 });

    assert.deepEqual(
        (received?.references as Array<{ storageKey: string }>).map((reference) => reference.storageKey),
        ["image:char"],
    );
});

test("图片命令与 H3/视频一样使用 idempotencyKey 复用任务", async () => {
    let received: Record<string, unknown> | undefined;
    const task = { id: "image-idempotent", kind: "canvas-image", status: "queued", progress: 0, input: {}, params: {}, createdAt: "", updatedAt: "" };
    const service = serviceWith({
        image: { start: (input: Record<string, unknown>) => { received = input; return { taskId: task.id, logId: undefined, executor: "direct-image" }; } },
        stores: { tasks: { get: () => task } },
    });

    const result = await service.start({ mode: "image", model: "gpt-image-2", prompt: "test", idempotencyKey: "image-key" });

    assert.equal(result.taskId, task.id);
    assert.equal(received?.clientTaskId, "image-key");
});

test("视频命令保留统一 input、params 和幂等键", async () => {
    const calls: unknown[] = [];
    const task = { id: "video-1", kind: "comfy", status: "queued", progress: 0, input: {}, params: {}, createdAt: "", updatedAt: "" };
    const service = serviceWith({ comfy: { run: (...args: unknown[]) => { calls.push(args); return Promise.resolve(task); } } });

    const result = await service.start({ mode: "video", model: "minimax-h3:video", preset: "minimax-h3", input: { prompt: "test" }, params: { duration: 8 }, comfyUrl: "http://comfy.local", idempotencyKey: "video-key" });

    assert.equal(result.taskId, task.id);
    assert.equal(result.executor, "h3");
    assert.deepEqual(calls, [["minimax-h3", { prompt: "test" }, { duration: 8, executor: "h3", model: "minimax-h3:video", projectId: undefined, nodeId: undefined, segmentId: undefined }, "http://comfy.local", "video-key", undefined]]);
});

test("普通视频命令进入 Backend 视频父任务并按画布图谱解析图片参考", async () => {
    let received: Record<string, unknown> | undefined;
    const task = { id: "canvas-video-1", kind: "canvas-video", status: "queued", progress: 0, input: {}, params: {}, createdAt: "", updatedAt: "" };
    const service = serviceWith({
        video: { start: (input: Record<string, unknown>) => { received = input; return { taskId: task.id, executor: "workflow" }; } },
        stores: {
            projects: { get: () => ({
                id: "project-1",
                nodes: [
                    { id: "config", type: "config" },
                    { id: "result", type: "video" },
                    { id: "scene", type: "image", metadata: { storageKey: "image:scene" } },
                ],
                connections: [{ id: "scene-config", fromNodeId: "scene", toNodeId: "config", order: 0 }],
            }) },
            tasks: { get: () => task },
        },
    });

    const result = await service.start({ mode: "video", projectId: "project-1", nodeId: "result", sourceNodeId: "config", model: "local::movie", prompt: "test", idempotencyKey: "video-key" });

    assert.equal(result.task, task);
    assert.equal(received?.clientTaskId, "video-key");
    assert.deepEqual((received?.references as Array<{ id: string }>).map((reference) => reference.id), ["scene"]);
});

test("画布图谱没有参考图时保留视频命令里的显式图片", async (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "smart", type: "config", metadata: { smart: true } }], connections: [] });
    const stores = createStores(db);
    let received: Record<string, unknown> | undefined;
    const service = serviceWith({
        stores,
        video: { start: (input: Record<string, unknown>) => { received = input; return { taskId: "video-task", executor: "workflow" }; } },
    });

    await service.start({
        mode: "video",
        projectId: "p",
        nodeId: "smart",
        model: "local::MiniMax_H3",
        prompt: "让画面动起来",
        references: [{ id: "ref", name: "reference.png", dataUrl: "data:image/png;base64,aGVsbG8=" }],
    });

    assert.equal((received?.references as Array<Record<string, unknown>>)[0].id, "ref");
});
