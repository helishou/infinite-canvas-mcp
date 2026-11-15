/**
 * ComfyUI 的 /prompt 只是把任务放进队列：返回 prompt_id 时本任务往往还没开始跑。
 * 旧逻辑从提交时刻起算超时，队列里前序任务的耗时会一起吃掉本任务的执行预算，
 * 表现为「前面几个任务加起来超时，本任务刚排到就被判失败」。
 *
 * 排队与执行各用一份独立预算，每个 prompt 持有自己的时钟：
 * 只有本任务真正进入 running 才开始计执行超时，且两段互不累计。
 */

/** 预设/自定义工作流共用的默认执行时限；与 H3 预设的既有产品决策一致。 */
export const DEFAULT_COMFY_TIMEOUT_MS = 120 * 60 * 1000;
export const MIN_COMFY_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_COMFY_TIMEOUT_MS = 120 * 60 * 1000;
/**
 * 排队兜底上限：排队是等前序任务，不是本任务在跑，所以不消耗执行预算，
 * 只保留一个很宽松的墙钟上限，避免队列彻底卡死时任务永久挂住。
 */
export const DEFAULT_COMFY_QUEUE_TIMEOUT_MS = 8 * 60 * 60 * 1000;

export function resolveComfyTimeoutMs(raw: unknown): number {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_COMFY_TIMEOUT_MS;
    return Math.max(MIN_COMFY_TIMEOUT_MS, Math.min(MAX_COMFY_TIMEOUT_MS, value));
}

export type ComfyExecutionPhase = "queued" | "running";
export type ComfyTimeout = { phase: ComfyExecutionPhase; waitedMs: number; limitMs: number };

export class ComfyExecutionClock {
    readonly submittedAt: number;
    readonly executionLimitMs: number;
    readonly queueLimitMs: number;
    private runningAt: number | null = null;

    constructor(
        now = Date.now(),
        executionLimitMs = DEFAULT_COMFY_TIMEOUT_MS,
        queueLimitMs = DEFAULT_COMFY_QUEUE_TIMEOUT_MS,
    ) {
        this.submittedAt = now;
        this.executionLimitMs = executionLimitMs;
        this.queueLimitMs = queueLimitMs;
    }

    get phase(): ComfyExecutionPhase {
        return this.runningAt === null ? "queued" : "running";
    }

    /** 本 prompt 进入执行；重复调用只认第一次，避免进度事件把起点不断往后推。 */
    markRunning(now = Date.now()): void {
        if (this.runningAt === null) this.runningAt = now;
    }

    /** 排队与执行分开计时；返回 null 表示当前这一段还没超。 */
    timeout(now = Date.now()): ComfyTimeout | null {
        if (this.runningAt === null) {
            const waitedMs = Math.max(0, now - this.submittedAt);
            return waitedMs > this.queueLimitMs ? { phase: "queued", waitedMs, limitMs: this.queueLimitMs } : null;
        }
        const waitedMs = Math.max(0, now - this.runningAt);
        return waitedMs > this.executionLimitMs ? { phase: "running", waitedMs, limitMs: this.executionLimitMs } : null;
    }
}

function durationLabel(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    return minutes >= 120 ? `${Math.round(minutes / 60)} 小时` : `${minutes} 分钟`;
}

export function comfyTimeoutMessage(timeout: ComfyTimeout, promptId: string): string {
    if (timeout.phase === "queued") {
        return `ComfyUI 队列等待超时（本任务已排队 ${durationLabel(timeout.limitMs)} 仍未开始执行；promptId: ${promptId}）。前序任务耗时不计入本任务的执行时间，请检查 ComfyUI 队列是否卡住`;
    }
    return `ComfyUI 任务执行超时（本任务已执行 ${durationLabel(timeout.limitMs)}；promptId: ${promptId}），请检查 ComfyUI 是否仍在运行`;
}

/**
 * 探测本 prompt 是否已进入 ComfyUI 的 running 队列。
 * 探测失败（服务忙、代理断开）返回 null，由调用方继续靠 WebSocket / history 判定，
 * 不能因为一次 /queue 失败就认为任务已经结束。
 */
export async function readComfyQueueState(
    comfyUrl: string,
    promptId: string,
    signal: AbortSignal,
): Promise<{ running: boolean; queued: boolean } | null> {
    try {
        const response = await fetch(`${comfyUrl.replace(/\/+$/, "")}/queue`, { signal });
        if (!response.ok) return null;
        const body = await response.json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
        // /queue 条目形如 [序号, prompt_id, prompt, extra, outputs]；不同版本序号位置略有差异。
        const contains = (items: unknown[]) => items.some((entry) =>
            Array.isArray(entry) && [entry[0], entry[1]].some((value) => value != null && String(value).includes(promptId)));
        const running = contains(body.queue_running || []);
        return { running, queued: running || contains(body.queue_pending || []) };
    } catch {
        return null;
    }
}
