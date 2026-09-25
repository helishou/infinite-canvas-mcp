import assert from "node:assert/strict";
import test from "node:test";

import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { findCanvasCompareReference } from "./image-compare-reference";

function node(id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata };
}

function connection(fromNodeId: string, toNodeId: string): CanvasConnection {
    return { id: `${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId };
}

test("图片对比优先使用结果图生成时保存的参考快照", () => {
    const target = node("target", CanvasNodeType.Config, { smart: true, generationMode: "image", content: "after" });
    const currentGraphImage = node("current", CanvasNodeType.Image, { content: "wrong-current.png", storageKey: "image:current" });
    const result = findCanvasCompareReference(
        target,
        [target, currentGraphImage],
        [connection(currentGraphImage.id, target.id)],
        [{ id: "ref-1", name: "原始参考图", type: "image/png", storageKey: "image:original", url: "original.png" }],
    );
    assert.deepEqual(result, { storageKey: "image:original", content: "original.png" });
});

test("图片对比忽略角色节点，只取上游图片节点", () => {
    const target = node("target", CanvasNodeType.Config, { smart: true, generationMode: "image", content: "after" });
    const character = node("character", CanvasNodeType.Character, { characterImages: [{ url: "character.png", name: "角色", outfit: "常服", outfitDescription: "", width: 1, height: 1, bytes: 1, mimeType: "image/png" }] });
    const upstreamImage = node("upstream", CanvasNodeType.Image, { content: "before", storageKey: "image:before" });
    const result = findCanvasCompareReference(target, [target, character, upstreamImage], [connection(character.id, target.id), connection(upstreamImage.id, target.id)]);
    assert.deepEqual(result, { storageKey: "image:before", content: "before" });
});

test("图片对比不会因角色节点挡住后续图片而选中角色", () => {
    const target = node("target", CanvasNodeType.Image, { content: "after" });
    const character = node("character", CanvasNodeType.Character, { characterImages: [{ url: "character.png", name: "角色", outfit: "常服", outfitDescription: "", width: 1, height: 1, bytes: 1, mimeType: "image/png" }] });
    const upstreamImage = node("upstream", CanvasNodeType.Image, { content: "before", storageKey: "image:before" });
    const result = findCanvasCompareReference(target, [target, character, upstreamImage], [connection(character.id, target.id), connection(upstreamImage.id, target.id)]);
    assert.equal(result?.storageKey, "image:before");
});
