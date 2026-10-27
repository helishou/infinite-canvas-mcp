import { useTranslation } from "react-i18next";
import { abortCanvasBrowserTask, isCanvasBrowserTaskPaused, resumeCanvasBrowserTask } from "@/services/api/canvas-browser-task";
import { browserTaskRecoveryAction } from "./browser-task-recovery-view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Modal, Progress, Segmented, Select, Tag, Tooltip, message } from "antd";
import { ChevronDown, ChevronRight, FileText, ListChecks, RefreshCw, Square } from "lucide-react";
import { backendMediaUrl, cancelBackendTask, fetchBackendCanvasFolders, fetchBackendDramaEpisodes, fetchBackendProject, fetchBackendTasks, resolveBackendH3Confirmation, retryBackendTask, type BackendRuntimeTask } from "@/services/backend-api";
import { useRunningTaskCount } from "@/hooks/use-running-task-count";
import { canvasThemes } from "@/lib/canvas-theme";
import { taskProgress } from "@/lib/canvas/task-progress";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasGenerationLogDialog } from "./canvas-generation-log-dialog";

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

// 可读名称映射：节点 ID → 节点标题；Clip ID → 所属节点内序号（Clip N）。
// 数据来自项目节点 metadata.segments 的排列顺序，与 H3 工作台 Clip 卡顺序一致。
type TaskLabelMaps = {
    nodeTitles: Map<string, string>;
    clipIndexes: Map<string, number>;
};

function buildLabelMaps(nodes: Array<Record<string, unknown>>): TaskLabelMaps {
    const nodeTitles = new Map<string, string>();
    const clipIndexes = new Map<string, number>();
    for (const node of nodes) {
        if (typeof node.id !== "string") continue;
        const title = typeof node.title === "string" && node.title.trim() ? node.title.trim() : null;
        if (title) nodeTitles.set(node.id, title);
        const metadata = (node.metadata || {}) as { segments?: Array<{ id?: unknown }> };
        const segments = Array.isArray(metadata.segments) ? metadata.segments : [];
        segments.forEach((segment, index) => {
            if (segment && typeof segment.id === "string") clipIndexes.set(segment.id, index + 1);
        });
    }
    return { nodeTitles, clipIndexes };
}

function nodeLabel(task: { nodeId?: string | null }, labels: TaskLabelMaps): string {
    if (!task.nodeId) return "-";
    return labels.nodeTitles.get(task.nodeId) || task.nodeId;
}

function clipLabel(task: { nodeId?: string | null; segmentId?: string | null }, labels: TaskLabelMaps): string {
    if (!task.segmentId) return "-";
    const index = labels.clipIndexes.get(task.segmentId);
    if (index) return `Clip ${index}`;
    return task.segmentId;
}

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

// 模型标签只保留文件名，去掉 "H3\dir\..." 这类路径前缀
function modelShortName(model?: string | null): string | undefined {
    if (!model) return undefined;
    const parts = model.split(/[\\/]/);
    return parts[parts.length - 1] || model;
}

type CanvasChoice = { id: string; label: string };
const ALL_CANVASES = "__all_drama_canvases__";

export function CanvasTaskCenter({ open, projectId, dramaId, onClose }: { open: boolean; projectId: string; dramaId?: string | null; onClose: () => void }) {
    const { t } = useTranslation();
    const [locallyPaused, setLocallyPaused] = useState(new Set<string>());
    const recoveryAction = (task: BackendRuntimeTask) => browserTaskRecoveryAction({ ...task, locallyPaused: locallyPaused.has(task.id) || isCanvasBrowserTaskPaused(task.id) });
    const retryingRef = useRef(new Set<string>());
    const [retryingIds, setRetryingIds] = useState(new Set<string>());
    const [tasks, setTasks] = useState<BackendRuntimeTask[]>([]);
    const [status, setStatus] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [progressHistory, setProgressHistory] = useState<Record<string, number>>({});
    const [labels, setLabels] = useState<TaskLabelMaps>({ nodeTitles: new Map(), clipIndexes: new Map() });
    // expanded 记录当前展开的父任务 id；userCollapsed 记录用户主动折叠的父任务 id，
    // 自动展开规则会跳过它们，避免用户折叠后被自动逻辑重新撑开
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [userCollapsed, setUserCollapsed] = useState<Set<string>>(new Set());
    const [view, setView] = useState<"tasks" | "logs">("tasks");
    const [canvasFilter, setCanvasFilter] = useState(projectId);
    const [canvases, setCanvases] = useState<CanvasChoice[]>([{ id: projectId, label: projectId }]);
    const [logRefreshKey, setLogRefreshKey] = useState(0);

    useEffect(() => {
        setCanvasFilter(projectId);
        setCanvases([{ id: projectId, label: projectId }]);
        if (!dramaId) return;
        let active = true;
        void Promise.all([fetchBackendDramaEpisodes(dramaId), fetchBackendCanvasFolders()]).then(([episodeResult, folderResult]) => {
            if (!active) return;
            const folder = (folderResult.folders || []).find(item => item.id === dramaId);
            const choices: CanvasChoice[] = [];
            const sharedId = String(folder?.sharedAssetCanvasId || "");
            if (sharedId) choices.push({ id: sharedId, label: "全剧共享素材" });
            for (const episode of episodeResult.episodes || []) if (episode.canvasId) choices.push({ id: episode.canvasId, label: `第${episode.episodeNumber}集 · ${episode.title}` });
            if (!choices.some(choice => choice.id === projectId)) choices.unshift({ id: projectId, label: "当前画布" });
            setCanvases(choices);
        }).catch(error => { if (active) message.error(String(error)); });
        return () => { active = false; };
    }, [dramaId, projectId]);

    const selectedCanvas = canvases.find(canvas => canvas.id === canvasFilter) || canvases[0];
    const selectedProjectIds = useMemo(() => canvasFilter === ALL_CANVASES ? canvases.map(canvas => canvas.id) : [canvasFilter], [canvasFilter, canvases]);

    const load = useCallback(async () => {
        if (!open || !projectId) return;
        setLoading(true);
        try {
            const results = await Promise.all(selectedProjectIds.map(async id => {
                const [taskResult, projectResult] = await Promise.all([
                    fetchBackendTasks({ projectId: id, status: status || undefined, limit: 100, offset: 0 }),
                    fetchBackendProject(id).catch(() => null),
                ]);
                return { id, tasks: taskResult.tasks || [], project: projectResult?.project };
            }));
            setTasks(results.flatMap(result => result.tasks).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
            const nodeTitles = new Map<string, string>(), clipIndexes = new Map<string, number>();
            for (const result of results) {
                if (!result.project) continue;
                const names = buildLabelMaps(Array.isArray(result.project.nodes) ? result.project.nodes as Array<Record<string, unknown>> : []);
                names.nodeTitles.forEach((value, key) => nodeTitles.set(key, value));
                names.clipIndexes.forEach((value, key) => clipIndexes.set(key, value));
            }
            setLabels({ nodeTitles, clipIndexes });
        } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
        finally { setLoading(false); }
    }, [open, canvasFilter, status, projectId, dramaId, selectedProjectIds]);

    useEffect(() => { void load(); }, [load]);

    useEffect(() => {
        if (!open) return;
        const onEvent = (event: Event) => {
            const detail = (event as CustomEvent).detail as { type?: string; entityId?: string; payload?: BackendRuntimeTask } | undefined;
            if (!detail?.entityId || !detail.type?.startsWith("task.") || !detail.payload?.projectId || !selectedProjectIds.includes(detail.payload.projectId)) return;
            setTasks((current) => {
                const next = current.filter((task) => task.id !== detail.entityId);
                return detail.payload && (!status || detail.payload.status === status) ? [detail.payload, ...next] : next;
            });
        };
        window.addEventListener("backend-event", onEvent);
        return () => window.removeEventListener("backend-event", onEvent);
    }, [open, selectedProjectIds, status]);

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

    const cancel = async (id: string) => { try { setLocallyPaused(current => new Set(current).add(id)); abortCanvasBrowserTask(id); await cancelBackendTask(id); await load(); } catch (error) { message.error(error instanceof Error ? error.message : String(error)); } };
    const resumeLocal = (id: string) => { setLocallyPaused(current => { const next=new Set(current);next.delete(id);return next; }); resumeCanvasBrowserTask(id); };
    const retry = async (id: string) => { if (retryingRef.current.has(id)) return; retryingRef.current.add(id); setRetryingIds(new Set(retryingRef.current)); try { const response = await retryBackendTask(id); if (response.task?.id === id) resumeLocal(id); await load(); message.success(response.task?.id === id ? t("browserRecovery.resumed") : t("browserRecovery.created")); } catch (error) { message.error(error instanceof Error ? error.message : String(error)); } finally { retryingRef.current.delete(id); setRetryingIds(new Set(retryingRef.current)); } };
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

    return <Modal title="任务与生成日志" open={open} onCancel={onClose} footer={null} width={900} destroyOnHidden>
        <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Segmented value={view} onChange={value => setView(value as "tasks" | "logs")} options={[{ value: "tasks", label: "任务" }, { value: "logs", label: <span className="inline-flex items-center gap-1"><FileText className="size-3.5" />生成日志</span> }]} />
                <Select value={canvasFilter} onChange={setCanvasFilter} className="min-w-48 max-w-72" options={[...(dramaId ? [{ value: ALL_CANVASES, label: "全部画布" }] : []), ...canvases.map(canvas => ({ value: canvas.id, label: canvas.label }))]} />
                {view === "tasks" ? <Select value={status} onChange={setStatus} className="w-36" options={[{ value: "", label: "全部状态" }, { value: "queued", label: "排队中" }, { value: "running", label: "运行中" }, { value: "awaiting_confirmation", label: "待确认" }, { value: "succeeded", label: "已完成" }, { value: "failed", label: "失败" }, { value: "cancelled", label: "已取消" }]} /> : null}
            </div>
            <Button icon={<RefreshCw className="size-3.5" />} onClick={() => view === "logs" ? setLogRefreshKey(value => value + 1) : void load()} loading={view === "tasks" && loading}>刷新</Button>
        </div>
        {view === "logs" ? <CanvasGenerationLogDialog key={`logs:${canvasFilter}:${logRefreshKey}`} open projectId={canvasFilter === ALL_CANVASES ? "" : canvasFilter} projectIds={canvasFilter === ALL_CANVASES ? selectedProjectIds : undefined} onClose={onClose} embedded canvasLabel={canvasFilter === ALL_CANVASES ? "全部画布" : selectedCanvas?.label || canvasFilter} canvasLabels={Object.fromEntries(canvases.map(canvas => [canvas.id, canvas.label]))} /> : <>
        {!groups.length ? <Empty description={loading ? "加载中…" : "暂无任务"} /> : <div className="max-h-[62vh] space-y-2 overflow-y-auto">
            {groups.map((group) => {
                const { parent, children } = group;
                const hasChildren = children.length > 0;
                const progress = taskProgress(parent, children, progressHistory[parent.id]);
                const isExpanded = expanded.has(parent.id);
                const terminal = TERMINAL_STATUSES.has(parent.status);
                return <div key={parent.id} className="rounded-lg border border-border">
                    <div className="p-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                {hasChildren
                                    ? <button type="button" onClick={() => toggleExpand(parent.id)} className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted dark:hover:bg-muted" aria-label={isExpanded ? "折叠子任务" : "展开子任务"}>
                                        {isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                                    </button>
                                    : <span className="inline-block w-5" />}
                                <Tag color={statusColor(parent.status)}>{recoveryAction(parent) ? t("browserRecovery.unknown") : parent.status}</Tag>
                                <Tag>{canvases.find(canvas => canvas.id === parent.projectId)?.label || selectedCanvas?.label || canvasFilter}</Tag>
                                <Tag>{parent.kind || parent.executor || "task"}</Tag>
                                {modelShortName(parent.model) ? <Tag title={parent.model}>{modelShortName(parent.model)}</Tag> : null}
                                <span className="truncate text-xs text-muted-foreground">{parent.id}</span>
                            </div>
                            <div className="flex shrink-0 gap-1">
                                {recoveryAction(parent) === "blocked" ? <span className="max-w-52 text-xs text-muted-foreground">{t("browserRecovery.checkProvider")}</span> : recoveryAction(parent) ? <Button type="text" size="small" loading={retryingIds.has(parent.id)} icon={<RefreshCw className="size-3.5" />} onClick={() => recoveryAction(parent) === "check" ? resumeLocal(parent.id) : void retry(parent.id)}>{t(`browserRecovery.${recoveryAction(parent)}`)}</Button> : terminal && parent.status !== "succeeded" ? <Button type="text" size="small" loading={retryingIds.has(parent.id)} icon={<RefreshCw className="size-3.5" />} onClick={() => void retry(parent.id)}>重试</Button> : null}
                                {parent.status === "awaiting_confirmation" && parent.kind === "canvas-h3-run" ? <><Button type="text" size="small" onClick={() => void resolve(parent, "confirm")}>确认二采</Button><Button type="text" size="small" onClick={() => void resolve(parent, "keep_first_pass")}>保留一采</Button><Button danger type="text" size="small" onClick={() => void resolve(parent, "discard")}>放弃</Button></> : null}
                                {!terminal && parent.status !== "awaiting_confirmation" ? <Button danger type="text" size="small" icon={<Square className="size-3.5" />} onClick={() => void cancel(parent.id)}>取消</Button> : null}
                            </div>
                        </div>
                        <Progress percent={Math.round(progress * 100)} size="small" status={progressStatus(parent.status)} />
                        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                            <span>节点：<span title={parent.nodeId || ""}>{nodeLabel(parent, labels)}</span></span>
                            <span>Clip：<span title={parent.segmentId || ""}>{clipLabel(parent, labels)}</span></span>
                            <span>执行器：{parent.executor || "-"}</span>
                            {hasChildren ? <span className="font-medium text-muted-foreground">{summarizeChildren(children)}</span> : null}
                        </div>
                        {parent.status === "awaiting_confirmation" && parent.result?.confirmation?.pending?.[0] ? <div className="mt-2 text-xs">
                            <div>待确认 Clip：{parent.result.confirmation.pending[0].segmentId}</div>
                            {parent.result.confirmation.pending[0].firstPassStorageKey ? <video controls preload="metadata" className="mt-1 max-h-48 max-w-xs" src={backendMediaUrl(parent.result.confirmation.pending[0].firstPassStorageKey)} aria-label="H3 一采预览" /> : <span>请在 H3 节点查看一采预览</span>}
                        </div> : null}
                        {parent.error ? <div className="mt-1 break-words text-xs text-red-500">{parent.error}</div> : null}
                    </div>
                    {hasChildren && isExpanded ? <div className="relative border-t border-border">
                        <span className="pointer-events-none absolute left-5 top-0 bottom-0 w-px bg-muted " />
                        {children.map((child, index) => {
                            const childTerminal = TERMINAL_STATUSES.has(child.status);
                            const isLast = index === children.length - 1;
                            return <div key={child.id} className={`pl-9 pr-3 py-2 ${isLast ? "" : "border-b border-border "}`}>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                        <Tag color={statusColor(child.status)}>{recoveryAction(child) ? t("browserRecovery.unknown") : child.status}</Tag>
                                        <Tag>{child.kind || child.executor || "task"}</Tag>
                                        {modelShortName(child.model) ? <Tag title={child.model}>{modelShortName(child.model)}</Tag> : null}
                                        <span className="truncate text-xs text-muted-foreground">{child.id}</span>
                                    </div>
                                    <div className="flex shrink-0 gap-1">
                                        {recoveryAction(child) === "blocked" ? <span className="max-w-52 text-xs text-muted-foreground">{t("browserRecovery.checkProvider")}</span> : recoveryAction(child) ? <Button type="text" size="small" loading={retryingIds.has(child.id)} icon={<RefreshCw className="size-3.5" />} onClick={() => recoveryAction(child) === "check" ? resumeLocal(child.id) : void retry(child.id)}>{t(`browserRecovery.${recoveryAction(child)}`)}</Button> : childTerminal && child.status !== "succeeded" ? <Button type="text" size="small" loading={retryingIds.has(child.id)} icon={<RefreshCw className="size-3.5" />} onClick={() => void retry(child.id)}>重试</Button> : null}
                                        {!childTerminal && child.status !== "awaiting_confirmation" ? <Button danger type="text" size="small" icon={<Square className="size-3.5" />} onClick={() => void cancel(child.id)}>取消</Button> : null}
                                    </div>
                                </div>
                                <Progress percent={Math.round((child.progress || 0) * 100)} size="small" status={progressStatus(child.status)} />
                                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                                    <span>节点：<span title={child.nodeId || ""}>{nodeLabel(child, labels)}</span></span>
                                    <span>Clip：<span title={child.segmentId || ""}>{clipLabel(child, labels)}</span></span>
                                    <span>执行器：{child.executor || "-"}</span>
                                </div>
                                {child.error ? <div className="mt-1 break-words text-xs text-red-500">{child.error}</div> : null}
                            </div>;
                        })}
                    </div> : null}
                </div>;
            })}
        </div>}
        </>}
    </Modal>;
}

/**
 * 画布顶栏右上角的「任务中心」入口：按钮 + 运行中任务角标，点击打开任务中心弹窗。
 * 与「生成日志」同一层级；角标只统计当前项目里 running / queued 的任务，为 0 时不显示。
 */
export function CanvasTaskCenterButton({ projectId, dramaId }: { projectId: string; dramaId?: string | null }) {
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
                {active ? <span className="absolute right-0 top-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[11px] font-semibold leading-none text-white" style={{ background: "#ff4d4f" }}>{active > 99 ? "99+" : active}</span> : null}
                {awaiting ? <span className="absolute -right-1 bottom-0 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[11px] font-semibold leading-none text-white" style={{ background: "#fa8c16" }}>{awaiting > 99 ? "99+" : awaiting}</span> : null}
                {runningProgresses.length ? <span className="absolute bottom-0 left-1/2 h-0.5 w-5 -translate-x-1/2 overflow-hidden rounded-full" style={{ background: theme.node.stroke }} aria-hidden="true">
                    <span className="block h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.round(overallRunningProgress * 100)}%`, background: theme.node.linkActive }} />
                </span> : null}
            </button>
        </Tooltip>
        <CanvasTaskCenter open={open} projectId={projectId} dramaId={dramaId} onClose={() => setOpen(false)} />
    </>;
}
