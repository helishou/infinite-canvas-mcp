import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubjectPictureBindingIds } from "@basketikun/canvas-agent/drama/production-contract";
import { keyframeSubjectSelectionFromPaths, setShotPictureBindingIds, setShotPictureBindingMode, shotPictureBindingMode, syncKeyframeSubjectsToShotUsages } from "./subject-picture-selection";

const subject = { id: "P", pictureBindings: [
    { id: "P_ID", defaultFor: ["identity"], applicableState: {}, provides: ["identity"] },
    { id: "P_OUTFIT", defaultFor: ["clothing"], applicableState: {}, provides: ["clothing"] },
] };

test("legacy and default modes continue to inherit purpose defaults", () => {
    const legacy = { presentation: "visible", referencePurpose: ["identity"], pictureBindingIds: [] };
    assert.equal(shotPictureBindingMode(legacy), "default");
    assert.deepEqual(resolveSubjectPictureBindingIds(subject, legacy).bindingIds, ["P_ID"]);
    assert.deepEqual(resolveSubjectPictureBindingIds(subject, { ...legacy, pictureBindingMode: "default" }).bindingIds, ["P_ID"]);
});

test("switching to a custom selection starts from current defaults and clearing it persists zero references", () => {
    const defaults = { presentation: "visible", referencePurpose: ["identity"], pictureBindingIds: [] };
    const custom = setShotPictureBindingMode(subject, defaults, "explicit");
    assert.deepEqual(custom.pictureBindingIds, ["P_ID"]);
    assert.equal(shotPictureBindingMode(custom), "explicit");

    const cleared = setShotPictureBindingIds(custom, []);
    assert.equal(shotPictureBindingMode(cleared), "explicit");
    assert.deepEqual(resolveSubjectPictureBindingIds(subject, cleared), { bindingIds: [], issues: [] });

    const reverted = setShotPictureBindingMode(subject, cleared, "default");
    assert.deepEqual(reverted.pictureBindingIds, []);
    assert.deepEqual(resolveSubjectPictureBindingIds(subject, reverted).bindingIds, ["P_ID"]);
});

test("legacy non-empty selections remain explicit and invalid IDs do not fall back to defaults", () => {
    const legacy = { presentation: "visible", referencePurpose: ["identity"], pictureBindingIds: ["P_OUTFIT"] };
    assert.equal(shotPictureBindingMode(legacy), "explicit");
    assert.deepEqual(resolveSubjectPictureBindingIds(subject, legacy).bindingIds, ["P_OUTFIT"]);
    assert.ok(resolveSubjectPictureBindingIds(subject, { ...legacy, pictureBindingMode: "explicit", pictureBindingIds: ["MISSING"] }).issues.length);
});

const actor = { id: "ACTOR", pictureBindings: [
    { id: "IDENTITY", provides: ["identity"] },
    { id: "COAT", provides: ["clothing"] },
    { id: "ROBE", provides: ["clothing"] },
] };

test("saving keyframe references adds missing Shot Subjects and transfers selected outfits", () => {
    const usages = [{ subjectId: "ACTOR", presentation: "offscreen_voice", pictureBindingMode: "explicit", pictureBindingIds: ["IDENTITY", "ROBE"], referencePurpose: ["identity"], continuityFactIds: [], stateRequirements: [] }];
    const result = syncKeyframeSubjectsToShotUsages(usages, [
        { subjectIds: ["ACTOR", "PROP"], subjectPictureBindingIds: { ACTOR: ["COAT"] } },
    ], [actor, { id: "PROP", pictureBindings: [] }]);

    assert.deepEqual(result.map(usage => usage.subjectId), ["ACTOR", "PROP"]);
    assert.deepEqual(result[0].pictureBindingIds, ["IDENTITY", "COAT"]);
    assert.equal(result[0].presentation, "visible");
    assert.equal(result[1].presentation, "visible");
    assert.deepEqual(usages[0].pictureBindingIds, ["IDENTITY", "ROBE"]);
});

test("keyframes without an explicit outfit choice preserve existing Shot outfits", () => {
    const usage = { subjectId: "ACTOR", presentation: "visible", pictureBindingIds: ["IDENTITY", "ROBE"] };
    const result = syncKeyframeSubjectsToShotUsages([usage], [{ subjectIds: ["ACTOR"] }], [actor]);
    assert.deepEqual(result[0].pictureBindingIds, ["IDENTITY", "ROBE"]);
});

test("Cascader leaf paths retain Subjects with no outfit and selected outfit bindings", () => {
    assert.deepEqual(keyframeSubjectSelectionFromPaths([
        ["ACTOR", "__default__"],
        ["OTHER_ACTOR", "OUTFIT_A"],
    ]), {
        subjectIds: ["ACTOR", "OTHER_ACTOR"],
        subjectPictureBindingIds: { ACTOR: [], OTHER_ACTOR: ["OUTFIT_A"] },
    });
});
