import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubjectPictureBindingIds } from "./production-contract.js";

test("legacy scene pictures resolve environment without rewriting authored data or bypassing selection gates", () => {
    const subject = { id: "YARD", entityRef: { kind: "scene" }, pictureBindings: [
        { id: "PB", provides: ["scene"], defaultFor: [] as string[], applicableState: {} as Record<string, string> },
    ] };
    const usage = { presentation: "visible", referencePurpose: ["environment"], pictureBindingIds: [], pictureBindingMode: "default" };
    const before = structuredClone(subject);
    assert.deepEqual(resolveSubjectPictureBindingIds(subject, usage), { bindingIds: ["PB"], issues: [] });
    assert.deepEqual(resolveSubjectPictureBindingIds(subject, { ...usage, presentation: "state_context" }).bindingIds, ["PB"]);
    assert.deepEqual(resolveSubjectPictureBindingIds(subject, { ...usage, pictureBindingMode: "explicit" }).bindingIds, []);
    assert.deepEqual(subject, before);
    subject.pictureBindings[0].applicableState = { weather: "dry" };
    assert.deepEqual(resolveSubjectPictureBindingIds(subject, usage).bindingIds, []);
    subject.pictureBindings[0].applicableState = {};
    subject.pictureBindings.push({ id: "NEW", provides: ["environment"], defaultFor: [], applicableState: {} });
    assert.deepEqual(resolveSubjectPictureBindingIds(subject, usage).bindingIds, ["NEW"]);
});
