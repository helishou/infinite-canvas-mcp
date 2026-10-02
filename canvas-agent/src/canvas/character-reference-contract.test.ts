import test from "node:test";
import assert from "node:assert/strict";

import { validateH3CharacterGroups } from "./character-reference-contract.js";

const sourceImages = [
    { url: "https://media.test/shen-zhao-1.png", storageKey: "image:shen-zhao-1", outfit: "三年前·退婚" },
    { url: "https://media.test/shen-zhao-2.png", storageKey: "image:shen-zhao-2", outfit: "婚后·常服" },
    { url: "https://media.test/shen-zhao-3.png", storageKey: "image:shen-zhao-3", outfit: "夜行·斗篷" },
];

function project(node: Record<string, unknown> = { id: "character-1", type: "character", metadata: { characterAssetId: "asset-1", characterImages: sourceImages } }) {
    return { nodes: [node] };
}

function completeSegment(bindingPatch: Record<string, unknown> = {}) {
    return {
        taskMode: "ref2va",
        h3CharacterGroups: {
            "group-1": {
                id: "group-1",
                characterName: "沈昭宁",
                characterAssetId: "asset-1",
                characterNodeId: "character-1",
                subjectId: "subject-1",
                outfitEnabled: true,
                outfits: sourceImages.map((image, index) => ({
                    id: `outfit-${index + 1}`,
                    url: image.url,
                    storageKey: image.storageKey,
                    name: image.outfit,
                    enabled: index === 0,
                })),
                voiceEnabled: false,
            },
        },
        referenceBindings: [{
            id: "binding-1",
            assetId: "image:shen-zhao-1",
            label: "沈昭宁 · 三年前·退婚",
            role: "character_turnaround",
            tags: [],
            enabled: true,
            usage: "reference",
            mediaType: "image",
            sourceNodeId: "character-1",
            subjectId: "subject-1",
            groupId: "group-1",
            outfitId: "outfit-1",
            url: sourceImages[0].url,
            storageKey: sourceImages[0].storageKey,
            ...bindingPatch,
        }],
    };
}

test("角色组 sourceNodeId 不存在时预检报错", () => {
    const issues = validateH3CharacterGroups(project(), {
        ...completeSegment(),
        h3CharacterGroups: { "group-1": { ...completeSegment().h3CharacterGroups["group-1"], characterNodeId: "missing" } },
    });
    assert.ok(issues.some((issue) => issue.code === "character_group_source_missing"));
});

test("缺少 characterAssetId 时预检报错", () => {
    const segment = completeSegment();
    delete segment.h3CharacterGroups["group-1"].characterAssetId;
    const issues = validateH3CharacterGroups(project(), segment);
    assert.ok(issues.some((issue) => issue.code === "character_group_asset_missing"));
});

test("源角色有三套服装但角色组只有一套时预检报错", () => {
    const segment = completeSegment();
    const group = segment.h3CharacterGroups["group-1"];
    group.outfits = [group.outfits[0]];
    const issues = validateH3CharacterGroups(project(), segment);
    assert.ok(issues.some((issue) => issue.code === "character_group_outfit_missing" && issue.outfitKey === "image:shen-zhao-2"));
});

test("角色组 sourceNodeId 指向 image 节点时预检报错", () => {
    const issues = validateH3CharacterGroups(project({ id: "character-1", type: "image", metadata: { characterImages: sourceImages } }), completeSegment());
    assert.ok(issues.some((issue) => issue.code === "character_group_source_not_character"));
});

// referenceBindings 里的角色组行是 h3CharacterGroups 的派生视图，由编译器现场生成。
// 这里故意把它们全部清空：缺行属于快照漂移，不是真数据错误，预检不应因此失败。
test("角色组派生 binding 缺失或漂移时预检仍以角色组本体为准", () => {
    for (const patch of [{}, { url: undefined }, { sourceNodeId: "wrong-node" }, { subjectId: "wrong-subject" }]) {
        const segment = completeSegment();
        segment.referenceBindings = [{ ...completeSegment().referenceBindings[0], ...patch }];
        const issues = validateH3CharacterGroups(project(), segment);
        assert.equal(issues.filter((issue) => issue.severity === "error").length, 0, `patch=${JSON.stringify(patch)}`);
    }
    const empty = completeSegment();
    empty.referenceBindings = [];
    assert.equal(validateH3CharacterGroups(project(), empty).filter((issue) => issue.severity === "error").length, 0);
});

test("服装总开关关闭时不要求旧目录中单件仍启用的图片 binding", () => {
    const segment = completeSegment();
    segment.h3CharacterGroups["group-1"].outfitEnabled = false;
    segment.referenceBindings = [];
    const issues = validateH3CharacterGroups(project(), segment);
    assert.equal(issues.some((issue) => issue.code === "character_group_outfit_role_mismatch"), false);
});
