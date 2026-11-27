import { test } from "node:test";
import assert from "node:assert/strict";

import { assetHasReference } from "./pipeline.js";

test("assetHasReference：制作稿 storageKey 已写回 → 视为已就绪（幂等成功，不重出）", () => {
    assert.equal(assetHasReference({ draftStorageKey: "assets/linxia.png" }), true);
    // 只有空白字符不算
    assert.equal(assetHasReference({ draftStorageKey: "   " }), false);
});

test("assetHasReference：draft 被清空但画布角色节点有主图 → 仍视为已就绪（compile 重建后不重出的关键）", () => {
    const node = {
        id: "entity-character-x",
        type: "character",
        metadata: {
            characterImages: [
                { storageKey: "assets/a.png" },
                { storageKey: "assets/b.png" },
            ],
            characterPrimaryIndex: 1,
        },
    };
    assert.equal(assetHasReference({ draftStorageKey: "", node }), true);
    // 主图序号越界时回退第一张
    const fallback = { ...node, metadata: { ...node.metadata, characterPrimaryIndex: 9 } };
    assert.equal(assetHasReference({ node: fallback }), true);
});

test("assetHasReference：只有 url/content 也算已有图；场景与道具分别读 sceneImage / propImage", () => {
    const scene = { type: "scene", metadata: { sceneImage: { content: "/media/scene.png" } } };
    const prop = { type: "prop", metadata: { propImage: { storageKey: "assets/prop.png" } } };
    assert.equal(assetHasReference({ node: scene }), true);
    assert.equal(assetHasReference({ node: prop }), true);
});

test("assetHasReference：两处都空 → 需要生成；节点缺 metadata 不抛错", () => {
    assert.equal(assetHasReference({ draftStorageKey: "", node: { id: "entity-1", type: "character", metadata: {} } }), false);
    assert.equal(assetHasReference({ draftStorageKey: "", node: { id: "entity-2", type: "scene" } }), false);
    assert.equal(assetHasReference({ draftStorageKey: "", node: null }), false);
    assert.equal(assetHasReference({}), false);
});
