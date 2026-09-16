import assert from "node:assert/strict";
import test from "node:test";

import { BackendEventBus } from "./events.js";

test("SSE 重连只补发游标之后的事件，同一实例无变化时不要求重置", () => {
    const bus = new BackendEventBus();
    const first = bus.publish({ type: "task.created", payload: {} });
    const second = bus.publish({ type: "task.completed", payload: {} });
    assert.deepEqual(bus.replay(first.id), { cursor: second.id, reset: false, events: [second] });
    assert.deepEqual(bus.replay(second.id), { cursor: second.id, reset: false, events: [] });
});

test("SSE 首连、实例重启与历史断档都明确要求快照校验", () => {
    const bus = new BackendEventBus();
    assert.equal(bus.replay().reset, true);
    const cursor = bus.publish({ type: "canvas.updated", payload: {} }).id;
    const restarted = new BackendEventBus();
    assert.equal(restarted.replay(cursor).reset, true);
    assert.notEqual(restarted.publish({ type: "canvas.updated", payload: {} }).id, cursor);
    for (let i = 0; i < 1001; i++) bus.publish({ type: "task.updated", payload: i });
    assert.deepEqual(bus.replay(cursor).events, []);
    assert.equal(bus.replay(cursor).reset, true);
});

test("publishCanvasDelta 统一发布 operations 事件，不携带完整项目", () => {
    const bus = new BackendEventBus();
    const event = bus.publishCanvasDelta({
        entityId: "project-1",
        revision: 8,
        operations: [{ type: "update_node", id: "node-1", patch: { title: "新标题" } }],
        updatedAt: "2026-01-01T00:00:08Z",
        operationResults: [{ type: "update_node", ok: true }],
    });

    assert.equal(event.type, "canvas.updated");
    assert.equal(event.entityId, "project-1");
    assert.equal(event.revision, 8);
    assert.deepEqual(event.payload, {
        operations: [{ type: "update_node", id: "node-1", patch: { title: "新标题" } }],
        operationResults: [{ type: "update_node", ok: true }],
        updatedAt: "2026-01-01T00:00:08Z",
    });
    assert.equal("nodes" in (event.payload as Record<string, unknown>), false);
    assert.equal("connections" in (event.payload as Record<string, unknown>), false);
});
