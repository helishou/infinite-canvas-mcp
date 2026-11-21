import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { fetchBackendGenerationLogs, fetchBackendTasks, type BackendGenerationLog, type BackendRuntimeTask } from "@/services/backend-api";
import { frameInterpolationTiming, isFrameInterpolationTask, taskProgress } from "@/lib/canvas/task-progress";
import { useBackendStore } from "@/stores/use-backend-store";
import { useTaskConfirmationStore } from "@/stores/use-task-confirmation-store";
import { taskConfirmationReminders } from "@/lib/confirmation-reminders";

const POLL_INTERVAL_MS = 15000;

type ActiveTaskStatus = "running" | "queued" | "awaiting_confirmation";
type ActiveTaskGroup = { parent: BackendRuntimeTask; children: BackendRuntimeTask[] };

function isActiveStatus(status: BackendRuntimeTask["status"]): status is ActiveTaskStatus {
    return status === "running" || status === "queued" || status === "awaiting_confirmation";
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
    const activeRef = useRef(active);
    const [progressHistory, setProgressHistory] = useState<Record<string, number>>({});
    useEffect(() => () => useTaskConfirmationStore.getState().clear(projectId), [projectId]);

    useEffect(() => {
        if (!connected || !projectId) {
            activeRef.current = new Map();
            setActive(new Map());
            return undefined;
        }
        let cancelled = false;
        const sync = async () => {
            try {
                const [running, queued, awaiting] = await Promise.all([
                    fetchBackendTasks({ projectId, status: "running", limit: 100, offset: 0 }),
                    fetchBackendTasks({ projectId, status: "queued", limit: 100, offset: 0 }),
                    fetchBackendTasks({ projectId, status: "awaiting_confirmation", limit: 100, offset: 0 }),
                ]);
                if (cancelled) return;
                const next = new Map<string, BackendRuntimeTask>();
                for (const task of running.tasks || []) next.set(task.id, task);
                for (const task of queued.tasks || []) next.set(task.id, task);
                for (const task of awaiting.tasks || []) next.set(task.id, task);
                activeRef.current = next;
                setActive(next);
                useTaskConfirmationStore.getState().setSnapshot(projectId, taskConfirmationReminders([...next.values()], projectId));
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
            const next = new Map(activeRef.current);
            if (isActiveStatus(payload.status)) next.set(payload.id, payload);
            else next.delete(payload.id);
            activeRef.current = next; setActive(next);
            useTaskConfirmationStore.getState().setSnapshot(projectId, taskConfirmationReminders([...next.values()], projectId));
        };
        window.addEventListener("backend-event", onEvent);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
            window.removeEventListener("backend-event", onEvent);
        };
    }, [connected, projectId]);

    const groups = useMemo(() => groupActiveTasks([...active.values()]), [active]);

    // 插帧任务后端进度会长时间停滞；用最早一个运行中插帧任务的 createdAt 作锚，
    // 复用 useElapsedSeconds 的 1s tick 给角标进度补一条随时间前进的下限。
    const interpolationAnchor = useMemo(() => {
        let earliest: string | undefined;
        for (const group of groups) {
            const createdAt = group.parent.createdAt;
            if (group.parent.status !== "running" || !createdAt || !isFrameInterpolationTask(group.parent)) continue;
            if (!earliest || Date.parse(createdAt) < Date.parse(earliest)) earliest = createdAt;
        }
        return earliest;
    }, [groups]);
    const interpolationElapsedSeconds = useElapsedSeconds(interpolationAnchor, Boolean(interpolationAnchor));

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
    let awaiting = 0;
    const runningProgresses: number[] = [];
    for (const group of groups) {
        if (group.parent.status === "running") {
            running += 1;
            runningProgresses.push(taskProgress(group.parent, group.children, progressHistory[group.parent.id], frameInterpolationTiming(group.parent, interpolationElapsedSeconds)));
        } else if (group.parent.status === "queued") {
            queued += 1;
        } else if (group.parent.status === "awaiting_confirmation") {
            awaiting += 1;
        }
    }
    return { running, queued, awaiting, active: running + queued, runningProgresses };
}

// ── 生成计时（画布总计时 / 卡片计时 / 列表行耗时）──────────────────────────
// 真值：tasks.created_at（跨刷新稳定）作为计时锚；generation_logs.duration_ms/finished_at 终态直接读。
// 单一 per-project 外部存储 + 15s 轮询 + task.* SSE，多个订阅组件共享一次拉取，按 task.id 独立维护。

type TimingSnapshot = { active: Map<string, BackendRuntimeTask>; logs: BackendGenerationLog[] };
const EMPTY_TIMING: TimingSnapshot = { active: new Map(), logs: [] };
const timingStores = new Map<string, ReturnType<typeof createTimingStore>>();

function createTimingStore(projectId: string) {
    const listeners = new Set<() => void>();
    let snapshot: TimingSnapshot = EMPTY_TIMING;
    let refCount = 0;
    let timer: number | undefined;
    let removeConnection: (() => void) | undefined;
    let syncing = false;

    const emit = () => listeners.forEach((listener) => listener());

    const sync = async () => {
        if (!projectId || syncing || !useBackendStore.getState().connected) return;
        syncing = true;
        try {
            const [running, queued, awaiting, logPage] = await Promise.all([
                fetchBackendTasks({ projectId, status: "running", limit: 100, offset: 0 }),
                fetchBackendTasks({ projectId, status: "queued", limit: 100, offset: 0 }),
                fetchBackendTasks({ projectId, status: "awaiting_confirmation", limit: 100, offset: 0 }),
                fetchBackendGenerationLogs({ projectId, limit: 200, offset: 0 }),
            ]);
            const active = new Map<string, BackendRuntimeTask>();
            for (const task of running.tasks || []) active.set(task.id, task);
            for (const task of queued.tasks || []) active.set(task.id, task);
            for (const task of awaiting.tasks || []) active.set(task.id, task);
            snapshot = { active, logs: logPage.logs || [] };
            emit();
        } catch {
            // 轮询失败保留上一次快照，避免计时闪烁归零
        } finally {
            syncing = false;
        }
    };

    const onEvent = (event: Event) => {
        const detail = (event as CustomEvent).detail as { type?: string; entityId?: string; payload?: BackendRuntimeTask } | undefined;
        const payload = detail?.payload;
        if (!detail?.type?.startsWith("task.") || !payload || payload.projectId !== projectId) return;
        const next = new Map(snapshot.active);
        if (isActiveStatus(payload.status)) next.set(payload.id, payload);
        else next.delete(payload.id);
        snapshot = { ...snapshot, active: next };
        emit();
        // 终态（完成/取消/失败）已从 active 移除并停表；补一次日志刷新以拿到 duration_ms 真值。
        if (!isActiveStatus(payload.status)) {
            void fetchBackendGenerationLogs({ projectId, limit: 200, offset: 0 })
                .then((page) => { snapshot = { ...snapshot, logs: page.logs || [] }; emit(); })
                .catch(() => {});
        }
    };

    const start = () => {
        if (timer !== undefined) return;
        void sync();
        timer = window.setInterval(() => void sync(), POLL_INTERVAL_MS);
        window.addEventListener("backend-event", onEvent);
        removeConnection = useBackendStore.subscribe((state, previous) => {
            if (state.connected && !previous.connected) void sync();
            if (!state.connected && previous.connected) { snapshot = EMPTY_TIMING; emit(); }
        });
    };
    const stop = () => {
        if (timer !== undefined) window.clearInterval(timer);
        timer = undefined;
        window.removeEventListener("backend-event", onEvent);
        removeConnection?.();
        removeConnection = undefined;
        snapshot = EMPTY_TIMING;
    };

    return {
        subscribe(listener: () => void) {
            listeners.add(listener);
            refCount += 1;
            if (refCount === 1) start();
            return () => {
                listeners.delete(listener);
                refCount -= 1;
                if (refCount <= 0) { stop(); timingStores.delete(projectId); }
            };
        },
        getSnapshot: () => snapshot,
    };
}

/** 当前项目的活跃任务 + 生成日志快照；多个组件共享同一轮询/SSE，不额外起定时器。 */
export function useCanvasTaskTiming(projectId: string): TimingSnapshot {
    let store = timingStores.get(projectId);
    if (!store) { store = createTimingStore(projectId); timingStores.set(projectId, store); }
    return useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY_TIMING);
}

/** 活跃任务中最早的创建时间：总计时从第一个任务创建起算（排队时间计入）。 */
export function earliestActiveCreatedAt(active: Map<string, BackendRuntimeTask>): string | undefined {
    let earliest: BackendRuntimeTask | undefined;
    for (const task of active.values()) {
        if (!task.createdAt) continue;
        if (!earliest || Date.parse(task.createdAt) < Date.parse(earliest.createdAt!)) earliest = task;
    }
    return earliest?.createdAt;
}

/** 某节点最早仍在活跃的任务创建时间：本卡计时锚点。 */
export function nodeActiveCreatedAt(active: Map<string, BackendRuntimeTask>, nodeId: string): string | undefined {
    let earliest: BackendRuntimeTask | undefined;
    for (const task of active.values()) {
        if (task.nodeId !== nodeId || !task.createdAt) continue;
        if (!earliest || Date.parse(task.createdAt) < Date.parse(earliest.createdAt!)) earliest = task;
    }
    return earliest?.createdAt;
}

/** 某节点最近一条终态生成日志的 durationMs（真值，直接读，不再计算）。 */
export function nodeLastLogDurationMs(logs: BackendGenerationLog[], nodeId: string): number | undefined {
    let latest: BackendGenerationLog | undefined;
    for (const log of logs) {
        if (log.nodeId !== nodeId || log.status === "running" || log.status === "queued") continue;
        if (!Number.isFinite(Date.parse(log.finishedAt || log.createdAt))) continue;
        if (!latest || Date.parse(log.finishedAt || log.createdAt) >= Date.parse(latest.finishedAt || latest.createdAt)) latest = log;
    }
    return latest && Number.isFinite(latest.durationMs) ? Math.max(0, latest.durationMs) : undefined;
}

/** 与生成日志弹窗一致的耗时格式：毫秒取整到秒。 */
export function formatDurationMs(ms: number): string {
    return `${Math.round(ms / 1000)}s`;
}

/**
 * 秒级跳动计时。以服务端 createdAt 为锚：仅在锚点变化（含刷新后按后端 createdAt 重新锚定）
 * 时算一次基线并 clamp 到 >=0；其间用本地单调时钟推进，避免无校准端点下的负数/跳变与归零。
 */
export function useElapsedSeconds(createdAt: string | undefined, enabled = true): number {
    const [elapsedMs, setElapsedMs] = useState(0);
    useEffect(() => {
        if (!enabled || !createdAt) { setElapsedMs(0); return undefined; }
        const serverMs = Date.parse(createdAt);
        const baseMs = Number.isFinite(serverMs) ? Math.max(0, Date.now() - serverMs) : 0;
        const startedAt = performance.now();
        setElapsedMs(baseMs);
        const id = window.setInterval(() => setElapsedMs(baseMs + Math.max(0, performance.now() - startedAt)), 1000);
        return () => window.clearInterval(id);
    }, [createdAt, enabled]);
    return Math.floor(elapsedMs / 1000);
}
