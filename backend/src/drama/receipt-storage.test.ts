import assert from "node:assert/strict";
import test from "node:test";
import { decodeReceipt, encodeReceipt, receiptBytes } from "./receipt-storage.js";

test("receipt storage reads legacy TEXT and gzip BLOB with exact JSON round-trip", () => {
    const value = {
        unicode: "暴雨夜·沈砚😀",
        nested: { keys: ["workflow", "artifacts"], count: 42 },
        repeated: "画布回执".repeat(20_000),
    };
    const legacyText = JSON.stringify(value);
    const compressed = encodeReceipt(value);
    assert.ok(compressed instanceof Uint8Array);
    assert.ok(compressed.byteLength < Buffer.byteLength(legacyText, "utf8") / 10);
    assert.deepEqual(decodeReceipt(legacyText), value);
    assert.deepEqual(decodeReceipt(compressed), value);
    assert.equal(receiptBytes(legacyText), Buffer.byteLength(legacyText, "utf8"));
    assert.equal(receiptBytes(compressed), compressed.byteLength);
});

test("receipt storage rejects unsupported/corrupt payloads rather than silently falling back", () => {
    assert.throws(() => decodeReceipt(123 as never), /存储类型不受支持/);
    assert.throws(() => decodeReceipt("not-json"), SyntaxError);
    assert.throws(() => decodeReceipt(new Uint8Array([1, 2, 3])), /incorrect header check|unknown compression method|unexpected end/i);
});
