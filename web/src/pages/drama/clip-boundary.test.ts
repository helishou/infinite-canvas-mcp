import assert from "node:assert/strict";
import test from "node:test";
import { boundaryCounts, clipBoundaryAutoScrollDelta, clipBoundaryPositions, clipDurationSeconds, clipPartitionProfileMix, createClipBoundaryPointerHandlers, materializeClipPartition, nearestBoundaryCount, outsideClipWindow, partitionAt } from "./clip-boundary";

const clips = [
    { id: "A", shot_ids: ["S1", "S2"], mode: "H3", mode_lock: true, mode_selection_reason: "locked", styleTemplateId: "style-1" },
    { id: "B", shot_ids: ["S3", "S4", "S5"], mode: "H3", mode_lock: true, mode_selection_reason: "locked", styleTemplateId: "style-1" },
    { id: "C", shot_ids: ["S6", "S7"], mode: "H3-FL2V", mode_lock: false, mode_selection_reason: "auto", styleTemplateId: "style-2" },
];
const shots = [1, 2, 3, 4, 5, 6, 7].map(index => ({ id: `S${index}`, start_frame: (index - 1) * 96, end_frame: index * 96, duration_frames: 96 }));

test("模式理由文字不同不要求重新选择执行配置，显式风格选择仍区分", () => {
    const same = [clips[0], { ...clips[1], mode_selection_reason: "另一种理由写法" }];
    assert.equal(clipPartitionProfileMix(same, [{ ids: ["S1", "S2", "S3"] }])[0].mixed, false);
    assert.equal(materializeClipPartition(same, [{ ids: ["S1", "S2", "S3"] }])[0].executionProfileSourceId, undefined);
    assert.equal(clipPartitionProfileMix([{ ...clips[0], styleTemplateId: undefined }, { ...clips[1], styleTemplateId: null }], [{ ids: ["S1", "S2", "S3"] }])[0].mixed, true);
});

test("分割块候选覆盖每个 Clip 至少 1 个镜头的位置", () => {
    assert.deepEqual(boundaryCounts(2, 3), [1, 2, 3, 4]);
    assert.deepEqual(boundaryCounts(1, 1), [1]);
    assert.deepEqual(boundaryCounts(0, 1), []);
});

test("分区夹到两端，不能越过另一侧的非空边界", () => {
    assert.deepEqual(partitionAt(["S1", "S2"], ["S3", "S4", "S5"], 1), { left: ["S1"], right: ["S2", "S3", "S4", "S5"], count: 1 });
    assert.deepEqual(partitionAt(["S1", "S2"], ["S3", "S4", "S5"], 99), { left: ["S1", "S2", "S3", "S4"], right: ["S5"], count: 4 });
    assert.deepEqual(partitionAt(["S1", "S2"], ["S3", "S4", "S5"], -3), { left: ["S1"], right: ["S2", "S3", "S4", "S5"], count: 1 });
    assert.deepEqual(partitionAt(["S1", "S2"], ["S3"], 2), { left: ["S1", "S2"], right: ["S3"], count: 2 });
});

test("指针吸附到最近的边界候选", () => {
    const edges = [{ count: 1, edge: 100 }, { count: 2, edge: 240 }, { count: 3, edge: 400 }];
    assert.equal(nearestBoundaryCount(90, edges), 1);
    assert.equal(nearestBoundaryCount(260, edges), 2);
    assert.equal(nearestBoundaryCount(900, edges), 3);
    assert.equal(nearestBoundaryCount(10, edges), 1);
});

test("未改变整套 Shot 时沿用旧 Clip 身份与执行配置", () => {
    const [left] = materializeClipPartition(clips, [{ ids: ["S1", "S2"] }]);
    assert.equal(left.id, "A");
    assert.equal(left.mode, "H3");
    assert.equal(left.styleTemplateId, "style-1");
    assert.equal(left.executionProfileSourceId, undefined);
});

test("覆盖范围变化时不复用旧 id，并继承来源片段的执行配置", () => {
    const [left, right] = materializeClipPartition(clips, [{ ids: ["S1"] }, { ids: ["S2", "S3", "S4", "S5"] }]);
    assert.equal(left.id, undefined);
    assert.deepEqual(left.shot_ids, ["S1"]);
    assert.equal(left.executionProfileSourceId, undefined);
    assert.equal(left.styleTemplateId, "style-1");
    assert.equal(right.id, undefined);
    assert.equal(right.styleTemplateId, "style-1");
    assert.equal(right.executionProfileSourceId, undefined);
});

test("合并执行配置不同的片段时必须指明沿用哪一段", () => {
    const resolved = materializeClipPartition(clips, [{ ids: ["S6", "S7", "S8"], profileSourceId: "C" }]);
    assert.deepEqual(resolved[0].shot_ids, ["S6", "S7", "S8"]);
    assert.equal(resolved[0].executionProfileSourceId, undefined);
    const conflicting = materializeClipPartition([...clips, { id: "D", shot_ids: ["S8"], mode: "H3", mode_lock: false, mode_selection_reason: "auto" }], [{ ids: ["S1", "S2", "S8"], profileSourceId: "D" }]);
    assert.equal(conflicting[0].executionProfileSourceId, "D");
    assert.equal(conflicting[0].mode, "H3");
    assert.equal(conflicting[0].mode_lock, false);
});

test("时长按帧窗计算，并识别 4–15 秒生成窗", () => {
    assert.equal(clipDurationSeconds(["S1", "S2"], shots, 24), 8);
    assert.equal(clipDurationSeconds(["S1"], shots, 24), 4);
    assert.equal(clipDurationSeconds(["S1", "S2", "S3", "S4"], shots, 24), 16);
    assert.equal(outsideClipWindow(16), true);
    assert.equal(outsideClipWindow(3.5), true);
    assert.equal(outsideClipWindow(4), false);
    assert.equal(outsideClipWindow(15), false);
});

// 模式理由是说明文字，不改变执行配置，也不应使跨界拖动失败。
test("模式与风格相同时，选择原因不同的旧 Clip 可以直接混合", () => {
    const realistic = [
        { id: "CLIP_01", shot_ids: ["S1", "S2"], mode: "Ref2VA", mode_lock: "Ref2VA", mode_selection_reason: "沿用指定 MiniMax H3 多参视频；缺图时阻塞。" },
        { id: "CLIP_02", shot_ids: ["S3", "S4"], mode: "Ref2VA", mode_lock: "Ref2VA", mode_selection_reason: "保持 H3 多参 Ref2VA；不切换 T2VA。" },
    ];
    const [mix] = clipPartitionProfileMix(realistic, [{ ids: ["S1", "S2", "S3"], profileSourceId: "CLIP_01" }]);
    assert.equal(mix.mixed, false);
    assert.deepEqual(mix.sources.map(clip => clip.id), ["CLIP_01", "CLIP_02"]);
    const [left, right] = materializeClipPartition(realistic, [{ ids: ["S1", "S2", "S3"], profileSourceId: "CLIP_01" }, { ids: ["S4"], profileSourceId: "CLIP_02" }]);
    assert.equal(left.executionProfileSourceId, undefined);
    assert.equal(left.mode_selection_reason, "沿用指定 MiniMax H3 多参视频；缺图时阻塞。");
    assert.equal(left.id, undefined);
    assert.equal(right.executionProfileSourceId, undefined);
    assert.equal(right.mode_selection_reason, "保持 H3 多参 Ref2VA；不切换 T2VA。");
});

// 没有真实参数冲突时，无需携带执行配置来源。
test("未指明来源时混合分组不带 executionProfileSourceId", () => {
    const realistic = [
        { id: "CLIP_01", shot_ids: ["S1", "S2"], mode: "Ref2VA", mode_lock: "Ref2VA", mode_selection_reason: "甲" },
        { id: "CLIP_02", shot_ids: ["S3", "S4"], mode: "Ref2VA", mode_lock: "Ref2VA", mode_selection_reason: "乙" },
    ];
    const [left] = materializeClipPartition(realistic, [{ ids: ["S1", "S2", "S3"] }]);
    assert.equal(left.executionProfileSourceId, undefined);
});

test("vertical boundary uses client Y and preserves content coordinates while scrolling", () => {
 const rects = [{ left: 40, right: 200, top: 180, bottom: 260 }, { left: 40, right: 200, top: 280, bottom: 360 }];
 const first = clipBoundaryPositions(rects, [1], { left: 20, top: 100 }, 50, true);
 assert.deepEqual(first, [{ count: 1, viewport: 270, content: 220 }]);
 const moved = clipBoundaryPositions(rects.map(rect => ({ ...rect, top: rect.top - 30, bottom: rect.bottom - 30 })), [1], { left: 20, top: 100 }, 80, true);
 assert.equal(moved[0].content, first[0].content);
 assert.equal(nearestBoundaryCount(239, moved.map(edge => ({ count: edge.count, edge: edge.viewport }))), 1);
 assert.deepEqual(clipBoundaryPositions(rects, [1], { left: 20, top: 100 }, 10), [{ count: 1, viewport: 120, content: 110 }]);
});

test("vertical boundary drag auto-scrolls toward either reachable edge and clamps to the track", () => {
 const track = { top: 100, bottom: 500 };
 assert.equal(clipBoundaryAutoScrollDelta(110, track, 50, 1000, 400), -12);
 assert.equal(clipBoundaryAutoScrollDelta(490, track, 595, 1000, 400), 5);
 assert.equal(clipBoundaryAutoScrollDelta(300, track, 300, 1000, 400), 0);
 assert.equal(clipBoundaryAutoScrollDelta(110, track, 0, 1000, 400), 0);
 assert.equal(clipBoundaryAutoScrollDelta(490, track, 600, 1000, 400), 0);
});

test("boundary pointer events capture one primary pointer, prevent selection, and commit its final drop", () => {
 type PointerSample = { pointerId: number; button: number; clientY: number; currentTarget: { setPointerCapture: (pointerId: number) => void }; preventDefault: () => void };
 const pointer = { current: null as number | null }, captured: number[] = [], committed: number[] = [];
 const edges = [{ count: 1, edge: 100 }, { count: 2, edge: 250 }, { count: 3, edge: 400 }];
 let starts = 0, finishes = 0, cancellations = 0, prevented = false, preview = 1;
 const handlers = createClipBoundaryPointerHandlers<PointerSample>(pointer, {
  begin: () => { starts += 1; return true; },
  move: event => { preview = nearestBoundaryCount(event.clientY, edges) ?? preview; },
  finish: event => {
   finishes += 1;
   const finalCount = nearestBoundaryCount(event.clientY, edges) ?? preview;
   if (finalCount !== 1) committed.push(finalCount);
  },
  cancel: () => { cancellations += 1; },
 });
 const target = { setPointerCapture: (pointerId: number) => captured.push(pointerId) };
 const event = (pointerId: number, button: number, clientY: number): PointerSample => ({
  pointerId, button, clientY, currentTarget: target,
  preventDefault: () => { prevented = true; },
 });

 handlers.onPointerDown(event(4, 2, 110));
 assert.equal(starts, 0, "secondary button does not start a drag");
 assert.equal(prevented, false);
 handlers.onPointerDown(event(4, 0, 110));
 assert.equal(starts, 1);
 assert.equal(prevented, true, "a drag start suppresses browser text selection");
 assert.deepEqual(captured, [4], "the full drag surface captures the active pointer");
 assert.equal(pointer.current, 4);

 handlers.onPointerDown(event(5, 0, 200));
 handlers.onPointerMove(event(5, 0, 350));
 assert.equal(starts, 1, "a second pointer cannot take over the boundary");
 assert.equal(preview, 1, "moves from another pointer are ignored");
 handlers.onPointerMove(event(4, 0, 350));
 assert.equal(preview, 3);
 handlers.onPointerUp(event(5, 0, 350));
 assert.equal(finishes, 0, "only the captured pointer can finish the drag");
 assert.equal(pointer.current, 4);
 handlers.onPointerUp(event(4, 0, 390));
 assert.equal(finishes, 1);
 assert.deepEqual(committed, [3], "pointerup commits the final snapped boundary count");
 assert.equal(pointer.current, null);
 handlers.onLostPointerCapture(event(4, 0, 390));
 assert.equal(cancellations, 0, "implicit capture release after pointerup does not undo the completed drag");

 handlers.onPointerDown(event(6, 0, 110));
 handlers.onPointerMove(event(6, 0, 300));
 handlers.onPointerCancel(event(6, 0, 300));
 assert.equal(cancellations, 1);
 assert.equal(pointer.current, null);
 assert.deepEqual(committed, [3], "cancelling a drag does not save a partial boundary");
});
