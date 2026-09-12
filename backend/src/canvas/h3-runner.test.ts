import assert from "node:assert/strict";
import test from "node:test";

import { appendPreviousReference, resolveClipContinuation } from "./h3-runner.js";

// 回归防线：链式续跑曾把上一段成品静默塞进下一段的「视频1（参考视频）」——
// 触发条件藏在已失效的 motionContextEnabled 里，UI 与生成日志都看不出来。
// 下面这些断言锁死「默认绝不注入、只有显式开关才注入」。

const previousReady = { id: "s1", result: "http://local/media/clip-1", tailFrameContinuation: false };

test("默认不把上一段成品带进下一段：既不当参考视频也不抓尾帧", () => {
    const decision = resolveClipContinuation({ id: "s2" }, previousReady, true, {});
    assert.equal(decision.usePreviousAsReference, false);
    assert.equal(decision.useTailFrame, false);
    assert.equal(decision.needsPreviousVideo, false);
    assert.deepEqual(appendPreviousReference(["own.mp4"], ""), ["own.mp4"]);
});

test("motionContextEnabled 不再是隐式注入开关", () => {
    const decision = resolveClipContinuation({ id: "s2", motionContextEnabled: true }, previousReady, true, {});
    assert.equal(decision.usePreviousAsReference, false);
    assert.equal(decision.needsPreviousVideo, false);
});

test("只有本段显式开启 previousVideoAsReference 才注入参考视频", () => {
    const decision = resolveClipContinuation({ id: "s2", previousVideoAsReference: true }, previousReady, true, {});
    assert.equal(decision.usePreviousAsReference, true);
    assert.equal(decision.useTailFrame, false);
    assert.equal(decision.needsPreviousVideo, true);
    assert.deepEqual(appendPreviousReference(["own.mp4"], "prev.mp4"), ["own.mp4", "prev.mp4"]);
});

test("运行参数（override）也能开启，但单段运行（非续跑）一律不注入", () => {
    assert.equal(resolveClipContinuation({ id: "s2" }, previousReady, true, { previousVideoAsReference: true }).needsPreviousVideo, true);
    assert.equal(resolveClipContinuation({ id: "s2", previousVideoAsReference: true }, previousReady, false, {}).needsPreviousVideo, false);
});

test("上一段没结果时不抓视频，上一段开了尾帧接续才抓", () => {
    assert.equal(resolveClipContinuation({ id: "s2" }, { id: "s1" }, true, {}).needsPreviousVideo, false);
    const tail = resolveClipContinuation({ id: "s2" }, { id: "s1", result: "http://local/media/clip-1", tailFrameContinuation: true }, true, {});
    assert.equal(tail.useTailFrame, true);
    assert.equal(tail.usePreviousAsReference, false);
    assert.equal(tail.needsPreviousVideo, true);
});

test("参考视频已达 3 段上限时报错而不是静默丢弃", () => {
    assert.throws(() => appendPreviousReference(["a.mp4", "b.mp4", "c.mp4"], "prev.mp4"), /3 段上限/);
    assert.deepEqual(appendPreviousReference([], "prev.mp4"), ["prev.mp4"]);
});
