import assert from "node:assert/strict";
import test from "node:test";

import { CanvasGenerationService } from "./generation-service.js";

function serviceWith(overrides: { image?: Record<string, unknown>; h3?: Record<string, unknown>; stores?: Record<string, unknown> } = {}) {
    return new CanvasGenerationService(
        (overrides.image || {}) as never,
        (overrides.h3 || {}) as never,
        (overrides.stores || {}) as never,
        {} as never,
        {} as never,
        {} as never,
    );
}

test("批量 H3 只传 nodeIds 也进入统一 runner", async () => {
    const calls: unknown[] = [];
    const task = { id: "h3-batch", kind: "canvas-h3", status: "queued", progress: 0, input: {}, params: {}, createdAt: "", updatedAt: "" };
    const service = serviceWith({ h3: { start: (input: unknown) => { calls.push(input); return task; } } });

    const result = await service.start({
        mode: "video",
        operation: "h3-run",
        projectId: "project-1",
        nodeIds: ["clip-1", "clip-2"],
        runFromCurrent: true,
    });

    assert.equal(result.taskId, "h3-batch");
    assert.equal(result.executor, "h3");
    assert.deepEqual(calls, [{ projectId: "project-1", nodeIds: ["clip-1", "clip-2"], runFromCurrent: true }]);
});

test("图片执行器结果只采用 Dispatcher 的单次解析", async () => {
    const task = { id: "image-1", kind: "canvas-image", status: "queued", progress: 0, input: {}, params: {}, createdAt: "", updatedAt: "" };
    const service = serviceWith({
        image: { start: () => ({ taskId: task.id, logId: "log-1", executor: "comfy-workflow" }) },
        stores: { tasks: { get: () => task } },
    });

    const result = await service.start({ mode: "image", model: "channel::model", prompt: "test" });

    assert.equal(result.executor, "comfy-workflow");
    assert.equal(result.task, task);
});
