import assert from "node:assert/strict";
import test from "node:test";

import { readSubmission, submissionDecision } from "./submission-outcome.js";

/**
 * 引擎渠道的 canvas-video 任务写的是 engine_submitted 事件（不是 submitted）。
 * 若 readSubmission 只认 submitted，submissionDecision 会对已提交引擎的任务返回 fail，
 * 启动恢复据此判失败并重复提交，造成同一段两次 prompt、重复出片。
 */
test("engine_submitted 回执被识别为已提交，submissionDecision 不再返回 fail", () => {
    const task = { kind: "canvas-video", status: "running", input: {}, result: {} } as never;
    const events = [{ type: "engine_submitted", payload: { engineTaskId: "engine-abc", baseUrl: "http://127.0.0.1:8300" } }] as never;
    const found = readSubmission(task, events);
    assert.ok(found, "engine_submitted 应被识别为提交回执");
    assert.equal(found!.record.outcome, "accepted");
    assert.equal(found!.record.providerRequestId, "engine-abc");
    assert.equal(submissionDecision(task, events), "observe");
});

test("无回执的 running 任务仍保持 fail 判据（不放松未提交任务）", () => {
    const task = { kind: "canvas-video", status: "running", input: {}, result: {} } as never;
    assert.equal(submissionDecision(task, [] as never), "fail");
});
