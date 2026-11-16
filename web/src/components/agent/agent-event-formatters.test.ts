import assert from "node:assert/strict";
import test from "node:test";
import { mergeUsage } from "./agent-event-formatters";

test("partial usage.updated keeps the last real cached/output counts", () => {
    // Hermes 的 ACP usage_update 只带上下文输入量；缺的字段不能补成 0。
    const previous = { input: 1200, cached: 800, output: 640 };
    const merged = mergeUsage(previous, { type: "usage.updated", usage: { input_tokens: 342464 } });
    assert.deepEqual(merged, { input: 342464, cached: 800, output: 640 });
});

test("full usage.updated from turn end replaces every field", () => {
    const previous = { input: 1200, cached: 800, output: 640 };
    const merged = mergeUsage(previous, { type: "usage.updated", usage: { input_tokens: 300000, cached_input_tokens: 210000, output_tokens: 1900 } });
    assert.deepEqual(merged, { input: 300000, cached: 210000, output: 1900 });
});

test("explicit zero from a real receipt is respected", () => {
    const previous = { input: 1200, cached: 800, output: 640 };
    const merged = mergeUsage(previous, { type: "usage.updated", usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 0 } });
    assert.deepEqual(merged, { input: 900, cached: 0, output: 0 });
});

test("first usage.updated without previous numbers reports what it has", () => {
    const merged = mergeUsage(null, { type: "usage.updated", usage: { input_tokens: 512 } });
    assert.deepEqual(merged, { input: 512, cached: 0, output: 0 });
});
