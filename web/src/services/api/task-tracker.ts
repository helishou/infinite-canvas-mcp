import { fetchBackendTask, type BackendRuntimeTask } from "@/services/backend-api";

export type TaskProgress = {
    taskId: string;
    status: BackendRuntimeTask["status"];
    /** 0–1，后端未上报时为 undefined。 */
    progress?: number;
    error?: string;
    task?: BackendRuntimeTask;
};

/**
 * 不阻塞 UI 的任务跟踪：每次轮询都把状态回调出去，由界面自行显示进度。
 * RunningHub 和本地 ComfyUI 的任务都在 Backend 统一任务端点下，所以共用这一个跟踪器。
 * 返回的取消函数同时停止轮询并通知调用方，以便把「取消」按钮接上。
 */
export function trackTask(
    taskId: string,
    onUpdate: (state: TaskProgress) => void,
    options?: { intervalMs?: number; onTerminal?: (state: TaskProgress) => void },
) {
    const interval = options?.intervalMs ?? 1500;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (state: TaskProgress) => {
        stopped = true;
        options?.onTerminal?.(state);
    };

    const tick = async () => {
        if (stopped) return;
        try {
            const { task } = await fetchBackendTask(taskId);
            if (!task) {
                finish({ taskId, status: "failed", error: "任务不存在" });
                return;
            }
            const state: TaskProgress = { taskId, status: task.status, progress: task.progress, error: task.error || undefined, task };
            onUpdate(state);
            if (task.status === "succeeded") return finish(state);
            if (task.status === "failed" || task.status === "cancelled") return finish(state);
        } catch (error) {
            // 单次轮询失败不立刻判死：网络抖动下继续重试，超时上限由调用方决定。
            onUpdate({ taskId, status: "running", error: error instanceof Error ? error.message : String(error) });
        }
        if (!stopped) timer = setTimeout(() => void tick(), interval);
    };

    void tick();

    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
        },
    };
}