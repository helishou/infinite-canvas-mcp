import assert from "node:assert/strict";
import test from "node:test";

import { appendPreviousReference, appendTailFramePrompt, boundH3ParentTaskIds, buildH3ContinuationTask, collectH3Refs, resolveClipContinuation, routeTailFrameInput } from "./h3-runner.js";

test("启动恢复只选仍绑定在节点或 Clip 上的 H3 父任务", () => {
    const projects = [{ id: "p", nodes: [
        { id: "h3", metadata: { runtimeTaskId: "active-parent", segments: [
            { id: "done", status: "success", runtimeTaskId: "", parentTaskId: "" },
            { id: "settled-stale-id", status: "success", runtimeTaskId: "", parentTaskId: "settled-parent" },
            { id: "loading", status: "loading", runtimeTaskId: "child", parentTaskId: "clip-parent" },
        ] } },
        { id: "image", metadata: { runtimeTaskId: "other-task" } },
    ] }];
    assert.deepEqual([...boundH3ParentTaskIds(projects)], ["active-parent", "clip-parent", "other-task"]);
    assert.deepEqual([...boundH3ParentTaskIds([{ id: "settled", nodes: [{ id: "h3", metadata: { segments: [{ status: "success" }] } }] }])], []);
});

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

test("尾帧参考追加独立图片，保留原首尾帧和引用编号", () => {
    const first = { id: "first-binding", name: "原首帧", type: "image" };
    const last = { id: "last-binding", name: "本段尾帧", type: "image" };
    const tail = { id: "runtime-tail", name: "上一段尾帧参考", resolved: "tail.png", type: "image" };
    const routed = routeTailFrameInput("fl2v", ["first.png", "last.png"], [first, last], tail);
    assert.equal(routed.taskMode, "ref2va");
    assert.deepEqual(routed.images, ["first.png", "last.png", "tail.png"]);
    assert.deepEqual(routed.actualReferences.slice(0, 2), [first, last]);
    assert.equal(routed.tailImageOrdinal, 3);
    assert.equal(routed.actualReferences[2].role, "motion_reference");
    assert.equal(routed.actualReferences[2].usage, "continuity_reference");
    assert.equal(routed.actualReferences[2].replacesBindingId, undefined);
    const original = "subject_definitions:\n<Picture 1> opening\n<Picture 2> closing\nretention_analysis:\nKeep <Picture 2>.\ndetailed_description:\n[Shot 1] Open with <Picture 1>.";
    const prompt = appendTailFramePrompt(original, "Clip 1", routed.tailImageOrdinal);
    assert.match(prompt, /<Picture 1> opening/);
    assert.match(prompt, /<Picture 2> closing/);
    assert.match(prompt, /\[Shot 1\] Open with <Picture 1>/);
    assert.match(prompt, /<Picture 3> is the ending frame/);
    assert.match(prompt, /pose, movement direction, scene layout, lighting and ongoing action/);
    assert.match(prompt, /defines the required opening state/);
    assert.match(prompt, /tail frame takes priority for the first-frame state/);
    assert.match(prompt, /Do not reset or repeat an action already completed/);
    assert.doesNotMatch(prompt, /hard-cut|shot-entry keyframe/);
});

test("尾帧参考独立于保存模式，文生和图生运行时均以多参考接收", () => {
    const tail = { id: "tail", resolved: "tail.png" };
    const text = routeTailFrameInput("t2v", [], [], tail);
    assert.equal(text.taskMode, "ref2va");
    assert.deepEqual(text.images, ["tail.png"]);
    const image = routeTailFrameInput("i2v", ["original.png"], [{ id: "first" }], tail);
    assert.equal(image.taskMode, "ref2va");
    assert.deepEqual(image.images, ["original.png", "tail.png"]);
    assert.equal(image.tailImageOrdinal, 2);
});

test("尾帧参考保留本段分镜、合成面板和后续镜头，不再替换分镜图1", () => {
    const original = "subject_definitions:\n<Picture 1> is the approved storyboard.\nretention_analysis:\n<Picture 1> ([Shot 1]): fully_preserved.\ndetailed_description:\n[Shot 1] Use the approved sheet from <Picture 1> as the target composition reference for this shot. In the composite storyboard image, this is Panel 1 (row 1, column 1), shared by [Shot 1].\n[Shot 2] Continue with <Picture 2>.\nA single submitted image is a composite storyboard sheet arranged in a 1-row by 2-column grid.\noverall_soundscape:\nWind.";
    const refs = [{ id: "board-1", role: "storyboard", type: "image" }, { id: "board-2", role: "storyboard", type: "image" }];
    const routed = routeTailFrameInput("ref2va", ["old.png", "next.png"], refs, { id: "tail", resolved: "tail.png" });
    assert.deepEqual(routed.images, ["old.png", "next.png", "tail.png"]);
    assert.deepEqual(routed.actualReferences.slice(0, 2), refs);
    const prompt = appendTailFramePrompt(original, "Clip 1", routed.tailImageOrdinal);
    for (const preserved of ["approved sheet from <Picture 1>", "Panel 1 (row 1, column 1)", "<Picture 1> ([Shot 1]): fully_preserved", "[Shot 2] Continue with <Picture 2>", "A single submitted image is a composite storyboard sheet", "Wind."]) assert.ok(prompt.includes(preserved), preserved);
    assert.match(prompt, /Start this segment from the physical state shown in <Picture 3> from Clip 1/);
    assert.equal(original.includes("<Picture 3>"), false);
});

test("尾帧插入图片组末尾，音视频引用顺序保持且不静默丢弃超额参考", () => {
    const refs = [{ id: "image", type: "image" }, { id: "video", type: "video" }, { id: "audio", type: "audio" }];
    const routed = routeTailFrameInput("ref2va", ["image.png"], refs, { id: "tail", resolved: "tail.png" });
    assert.deepEqual(routed.actualReferences.map((ref) => ref.id), ["image", "tail", "video", "audio"]);
    assert.throws(() => routeTailFrameInput("ref2va", Array(9).fill("image.png"), [], { resolved: "tail.png" }), /9 张上限/);
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
