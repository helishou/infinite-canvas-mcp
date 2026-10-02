import assert from "node:assert/strict";
import test from "node:test";

import { CANVAS_GENERATION_PATH, CANVAS_LOOP_PREPARE_PATH } from "@basketikun/canvas-agent/generation-api";
import { validateLoopGenerationCommand } from "../canvas/generation-service.js";
import { registerCanvasGenerationRoutes } from "./canvas-generation-routes.js";

type ResponseStub = {
    statusCode: number;
    body?: unknown;
    status: (code: number) => ResponseStub;
    json: (body: unknown) => void;
};

function responseStub(): ResponseStub {
    const response: ResponseStub = { statusCode: 200, status(code: number) { response.statusCode = code; return response; }, json(body: unknown) { response.body = body; } };
    return response;
}

test("统一生成路由转发已校验的 command", async () => {
    const routes: Array<{ path: string; handler: (req: unknown, res: ResponseStub) => unknown }> = [];
    let received: unknown;
    const task = { id: "task-1", kind: "canvas-image", status: "queued", progress: 0, input: {}, params: {}, createdAt: "", updatedAt: "" };
    registerCanvasGenerationRoutes({ post(path: string, handler: (req: unknown, res: ResponseStub) => unknown) { routes.push({ path, handler }); } } as never, { start: async (command: unknown) => { received = command; return { taskId: task.id, task, executor: "direct-image" }; } } as never);

    assert.deepEqual(routes.map((route) => route.path), [CANVAS_GENERATION_PATH, CANVAS_LOOP_PREPARE_PATH]);
    const command = { mode: "image", model: "gpt-image-2", prompt: "a cat", params: { count: 2 }, idempotencyKey: "key-1" };
    const response = responseStub();
    await routes[0].handler({ body: command }, response);

    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.body, { ok: true, taskId: task.id, task, executor: "direct-image" });
    assert.deepEqual(received, command);
});

test("循环准备路由校验并转发 Backend 轮次计划", () => {
    const routes: Array<{ path: string; handler: (req: unknown, res: ResponseStub) => unknown }> = [];
    let received: unknown;
    registerCanvasGenerationRoutes({ post(path: string, handler: (req: unknown, res: ResponseStub) => unknown) { routes.push({ path, handler }); } } as never, {
        start: async () => ({ taskId: "unused" }),
        prepareLoopRun: (input: unknown) => { received = input; return { runId: "run-1", outputGroupId: "group-1", slotNodeIds: ["a", "b"], totalRounds: 2 }; },
    } as never);
    const route = routes.find((item) => item.path === CANVAS_LOOP_PREPARE_PATH)!;
    const response = responseStub();
    route.handler({ body: { projectId: "p", loopNodeId: "loop", runId: "run-1", mode: "audio", totalRounds: 2, roundInputNodeIds: [[], []] } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(received, { projectId: "p", loopNodeId: "loop", runId: "run-1", mode: "audio", totalRounds: 2, roundInputNodeIds: [[], []] });
    assert.deepEqual(response.body, { ok: true, runId: "run-1", outputGroupId: "group-1", slotNodeIds: ["a", "b"], totalRounds: 2 });
});

test("循环生成拒绝旧客户端缺少的输出槽绑定字段", () => {
    assert.throws(() => validateLoopGenerationCommand({
        mode: "image", projectId: "p", nodeId: "old-slot",
        loopOutput: { loopNodeId: "loop", roundIndex: 1, slotIndex: 0 },
    }, null), /刷新画布页面/);
    assert.throws(() => validateLoopGenerationCommand({
        mode: "image", projectId: "p", nodeId: "old-slot",
    }, { nodes: [{ id: "loop", type: "loop" }, { id: "old-slot", type: "config", metadata: { loopOutputSlot: true } }], connections: [] } as never), /Backend 准备的输出槽/);
    assert.doesNotThrow(() => validateLoopGenerationCommand({
        mode: "image", projectId: "p", nodeId: "slot",
        loopOutput: { loopNodeId: "loop", roundIndex: 1, slotIndex: 0, totalRounds: 1, slotNodeId: "slot", outputGroupId: "group" },
    }, null));
});

test("统一生成路由拒绝不符合共享 schema 的 command", async () => {
    let called = false;
    const routes: Array<{ handler: (req: unknown, res: ResponseStub) => unknown }> = [];
    registerCanvasGenerationRoutes({ post(_path: string, handler: (req: unknown, res: ResponseStub) => unknown) { routes.push({ handler }); } } as never, { start: async () => { called = true; return { taskId: "unexpected", executor: "test" }; } } as never);

    const response = responseStub();
    await routes[0].handler({ body: { mode: "image", model: 123, prompt: "test" } }, response);

    assert.equal(response.statusCode, 400);
    assert.equal(called, false);
    assert.deepEqual(response.body, { ok: false, error: "model: Expected string, received number" });
});
