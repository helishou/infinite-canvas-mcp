import type { BackendRuntimeTask } from "@/services/backend-api";

/** 后端在 DLSS 插帧阶段常停滞不报进度；用已用时/预期用时给进度补一条随时间前进的下限。 */
export type TaskProgressTiming = {
    /** 已用时（毫秒）。 */
    elapsedMs: number;
    /** 预期用时（毫秒）；<=0 或非有限值时忽略时间下限。 */
    expectedMs: number;
    /** 推进起点，缺省取当前上报进度（避免一开跑就跳到固定值）。 */
    base?: number;
    /** 时间推进最多覆盖的进度区间，默认 0.09（最多再走 9 个百分点）。 */
    headroom?: number;
};

/** DLSS 插帧预期耗时（毫秒，经验值；后端没有上报该时长，可按实测调整）。 */
export const FRAME_INTERPOLATION_EXPECTED_MS = 180_000;

function hasInterpolationFlag(record: unknown): boolean {
    return Boolean(record && typeof record === "object" && (record as Record<string, unknown>).dlssFrameInterpolationEnabled === true);
}

/**
 * 任务是否启用了 DLSS 补帧。兼容标记落在 input / params / input.params / input.segments[i] 几种位置，
 * 并且只认 canvas-h3-run（插帧是 H3 出片后的后处理阶段）。
 */
export function isFrameInterpolationTask(task: BackendRuntimeTask): boolean {
    if (task.kind !== "canvas-h3-run") return false;
    const input = task.input || {};
    if (hasInterpolationFlag(input) || hasInterpolationFlag(task.params) || hasInterpolationFlag(input.params)) return true;
    const segments = input.segments;
    return Array.isArray(segments) && segments.some(hasInterpolationFlag);
}

/** 插帧任务的时间下限入参；非插帧任务返回 undefined，保持原进度行为不变。 */
export function frameInterpolationTiming(task: BackendRuntimeTask, elapsedSeconds: number): TaskProgressTiming | undefined {
    if (!isFrameInterpolationTask(task)) return undefined;
    return { elapsedMs: Math.max(0, elapsedSeconds) * 1000, expectedMs: FRAME_INTERPOLATION_EXPECTED_MS };
}

/** 总进度只增不减；父任务正式成功前最多显示 99%，成功后才显示 100%。 */
export function taskProgress(parent: BackendRuntimeTask, children: BackendRuntimeTask[], previousProgress = 0, timing?: TaskProgressTiming): number {
    const currentProgress = parent.kind === "canvas-h3-run" || !children.length
        ? parent.progress || 0
        : children.reduce((total, child) => total + (child.progress || 0), 0) / children.length;
    const reported = Math.max(previousProgress, currentProgress);
    if (parent.status === "succeeded") return 1;
    let progress = reported;
    if (timing && Number.isFinite(timing.expectedMs) && timing.expectedMs > 0 && Number.isFinite(timing.elapsedMs) && timing.elapsedMs > 0) {
        const base = timing.base ?? reported;
        const headroom = timing.headroom ?? 0.09;
        const fraction = Math.min(1, timing.elapsedMs / timing.expectedMs);
        progress = Math.max(progress, Math.min(0.99, base + fraction * headroom));
    }
    return Math.min(0.99, progress);
}
