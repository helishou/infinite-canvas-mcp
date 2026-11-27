import assert from "node:assert/strict";
import test from "node:test";

import { TASK_TIMEOUT_MS } from "./pipeline.js";
import { DEFAULT_TIMEOUT_MS } from "../canvas/engine-client.js";

/**
 * video 作业等待上限必须 >= 引擎等待上限：H3 单段 20-40 分钟，15 分钟会把在跑的段
 * 误判 TASK_TIMEOUT，外层重提撞占用、重复出片。
 */
test("pipeline 作业超时对齐引擎等待上限（60 分钟）", () => {
    assert.ok(TASK_TIMEOUT_MS >= DEFAULT_TIMEOUT_MS,
        `TASK_TIMEOUT_MS(${TASK_TIMEOUT_MS}) 必须 >= 引擎 DEFAULT_TIMEOUT_MS(${DEFAULT_TIMEOUT_MS})`);
    assert.equal(TASK_TIMEOUT_MS, 60 * 60 * 1000);
});
