import assert from "node:assert/strict";
import test from "node:test";
import { commandNeedsRecovery } from "./production-command-recovery";

test("连不上服务器是确定的失败，不占用提交态", () => {
    // status 0 = fetch 抛错，请求根本没送达；不该弹出「回执待确认」并锁死提交。
    assert.equal(commandNeedsRecovery({ status: "unknown", httpStatus: 0 }), false);
    assert.equal(commandNeedsRecovery({ status: "unknown", httpStatus: 0, error: "无法连接 Backend：POST /production/ops → http://127.0.0.1:8787（TypeError: Failed to fetch）" }), false);
});

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
    assert.equal(commandNeedsRecovery({ status: "unknown", httpStatus: 502 }), true);
    assert.equal(commandNeedsRecovery({ status: "unknown", httpStatus: 408 }), true);
    assert.equal(commandNeedsRecovery({ status: "unknown", httpStatus: 500 }), true);
    assert.equal(commandNeedsRecovery({ status: "rejected", error: "Backend POST failed: HTTP 503 upstream unavailable" }), true);
    assert.equal(commandNeedsRecovery(null), false);
});
