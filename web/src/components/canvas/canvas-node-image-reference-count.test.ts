import assert from "node:assert/strict";
import test from "node:test";
import { buildNodeMentionReferences, getGenerationResourceNodes, getMentionCandidateResourceNodes, getMentionResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { getNodeImageReferenceCount } from "./canvas-node-image-reference-count";

const makeNode = (id: string, type: CanvasNodeData["type"], metadata: CanvasNodeData["metadata"]): CanvasNodeData => ({
    id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata,
});
const smart = (id: string, extra: CanvasNodeData["metadata"] = {}) => makeNode(id, CanvasNodeType.Config, { smart: true, generationMode: "image", ...extra });
const picture = (id: string) => makeNode(id, CanvasNodeType.Image, { content: `${id}.png`, storageKey: `image:${id}` });

test("智能节点无参考，生成前后均为文生；自身图片仍可出现在 @ 候选", () => {
    const empty = smart("target");
    assert.equal(getNodeImageReferenceCount(empty, [empty], [], "人物"), 0);
    const generated = smart("target", { content: "result.png", storageKey: "image:result" });
    assert.equal(buildNodeMentionReferences(generated, [generated], []).filter((ref) => ref.kind === "image").length, 1);
    assert.equal(getNodeImageReferenceCount(generated, [generated], [], "人物"), 0);
});

test("上游智能节点只贡献主图，目标自身历史输出不算参考", () => {
    const source = smart("source", { content: "source.png", storageKey: "image:source" });
    const target = smart("target", { content: "result.png", storageKey: "image:result" });
    assert.equal(getNodeImageReferenceCount(target, [source, target], [source], "人物"), 1);
    const second = picture("second");
    assert.equal(getNodeImageReferenceCount(target, [source, second, target], [source, second], "人物"), 2);
});

test("图片组按实际展开的图片数计数", () => {
    const group = makeNode("group", CanvasNodeType.Group, {});
    const a = picture("a"); a.metadata!.groupId = group.id;
    const b = picture("b"); b.metadata!.groupId = group.id;
    const target = smart("target");
    assert.equal(getNodeImageReferenceCount(target, [group, a, b, target], [group], "人物"), 2);
});

test("角色选择的两套服装按实际图片数计数，不压成一个节点", () => {
    const character = makeNode("character", CanvasNodeType.Character, { characterImages: [
        { url: "a.png", storageKey: "image:a", name: "a", outfit: "a", outfitDescription: "", width: 100, height: 100, bytes: 1, mimeType: "image/png" },
        { url: "b.png", storageKey: "image:b", name: "b", outfit: "b", outfitDescription: "", width: 100, height: 100, bytes: 1, mimeType: "image/png" },
    ] });
    const target = smart("target", { characterReferences: { character: { imageKeys: ["image:a", "image:b"], voiceEnabled: false } } });
    assert.equal(getNodeImageReferenceCount(target, [character, target], [character], "人物"), 2);
});

test("带 @ 的提示词按生成器实际选择计数，不把所有候选都算进去", () => {
    const a = picture("a"), b = picture("b");
    const target = smart("target", { composerContent: "@[node:a]" });
    assert.equal(getNodeImageReferenceCount(target, [a, b, target], [a, b], "@[node:a]"), 1);
});

test("显式恢复历史的零参考与多参考覆盖当前连接；循环使用实时输入", () => {
    const a = picture("a"), target = smart("target");
    assert.equal(getNodeImageReferenceCount(target, [a, target], [a], "人物", 0, 0), 0);
    assert.equal(getNodeImageReferenceCount(target, [a, target], [a], "人物", 0, 2), 2);
    assert.equal(getNodeImageReferenceCount(target, [a, target], [a], "人物", 2), 3);
});

test("普通图片节点编辑仍把自身图片作为参考", () => {
    const target = picture("target");
    assert.equal(getNodeImageReferenceCount(target, [target], [], "改图"), 1);
});

test("候选并集纳入配置与直连参考，不改变生成解析语义", () => {
    const configRef = smart("config-ref", { generationMode: "text", content: "人物设定" });
    const directImage = picture("direct-image");
    const generator = picture("generator");
    const config = smart("downstream");
    const nodes = [configRef, directImage, generator, config];
    const connections = [
        { id: "configref-config", fromNodeId: configRef.id, toNodeId: config.id },
        { id: "direct-generator", fromNodeId: directImage.id, toNodeId: generator.id },
        { id: "generator-config", fromNodeId: generator.id, toNodeId: config.id },
    ];
    // 原候选与生成解析：configInputs 非空即早返回，直连图不在这两条口径里。
    assert.deepEqual(getMentionResourceNodes(generator.id, nodes, connections).map((node) => node.id), [configRef.id]);
    assert.deepEqual(getGenerationResourceNodes(generator.id, nodes, connections).map((node) => node.id), [configRef.id]);
    // 候选并集：配置参考 + 直连图都在，且去重。
    const candidates = getMentionCandidateResourceNodes(generator.id, nodes, connections).map((node) => node.id);
    assert.deepEqual(candidates, [configRef.id, directImage.id]);
    assert.equal(new Set(candidates).size, candidates.length);
});
