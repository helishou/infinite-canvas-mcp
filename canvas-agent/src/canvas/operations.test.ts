import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCanvasToolRequest } from "./operations.js";

function opsOf(name: Parameters<typeof buildCanvasToolRequest>[0], input: Record<string, unknown>, state: Parameters<typeof buildCanvasToolRequest>[2] = null) {
    const request = buildCanvasToolRequest(name, input, state);
    return (request.input as { ops: Array<Record<string, any>> }).ops;
}

test("generation flow reuses referenced nodes when the prompt only mentions them", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "@[node:text-1]", referenceNodeIds: ["text-1"], title: "Flow", autoRun: true });
    const addedTextNodes = ops.filter((op) => op.type === "add_node" && op.nodeType === "text");
    const config = ops.find((op) => op.type === "add_node" && op.nodeType === "config");
    const runs = ops.filter((op) => op.type === "run_generation");
    assert.equal(addedTextNodes.length, 0);
    assert.equal(ops.filter((op) => op.type === "connect_nodes" && op.fromNodeId === "text-1" && String(op.toNodeId).startsWith("config-")).length, 1);
    assert.match(String(config?.metadata?.prompt), /^@\[node:text-1\]$/);
    assert.equal(runs.length, 1);
});

test("generation flow still creates a prompt node for prose prompts", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "a cat on a roof", referenceNodeIds: ["text-1"], autoRun: true });
    assert.equal(ops.filter((op) => op.type === "add_node" && op.nodeType === "text").length, 1);
    const config = ops.find((op) => op.type === "add_node" && op.nodeType === "config");
    assert.match(String(config?.metadata?.prompt), /@\[node:text-/);
});

test("setting generation references removes old media inputs but keeps the prompt connection", () => {
    const state = {
        nodes: [
            { id: "prompt", type: "text", position: { x: 0, y: 0 }, width: 320, height: 240 },
            { id: "old-1", type: "image", position: { x: 0, y: 0 }, width: 320, height: 240 },
            { id: "old-2", type: "image", position: { x: 0, y: 0 }, width: 320, height: 240 },
            { id: "new", type: "image", position: { x: 0, y: 0 }, width: 320, height: 240 },
            { id: "config", type: "config", position: { x: 0, y: 0 }, width: 320, height: 240 },
        ],
        connections: [
            { id: "prompt-connection", fromNodeId: "prompt", toNodeId: "config" },
            { id: "old-connection-1", fromNodeId: "old-1", toNodeId: "config" },
            { id: "old-connection-2", fromNodeId: "old-2", toNodeId: "config" },
        ],
    };
    const ops = opsOf("canvas_set_generation_references", { nodeId: "config", referenceNodeIds: ["new"] }, state);
    assert.deepEqual(ops, [
        { type: "delete_connections", ids: ["old-connection-1", "old-connection-2"] },
        { type: "connect_nodes", fromNodeId: "new", toNodeId: "config", role: "reference", order: 0 },
    ]);
});

test("running generation with referenceNodeIds replaces old media inputs before running", () => {
    const state = {
        nodes: [
            { id: "prompt", type: "text", position: { x: 0, y: 0 }, width: 320, height: 240 },
            { id: "old", type: "image", position: { x: 0, y: 0 }, width: 320, height: 240 },
            { id: "new", type: "image", position: { x: 0, y: 0 }, width: 320, height: 240 },
            { id: "config", type: "config", position: { x: 0, y: 0 }, width: 320, height: 240 },
        ],
        connections: [
            { id: "prompt-connection", fromNodeId: "prompt", toNodeId: "config" },
            { id: "old-connection", fromNodeId: "old", toNodeId: "config" },
        ],
    };
    const ops = opsOf("canvas_run_generation", { nodeId: "config", referenceNodeIds: ["new"] }, state);
    assert.deepEqual(ops, [
        { type: "delete_connections", ids: ["old-connection"] },
        { type: "connect_nodes", fromNodeId: "new", toNodeId: "config", role: "reference", order: 0 },
        { type: "run_generation", nodeId: "config", mode: "image", prompt: undefined },
    ]);
});

test("running generation preserves the explicitly selected segment", () => {
    const ops = opsOf("canvas_run_generation", { nodeId: "config", segmentId: "S03" });
    assert.deepEqual(ops, [
        { type: "run_generation", nodeId: "config", mode: "image", prompt: undefined, segmentId: "S03" },
    ]);
});

test("generation flow anchors to the first reference node (same row, x = ref.right + 96)", () => {
    // 第一次 MCP 生成在画布中段铺了一组 result，下游想接着做第二次生成时，新 prompt/config 必须
    // 贴在 firstReference 节点的同行右侧，而不是被 nextCanvasX 推到画布全局最右。
    const state = {
        nodes: [
            { id: "ref", type: "image", position: { x: 1000, y: 240 }, width: 320, height: 240 },
        ],
    };
    const ops = opsOf("canvas_generate_image", { prompt: "a follow-up shot", referenceNodeIds: ["ref"], autoRun: true }, state);
    const text = ops.find((op) => op.type === "add_node" && op.nodeType === "text");
    const config = ops.find((op) => op.type === "add_node" && op.nodeType === "config");
    // text 起点 = firstReference 右边 + 96、y 与 reference 对齐
    assert.equal((text as { position: { x: number; y: number } }).position.x, 1000 + 320 + 96);
    assert.equal((text as { position: { x: number; y: number } }).position.y, 240);
    // config 在 text 右边 420（保持老间距口径），y 同样与 reference 对齐
    assert.equal((config as { position: { x: number; y: number } }).position.x, 1000 + 320 + 96 + 420);
    assert.equal((config as { position: { x: number; y: number } }).position.y, 240);
});

test("generation flow falls back to canvas-far-right + y=0 when no reference is given", () => {
    const state = {
        nodes: [
            { id: "only", type: "image", position: { x: 0, y: 0 }, width: 320, height: 240 },
        ],
    };
    const ops = opsOf("canvas_generate_image", { prompt: "lone prompt", autoRun: true }, state);
    const text = ops.find((op) => op.type === "add_node" && op.nodeType === "text");
    // 没有 reference 时退回到 nextCanvasX（画布全局最右 + 80），y 用 0
    assert.equal((text as { position: { x: number; y: number } }).position.x, 320 + 80);
    assert.equal((text as { position: { x: number; y: number } }).position.y, 0);
});
