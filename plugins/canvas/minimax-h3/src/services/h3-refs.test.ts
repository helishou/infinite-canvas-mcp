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

test("角色节点不产生无 groupId 的普通图片候选", () => {
    const candidates = h3RefCandidates([
        { id: "character-1", type: "character", title: "沈昭宁", metadata: { characterImages: [{ url: "https://media.test/a.png" }] } } as never,
    ], "h3-1");
    assert.equal(candidates.length, 0);
});
