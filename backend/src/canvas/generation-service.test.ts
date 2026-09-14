import assert from "node:assert/strict";
import test from "node:test";

import { CanvasGenerationService } from "./generation-service.js";

function serviceWith(overrides: { image?: Record<string, unknown>; h3?: Record<string, unknown>; comfy?: Record<string, unknown>; stores?: Record<string, unknown> } = {}) {
    return new CanvasGenerationService(
        (overrides.image || {}) as never,
        (overrides.h3 || {}) as never,
        (overrides.stores || {}) as never,
        {} as never,
        (overrides.comfy || {}) as never,
        {} as never,
    );
}

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
