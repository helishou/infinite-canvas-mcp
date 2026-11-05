import assert from "node:assert/strict";
import test from "node:test";

import { repairMcpToolArguments } from "./mcp-arg-integrity.js";

const op = { type: "update_h3_segment", nodeId: "n1", segmentId: "s1", patch: { visual: "慕璃站在条案后，面朝人群与镜头" } };

test("宿主流式重拼把同一个 op 数组复制五份时只留一份", () => {
    const { input, repairs, changed } = repairMcpToolArguments({ operationId: "x", expectedRevision: 12, ops: [op, op, op, op, op] });
    assert.equal(changed, true);
    assert.deepEqual((input as { ops: unknown[] }).ops, [op]);
    assert.equal(repairs.duplicateEntries, 4);
    assert.deepEqual(repairs.paths, ["ops"]);
    assert.equal((input as { operationId: string }).operationId, "x");
});

test("type 被吞掉时按唯一兄弟条目补回，补回后再折叠重复", () => {
    const { type: _type, ...withoutType } = op;
    const { input, repairs } = repairMcpToolArguments({ ops: [op, withoutType, withoutType, withoutType] });
    assert.deepEqual((input as { ops: unknown[] }).ops, [op], "补回 type 后与首条完全相同，于是折叠成一条");
    assert.equal(repairs.restoredTypes, 3);
    assert.equal(repairs.duplicateEntries, 3);
});

test("没有兄弟条目可以对照时不猜 type，原样交给校验拒绝", () => {
    const { type: _type, ...withoutType } = op;
    const { input, changed, repairs } = repairMcpToolArguments({ ops: [withoutType] });
    assert.equal(changed, false);
    assert.deepEqual((input as { ops: unknown[] }).ops, [withoutType]);
    assert.equal(repairs.restoredTypes, 0);
});

test("兄弟条目给出两个不同 type 时保持原样，不按任意一个补", () => {
    const { type: _type, ...withoutType } = op;
    const other = { ...op, type: "add_h3_segment" };
    const { input, changed } = repairMcpToolArguments({ ops: [op, other, withoutType] });
    assert.equal(changed, false);
    assert.equal(input, input);
    assert.equal((input as { ops: unknown[] }).ops.length, 3);
});

test("需要保留的重复内容不动：字符串数组、不同 op、嵌套 patch 原样返回", () => {
    const ops = [
        { type: "update_h3_segment", nodeId: "n1", segmentId: "s1", patch: { voice: "他说：走。" } },
        { type: "update_h3_segment", nodeId: "n1", segmentId: "s2", patch: { voice: "他说：走。" } },
        { type: "request_director_shot_refresh", shotIds: ["S1", "S1"] },
    ];
    const value = { ops, tags: ["同一句", "同一句"], nested: { list: [{ filePath: "a.png" }, { filePath: "b.png" }] } };
    const { input, changed } = repairMcpToolArguments(value);
    assert.equal(changed, false, "没有传输损坏时必须是同一个对象引用，不做无意义改写");
    assert.equal(input, value);
});

test("截断重拼出的另一个症状：条目自身字段残缺时保持原样，不当作重复折叠", () => {
    const truncated = { type: "update_h3_segment", nodeId: "n1", segmentId: "s1", patch: { visual: "慕璃站在条案后" } };
    const { input, changed } = repairMcpToolArguments({ ops: [op, truncated] });
    assert.equal(changed, false);
    assert.equal((input as { ops: unknown[] }).ops.length, 2);
});

test("不做深拷贝以外的破坏：未修复的兄弟对象引用保持不变", () => {
    const nested = { ops: [op, op], meta: { keep: true } };
    const { input } = repairMcpToolArguments(nested);
    assert.equal((input as typeof nested).meta, nested.meta);
    assert.equal((input as typeof nested).ops[0], op);
});
