import assert from "node:assert/strict";
import test from "node:test";

import { BackendEventBus } from "./events.js";

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
