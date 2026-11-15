/**
 * P0-A 回归：上游提交三态。
 *
 * 全部走真实 SQLite（BackendDatabase(":memory:") + createTaskStore），
 * 覆盖提交窗口、远端 ID 回执、明确拒绝、网络失败、存量任务兼容与终态保护。
 * 不 mock 网络：提交窗口用真实的 task_events / result_json 序列还原。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { createTaskStore } from "../stores/task-store.js";
import type { MediaStore, SettingStore } from "../stores/types.js";
import { H3ExecutionQueue, h3CanResumeQueued } from "@basketikun/media-engine/runtime/h3-queue";
import { RunningHubBackend } from "@basketikun/media-engine/runtime/runninghub";
import { ComfyUiBackend } from "@basketikun/media-engine/comfyui/bridge";
import { classifyErrorDisposition } from "../error-taxonomy.js";
import {
    holdUnknownSubmission,
    isDefiniteRejection,
    isProvablyNotSent,
    readSubmission,
    retryClassForCode,
    submissionDecision,
    writeSubmission,
} from "@basketikun/media-engine/runtime/submission-outcome";

function fixture(kind = "runninghub:workflow") {
    const db = new BackendDatabase(":memory:");
    const tasks = createTaskStore(db);
    const settings = { get: () => undefined, set: () => undefined } as unknown as SettingStore;
    const task = tasks.create(kind, {}, {});
    return { db, tasks, settings, id: task.id };
}

function queued(tasks: ReturnType<typeof createTaskStore>, id: string, provider = "runninghub") {
    tasks.addEvent(id, "h3_queued", { provider });
}

function failThrough(backend: object, id: string, error: unknown) {
    (backend as unknown as { fail(id: string, error: unknown): void }).fail(id, error);
}

test("H3 launch 在进入 work 前落下 unknown 意图，恢复判据不再误判为可重提", () => {
    const { tasks, settings, id } = fixture();
    const queue = new H3ExecutionQueue(tasks, settings);
    queue.enqueue(tasks.get(id)!, "runninghub", async () => {});

    const task = tasks.get(id)!;
    const events = tasks.events(id);
    assert.equal(events.some((event) => event.type === "h3_queued"), true);
    assert.equal(events.some((event) => event.type === "h3_dispatching"), true);
    const found = readSubmission(task, events);
    assert.equal(found?.explicit, true, "提交意图必须真实落库，不能只留在内存");
    assert.equal(found?.record.outcome, "unknown");
    assert.equal(submissionDecision(task, events), "reconcile");
    assert.equal(h3CanResumeQueued(tasks, id), false);
    assert.equal(events.some((event) => event.type === "submission_intent"), true);
});

test("拿到远端 ID 后只恢复观察；分段执行不能把 accepted 降级", () => {
    const { tasks, id } = fixture();
    queued(tasks, id);
    writeSubmission(tasks, id, { outcome: "unknown", retryClass: "reconcile_submission", provider: "runninghub" });
    tasks.addEvent(id, "submitted", { taskId: "rh-42", backend: "runninghub", credentialFingerprint: "fp" });
    writeSubmission(tasks, id, { outcome: "accepted", retryClass: "recover_result", provider: "runninghub", providerRequestId: "rh-42" });

    let task = tasks.get(id)!;
    assert.equal(submissionDecision(task, tasks.events(id)), "observe");
    assert.equal(readSubmission(task, tasks.events(id))?.record.providerRequestId, "rh-42");
    assert.equal(tasks.events(id).some((event) => event.type === "submission_accepted"), true);

    // autoSplit 会多次经过本地准备阶段，单向升级必须挡住降级。
    writeSubmission(tasks, id, { outcome: "not_submitted", retryClass: "correct_input", provider: "runninghub" });
    task = tasks.get(id)!;
    assert.equal(readSubmission(task, tasks.events(id))?.record.outcome, "accepted");
    assert.equal(submissionDecision(task, tasks.events(id)), "observe");
});

test("提交窗口内网络失败：保持 running 并给出核对诊断，不置 failed", () => {
    const { tasks, settings, id } = fixture();
    queued(tasks, id);
    writeSubmission(tasks, id, { outcome: "unknown", retryClass: "reconcile_submission", provider: "runninghub" });
    failThrough(new RunningHubBackend(tasks, settings), id, new Error("fetch failed"));

    const task = tasks.get(id)!;
    assert.equal(task.status, "running", "远端可能已建任务，不能判 failed");
    assert.match(String(task.error || ""), /unknown/);
    assert.match(String(task.error || ""), /禁止重复提交/);
    assert.equal(tasks.events(id).some((event) => event.type === "submission_unknown"), true);
    assert.equal(h3CanResumeQueued(tasks, id), false, "unknown 永远不允许重提");
});

test("上游明确拒绝：退回 not_submitted，重启后可安全重提且不会重复计费", () => {
    const { tasks, settings, id } = fixture();
    queued(tasks, id);
    writeSubmission(tasks, id, { outcome: "unknown", retryClass: "reconcile_submission", provider: "runninghub" });
    failThrough(new RunningHubBackend(tasks, settings), id, new Error("RunningHub 请求失败（HTTP 401 / code 412）：TOKEN_INVALID"));

    const task = tasks.get(id)!;
    assert.equal(task.status, "failed");
    assert.equal(readSubmission(task, tasks.events(id))?.record.outcome, "not_submitted");
    assert.equal(submissionDecision(task, tasks.events(id)), "resubmit");
    assert.equal(h3CanResumeQueued(tasks, id), true);
});

test("ComfyUI 链同样拦截 unknown 窗口", () => {
    const { tasks, settings, id } = fixture("comfyui:minimax-h3");
    queued(tasks, id, "local");
    writeSubmission(tasks, id, { outcome: "unknown", retryClass: "reconcile_submission", provider: "local" });
    const bridge = new ComfyUiBackend({ tasks, settings, media: {} as MediaStore }, "http://127.0.0.1:8188");
    failThrough(bridge, id, new Error("ECONNRESET"));

    const task = tasks.get(id)!;
    assert.equal(task.status, "running");
    assert.match(String(task.error || ""), /unknown/);
    assert.equal(tasks.events(id).some((event) => event.type === "submission_unknown"), true);
});

test("存量任务零迁移：没有显式记录时从既有事件推导", () => {
    const onlyQueued = fixture();
    queued(onlyQueued.tasks, onlyQueued.id);
    assert.equal(readSubmission(onlyQueued.tasks.get(onlyQueued.id), onlyQueued.tasks.events(onlyQueued.id)), undefined);
    assert.equal(submissionDecision(onlyQueued.tasks.get(onlyQueued.id), onlyQueued.tasks.events(onlyQueued.id)), "resubmit");

    const withSubmitted = fixture();
    queued(withSubmitted.tasks, withSubmitted.id);
    withSubmitted.tasks.addEvent(withSubmitted.id, "submitted", { taskId: "rh-old", backend: "runninghub" });
    const oldTask = withSubmitted.tasks.get(withSubmitted.id)!;
    assert.equal(submissionDecision(oldTask, withSubmitted.tasks.events(withSubmitted.id)), "observe");
    assert.equal(readSubmission(oldTask, withSubmitted.tasks.events(withSubmitted.id))?.record.providerRequestId, "rh-old");

    // 旧判据会把「已 dispatch 未 submitted」判成失败；新判据是 reconcile（保留诊断）。
    const dispatched = fixture();
    queued(dispatched.tasks, dispatched.id);
    dispatched.tasks.addEvent(dispatched.id, "h3_dispatching", { provider: "runninghub" });
    const pending = dispatched.tasks.get(dispatched.id)!;
    assert.equal(submissionDecision(pending, dispatched.tasks.events(dispatched.id)), "reconcile");
    assert.equal(readSubmission(pending, dispatched.tasks.events(dispatched.id))?.record.legacyUnknown, true);
    assert.equal(h3CanResumeQueued(dispatched.tasks, dispatched.id), false);

    // 既无排队意图也无提交回执的任务仍按原语义拒绝恢复。
    const orphan = fixture();
    assert.equal(submissionDecision(orphan.tasks.get(orphan.id), orphan.tasks.events(orphan.id)), "fail");
});

test("unknown 诊断不改写终态；错误分级透出 retryClass", () => {
    const { tasks, id } = fixture();
    tasks.update(id, { status: "succeeded" });
    assert.equal(holdUnknownSubmission(tasks, id, "迟到的提交窗口错误"), false);
    assert.equal(tasks.get(id)!.status, "succeeded");

    assert.equal(classifyErrorDisposition({ code: "BACKEND_TIMEOUT", message: "timeout" }).retryClass, "reconcile_submission");
    assert.equal(classifyErrorDisposition({ code: "OPERATION_RECEIPT_UNAVAILABLE", message: "" }).retryClass, "recover_result");
    assert.equal(classifyErrorDisposition({ code: "SPEC_MISMATCH", message: "", retryClass: "new_generation_authorization" }).retryClass, "new_generation_authorization");
    assert.equal(retryClassForCode("SPEC_MISMATCH"), undefined);

    assert.equal(isDefiniteRejection(new Error("ComfyUI /prompt failed: HTTP 400")), true);
    assert.equal(isDefiniteRejection(new Error("RunningHub 请求失败（HTTP 429 / 限流）")), false);
    assert.equal(isDefiniteRejection(new Error("ETIMEDOUT")), false);
    assert.equal(isDefiniteRejection(new Error("code 380 WORKFLOW_NOT_EXISTS")), true);
});

/** undici 把真实原因放在 cause 链里，消息只有一句 fetch failed。 */
function connectRefused(cause = "connect ECONNREFUSED 127.0.0.1:8188") {
    return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(cause), { code: "ECONNREFUSED" }) });
}

test("连接根本没建立是可证明的未提交：不冻结 unknown，可直接重提", () => {
    // 纯 fetch failed 无法区分「已发出」与「未发出」，仍按 unknown 冻结。
    assert.equal(isProvablyNotSent(new Error("fetch failed")), false);
    assert.equal(isDefiniteRejection(new Error("fetch failed")), false);
    // 连接被拒 / DNS 失败证明请求没有离开本机。
    assert.equal(isProvablyNotSent(connectRefused()), true);
    assert.equal(isDefiniteRejection(connectRefused()), true);
    assert.equal(isProvablyNotSent(Object.assign(new Error("getaddrinfo ENOTFOUND comfy"), { code: "ENOTFOUND" })), true);
    assert.equal(isProvablyNotSent(new Error("ECONNRESET")), false);
    assert.equal(isDefiniteRejection(new Error("ECONNREFUSED")), true);

    const { tasks, settings, id } = fixture("comfyui:minimax-h3");
    queued(tasks, id, "local");
    writeSubmission(tasks, id, { outcome: "unknown", retryClass: "reconcile_submission", provider: "local" });
    const bridge = new ComfyUiBackend({ tasks, settings, media: {} as MediaStore }, "http://127.0.0.1:8188");
    failThrough(bridge, id, connectRefused());

    // ComfyUI 重启窗口里提交必失败：任务必须落到可重跑的失败态，而不是永远停在 running。
    const task = tasks.get(id)!;
    assert.equal(task.status, "failed");
    assert.equal(readSubmission(task, tasks.events(id))?.record.outcome, "not_submitted");
    assert.equal(h3CanResumeQueued(tasks, id), true);
});

test("提交窗口重复判定不再把事件流刷屏，状态仍保持 unknown", () => {
    const { tasks, id } = fixture("comfyui:minimax-h3");
    queued(tasks, id, "local");
    writeSubmission(tasks, id, { outcome: "unknown", retryClass: "reconcile_submission", provider: "local" });
    for (let i = 0; i < 20; i++) holdUnknownSubmission(tasks, id, "轮询重复判定");
    const holds = tasks.events(id).filter((event) => event.type === "submission_unknown").length;
    assert.equal(holds, 1, "30 秒内重复判定只记一条事件");
    assert.equal(tasks.get(id)!.status, "running");
});
