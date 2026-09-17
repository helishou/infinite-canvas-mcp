import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import { cancelBackendTask, fetchBackendTask, startCanvasGeneration } from "../backend-api";
import { abortCanvasBrowserTask, kickCanvasBrowserTask } from "./canvas-browser-task";

/** 所有 Backend 托管生成共用：一次提交，结果只读任务终态，画布变化由 realtime ops 到达。 */
export async function observeCanvasGenerationTask(input: CanvasGenerationCommand, signal: AbortSignal, label: string, pollMs = 1000) {
    signal.throwIfAborted();
    // POST 不随观察取消中断：先拿稳定 taskId，再向 Backend 发取消，避免请求已落地但页面丢失任务身份。
    const started = await startCanvasGeneration(input);
    if (started.executor.startsWith("browser-") || started.task?.kind === "canvas-browser-script") kickCanvasBrowserTask(started.taskId);
    if (signal.aborted) {
        abortCanvasBrowserTask(started.taskId);
        await cancelBackendTask(started.taskId);
        signal.throwIfAborted();
    }
    const cancel = () => {
        abortCanvasBrowserTask(started.taskId);
        void cancelBackendTask(started.taskId).catch(() => { /* 断网时保留 Backend 权威状态。 */ });
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        for (;;) {
            const { task } = await fetchBackendTask(started.taskId, signal);
            if (!task) throw new Error(`画布${label}任务查询没有返回任务`);
            if (task.status === "succeeded") return task;
            if (task.status === "failed" || task.status === "cancelled") throw new Error(task.error || `画布${label}任务${task.status}`);
            await wait(pollMs, signal);
        }
    } finally { signal.removeEventListener("abort", cancel); }
}

function wait(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(done, ms);
        const abort = () => { window.clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason || new DOMException("Aborted", "AbortError")); };
        function done() { signal.removeEventListener("abort", abort); resolve(); }
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
    });
}
