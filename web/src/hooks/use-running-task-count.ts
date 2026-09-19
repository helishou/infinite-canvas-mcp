import { useEffect, useState } from "react";

import { fetchBackendTasks, type BackendRuntimeTask } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";

const POLL_INTERVAL_MS = 15000;

type ActiveTaskStatus = "running" | "queued";

function isActiveStatus(status: BackendRuntimeTask["status"]): status is ActiveTaskStatus {
    return status === "running" || status === "queued";
}

/**
 * 画布顶栏「任务中心」角标数据：当前项目下运行中 / 排队中的任务数。
 * - 轮询任务列表做全量校准：后端 listTasks 只支持单状态过滤，因此 running 与 queued 各查一次；
 * - 叠加 backend-event 的 task.* 事件做即时增减，避免「任务已结束但角标还挂着」或「新任务要等 15s 才出现」。
 * 只统计当前 projectId，画布外的任务（生图/生视频页面）不会算进来。
 */
export function useRunningTaskCount(projectId: string) {
    const connected = useBackendStore((state) => state.connected);
    const [active, setActive] = useState<Map<string, ActiveTaskStatus>>(() => new Map());

    useEffect(() => {
        if (!connected || !projectId) {
            setActive(new Map());
            return undefined;
        }
        let cancelled = false;
        const sync = async () => {
            try {
                const [running, queued] = await Promise.all([
                    fetchBackendTasks({ projectId, status: "running", limit: 100, offset: 0 }),
                    fetchBackendTasks({ projectId, status: "queued", limit: 100, offset: 0 }),
                ]);
                if (cancelled) return;
                const next = new Map<string, ActiveTaskStatus>();
                for (const task of running.tasks || []) next.set(task.id, "running");
                for (const task of queued.tasks || []) next.set(task.id, "queued");
                setActive(next);
            } catch {
                // 轮询失败保留上一次结果，避免网络抖动让角标闪烁归零
            }
        };
        void sync();
        const timer = window.setInterval(() => void sync(), POLL_INTERVAL_MS);
        const onEvent = (event: Event) => {
            const detail = (event as CustomEvent).detail as { type?: string; entityId?: string; payload?: BackendRuntimeTask } | undefined;
            const payload = detail?.payload;
            if (!detail?.type?.startsWith("task.") || !detail.entityId || !payload || payload.projectId !== projectId) return;
            setActive((current) => {
                const next = new Map(current);
                if (isActiveStatus(payload.status)) next.set(payload.id, payload.status);
                else next.delete(payload.id);
                return next;
            });
        };
        window.addEventListener("backend-event", onEvent);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
            window.removeEventListener("backend-event", onEvent);
        };
    }, [connected, projectId]);

    let running = 0;
    for (const status of active.values()) if (status === "running") running += 1;
    return { running, queued: active.size - running, active: active.size };
}
