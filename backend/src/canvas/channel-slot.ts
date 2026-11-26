/**
 * dispatcher 接入渠道并发限流的薄封装。
 *
 * 四类 dispatcher 的 execute 是 fire-and-forget（void this.execute），改造主体
 * 风险高；这里在调用处包一层：拿到渠道槽位才真正执行，finally 保证释放。
 * 没有配置并发上限时 resolveChannelLimit 返回 0，acquire 立即放行，行为与改造前一致。
 */
import { channelConcurrency, resolveChannelLimit, type ChannelKind } from "./channel-concurrency.js";
import { decodeChannelModel } from "./model-workflow.js";
import type { Stores } from "../stores/types.js";

type SettingsLike = { settings: { get(key: string): unknown } };

/** 从模型限定标识（channelId::model）里取 channelId。 */
export function channelIdOfModel(model: unknown): string | undefined {
    if (typeof model !== "string") return undefined;
    return decodeChannelModel(model)?.channelId;
}

const CHANNEL_KIND_LABEL: Record<ChannelKind, string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };

/** 排队事实文案：只用真实并发上限与真实已有排队人数，拿不到等待就不调用。 */
export function channelWaitReason(kind: ChannelKind, limit: number, ahead: number): string {
    return `渠道并发已满（${CHANNEL_KIND_LABEL[kind]} · 并发 ${limit}，前面还有 ${ahead} 个）`;
}

/**
 * 把等待原因写进任务与生成日志的 params.waitReason（不新增列/迁移）。
 * reason 为空表示清空，避免残留「排队中」。写失败只丢诊断信息，不影响真实生成。
 */
export function recordWaitReason(
    stores: Pick<Stores, "tasks" | "logs">,
    taskId: string | null,
    logId: string | null,
    reason: string,
): void {
    try {
        if (taskId) {
            const task = stores.tasks.get(taskId);
            if (task) stores.tasks.update(taskId, { params: { ...task.params, waitReason: reason } });
        }
        if (!logId) return;
        const log = stores.logs.get(logId);
        if (log) stores.logs.update(logId, { params: { ...log.params, waitReason: reason } });
    } catch {
        // 等待原因是诊断信息：日志/任务写不进时按「没有原因」处理，不中断生成。
    }
}

/** dispatcher 通用注入：排队时写事实文案，拿到槽位时清空同一个字段。 */
export function waitReasonHooks(
    stores: Pick<Stores, "tasks" | "logs">,
    taskId: string | null,
    logId: string | null,
): ChannelSlotHooks {
    return {
        onWait: (reason) => recordWaitReason(stores, taskId, logId, reason),
        onAcquired: () => recordWaitReason(stores, taskId, logId, ""),
    };
}

export type ChannelSlotHooks = {
    /** 只有真正需要排队时回调一次（同步，携带真实并发配置与前面等待数）。 */
    onWait?: (reason: string) => void;
    /** 拿到槽位、即将执行时回调，用于清掉已经过期的等待原因。 */
    onAcquired?: () => void;
};

/** 申请渠道槽位后执行 fn，fn 结束（含抛错）必定释放。 */
export async function withChannelSlot<T>(
    stores: SettingsLike,
    kind: ChannelKind,
    channelId: string | undefined,
    fn: () => Promise<T>,
    hooks?: ChannelSlotHooks,
): Promise<T> {
    const limit = resolveChannelLimit(stores.settings.get("ai.config"), channelId);
    // 没配并发上限（limit<=0）时直接执行，不引入额外 await 微任务，
    // 保持与原 fire-and-forget 路径完全一致的时序，避免破坏既有调用方与测试。
    if (limit <= 0) return fn();
    // 按 kind + channelId 分桶：文字/图片/视频/音频各渠道独立计数。
    const key = `${kind}:${channelId || "default"}`;
    // 先无等待尝试：拿到槽位就不会等待，不写任何排队话术。
    const immediate = channelConcurrency.tryAcquire(key, limit);
    if (immediate) {
        try {
            return await fn();
        } finally {
            immediate();
        }
    }
    // 已满：先记录真实排队事实（limit 与此刻已在前面排队的人数），再入队等待。
    hooks?.onWait?.(channelWaitReason(kind, limit, channelConcurrency.stats(key).waiting));
    const release = await channelConcurrency.acquire(key, limit);
    try {
        hooks?.onAcquired?.();
        return await fn();
    } finally {
        release();
    }
}
