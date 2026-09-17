import assert from "node:assert/strict";
import test from "node:test";

import { h3ClipCacheFingerprint, h3ClipDependsOnPrevious, h3ConfirmationPhaseParams, planH3CacheReuse, stableH3Fingerprint } from "./h3-cache.js";

const base = { id: "c1", prompt: "shot", seed: 7, result: "/media/a", resultStorageKey: "a" };
const fingerprint = (segment: Record<string, unknown>, previousFingerprint?: string) => h3ClipCacheFingerprint({
    segment, params: { steps: 6, modelName: "h3/model" }, references: [{ storageKey: "ref-a" }], compiledPrompt: String(segment.prompt), previousFingerprint,
});

test("fingerprints are canonical and exclude runtime/result fields", () => {
    assert.equal(stableH3Fingerprint({ b: 2, a: 1 }), stableH3Fingerprint({ a: 1, b: 2 }));
    assert.equal(fingerprint(base), fingerprint({ ...base, status: "loading", progress: 0.5, result: "/media/b", resultStorageKey: "b" }));
    assert.notEqual(fingerprint(base), fingerprint({ ...base, prompt: "changed" }));
});

test("only explicit continuation modes depend on the previous clip", () => {
    assert.equal(h3ClipDependsOnPrevious({}), false);
    assert.equal(h3ClipDependsOnPrevious({ motionContextEnabled: true }), true);
    assert.equal(h3ClipDependsOnPrevious({ previousVideoAsReference: true }), true);
    assert.equal(h3ClipDependsOnPrevious({ tailFrameContinuation: true }), true);
});

test("upstream changes invalidate only dependent downstream clips", () => {
    const independent = { ...base, id: "c2" };
    const dependent = { ...base, id: "c3", motionContextEnabled: true };
    assert.equal(fingerprint(independent, "upstream-a"), fingerprint(independent, "upstream-b"));
    assert.notEqual(fingerprint(dependent, "upstream-a"), fingerprint(dependent, "upstream-b"));
});

test("reuse requires both exact fingerprint and an output", () => {
    assert.deepEqual(planH3CacheReuse([
        { segment: { result: "/media/a", cacheFingerprint: "same" }, fingerprint: "same" },
        { segment: { result: "/media/b", cacheFingerprint: "old" }, fingerprint: "new" },
        { segment: { cacheFingerprint: "same" }, fingerprint: "same" },
    ]).map((row) => row.reusable), [true, false, false]);
});

test("confirmation runtime fields and phase-B flag do not invalidate the first-pass fingerprint", () => {
    const first = fingerprint({ ...base, confirmationMode: true });
    const withDurableCache = h3ClipCacheFingerprint({
        segment: { ...base, confirmationMode: true, firstPassReady: true, firstPassResult: "/media/first", firstPassStorageKey: "first", firstPassFingerprint: first, status: "awaiting_confirmation" },
        params: { steps: 6, modelName: "h3/model", confirmSecondPass: true, postGenerationOnly: true },
        references: [{ storageKey: "ref-a" }], compiledPrompt: "shot",
    });
    assert.equal(withDurableCache, first);
});

test("confirmation phase A excludes every expensive postpass and phase B selects decoded-video refine", () => {
    const requested = { latentUpscaleEnabled: true, rtxEnabled: true, faceRefineEnabled: true, dlssUpscaleMode: "视频超分", dlssFrameInterpolationEnabled: true };
    const phaseA = h3ConfirmationPhaseParams({ confirmationMode: true }, requested);
    assert.deepEqual(phaseA, { ...requested, latentUpscaleEnabled: false, rtxEnabled: false, faceRefineEnabled: false, dlssUpscaleMode: "关闭", dlssFrameInterpolationEnabled: false });
    const phaseB = h3ConfirmationPhaseParams({ confirmationMode: true }, requested, true);
    assert.equal(phaseB.postGenerationOnly, true);
    assert.equal(phaseB.confirmSecondPass, true);
    assert.equal(phaseB.motionContextEnabled, false);
});
