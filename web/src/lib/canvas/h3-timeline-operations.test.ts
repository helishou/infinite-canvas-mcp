import assert from "node:assert/strict";
import test from "node:test";
import { recoverH3StartOperations } from "./h3-timeline-operations";

const base = { nodes: [{ id: "h3", metadata: { segments: [{ id: "a", duration: 5 }, { id: "b", duration: 5 }] } }] };
test("旧起点草稿保留时长和正文，剥离派生字段而不改变原请求", () => {
    const operations = [{ type: "update_h3_segment", nodeId: "h3", segmentId: "a", patch: { duration: 8, prompt: "保留" } },
        { type: "update_h3_segment", nodeId: "h3", segmentId: "b", patch: { start: 8 } }];
    assert.deepEqual(recoverH3StartOperations(operations, base), [operations[0]]);
    assert.deepEqual(operations[1].patch, { start: 8 });
});
test("旧排序起点转换为移动命令，保留所有非时间轴操作", () => {
    const operations = [{ type: "update_h3_segment", nodeId: "h3", segmentId: "a", patch: { start: 5 } },
        { type: "update_h3_segment", nodeId: "h3", segmentId: "b", patch: { start: 0, prompt: "新" } },
        { type: "update_node", id: "image", patch: { title: "保留" } }];
    assert.deepEqual(recoverH3StartOperations(operations, base), [
        { type: "update_h3_segment", nodeId: "h3", segmentId: "b", patch: { prompt: "新" } }, operations[2],
        { type: "move_h3_segment", nodeId: "h3", segmentId: "b", beforeSegmentId: "a" },
    ]);
});
test("无法推断的重叠、缺失基线和删起点草稿拒绝转换", () => {
    const op = { type: "update_h3_segment", nodeId: "h3", segmentId: "b", patch: { start: 0 } };
    assert.equal(recoverH3StartOperations([op], base), null);
    assert.equal(recoverH3StartOperations([op], { nodes: [] }), null);
    assert.equal(recoverH3StartOperations([{ ...op, patch: {}, patchDelete: ["start"] }], base), null);
});
