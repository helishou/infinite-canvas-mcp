import assert from "node:assert/strict";
import test from "node:test";
import { commandNeedsRecovery, commandFailureStatus, normalizeCommandRecovery, commandErrorSummary, commandFailureRecord } from "./production-command-recovery";

test("confirmed validation failures preserve the record without blocking another submission", () => {
    const command = { status: "rejected" as const, httpStatus: 400, error: "Choose an execution profile", ops: [{ type: "repartition_director_clips" }] };
    const restored = JSON.parse(JSON.stringify(command));
    assert.equal(commandNeedsRecovery(restored), false);
    assert.deepEqual(restored, command);
    assert.equal(commandNeedsRecovery({ status: "rejected", error: "Backend POST /production/ops failed: HTTP 400 segments.0.executionProfileSourceId: choose a profile" }), false);
    assert.equal(commandNeedsRecovery({ status: "rejected", httpStatus: 422 }), false);
});

test("version conflicts and uncertain outcomes retain their recovery guard", () => {
    assert.equal(commandNeedsRecovery({ status: "rejected", httpStatus: 409 }), true);
    assert.equal(commandNeedsRecovery({ status: "rejected", error: "Backend POST failed: HTTP 409 REVISION_CONFLICT" }), true);
    assert.equal(commandNeedsRecovery({ status: "rejected", httpStatus: 400, errorCode: "REVISION_CONFLICT" }), true);
    assert.equal(commandNeedsRecovery({ status: "unknown", httpStatus: 0 }), true);
    assert.equal(commandNeedsRecovery({ status: "unknown", httpStatus: 502 }), true);
    assert.equal(commandNeedsRecovery({ status: "unknown", httpStatus: 408 }), true);
    assert.equal(commandNeedsRecovery({ status: "rejected", error: "Unknown legacy failure" }), true);
    assert.equal(commandNeedsRecovery(null), false);
});


test("confirmed unsupported 501 commands retain the draft and request but do not lock later edits", () => {
    for (const record of [
        { status: "rejected" as const, httpStatus: 501, error: "Unsupported write" },
        { status: "rejected" as const, error: "Backend POST /production/ops failed: HTTP 501 Preview is read-only" },
    ]) {
        const persisted = { ...record, operationId: "original-operation", ops: [{ type: "edit_director_continuity", reason: "Keep my edit" }] };
        const restored = normalizeCommandRecovery(JSON.parse(JSON.stringify(persisted)));
        assert.equal(restored.status, "rejected");
        assert.equal(commandNeedsRecovery(persisted), false);
        assert.equal(commandNeedsRecovery(restored), false);
        assert.equal(restored.operationId, persisted.operationId);
        assert.deepEqual(restored.ops, persisted.ops);
        assert.equal(restored.error, persisted.error);
    }
    assert.equal(commandFailureStatus(501), "rejected");
});

test("server, gateway, timeout, network and malformed receipts stay unknown", () => {
    for (const httpStatus of [500, 502, 503, 504, 507, 408, 0]) {
        const record = { status: commandFailureStatus(httpStatus), httpStatus, operationId: "original-operation" };
        assert.equal(record.status, "unknown", String(httpStatus));
        assert.equal(normalizeCommandRecovery(record), record);
        assert.equal(commandNeedsRecovery(record), true);
    }
    assert.equal(commandFailureStatus(409), "rejected");
    assert.equal(commandNeedsRecovery({ status: commandFailureStatus(409), httpStatus: 409 }), true);
    assert.equal(commandNeedsRecovery({ status: "unknown", error: "Malformed receipt" }), true);
});

test("user explanations omit HTTP routes while the original error remains intact", () => {
    const error = "Backend POST /production/canvas/private-id/ops failed: HTTP 501 Preview does not support saving";
    const record = { error };
    assert.equal(commandErrorSummary(record), "Preview does not support saving");
    assert.equal(record.error, error);
    assert.equal(commandErrorSummary({ error, errorSummary: "Authoritative server explanation" }), "Authoritative server explanation");
    assert.equal(commandErrorSummary({ error: "Backend POST /ops failed: HTTP 502" }), "");
    assert.equal(commandErrorSummary({ error: "无法连接 Backend：POST /ops → https://private.example（Failed to fetch）。" }), "");
    assert.equal(commandErrorSummary({ error: "A shot needs a title" }), "A shot needs a title");
});


test("501 during recovery never clears the original unknown outcome", () => {
    const failure = { httpStatus: 501, error: "Backend POST /ops failed: HTTP 501 Recovery unavailable", errorSummary: "Recovery unavailable" };
    for (const original of [
        { status: "unknown" as const, httpStatus: 500, error: "Original server failure" },
        { status: "unknown" as const, httpStatus: 0, error: "Original network failure" },
        { status: "unknown" as const },
        { status: "unknown" as const, httpStatus: 501, error: "Legacy unknown 501, submission history is unavailable" },
    ]) {
        const persisted = { ...original, operationId: "keep-original-operation", ops: [{ reason: "Keep my draft" }] };
        const restored = normalizeCommandRecovery(JSON.parse(JSON.stringify(persisted)));
        assert.equal(restored.status, "unknown");
        assert.equal(commandNeedsRecovery(restored), true);
        const result = commandFailureRecord(restored, failure, true);
        assert.equal(result.status, "unknown");
        assert.equal(commandNeedsRecovery(result), true);
        assert.equal(result.operationId, persisted.operationId);
        assert.deepEqual(result.ops, persisted.ops);
        if (original.error) assert.ok(result.error!.startsWith(original.error));
    }
    const first = commandFailureRecord({ status: "unknown" as const, operationId: "new-operation" }, failure, false);
    assert.equal(first.status, "rejected");
    assert.equal(commandNeedsRecovery(first), false);
});
