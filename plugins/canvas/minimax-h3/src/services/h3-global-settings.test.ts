import test from "node:test";
import assert from "node:assert/strict";
import type { H3Segment } from "../types";
import { applyH3GlobalSettings, patchAllH3Clips } from "./h3-global-settings";
import { resolveH3Runtime } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";

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

test("new Clips keep explicitly chosen global fields while following defaults for other fields", () => {
    const clip = applyH3GlobalSettings({ id: "new", h3ParameterPolicy: "defaults", videoSteps: 99 }, { h3GlobalSettings: { megapixels: 0.9, motionContextEnabled: true } });
    const params = resolveH3Runtime(clip as unknown as Record<string, unknown>, {}, {}, { megapixels: 0.4, videoSteps: 12, tailFrameContinuation: true }).params;
    assert.equal(params.megapixels, 0.9);
    assert.equal(params.steps, 12);
    assert.equal(params.motionContextEnabled, true);
    assert.equal(params.tailFrameContinuation, false);
});

test("global imports cannot restore the conflicting raw patch over atomic continuation edits", () => {
    const result = patchAllH3Clips({}, [{ id: "a" }, { id: "b" }], { tailFrameContinuation: true, motionContextEnabled: true });
    assert.equal(result.h3GlobalSettings.motionContextEnabled, false);
    for (const clip of result.segments) {
        assert.equal(clip.tailFrameContinuation, true);
        assert.equal(clip.motionContextEnabled, false);
    }
});
