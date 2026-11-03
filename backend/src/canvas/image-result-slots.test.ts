import assert from "node:assert/strict";
import test from "node:test";
import { completedImageSlots } from "./image-result-slots.js";

test("one workflow run archives both outputs in distinct slots without resurrecting deleted slots", () => {
    const metadata = { primaryImageId: "slot", images: [{ id: "old", content: "old.png" }, { id: "slot", status: "loading", generationSnapshot: { prompt: "MJ" } }] };
    const media = [
        { imageId: "slot", url: "two-pass.png", storageKey: "image:237" },
        { imageId: "slot", url: "one-pass.png", storageKey: "image:812" },
    ];
    const result = completedImageSlots(metadata, ["slot"], media, "task", 42);
    const images = result.images as Array<Record<string, any>>;
    assert.equal(images.length, 3);
    assert.equal(new Set(images.map(image => image.id)).size, 3);
    assert.deepEqual(images.slice(1).map(image => [image.storageKey, image.generationOutputIndex, image.generationTaskId]), [["image:237", 0, "task"], ["image:812", 1, "task"]]);
    assert.deepEqual(images[2].generationSnapshot, { prompt: "MJ" });
    assert.equal(result.storageKey, "image:237");
    const replay = completedImageSlots({ ...metadata, ...result }, ["slot"], media, "task", 42);
    assert.deepEqual(replay.images, result.images, "write-back replay must not duplicate extra outputs");
    assert.deepEqual(completedImageSlots({ images: [] }, ["slot"], media, "task").images, []);
});

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

