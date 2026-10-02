import assert from "node:assert/strict";
import test from "node:test";
import { recoverCompactedCanvasReceipt } from "./canvas-compacted-receipt";

const compacted = { status: 409, details: { code: "RECEIPT_UNAVAILABLE", committed: true, revision: 2, snapshotAvailable: false } };
test("a compacted committed envelope refreshes to a newer project without resubmission", async () => {
    const latest = { id: "p", revision: 5 };
    assert.equal(await recoverCompactedCanvasReceipt(compacted, "p", async () => latest), latest);
});
test("old Backend errors and hash conflicts do not acknowledge an uncertain command", async () => {
    for (const error of [{ status: 409, details: { code: "RECEIPT_UNAVAILABLE" } }, { ...compacted, details: { ...compacted.details, code: "OPERATION_ID_REUSED" } }]) {
        assert.equal(await recoverCompactedCanvasReceipt(error, "p", async () => { throw new Error("must not fetch"); }), null);
    }
});
test("stale, wrong-project and failed refreshes preserve the command rather than becoming deterministic rejections", async () => {
    for (const latest of [{ id: "p", revision: 1 }, { id: "other", revision: 4 }]) await assert.rejects(recoverCompactedCanvasReceipt(compacted, "p", async () => latest), /原命令仍保留/);
    await assert.rejects(recoverCompactedCanvasReceipt(compacted, "p", async () => { throw { status: 404 }; }), (error: Error) => error instanceof Error && !("status" in error));
});
