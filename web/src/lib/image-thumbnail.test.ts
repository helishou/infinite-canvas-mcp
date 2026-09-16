import assert from "node:assert/strict";
import test from "node:test";

import { getThumbnailDimensions, pickImageSource } from "./image-thumbnail";

const image = {
    previewUrl: "data:image/webp;base64,preview",
    originalUrl: "data:image/png;base64,original",
    naturalWidth: 4000,
    naturalHeight: 3000,
    renderedWidth: 420,
    renderedHeight: 315,
};

test("画布尺寸在缩略图分辨率内时使用 WebP 预览", () => {
    assert.equal(pickImageSource({ ...image, scale: 1, devicePixelRatio: 1 }), image.previewUrl);
});

test("放大后所需像素超过缩略图时回退原图", () => {
    assert.equal(pickImageSource({ ...image, scale: 3, devicePixelRatio: 2 }), image.originalUrl);
});

test("缩略图保持原始比例且最长边不超过限制", () => {
    assert.deepEqual(getThumbnailDimensions(4000, 3000), { width: 768, height: 576 });
});
