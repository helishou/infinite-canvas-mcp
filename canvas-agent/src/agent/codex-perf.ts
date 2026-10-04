import { logger } from "../utils/logger.js";

/**
 * Codex turn 与补充历史落盘的耗时探针。
 *
 * 目的：把「哪里慢」从猜测变成数字。区分三类等待：
 * - 模型/网络：turn 发出到 turn.completed 到达
 * - 本地收尾：turn.completed 到 UI 收到 agent_done（含落盘）
 * - 落盘本身：序列化 / 写盘 / 字节数
 *
 * 只在 --debug 下输出，且只记录时长、体积与计数：
 * 不记录 prompt、命令输出、threadId 或 itemId。
 */

type TurnTiming = {
    /** turn/start 请求发出的时刻。 */
    requestedAt: number;
    /** 收到该 turn 第一个通知的时刻。 */
    firstEventAt?: number;
    /** 收到 turn.completed 的时刻。 */
    completedAt?: number;
    /** 即将发出 agent_done：记录服务端本地收尾时刻，不含 SSE 传输和浏览器渲染。 */
    finalizedAt?: number;
    /** 该 turn 内收到的通知数。 */
    events: number;
};

/** 用 turnKey 做键；只在内存里保留时长，不保留任何身份标识或内容。 */
const turnTimings = new Map<string, TurnTiming>();
let inFlightRecords = 0;
let peakInFlightRecords = 0;

/** 开始跟踪一个 turn。重复调用会保留最早的 requestedAt。 */
export function beginTurnTrace(turnKey: string, requestedAt = Date.now()) {
    const existing = turnTimings.get(turnKey);
    if (existing) return;
    turnTimings.set(turnKey, { requestedAt, events: 0 });
}

/** 记录该 turn 的第一个事件；用来算「等待首包」。 */
export function markFirstEvent(turnKey: string) {
    const timing = turnTimings.get(turnKey);
    if (!timing || timing.firstEventAt) return;
    timing.firstEventAt = Date.now();
}

/** 累加该 turn 收到的通知数。 */
export function countTurnEvent(turnKey: string) {
    const timing = turnTimings.get(turnKey);
    if (timing) timing.events += 1;
}

/** 收到 turn.completed：此刻起进入本地收尾阶段。 */
export function markTurnCompleted(turnKey: string) {
    const timing = turnTimings.get(turnKey);
    if (!timing || timing.completedAt) return;
    timing.completedAt = Date.now();
}

/** 即将发出 agent_done：这是服务端本地收尾耗时，不含 SSE 传输和浏览器渲染。 */
export function endTurnTrace(turnKey: string) {
    const timing = turnTimings.get(turnKey);
    if (!timing) return;
    timing.finalizedAt = Date.now();
    turnTimings.delete(turnKey);

    const first = timing.firstEventAt ? timing.firstEventAt - timing.requestedAt : undefined;
    const model = timing.completedAt ? timing.completedAt - timing.requestedAt : undefined;
    const finalize = timing.completedAt ? timing.finalizedAt - timing.completedAt : undefined;
    logger.debug("codex-turn-timing", {
        firstEventMs: first,
        modelMs: model,
        finalizeMs: finalize,
        totalMs: timing.finalizedAt - timing.requestedAt,
        events: timing.events,
    });
}

/** 记录冷启动历史文件读取/解析耗时（只记字节数，不读出数据内容）。 */
export function recordHistoryLoad(input: { readMs: number; parseMs: number; bytes: number }) {
    logger.debug("codex-history-load", input);
}

/** 记录一次实际落盘的耗时与体积。 */
export function recordFlushTiming(input: { serializeMs: number; writeMs: number; bytes: number }) {
    logger.debug("codex-history-flush", {
        serializeMs: input.serializeMs,
        writeMs: input.writeMs,
        bytes: input.bytes,
        inFlightRecords: inFlightRecords,
        peakInFlightRecords,
    });
    peakInFlightRecords = inFlightRecords;
}

/** 记录进入持久化路径的 record 数量，返回当前在途数。 */
export function recordQueueDepth() {
    inFlightRecords += 1;
    peakInFlightRecords = Math.max(peakInFlightRecords, inFlightRecords);
    return inFlightRecords;
}

/** 一个 record 完成时调用，回收在途计数。 */
export function releaseQueueDepth() {
    inFlightRecords = Math.max(0, inFlightRecords - 1);
}
