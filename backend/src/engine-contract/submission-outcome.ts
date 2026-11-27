/**
 * 从执行引擎 `comfyui2api/src/runtime/submission-outcome.ts` 落地到画布的类型/纯函数副本。
 * 目的：画布不再 import 引擎 npm 包，双方只通过 HTTP 通信。
 * 同步方式：引擎侧该文件改动时，这里需要手工同步（内容已冻结，不含 I/O）。
 */
/**
 * 上游提交三态（P0-A）。
 *
 * 解决的问题：H3 任务在「已 dispatch、未拿到远端 taskId/prompt_id」这个窗口里，
 * 远端可能已经创建了任务，本地却既没有远端 ID 可观察，又因 h3_dispatching
 * 事件而不允许重提。旧判据只能把它置为 failed（"提交状态不明"），既可能漏掉
 * 已付费的结果，也可能诱导调用方重复提交。
 *
 * 本模块把已存在于 browser-script-dispatcher 的 notSubmitted / terminalConfirmed /
 * legacyUnknown 语义提升为运行时公共契约：
 *   - not_submitted：请求没发出或上游明确拒绝，可安全重提；
 *   - accepted：拿到远端 ID，只恢复观察，绝不重提；
 *   - unknown：请求可能已发出但没有回执，只回查 / 人工核对，禁止重提与判失败。
 *
 * 落库为零迁移方案：记录写进 tasks.result_json.submission，边界事件写 task_events。
 * 没有显式记录的老任务由 readSubmission 从既有事件推导，行为不改变。
 */

import type { RuntimeTask, RuntimeTaskEvent } from "./contracts.js";
import type { TaskStore } from "./contracts.js";

export type SubmissionOutcome = "not_submitted" | "accepted" | "unknown";

export type RetryClass =
    | "correct_input"                  // 未提交，本地校验失败，改输入后可直接重提
    | "reconcile_submission"           // 已发出但无回执，只回查，禁止重提
    | "recover_result"                 // 已有 providerRequestId，恢复轮询 / 补存媒体
    | "new_generation_authorization";  // 上游已确认失败，须人工授权才重生成

export type SubmissionDecision = "resubmit" | "observe" | "reconcile" | "fail";

export type SubmissionRecord = {
    version: 1;
    outcome: SubmissionOutcome;
    retryClass: RetryClass;
    provider: "local" | "runninghub";
    providerRequestId?: string;
    intentAt: number;
    acceptedAt?: number;
    credentialFingerprint?: string;
    /** 老任务没有显式记录，由 h3_dispatching 推导出的 unknown。 */
    legacyUnknown?: boolean;
};

export type SubmissionWrite = Partial<Omit<SubmissionRecord, "version" | "outcome" | "retryClass" | "intentAt">> & {
    outcome: SubmissionOutcome;
    retryClass: RetryClass;
    /** 有上游明确拒绝证据时允许从 unknown 退回 not_submitted。 */
    force?: boolean;
};

/** 记录只能单向升级：分段执行会多次经过提交点，不能把 accepted 打回 not_submitted。 */
const OUTCOME_RANK: Record<SubmissionOutcome, number> = { not_submitted: 0, unknown: 1, accepted: 2 };
const OUTCOMES: SubmissionOutcome[] = ["not_submitted", "unknown", "accepted"];
const RETRY_CLASSES: RetryClass[] = ["correct_input", "reconcile_submission", "recover_result", "new_generation_authorization"];

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function providerOf(task: RuntimeTask | null | undefined, events: RuntimeTaskEvent[]): "local" | "runninghub" {
    const submitted = [...events].reverse().find((event) => event.type === "submitted");
    if (submitted?.payload?.backend === "runninghub") return "runninghub";
    if (typeof task?.kind === "string" && task.kind.startsWith("runninghub:")) return "runninghub";
    const queued = events.find((event) => event.type === "h3_queued");
    if (queued?.payload?.provider === "runninghub") return "runninghub";
    return "local";
}

function isSubmissionRecord(value: unknown): value is SubmissionRecord {
    const item = recordOf(value);
    return item.version === 1
        && OUTCOMES.includes(item.outcome as SubmissionOutcome)
        && RETRY_CLASSES.includes(item.retryClass as RetryClass)
        && typeof item.intentAt === "number";
}

/**
 * 读取提交记录。优先读显式落库记录；老任务没有记录时从既有事件推导，
 * 推导结果只用于判定、不写回，避免为存量数据引入迁移。
 */
export function readSubmission(
    task: RuntimeTask | null | undefined,
    events: RuntimeTaskEvent[] = [],
): { record: SubmissionRecord; explicit: boolean } | undefined {
    const stored = recordOf(task?.result).submission;
    if (isSubmissionRecord(stored)) return { record: stored, explicit: true };

    const submitted = [...events].reverse().find((event) => event.type === "submitted");
    // 引擎渠道（canvas-video）写的是 engine_submitted 而非 submitted；只认后者会把
    // 已提交到引擎的任务判成 fail（submissionDecision），重启后误判失败并重复提交。
    const engineSubmitted = [...events].reverse().find((event) => event.type === "engine_submitted");
    const submittedEvent = submitted || engineSubmitted;
    if (submittedEvent) {
        const payload = recordOf(submittedEvent.payload);
        const providerRequestId = [payload.taskId, payload.promptId, payload.engineTaskId].find((value) => typeof value === "string" && value) as string | undefined;
        const credentialFingerprint = typeof payload.credentialFingerprint === "string" ? payload.credentialFingerprint : undefined;
        return {
            explicit: false,
            record: {
                version: 1,
                outcome: "accepted",
                retryClass: "recover_result",
                provider: providerOf(task, events),
                ...(providerRequestId ? { providerRequestId } : {}),
                ...(credentialFingerprint ? { credentialFingerprint } : {}),
                intentAt: 0,
                acceptedAt: 0,
            },
        };
    }
    if (events.some((event) => event.type === "h3_dispatching")) {
        return {
            explicit: false,
            record: {
                version: 1,
                outcome: "unknown",
                retryClass: "reconcile_submission",
                provider: providerOf(task, events),
                intentAt: 0,
                legacyUnknown: true,
            },
        };
    }
    return undefined;
}

/** 统一的恢复判据。所有 resume / 孤儿回收分支都走这里，不再各自拼事件判断。 */
export function submissionDecision(
    task: RuntimeTask | null | undefined,
    events: RuntimeTaskEvent[] = [],
): SubmissionDecision {
    const found = readSubmission(task, events);
    const hasQueued = events.some((event) => event.type === "h3_queued");
    if (!found) return hasQueued ? "resubmit" : "fail";
    const { record } = found;
    if (record.outcome === "accepted") return record.providerRequestId ? "observe" : "reconcile";
    if (record.outcome === "not_submitted") return hasQueued ? "resubmit" : "fail";
    return "reconcile";
}

/** 保持与旧 h3CanResumeQueued 相同的签名与语义：只有「确定没提交」才可重提。 */
export function submissionCanResubmit(
    task: RuntimeTask | null | undefined,
    events: RuntimeTaskEvent[] = [],
): boolean {
    return submissionDecision(task, events) === "resubmit";
}

/**
 * 写入 / 升级提交记录。同一事务内写 result_json 与边界事件；
 * 低等级 outcome 不能覆盖高等级，避免分段执行或迟到的提交点把 accepted 打回去。
 */
export function writeSubmission(tasks: TaskStore, id: string, patch: SubmissionWrite): SubmissionRecord | undefined {
    const task = tasks.get(id);
    if (!task) return undefined;
    const events = tasks.events(id);
    const existing = readSubmission(task, events);
    const current = existing?.explicit ? existing.record : undefined;
    const rank = OUTCOME_RANK[patch.outcome];
    if (!patch.force && current && OUTCOME_RANK[current.outcome] > rank) return current;
    if (!patch.force && current && OUTCOME_RANK[current.outcome] === rank && patch.outcome !== "accepted") {
        // 同级重复写入不追加事件，避免事件流被同一状态刷屏。
        return current;
    }
    const accepted = patch.outcome === "accepted";
    const next: SubmissionRecord = {
        version: 1,
        outcome: patch.outcome,
        retryClass: patch.retryClass,
        provider: patch.provider || current?.provider || providerOf(task, events),
        intentAt: current?.intentAt || Date.now(),
        ...(accepted && (patch.providerRequestId || current?.providerRequestId)
            ? { providerRequestId: patch.providerRequestId || current?.providerRequestId }
            : {}),
        ...(patch.credentialFingerprint || current?.credentialFingerprint
            ? { credentialFingerprint: patch.credentialFingerprint || current?.credentialFingerprint }
            : {}),
        ...(!patch.force && (patch.legacyUnknown || current?.legacyUnknown) ? { legacyUnknown: true } : {}),
        ...(accepted ? { acceptedAt: current?.acceptedAt || Date.now() } : {}),
    };
    tasks.update(id, { result: { ...recordOf(task.result), submission: next } });
    const eventType = patch.outcome === "accepted" ? "submission_accepted"
        : patch.outcome === "not_submitted" ? "submission_not_submitted" : "submission_intent";
    tasks.addEvent(id, eventType, {
        outcome: next.outcome,
        retryClass: next.retryClass,
        provider: next.provider,
        ...(next.providerRequestId ? { providerRequestId: next.providerRequestId } : {}),
    });
    return next;
}

/** unknown 不判 failed：保持 running 并给出可执行诊断，等重启恢复时按 reconcile 分流。 */
export function submissionDiagnostic(message?: string): string {
    const base = "上游提交状态未确认（unknown）：请求可能已发出但没有远端回执。禁止重复提交，请核对平台任务或用原 taskId / prompt_id 查询终态后再恢复；不要重新生成。";
    return message ? `${base} 原始错误：${message}` : base;
}

/** 同一状态重复写入的最小间隔：轮询触发的恢复判定不应把事件流刷成几百条。 */
const UNKNOWN_HOLD_EVENT_INTERVAL_MS = 30_000;

export function holdUnknownSubmission(tasks: TaskStore, id: string, message?: string): boolean {
    const task = tasks.get(id);
    if (!task || ["succeeded", "failed", "cancelled"].includes(task.status)) return false;
    const diagnostic = submissionDiagnostic(message);
    tasks.update(id, { status: "running", error: diagnostic });
    const events = tasks.events(id);
    const last = [...events].reverse().find((event) => event.type === "submission_unknown");
    const lastAt = last ? Date.parse(String(last.createdAt || "")) : NaN;
    // 每个 GET / 轮询都会走一遍恢复判定：状态没变时不重复追加同一条事件。
    if (!last || !Number.isFinite(lastAt) || Date.now() - lastAt >= UNKNOWN_HOLD_EVENT_INTERVAL_MS) {
        tasks.addEvent(id, "submission_unknown", { retryClass: "reconcile_submission", error: diagnostic });
    }
    return true;
}

/**
 * 可证明「请求从未离开本机」的连接级错误：TCP 连接没有建立（端口未监听、主机不可达）
 * 或域名解析失败。这类失败与「已发出但没回执」是两回事——上游不可能建过任务，
 * 因此不需要人工核对，也不会重复计费。
 */
const NOT_SENT_CODES = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"] as const;

/** 沿 cause 链读取连接级错误码（undici 的 fetch failed 把真实原因放在 cause.code）。 */
export function notSentCode(error: unknown): string | undefined {
    let current: unknown = error;
    for (let depth = 0; current && depth < 5; depth++) {
        const item = recordOf(current);
        for (const candidate of [item.code, item.errno]) {
            if (typeof candidate === "string" && (NOT_SENT_CODES as readonly string[]).includes(candidate)) return candidate;
        }
        current = item.cause;
    }
    const message = error instanceof Error ? error.message : String(error || "");
    return NOT_SENT_CODES.find((code) => new RegExp(`\\b${code}\\b`).test(message));
}

export function isProvablyNotSent(error: unknown): boolean {
    return notSentCode(error) !== undefined;
}

/** 连接级失败的最终诊断：本次确实没提交，可以直接重跑，而不是挂着等人核对。 */
export function notSentDiagnostic(code: string): string {
    return `上游服务未响应（${code}）：请求没有离开本机，ComfyUI 可能正在启动、重启或端口未监听。本次没有提交任何生成任务，也没有产生远端任务，确认服务可用后可直接重跑。`;
}

/**
 * 上游「明确拒绝」与「可能已创建任务」的区分。
 * HTTP 4xx（除 408 / 429）与平台业务拒绝码意味着任务没有创建，可安全退回 not_submitted；
 * 超时、网络中断、响应解析失败一律保持 unknown。
 * 连接根本没建立的失败同样可安全退回：请求没有发出去，上游不可能建过任务。
 */
export function isDefiniteRejection(error: unknown): boolean {
    if (notSentCode(error)) return true;
    const message = error instanceof Error ? error.message : String(error || "");
    if (/\b(?:408|429)\b/.test(message)) return false;
    if (/HTTP\s*4\d\d/i.test(message)) return true;
    if (/\b(?:401|403|404|412|422)\b/.test(message) && /TOKEN|UNAUTHORIZED|FORBIDDEN|INVALID|不存在|未授权|鉴权/i.test(message)) return true;
    if (/(?:code\s*380|WORKFLOW_NOT_EXISTS|WORKFLOW_NOT_SAVED_OR_NOT_RUNNING|code\s*810)/i.test(message)) return true;
    return false;
}

/** 错误码 → 建议处置类别。只是错误语义分级，不臆断任务实际状态。 */
export function retryClassForCode(code: string): RetryClass | undefined {
    switch (code) {
        case "BACKEND_TIMEOUT":
        case "BACKEND_NETWORK_ERROR":
        case "BACKEND_INVALID_RESPONSE":
        case "MCP_CALL_CANCELLED":
            return "reconcile_submission";
        case "RECEIPT_UNAVAILABLE":
        case "OPERATION_RECEIPT_UNAVAILABLE":
            return "recover_result";
        case "OPERATION_ID_REUSED":
        case "IDEMPOTENCY_CONFLICT":
            return "new_generation_authorization";
        default:
            return undefined;
    }
}
