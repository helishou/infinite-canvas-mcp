import assert from "node:assert/strict";
import test from "node:test";
import { styleTemplateText } from "@basketikun/canvas-agent/plugins/minimax-h3/style-templates";

import { h3ClipCacheFingerprint, h3ClipDependsOnPrevious, h3ConfirmationKind, h3ConfirmationFingerprintParams, h3ConfirmationPhaseParams, planH3CacheReuse, stableH3Fingerprint } from "./h3-cache.js";

const base = { id: "c1", prompt: "shot", seed: 7, result: "/media/a", resultStorageKey: "a" };
const fingerprint = (segment: Record<string, unknown>, previousFingerprint?: string) => h3ClipCacheFingerprint({
    segment, params: { steps: 6, modelName: "h3/model" }, references: [{ storageKey: "ref-a" }], compiledPrompt: String(segment.prompt), previousFingerprint,
});

test("fingerprints are canonical and exclude runtime/result fields", () => {
    assert.equal(stableH3Fingerprint({ b: 2, a: 1 }), stableH3Fingerprint({ a: 1, b: 2 }));
    assert.equal(fingerprint(base), fingerprint({ ...base, status: "loading", progress: 0.5, result: "/media/b", resultStorageKey: "b" }));
    assert.notEqual(fingerprint(base), fingerprint({ ...base, prompt: "changed" }));
});

test("changing the visual style template invalidates a cached Clip", () => {
    assert.notEqual(fingerprint({ ...base, styleTemplateId: "modern-korean" }), fingerprint({ ...base, styleTemplateId: "soft-light" }));
    assert.notEqual(fingerprint({ ...base, styleTemplateId: "modern-korean" }), fingerprint({ ...base, styleTemplateId: null }));
});

test("revised style content invalidates outputs cached under the same template ID", () => {
    for (const id of ["soft-light", "modern-korean"]) {
        const params = { mode: "ref2va" };
        const compiledPrompt = "detailed_description:\nA moonlit bridge over a dark pond.";
        const segment = { styleTemplateId: id };
        const oldInput = { version: 2, segment, params, references: [], compiledPrompt, dependency: "independent" };
        const old = stableH3Fingerprint(oldInput);
        const current = h3ClipCacheFingerprint({ segment, params, references: [], compiledPrompt });
        assert.notEqual(current, old);
        assert.equal(current, stableH3Fingerprint({ ...oldInput, styleTemplate: styleTemplateText(id) }));
    }
});

test("Clips without a selected style retain the existing cache identity", () => {
    const params = { mode: "ref2va" };
    const compiledPrompt = "detailed_description:\nA moonlit bridge.";
    for (const segment of [{}, { styleTemplateId: null }]) {
        assert.equal(h3ClipCacheFingerprint({ segment, params, references: [], compiledPrompt }),
            stableH3Fingerprint({ version: 2, segment, params, references: [], compiledPrompt, dependency: "independent" }));
    }
});

test("only explicit continuation modes depend on the previous clip", () => {
    assert.equal(h3ClipDependsOnPrevious({}), false);
    assert.equal(h3ClipDependsOnPrevious({ motionContextEnabled: true }), true);
    assert.equal(h3ClipDependsOnPrevious({ previousVideoAsReference: true }), false);
    assert.equal(h3ClipDependsOnPrevious({ tailFrameContinuation: true }), true);
});

test("upstream changes invalidate only dependent downstream clips", () => {
    const independent = { ...base, id: "c2" };
    const dependent = { ...base, id: "c3", motionContextEnabled: true };
    assert.equal(fingerprint(independent, "upstream-a"), fingerprint(independent, "upstream-b"));
    assert.notEqual(fingerprint(dependent, "upstream-a"), fingerprint(dependent, "upstream-b"));
});

test("fixed-frame tail continuation invalidates outputs produced before tail routing was fixed", () => {
    const segment = { ...base, previousTailFrameContinuation: true };
    const params = { mode: "fl2v", taskMode: "fl2v" };
    const oldFingerprint = stableH3Fingerprint({
        version: 2, segment: { previousTailFrameContinuation: true }, params,
        references: [], compiledPrompt: "shot", dependency: "previous",
    });
    const newFingerprint = h3ClipCacheFingerprint({ segment, params, references: [], compiledPrompt: "shot", previousFingerprint: "previous" });
    assert.notEqual(newFingerprint, oldFingerprint);
});

test("tail references invalidate older storyboard-replacement outputs in every mode", () => {
    for (const mode of ["ref2va", "t2v", "i2v", "fl2v"]) {
        const segment = { ...base, previousTailFrameContinuation: true };
        const params = { mode, taskMode: mode };
        const old = stableH3Fingerprint({ version: mode === "ref2va" ? 2 : 3, segment: { previousTailFrameContinuation: true }, params, references: [], compiledPrompt: "shot", dependency: "previous" });
        assert.notEqual(h3ClipCacheFingerprint({ segment, params, references: [], compiledPrompt: "shot", previousFingerprint: "previous" }), old);
    }
});

test("tail opening-state priority invalidates the older optional-reference cache", () => {
    const segment = { ...base, previousTailFrameContinuation: true };
    const params = { mode: "ref2va" };
    const older = stableH3Fingerprint({ version: 4, segment: { previousTailFrameContinuation: true }, params, references: [], compiledPrompt: "shot", dependency: "previous" });
    assert.notEqual(h3ClipCacheFingerprint({ segment, params, references: [], compiledPrompt: "shot", previousFingerprint: "previous" }), older);
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

test("confirmation without latent upscaling selects decoded-video refine", () => {
    const requested = { latentUpscaleEnabled: false, rtxEnabled: true, faceRefineEnabled: true, dlssUpscaleMode: "视频超分", dlssFrameInterpolationEnabled: true };
    const phaseA = h3ConfirmationPhaseParams({ confirmationMode: true }, requested);
    assert.deepEqual(phaseA, { ...requested, latentUpscaleEnabled: false, rtxEnabled: false, faceRefineEnabled: false, dlssUpscaleMode: "关闭", dlssFrameInterpolationEnabled: false });
    const phaseB = h3ConfirmationPhaseParams({ confirmationMode: true }, requested, true);
    assert.equal(phaseB.postGenerationOnly, true);
    assert.equal(phaseB.confirmSecondPass, true);
    assert.equal(phaseB.motionContextEnabled, false);
});

test("confirmation fingerprint ignores phase-B-only postpass settings", () => {
    const segment = { ...base, latentUpscaleConfirmationMode: true };
    const firstPass = {
        steps: 6, modelName: "h3/model", faceRefineEnabled: false, faceRefineDetector: "old.pt", faceRefineConfidence: 0.35,
        rtxEnabled: false, rtxScale: 1, rtxQuality: "HIGH", latentUpscaleEnabled: true, latentUpscaleModel: "old.safetensors",
        latentUpscaleMegapixels: 1, dlssUpscaleMode: "关闭", dlssFrameInterpolationEnabled: false, dlssVideoUpscaleMode: "关闭",
        seamFaceFadeFrames: 0,
    };
    const secondPass = {
        ...firstPass, confirmSecondPass: true, postGenerationOnly: true, faceRefineEnabled: true, faceRefineDetector: "new.pt",
        faceRefineConfidence: 0.8, rtxEnabled: true, rtxScale: 2, rtxQuality: "ULTRA", latentUpscaleEnabled: true,
        latentUpscaleModel: "new.safetensors", latentUpscaleMegapixels: 2, dlssUpscaleMode: "视频超分",
        dlssFrameInterpolationEnabled: true, dlssVideoUpscaleMode: "超分", seamFaceFadeFrames: 12,
    };
    const firstFingerprintParams = h3ConfirmationFingerprintParams(segment, firstPass);
    const secondFingerprintParams = h3ConfirmationFingerprintParams(segment, secondPass);
    assert.deepEqual(secondFingerprintParams, firstFingerprintParams);
    assert.equal(
        h3ClipCacheFingerprint({ segment, params: secondFingerprintParams, references: [{ storageKey: "ref-a" }], compiledPrompt: "shot" }),
        h3ClipCacheFingerprint({ segment, params: firstFingerprintParams, references: [{ storageKey: "ref-a" }], compiledPrompt: "shot" }),
    );
});

test("latent confirmation preserves the split schedule and chooses durable continuation", () => {
    const segment = { latentUpscaleConfirmationMode: true };
    const params = { latentUpscaleEnabled: true, h3FirstSteps: 6, h3SecondSteps: 4, rtxEnabled: true, faceRefineEnabled: true };
    const first = h3ConfirmationPhaseParams(segment, params);
    assert.equal(first.latentUpscaleEnabled, true);
    assert.equal(first.latentConfirmationPhase, "first");
    assert.equal(first.rtxEnabled, false);
    assert.equal(first.faceRefineEnabled, false);
    const second = h3ConfirmationPhaseParams(segment, params, true);
    assert.equal(second.latentConfirmationPhase, "second");
    assert.equal(second.postGenerationOnly, false);
    assert.equal(second.confirmSecondPass, true);
    assert.deepEqual(h3ConfirmationFingerprintParams(segment, { ...second, latentCheckpointId: "runtime" }), h3ConfirmationFingerprintParams(segment, first));
    assert.notDeepEqual(h3ConfirmationFingerprintParams(segment, { ...params, h3SecondSteps: 5 }), h3ConfirmationFingerprintParams(segment, params));
    assert.notDeepEqual(h3ConfirmationFingerprintParams(segment, { ...params, h3FirstSteps: 8 }), h3ConfirmationFingerprintParams(segment, params));
    assert.equal(h3ConfirmationPhaseParams({}, params).latentConfirmationPhase, undefined);
});

test("disabled features cannot activate a dormant confirmation switch or decoded fallback", () => {
    const segment = { confirmationMode: true, latentUpscaleConfirmationMode: true };
    const ordinary = { latentUpscaleEnabled: false, faceRefineEnabled: false, rtxEnabled: true };
    assert.equal(h3ConfirmationKind(segment, ordinary), null);
    assert.deepEqual(h3ConfirmationPhaseParams(segment, ordinary), ordinary);
    assert.throws(() => h3ConfirmationPhaseParams(segment, ordinary, true), /不匹配/);
    assert.equal(h3ConfirmationKind({ confirmationMode: true }, { latentUpscaleEnabled: true, faceRefineEnabled: true }), null, "精修确认不能启动潜空间确认");
    assert.equal(h3ConfirmationKind(segment, { latentUpscaleEnabled: false, faceRefineEnabled: true }), "face");
    assert.equal(h3ConfirmationKind(segment, { latentUpscaleEnabled: true, faceRefineEnabled: false }), "latent");
});
