import assert from "node:assert/strict";
import test from "node:test";
import { selectSmartImageResult } from "./reference-contract.js";

const images = [
    { id: "old", status: "success", storageKey: "image:old" },
    { id: "working", status: "loading", storageKey: "" },
    { id: "latest", status: "success", storageKey: "image:latest" },
];

test("follow latest selects the last archived successful image slot", () => {
    assert.equal(selectSmartImageResult({ images, primaryImageId: "old" }, { mode: "latest_success" }).image?.id, "latest");
});

test("a late older task cannot replace the latest task-batch result", () => {
    const delayed = [
        { id: "new-task-first-output", generationTaskId: "task-new", generationTaskSequence: 22, generationOutputIndex: 0, status: "success", storageKey: "image:new-1" },
        { id: "old-task-late-output", generationTaskId: "task-old", generationTaskSequence: 11, generationOutputIndex: 0, status: "success", storageKey: "image:old" },
    ];
    assert.equal(selectSmartImageResult({ images: delayed }, { mode: "latest_success" }).image?.id, "new-task-first-output");
});

test("latest within one multi-image batch follows output order", () => {
    const batch = [
        { id: "batch-first", generationTaskSequence: 30, generationOutputIndex: 0, status: "success", storageKey: "image:first" },
        { id: "batch-last", generationTaskSequence: 30, generationOutputIndex: 1, status: "success", storageKey: "image:last" },
    ];
    assert.equal(selectSmartImageResult({ images: batch }, { mode: "latest_success" }).image?.id, "batch-last");
});

test("pinning an image history does not follow later successful outputs", () => {
    assert.equal(selectSmartImageResult({ images }, { mode: "selected_result", resultId: "old" }).image?.storageKey, "image:old");
});

test("failed and pending image slots cannot replace the last good result", () => {
    const result = selectSmartImageResult({ images: [{ id: "failed", status: "failed", storageKey: "image:failed" }, { id: "queued", status: "loading", storageKey: "" }] }, { mode: "latest_success" });
    assert.match(result.error || "", /没有成功归档/u);
});

test("legacy reference bindings preserve explicit-primary then first-valid behavior", () => {
    assert.equal(selectSmartImageResult({ images, primaryImageId: "old" }).image?.id, "old");
    assert.equal(selectSmartImageResult({ images }).image?.id, "old");
});
test("node-managed selection is independent of browsing and keeps explicit binding overrides", () => {
    const metadata = { images, primaryImageId: "latest", smartImageReferenceSelection: { mode: "selected_result", resultId: "old" }, prompt: "current prompt", model: "current model" };
    assert.equal(selectSmartImageResult(metadata, { mode: "node_selection" }).image?.id, "old");
    assert.equal(selectSmartImageResult({ ...metadata, primaryImageId: "old" }, { mode: "latest_success" }).image?.id, "latest");
    assert.equal(selectSmartImageResult({ images, primaryImageId: "old" }, { mode: "node_selection" }).image?.id, "latest");
    assert.match(selectSmartImageResult({ ...metadata, smartImageReferenceSelection: { mode: "selected_result", resultId: "working" } }, { mode: "node_selection" }).error || "", /未成功|未归档/u);
});
