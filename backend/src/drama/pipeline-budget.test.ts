import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetReached, taskCostMicrocredits, DEFAULT_STEP_COST_MICROCREDITS } from "./pipeline.js";
import { pipelineOptionsSchema } from "../server/drama-pipeline-routes.js";

test("budgetReached: 0/未设/非法=不限，达到即耗尽", () => {
    assert.equal(budgetReached(0, undefined), false);
    assert.equal(budgetReached(10_000, 0), false);
    assert.equal(budgetReached(10_000, Number.NaN), false);
    assert.equal(budgetReached(99, 100), false);
    assert.equal(budgetReached(100, 100), true);
    assert.equal(budgetReached(101, 100), true);
});

test("taskCostMicrocredits: 真实 usage 优先，缺失回退估算，0 也是真值", () => {
    assert.equal(taskCostMicrocredits({ usage: { costMicrocredits: 777 } }, 150), 777);
    assert.equal(taskCostMicrocredits({ usageResponse: { microcredits: 42 } }, 150), 42);
    assert.equal(taskCostMicrocredits({ result: { usage: { costMicrocredits: 9 } } }, 150), 9);
    assert.equal(taskCostMicrocredits({ usage: { costMicrocredits: 0 } }, 150), 0);
    assert.equal(taskCostMicrocredits({ usage: { costMicrocredits: "bad" } }, 150), 150);
    assert.equal(taskCostMicrocredits(undefined, DEFAULT_STEP_COST_MICROCREDITS.text), 150);
});

test("schema: 接受 budgetMicrocredits>=0，拒绝负数", () => {
    assert.equal(pipelineOptionsSchema.safeParse({ budgetMicrocredits: 0 }).success, true);
    assert.equal(pipelineOptionsSchema.safeParse({ budgetMicrocredits: 50000 }).success, true);
    assert.equal(pipelineOptionsSchema.safeParse({ budgetMicrocredits: -1 }).success, false);
    assert.equal(pipelineOptionsSchema.safeParse({}).success, true); // 不设=不限
});
