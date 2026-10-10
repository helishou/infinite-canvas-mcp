import assert from "node:assert/strict";
import test from "node:test";
import { draftFieldConflicts, mergeDraftFields } from "./draft-field-merge";
test("picture-use edits retain independent server fields and keep explicit deletions", () => {
    const base = { provides: ["identity"], retain: ["脸"], exclude: ["姿势"], applicableState: { injury: "none" } };
    const local = { ...base, retain: ["正侧脸"] };
    const remote = { ...base, exclude: ["姿势", "背景"] };
    assert.deepEqual(draftFieldConflicts(base, local, remote), []);
    assert.deepEqual(mergeDraftFields(base, local, remote), { ...remote, retain: local.retain });
    assert.deepEqual(draftFieldConflicts(base, local, { ...remote, retain: ["服装"] }), ["retain"]);
    assert.deepEqual(mergeDraftFields({ camera: { lens: 35, path: "静止" } }, { camera: { path: "静止" } }, { camera: { lens: 35, path: "缓推" } }), { camera: { path: "缓推" } });
});
