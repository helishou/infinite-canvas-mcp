import assert from "node:assert/strict";
import test from "node:test";

import { applyCanvasProjectOperations } from "./project-ops.js";

type Project = { revision?: number; nodes: Array<Record<string, unknown>>; connections: Array<Record<string, unknown>>; selectedNodeIds?: string[]; viewport?: Record<string, unknown> };

function makeH3Node(overrides: Partial<{ id: string; segments: Array<Record<string, unknown>> }> = {}): Record<string, unknown> {
    return {
        id: overrides.id || "h3-1",
        type: "minimax-h3:video",
        title: "H3 节点",
        position: { x: 0, y: 0 },
        width: 600,
        height: 400,
        metadata: {
            segments: overrides.segments || [
                { id: "s1", prompt: "开场", status: "idle" },
                { id: "s2", prompt: "中段", status: "idle" },
            ],
        },
    };
}

function makeProject(nodes: Array<Record<string, unknown>>): Project {
    return { revision: 1, nodes, connections: [] };
}

test("update_h3_segment：按 segmentId 原子更新单段字段，不动其它段", () => {
    const project = makeProject([makeH3Node()]);
    const results = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_h3_segment", nodeId: "h3-1", segmentId: "s1", patch: { prompt: "新的开场", status: "loading" } },
    ]);
    assert.equal(results[0].ok, true);
    assert.deepEqual(results[0].updatedSegmentIds, ["s1"]);
    const segments = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.equal(segments[0].prompt, "新的开场");
    assert.equal(segments[0].status, "loading");
    assert.equal(segments[1].prompt, "中段");
});

test("update_h3_segment：CAS 失败时抛错（runtimeTaskId 已被清空）", () => {
    // 旧任务试图回写时本应 CAS 失败：当前段 runtimeTaskId 已被新任务清空，而旧任务仍带 expectedFields.runtimeTaskId = "task-A"
    const project = makeProject([makeH3Node({
        segments: [
            { id: "s1", prompt: "开场", status: "running", runtimeTaskId: "" },
        ],
    })]);
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_h3_segment", nodeId: "h3-1", segmentId: "s1", patch: { status: "success" }, expectedFields: { runtimeTaskId: "task-A" } },
    ]), /CAS 失败/);
});

test("update_h3_segment：patchDelete 正确删除段内字段", () => {
    const project = makeProject([makeH3Node({
        segments: [
            { id: "s1", prompt: "开场", status: "error", errorDetails: "旧错误" } as Record<string, unknown>,
        ],
    })]);
    applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_h3_segment", nodeId: "h3-1", segmentId: "s1", patch: { status: "success" }, patchDelete: ["errorDetails"] },
    ]);
    const seg = ((project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>)[0];
    assert.equal(seg.status, "success");
    assert.equal("errorDetails" in seg, false);
});

test("add_h3_segment：按 id 追加新段到末尾，重复 id 抛错", () => {
    const project = makeProject([makeH3Node()]);
    applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "add_h3_segment", nodeId: "h3-1", segment: { id: "s3", prompt: "新段" } },
    ]);
    const segments = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.equal(segments.length, 3);
    assert.equal(segments[2].id, "s3");
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "add_h3_segment", nodeId: "h3-1", segment: { id: "s3", prompt: "重复" } },
    ]), /已存在/);
});

test("delete_h3_segment：按 id 删除；远端已无该段视为 skipped", () => {
    const project = makeProject([makeH3Node()]);
    const results = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "delete_h3_segment", nodeId: "h3-1", segmentId: "s2" },
    ]);
    assert.deepEqual(results[0].deletedSegmentIds, ["s2"]);
    const segments = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.equal(segments.length, 1);
    assert.equal(segments[0].id, "s1");
    // 远端已删
    const second = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "delete_h3_segment", nodeId: "h3-1", segmentId: "s2" },
    ]);
    assert.equal(second[0].skipped, true);
});

test("replace_h3_segments：完全替换；id 集合变化是允许的", () => {
    const project = makeProject([makeH3Node()]);
    const results = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "replace_h3_segments", nodeId: "h3-1", segments: [
            { id: "x1", prompt: "全新计划 1" },
            { id: "x2", prompt: "全新计划 2" },
        ] },
    ]);
    assert.deepEqual(results[0].deletedSegmentIds?.sort(), ["s1", "s2"]);
    assert.deepEqual(results[0].createdSegmentIds?.sort(), ["x1", "x2"]);
    const segments = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.deepEqual(segments.map((s) => s.id), ["x1", "x2"]);
});

test("update_node.metadata.segments 严格校验：id 集合不一致时抛错", () => {
    const project = makeProject([makeH3Node()]);
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_node", id: "h3-1", metadata: { segments: [{ id: "s1" }, { id: "sX" }] } },
    ]), /metadata.segments 必须为完整数组/);
});

test("update_node.metadata.segments 严格校验：id 数量一致但少了某个 id 时抛错", () => {
    const project = makeProject([makeH3Node()]);
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_node", id: "h3-1", metadata: { segments: [{ id: "s1" }, { id: "s1" }] } },
    ]), /metadata.segments 必须为完整数组/);
});

test("update_node.metadata.segments 严格校验：完整替换（同长同 id）允许", () => {
    const project = makeProject([makeH3Node()]);
    const results = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_node", id: "h3-1", metadata: { segments: [
            { id: "s1", prompt: "A", status: "idle" },
            { id: "s2", prompt: "B", status: "idle" },
        ] } },
    ]);
    assert.equal(results[0].ok, true);
    const segments = (project.nodes[0].metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.equal(segments[0].prompt, "A");
    assert.equal(segments[1].prompt, "B");
});

test("非 H3 节点 metadata.segments 出现就抛错", () => {
    const project = makeProject([{ id: "img-1", type: "image", title: "图片", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: {} }]);
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_node", id: "img-1", metadata: { segments: [{ id: "s1" }] } },
    ]), /只有 H3 节点/);
});

test("update_h3_segment 在非 H3 节点上抛错", () => {
    const project = makeProject([{ id: "img-1", type: "image", title: "图片", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: {} }]);
    assert.throws(() => applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_h3_segment", nodeId: "img-1", segmentId: "s1", patch: { status: "loading" } },
    ]), /不是 H3 节点/);
});

test("混合：H3 节点级 metadata + 单段 patch 共存，revision 一次 +1", () => {
    const project = makeProject([makeH3Node()]);
    const results = applyCanvasProjectOperations(project as Record<string, unknown>, [
        { type: "update_h3_segment", nodeId: "h3-1", segmentId: "s1", patch: { status: "loading" } },
        { type: "update_node", id: "h3-1", metadata: { status: "running", runProgress: 0.5 } },
    ]);
    assert.equal(results.length, 2);
    const node = project.nodes[0];
    const segments = (node.metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>;
    assert.equal(segments[0].status, "loading");
    assert.equal(segments[1].status, "idle");
    assert.equal((node.metadata as Record<string, unknown>).status, "running");
    assert.equal((node.metadata as Record<string, unknown>).runProgress, 0.5);
});
