import test from "node:test";
import assert from "node:assert/strict";
import { BackendDatabase } from "./db.js";
import { observeReadRequest, observeReadResult, observeTaskReadResult } from "./mcp-read-observation.js";

test("read fingerprints separate target, scope and pages without retaining private text", () => {
    const input = { kind: "episode", id: "private-owner", sourceSection: "shots", targetIds: ["private-shot"], cursor: "private-cursor" };
    const a = observeReadRequest("production_get_source", input);
    const b = observeReadRequest("production_get_source", { ...input, cursor: "other-cursor" });
    assert.equal(a.readScopeFingerprint, b.readScopeFingerprint);
    assert.notEqual(a.requestFingerprint, b.requestFingerprint);
    assert.ok(!JSON.stringify(a).includes("private"));
    assert.notEqual(a.readScopeFingerprint, observeReadRequest("production_get_source", { ...input, targetIds: ["other-shot"] }).readScopeFingerprint);
    assert.deepEqual(observeReadRequest("h3_get_clip", { segmentId: "s", include: ["result"] }), {});
    assert.deepEqual(observeReadRequest("h3_get_clip_runtime", { segmentId: "s" }), {});
    assert.deepEqual(observeReadRequest("production_get_source", { ...input, unknownArgument: "changed invalid value" }), {});
    assert.deepEqual(observeReadRequest("production_edit", { kind: "episode", id: "e" }), {});
});

test("efficiency report excludes pagination, unchanged, dynamic reads, new targets and schema changes", t => {
    const db = new BackendDatabase(":memory:"); t.after(() => db.close());
    let index = 0;
    const input = { kind: "episode", id: "e", sourceSection: "shots", targetIds: ["s"] };
    const record = (tool: string, args: Record<string, unknown>, result: unknown, schemaHash = "schema-1", errorCode?: string) => db.createMcpObservabilityEvent({
        sessionId: "same-session", traceId: `trace-${index++}`, tool, event: errorCode ? "tool.failed" : "tool.succeeded", errorCode,
        inputSummary: { ...observeReadRequest(tool, args), schemaHash, inputBytes: 100, inputChars: 90 },
        outputSummary: { ...observeReadResult(tool, args, result), ...observeTaskReadResult(tool, args, result), outputBytes: 200, outputChars: 160 },
    });
    const source = { revision: 1, sourceHash: "a".repeat(64), source: { items: [{ id: "s" }], nextCursor: null } };
    record("production_get_source", input, source);
    record("production_get_source", input, source);
    record("production_get_source", { ...input, targetIds: ["another"] }, source);
    record("production_get_source", input, { ...source, sourceHash: "b".repeat(64), revision: 2 });
    record("production_get_source", input, source, "schema-2");
    record("production_get_source", { ...input, ifRevision: 1 }, { revision: 1, unchanged: true });
    record("production_get_source", input, { ...source, source: { items: [], nextCursor: "next" } });
    record("production_get_source", { ...input, cursor: "next" }, source);
    record("production_get_source", { ...input, cursor: "next" }, source);
    const historyPage = { version: { version: 1, sha256: "c".repeat(64), snapshot: { revision: 1, source: { items: [{ id: "s" }], nextCursor: "next" } } } };
    record("production_get_version_source", { ...input, version: 1 }, historyPage);
    record("production_get_version_source", { ...input, version: 1 }, historyPage);
    record("canvas_get_state", { projectId: "p", nodeIds: ["n"], projection: "summary" }, { revision: 3, nodes: [] });
    record("canvas_get_state", { projectId: "p", nodeIds: ["n"], projection: "summary" }, { revision: 3, nodes: [] });
    record("canvas_get_state", { projectId: "p", nodeIds: ["n"], projection: "media" }, { revision: 3, nodes: [] });
    record("h3_get_clip", { projectId: "p", segmentId: "s", include: ["result"] }, { revision: 1 });
    record("h3_get_clip", { projectId: "p", segmentId: "s", include: ["result"] }, { revision: 1 });
    record("production_get_source", input, {}, "schema-1", "INVALID_INPUT");
    record("production_get_source", input, {}, "schema-1", "INVALID_INPUT");
    record("production_get_source", { ...input, sourceSection: "segments" }, {}, "schema-1", "INVALID_INPUT");
    for (const status of ["running", "running", "awaiting_confirmation", "awaiting_confirmation", "succeeded", "succeeded"]) record("canvas_task_status", { taskId: "original-task" }, { tasks: [{ taskId: "original-task", status }] });
    const report = db.getMcpObservabilityReport({ view: "full" });
    assert.equal(report.efficiency.sameContentCandidates, 1);
    assert.equal(report.efficiency.sameVersionCandidates, 1);
    assert.equal(report.efficiency.failedReadRetryCandidates, 1);
    assert.equal(report.efficiency.terminalTaskReadCandidates, 1);
    assert.equal(report.payload.totalInputBytes, index * 100);
    assert.equal(report.payload.totalOutputBytes, index * 200);
    assert.equal(report.byTool.find(row => row.tool === "production_get_source")!.estimatedMaxOutputTokens, 40);
    assert.ok(report.byTool.find(row => row.tool === "production_get_source")!.estimatedTotalOutputTokens! > 40);
    assert.equal(db.getMcpObservabilityReport({ tool: "canvas_get_state" }).efficiency.sameContentCandidates, 0);
    assert.equal(db.getMcpObservabilityReport().efficiency.byTool, undefined);
    const history = new BackendDatabase(":memory:"); t.after(() => history.close());
    history.createMcpObservabilityEvent({ sessionId: "old", traceId: "old", tool: "legacy", event: "tool.succeeded" });
    assert.equal(history.getMcpObservabilityReport().payload.totalOutputBytes, null);
    assert.equal(history.getMcpObservabilityReport().efficiency.measuredReadCalls, 0);
});
