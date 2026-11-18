import assert from "node:assert/strict";
import { test } from "node:test";
import { findPipelineAssetEntityNode, generatedMediaStorageKey } from "./pipeline-asset-image.js";

test("generatedMediaStorageKey 取结果里第一张真实媒体，并兼容顶层 storageKey", () => {
    assert.equal(generatedMediaStorageKey({ result: { media: [{ storageKey: "image:a" }, { storageKey: "image:b" }] } }), "image:a");
    assert.equal(generatedMediaStorageKey({ result: { media: [{ url: "/media/x" }, { storageKey: " image:b " }] } }), "image:b");
    assert.equal(generatedMediaStorageKey({ result: { storageKey: "image:top" } }), "image:top");
    assert.equal(generatedMediaStorageKey({ result: { media: [] } }), "");
    assert.equal(generatedMediaStorageKey(null), "");
});

test("findPipelineAssetEntityNode 优先按实体绑定/名称定位，不猜多个候选", () => {
    const nodes = [
        { id: "production-entity-ep-1-character-A", type: "character", title: "甲", metadata: { productionEntity: { entityId: "entity-A" }, characterName: "甲" } },
        { id: "production-entity-ep-1-character-B", type: "character", title: "乙", metadata: { productionEntity: { entityId: "entity-B" }, characterName: "乙" } },
        { id: "production-entity-ep-1-scene-S", type: "scene", title: "雪夜", metadata: { sceneName: "雪夜" } },
        { id: "production-entity-ep-1-prop-P", type: "prop", title: "玉佩", metadata: { propName: "玉佩" } },
    ];
    assert.equal(findPipelineAssetEntityNode(nodes, { kind: "character", name: "乙", entityId: "entity-B" })?.id,
        "production-entity-ep-1-character-B");
    assert.equal(findPipelineAssetEntityNode(nodes, { kind: "scene", name: "雪夜" })?.id,
        "production-entity-ep-1-scene-S");
    assert.equal(findPipelineAssetEntityNode(nodes, { kind: "prop", name: "玉佩" })?.id,
        "production-entity-ep-1-prop-P");
    // 两个同类候选、无绑定也无名称命中时不猜。
    assert.equal(findPipelineAssetEntityNode(nodes, { kind: "character", name: "" }), null);
    assert.equal(findPipelineAssetEntityNode(nodes, { kind: "character", name: "不存在的角色", entityId: "missing" }), null);
});

test("findPipelineAssetEntityNode 在没有 production-entity 前缀时按唯一同类型节点兜底", () => {
    const nodes = [{ id: "legacy-node", type: "scene", title: "旧场景", metadata: {} }];
    assert.equal(findPipelineAssetEntityNode(nodes, { kind: "scene", name: "" })?.id, "legacy-node");
});
