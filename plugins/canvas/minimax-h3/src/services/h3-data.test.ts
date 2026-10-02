import test from "node:test";
import assert from "node:assert/strict";

import {
    applyCharacterGroupEdits,
    promoteCharacterSourceReferences,
    refsForSegment,
    refsFromCharacterGroup,
    syncCharacterGroupFromSource,
    upsertCharacterGroup,
    withSegmentRefs,
    removeCharacterGroup,
    segmentRefsPatch,
} from "./h3-data";
import type { H3CharacterGroup, H3Segment } from "../types";

import { characterGroupBindings } from "../../../../../canvas-agent/src/canvas/reference-contract";

function derivedFixture(): H3Segment {
    const groups = Object.fromEntries(["su", "shen"].map((id) => [id, {
        id, characterName: id, characterNodeId: `node-${id}`,
        outfits: [{ id: `outfit-${id}`, name: "四视图", url: `https://media.test/${id}?token=new`, storageKey: `image:${id}`, enabled: true }],
        voiceEnabled: false,
    }]));
    return { id: "derived", taskMode: "ref2va", h3CharacterGroups: groups, referenceBindings: [
        { id: "scene", assetId: "scene-asset", label: "场景", role: "scene", mediaType: "image", storageKey: "image:scene" },
        { id: "disabled", assetId: "disabled-asset", label: "保留", role: "other", mediaType: "image", storageKey: "image:disabled", enabled: false, tags: ["keep"] },
    ] };
}

test("手工场景与两个角色组共享解析得到三张参考，ID 来源顺序对齐后台", () => {
    const segment = derivedFixture();
    const refs = refsForSegment(segment);
    assert.deepEqual(refs.map((ref) => ref.storageKey), ["image:scene", "image:su", "image:shen"]);
    const expected = Object.values(segment.h3CharacterGroups!).flatMap((group) => characterGroupBindings(group as unknown as Record<string, unknown>));
    assert.deepEqual(refs.slice(1).map((ref) => [ref.bindingId, ref.assetId, ref.nodeId]), expected.map((binding) => [binding.id, binding.assetId, binding.sourceNodeId]));
});

test("旧角色参考在场景之前时，参考卡与共享编译保留同一图片顺序", () => {
    const segment = derivedFixture();
    segment.referenceBindings!.unshift({
        ...characterGroupBindings(segment.h3CharacterGroups!.su as unknown as Record<string, unknown>)[0],
        id: "old-su", storageKey: "image:old", url: "https://media.test/old",
    });
    assert.deepEqual(refsForSegment(segment).map((ref) => ref.storageKey), ["image:su", "image:scene", "image:shen"]);
});

test("历史角色快照由当前组刷新且删除孤儿，手工编辑不双写派生项并保留禁用绑定", () => {
    const segment = derivedFixture();
    segment.referenceBindings!.push(
        { id: "old-su", assetId: "old-asset", label: "旧图", role: "character_turnaround", mediaType: "image", groupId: "su", outfitId: "outfit-su", storageKey: "image:old", url: "https://media.test/old?token=old" },
        { id: "orphan", assetId: "orphan-asset", label: "已删", role: "other", mediaType: "image", groupId: "deleted", storageKey: "image:orphan" },
    );
    const refs = refsForSegment(segment);
    assert.deepEqual(refs.map((ref) => ref.storageKey), ["image:scene", "image:su", "image:shen"]);
    const edited = withSegmentRefs(segment, [...refs, { type: "image", url: "", storageKey: "image:prop", name: "道具" }]);
    assert.equal(edited.referenceBindings?.some((binding) => binding.groupId), false);
    assert.deepEqual(edited.referenceBindings?.find((binding) => binding.id === "disabled"), segment.referenceBindings![1]);
    assert.equal(segmentRefsPatch(refs).referenceBindings?.length, 1);
    assert.deepEqual(refsForSegment(removeCharacterGroup(edited, "su")).map((ref) => ref.storageKey), ["image:scene", "image:prop", "image:shen"]);
});

test("角色服装声线关闭与重开不泄漏快照也不删除可恢复目录", () => {
    const segment = derivedFixture();
    segment.h3CharacterGroups!.su.voice = { url: "https://media.test/voice", storageKey: "audio:su", name: "声线" };
    segment.h3CharacterGroups!.su.voiceEnabled = true;
    const off = applyCharacterGroupEdits(segment, "su", { outfitEnabled: false, voiceEnabled: false });
    assert.ok(off.h3CharacterGroups?.su);
    assert.deepEqual(refsForSegment(off).map((ref) => ref.storageKey), ["image:scene", "image:shen"]);
    const on = applyCharacterGroupEdits(off, "su", { outfitEnabled: true, voiceEnabled: true });
    assert.deepEqual(refsForSegment(on).map((ref) => ref.storageKey), ["image:scene", "image:su", "audio:su", "image:shen"]);
    assert.equal(on.referenceBindings?.some((binding) => binding.groupId), false);
});

test("legacy buckets 和禁用手工引用仍兼容，token 更新按 storageKey 去重", () => {
    const segment = derivedFixture();
    const bindings = segment.referenceBindings!;
    segment.referenceBindings = undefined;
    segment.refItems = [];
    segment.refs = { image: [
        { type: "image", url: "", storageKey: "image:scene", name: "场景" },
        { type: "image", url: "", storageKey: "image:disabled", name: "保留", enabled: false },
        { type: "image", url: "https://media.test/su?token=old", storageKey: "image:su", name: "旧角色", groupId: "su", outfitId: "outfit-su" },
    ] };
    const refs = refsForSegment(segment);
    assert.deepEqual(refs.map((ref) => ref.storageKey), ["image:scene", "image:su", "image:shen"]);
    assert.equal(refs[1].url, "https://media.test/su?token=new");
    const edited = withSegmentRefs(segment, refs);
    assert.equal(edited.referenceBindings?.find((binding) => binding.storageKey === "image:disabled")?.enabled, false);
    assert.equal(edited.referenceBindings?.some((binding) => binding.groupId), false);
    const canonical = { ...segment, referenceBindings: bindings };
    assert.deepEqual(segmentRefsPatch(refsForSegment(canonical), canonical).referenceBindings?.find((binding) => binding.id === "disabled"), bindings[1]);
});

const sourceOutfits = [
    { url: "https://media.test/shen-zhao-1.png", name: "三年前·退婚", storageKey: "image:shen-zhao-1" },
    { url: "https://media.test/shen-zhao-2.png", name: "婚后·常服", storageKey: "image:shen-zhao-2" },
    { url: "https://media.test/shen-zhao-3.png", name: "夜行·斗篷", storageKey: "image:shen-zhao-3" },
];

test("图片源转角色后原位接入角色组，保留绑定、顺序和 Clip 职责", () => {
    const segment: H3Segment = { id: "converted", taskMode: "ref2va", referenceBindings: [
        { id: "before", assetId: "a", label: "场景", role: "scene", mediaType: "image", url: "https://media.test/scene.png" },
        { id: "original", assetId: "b", label: "智能生成", role: "other", mediaType: "image", sourceNodeId: "converted-source", url: sourceOutfits[1].url, storageKey: sourceOutfits[1].storageKey, tags: ["keep"] },
        { id: "disabled", assetId: "c", label: "保留参考", role: "other", mediaType: "image", url: "https://media.test/disabled.png", enabled: false },
    ] };
    const source = { characterName: "沈昭宁", characterNodeId: "converted-source", outfits: sourceOutfits };
    const converted = promoteCharacterSourceReferences(segment, source);
    const refs = refsForSegment(converted);
    assert.deepEqual(refs.map((ref) => ref.bindingId), ["before", "original"]);
    assert.equal(refs[1].name, "沈昭宁 · 婚后·常服");
    assert.equal(refs[1].role, "character_turnaround");
    assert.equal(refs[1].subjectId, "converted-source");
    assert.equal(refs[1].assetId, "b");
    assert.deepEqual(refs[1].tags, ["keep"]);
    assert.deepEqual(converted.referenceBindings?.[2], segment.referenceBindings?.[2]);
    assert.deepEqual(groupFrom(converted).outfits.map((outfit) => outfit.enabled), [false, true, false]);
    assert.equal(promoteCharacterSourceReferences(converted, source), converted);
    const refreshed = syncCharacterGroupFromSource(converted, groupFrom(converted).id, source);
    assert.deepEqual(refsForSegment(refreshed).map((ref) => ref.bindingId), ["before", "original"]);
    const storyboard = { ...segment, referenceBindings: segment.referenceBindings!.map((binding) => binding.id === "original" ? { ...binding, role: "storyboard" as const } : binding) };
    assert.equal(promoteCharacterSourceReferences(storyboard, source), storyboard);
    const unrelated = { ...source, characterNodeId: "unrelated" };
    assert.equal(promoteCharacterSourceReferences(segment, unrelated), segment);
});

function groupFrom(segment: H3Segment): H3CharacterGroup {
    const group = Object.values(segment.h3CharacterGroups || {})[0];
    assert.ok(group);
    return group;
}

test("同源 upsert 不能用当前选中的一套覆盖完整服装目录", () => {
    const initial = upsertCharacterGroup({ id: "clip-1", taskMode: "ref2va", refItems: [] }, {
        characterName: "沈昭宁",
        characterNodeId: "character-shen-zhaoning",
        outfits: sourceOutfits,
    });
    const initialGroup = groupFrom(initial);
    const selectedOnly = upsertCharacterGroup(initial, {
        characterName: "沈昭宁",
        characterNodeId: "character-shen-zhaoning",
        outfits: [sourceOutfits[0]],
    });

    const group = groupFrom(selectedOnly);
    assert.equal(initialGroup.outfits.length, 3);
    assert.equal(group.outfits.length, 3);
    assert.deepEqual(group.outfits.map((outfit) => outfit.storageKey), sourceOutfits.map((outfit) => outfit.storageKey));
});

test("编辑当前 Clip 的选择只改变 enabled，不删除目录项", () => {
    const initial = upsertCharacterGroup({ id: "clip-2", taskMode: "ref2va", refItems: [] }, {
        characterName: "沈昭宁",
        characterNodeId: "character-shen-zhaoning",
        outfits: sourceOutfits,
    });
    const group = groupFrom(initial);
    const edited = applyCharacterGroupEdits(initial, group.id, {
        outfitEnabledById: {
            [group.outfits[0].id]: true,
            [group.outfits[1].id]: false,
            [group.outfits[2].id]: false,
        },
    });

    const editedGroup = groupFrom(edited);
    assert.equal(editedGroup.outfits.length, 3);
    assert.deepEqual(refsForSegment(edited).filter((ref) => ref.type === "image").map((ref) => ref.storageKey), ["image:shen-zhao-1"]);
});

test("角色只有声线没有服装时仍保留角色组和声线引用", () => {
    const initial = upsertCharacterGroup({ id: "clip-voice-only", taskMode: "ref2va", refItems: [] }, {
        characterName: "沈昭宁",
        characterNodeId: "character-shen-zhaoning",
        outfits: [],
        voice: { url: "https://media.test/voice.mp3", name: "沈昭宁声线", storageKey: "audio:voice" },
    });

    const group = groupFrom(initial);
    assert.equal(group.outfits.length, 0);
    assert.equal(group.outfitEnabled, false);
    assert.equal(group.voiceEnabled, true);
    assert.deepEqual(refsForSegment(initial).map((ref) => ref.type), ["audio"]);
});

test("关闭服装参考只移除图片引用并保留声线引用", () => {
    const initial = upsertCharacterGroup({ id: "clip-outfit-off", taskMode: "ref2va", refItems: [] }, {
        characterName: "沈昭宁",
        characterNodeId: "character-shen-zhaoning",
        outfits: sourceOutfits,
        voice: { url: "https://media.test/voice.mp3", name: "沈昭宁声线", storageKey: "audio:voice" },
    });
    const group = groupFrom(initial);
    const edited = applyCharacterGroupEdits(initial, group.id, { outfitEnabled: false });

    assert.ok(Object.keys(edited.h3CharacterGroups || {}).length);
    assert.equal(groupFrom(edited).voiceEnabled, true);
    assert.deepEqual(refsForSegment(edited).filter((ref) => ref.type === "image"), []);
    assert.deepEqual(refsForSegment(edited).filter((ref) => ref.type === "audio").map((ref) => ref.storageKey), ["audio:voice"]);
});

test("角色组派生 ref 保留真实源节点和角色四视图语义", () => {
    const group: H3CharacterGroup = {
        id: "group-1",
        characterName: "沈昭宁",
        characterNodeId: "character-shen-zhaoning",
        subjectId: "subject-shen-zhaoning",
        outfits: [{ id: "outfit-1", ...sourceOutfits[0], enabled: true }],
        voiceEnabled: false,
    };

    const [ref] = refsFromCharacterGroup(group);
    assert.equal(ref?.nodeId, "character-shen-zhaoning");
    assert.equal(ref?.role, "character_turnaround");
    assert.equal(ref?.subjectId, "subject-shen-zhaoning");
    assert.equal(ref?.groupId, "group-1");
    assert.equal(ref?.outfitId, "outfit-1");
    assert.equal(ref?.url, sourceOutfits[0].url);
});

test("源角色刷新不因临时切换到文生视频而清空已选参考", () => {
    const initial = upsertCharacterGroup({ id: "clip-mode", taskMode: "ref2va", refItems: [] }, {
        characterName: "沈昭宁",
        characterNodeId: "character-shen-zhaoning",
        outfits: sourceOutfits,
        selectedOutfitKeys: [sourceOutfits[0].storageKey!],
        voice: { url: "https://media.test/voice.mp3", name: "声线", storageKey: "audio:voice" },
    });
    const before = refsForSegment(initial).map((ref) => ref.storageKey);
    const group = groupFrom(initial);
    const textMode = { ...initial, mode: "t2v" as const, taskMode: "t2v" as const };
    const refreshed = syncCharacterGroupFromSource(textMode, group.id, {
        characterName: "沈昭宁",
        characterNodeId: "character-shen-zhaoning",
        outfits: sourceOutfits,
        voice: { url: "https://media.test/voice.mp3", name: "声线", storageKey: "audio:voice" },
    });

    assert.deepEqual(refsForSegment(refreshed).map((ref) => ref.storageKey), before);
    assert.equal(groupFrom(refreshed).outfitEnabled, true);
    assert.equal(groupFrom(refreshed).voiceEnabled, true);
    assert.deepEqual(refsForSegment({ ...refreshed, mode: "ref2va", taskMode: "ref2va" }).map((ref) => ref.storageKey), before);
});

test("源角色原位置换已选形象图后，H3 参考槽显示新图并保留服装绑定", () => {
    const initial = upsertCharacterGroup({ id: "clip-replace", taskMode: "ref2va", refItems: [] }, {
        characterName: "苏青璃", characterNodeId: "character-su", outfits: sourceOutfits,
        selectedOutfitKeys: [sourceOutfits[0].storageKey!],
    });
    const group = groupFrom(initial);
    const before = refsForSegment(initial).find((ref) => ref.type === "image")!;
    const replacement = { url: "https://media.test/new-appearance.png", storageKey: "image:new-appearance", name: "新形象" };
    const updated = syncCharacterGroupFromSource(initial, group.id, {
        characterName: "苏青璃", characterNodeId: "character-su", outfits: [replacement, ...sourceOutfits.slice(1)],
    });
    const after = refsForSegment(updated).find((ref) => ref.type === "image")!;
    assert.equal(after.storageKey, replacement.storageKey);
    assert.equal(after.url, replacement.url);
    assert.equal(after.outfitId, before.outfitId);
    assert.equal(after.bindingId, before.bindingId);
    assert.equal(groupFrom(updated).outfits.length, sourceOutfits.length);
    assert.equal(syncCharacterGroupFromSource(updated, group.id, { characterName: "苏青璃", characterNodeId: "character-su", outfits: [replacement, ...sourceOutfits.slice(1)] }), updated);
});
