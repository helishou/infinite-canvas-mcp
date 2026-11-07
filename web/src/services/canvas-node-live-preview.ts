import { useEffect, useState } from "react";
import { fetchBackendTask, type BackendTaskLivePreview } from "@/services/backend-api";

/**
 * 画布节点的生成态预览帧：按 metadata.runtimeTaskId 共享轮询。
 *
 * 后端把工作流子任务的帧同时登记在子任务 id 与画布父任务 id 下，
 * 所以节点只认自己的 runtimeTaskId 就够，不需要反查 `video-workflow-child-*`。
 * 多个节点指向同一任务时复用一个轮询器；任务终态或无人订阅立即停止。
 * 帧只在内存里，绝不写回节点 metadata / 产物 / 归档。
 */
export type CanvasNodeLivePreview = BackendTaskLivePreview;

const POLL_INTERVAL_MS = 1500;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "awaiting_confirmation"]);

const cache = new Map<string, CanvasNodeLivePreview | null>();
const listeners = new Map<string, Set<(frame: CanvasNodeLivePreview | null) => void>>();
const pollers = new Map<string, { stop: () => void }>();

function emit(taskId: string, frame: CanvasNodeLivePreview | null) {
    const previous = cache.get(taskId) || null;
    // 1.5s 轮询会反复拿到同一帧，去重避免节点无意义重渲染。
    if (previous?.dataUrl === frame?.dataUrl && previous?.step === frame?.step) return;
    cache.set(taskId, frame);
    for (const listener of listeners.get(taskId) || []) listener(frame);
}

function ensurePoller(taskId: string) {
    if (pollers.has(taskId)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        pollers.delete(taskId);
    };
    const tick = async () => {
        if (stopped || !listeners.get(taskId)?.size) return stop();
        try {
            const result = await fetchBackendTask(taskId);
            if (stopped) return;
            const task = result.task;
            if (task && TERMINAL_STATUSES.has(task.status)) {
                emit(taskId, null);
                return stop();
            }
            if (result.preview?.dataUrl) emit(taskId, result.preview);
        } catch { /* 短暂查询失败只跳过本轮，不影响生成 */ }
        if (!stopped) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    pollers.set(taskId, { stop });
    void tick();
}

export function useCanvasNodeLivePreview(taskId: string | undefined, active: boolean): CanvasNodeLivePreview | null {
    const [frame, setFrame] = useState<CanvasNodeLivePreview | null>(null);
    useEffect(() => {
        if (!active || !taskId) {
            setFrame(null);
            return;
        }
        setFrame(cache.get(taskId) || null);
        let subscribers = listeners.get(taskId);
        if (!subscribers) {
            subscribers = new Set();
            listeners.set(taskId, subscribers);
        }
        const listener = (next: CanvasNodeLivePreview | null) => setFrame(next);
        subscribers.add(listener);
        ensurePoller(taskId);
        return () => {
            subscribers.delete(listener);
            if (!subscribers.size) {
                listeners.delete(taskId);
                pollers.get(taskId)?.stop();
                cache.delete(taskId);
            }
        };
    }, [taskId, active]);
    return active ? frame : null;
}
