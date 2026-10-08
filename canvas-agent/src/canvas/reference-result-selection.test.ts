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
