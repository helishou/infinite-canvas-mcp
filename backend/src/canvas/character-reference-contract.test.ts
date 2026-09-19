import assert from "node:assert/strict";
import test from "node:test";

import { compileReferenceSubmission, assertReferenceCompilation } from "@basketikun/canvas-agent/reference-contract";

const characterProject = {
    nodes: [{
        id: "character-1",
        type: "character",
        metadata: {
            characterAssetId: "asset-1",
            characterImages: [
                { storageKey: "image:a", url: "https://media.test/a.png", outfit: "三年前" },
                { storageKey: "image:b", url: "https://media.test/b.png", outfit: "婚后" },
                { storageKey: "image:c", url: "https://media.test/c.png", outfit: "夜行" },
            ],
        },
    }],
};

test("Backend 预检阻断只有 storageKey 的角色预览引用", () => {
    const result = compileReferenceSubmission(characterProject, {
        id: "clip-1",
        taskMode: "ref2va",
        h3CharacterGroups: {
            "group-1": {
                id: "group-1",
                characterName: "沈昭宁",
                characterAssetId: "asset-1",
                characterNodeId: "character-1",
                subjectId: "character-1",
                outfits: [
                    { id: "outfit-a", name: "三年前", storageKey: "image:a", url: "https://media.test/a.png", enabled: true },
                    { id: "outfit-b", name: "婚后", storageKey: "image:b", url: "https://media.test/b.png", enabled: false },
                    { id: "outfit-c", name: "夜行", storageKey: "image:c", url: "https://media.test/c.png", enabled: false },
                ],
            },
        },
        referenceBindings: [{ id: "binding-1", assetId: "asset-a", label: "沈昭宁 · 三年前", role: "character_turnaround", subjectId: "character-1", mediaType: "image", storageKey: "image:a", sourceNodeId: "character-1", groupId: "group-1", outfitId: "outfit-a", enabled: true, usage: "reference" }],
    });
    assert.ok(result.issues.some((issue) => issue.code === "character_group_preview_url_missing"));
    assert.throws(() => assertReferenceCompilation(result), /缺少预览 URL/);
});
