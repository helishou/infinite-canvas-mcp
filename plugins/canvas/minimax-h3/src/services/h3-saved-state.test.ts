import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { resolveH3Runtime } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { segmentsFor } from "../hooks/useH3Segments";
import { patchSelectedSegment } from "./h3-segment-utils";
import { readDefaultParams, setDefaultParamsCache, clearDefaultParams } from "./h3-defaults";

test("timeline rendering does not manufacture persisted model or sampling overrides", () => {
    const raw = { id: "b", duration: 5, prompt: "saved", h3ParameterPolicy: "defaults", videoSteps: 99 };
    const metadata = { segments: [raw], modelName: "node-model", noDub: false };
    const displayed = segmentsFor(metadata)[0];
    assert.equal(displayed.videoSteps, 99);
    for (const key of ["modelName", "noiseSeedMode", "seed", "noDub", "megapixels", "loraName", "loraSlots"]) assert.equal(Object.hasOwn(displayed, key), false, key);
    const params = resolveH3Runtime(displayed, {}, metadata, { videoSteps: 12, modelName: "default-model" }).params;
    assert.equal(params.steps, 12);
    assert.equal(params.modelName, "default-model");
    assert.equal(raw.videoSteps, 99);
});

test("timeline mode aliases agree with the Backend instead of silently displaying reference mode", () => {
    for (const mode of ["t2va", "i2va", "fl2va", "l2va", "ref2v"]) {
        const raw = { id: "clip", mode, duration: 5 };
        const displayed = segmentsFor({ segments: [raw] })[0];
        assert.equal(displayed.mode, resolveH3Runtime(raw, {}, {}, {}).params.mode);
        assert.equal(raw.mode, mode);
    }
});

test("explicit edit target wins over a changed selection and leaves unedited saved fields untouched", () => {
    const first = { id: "a", duration: 5, prompt: "first", status: "success", result: "old.mp4" };
    const second = { id: "b", duration: 5, prompt: "second", h3ParameterPolicy: "defaults", videoSteps: 99, motionContextEnabled: true };
    let metadata: Record<string, unknown> = { selectedSegmentId: "a", segments: [first, second], modelName: "node-model" };
    const ctx = { node: { id: "h3" }, getNode: () => ({ metadata }), updateMetadata: (patch: Record<string, unknown>) => { metadata = { ...metadata, ...patch }; } } as unknown as CanvasNodeContext;
    patchSelectedSegment(ctx, { selectedSegmentId: "b" }, { tailFrameContinuation: true });
    const saved = JSON.parse(JSON.stringify(metadata)).segments;
    assert.deepEqual(saved[0], first);
    assert.deepEqual(saved[1], { ...second, tailFrameContinuation: true, motionContextEnabled: false, h3ParameterOverrides: ["tailFrameContinuation", "motionContextEnabled"] });
    const params = resolveH3Runtime(saved[1], {}, metadata, { videoSteps: 12 }).params;
    assert.equal(params.steps, 12);
    assert.equal(params.motionContextEnabled, false);
    assert.throws(() => patchSelectedSegment(ctx, { selectedSegmentId: "deleted" }, { noDub: true }), /不存在/);
});

test("default snapshot retains explicit false, zero and null, strips layout and remains stable until changed", () => {
    setDefaultParamsCache({ noDub: false, denoise: 0, styleTemplateId: null, layout: { width: 3000 } });
    const before = readDefaultParams();
    assert.equal(before, readDefaultParams());
    assert.deepEqual(before, { noDub: false, denoise: 0, styleTemplateId: null });
    setDefaultParamsCache({ noDub: true });
    assert.notEqual(before, readDefaultParams());
    assert.equal(readDefaultParams().noDub, true);
    clearDefaultParams();
    assert.deepEqual(readDefaultParams(), {});
});
