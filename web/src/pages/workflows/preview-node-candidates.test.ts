import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { isStepPreviewBridge, preferredPreviewNodeId, previewNodeCandidates } from "./preview-node-candidates.js";

/** 从「MiniMax-H3 高速大动态」工作流里摘出的真实节点结构（UI 格式，节点编号未变）。 */
const realFlowSlice = {
    version: 0.4,
    nodes: [
        { id: 141, type: "ModelPreviewOverrideKJ", mode: 0, inputs: [], outputs: [], widgets_values: [1024, 80, true, 1, 24, "taeh3.safetensors", ""] },
        { id: 221, type: "SaveVideo", mode: 0, inputs: [], outputs: [], widgets_values: ["video/MiniMax_H3"] },
        { id: 591, type: "MiniMaxH3SemanticBridgeConfigT8", mode: 0, inputs: [], outputs: [] },
        // mode 4 = bypass，不执行；VHS_LoadVideo 名字里带 VHS 也不该被当成预览源。
        { id: 473, type: "VHS_LoadVideo", mode: 4, inputs: [], outputs: [] },
        { id: 136, type: "MiniMaxH3ReferenceToVideo", mode: 0, inputs: [], outputs: [] },
    ],
    links: [],
};

test("预览桥候选只收 Preview/Save 类且排除 bypass 节点", () => {
    const candidates = previewNodeCandidates(realFlowSlice as never);
    assert.deepEqual(candidates.map((item) => item.nodeId), ["141", "221"]);
    assert.equal(isStepPreviewBridge("ModelPreviewOverrideKJ"), true);
    assert.equal(isStepPreviewBridge("SaveVideo"), false);
    assert.equal(isStepPreviewBridge("MiniMaxH3SemanticBridgeConfigT8"), false);
});

test("唯一逐帧桥自动推荐；多个桥时交给用户单选", () => {
    assert.equal(preferredPreviewNodeId(realFlowSlice as never), "141");
    const twoBridges = {
        ...realFlowSlice,
        nodes: [...realFlowSlice.nodes, { id: 142, type: "ModelPreviewOverrideKJ", mode: 0, inputs: [], outputs: [] }],
    };
    assert.equal(preferredPreviewNodeId(twoBridges as never), "");
});

test("API 格式工作流同样能识别逐帧桥", () => {
    const graph = {
        "141": { class_type: "ModelPreviewOverrideKJ", inputs: {} },
        "221": { class_type: "SaveVideo", inputs: {} },
    };
    assert.equal(preferredPreviewNodeId(graph as never), "141");
});

/**
 * 可选的真实样本回归：设置 INFINITE_CANVAS_WORKFLOW_FIXTURE 指向本地 ComfyUI 工作流 JSON，
 * 验证用户实际用的流里能否自动找到唯一预览桥。未设置时自动跳过，测试不依赖外部文件。
 */
test("外部工作流样本（可选）能找到预览桥节点", () => {
    const fixture = process.env.INFINITE_CANVAS_WORKFLOW_FIXTURE;
    if (!fixture || !existsSync(fixture)) return;
    const graph = JSON.parse(readFileSync(fixture, "utf8"));
    const candidates = previewNodeCandidates(graph);
    const bridges = candidates.filter((item) => isStepPreviewBridge(item.classType, item.label));
    assert.ok(bridges.length > 0, "样本里应该至少有一个逐帧预览桥");
    assert.equal(preferredPreviewNodeId(graph), bridges.length === 1 ? bridges[0].nodeId : "");
});
