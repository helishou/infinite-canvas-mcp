import assert from "node:assert/strict";
import zlib, { gzipSync } from "node:zlib";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compressStoredJsonText, decodeStoredJson, encodeStoredJson, storedJsonText } from "./json-storage.js";

test("versioned Brotli codec preserves exact UTF8 JSON text", () => {
    const source = '{ "n" : 1.00, "name" : "山海😀", "space" : "\\u4e2d" }';
    const compressed = compressStoredJsonText(source);
    assert.equal(Buffer.from(compressed).subarray(0, 5).toString("ascii"), "ICBR1");
    assert.equal(storedJsonText(compressed), source);
    assert.deepEqual(decodeStoredJson(compressed), JSON.parse(source));
});

test("current TEXT remains readable and legacy gzip is rejected outside migration", () => {
    const source = '{"prompt":"旧提示词","value":2}';
    assert.equal(storedJsonText(source), source);
    assert.throws(() => storedJsonText(gzipSync(Buffer.from(source))), /Unsupported compressed JSON storage format/);
});

test("large new JSON chooses compact lossless encoding and small JSON remains TEXT", () => {
    const value = { prompt: "保留中文提示词。".repeat(2000), value: 1 };
    const stored = encodeStoredJson(value);
    assert.ok(stored instanceof Uint8Array);
    assert.equal(storedJsonText(stored), JSON.stringify(value));
    assert.equal(encodeStoredJson({ title: "small" }), '{"title":"small"}');
});

test("unknown and corrupt compressed formats fail with sanitized errors", () => {
    assert.throws(() => storedJsonText(Buffer.from("not a codec")), { message: "Unsupported compressed JSON storage format" });
    const brotli = Buffer.from(compressStoredJsonText('{"private":"value"}'));
    brotli[brotli.length - 1] ^= 0xff;
    assert.throws(() => storedJsonText(brotli), { message: "Corrupt compressed JSON storage" });
    assert.throws(() => decodeStoredJson('{"private":"value"'), { message: "Stored JSON payload is invalid" });
});

test("SQLite stored_json_text UDF reads current TEXT and Brotli", () => {
    const db = new DatabaseSync(":memory:");
    try {
        db.function("stored_json_text", { deterministic: true }, storedJsonText);
        const json = '{ "n" : 1.00 }';
        const row = db.prepare("SELECT stored_json_text(?) AS plain, stored_json_text(?) AS brotli")
            .get(json, compressStoredJsonText(json)) as Record<string, string>;
        assert.deepEqual({ ...row }, { plain: json, brotli: json });
    } finally { db.close(); }
});


test("online large writes never invoke gzip in addition to the current codec", t => {
    const spy = t.mock.method(zlib, "gzipSync", () => { throw new Error("unexpected second compression"); });
    syncBuiltinESMExports();
    t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
    const input = { prompt: "full snapshot content ".repeat(2000), value: false };
    const encoded = encodeStoredJson(input);
    assert.ok(encoded instanceof Uint8Array);
    assert.equal(Buffer.from(encoded).subarray(0, 5).toString("ascii"), "ICBR1");
    assert.deepEqual(decodeStoredJson(encoded), input);
    assert.equal(spy.mock.callCount(), 0);
});
