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

test("循环输出逐槽对比对应输入组图片，不使用固定参考快照或其他槽图片", () => {
    const fixed = node("fixed", CanvasNodeType.Image, { content: "fixed.png", storageKey: "image:fixed" });
    const inputs = [1, 2, 3].map((index) => node(`input-${index}`, CanvasNodeType.Image, { content: `input-${index}.png`, storageKey: `image:input-${index}`, groupId: "input-group" }));
    const outputs = [1, 2, 3].map((index) => node(`output-${index}`, CanvasNodeType.Config, { smart: true, generationMode: "image", loopOutputSlot: true, loopSlotIndex: index - 1, content: `output-${index}.png` }));
    const links = [
        ...inputs.map((input, index) => ({ ...connection(input.id, outputs[index].id), role: "loop-input-reference" })),
        ...outputs.map((output) => connection(fixed.id, output.id)),
    ];
    const snapshot = [{ id: "fixed", name: "固定参考", type: "image/png", storageKey: "image:fixed" }];
    for (let index = 0; index < outputs.length; index += 1) {
        assert.deepEqual(findCanvasCompareReference(outputs[index], [...outputs, fixed, ...inputs], links, snapshot), {
            storageKey: `image:input-${index + 1}`,
            content: `input-${index + 1}.png`,
        });
    }
});

test("循环输入是智能图片节点时，对比使用其当前主图", () => {
    const input = node("input", CanvasNodeType.Config, { smart: true, generationMode: "image", images: [
        { id: "old", status: "success", content: "old.png", storageKey: "image:old", naturalWidth: 1, naturalHeight: 1, bytes: 1, mimeType: "image/png" },
        { id: "current", status: "success", content: "current.png", storageKey: "image:current", naturalWidth: 1, naturalHeight: 1, bytes: 1, mimeType: "image/png" },
    ], primaryImageId: "current" });
    const output = node("output", CanvasNodeType.Config, { loopOutputSlot: true, content: "after.png" });
    assert.deepEqual(findCanvasCompareReference(output, [input, output], [{ ...connection(input.id, output.id), role: "loop-input-reference" }], []), {
        storageKey: "image:current", content: "current.png",
    });
});

test("循环槽同时接收文本和图片时跳过文本输入", () => {
    const prompt = node("prompt", CanvasNodeType.Text, { content: "本轮提示词" });
    const input = node("input", CanvasNodeType.Image, { content: "before.png", storageKey: "image:before" });
    const output = node("output", CanvasNodeType.Config, { loopOutputSlot: true, content: "after.png" });
    const links = [prompt, input].map((source) => ({ ...connection(source.id, output.id), role: "loop-input-reference" }));
    assert.deepEqual(findCanvasCompareReference(output, [prompt, input, output], links), { storageKey: "image:before", content: "before.png" });
});

test("循环输入连线存在但素材已空时，不退回无关的固定参考图", () => {
    const input = node("input", CanvasNodeType.Image);
    const output = node("output", CanvasNodeType.Config, { loopOutputSlot: true, content: "after.png" });
    assert.equal(findCanvasCompareReference(output, [input, output], [{ ...connection(input.id, output.id), role: "loop-input-reference" }], [
        { id: "fixed", name: "固定参考", type: "image/png", storageKey: "image:fixed" },
    ]), null);
});

test("旧循环结果槽失去对应输入连线后不展示错误对比图", () => {
    const output = node("output", CanvasNodeType.Config, { loopOutputSlot: true, content: "after.png" });
    assert.equal(findCanvasCompareReference(output, [output], [], [
        { id: "fixed", name: "固定参考", type: "image/png", storageKey: "image:fixed" },
    ]), null);
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
