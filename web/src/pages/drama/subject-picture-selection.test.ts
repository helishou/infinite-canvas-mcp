import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubjectPictureBindingIds } from "@basketikun/canvas-agent/drama/production-contract";
import { setShotPictureBindingIds, setShotPictureBindingMode, shotPictureBindingMode } from "./subject-picture-selection";

const subject = { id: "P", pictureBindings: [
    { id: "P_ID", defaultFor: ["identity"], applicableState: {} },
    { id: "P_OUTFIT", defaultFor: ["clothing"], applicableState: {} },
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
    assert.equal(cleared.pictureBindingMode, "explicit");
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
