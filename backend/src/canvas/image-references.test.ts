import assert from "node:assert/strict";
import test from "node:test";

import { resolveCanvasCharacterImageReferences, resolveCanvasImageReferences } from "./image-references.js";

const image = (id: string, title: string) => ({ id, type: "image", title, metadata: { storageKey: `image:${id}`, mimeType: "image/png" } });

test("失效的角色选图恢复当前主图，Backend 不再静默漏传人物参考", () => {
    const project = { id: "project", nodes: [
        { id: "config", type: "config", metadata: { characterReferences: { char: { imageKeys: ["image:deleted"] } } } },
        { id: "char", type: "character", metadata: { characterPrimaryIndex: 1, characterImages: [
            { storageKey: "image:identity" }, { storageKey: "image:primary" },
        ] } },
    ], connections: [{ id: "ref", fromNodeId: "char", toNodeId: "config" }] };
    assert.deepEqual(resolveCanvasImageReferences(project, "config")?.map((ref) => ref.storageKey), ["image:primary"]);
});

test("full character catalog resolution uses stable media keys independent of its cover", () => {
    const node = { id: "character", type: "character", metadata: { characterPrimaryIndex: 1, characterImages: [
        { storageKey: "media:outfit-a", url: "a.png" }, { storageKey: "media:outfit-b", url: "b.png" },
    ] } };
    assert.deepEqual(resolveCanvasCharacterImageReferences(node).map(reference => [reference.id, reference.storageKey]), [
        ["character:character-image:media:outfit-a", "media:outfit-a"],
        ["character:character-image:media:outfit-b", "media:outfit-b"],
    ]);
});

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

test("角色参考未保存选择时默认只用主图，存量选择不改写", () => {
    const project = {
        id: "project-1",
        nodes: [
            { id: "config-default", type: "config", metadata: {} },
            { id: "config-existing", type: "config", metadata: { characterReferences: { char: { imageKeys: ["image:outfit-a"] } } } },
            { id: "char", type: "character", title: "沈昭宁", metadata: { characterPrimaryIndex: 1, characterImages: [
                { url: "outfit-a", storageKey: "image:outfit-a", name: "outfit-a", mimeType: "image/png" },
                { url: "outfit-b", storageKey: "image:outfit-b", name: "outfit-b", mimeType: "image/png" },
            ] } },
        ],
        connections: [
            { id: "char-default", fromNodeId: "char", toNodeId: "config-default", role: "reference", order: 0 },
            { id: "char-existing", fromNodeId: "char", toNodeId: "config-existing", role: "reference", order: 0 },
        ],
    };

    assert.deepEqual(resolveCanvasImageReferences(project, "config-default")?.map((reference) => reference.storageKey), ["image:outfit-b"]);
    assert.deepEqual(resolveCanvasImageReferences(project, "config-existing")?.map((reference) => reference.storageKey), ["image:outfit-a"]);
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

test("智能生成节点作为参考入边时默认传递主图", () => {
    const project = {
        id: "project-1",
        nodes: [
            { id: "target", type: "config", metadata: { smart: true, generationMode: "image" } },
            { id: "source", type: "config", title: "源智能节点", metadata: { smart: true, generationMode: "image", primaryImageId: "image-2", images: [
                { id: "image-1", status: "success", content: "first.png", storageKey: "image:first", mimeType: "image/png" },
                { id: "image-2", status: "success", content: "second.png", storageKey: "image:second", mimeType: "image/png" },
                { id: "image-3", status: "success", content: "third.png", storageKey: "image:third", mimeType: "image/png" },
            ] } },
        ],
        connections: [{ id: "source-target", fromNodeId: "source", toNodeId: "target", role: "reference" }],
    };

    // 下游输入必须与节点上标记的主图一致。
    const references = resolveCanvasImageReferences(project, "target");
    assert.deepEqual(references?.map((reference) => reference.storageKey), ["image:second"]);
    assert.deepEqual(references?.map((reference) => reference.id), ["source:image:image-2"]);
});

test("智能节点显式钉选历史结果后，新结果归档不会改写引用", () => {
    const pinned = { id: "pinned", type: "config", title: "钉选节点", metadata: { smart: true, generationMode: "image", primaryImageId: "image-3",
        smartImageReferenceSelection: { mode: "selected_result", resultId: "image-2" }, images: [
            { id: "image-1", status: "success", content: "first.png", storageKey: "image:first", mimeType: "image/png" },
            { id: "image-2", status: "success", content: "second.png", storageKey: "image:second", mimeType: "image/png" },
            { id: "image-3", status: "success", content: "third.png", storageKey: "image:third", mimeType: "image/png" },
        ] } };
    const project = {
        id: "project-1",
        nodes: [{ id: "target", type: "config", metadata: { smart: true, generationMode: "image" } }, pinned],
        connections: [{ id: "pinned-target", fromNodeId: "pinned", toNodeId: "target", role: "reference" }],
    };

    assert.deepEqual(resolveCanvasImageReferences(project, "target")?.map((reference) => reference.storageKey), ["image:second"]);
});

test("智能节点的引用策略失效时回落到最新成功归档结果，不引用失败或运行中的槽位", () => {
    const project = {
        id: "project-1",
        nodes: [
            { id: "target", type: "config", metadata: { smart: true, generationMode: "image" } },
            { id: "source", type: "config", title: "源智能节点", metadata: { smart: true, generationMode: "image",
                smartImageReferenceSelection: { mode: "selected_result", resultId: "missing" }, images: [
                    { id: "image-1", status: "success", content: "first.png", storageKey: "image:first", mimeType: "image/png" },
                    { id: "image-2", status: "running", content: "pending.png", mimeType: "image/png" },
                ] } },
        ],
        connections: [{ id: "source-target", fromNodeId: "source", toNodeId: "target", role: "reference" }],
    };

    assert.deepEqual(resolveCanvasImageReferences(project, "target")?.map((reference) => reference.storageKey), ["image:first"]);
});

test("局部修改结果节点把智能节点主图当原图、蒙版排最后", () => {
    const project = {
        id: "project-1",
        nodes: [
            { id: "result", type: "image", metadata: { generationType: "edit" } },
            { id: "smart", type: "config", title: "智能生成", metadata: { smart: true, generationMode: "image", images: [{ id: "main", content: "smart.png", storageKey: "image:smart-main", mimeType: "image/png" }] } },
            { id: "mask", type: "image", title: "遮罩标注", metadata: { storageKey: "image:mask", maskOverlay: true } },
        ],
        connections: [
            { id: "smart-result", fromNodeId: "smart", toNodeId: "result" },
            { id: "mask-result", fromNodeId: "mask", toNodeId: "result" },
        ],
    };

    assert.deepEqual(resolveCanvasImageReferences(project, "result")?.map((reference) => reference.storageKey), ["image:smart-main", "image:mask"]);
});

test("蒙版标注连在改图源之前也排到最后", () => {
    const project = {
        id: "project-1",
        nodes: [
            { id: "result", type: "image", metadata: { generationType: "edit" } },
            { id: "source", type: "image", title: "原图", metadata: { storageKey: "image:source" } },
            { id: "mask", type: "image", title: "遮罩标注", metadata: { storageKey: "image:mask", maskOverlay: true } },
        ],
        connections: [
            { id: "mask-result", fromNodeId: "mask", toNodeId: "result" },
            { id: "source-result", fromNodeId: "source", toNodeId: "result" },
        ],
    };

    assert.deepEqual(resolveCanvasImageReferences(project, "result")?.map((reference) => reference.storageKey), ["image:source", "image:mask"]);
});
