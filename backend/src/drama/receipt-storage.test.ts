import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { decodeReceipt, encodeReceipt, receiptBytes } from "./receipt-storage.js";

test("receipt codec writes Brotli envelope and reads only current BLOB", () => {
    const value = { draft: { source: { title: "中文" } }, published: null };
    const encoded = encodeReceipt(value);
    assert.equal(Buffer.from(encoded).subarray(0, 5).toString("ascii"), "ICBR1");
    assert.deepEqual(decodeReceipt(encoded), value);
    const legacyText = JSON.stringify(value);
    assert.throws(() => decodeReceipt(legacyText), /Unsupported receipt storage type/);
    assert.throws(() => decodeReceipt(gzipSync(Buffer.from(legacyText))), /Unsupported compressed JSON storage format/);
    assert.equal(receiptBytes(encoded), encoded.byteLength);
});

test("receipt codec rejects corrupt and unknown BLOBs without exposing payload", () => {
    assert.throws(() => decodeReceipt(Buffer.from("unknown payload")), { message: "Unsupported compressed JSON storage format" });
    assert.throws(() => decodeReceipt("not json"), { message: "Unsupported receipt storage type" });
});
