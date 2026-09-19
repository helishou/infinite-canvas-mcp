import assert from "node:assert/strict";
import test from "node:test";

import { resolveCanvasImageReferences } from "./image-references.js";

const image = (id: string, title: string) => ({ id, type: "image", title, metadata: { storageKey: `image:${id}`, mimeType: "image/png" } });

test("图片生成从结果节点沿配置节点回溯全部参考图并保留顺序", () => {
    const project = {
        id: "project-1",
        nodes: [
            { id: "config", type: "config" },
            { id: "result", type: "image", metadata: { storageKey: "image:result" } },
            image("scene", "场景"), image("shen", "沈昭"), image("su", "苏晚"), image("blocking", "站位图"),
        ],
        connections: [
            { id: "config-result", fromNodeId: "config", toNodeId: "result" },
            { id: "scene-config", fromNodeId: "scene", toNodeId: "config", role: "reference", order: 0 },
            { id: "shen-config", fromNodeId: "shen", toNodeId: "config", role: "reference", order: 1 },
            { id: "su-config", fromNodeId: "su", toNodeId: "config", role: "reference", order: 2 },
            { id: "blocking-config", fromNodeId: "blocking", toNodeId: "config", role: "reference", order: 3 },
        ],
    };

    assert.deepEqual(resolveCanvasImageReferences(project, "result")?.map((reference) => reference.id), ["result", "scene", "shen", "su", "blocking"]);
});

test("配置节点没有媒体入边时解析为空数组而不是丢失生成命令", () => {
    const project = { id: "project-1", nodes: [{ id: "config", type: "config" }], connections: [] };
    assert.deepEqual(resolveCanvasImageReferences(project, "config"), []);
});

test("角色参考入边按生成节点保存的服装选择解析为图片输入", () => {
    const project = {
        id: "project-1",
        nodes: [
            { id: "config", type: "config", metadata: { characterReferences: { char: { imageKeys: ["image:outfit-b"] } } } },
            { id: "char", type: "character", title: "沈昭宁", metadata: { characterImages: [
                { url: "outfit-a", storageKey: "image:outfit-a", name: "outfit-a", mimeType: "image/png" },
                { url: "outfit-b", storageKey: "image:outfit-b", name: "outfit-b", mimeType: "image/png" },
            ] } },
        ],
        connections: [{ id: "char-config", fromNodeId: "char", toNodeId: "config", role: "reference", order: 0 }],
    };

    assert.deepEqual(resolveCanvasImageReferences(project, "config")?.map((reference) => reference.storageKey), ["image:outfit-b"]);
});

test("场景参考只提交栅格场景图，不把 SVG 色卡作为图片模型输入", () => {
    const project = {
        id: "project-1",
        nodes: [
            { id: "config", type: "config" },
            { id: "scene", type: "scene", title: "场景", metadata: {
                sceneImage: { storageKey: "image:scene", name: "scene.png", mimeType: "image/png" },
                sceneColorCard: { storageKey: "image:color-card", name: "scene.svg", mimeType: "image/svg+xml" },
            } },
        ],
        connections: [{ id: "scene-config", fromNodeId: "scene", toNodeId: "config", role: "reference", order: 0 }],
    };

    assert.deepEqual(resolveCanvasImageReferences(project, "config")?.map((reference) => reference.storageKey), ["image:scene"]);
});

test("智能生成节点作为参考入边时只解析主图", () => {
    const project = {
        id: "project-1",
        nodes: [
            { id: "target", type: "config", metadata: { smart: true, generationMode: "image" } },
            { id: "source", type: "config", title: "源智能节点", metadata: { smart: true, generationMode: "image", primaryImageId: "image-2", images: [
                { id: "image-1", content: "first.png", storageKey: "image:first", mimeType: "image/png" },
                { id: "image-2", content: "second.png", storageKey: "image:second", mimeType: "image/png" },
                { id: "image-3", content: "third.png", storageKey: "image:third", mimeType: "image/png" },
            ] } },
        ],
        connections: [{ id: "source-target", fromNodeId: "source", toNodeId: "target", role: "reference" }],
    };

    assert.deepEqual(resolveCanvasImageReferences(project, "target")?.map((reference) => reference.storageKey), ["image:second"]);
});
