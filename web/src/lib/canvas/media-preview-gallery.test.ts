import assert from "node:assert/strict";
import test from "node:test";
import { mediaPreviewSources, mediaPreviewStartIndex } from "./media-preview-gallery";

test("single previews and image comparisons keep their original request semantics", () => {
    const item = { url: "after.png", beforeUrl: "before.png", type: "image" as const };
    assert.deepEqual(mediaPreviewSources(item), [item]);
    assert.deepEqual(mediaPreviewSources(null), []);
    assert.equal(mediaPreviewStartIndex(item, [item]), 0);
});
test("galleries start at the clicked item, including URL fallback for invalid indices", () => {
    const gallery = [{ url: "a", type: "video" as const }, { url: "b", type: "video" as const }];
    const item = { ...gallery[1], gallery, galleryIndex: 1 };
    assert.equal(mediaPreviewStartIndex(item, mediaPreviewSources(item)), 1);
    assert.equal(mediaPreviewStartIndex({ ...item, galleryIndex: 99 }, gallery), 1);
    const withEmpty = { ...item, gallery: [{ url: "" }, gallery[1], { url: "c", type: "video" as const }] };
    assert.equal(mediaPreviewStartIndex(withEmpty, mediaPreviewSources(withEmpty)), 0);
    assert.equal(mediaPreviewStartIndex({ url: "unknown", galleryIndex: -1 }, gallery), 0);
    assert.deepEqual(mediaPreviewSources({ url: "single", gallery: [] }), [{ url: "single", gallery: [] }]);
});
