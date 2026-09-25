import test from "node:test";
import assert from "node:assert/strict";

import { CharacterGroupParseError, h3RefCandidates, readCharacterGroupFromDrop } from "./h3-refs.ts";

function transfer(payload: Record<string, unknown>) {
    const encoded = JSON.stringify(payload);
    return { dataTransfer: { getData: (kind: string) => kind === "application/x-infinite-canvas-ref" || kind === "text/plain" ? encoded : "" } };
}

test("缺少 characterNodeId 的角色 payload 结构化拒绝，不降级成普通图片", () => {
    assert.throws(() => readCharacterGroupFromDrop(transfer({ type: "character", characterImages: [{ url: "https://media.test/a.png" }] })), (error: unknown) => error instanceof CharacterGroupParseError && error.code === "character_group_source_missing");
});

test("角色 payload 保留完整服装目录和已有节点 ID", () => {
    const group = readCharacterGroupFromDrop(transfer({
        type: "character",
        characterName: "沈昭宁",
        characterNodeId: "character-1",
        characterImages: [
            { url: "https://media.test/a.png", outfit: "三年前", storageKey: "image:a" },
            { url: "https://media.test/b.png", outfit: "婚后", storageKey: "image:b" },
            { url: "https://media.test/c.png", outfit: "夜行", storageKey: "image:c" },
        ],
    }));
    assert.equal(group?.characterNodeId, "character-1");
    assert.equal(group?.outfits.length, 3);
});

test("只有声线的角色 payload 仍能建立角色组", () => {
    const group = readCharacterGroupFromDrop(transfer({
        type: "character",
        characterName: "沈昭宁",
        characterNodeId: "character-voice-only",
        characterImages: [],
        characterVoiceUrl: "https://media.test/voice.mp3",
        characterVoiceName: "沈昭宁声线",
    }));
    assert.equal(group?.outfits.length, 0);
    assert.equal(group?.voice?.name, "沈昭宁声线");
});

test("角色节点不产生无 groupId 的普通图片候选", () => {
    const candidates = h3RefCandidates([
        { id: "character-1", type: "character", title: "沈昭宁", metadata: { characterImages: [{ url: "https://media.test/a.png" }] } } as never,
    ], "h3-1");
    assert.equal(candidates.length, 0);
});

test("分镜候选自动带出生成快照中的参考角色", () => {
    const storyboard = {
        id: "storyboard-1",
        type: "config",
        title: "候选分镜",
        metadata: {
            smart: true,
            generationMode: "image",
            primaryImageId: "image-1",
            images: [{
                id: "image-1",
                content: "https://media.test/storyboard.png",
                generationSnapshot: {
                    references: [
                        { id: "character-1-image-0", name: "沈昭宁", type: "image/png" },
                        { id: "scene-1", name: "雪院", type: "image/png" },
                    ],
                },
            }],
        },
    } as never;
    const candidates = h3RefCandidates([
        storyboard,
    ], "h3-1", [
        storyboard,
        { id: "character-1", type: "character", title: "沈昭宁", metadata: {} },
        { id: "character-2", type: "character", title: "谢临渊", metadata: {} },
    ] as never);
    assert.deepEqual(candidates[0]?.ref.storyboardSubjectIds, ["character-1"]);
});

test("旧图片节点没有快照时沿生成输入连线回溯角色", () => {
    const image = { id: "image-1", type: "image", title: "候选分镜", metadata: { content: "https://media.test/storyboard.png" } } as never;
    const candidates = h3RefCandidates([image], "h3-1", [
        image,
        { id: "character-1", type: "character", title: "沈昭宁", metadata: {} },
        { id: "config-1", type: "config", title: "生图", metadata: {} },
    ] as never, [
        { id: "connection-1", fromNodeId: "character-1", toNodeId: "config-1" },
        { id: "connection-2", fromNodeId: "config-1", toNodeId: "image-1" },
    ] as never);
    assert.deepEqual(candidates[0]?.ref.storyboardSubjectIds, ["character-1"]);
});
