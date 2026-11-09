import assert from "node:assert/strict";
import test from "node:test";

import { MAX_RESIZE_LONG_EDGE, MIN_RESIZE_LONG_EDGE, resolveResizeSize } from "@/lib/canvas/canvas-image-data";

test("resize keeps the aspect ratio when enlarging", () => {
    assert.deepEqual(resolveResizeSize(1024, 512, 2048), { width: 2048, height: 1024 });
});

test("resize can shrink below the source size", () => {
    assert.deepEqual(resolveResizeSize(2048, 1024, 512), { width: 512, height: 256 });
});

test("images above the 4K ceiling can still be shrunk", () => {
    assert.deepEqual(resolveResizeSize(6000, 3000, 2048), { width: 2048, height: 1024 });
});

test("out-of-range targets are clamped without producing an empty edge", () => {
    assert.deepEqual(resolveResizeSize(1000, 500, 8000), { width: MAX_RESIZE_LONG_EDGE, height: 2048 });
    assert.deepEqual(resolveResizeSize(1000, 500, 1), { width: MIN_RESIZE_LONG_EDGE, height: 16 });
    assert.deepEqual(resolveResizeSize(4096, 2, MIN_RESIZE_LONG_EDGE), { width: MIN_RESIZE_LONG_EDGE, height: 1 });
});

test("a target equal to the source long edge leaves the size unchanged", () => {
    assert.deepEqual(resolveResizeSize(1536, 768, 1536), { width: 1536, height: 768 });
});
