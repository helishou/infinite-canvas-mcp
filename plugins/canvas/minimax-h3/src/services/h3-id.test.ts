import test from "node:test";
import assert from "node:assert/strict";
import { createH3Id } from "./h3-id";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("uses native randomUUID when the browser exposes it", () => {
    assert.equal(createH3Id({ randomUUID: () => "native-id" }), "native-id");
});

test("generates a v4 ID with getRandomValues when randomUUID is missing", () => {
    let generation = 0;
    const source = { getRandomValues: (bytes: Uint8Array) => { bytes.fill(++generation); return bytes; } };
    const first = createH3Id(source);
    const second = createH3Id(source);
    assert.match(first, UUID_V4);
    assert.match(second, UUID_V4);
    assert.notEqual(first, second);
});

test("still generates an ID when the browser exposes no Web Crypto object", () => {
    assert.match(createH3Id(null), UUID_V4);
});
