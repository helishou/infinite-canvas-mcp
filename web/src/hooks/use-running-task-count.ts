import { useEffect, useMemo, useState } from "react";

import { fetchBackendTasks, type BackendRuntimeTask } from "@/services/backend-api";
import { taskProgress } from "@/lib/canvas/task-progress";
import { useBackendStore } from "@/stores/use-backend-store";

const POLL_INTERVAL_MS = 15000;

type ActiveTaskStatus = "running" | "queued";
type ActiveTaskGroup = { parent: BackendRuntimeTask; children: BackendRuntimeTask[] };

function isActiveStatus(status: BackendRuntimeTask["status"]): status is ActiveTaskStatus {
    return status === "running" || status === "queued";
}

/** 父任务和子任务只组成一个角标任务，状态与总进度均按父任务展示。 */
export function groupActiveTasks(tasks: BackendRuntimeTask[]): ActiveTaskGroup[] {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const groups = new Map<string, ActiveTaskGroup>();
    for (const task of tasks) {
        const parent = task.parentTaskId ? byId.get(task.parentTaskId) : undefined;
        const groupParent = parent || task;
        const group = groups.get(groupParent.id) || { parent: groupParent, children: [] };
        if (task.id !== groupParent.id) group.children.push(task);
        groups.set(groupParent.id, group);
    }
    return [...groups.values()];
}

/**
 * 画布顶栏「任务中心」角标数据：当前项目下按父任务聚合运行中 / 排队中的任务。
 * - 轮询任务列表做全量校准：后端 listTasks 只支持单状态过滤，因此 running 与 queued 各查一次；
 * - 叠加 backend-event 的 task.* 事件做即时增减，避免「任务已结束但角标还挂着」或「新任务要等 15s 才出现」。
 * 只统计当前 projectId，画布外的任务（生图/生视频页面）不会算进来。
 */
export function useRunningTaskCount(projectId: string) {
    const connected = useBackendStore((state) => state.connected);
    const [active, setActive] = useState<Map<string, BackendRuntimeTask>>(() => new Map());
    const [progressHistory, setProgressHistory] = useState<Record<string, number>>({});

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
                const next = new Map<string, BackendRuntimeTask>();
                for (const task of running.tasks || []) next.set(task.id, task);
                for (const task of queued.tasks || []) next.set(task.id, task);
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
                if (isActiveStatus(payload.status)) next.set(payload.id, payload);
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

    const groups = useMemo(() => groupActiveTasks([...active.values()]), [active]);

    useEffect(() => {
        setProgressHistory((current) => {
            let changed = false;
            const next = { ...current };
            for (const group of groups) {
                const progress = taskProgress(group.parent, group.children, current[group.parent.id]);
                if (next[group.parent.id] !== progress) {
                    next[group.parent.id] = progress;
                    changed = true;
                }
            }
            return changed ? next : current;
        });
    }, [groups]);

    let running = 0;
    let queued = 0;
    const runningProgresses: number[] = [];
    for (const group of groups) {
        if (group.parent.status === "running") {
            running += 1;
            runningProgresses.push(taskProgress(group.parent, group.children, progressHistory[group.parent.id]));
        } else if (group.parent.status === "queued") {
            queued += 1;
        }
    }
    return { running, queued, active: running + queued, runningProgresses };
}
