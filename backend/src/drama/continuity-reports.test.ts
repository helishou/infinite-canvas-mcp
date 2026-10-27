import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { continuityTargetBlockers, ProductionContinuityReports } from "./continuity-reports.js";
import { BackendDatabase } from "../db.js";

test("H3 consumers share fresh, target-scoped continuity readiness", () => {
    const result = { status: "blocked", sourceHash: "a".repeat(64), runtime: { runtimeId: "runtime-v2" }, report: { stale: false, sourceHash: "a".repeat(64), runtimeId: "runtime-v2", selectedTargets: ["SEG01", "SEG02"], diagnostics: [
        { code: "ISSUE_ONE", message: "SEG01 needs repair", severity: "error", affectedTargets: ["SEG01"] },
        { code: "ISSUE_TWO", message: "unscoped issue", severity: "error", affectedTargets: [] },
        { code: "NOTE", message: "non-blocking note", severity: "warning", affectedTargets: ["SEG02"] },
    ] } };
    const scoped = { ...result, report: { ...result.report, diagnostics: result.report.diagnostics.filter(item => item.code !== "ISSUE_TWO") } };
    assert.deepEqual(continuityTargetBlockers(scoped, ["SEG02"]), []);
    assert.deepEqual(continuityTargetBlockers(result, ["SEG02"]), [{ code: "CONTINUITY_BLOCKED", message: "ISSUE_TWO: unscoped issue" }]);
    assert.deepEqual(continuityTargetBlockers(result, ["SEG01"]), [
        { code: "CONTINUITY_BLOCKED", message: "ISSUE_ONE: SEG01 needs repair", targetId: "SEG01" },
        { code: "CONTINUITY_BLOCKED", message: "ISSUE_TWO: unscoped issue" },
    ]);
    assert.equal(continuityTargetBlockers(result, ["SEG03"])[0].code, "CONTINUITY_SCOPE_INCOMPLETE");
    assert.equal(continuityTargetBlockers({ ...result, status: "stale" }, ["SEG01"])[0].code, "CONTINUITY_REPORT_REQUIRED");
    assert.equal(continuityTargetBlockers({ ...result, sourceHash: "b".repeat(64) }, ["SEG01"])[0].code, "CONTINUITY_REPORT_REQUIRED");
});

test("continuity reports are source/runtime scoped and old reports remain diagnostic history", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-report-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const reports = new ProductionContinuityReports(root);
    const owner = { kind: "episode", id: "episode-test" };
    const report = { owner, snapshot: "draft", sourceHash: "a".repeat(64), runtimeId: "runtime-v2", snapshotVersion: 3, verdict: "passed", selectedTargets: ["SEG01"], checkedAt: "2026-10-06T00:00:00.000Z", diagnostics: [], trajectories: { SH01: { timelineId: "main", storyOrder: 0, start: {}, end: {} } } };
    reports.persist(owner, "check-1", "request-1", report);

    const fresh = reports.get(owner, "draft", { sourceHash: "a".repeat(64), runtimeId: "runtime-v2" }, "summary");
    assert.equal(fresh.status, "passed");
    assert.equal(reports.operation(owner, "check-1").requestHash, "request-1");

    const changedSource = reports.get(owner, "draft", { sourceHash: "b".repeat(64), runtimeId: "runtime-v2" }, "summary");
    assert.equal(changedSource.status, "stale");
    assert.equal(changedSource.report.stale, true);
    const changedRuntime = reports.get(owner, "draft", { sourceHash: "a".repeat(64), runtimeId: "runtime-v3" }, "summary");
    assert.equal(changedRuntime.status, "stale");
});

test("continuity report cursors cannot be reused for a different source version", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-cursor-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const reports = new ProductionContinuityReports(root);
    const owner = { kind: "canvas", id: "canvas-test" };
    reports.persist(owner, "check-1", "request-1", { owner, snapshot: "draft", sourceHash: "a".repeat(64), runtimeId: "runtime-v2", verdict: "blocked", checkedAt: "2026-10-06T00:00:00.000Z", diagnostics: [{ code: "ONE" }, { code: "TWO" }], trajectories: {} });
    const page = reports.get(owner, "draft", { sourceHash: "a".repeat(64), runtimeId: "runtime-v2" }, "issues", undefined, undefined, 1);
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
    assert.throws(() => reports.get(owner, "draft", { sourceHash: "b".repeat(64), runtimeId: "runtime-v2" }, "issues", undefined, undefined, 1, page.nextCursor!), /READ_CURSOR_EXPIRED/);
});

test("published continuity cursors are bound to the frozen snapshot version", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-published-cursor-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const reports = new ProductionContinuityReports(root);
    const owner = { kind: "episode", id: "published-cursor-test" };
    reports.persist(owner, "check-1", "request-1", { owner, snapshot: "published", snapshotVersion: 4, sourceHash: "a".repeat(64), runtimeId: "runtime-v2", verdict: "blocked", checkedAt: "2026-10-06T00:00:00.000Z", diagnostics: [{ code: "ONE" }, { code: "TWO" }], trajectories: {} });
    const page = reports.get(owner, "published", { sourceHash: "a".repeat(64), runtimeId: "runtime-v2", snapshotVersion: 4 }, "issues", undefined, undefined, 1);
    assert.ok(page.nextCursor);
    assert.throws(() => reports.get(owner, "published", { sourceHash: "a".repeat(64), runtimeId: "runtime-v2", snapshotVersion: 5 }, "issues", undefined, undefined, 1, page.nextCursor!), /READ_CURSOR_EXPIRED/);
});

test("database readiness lookup decodes only the matching report, not the owner's full history", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-report-db-"));
    const db = new BackendDatabase(path.join(root, "test.sqlite"));
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const reports = new ProductionContinuityReports(db);
    const owner = { kind: "episode", id: "db-history-test" };
    for (let i = 0; i < 40; i++) reports.persist(owner, `old-${i}`, `request-${i}`, {
        owner, snapshot: "draft", sourceHash: String(i).padStart(64, "a"), runtimeId: "runtime-v2",
        verdict: "stale-history", checkedAt: `2026-10-${String(1 + Math.floor(i / 24)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`, diagnostics: [],
    });
    reports.persist(owner, "current", "request-current", {
        owner, snapshot: "draft", sourceHash: "c".repeat(64), runtimeId: "runtime-v2",
        verdict: "passed", checkedAt: "2026-10-04T00:00:00.000Z", diagnostics: [],
    });
    db.db.prepare(`INSERT INTO production_continuity_reports
        (owner_kind,owner_id,operation_id,request_hash,snapshot,source_hash,runtime_id,checked_at,report_gzip,result_gzip,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(owner.kind, owner.id, "corrupt-current", "request-corrupt", "draft", "c".repeat(64), "runtime-v2",
        "2026-10-05T00:00:00.000Z", Buffer.from("bad-gzip"), Buffer.from("bad-gzip"), "2026-10-05T00:00:00.000Z");
    let decoded = 0;
    const decode = (reports as any).decode.bind(reports);
    (reports as any).decode = (value: unknown) => { decoded++; return decode(value); };

    const fresh = reports.get(owner, "draft", { sourceHash: "c".repeat(64), runtimeId: "runtime-v2" }, "summary");
    assert.equal(fresh.status, "passed");
    assert.equal(decoded, 2, "fresh readiness should skip a corrupt match and decode one valid report, not 42 history rows");

    decoded = 0;
    const stale = reports.get(owner, "draft", { sourceHash: "d".repeat(64), runtimeId: "runtime-v2" }, "summary");
    assert.equal(stale.status, "stale");
    assert.equal(stale.report.verdict, "passed", "stale fallback must remain the latest report overall");
    assert.equal(decoded, 2, "stale fallback skips the corrupt newest row, then decodes the latest valid history row");

    for (const version of [2, 3]) reports.persist(owner, `published-${version}`, `published-request-${version}`, {
        owner, snapshot: "published", sourceHash: "e".repeat(64), runtimeId: "runtime-v2", snapshotVersion: version,
        verdict: `published-${version}`, checkedAt: `2026-10-0${version}T00:00:00.000Z`, diagnostics: [],
    });
    decoded = 0;
    const published = reports.get(owner, "published", { sourceHash: "e".repeat(64), runtimeId: "runtime-v2", snapshotVersion: 2 }, "summary");
    assert.equal(published.status, "published-2", "published lookup must find the matching frozen snapshot, not just the newest row");
    assert.equal(decoded, 2, "published lookup decodes ordered same-source candidates only until the matching version");
});
