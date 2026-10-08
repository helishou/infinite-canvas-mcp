import test from "node:test";
import assert from "node:assert/strict";
import { continuityBoundaryDiagnostics, outgoingDirectorBoundary } from "./production-validation.js";
const source = (boundaries: any[]): any => ({ source: { segments: [{ id: "A" }, { id: "B" }, { id: "C" }] }, boundaries });

test("tail-frame and Motion Context are exclusive in validation and formal Clip projection", () => {
    for (const [tailFrame, motionContext] of [[false, false], [true, false], [false, true], [true, true]]) {
        const d = source([{ from: "A", to: "B", tailFrame, motionContext, reason: "Authored adjacent boundary" }, { from: "B", to: "C", tailFrame: false, motionContext: false, reason: "Cut" }]);
        if (tailFrame && motionContext) {
            const conflict = continuityBoundaryDiagnostics(d).find(item => item.code === "CONTINUITY_MODES_CONFLICT");
            assert.equal(conflict?.targetId, "A");
            assert.equal(conflict?.severity, "error");
            assert.match(conflict!.message, /A → B/);
            assert.equal(continuityBoundaryDiagnostics(d, "edit").find(item => item.code === "CONTINUITY_MODES_CONFLICT")?.severity, "warning");
            assert.throws(() => outgoingDirectorBoundary(d, "A"), /CONTINUITY_MODES_CONFLICT/);
        } else {
            assert.deepEqual(continuityBoundaryDiagnostics(d), []);
            assert.deepEqual(outgoingDirectorBoundary(d, "A"), d.boundaries[0]);
        }
    }
});
test("missing, duplicate and non-adjacent decisions block compilation instead of silently disabling continuation", () => {
    assert.ok(continuityBoundaryDiagnostics(source([])).some(d => d.code === "MISSING_CONTINUITY_BOUNDARY"));
    assert.throws(() => outgoingDirectorBoundary(source([]), "A"), /MISSING_CONTINUITY_DECISION/);
    assert.ok(continuityBoundaryDiagnostics(source([{ from: "A", to: "C", tailFrame: true, motionContext: true, reason: "wrong" }])).some(d => d.code === "NON_ADJACENT_CONTINUITY_BOUNDARY"));
    assert.equal(outgoingDirectorBoundary(source([]), "C"), undefined);
    assert.throws(() => outgoingDirectorBoundary(source([{ from: "A", to: "B", reason: "flags missing" }]), "A"), /MISSING_CONTINUITY_DECISION/);
    assert.ok(continuityBoundaryDiagnostics(source([]), "edit").every(d => d.severity === "warning"));
});
test("an all-cut dialogue sequence is valid without manufacturing continuation", () => {
    const template = [{ from: "A", to: "B", tailFrame: false, motionContext: false, reason: "independent cuts" }, { from: "B", to: "C", tailFrame: false, motionContext: false, reason: "independent cuts" }];
    assert.deepEqual(continuityBoundaryDiagnostics(source(template)), []);
    template[0].reason = "A to B skips to the following morning"; template[1].reason = "B to C moves from the yard into the bedroom";
    assert.deepEqual(continuityBoundaryDiagnostics(source(template)), []);
    template[0].tailFrame = true;
    assert.equal(outgoingDirectorBoundary(source(template), "A")?.motionContext, false);
});
