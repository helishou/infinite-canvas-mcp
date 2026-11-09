import assert from "node:assert/strict";
import test from "node:test";

import { durationTargetFromField, inferDurationUnit, isDurationTargetFor } from "./duration-target.js";

test("单位推断与后端一致", () => {
    assert.equal(inferDurationUnit("length"), "frames");
    assert.equal(inferDurationUnit("num_frames"), "frames");
    assert.equal(inferDurationUnit("value"), "seconds");
    assert.equal(inferDurationUnit("duration_seconds"), "seconds");
});

test("字段编辑器勾「作为时长」派生配置单值，勾选态只认同一 node::input", () => {
    assert.deepEqual(durationTargetFromField({ node: "132", input: "value" }), { nodeId: "132", input: "value", unit: "seconds" });
    assert.deepEqual(durationTargetFromField({ node: "136", input: "length" }), { nodeId: "136", input: "length", unit: "frames" });
    assert.equal(durationTargetFromField({ node: "152,156", input: "value" }), null, "多节点字段没有唯一注入目标");
    assert.equal(durationTargetFromField({ node: "132", input: "" }), null);
    const target = durationTargetFromField({ node: "136", input: "length" });
    assert.equal(isDurationTargetFor(target, "136", "length"), true);
    assert.equal(isDurationTargetFor(target, "132", "value"), false, "勾了 136 后 132 不能还显示勾选");
    assert.equal(isDurationTargetFor(null, "136", "length"), false);
});
