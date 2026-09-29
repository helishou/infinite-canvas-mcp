import assert from "node:assert/strict";
import test from "node:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { canvasNodeImage, hasRenderableCanvasImage } from "./canvas-image-renderability";

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

test("图片工具读取智能图片当前主图，包含只有 storageKey 的结果", () => {
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
