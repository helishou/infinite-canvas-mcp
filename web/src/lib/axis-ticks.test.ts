import assert from "node:assert/strict";
import test from "node:test";

import { axisTicks } from "./axis-ticks";

test("a max of 7 produces round labels instead of 0 / 2 / 5 / 7", () => {
    assert.deepEqual(axisTicks(7), [0, 2, 4, 6, 8]);
    assert.deepEqual(axisTicks(25), [0, 10, 20, 30]);
    assert.deepEqual(axisTicks(100), [0, 25, 50, 75, 100]);
});

test("small counts keep integer steps and never start above the data", () => {
    assert.deepEqual(axisTicks(1), [0, 1]);
    assert.deepEqual(axisTicks(3), [0, 1, 2, 3]);
    assert.deepEqual(axisTicks(0), [0, 1]);
});

test("the axis always covers the largest value", () => {
    for (const maximum of [2, 4, 9, 37, 999]) {
        const ticks = axisTicks(maximum);
        assert.ok(ticks[ticks.length - 1] >= maximum, `top ${ticks[ticks.length - 1]} must cover ${maximum}`);
        assert.equal(ticks[0], 0);
    }
});
