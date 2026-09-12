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
