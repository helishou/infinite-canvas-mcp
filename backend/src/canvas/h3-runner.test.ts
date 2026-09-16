import assert from "node:assert/strict";
import test from "node:test";

import { appendPreviousReference, buildH3ContinuationTask, collectH3Refs, resolveClipContinuation } from "./h3-runner.js";

// 回归防线：链式续跑曾把上一段成品静默塞进下一段的「视频1（参考视频）」——
// 旧实现曾把 motionContextEnabled 误解为上一段成品视频注入开关。
// 下面这些断言锁死「默认绝不注入、只有显式开关才注入」。

const previousReady = { id: "s1", result: "http://local/media/clip-1", tailFrameContinuation: false };

test("默认不把上一段成品带进下一段：既不当参考视频也不抓尾帧", () => {
    const decision = resolveClipContinuation({ id: "s2" }, previousReady, true, {});
    assert.equal(decision.usePreviousAsReference, false);
    assert.equal(decision.useTailFrame, false);
    assert.equal(decision.needsPreviousVideo, false);
    assert.deepEqual(appendPreviousReference(["own.mp4"], ""), ["own.mp4"]);
});

test("motionContextEnabled 只控制潜空间续写，不隐式注入参考视频", () => {
    const decision = resolveClipContinuation({ id: "s2", motionContextEnabled: true }, previousReady, true, {});
    assert.equal(decision.usePreviousAsReference, false);
    assert.equal(decision.needsPreviousVideo, false);
});

test("V15 潜空间续写描述符使用 ComfyUI 主节点 ID，而不是画布节点 ID", () => {
    assert.deepEqual(JSON.parse(buildH3ContinuationTask("project-1", "group-1", "run-1", 2)), {
        workflow: "project-1", node: "nf_v15", group: "group-1", run: "run-1", index: 2,
    });
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

test("上一段没结果时不抓视频，单独生成下一段也能抓尾帧", () => {
    assert.equal(resolveClipContinuation({ id: "s2" }, { id: "s1" }, true, {}).needsPreviousVideo, false);
    const tail = resolveClipContinuation({ id: "s2" }, { id: "s1", result: "http://local/media/clip-1", tailFrameContinuation: true }, true, {});
    assert.equal(tail.useTailFrame, true);
    assert.equal(tail.usePreviousAsReference, false);
    assert.equal(tail.needsPreviousVideo, true);
    const singleClip = resolveClipContinuation({ id: "s2" }, { id: "s1", result: "http://local/media/clip-1", tailFrameContinuation: true }, false, {});
    assert.equal(singleClip.useTailFrame, true);
    assert.equal(singleClip.needsPreviousVideo, true);
});

test("参考视频已达 3 段上限时报错而不是静默丢弃", () => {
    assert.throws(() => appendPreviousReference(["a.mp4", "b.mp4", "c.mp4"], "prev.mp4"), /3 段上限/);
    assert.deepEqual(appendPreviousReference([], "prev.mp4"), ["prev.mp4"]);
});

test("H3 参考图保持画布 refs 槽位顺序，不按旧 order 字段重排", () => {
    const refs = collectH3Refs({
        refItems: [
            { name: "苏晚", url: "su-wan.png", type: "image", order: 2 },
            { name: "沈昭", url: "shen-zhao.png", type: "image", order: 1 },
            { name: "S03-1", url: "s03-1.png", type: "image" },
        ],
    });
    assert.deepEqual(refs.map((ref) => ref.name), ["苏晚", "沈昭", "S03-1"]);
});
