import test from "node:test";
import assert from "node:assert/strict";

import { buildCharacterGroupFromExistingNode } from "./character-groups.js";

const node = {
    id: "character-1",
    type: "character",
    title: "沈昭宁",
    metadata: {
        characterName: "沈昭宁",
        characterAssetId: "asset-1",
        characterImages: [
            { url: "https://media.test/shen-zhao-1.png", storageKey: "image:shen-zhao-1", outfit: "三年前·退婚" },
            { url: "https://media.test/shen-zhao-2.png", storageKey: "image:shen-zhao-2", outfit: "婚后·常服" },
            { url: "https://media.test/shen-zhao-3.png", storageKey: "image:shen-zhao-3", outfit: "夜行·斗篷" },
        ],
        characterVoiceUrl: "https://media.test/shen-zhao.wav",
        characterVoiceName: "心声1",
    },
};

test("从现有角色节点读取完整目录，只按 selected key 启用一套", () => {
    const result = buildCharacterGroupFromExistingNode(node, {
        selectedOutfitStorageKeys: ["image:shen-zhao-1"],
        voiceEnabled: false,
    });

    assert.equal(result.group.characterNodeId, "character-1");
    assert.equal(result.group.characterAssetId, "asset-1");
    assert.equal(result.group.outfits.length, 3);
    assert.deepEqual(result.group.outfits.filter((outfit) => outfit.enabled).map((outfit) => outfit.storageKey), ["image:shen-zhao-1"]);
    assert.equal(result.refs.length, 1);
    assert.equal(result.refs[0].sourceNodeId, "character-1");
    assert.equal(result.refs[0].role, "character_turnaround");
    assert.equal(result.refs[0].groupId, result.group.id);
    assert.equal(result.refs[0].outfitId, result.group.outfits[0].id);
    assert.equal(result.ops.some((op) => op.type === "add_node"), false);

    const updated = buildCharacterGroupFromExistingNode(node, { selectedOutfitStorageKeys: ["image:shen-zhao-2"], existingGroup: result.group });
    assert.equal(updated.group.id, result.group.id);
    assert.deepEqual(updated.group.outfits.map((outfit) => outfit.id), result.group.outfits.map((outfit) => outfit.id));
    assert.deepEqual(updated.group.outfits.filter((outfit) => outfit.enabled).map((outfit) => outfit.storageKey), ["image:shen-zhao-2"]);
});

test("未知角色节点、非 character 节点和未知服装选择都拒绝", () => {
    assert.throws(() => buildCharacterGroupFromExistingNode({}, { selectedOutfitStorageKeys: ["image:shen-zhao-1"] }), /character 节点/);
    assert.throws(() => buildCharacterGroupFromExistingNode({ ...node, type: "image" }, { selectedOutfitStorageKeys: ["image:shen-zhao-1"] }), /character 节点/);
    assert.throws(() => buildCharacterGroupFromExistingNode(node, { selectedOutfitStorageKeys: ["image:not-from-source"] }), /不属于源角色节点/);
    assert.throws(() => buildCharacterGroupFromExistingNode(node, { selectedOutfitStorageKeys: [] }), /至少选择一套/);
});
