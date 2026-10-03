import assert from "node:assert/strict";
import test from "node:test";
import { buildH3OutputPreview } from "./h3-output-preview";
import type { H3Ref } from "../types";

test("Output preview keeps the visible filter order and selected item, resolving archived media only", () => {
    const outputs: H3Ref[] = [
        { type: "video", url: "old-url", storageKey: "video:first", name: "Clip 1 old", segmentId: "one", params: { prompt: "private" } },
        { type: "video", url: "second.mp4", name: "Clip 2", segmentId: "two" },
        { type: "image", url: "image.png", name: "Clip 1 frame", segmentId: "one" },
    ];
    const original = structuredClone(outputs);
    const preview = buildH3OutputPreview(outputs, 1, (key) => `/media/${key}`)!;
    assert.equal(preview.url, "second.mp4");
    assert.equal(preview.galleryIndex, 1);
    assert.deepEqual(preview.gallery?.map((item) => item.url), ["/media/video:first", "second.mp4", "image.png"]);
    assert.equal(JSON.stringify(preview).includes("private"), false);
    const filtered = buildH3OutputPreview(outputs.filter((item) => item.segmentId === "one"), 1, (key) => `/media/${key}`)!;
    assert.deepEqual(filtered.gallery?.map((item) => item.name), ["Clip 1 old", "Clip 1 frame"]);
    assert.deepEqual(outputs, original);
    assert.equal(buildH3OutputPreview([], 0, String), null);
    assert.equal(buildH3OutputPreview(outputs, -1, String), null);
});
