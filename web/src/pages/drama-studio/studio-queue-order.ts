/**
 * 制作台队列的展示顺序（对齐影策 queue-bar：运行中 → 排队 → 失败/待重试 → 完成历史）。
 *
 * 队列行来自三个数据源：流水线阶段作业（priority DESC / created_at ASC）、
 * 批次、生成日志（created_at DESC）。直接按数据源拼接顺序展示，会让同一状态里的行
 * 一会儿 oldest-first、一会儿 newest-first，看起来像完全乱排。这里统一按状态分桶，
 * 桶内按真实时间排序，数据源顺序只作同时间的稳定兜底。
 */

export type StudioQueueOrderJob = {
    status?: string;
    error?: string;
    createdAt?: string;
    startedAt?: string;
    finishedAt?: string;
};

/** 状态桶：0 运行中、1 排队、2 失败/待重试、3 完成历史。 */
export function studioQueueRank(job: StudioQueueOrderJob): number {
    const status = String(job.status || "").toLowerCase();
    if (["running", "checking", "compiling", "applying"].includes(status)) return 0;
    if (["queued", "waiting", "pending", "blocked"].includes(status)) return 1;
    if (["failed", "error", "retry", "rejected", "paused", "paused_by_user"].includes(status) || Boolean(job.error)) return 2;
    return 3;
}

/** 队列行时间，与列表时间列同源：开始 → 加入 → 结束；无真实时间返回 0。 */
function queueTimeOf(job: StudioQueueOrderJob): number {
    const value = Date.parse(String(job.startedAt || job.createdAt || job.finishedAt || ""));
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 活跃桶（运行中/排队）按时间升序：最早该处理的排最前，与后端 claim 的
 * created_at ASC 一致。终态桶（失败/完成历史）按时间降序：最近发生的排最前，
 * 与生成日志的 created_at DESC 一致。没有时间的行排到桶尾，时间相同保持原顺序。
 */
export function orderStudioQueue<T extends StudioQueueOrderJob>(jobs: readonly T[]): T[] {
    return jobs
        .map((job, at) => ({ job, at }))
        .sort((a, b) => {
            const rankDiff = studioQueueRank(a.job) - studioQueueRank(b.job);
            if (rankDiff) return rankDiff;
            const ta = queueTimeOf(a.job);
            const tb = queueTimeOf(b.job);
            if ((ta > 0) !== (tb > 0)) return ta > 0 ? -1 : 1;
            if (!ta) return a.at - b.at;
            const ascending = studioQueueRank(a.job) <= 1;
            return (ascending ? ta - tb : tb - ta) || a.at - b.at;
        })
        .map((entry) => entry.job);
}
