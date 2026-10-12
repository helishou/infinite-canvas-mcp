import test from "node:test";
import assert from "node:assert/strict";
import { matchesProductionEntityTarget, subjectPictureNavigation } from "./subject-picture-navigation";

const entity = { projectId: "episode", nodeId: "subject" };
test("unbound and incomplete picture sources retain the separate Subject material action", () => {
    assert.deepEqual(subjectPictureNavigation([], entity), { pictures: [], entitySource: entity });
    assert.deepEqual(subjectPictureNavigation([{}, { sourceNode: { projectId: "episode" } }], entity), { pictures: [undefined, undefined], entitySource: entity });
});
test("a picture and Subject pointing to the same actual node share one labelled action", () => {
    assert.deepEqual(subjectPictureNavigation([{ sourceNode: entity }], entity), { pictures: [{ sourceNode: entity, isEntity: true }], entitySource: undefined });
});
test("different picture and material targets retain both actions, including across canvases", () => {
    const source = { projectId: "shared", nodeId: "subject" };
    assert.deepEqual(subjectPictureNavigation([{ sourceNode: source }], entity), { pictures: [{ sourceNode: source, isEntity: false }], entitySource: entity });
});
test("multiple references deduplicate only identical canvas/node navigation, not the bindings", () => {
    const other = { projectId: "episode", nodeId: "other" };
    const bindings = [{ sourceNode: entity }, { sourceNode: other }, { sourceNode: { ...entity } }];
    const result = subjectPictureNavigation(bindings, entity);
    assert.equal(bindings.length, 3);
    assert.deepEqual(result.pictures, [{ sourceNode: entity, isEntity: true }, { sourceNode: other, isEntity: false }, undefined]);
    assert.equal(result.entitySource, undefined);
});
test("a missing material node is not replaced with an unrelated picture target", () => {
    assert.equal(subjectPictureNavigation([{ sourceNode: entity }]).pictures[0]?.isEntity, false);
    assert.equal(subjectPictureNavigation([{ sourceNode: entity }]).entitySource, undefined);
});

test("an archived binding whose local node was removed has no stale navigation", () => {
    const binding = { sourceNode: { projectId: "episode", nodeId: "removed" }, assetId: "archived", selection: { mode: "selected_result", resultId: "result" } };
    assert.deepEqual(subjectPictureNavigation([binding], entity, { id: "episode", nodeIds: ["subject"] }), { pictures: [undefined], entitySource: entity });
    assert.equal(binding.sourceNode.nodeId, "removed");
});
test("unloaded shared sources keep their distinct navigation when local nodes are empty", () => {
    const shared = { projectId: "shared", nodeId: "picture" };
    assert.deepEqual(subjectPictureNavigation([{ sourceNode: shared }], undefined, { id: "episode", nodeIds: [] }).pictures, [{ sourceNode: shared, isEntity: false }]);
});

test("material preparation and navigation require the same complete entity ownership", () => {
    const target = { ownerKind: "episode", ownerId: "one", entityId: "subject", kind: "character" };
    assert.equal(matchesProductionEntityTarget(target, target), true);
    for (const field of ["ownerKind", "ownerId", "entityId", "kind"] as const) assert.equal(matchesProductionEntityTarget({ ...target, [field]: "other" }, target), false);
    assert.equal(matchesProductionEntityTarget(undefined, target), false);
});
