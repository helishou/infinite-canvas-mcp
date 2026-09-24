import type { BackendRuntimeTask } from "@/services/backend-api";

/** 总进度只增不减；父任务正式成功前最多显示 99%，成功后才显示 100%。 */
export function taskProgress(parent: BackendRuntimeTask, children: BackendRuntimeTask[], previousProgress = 0): number {
    const currentProgress = parent.kind === "canvas-h3-run" || !children.length
        ? parent.progress || 0
        : children.reduce((total, child) => total + (child.progress || 0), 0) / children.length;
    const monotonicProgress = Math.max(previousProgress, currentProgress);
    if (parent.status === "succeeded") return 1;
    return Math.min(0.99, monotonicProgress);
}
