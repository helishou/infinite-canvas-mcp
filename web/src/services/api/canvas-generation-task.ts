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
    let cancellation: Promise<unknown> | undefined;
    const cancel = () => {
        abortCanvasBrowserTask(started.taskId);
        // Keep the local request alive until Backend confirms cancellation. Otherwise
        // the UI can submit again while the original task still occupies its target.
        cancellation = cancelBackendTask(started.taskId);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        for (;;) {
            const { task } = await fetchBackendTask(started.taskId, signal);
            if (!task) throw new Error(`画布${label}任务查询没有返回任务`);
            if (task.status === "succeeded" || task.status === "awaiting_confirmation") return task;
            if (task.status === "failed" || task.status === "cancelled") throw new Error(task.error || `画布${label}任务${task.status}`);
            await wait(pollMs, signal, started.taskId);
        }
    } finally {
        signal.removeEventListener("abort", cancel);
        if (cancellation) await cancellation;
    }
}

/**
 * 等一个轮询间隔；期间如果 SSE 推来同一个任务的事件就立刻醒来。
 * 轮询保留为兜底（SSE 断流时仍然能收敛），但正常路径不再白等 1s。
 */
function wait(ms: number, signal: AbortSignal, taskId?: string) {
    return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(done, ms);
        const onEvent = (event: Event) => {
            const detail = (event as CustomEvent<{ type?: string; entityId?: string }>).detail;
            if (!detail || !taskId || detail.entityId !== taskId) return;
            if (detail.type && !detail.type.startsWith("task.")) return;
            done();
        };
        const abort = () => { window.clearTimeout(timer); signal.removeEventListener("abort", abort); window.removeEventListener("backend-event", onEvent); reject(signal.reason || new DOMException("Aborted", "AbortError")); };
        function done() { window.clearTimeout(timer); signal.removeEventListener("abort", abort); window.removeEventListener("backend-event", onEvent); resolve(); }
        signal.addEventListener("abort", abort, { once: true });
        if (taskId) window.addEventListener("backend-event", onEvent);
        if (signal.aborted) abort();
    });
}
