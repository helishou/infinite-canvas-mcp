import assert from "node:assert/strict";
import test from "node:test";
import { normalizeH3Params, resolveH3Runtime, withH3ParameterEdits } from "./runtime-params.js";

test("global defaults cannot enable continuation, while authored per-Clip choices remain effective", () => {
    const defaults = { motionContextEnabled: true, tailFrameContinuation: true };
    const fresh = resolveH3Runtime({}, {}, {}, defaults);
    assert.equal(fresh.params.motionContextEnabled, false);
    assert.equal(fresh.params.tailFrameContinuation, false);
    assert.equal(resolveH3Runtime({ motionContextEnabled: true }, {}, {}, defaults).params.motionContextEnabled, true);
});

test("conflicting saved switches stay visible and are diagnosed instead of hidden", () => {
    const clip = { tailFrameContinuation: true, motionContextEnabled: true };
    const { params, parameterIssues } = resolveH3Runtime(clip, {}, {}, {});
    assert.equal(params.tailFrameContinuation, true);
    assert.equal(params.motionContextEnabled, true);
    assert.ok(parameterIssues.some(issue => issue.includes('保存值同时开启')));
    assert.deepEqual(clip, { tailFrameContinuation: true, motionContextEnabled: true });
    assert.equal(normalizeH3Params(clip).motionContextEnabled, true);
});

test("saved companion false prevents inherited defaults from reopening motion", () => {
    for (const defaults of [{ motionContextEnabled: true }, { motionContextEnabled: true, tailFrameContinuation: true }]) {
        const params = resolveH3Runtime(withH3ParameterEdits({}, { tailFrameContinuation: true }), {}, {}, defaults).params;
        assert.equal(params.tailFrameContinuation, true);
        assert.equal(params.motionContextEnabled, false);
    }
});

test("manual continuation edits persist the opposite false under default policy", () => {
    const clip = { h3ParameterPolicy: "defaults", tailFrameContinuation: true, motionContextEnabled: true };
    for (const key of ["motionContextEnabled", "tailFrameContinuation"]) {
        const other = key === "motionContextEnabled" ? "tailFrameContinuation" : "motionContextEnabled";
        const patch = withH3ParameterEdits(clip, { [key]: true });
        assert.equal(patch[other], false);
        assert.deepEqual(new Set(patch.h3ParameterOverrides as string[]), new Set([key, other]));
        const params = resolveH3Runtime({ ...clip, ...patch }, {}, {}, { [other]: true }).params;
        assert.equal(params[key], true);
        assert.equal(params[other], false);
    }
    assert.deepEqual(withH3ParameterEdits({}, { motionContextEnabled: false }), { motionContextEnabled: false, h3ParameterOverrides: ["motionContextEnabled"] });
});
