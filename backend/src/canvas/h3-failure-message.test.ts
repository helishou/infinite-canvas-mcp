/**
 * 失败原因序列化的行为测试。
 *
 * 背景：真实事故里整段视频生成失败，任务历史只留下 "[object Object]"，
 * 无法判断是显卡、提示词还是参数问题，只能盲试。根因就是 String(对象)。
 * 这里用引擎真实回执的几种形状把它钉住。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { describeFailure } from "./h3-runner.js";

test("Error 实例取 message", () => {
    assert.equal(describeFailure(new Error("参考图未通过校验")), "参考图未通过校验");
});

test("字符串原样返回，空白串不返回空", () => {
    assert.equal(describeFailure("CUDA out of memory"), "CUDA out of memory");
    assert.equal(describeFailure("   "), "未知错误");
});

test("{code, message} 对象取 message，绝不再出 [object Object]", () => {
    const error = { code: "WORKFLOW_FAILED", message: "ComfyUI 节点 124 执行失败" };
    const text = describeFailure(error);
    assert.equal(text, "ComfyUI 节点 124 执行失败");
    assert.ok(!text.includes("[object Object]"));
});

test("{error:{message}} 嵌套对象递归取真因", () => {
    const error = { error: { message: "ffmpeg 无法打开输入文件" } };
    const text = describeFailure(error);
    assert.equal(text, "ffmpeg 无法打开输入文件");
    assert.ok(!text.includes("[object Object]"));
});

test("只有 code 时返回 code", () => {
    assert.equal(describeFailure({ code: "INVALID_REQUEST" }), "INVALID_REQUEST");
});

test("无已知字段的对象退化为 JSON，而不是 [object Object]", () => {
    const text = describeFailure({ stage: "sampling", node: "nf_ref_condition" });
    assert.ok(text.includes("sampling"));
    assert.ok(!text.includes("[object Object]"));
});

test("null/undefined 给兜底文案", () => {
    assert.equal(describeFailure(null), "未知错误");
    assert.equal(describeFailure(undefined), "未知错误");
});

test("循环引用对象不抛异常", () => {
    const loop: Record<string, unknown> = { stage: "sampling" };
    loop.self = loop;
    const text = describeFailure(loop);
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0);
    assert.ok(!text.includes("[object Object]"));
});
