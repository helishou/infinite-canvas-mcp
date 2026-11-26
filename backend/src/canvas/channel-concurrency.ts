/**
 * 渠道级并发限流：对齐影策的「每渠道最大并发数 + 全局渠道并发默认」机制。
 *
 * 影策在 provider_http_client.go 的 AcquireChannelSlot 处，对每个渠道请求做限流：
 * - 渠道配了 concurrencyLimit 就用渠道值；
 * - 渠道「跟随系统」时用全局 channelConcurrency；
 * - 都没有则不限（0）。
 *
 * 本地四类渠道（文字 / 图片 / 视频 / 音频）共用这一层。按 channelId 分桶计数，
 * 超出上限的请求排队等待，前面的 release 后按 FIFO 唤醒。
 *
 * 任务调度是 fire-and-forget：调用方用 withChannelSlot 包住真正的执行函数，
 * acquire 拿到槽位才执行，finally 释放，保证槽位不泄漏。
 */

export type ChannelKind = "text" | "image" | "video" | "audio";

type RawChannelLimit = { id?: unknown; concurrencyLimit?: unknown };

/** 从 ai.config 读某渠道的并发上限。返回 0 表示不限。 */
export function resolveChannelLimit(aiConfig: unknown, channelId: string | undefined): number {
    if (!aiConfig || typeof aiConfig !== "object") return 0;
    const config = aiConfig as Record<string, unknown>;
    const globalLimit = normalizeLimit(config.channelConcurrency);
    if (!channelId) return globalLimit;
    const channels = Array.isArray(config.channels) ? (config.channels as RawChannelLimit[]) : [];
    const channel = channels.find((item) => item && String(item.id || "") === channelId);
    if (!channel) return globalLimit;
    // 渠道填了上限就用渠道值，没填则回退全局值。不额外设"跟随系统"开关：
    // 留空本身就表达"跟随系统"，少一个用户要填的字段。
    const own = normalizeLimit(channel.concurrencyLimit);
    return own > 0 ? own : globalLimit;
}

function normalizeLimit(value: unknown): number {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 999) : 0;
}

type Waiter = { resolve: (release: () => void) => void };

/**
 * 按 key（通常是 channelId）分桶的并发限流器。
 * limit <= 0 表示不限。
 */
export class ChannelConcurrencyLimiter {
    private readonly active = new Map<string, number>();
    private readonly queues = new Map<string, Waiter[]>();

    /**
     * 尝试无等待获取槽位：有空位立即占用并返回 release；没有空位返回 null（不排队）。
     * 供调用方在真正入队前判断「是否会发生等待」。
     */
    tryAcquire(key: string, limit: number): (() => void) | null {
        const normalizedKey = key || "__default__";
        if (limit <= 0) return () => undefined;
        const current = this.active.get(normalizedKey) || 0;
        if (current >= limit) return null;
        this.active.set(normalizedKey, current + 1);
        return this.makeRelease(normalizedKey);
    }

    /** 申请一个槽位；超限则排队。返回的 release 必须且只需调用一次。 */
    async acquire(key: string, limit: number): Promise<() => void> {
        const immediate = this.tryAcquire(key, limit);
        if (immediate) return immediate;
        const normalizedKey = key || "__default__";
        return new Promise<() => void>((resolve) => {
            const queue = this.queues.get(normalizedKey) || [];
            queue.push({ resolve });
            this.queues.set(normalizedKey, queue);
        });
    }

    private makeRelease(key: string): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const current = Math.max(0, (this.active.get(key) || 1) - 1);
            const queue = this.queues.get(key);
            if (queue && queue.length) {
                const next = queue.shift()!;
                // 槽位直接转交给等待者，active 保持不变。
                next.resolve(this.makeRelease(key));
            } else {
                this.active.set(key, current);
            }
        };
    }

    /** 当前活跃数与排队数，供测试与诊断。 */
    stats(key: string): { active: number; waiting: number } {
        const normalizedKey = key || "__default__";
        return {
            active: this.active.get(normalizedKey) || 0,
            waiting: (this.queues.get(normalizedKey) || []).length,
        };
    }

    /** 测试用：清空所有状态。 */
    reset(): void {
        this.active.clear();
        this.queues.clear();
    }
}

/** 四类 dispatcher 共用的单例限流器。 */
export const channelConcurrency = new ChannelConcurrencyLimiter();
