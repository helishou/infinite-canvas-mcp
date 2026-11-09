import assert from "node:assert/strict";
import test from "node:test";

import { applyVideoContinuation } from "./video-continuation.js";

/**
 * 最小化复刻「无限流」工作流的续写骨架（节点 ID 与真实图一致）：
 * 14 循环入口、13 当前段号加法器、11 起始段号、10 结束段号、12 段数计算、
 * 705 续段判定(索引>0)、1240 多段判定(段数>1)、48 重叠帧规划、704/1245 判定消费方。
 */
function skeleton(): Record<string, unknown> {
    return {
        "14": { class_type: "easy forLoopStart", inputs: { total: ["12", 1] } },
        "13": { class_type: "MathExpression|pysssss", inputs: { a: ["14", 1], b: ["11", 0], expression: "a+b" } },
        "11": { class_type: "PrimitiveInt", inputs: { value: 3 } },
        "10": { class_type: "PrimitiveInt", inputs: { value: 0 } },
        "12": { class_type: "ComfyMathExpression", inputs: { "values.a": ["10", 0], "values.b": ["11", 0], expression: "a-b+1" } },
        "705": { class_type: "ComfyMathExpression", inputs: { "values.a": ["14", 1], expression: "a > 0" } },
        "1240": { class_type: "ComfyMathExpression", inputs: { "values.a": ["12", 1], expression: "a > 1" } },
        "48": { class_type: "ComfyMathExpression", inputs: { "values.a": ["6", 0], "values.b": ["14", 1], expression: "22*(b>0)" } },
        "704": { class_type: "ComfyBooleanSwitch", inputs: { switch: ["705", 2], on_true: ["14", 2], on_false: ["9", 0] } },
        "1245": { class_type: "ComfyBooleanSwitch", inputs: { boolean: ["1240", 2] } },
    };
}

test("非侵入：深拷贝原图，动态追加续写节点并改写循环种子与判定", () => {
    const original = skeleton();
    const snapshot = JSON.stringify(original);
    const { workflow: out, summary } = applyVideoContinuation(original, "prev.mp4");

    assert.equal(JSON.stringify(original), snapshot, "不得修改存储的原工作流图");
    assert.deepEqual(out["14"].inputs.initial_value1, ["vc_tail_img", 0]);
    assert.deepEqual(out["14"].inputs.initial_value2, ["vc_prev_video", 0]);
    assert.deepEqual(out["14"].inputs.initial_value3, ["vc_tail_audio", 1]);
    assert.equal(out["11"].inputs.value, 1);
    assert.equal(out["10"].inputs.value, 1);
    assert.equal(out.vc_load.inputs.video, "prev.mp4");
    assert.deepEqual(out.vc_tail_img.inputs.image, ["vc_load", 0]);
    assert.equal(out.vc_tail_img.inputs.batch_index, -22);
    assert.deepEqual(out.vc_tail_audio.inputs.audio, ["vc_load", 2]);
    assert.deepEqual(out.vc_prev_video.inputs.images, ["vc_load", 0]);
    // summary 是本次执行实际改写的事实，供生成日志证明续写已进入执行。
    assert.deepEqual(summary, {
        prevVideoFile: "prev.mp4",
        addedNodes: 9,
        loopId: "14",
        startSegmentNode: "11",
        endSegmentNode: "10",
        continuationRewires: 2,
        overlapRewires: 1,
    });
});

test("续段/多段判定的所有 BOOL 消费方改接恒真旗标，重叠帧规划改接恒 1", () => {
    const { workflow: out } = applyVideoContinuation(skeleton(), "prev.mp4");
    assert.deepEqual(out["704"].inputs.switch, ["vc_resume_flag", 0]);
    assert.deepEqual(out["1245"].inputs.boolean, ["vc_resume_flag", 0]);
    assert.deepEqual(out["48"].inputs["values.b"], ["vc_overlap_flag", 0]);
    assert.equal(out.vc_resume_flag.inputs.value, true);
    assert.equal(out.vc_overlap_flag.inputs.value, 1);
    // 原判定输出不再被消费
    for (const node of Object.values(out) as any[]) {
        for (const value of Object.values(node.inputs || {})) {
            if (Array.isArray(value)) {
                assert.ok(!(value[0] === "705" && value[1] === 2));
                assert.ok(!(value[0] === "1240" && value[1] === 2));
            }
        }
    }
});

test("缺少上一段成片文件名时拒绝", () => {
    assert.throws(() => applyVideoContinuation(skeleton(), "  "), /上一段成片文件名/);
});

test("没有循环入口的工作流不支持续写", () => {
    const graph = skeleton();
    delete graph["14"];
    assert.throws(() => applyVideoContinuation(graph, "prev.mp4"), /forLoopStart/);
});

test("节点 ID 冲突时拒绝，避免覆盖原流节点", () => {
    const graph = skeleton();
    graph.vc_load = { class_type: "VHS_LoadVideo", inputs: { video: "x.mp4" } };
    assert.throws(() => applyVideoContinuation(graph, "prev.mp4"), /ID 冲突/);
});