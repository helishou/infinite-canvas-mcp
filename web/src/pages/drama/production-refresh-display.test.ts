import assert from "node:assert/strict";
import test from "node:test";
import { currentClipRefreshes, groupedRefreshIssues } from "./production-refresh-display";
const job = (segmentId: string, savedRevision: number, status = "blocked", sourceHash = "current") => ({ segmentId, savedRevision, status, sourceHash, blockingDiagnostic: { code: "MISSING_IMAGE", message: "缺少有效图片" } });
test("current diagnostics exclude archived targets, obsolete source and superseded results", () => {
    const jobs = [job("OLD", 20), job("C1", 3), job("C1", 5, "succeeded"), job("C2", 6, "blocked", "old-source"), job("C3", 7, "superseded")];
    const original = structuredClone(jobs);
    const current = currentClipRefreshes(jobs, ["C1", "C2", "C3"], "current");
    assert.deepEqual(current.map(item => [item.segmentId, item.status]), [["C1", "succeeded"]]);
    assert.deepEqual(groupedRefreshIssues(current), []);
    assert.deepEqual(jobs, original, "history stays intact");
});
test("one diagnostic shared by several current Clips appears once with all targets", () => {
    const jobs = [job("C1", 4), job("C2", 4), job("C1", 2)];
    assert.deepEqual(groupedRefreshIssues(currentClipRefreshes(jobs, ["C1", "C2"], "current")), [
        { code: "MISSING_IMAGE", message: "缺少有效图片", segmentIds: ["C1", "C2"] }
    ]);
});
