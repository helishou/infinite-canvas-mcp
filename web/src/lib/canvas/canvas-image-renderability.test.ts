import assert from "node:assert/strict";
import test from "node:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { canvasNodeImage, canvasNodePrimaryImage, hasRenderableCanvasImage } from "./canvas-image-renderability";

const imageNode = (metadata: CanvasNodeData["metadata"]): CanvasNodeData => ({
    id: "image",
    type: CanvasNodeType.Image,
    title: "图片",
    position: { x: 0, y: 0 },
    width: 200,
    height: 300,
    metadata,
});

test("图片节点仅有 storageKey 时仍应进入图片渲染而不是空图占位", () => {
    assert.equal(hasRenderableCanvasImage(imageNode({ status: "success", storageKey: "image:1" })), true);
    assert.equal(hasRenderableCanvasImage(imageNode({ status: "success", images: [{ id: "a", status: "success", content: "", storageKey: "image:a", naturalWidth: 100, naturalHeight: 200, bytes: 1, mimeType: "image/png" }] })), true);
    assert.equal(hasRenderableCanvasImage(imageNode({ status: "success" })), false);
});

test("图片工具读取智能图片当前引用的结果，包含只有 storageKey 的结果", () => {
    const smart: CanvasNodeData = {
        ...imageNode({}),
        type: CanvasNodeType.Config,
        metadata: {
            smart: true,
            generationMode: "image",
            content: "old.png",
            images: [
                { id: "old", status: "success", content: "old.png", storageKey: "image:old", naturalWidth: 100, naturalHeight: 100, bytes: 1, mimeType: "image/png" },
                { id: "current", status: "success", content: "", storageKey: "image:current", naturalWidth: 200, naturalHeight: 300, bytes: 2, mimeType: "image/webp" },
            ],
            primaryImageId: "current",
        },
    };
    assert.deepEqual(canvasNodeImage(smart), { content: "", storageKey: "image:current", naturalWidth: 200, naturalHeight: 300, bytes: 2, mimeType: "image/webp" });
    assert.equal(hasRenderableCanvasImage(smart), true);
    assert.equal(canvasNodeImage({ ...smart, metadata: { ...smart.metadata, generationMode: "text" } }), null);
    assert.equal(canvasNodeImage(imageNode({ storageKey: "image:plain" }))?.storageKey, "image:plain");
});

test("智能节点引用缺省跟随最新成功归档结果，不被 primaryImageId 冻结", () => {
    const smart: CanvasNodeData = {
        ...imageNode({}),
        type: CanvasNodeType.Config,
        metadata: {
            smart: true,
            generationMode: "image",
            // 新结果归档后 primaryImageId 可能仍停留在旧主图（批量结果保持折叠）。
            primaryImageId: "first",
            images: [
                { id: "first", status: "success", content: "first.png", storageKey: "image:first", naturalWidth: 100, naturalHeight: 100, bytes: 1, mimeType: "image/png" },
                { id: "latest", status: "success", content: "", storageKey: "image:latest", naturalWidth: 200, naturalHeight: 300, bytes: 2, mimeType: "image/webp" },
            ],
        },
    };
    assert.equal(canvasNodeImage(smart)?.storageKey, "image:latest");
});

test("智能节点加入资产时使用当前主图，而非引用默认跟随的最新结果", () => {
    const smart: CanvasNodeData = {
        ...imageNode({}),
        type: CanvasNodeType.Config,
        metadata: {
            smart: true,
            generationMode: "image",
            primaryImageId: "selected",
            images: [
                { id: "selected", status: "success", content: "selected.png", storageKey: "image:selected", naturalWidth: 100, naturalHeight: 100, bytes: 1, mimeType: "image/png" },
                { id: "first-following", status: "success", content: "first-following.png", storageKey: "image:first-following", naturalWidth: 200, naturalHeight: 200, bytes: 2, mimeType: "image/webp" },
            ],
        },
    };
    assert.equal(canvasNodeImage(smart)?.storageKey, "image:first-following");
    assert.equal(canvasNodePrimaryImage(smart)?.storageKey, "image:selected");
});

test("智能节点没有有效主图 ID 时，加入资产与节点预览一样回退到第一张", () => {
    const base: CanvasNodeData["metadata"] = {
        smart: true,
        generationMode: "image",
        images: [
            { id: "first", status: "success", content: "first.png", storageKey: "image:first", naturalWidth: 100, naturalHeight: 100, bytes: 1, mimeType: "image/png" },
            { id: "latest", status: "success", content: "latest.png", storageKey: "image:latest", naturalWidth: 200, naturalHeight: 200, bytes: 2, mimeType: "image/webp" },
        ],
    };
    const node = (metadata: CanvasNodeData["metadata"]): CanvasNodeData => ({ ...imageNode(metadata), type: CanvasNodeType.Config });
    assert.equal(canvasNodePrimaryImage(node(base))?.storageKey, "image:first");
    assert.equal(canvasNodePrimaryImage(node({ ...base, primaryImageId: "deleted-result" }))?.storageKey, "image:first");
});

test("智能节点显式钉选历史结果时锁定那张，失效选择回落最新", () => {
    const base: CanvasNodeData["metadata"] = {
        smart: true,
        generationMode: "image",
        images: [
            { id: "first", status: "success", content: "first.png", storageKey: "image:first", naturalWidth: 100, naturalHeight: 100, bytes: 1, mimeType: "image/png" },
            { id: "latest", status: "success", content: "", storageKey: "image:latest", naturalWidth: 200, naturalHeight: 300, bytes: 2, mimeType: "image/webp" },
        ],
    };
    const node = (metadata: CanvasNodeData["metadata"]): CanvasNodeData => ({ ...imageNode(metadata), type: CanvasNodeType.Config });
    assert.equal(canvasNodeImage(node({ ...base, smartImageReferenceSelection: { mode: "selected_result", resultId: "first" } }))?.storageKey, "image:first");
    assert.equal(canvasNodeImage(node({ ...base, smartImageReferenceSelection: { mode: "selected_result", resultId: "missing" } }))?.storageKey, "image:latest");
    // 只写了顶层字段、没有归档历史的旧画布继续走顶层兜底。
    assert.equal(canvasNodeImage(node({ smart: true, generationMode: "image", content: "legacy.png", storageKey: "image:legacy" }))?.storageKey, "image:legacy");
});
