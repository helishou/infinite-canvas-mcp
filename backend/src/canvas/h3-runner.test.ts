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

test("FL2VA 尾帧接续替换首帧槽位，保留本段尾帧和 Picture 编号", () => {
    const first = { id: "first-binding", name: "原首帧", type: "image" };
    const last = { id: "last-binding", name: "本段尾帧", type: "image" };
    const tail = { id: "runtime-tail", name: "上一段尾帧", resolved: "tail.png", type: "image", usage: "first_frame" };
    const routed = routeTailFrameInput("fl2v", ["old-first.png", "last.png"], [first, last], tail);
    assert.equal(routed.taskMode, "fl2v");
    assert.deepEqual(routed.images, ["tail.png", "last.png"]);
    assert.deepEqual(routed.actualReferences.map((ref) => [ref.id, ref.name]), [["first-binding", "上一段尾帧"], ["last-binding", "本段尾帧"]]);
    assert.equal(routed.actualReferences[0].replacesBindingId, "first-binding");
    const prompt = appendTailFramePrompt("subject_definitions:\n<Picture 1> old first\n<Picture 2> last\nretention_analysis:\nKeep <Picture 2>.", "Clip 1", routed.replacedFirstFrame);
    assert.match(prompt, /<Picture 1> is the opening frame/);
    assert.match(prompt, /<Picture 2> last/);
    assert.doesNotMatch(prompt, /<Picture 3>/);
});

test("I2V 替换首帧；T2V 转为 I2V；Ref2VA 在首位插入尾帧", () => {
    const tail = { id: "tail", resolved: "tail.png" };
    assert.deepEqual(routeTailFrameInput("i2v", ["original.png"], [{ id: "first" }], tail).images, ["tail.png"]);
    const text = routeTailFrameInput("t2v", [], [], tail);
    assert.equal(text.taskMode, "i2v");
    assert.deepEqual(text.images, ["tail.png"]);
    const refs = routeTailFrameInput("ref2va", ["a.png", "b.png"], [{ id: "a" }, { id: "b" }], tail);
    assert.deepEqual(refs.images, ["tail.png", "a.png", "b.png"]);
    assert.deepEqual(refs.actualReferences.map((ref) => ref.id), ["tail", "a", "b"]);
    assert.equal(refs.actualReferences[0].role, "storyboard");
});

test("Ref2VA 运行时用尾帧替换分镜图 1，并在 Shot 1 后引用 Picture 1", () => {
    const savedPrompt = `subject_definitions:\n<Picture 1> is the old storyboard frame.\n\nretention_analysis:\n<Picture 1> ([Shot 1]): fully_preserved.\n\ndetailed_description:\n[Shot 1] Use the approved old frame from <Picture 1> as the target composition reference for this shot. Opening action.\n[Shot 2] Use the approved next frame from <Picture 2> as the target composition reference for this shot. Next action.\n\noverall_soundscape:\nWind.`;
    const refs = [{ id: "board-1", role: "storyboard", type: "image" }, { id: "board-2", role: "storyboard", type: "image" }];
    const routed = routeTailFrameInput("ref2va", ["old.png", "next.png"], refs, { id: "runtime-tail", resolved: "tail.png", name: "上一段尾帧" });
    assert.equal(routed.replacedFirstFrame, true);
    assert.deepEqual(routed.images, ["tail.png", "next.png"]);
    assert.deepEqual(routed.actualReferences.map((ref) => [ref.id, ref.role]), [["board-1", "storyboard"], ["board-2", "storyboard"]]);
    const submittedPrompt = appendTailFramePrompt(savedPrompt, "Clip 1", routed.replacedFirstFrame, true);
    assert.match(submittedPrompt, /\[Shot 1\] Use the approved ending frame of Clip 1 from <Picture 1> as the shot-entry keyframe/);
    assert.doesNotMatch(submittedPrompt, /approved old frame/);
    assert.doesNotMatch(submittedPrompt, /<Picture 1> is the old storyboard frame/);
    assert.doesNotMatch(submittedPrompt, /<Picture 1> \(\[Shot 1\]\): fully_preserved/);
    assert.match(submittedPrompt, /\n\[Shot 2\] Use the approved next frame from <Picture 2>/);
    assert.match(submittedPrompt, /<Picture 1> \(\[Shot 1\] first frame\): partially_preserved/);
    assert.match(savedPrompt, /approved old frame/);
});

test("Ref2VA 无分镜图时运行态插入尾帧并顺延原引用；合成分镜图保留原槽位", () => {
    const refs = [{ id: "character", role: "character_identity", type: "image" }];
    const inserted = routeTailFrameInput("ref2va", ["character.png"], refs, { id: "tail", resolved: "tail.png" });
    assert.equal(inserted.replacedFirstFrame, false);
    assert.deepEqual(inserted.images, ["tail.png", "character.png"]);
    const prompt = appendTailFramePrompt("detailed_description:\n[Shot 1] <Picture 1> enters.\n[Shot 2] Later.", "Clip 1", false, true);
    assert.match(prompt, /\[Shot 1\] Use the approved ending frame of Clip 1 from <Picture 1>[^\n]*<Picture 2> enters/);
    assert.match(prompt, /\n\[Shot 2\] Later/);
    const composite = routeTailFrameInput("ref2va", ["sheet.png"], [{ id: "sheet", role: "storyboard", type: "image" }], { id: "tail", resolved: "tail.png" }, true);
    assert.deepEqual(composite.images, ["tail.png", "sheet.png"]);
    assert.deepEqual(composite.actualReferences.map((ref) => ref.id), ["tail", "sheet"]);
    const compositePrompt = appendTailFramePrompt("detailed_description:\n[Shot 1] Use the approved sheet from <Picture 1> as the target composition reference for this shot. In the composite storyboard image, this is Panel 1 (row 1, column 1), shared by [Shot 1]. Start.\n[Shot 2] Continue.\nA single submitted image is a composite storyboard sheet arranged in a 1-row by 2-column grid.", "Clip 1", false, true, true);
    assert.match(compositePrompt, /\[Shot 1\] Use the approved ending frame of Clip 1 from <Picture 1>/);
    assert.doesNotMatch(compositePrompt, /approved sheet/);
    assert.doesNotMatch(compositePrompt, /this is Panel 1/);
    assert.match(compositePrompt, /<Picture 2> is a composite storyboard sheet/);
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
