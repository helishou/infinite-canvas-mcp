import test from "node:test";
import assert from "node:assert/strict";

import {
    applyCharacterGroupEdits,
    refsForSegment,
    refsFromCharacterGroup,
    upsertCharacterGroup,
} from "./h3-data";
import type { H3CharacterGroup, H3Segment } from "../types";

const sourceOutfits = [
    { url: "https://media.test/shen-zhao-1.png", name: "三年前·退婚", storageKey: "image:shen-zhao-1" },
    { url: "https://media.test/shen-zhao-2.png", name: "婚后·常服", storageKey: "image:shen-zhao-2" },
    { url: "https://media.test/shen-zhao-3.png", name: "夜行·斗篷", storageKey: "image:shen-zhao-3" },
];

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
