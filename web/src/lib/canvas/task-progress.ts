import type { BackendRuntimeTask } from "@/services/backend-api";

/** 总进度只增不减；父任务正式成功前最多显示 99%，成功后才显示 100%。 */
export function taskProgress(parent: BackendRuntimeTask, children: BackendRuntimeTask[], previousProgress = 0): number {
    const currentProgress = children.length
        ? children.reduce((total, child) => total + (child.progress || 0), 0) / children.length
        : parent.progress || 0;
    const monotonicProgress = Math.max(previousProgress, currentProgress);
    if (parent.status === "succeeded" || previousProgress >= 1) return 1;
    return Math.min(0.99, monotonicProgress);
}
