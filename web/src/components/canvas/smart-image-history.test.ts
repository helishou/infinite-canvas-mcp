import assert from "node:assert/strict";
import test from "node:test";
import { smartImagePrimaryPatch, smartImageSettingsPatch } from "./smart-image-history";
import type { CanvasNodeImage } from "@/types/canvas";

const image: CanvasNodeImage = { id: "old-result", status: "success", storageKey: "image:old", content: "preview", naturalWidth: 8, naturalHeight: 8, bytes: 100, mimeType: "image/png",
    generationSnapshot: { createdAt: "2026-01-01T00:00:00Z", prompt: "Old prompt", effectivePrompt: "Old prompt", model: "Old model", size: "old size", quality: "old quality", background: "opaque", count: 1, references: [{ id: "REF", name: "Reference", type: "image", storageKey: "reference:old" }], params: { seed: 7 } } };
test("设为主图把旧结果显式指定为当前有效结果，但不恢复生成输入或改引用选择策略", () => {
    const metadata = { prompt: "Current prompt", composerContent: "Current prompt", model: "Current model", smartImageReferenceSelection: { mode: "latest_success" }, ...smartImagePrimaryPatch(image) };
    assert.equal(metadata.prompt, "Current prompt");
    assert.equal(metadata.composerContent, "Current prompt");
    assert.equal(metadata.model, "Current model");
    assert.equal(metadata.activeImageHistoryExplicit, true);
    assert.equal(metadata.activeImageHistoryId, "old-result");
    assert.deepEqual(metadata.smartImageReferenceSelection, { mode: "latest_success" });
});
test("explicit settings restoration restores the snapshot but leaves reference selection independent", () => {
    const restored = smartImageSettingsPatch(image)!;
    assert.equal(restored.prompt, "Old prompt");
    assert.equal(restored.model, "Old model");
    assert.deepEqual(restored.references, ["reference:old"]);
    assert.equal(restored.activeImageHistoryExplicit, true);
    assert.equal(Object.hasOwn(restored, "smartImageReferenceSelection"), false);
    assert.equal(smartImageSettingsPatch({ id: "imported" } as CanvasNodeImage), undefined);
});
