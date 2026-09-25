import test from "node:test";
import assert from "node:assert/strict";

import { refsForSegment, replaceSegmentReference, withSegmentRefs } from "./h3-data";
import { dropUnboundStoryboardReferences, rebindStoryboardShot, removeStoryboardShot, storyboardTrackItems } from "./h3-storyboard-track";
import type { H3Ref, H3Segment } from "../types";

function storyboardSegment(): H3Segment {
    const base: H3Segment = {
        id: "clip-1",
        duration: 8,
        taskMode: "ref2va",
        refItems: [],
        storyboardModeEnabled: true,
        storyboardShots: [],
    };
    const withRefs = withSegmentRefs(base, [
        { url: "https://media.test/board-a.png", storageKey: "image:board-a", type: "image", name: "分镜 A", role: "storyboard" },
        { url: "https://media.test/scene.png", storageKey: "image:scene", type: "image", name: "场景", role: "scene" },
        { url: "https://media.test/board-b.png", storageKey: "image:board-b", type: "image", name: "分镜 B", role: "storyboard" },
    ]);
    const ids = refsForSegment(withRefs).map((ref) => ref.bindingId!);
    return {
        ...withRefs,
        storyboardShots: [
            { id: "shot-1", referenceBindingId: ids[0], duration: 3 },
            { id: "shot-2", referenceBindingId: ids[2], duration: 5 },
        ],
        storyboardDurations: { [ids[0]]: 3, [ids[2]]: 5 },
    };
}

function boardsOf(segment: H3Segment) {
    return storyboardTrackItems(segment).map((item) => ({
        id: item.id,
        image: item.ref?.storageKey,
        duration: Number(item.duration.toFixed(6)),
    }));
}

test("从画布替换分镜图后，分镜卡停在原位置且图片换成新素材", () => {
    const segment = storyboardSegment();
    const before = boardsOf(segment);
    assert.deepEqual(before.map((item) => item.image), ["image:board-a", "image:board-b"]);

    const target = refsForSegment(segment).find((ref) => ref.storageKey === "image:board-a")!;
    const updated = replaceSegmentReference(segment, target, [
        { url: "https://media.test/board-a2.png", storageKey: "image:board-a2", type: "image", name: "分镜 A 新版" },
    ]);

    const after = boardsOf(updated);
    // 卡片数量不变、顺序不变、时长不变，只有第一格换了图。
    assert.equal(after.length, 2);
    assert.deepEqual(after.map((item) => item.id), before.map((item) => item.id));
    assert.deepEqual(after.map((item) => item.image), ["image:board-a2", "image:board-b"]);
    assert.deepEqual(after.map((item) => item.duration), before.map((item) => item.duration));
    // 引用槽顺序与职责保持：新图仍在原槽位，场景参考没被挤走。
    assert.deepEqual(refsForSegment(updated).map((ref) => [ref.storageKey, ref.role]), [
        ["image:board-a2", "storyboard"],
        ["image:scene", "scene"],
        ["image:board-b", "storyboard"],
    ]);
    // 分镜轨不该留下指向已删 bindingId 的孤立引用。
    const bindingIds = new Set(refsForSegment(updated).map((ref) => ref.bindingId));
    for (const shot of updated.storyboardShots || []) {
        if (shot.referenceBindingId) assert.ok(bindingIds.has(shot.referenceBindingId), `孤立分镜引用 ${shot.referenceBindingId}`);
    }
});

test("替换时被换掉的分镜图素材已经在本 Clip 里则不改动", () => {
    const segment = storyboardSegment();
    const target = refsForSegment(segment).find((ref) => ref.storageKey === "image:board-a")!;
    const unchanged = replaceSegmentReference(segment, target, [
        { url: "https://media.test/scene.png", storageKey: "image:scene", type: "image", name: "场景" },
    ]);
    assert.equal(unchanged, segment);
});

test("角色组替换分镜图时把原分镜卡改绑到新插入的角色图，且沿用原时长", () => {
    const segment = storyboardSegment();
    const oldRef = refsForSegment(segment).find((ref) => ref.storageKey === "image:board-a")!;
    const oldShotDuration = storyboardTrackItems(segment).find((item) => item.referenceBindingId === oldRef.bindingId)?.duration;
    assert.equal(oldShotDuration, 3);
    // 模拟「先摘掉旧 ref、再插入一张拿不到原 bindingId 的角色图」这条路径。
    const withoutOld = withSegmentRefs(segment, refsForSegment(segment).filter((ref) => ref.bindingId !== oldRef.bindingId));
    const inserted = withSegmentRefs(withoutOld, [
        ...refsForSegment(withoutOld),
        { url: "https://media.test/outfit.png", storageKey: "image:char-outfit", type: "image", name: "沈侯 · 冬装", role: "storyboard" },
    ]);
    const replacementId = refsForSegment(inserted).find((ref) => ref.storageKey === "image:char-outfit")!.bindingId!;
    const rebound = rebindStoryboardShot(inserted, oldRef.bindingId, replacementId, oldShotDuration);

    const shots = rebound.storyboardShots || [];
    assert.ok(shots.some((shot) => shot.referenceBindingId === replacementId));
    assert.ok(!shots.some((shot) => shot.referenceBindingId === oldRef.bindingId));
    // 卡片数量与顺序不变，且被换的那格沿用原来的 3 秒，而不是重算出来的值。
    assert.deepEqual(boardsOf(rebound).map((item) => item.image), ["image:char-outfit", "image:board-b"]);
    assert.deepEqual(boardsOf(rebound).map((item) => item.duration), [3, 5]);
});

test("自愈：指向已删引用的分镜卡清掉绑定后变成可绑图的空卡", () => {
    const segment = storyboardSegment();
    // 真实脏数据：图已被删掉，卡片却还记着它的 bindingId
    const target = refsForSegment(segment).find((ref) => ref.storageKey === "image:board-a")!;
    const withoutRef = withSegmentRefs(segment, refsForSegment(segment).filter((ref) => ref.bindingId !== target.bindingId));
    const stale = { ...withoutRef, storyboardShots: [{ id: "shot-1", referenceBindingId: target.bindingId, duration: 3 }, ...(withoutRef.storyboardShots || []).slice(1)] };
    const healed = dropUnboundStoryboardReferences(stale);
    const first = (healed.storyboardShots || [])[0];
    assert.equal(first.referenceBindingId, undefined);
    assert.equal(first.duration, 3);
    // 仍然保持一张空卡（可以重新绑图），而不是整格消失。
    assert.deepEqual(boardsOf(healed).map((item) => item.image ?? null), [null, "image:board-b"]);
});

test("删除分镜卡时同步删掉它的参考素材，不该残留在 ref 区", () => {
    const segment = storyboardSegment();
    const updated = removeStoryboardShot(segment, "shot-1");
    // 分镜轨只剩一张。
    assert.deepEqual(boardsOf(updated).map((item) => item.image), ["image:board-b"]);
    // 被删分镜图的引用必须一起消失，不能靠改 role 躲进 ref 区。
    const remaining = refsForSegment(updated) as H3Ref[];
    assert.equal(remaining.some((ref) => ref.storageKey === "image:board-a"), false, "被删分镜图仍留在 refs 里");
    assert.deepEqual(remaining.map((ref) => [ref.storageKey, ref.role]), [
        ["image:scene", "scene"],
        ["image:board-b", "storyboard"],
    ]);
    // 剩余分镜卡的时长吸收被删卡的时长，总时长不变。
    assert.equal(Number((updated.storyboardShots || []).reduce((sum, shot) => sum + Number(shot.duration || 0), 0).toFixed(6)), 8);
});

test("替换出的第一个候选沿用原 bindingId，后续候选顺序插在其后", () => {
    const segment = storyboardSegment();
    const target = refsForSegment(segment).find((ref) => ref.storageKey === "image:scene")!;
    const updated = replaceSegmentReference(segment, target, [
        { url: "https://media.test/other.png", storageKey: "image:other", type: "image", name: "替换场景" },
        { url: "https://media.test/extra.png", storageKey: "image:extra", type: "image", name: "额外素材" },
    ]);
    const refs = refsForSegment(updated) as H3Ref[];
    assert.equal(refs[1].storageKey, "image:other");
    assert.equal(refs[1].bindingId, target.bindingId);
    assert.equal(refs[2].storageKey, "image:extra");
});
