import assert from "node:assert/strict";
import test from "node:test";
import { boundaryCounts, clipDurationSeconds, clipPartitionProfileMix, materializeClipPartition, nearestBoundaryCount, outsideClipWindow, partitionAt } from "./clip-boundary";

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
