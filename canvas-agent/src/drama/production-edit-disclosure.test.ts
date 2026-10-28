import test from "node:test";
import assert from "node:assert/strict";
import { compactProductionEditSchema, compactEditOperationForIssue } from "./production-edit-disclosure.js";
import { productionToolSchemas } from "./production-tools.js";
import { productionOperationSchema } from "./production-contract.js";
import { productionOperationContract } from "./production-validation.js";

const base = { kind: "episode", id: "e", operationId: "stable", expectedRevision: 0 };

test("compact disclosure derives every operation and retains request identities and scalar constraints", () => {
    assert.deepEqual(compactProductionEditSchema.shape.ops.element.options.map(operation => operation.shape.type.value), productionOperationSchema.options.map(operation => operation.shape.type.value));
    for (const key of ["kind", "id", "operationId", "expectedRevision", "adoptions"] as const) assert.equal(compactProductionEditSchema.shape[key], productionToolSchemas.production_edit.shape[key]);
    const request = { ...base, ops: [{ type: "set_director_brief", brief: "保留原文" }] };
    assert.deepEqual(compactProductionEditSchema.parse(request), productionToolSchemas.production_edit.parse(request));
    for (const raw of [
        { ...request, extra: true }, { ...request, expectedRevision: -1 }, { ...base, ops: [] },
        { ...base, ops: [{ type: "invented" }] }, { ...base, ops: [{ type: "set_director_brief" }] },
        { ...base, ops: [{ type: "set_director_brief", brief: 4 }] }, { ...base, ops: [{ type: "set_director_brief", brief: "valid", extra: true }] },
        { ...base, ops: [{ type: "set_settings" }] }, { ...base, ops: [{ type: "set_settings", patch: [] }] },
    ]) assert.equal(compactProductionEditSchema.safeParse(raw).success, false);
});

test("compact containers preserve nested input while authoritative validation still rejects it", () => {
    const raw = { ...base, ops: [{ type: "set_director_production", director: { source: { nested: [{ keepFalse: false, keepZero: 0, keepNull: null }] } } }] };
    assert.deepEqual(compactProductionEditSchema.parse(raw), raw, "disclosure must never strip unlisted nested fields");
    assert.equal(productionToolSchemas.production_edit.safeParse(raw).success, false);
    const invalid = { ...base, ops: [{ type: "set_settings", patch: { parallelScenes: "invalid-boolean" } }] };
    assert.equal(compactProductionEditSchema.safeParse(invalid).success, true);
    assert.equal(productionToolSchemas.production_edit.safeParse(invalid).success, false);
    assert.equal(compactEditOperationForIssue(invalid, ["ops", 0, "patch"]), "set_settings");
    assert.equal(compactEditOperationForIssue({ ops: [{ type: "invented" }] }, ["ops", 0, "patch"]), undefined);
});

test("every canonical operation example survives compact disclosure without changing its final validated value", () => {
    for (const operation of productionOperationContract().operations) {
        const request = { ...base, ops: [operation.example] };
        assert.deepEqual(productionToolSchemas.production_edit.parse(compactProductionEditSchema.parse(request)), productionToolSchemas.production_edit.parse(request), operation.type);
    }
});
