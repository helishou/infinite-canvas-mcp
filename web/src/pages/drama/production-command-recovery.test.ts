import assert from "node:assert/strict";
import test from "node:test";
import { commandNeedsRecovery } from "./production-command-recovery";

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
