import test from "node:test";
import assert from "node:assert/strict";

import { buildRestoreParamsPatch } from "./h3-segment-utils";
import type { H3Ref, H3Segment } from "../types";

const targetSegment: H3Segment = {
    id: "target-clip",
    taskMode: "ref2va",
    duration: 8,
    h3CharacterGroups: {
        "group-shenhou": {
            id: "group-shenhou",
            characterName: "沈侯",
            characterNodeId: "character-shenhou",
            subjectId: "shenhou",
            outfits: [{ id: "outfit-winter", name: "冬装", url: "/media/shenhou.png", storageKey: "image:shenhou", role: "character_turnaround", enabled: true }],
            voiceEnabled: false,
        },
    },
    storyboardShots: [
        { id: "stale-shot", referenceBindingId: "deleted-binding", duration: 4 },
        { id: "stale-empty-shot", duration: 4 },
    ],
};

const historicalOutput: H3Ref = {
    url: "/media/result.mp4",
    type: "video",
    name: "历史输出",
    generationLogId: "generation-1",
    params: {
        prompt: "历史提示词",
        duration: 6,
        refs: [
            { url: "/media/shenhou.png", storageKey: "image:shenhou", type: "image", name: "沈侯 · 冬装", role: "character_turnaround", subjectId: "shenhou", groupId: "group-shenhou", outfitId: "outfit-winter" },
            { url: "/media/board.png", storageKey: "image:board", type: "image", name: "分镜图", role: "storyboard" },
        ],
    },
};

test("还原历史输出时从当前角色组补齐角色 binding 的源角色节点", () => {
    const patch = buildRestoreParamsPatch([], historicalOutput, targetSegment);
    const characterBinding = patch.referenceBindings?.find((binding) => binding.groupId === "group-shenhou");
    assert.equal(characterBinding?.sourceNodeId, "character-shenhou");
});

test("还原引用时丢弃旧 storyboardShots，按历史分镜引用重建，避免空槽叠加", () => {
    const patch = buildRestoreParamsPatch([], historicalOutput, targetSegment);
    const boardBinding = patch.referenceBindings?.find((binding) => binding.role === "storyboard");
    assert.ok(boardBinding);
    assert.deepEqual(patch.storyboardShots, [{ id: boardBinding.id, referenceBindingId: boardBinding.id }]);
    assert.equal(patch.storyboardShots?.some((shot) => shot.id === "stale-shot"), false);
    assert.equal(patch.storyboardShots?.some((shot) => shot.id === "stale-empty-shot"), false);
});
