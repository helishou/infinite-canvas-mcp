import assert from "node:assert/strict";
import test from "node:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { hasRenderableCanvasImage } from "./canvas-image-renderability";

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
