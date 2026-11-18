import assert from "node:assert/strict";
import test from "node:test";

import { auditContinuityFactBindings } from "./continuity-binding.js";

function source(bindings: { usage?: string[]; shot?: string[]; kind?: string } = {}) {
    return {
        ledger: {
            contract_version: 2,
            facts: [{ id: "F1", object_kind: "character", object_id: "C1" }],
            coverage: [{ id: "COV1", evidence_kind: bindings.kind ?? "explicit_hold", shot_ids: ["S1"], fact_ids: ["F1"] }],
        },
        subject_registry: [{ id: "SUB1", entityRef: { kind: "character", id: "C1" } }],
        segments: [{ id: "CLIP1", shot_ids: ["S1"] }],
        shots: [{ id: "S1", continuity_facts: bindings.shot ?? [], subject_usages: [{ subjectId: "SUB1", continuityFactIds: bindings.usage ?? [] }] }],
    };
}

test("账本登记的事实没勾选时给出可定位诊断", () => {
    const issues = auditContinuityFactBindings(source());
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "CONTINUITY_FACT_NOT_SELECTED");
    assert.deepEqual(issues[0].affectedTargets, ["CLIP1"]);
    assert.match(issues[0].message, /S1\(F1\)/);
});

test("主体 usage 勾选或镜头级事实任一命中就算已打开", () => {
    assert.equal(auditContinuityFactBindings(source({ usage: ["F1"] })).length, 0);
    assert.equal(auditContinuityFactBindings(source({ shot: ["F1"] })).length, 0);
});

test("不适用规则和本镜没有对应主体的事实不产生诊断", () => {
    assert.equal(auditContinuityFactBindings(source({ kind: "not_applicable_with_rule" })).length, 0);
    const noSubject = source();
    (noSubject.shots[0].subject_usages as unknown[]).length = 0;
    assert.equal(auditContinuityFactBindings(noSubject).length, 0);
});
