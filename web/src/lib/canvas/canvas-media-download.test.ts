import assert from "node:assert/strict";
import test from "node:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { canvasNodeDownloadPlan } from "./canvas-media-download";

const node = (id: string, type: CanvasNodeData["type"], metadata: CanvasNodeData["metadata"]): CanvasNodeData => ({
    id,
    type,
    title: id,
    position: { x: 0, y: 0 },
    width: 320,
    height: 180,
    metadata,
});

test("裁剪结果视频节点下载优先用归档 storageKey，文件名不重复类型前缀", () => {
    const trimmed = node("video-canvas-trim-56f01c78", CanvasNodeType.Video, {
        status: "success",
        content: "/media/video%3A6aedf78b",
        storageKey: "video:6aedf78b",
        mimeType: "video/mp4",
    });
    assert.deepEqual(canvasNodeDownloadPlan(trimmed, "video", "mp4"), {
        storageKey: "video:6aedf78b",
        url: "/media/video%3A6aedf78b",
        filename: "canvas-video-canvas-trim-56f01c78.mp4",
    });
});

test("普通 id 的节点下载保留类型前缀，音频与图片同样带出 storageKey", () => {
    const audio = node("node-1", CanvasNodeType.Audio, { status: "success", content: "/media/audio%3Aa", storageKey: "audio:a", mimeType: "audio/mpeg" });
    assert.deepEqual(canvasNodeDownloadPlan(audio, "audio", "mp3"), { storageKey: "audio:a", url: "/media/audio%3Aa", filename: "canvas-audio-node-1.mp3" });
    const image = node("image-2", CanvasNodeType.Image, { status: "success", content: "/media/image%3Ab", storageKey: "image:b", mimeType: "image/webp" });
    assert.equal(canvasNodeDownloadPlan(image, "image", "webp")?.filename, "canvas-image-2.webp");
    assert.equal(canvasNodeDownloadPlan(image, "image", "webp")?.storageKey, "image:b");
});

test("多图图片节点下载屏幕当前显示的主图", () => {
    const image = node("image-batch", CanvasNodeType.Image, {
        primaryImageId: "shown",
        images: [
            { id: "shown", status: "success", content: "/media/image%3Ashown", storageKey: "image:shown", naturalWidth: 100, naturalHeight: 100, bytes: 1, mimeType: "image/png" },
            { id: "latest", status: "success", content: "/media/image%3Alatest", storageKey: "image:latest", naturalWidth: 200, naturalHeight: 200, bytes: 2, mimeType: "image/webp" },
        ],
    });
    assert.equal(canvasNodeDownloadPlan(image, "image", "png")?.storageKey, "image:shown");
});

test("没有归档也没有内容时不产生下载计划，只有内容时仍按原 URL 下载", () => {
    assert.equal(canvasNodeDownloadPlan(node("video-empty", CanvasNodeType.Video, { status: "idle" }), "video", "mp4"), null);
    const remote = node("video-remote", CanvasNodeType.Video, { status: "success", content: "https://example.test/a.mp4" });
    assert.deepEqual(canvasNodeDownloadPlan(remote, "video", "mp4"), { storageKey: undefined, url: "https://example.test/a.mp4", filename: "canvas-video-remote.mp4" });
});
