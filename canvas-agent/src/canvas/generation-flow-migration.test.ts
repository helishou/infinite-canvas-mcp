import test from "node:test";
import assert from "node:assert/strict";
import { buildCanvasToolRequest } from "./operations.js";
import { toolInputSchemas } from "./schemas.js";

test("explicit image flow keeps the existing smart config, ordered references and no-run behavior", () => {
    const state: any = { projectId: "c", nodes: [{ id: "ref", type: "image", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: {} }], connections: [] };
    const input = toolInputSchemas.canvas_create_generation_flow.parse({ projectId: "c", mode: "image", prompt: "中文图片提示词", x: 40, y: 70, referenceNodeIds: ["ref"], autoRun: false });
    const request = buildCanvasToolRequest("canvas_create_generation_flow", input, state);
    const ops: any[] = request.input.ops as any[];
    const nodes = ops.filter(op => op.type === "add_node");
    assert.equal(nodes.length, 1); assert.equal(nodes[0].nodeType, "config");
    assert.deepEqual(nodes[0].position, { x: 40, y: 70 });
    assert.ok(JSON.stringify(nodes[0]).includes("中文图片提示词"));
    assert.equal(ops.filter(op => op.type === "connect_nodes")[0].fromNodeId, "ref");
    assert.equal(ops.some(op => op.type === "run_generation"), false);
    const running = buildCanvasToolRequest("canvas_create_generation_flow", { ...input, autoRun: true }, state);
    assert.equal((running.input.ops as any[]).filter(op => op.type === "run_generation").length, 1);
});
