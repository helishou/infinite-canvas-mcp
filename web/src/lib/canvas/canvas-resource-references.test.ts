import assert from "node:assert/strict";
import test from "node:test";
import { buildCanvasGraphIndex, createMentionReferenceSelector, nodeResourceItems } from "./canvas-resource-references";
import { buildNodeGenerationInputs } from "@/components/canvas/canvas-node-generation";
import { sourceNodeReferenceImages } from "@/lib/canvas/canvas-generation-helpers";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("无关节点更新和裁剪变化保留引用数组，关联资源变化才失效", () => {
    const a: CanvasNodeData = { id: "a", type: CanvasNodeType.Text, title: "A", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "a" } };
    const b = { ...a, id: "b", title: "B" };
    const select = createMentionReferenceSelector();
    let nodes = [a, b];
    const first = select(nodes, nodes, [], buildCanvasGraphIndex(nodes, []));
    nodes = [a, { ...b, metadata: { content: "edited" } }];
    const second = select(nodes, nodes, [], buildCanvasGraphIndex(nodes, []));
    assert.equal(first.get("a"), second.get("a"));
    assert.notEqual(first.get("b"), second.get("b"));
    assert.equal(select([a], nodes, [], buildCanvasGraphIndex(nodes, [])).get("a"), first.get("a"));
});

test("智能生成节点只把主图作为下游参考输入", () => {
    const source: CanvasNodeData = {
        id: "source",
        type: CanvasNodeType.Config,
        title: "源智能节点",
        position: { x: 0, y: 0 },
        width: 340,
        height: 240,
        metadata: {
            smart: true,
            generationMode: "image",
            content: "second.png",
            primaryImageId: "image-2",
            images: [
                { id: "image-1", status: "success", content: "first.png", storageKey: "media/first.png", naturalWidth: 100, naturalHeight: 100, bytes: 1, mimeType: "image/png" },
                { id: "image-2", status: "success", content: "second.png", storageKey: "media/second.png", naturalWidth: 100, naturalHeight: 100, bytes: 1, mimeType: "image/png" },
                { id: "image-3", status: "success", content: "third.png", storageKey: "media/third.png", naturalWidth: 100, naturalHeight: 100, bytes: 1, mimeType: "image/png" },
            ],
        },
    };
    const target: CanvasNodeData = { ...source, id: "target", title: "目标智能节点", metadata: { smart: true, generationMode: "image" } };
    const resources = nodeResourceItems(source);
    assert.deepEqual(resources.map((resource) => resource.storageKey), ["media/second.png"]);

    const inputs = buildNodeGenerationInputs("target", [source, target], [{ id: "connection", fromNodeId: "source", toNodeId: "target" }], buildCanvasGraphIndex([source, target], [{ id: "connection", fromNodeId: "source", toNodeId: "target" }]));
    assert.deepEqual(inputs.map((input) => input.type), ["image"]);
    assert.deepEqual(inputs.map((input) => input.type === "image" && input.image ? input.image.storageKey : undefined), ["media/second.png"]);
    assert.deepEqual(sourceNodeReferenceImages(source).map((image) => image.storageKey), ["media/second.png"]);
});

test("角色参考默认只用主图，存量服装选择保持原样", () => {
    const character: CanvasNodeData = {
        id: "character",
        type: CanvasNodeType.Character,
        title: "沈昭宁",
        position: { x: 0, y: 0 },
        width: 340,
        height: 480,
        metadata: {
            characterImages: [
                { url: "outfit-a.png", storageKey: "media/outfit-a.png", name: "outfit-a", outfit: "常服", outfitDescription: "", width: 100, height: 100, bytes: 1, mimeType: "image/png" },
                { url: "outfit-b.png", storageKey: "media/outfit-b.png", name: "outfit-b", outfit: "退婚雪服", outfitDescription: "", width: 100, height: 100, bytes: 1, mimeType: "image/png" },
            ],
            characterPrimaryIndex: 1,
        },
    };
    const baseTarget: CanvasNodeData = { id: "target", type: CanvasNodeType.Config, title: "目标", position: { x: 500, y: 0 }, width: 420, height: 540, metadata: { smart: true, generationMode: "image" } };
    const connection = { id: "character-target", fromNodeId: character.id, toNodeId: baseTarget.id, role: "reference" as const };
    const resolve = (metadata: CanvasNodeData["metadata"]) => {
        const target = { ...baseTarget, metadata };
        const nodes = [character, target];
        const connections = [connection];
        return buildNodeGenerationInputs(target.id, nodes, connections, buildCanvasGraphIndex(nodes, connections))
            .filter((input) => input.type === "image")
            .map((input) => input.type === "image" ? input.image?.storageKey : undefined);
    };

    assert.deepEqual(resolve(baseTarget.metadata), ["media/outfit-b.png"]);
    assert.deepEqual(resolve({ ...baseTarget.metadata, characterReferences: { character: { imageKeys: ["media/outfit-a.png"] } } }), ["media/outfit-a.png"]);
    assert.deepEqual(resolve({ ...baseTarget.metadata, characterReferences: { character: { imageKeys: [] } } }), []);
});

test("循环节点按轮次选择上游图片并渲染循环变量", () => {
    const imageA: CanvasNodeData = { id: "image-a", type: CanvasNodeType.Image, title: "A", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "a.png", storageKey: "media/a.png" } };
    const imageB: CanvasNodeData = { id: "image-b", type: CanvasNodeType.Image, title: "B", position: { x: 0, y: 120 }, width: 100, height: 100, metadata: { content: "b.png", storageKey: "media/b.png" } };
    const loop: CanvasNodeData = {
        id: "loop",
        type: CanvasNodeType.Loop,
        title: "循环",
        position: { x: 160, y: 0 },
        width: 380,
        height: 320,
        metadata: { loopCount: 3, loopImageEnabled: true, loopPromptEnabled: true, loopPrompt: "第《计数》轮 / 共《总数》轮" },
    };
    const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Config, title: "目标", position: { x: 600, y: 0 }, width: 420, height: 540, metadata: { smart: true, generationMode: "image" } };
    const nodes = [imageA, imageB, loop, target];
    const connections = [
        { id: "a-loop", fromNodeId: imageA.id, toNodeId: loop.id },
        { id: "b-loop", fromNodeId: imageB.id, toNodeId: loop.id },
        { id: "loop-target", fromNodeId: loop.id, toNodeId: target.id },
    ];
    const index = buildCanvasGraphIndex(nodes, connections);
    const first = buildNodeGenerationInputs(target.id, nodes, connections, index, { index: 0, total: 3 });
    const second = buildNodeGenerationInputs(target.id, nodes, connections, index, { index: 1, total: 3 });
    assert.deepEqual(first.map((input) => input.type), ["text", "image"]);
    assert.equal(first[0].type === "text" ? first[0].text : "", "第1轮 / 共3轮");
    assert.equal(first[1].type === "image" ? first[1].image?.storageKey : "", "media/a.png");
    assert.equal(second[1].type === "image" ? second[1].image?.storageKey : "", "media/b.png");
});
