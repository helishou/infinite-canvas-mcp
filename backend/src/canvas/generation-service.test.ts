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
    assert.equal(received, command);
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
