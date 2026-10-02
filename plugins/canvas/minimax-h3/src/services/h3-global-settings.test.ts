import test from "node:test";
import assert from "node:assert/strict";
import type { H3Segment } from "../types";
import { applyH3GlobalSettings, patchAllH3Clips } from "./h3-global-settings";

test("global H3 edits update every Clip and remain available to new Clips", () => {
    const clips: H3Segment[] = [
        { id: "one", prompt: "first", duration: 5, megapixels: 0.4, referenceBindings: [{ id: "ref-one", role: "scene", type: "image", sourceNodeId: "image-one" }] },
        { id: "two", prompt: "second", duration: 8, megapixels: 0.6 },
    ];
    const update = patchAllH3Clips({}, clips, { megapixels: 0.9, duration: 6, styleTemplateId: "modern-korean" });
    assert.deepEqual(update.segments.map((clip) => [clip.start, clip.duration, clip.megapixels]), [[0, 6, 0.9], [6, 6, 0.9]]);
    assert.equal(update.segments[0].prompt, "first");
    assert.equal(update.segments[1].prompt, "second");
    assert.deepEqual(update.segments.map((clip) => clip.styleTemplateId), ["modern-korean", "modern-korean"]);
    assert.deepEqual(update.segments[0].referenceBindings, clips[0].referenceBindings);
    const newClip = applyH3GlobalSettings({ id: "three", prompt: "new", duration: 5, megapixels: 0.2 }, update);
    assert.equal(newClip.duration, 6);
    assert.equal(newClip.megapixels, 0.9);
    assert.equal(newClip.prompt, "new");
    assert.equal(newClip.styleTemplateId, "modern-korean");
});

test("clearing a global setting still clears an inherited value on new Clips", () => {
    const update = patchAllH3Clips({}, [{ id: "one", sampler: "euler" }], { sampler: undefined });
    assert.equal(update.segments[0].sampler, undefined);
    assert.equal(update.h3GlobalSettings.sampler, null);
    assert.equal(applyH3GlobalSettings({ id: "two", sampler: "euler" }, JSON.parse(JSON.stringify(update))).sampler, undefined);
});
