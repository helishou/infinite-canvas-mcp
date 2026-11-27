import assert from "node:assert/strict";
import test from "node:test";
import { resolveConcurrency } from "./studio-settings-concurrency.js";

test("旧三池并发设置收敛为影策单值，取最小值不放大任何一池的上限", () => {
    assert.equal(resolveConcurrency({ text: 4, video: 1, assemble: 2 }, 4), 1);
    assert.equal(resolveConcurrency({ text: 2, video: 3, assemble: 2 }, 4), 2);
});

test("单值并发按 1-16 clamp，非法值回退影策默认 4", () => {
    assert.equal(resolveConcurrency(3, 4), 3);
    assert.equal(resolveConcurrency(99, 4), 16);
    assert.equal(resolveConcurrency(0, 4), 4);
    assert.equal(resolveConcurrency(undefined, 4), 4);
});
