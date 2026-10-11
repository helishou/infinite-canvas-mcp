import assert from "node:assert/strict";
import test from "node:test";
import { completedImageSlots } from "./image-result-slots.js";

test("archived smart-image slots keep task-batch identity and output order", () => {
    const result = completedImageSlots(
        { images: [{ id: "slot-1", status: "loading" }, { id: "slot-2", status: "loading" }] },
        ["slot-1", "slot-2"],
        [
            { imageId: "slot-1", url: "archive:one", storageKey: "image:one", mimeType: "image/png" },
            { imageId: "slot-2", url: "archive:two", storageKey: "image:two", mimeType: "image/png" },
        ],
        "task-new",
        42,
    );
    assert.deepEqual((result.images as Array<Record<string, unknown>>).map(image => [
        image.id, image.generationTaskId, image.generationTaskSequence, image.generationOutputIndex,
    ]), [
        ["slot-1", "task-new", 42, 0],
        ["slot-2", "task-new", 42, 1],
    ]);
});
