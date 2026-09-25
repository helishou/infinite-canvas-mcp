import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Empty, Modal, Progress, Select, Tag, Tooltip, message } from "antd";
import { ChevronDown, ChevronRight, ListChecks, RefreshCw, Square } from "lucide-react";
import { backendMediaUrl, cancelBackendTask, fetchBackendProject, fetchBackendTasks, resolveBackendH3Confirmation, retryBackendTask, type BackendRuntimeTask } from "@/services/backend-api";
import { useRunningTaskCount } from "@/hooks/use-running-task-count";
import { canvasThemes } from "@/lib/canvas-theme";
import { taskProgress } from "@/lib/canvas/task-progress";
import { useThemeStore } from "@/stores/use-theme-store";

type TaskGroup = {
    parent: BackendRuntimeTask;
    children: BackendRuntimeTask[];
};

// 把平铺任务按 parentTaskId 折叠成父子组。
// 父任务不在当前列表（被状态过滤掉）的子任务当作「孤儿」独立显示，不强行建组。
function groupTasks(tasks: BackendRuntimeTask[]): TaskGroup[] {
    const idSet = new Set(tasks.map((task) => task.id));
    const childrenByParent = new Map<string, BackendRuntimeTask[]>();
    const topLevel: BackendRuntimeTask[] = [];
    for (const task of tasks) {
        if (!task.parentTaskId) {
            topLevel.push(task);
        } else if (idSet.has(task.parentTaskId)) {
            const list = childrenByParent.get(task.parentTaskId) || [];
            list.push(task);
            childrenByParent.set(task.parentTaskId, list);
        } else {
            topLevel.push(task);
        }
    }
    return topLevel.map((parent) => ({
        parent,
        children: childrenByParent.get(parent.id) || [],
    }));
}

// 折叠态摘要：让用户在不展开时也能看到子任务整体进度
function summarizeChildren(children: BackendRuntimeTask[]): string {
    if (!children.length) return "";
    const counts: Record<string, number> = {};
    for (const child of children) counts[child.status] = (counts[child.status] || 0) + 1;
    const parts: string[] = [`${children.length} 段`];
    if (counts.succeeded) parts.push(`${counts.succeeded} 完成`);
    if (counts.running) parts.push(`${counts.running} 运行`);
    if (counts.queued) parts.push(`${counts.queued} 排队`);
    if (counts.awaiting_confirmation) parts.push(`${counts.awaiting_confirmation} 待确认`);
    if (counts.failed) parts.push(`${counts.failed} 失败`);
    if (counts.cancelled) parts.push(`${counts.cancelled} 取消`);
    return parts.join(" · ");
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

function statusColor(status: BackendRuntimeTask["status"]) {
    if (status === "succeeded") return "green" as const;
    if (status === "failed") return "red" as const;
    if (status === "running") return "processing" as const;
    if (status === "queued") return "blue" as const;
    if (status === "awaiting_confirmation") return "orange" as const;
    return "default" as const;
}

function progressStatus(status: BackendRuntimeTask["status"]) {
    if (status === "failed") return "exception" as const;
    if (status === "succeeded") return "success" as const;
    return "active" as const;
}

export function CanvasTaskCenter({ open, projectId, onClose }: { open: boolean; projectId: string; onClose: () => void }) {
    const [tasks, setTasks] = useState<BackendRuntimeTask[]>([]);
    const [status, setStatus] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [progressHistory, setProgressHistory] = useState<Record<string, number>>({});
    // expanded 记录当前展开的父任务 id；userCollapsed 记录用户主动折叠的父任务 id，
    // 自动展开规则会跳过它们，避免用户折叠后被自动逻辑重新撑开
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [userCollapsed, setUserCollapsed] = useState<Set<string>>(new Set());

    const load = useCallback(async () => {
        if (!open || !projectId) return;
        setLoading(true);
        try {
            const result = await fetchBackendTasks({ projectId, status: status || undefined, limit: 100, offset: 0 });
            setTasks(result.tasks || []);
        } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
        finally { setLoading(false); }
    }, [open, projectId, status]);

    useEffect(() => { void load(); }, [load]);

    useEffect(() => {
        if (!open) return;
        const onEvent = (event: Event) => {
            const detail = (event as CustomEvent).detail as { type?: string; entityId?: string; payload?: BackendRuntimeTask } | undefined;
            if (!detail?.entityId || !detail.type?.startsWith("task.") || !detail.payload?.projectId || detail.payload.projectId !== projectId) return;
            setTasks((current) => {
                const next = current.filter((task) => task.id !== detail.entityId);
                return detail.payload && (!status || detail.payload.status === status) ? [detail.payload, ...next] : next;
            });
        };
        window.addEventListener("backend-event", onEvent);
        return () => window.removeEventListener("backend-event", onEvent);
    }, [open, projectId, status]);

    const groups = useMemo(() => groupTasks(tasks), [tasks]);

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

    // 自动展开：父或子任务处于运行/排队时默认展开；用户手动折叠的保留折叠
    useEffect(() => {
        setExpanded((current) => {
            let changed = false;
            const next = new Set(current);
            for (const group of groups) {
                if (userCollapsed.has(group.parent.id) || current.has(group.parent.id)) continue;
                const isActive = group.parent.status === "running" || group.parent.status === "queued"
                    || group.children.some((child) => child.status === "running" || child.status === "queued");
                if (isActive) {
                    next.add(group.parent.id);
                    changed = true;
                }
            }
            return changed ? next : current;
        });
    }, [groups, userCollapsed]);

    const toggleExpand = (parentId: string) => {
        if (expanded.has(parentId)) {
            setExpanded((current) => { const next = new Set(current); next.delete(parentId); return next; });
            setUserCollapsed((current) => new Set(current).add(parentId));
        } else {
            setExpanded((current) => new Set(current).add(parentId));
            setUserCollapsed((current) => { const next = new Set(current); next.delete(parentId); return next; });
        }
    };

    const cancel = async (id: string) => { try { await cancelBackendTask(id); await load(); } catch (error) { message.error(error instanceof Error ? error.message : String(error)); } };
    const retry = async (id: string) => { try { await retryBackendTask(id); await load(); message.success("已创建重试任务"); } catch (error) { message.error(error instanceof Error ? error.message : String(error)); } };
    const resolve = async (task: BackendRuntimeTask, action: "confirm" | "keep_first_pass" | "discard") => {
        const pending = task.result?.confirmation?.pending?.[0];
        if (!pending) { message.error("找不到待确认 Clip，请刷新任务"); return; }
        try {
            let postpassParams: Record<string, unknown> | undefined;
            if (action === "confirm") {
                const projectId = String(task.projectId || task.input?.projectId || "");
                const project = (await fetchBackendProject(projectId)).project as Record<string, unknown>;
                const node = (Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : []).find((item) => item.id === pending.nodeId);
                postpassParams = (Array.isArray((node?.metadata as Record<string, unknown> | undefined)?.segments)
                    ? (node!.metadata as { segments: Array<Record<string, unknown>> }).segments
                    : []).find((item) => item.id === pending.segmentId);
                if (!postpassParams) throw new Error("找不到当前 Clip 设置，请刷新任务");
            }
            await resolveBackendH3Confirmation(task.id, { action, segmentId: pending.segmentId, expectedRevision: Number(task.result?.confirmation?.revision || 0), ...(postpassParams ? { postpassParams } : {}) });
            await load();
        } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
    };

    return <Modal title="任务中心" open={open} onCancel={onClose} footer={null} width={900} destroyOnHidden>
        <div className="mb-3 flex items-center justify-between gap-3">
            <Select value={status} onChange={setStatus} className="w-40" options={[{ value: "", label: "全部状态" }, { value: "queued", label: "排队中" }, { value: "running", label: "运行中" }, { value: "awaiting_confirmation", label: "待确认" }, { value: "succeeded", label: "已完成" }, { value: "failed", label: "失败" }, { value: "cancelled", label: "已取消" }]} />
            <Button icon={<RefreshCw className="size-3.5" />} onClick={() => void load()} loading={loading}>刷新</Button>
        </div>
        {!groups.length ? <Empty description={loading ? "加载中…" : "暂无任务"} /> : <div className="max-h-[62vh] space-y-2 overflow-y-auto">
            {groups.map((group) => {
                const { parent, children } = group;
                const hasChildren = children.length > 0;
                const progress = taskProgress(parent, children, progressHistory[parent.id]);
                const isExpanded = expanded.has(parent.id);
                const terminal = TERMINAL_STATUSES.has(parent.status);
                return <div key={parent.id} className="rounded-lg border border-stone-200 dark:border-stone-700">
                    <div className="p-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                {hasChildren
                                    ? <button type="button" onClick={() => toggleExpand(parent.id)} className="flex h-5 w-5 items-center justify-center rounded text-stone-500 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800" aria-label={isExpanded ? "折叠子任务" : "展开子任务"}>
                                        {isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                                    </button>
                                    : <span className="inline-block w-5" />}
                                <Tag color={statusColor(parent.status)}>{parent.status}</Tag>
                                <Tag>{parent.kind || parent.executor || "task"}</Tag>
                                {parent.model ? <Tag>{parent.model}</Tag> : null}
                                <span className="truncate text-xs text-stone-500">{parent.id}</span>
                            </div>
                            <div className="flex shrink-0 gap-1">
                                {terminal && parent.status !== "succeeded" ? <Button type="text" size="small" icon={<RefreshCw className="size-3.5" />} onClick={() => void retry(parent.id)}>重试</Button> : null}
                                {parent.status === "awaiting_confirmation" && parent.kind === "canvas-h3-run" ? <><Button type="text" size="small" onClick={() => void resolve(parent, "confirm")}>确认二采</Button><Button type="text" size="small" onClick={() => void resolve(parent, "keep_first_pass")}>保留一采</Button><Button danger type="text" size="small" onClick={() => void resolve(parent, "discard")}>放弃</Button></> : null}
                                {!terminal && parent.status !== "awaiting_confirmation" ? <Button danger type="text" size="small" icon={<Square className="size-3.5" />} onClick={() => void cancel(parent.id)}>取消</Button> : null}
                            </div>
                        </div>
                        <Progress percent={Math.round(progress * 100)} size="small" status={progressStatus(parent.status)} />
                        <div className="flex flex-wrap gap-3 text-xs text-stone-500">
                            <span>节点：{parent.nodeId || "-"}</span>
                            <span>Clip：{parent.segmentId || "-"}</span>
                            <span>执行器：{parent.executor || "-"}</span>
                            {hasChildren ? <span className="font-medium text-stone-600 dark:text-stone-300">{summarizeChildren(children)}</span> : null}
                        </div>
                        {parent.status === "awaiting_confirmation" && parent.result?.confirmation?.pending?.[0] ? <div className="mt-2 text-xs">
                            <div>待确认 Clip：{parent.result.confirmation.pending[0].segmentId}</div>
                            {parent.result.confirmation.pending[0].firstPassStorageKey ? <video controls preload="metadata" className="mt-1 max-h-48 max-w-xs" src={backendMediaUrl(parent.result.confirmation.pending[0].firstPassStorageKey)} aria-label="H3 一采预览" /> : <span>请在 H3 节点查看一采预览</span>}
                        </div> : null}
                        {parent.error ? <div className="mt-1 break-words text-xs text-red-500">{parent.error}</div> : null}
                    </div>
                    {hasChildren && isExpanded ? <div className="relative border-t border-stone-200 dark:border-stone-700">
                        <span className="pointer-events-none absolute left-5 top-0 bottom-0 w-px bg-stone-200 dark:bg-stone-700" />
                        {children.map((child, index) => {
                            const childTerminal = TERMINAL_STATUSES.has(child.status);
                            const isLast = index === children.length - 1;
                            return <div key={child.id} className={`pl-9 pr-3 py-2 ${isLast ? "" : "border-b border-stone-100 dark:border-stone-800"}`}>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                        <Tag color={statusColor(child.status)}>{child.status}</Tag>
                                        <Tag>{child.kind || child.executor || "task"}</Tag>
                                        {child.model ? <Tag>{child.model}</Tag> : null}
                                        <span className="truncate text-xs text-stone-500">{child.id}</span>
                                    </div>
                                    <div className="flex shrink-0 gap-1">
                                        {childTerminal && child.status !== "succeeded" ? <Button type="text" size="small" icon={<RefreshCw className="size-3.5" />} onClick={() => void retry(child.id)}>重试</Button> : null}
                                        {!childTerminal && child.status !== "awaiting_confirmation" ? <Button danger type="text" size="small" icon={<Square className="size-3.5" />} onClick={() => void cancel(child.id)}>取消</Button> : null}
                                    </div>
                                </div>
                                <Progress percent={Math.round((child.progress || 0) * 100)} size="small" status={progressStatus(child.status)} />
                                <div className="flex flex-wrap gap-3 text-xs text-stone-500">
                                    <span>节点：{child.nodeId || "-"}</span>
                                    <span>Clip：{child.segmentId || "-"}</span>
                                    <span>执行器：{child.executor || "-"}</span>
                                </div>
                                {child.error ? <div className="mt-1 break-words text-xs text-red-500">{child.error}</div> : null}
                            </div>;
                        })}
                    </div> : null}
                </div>;
            })}
        </div>}
    </Modal>;
}

/**
 * 画布顶栏右上角的「任务中心」入口：按钮 + 运行中任务角标，点击打开任务中心弹窗。
 * 与「生成日志」同一层级；角标只统计当前项目里 running / queued 的任务，为 0 时不显示。
 */
export function CanvasTaskCenterButton({ projectId }: { projectId: string }) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const [open, setOpen] = useState(false);
    const { running, queued, awaiting, active, runningProgresses } = useRunningTaskCount(projectId);
    const runningProgress = runningProgresses.length ? `（${runningProgresses.map((progress) => `${Math.round(progress * 100)}%`).join("、")}）` : "";
    const overallRunningProgress = runningProgresses.length
        ? runningProgresses.reduce((total, progress) => total + progress, 0) / runningProgresses.length
        : 0;
    const tip = active || awaiting ? `任务中心 · 运行中 ${running}${runningProgress} · 排队 ${queued} · 待确认 ${awaiting}` : "任务中心";
    return <>
        <Tooltip title={tip}>
            <button type="button" aria-label={tip} className="relative grid size-8 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} onClick={() => setOpen(true)}>
                <ListChecks className="size-4" />
                {active ? <span className="absolute right-0 top-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold leading-none text-white" style={{ background: "#ff4d4f" }}>{active > 99 ? "99+" : active}</span> : null}
                {awaiting ? <span className="absolute -right-1 bottom-0 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold leading-none text-white" style={{ background: "#fa8c16" }}>{awaiting > 99 ? "99+" : awaiting}</span> : null}
                {runningProgresses.length ? <span className="absolute bottom-0 left-1/2 h-0.5 w-5 -translate-x-1/2 overflow-hidden rounded-full" style={{ background: theme.node.stroke }} aria-hidden="true">
                    <span className="block h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.round(overallRunningProgress * 100)}%`, background: theme.node.linkActive }} />
                </span> : null}
            </button>
        </Tooltip>
        <CanvasTaskCenter open={open} projectId={projectId} onClose={() => setOpen(false)} />
    </>;
}
