import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Drawer, Empty, Input, Modal, Popconfirm, Progress, Segmented, Skeleton, Tag, Tooltip } from "antd";
import { ArrowRight, Bookmark, BookmarkCheck, Clapperboard, ImagePlus, LayoutGrid, List, ListChecks, Pencil, Plus, RefreshCw, Search, Trash2, Workflow, Sparkles, Eye } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { fetchProductionCanvasContext, BackendApiError } from "@/services/backend-api";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { useWorkbenchCanvas } from "@/lib/canvas/canvas-host";
import { canvasHostLocation } from "@/lib/canvas/canvas-host-navigation";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { PageHeader } from "@/components/layout/page-header";
import { WorkbenchCanvas } from "@/pages/drama/workbench-canvas";
import { dramaWorkbenchPath } from "@/pages/drama/workbench-entry";
import { cn } from "@/lib/utils";
import { CreativeLaunchPad } from "./creative-launch-pad";
import { CreativeGenerationFeed } from "./creative-generation-feed";
import {
    appendConversationLaunch,
    collectOutputs,
    CREATIVE_CONVERSATION_STORAGE_KEY,
    nextConversationId,
    pruneConversations,
    readCreativeConversations,
    taskDestination,
    writeCreativeConversations,
    projectCover,
    type CreativeConversation,
    type CreativeLaunch,
    type WorkbenchOutput,
} from "./workbench-data";
import { WorkbenchMediaPreview } from "./workbench-media";
import { useProjectCoverResults, useStableProjectCovers, useWorkbenchData } from "./use-workbench-data";

type ProjectFilter = "all" | "canvas" | "drama" | "pinned";
const surface = "rounded-[10px] border border-border bg-card";

export default function IndexPage() {
    return <WorkbenchCanvas><HomeWorkbench /></WorkbenchCanvas>;
}

function HomeWorkbench() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const canvasHost = useWorkbenchCanvas();
    const projects = useCanvasStore((s) => s.projects);
    const folders = useCanvasStore((s) => s.folders);
    const hydrated = useCanvasStore((s) => s.hydrated);
    const createProject = useCanvasStore((s) => s.createProject);
    const setDeleteProjectIds = useCanvasUiStore((s) => s.setDeleteProjectIds);
    const data = useWorkbenchData();
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<ProjectFilter>("all");
    const [view, setView] = useState<"grid" | "list">(() => {
        try {
            return localStorage.getItem("home-project-view") === "list" ? "list" : "grid";
        } catch {
            return "grid";
        }
    });
    const [visibleCount, setVisibleCount] = useState(12);
    const [previewProject, setPreviewProject] = useState<CanvasProject | null>(null);
    const [previewOutput, setPreviewOutput] = useState<WorkbenchOutput | null>(null);
    const homeStorage = typeof localStorage !== "undefined" ? localStorage : undefined;
    // 对齐影策：多会话 + 活动会话 + 对话形态开关，全部持久化；空会话不入库。
    const [conversations, setConversations] = useState<CreativeConversation[]>(() => readCreativeConversations(homeStorage, Date.now()));
    const [activeConversationId, setActiveConversationId] = useState(() => readCreativeConversations(homeStorage, Date.now())[0]?.id || "");
    const [threadActive, setThreadActive] = useState(() => {
        try {
            return sessionStorage.getItem("home-thread-active") === "1";
        } catch {
            return false;
        }
    });
    const [historyOpen, setHistoryOpen] = useState(false);
    const [renamingConversation, setRenamingConversation] = useState<CreativeConversation | null>(null);
    const [renameText, setRenameText] = useState("");
    // 编辑并重发（影策）：nonce 变化即回填追问输入条。
    const [editRequest, setEditRequest] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
    const persistConversations = (next: CreativeConversation[]) => {
        const pruned = pruneConversations(next, Date.now());
        setConversations(pruned);
        writeCreativeConversations(homeStorage, pruned);
    };
    const setThreadActivePersisted = (value: boolean) => {
        setThreadActive(value);
        try {
            sessionStorage.setItem("home-thread-active", value ? "1" : "0");
        } catch {
            /* 可选持久化失败不影响本次会话 */
        }
    };
    const activeConversation = conversations.find(item => item.id === activeConversationId) || conversations[0] || null;
    const activeLaunches = activeConversation?.launches || [];
    const otherConversationCount = Math.max(0, conversations.length - (activeConversation ? 1 : 0));
    const [tasksOpen, setTasksOpen] = useState(false);
    const [outputsOpen, setOutputsOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const openDestinationRequest = useRef(0);
    const outputs = useMemo(() => collectOutputs(data.logs), [data.logs]);
    const folderFor = (p: CanvasProject) => data.canvasOwners.get(p.id);
    const isDrama = (p: CanvasProject) => data.canvasOwners.has(p.id);
    const dramaDestination = (p: CanvasProject) => {
        const episode = data.canvasEpisodes.get(p.id);
        return episode ? dramaWorkbenchPath(episode.dramaId, episode.episodeId) : `/production?dramaId=${encodeURIComponent(folderFor(p)?.id || "")}&workspace=series`;
    };
    const sorted = [...projects].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const ordinaryProjects = sorted.filter((p) => !isDrama(p));
    const entries = [
        ...ordinaryProjects.map((project) => ({ kind: "canvas" as const, id: project.id, title: project.title, updatedAt: project.updatedAt, project })),
        ...folders.filter((folder) => folder.isDrama).map((folder) => ({ kind: "drama" as const, id: folder.id, title: folder.name, updatedAt: folder.updatedAt || folder.createdAt, folder })),
    ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const filtered = entries.filter((entry) => entry.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (filter === "all" || (filter === "pinned" ? entry.kind === "canvas" && data.settings[`homePinnedProject:${entry.id}`] : entry.kind === filter)));
    const latest = sorted[0];
    const projectIds = new Set(projects.map((p) => p.id));
    const date = (value: string) => (Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(i18n.resolvedLanguage, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
    const stats = (project: CanvasProject) => t("canvas.project.stats", {
        nodes: project.summary?.nodeCount ?? project.nodes.length,
        connections: project.summary?.connectionCount ?? project.connections.length,
    });
    const openDestination = async (destination: string) => {
        const requestId = ++openDestinationRequest.current;
        const target = canvasHostLocation(destination, "");
        if (target) {
            const openInOverlay = () => canvasHost?.openCanvas({ projectId: target.projectId, nodeId: target.search.get("nodeId") || undefined, segmentId: target.search.get("segmentId") || undefined });
            if (data.canvasOwners.has(target.projectId)) {
                openInOverlay();
                return;
            }
            // The latest-project card is available before the drama ownership queries finish.
            // Resolve that one clicked project so an early click cannot escape the production layout.
            if (!data.dramaReady && data.connected) {
                try {
                    const { context } = await fetchProductionCanvasContext(target.projectId);
                    if (requestId !== openDestinationRequest.current) return;
                    if (["episode", "scene", "shared-assets"].includes(context.role)) {
                        openInOverlay();
                        return;
                    }
                } catch (error) {
                    if (requestId !== openDestinationRequest.current) return;
                    // 画布不存在（404）时按普通画布处理，继续导航，避免“新建画布”等入口被阻断
                    if (error instanceof BackendApiError && error.status === 404) {
                        openInOverlay();
                        return;
                    }
                    message.error(error instanceof Error ? error.message : String(error));
                    return;
                }
            }
        }
        if (requestId !== openDestinationRequest.current) return;
        navigate(destination);
    };
    const openProject = (id: string, nodeId?: string) => openDestination(`/canvas/${encodeURIComponent(id)}${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ""}`);
    const totalLaunchCount = conversations.reduce((count, item) => count + item.launches.length, 0);
    const recordLaunch = (launch: CreativeLaunch) => {
        const targetId = activeConversation?.id || nextConversationId();
        if (!activeConversation) {
            const conversation: CreativeConversation = { id: targetId, title: launch.prompt.slice(0, 24), createdAt: launch.createdAt, updatedAt: launch.createdAt, canvasId: launch.projectId, launches: [launch] };
            persistConversations([conversation, ...conversations]);
            setActiveConversationId(targetId);
        } else {
            persistConversations(appendConversationLaunch(conversations, targetId, launch));
        }
        // 提交成功 → 原地进入对话工作台并滚动到消息流。
        setThreadActivePersisted(true);
        // 立刻拉一次任务列表：既让进度条马上出现，也启动轮询兜底
        // （轮询在每次 load 完成后才会排下一轮；若页面空闲，只有主动 refresh 才能让它接管）。
        data.refresh();
        window.requestAnimationFrame(() => document.getElementById("creative-generation-feed")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    };
    const dismissLaunch = (taskId: string) => {
        const next = conversations
            .map(conversation => ({ ...conversation, launches: conversation.launches.filter(item => item.taskId !== taskId) }))
            .filter(conversation => conversation.launches.length > 0);
        persistConversations(next);
        if (activeConversation && !next.some(item => item.id === activeConversation.id)) setActiveConversationId(next[0]?.id || "");
    };
    const startNewConversation = () => {
        // 新对话先在内存里建空会话（允许空，不入库）；第一条提交时落标题。
        const conversation: CreativeConversation = { id: nextConversationId(), title: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), launches: [] };
        setConversations(current => [conversation, ...current]);
        setActiveConversationId(conversation.id);
        try {
            homeStorage?.setItem(CREATIVE_CONVERSATION_STORAGE_KEY, JSON.stringify(pruneConversations([conversation, ...conversations], Date.now())));
        } catch { /* 可选持久化 */ }
        setThreadActivePersisted(true);
        window.requestAnimationFrame(() => document.getElementById("creative-generation-feed")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    };
    const selectConversation = (id: string) => {
        setActiveConversationId(id);
        setHistoryOpen(false);
        setThreadActivePersisted(true);
        window.requestAnimationFrame(() => document.getElementById("creative-generation-feed")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    };
    const deleteConversation = (id: string) => {
        const next = conversations.filter(item => item.id !== id);
        persistConversations(next);
        if (activeConversationId === id) setActiveConversationId(next[0]?.id || "");
    };
    const renameConversation = () => {
        if (!renamingConversation) return;
        const title = renameText.trim();
        if (title) persistConversations(conversations.map(item => item.id === renamingConversation.id ? { ...item, title } : item));
        setRenamingConversation(null);
    };
    // 影策 handoff：进画布时带上生成节点，画布加载后自动聚焦到本次成果。
    const continueEditing = async (projectId: string, nodeId?: string) => {
        const requestId = ++openDestinationRequest.current;
        const knownDrama = data.canvasOwners.get(projectId);
        if (knownDrama || !data.dramaReady && data.connected) {
            try {
                const { context } = await fetchProductionCanvasContext(projectId);
                if (requestId !== openDestinationRequest.current) return;
                if (["episode", "scene", "shared-assets"].includes(context.role) && (context.dramaId || knownDrama?.id)) {
                    // ProductionCanvasTarget 不支持 nodeId：drama 画布只做切换，不做节点聚焦。
                    canvasHost?.switchProductionCanvas({ projectId, dramaId: context.dramaId || knownDrama!.id, episodeId: context.episodeId || undefined, keepCanvasOpen: true });
                    return;
                }
            } catch (error) {
                if (requestId !== openDestinationRequest.current) return;
                message.error(error instanceof Error ? error.message : String(error));
                return;
            }
        }
        if (requestId === openDestinationRequest.current) openProject(projectId, nodeId);
    };
    const visibleProjects = (data.dramaReady ? filtered.slice(0, visibleCount) : []).flatMap((entry) => entry.kind === "canvas" ? [entry.project] : []);
    const coverProjects = latest && !visibleProjects.some((p) => p.id === latest.id) ? [latest, ...visibleProjects] : visibleProjects;
    const extraCover = useProjectCoverResults(coverProjects.filter((p) => !projectCover(p, outputs, folderFor(p))).map((p) => [p.id, p.updatedAt]));
    const coverKey = (p: CanvasProject) => JSON.stringify([data.backendUrl, p.id, p.updatedAt]);
    const stableCovers = useStableProjectCovers(coverProjects.map((p) => ({ key: coverKey(p), media: projectCover(p, outputs, folderFor(p)) || extraCover(p.id, p.updatedAt) })));
    const cover = (p: CanvasProject) => stableCovers[coverKey(p)] || null;
    const hasWork = Boolean(latest || entries.length);
    const latestCover = latest ? cover(latest) : null;
    const outputTitle = (o: WorkbenchOutput) => projects.find((p) => p.id === o.log.projectId)?.title || o.log.model || t("home.workbench.result");
    const pin = (id: string) => void data.togglePin(id).catch((error) => message.error(error instanceof Error ? error.message : t("home.workbench.saveFailed")));
    const create = () => {
        if (!hydrated || !data.connected || !name.trim()) return;
        const id = createProject(name.trim());
        setCreating(false);
        openProject(id);
    };
    const outputCard = (o: WorkbenchOutput) => (
        <button key={o.id} type="button" className="group min-w-0 cursor-pointer text-left" onClick={() => setPreviewOutput(o)} aria-label={t("home.workbench.previewNamed", { name: outputTitle(o) })}>
            <div className="h-28 overflow-hidden rounded-lg border border-border bg-muted transition-colors group-hover:border-foreground/40">
                <WorkbenchMediaPreview media={o} label={t(`home.workbench.${o.kind}`)} />
            </div>
            <p className="ui-group-title mt-2 truncate">{outputTitle(o)}</p>
            <p className="ui-caption mt-1 text-muted-foreground">
                {t(`home.workbench.${o.kind}`)} · {date(o.log.createdAt)}
            </p>
        </button>
    );

    const creationActions = (
        <section className={hasWork ? "flex flex-wrap items-center gap-2" : "mb-5 grid gap-3 sm:grid-cols-2"} aria-label={t("productionCanvas.entryTitle")}>
            {[{ path: "/production", title: "dramaEntry", description: "dramaEntryHint", icon: Clapperboard }, { path: "/canvas", title: "canvasEntry", description: "canvasEntryHint", icon: LayoutGrid }].map(({ path, title, description, icon: Icon }) => (
                <Link
                    key={path}
                    to={path}
                    className={cn("group flex min-w-0 items-center text-foreground transition-colors hover:border-primary/50 hover:bg-muted/40", hasWork ? "ui-action-link border border-border" : "gap-3 rounded-[10px] border border-border bg-card p-4")}
                >
                    <Icon className={cn("shrink-0 text-primary", hasWork ? "size-4" : "size-4.5")} aria-hidden="true" />
                    {hasWork ? <span>{t(`productionCanvas.${title}`)}</span> : (
                        <div className="min-w-0 flex-1">
                            <h2 className="ui-panel-title">{t(`productionCanvas.${title}`)}</h2>
                            <p className="ui-body mt-1 text-muted-foreground">{t(`productionCanvas.${description}`)}</p>
                        </div>
                    )}
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Link>
            ))}
        </section>
    );

    const pageActions = (
        <>
            {hasWork ? creationActions : null}
            <Button icon={<ListChecks className="size-4" />} onClick={() => setTasksOpen(true)}>
                {t("home.workbench.tasks")}
            </Button>
            <Button
                type="primary"
                disabled={!hydrated || !data.connected}
                icon={<Plus className="size-4" />}
                onClick={() => {
                    setName(t("canvas.defaultTitle", { count: projects.length + 1 }));
                    setCreating(true);
                }}
            >
                {t("canvas.create")}
            </Button>
        </>
    );

    const flatLaunches = useMemo(() => conversations.flatMap(item => item.launches).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [conversations]);
    // 对齐影策：对话形态是全屏页（fixed 覆盖层），有活动会话且已有消息时接管整个视口；
    // 「返回」或「新对话」（空会话）退出覆盖层，回到创作台。
    const threadOverlayOpen = threadActive && Boolean(activeConversation) && activeLaunches.length > 0;
    useEffect(() => {
        if (!threadOverlayOpen) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => { document.body.style.overflow = previous; };
    }, [threadOverlayOpen]);
    return (
        <main className="ui-controls min-h-full bg-background text-foreground" data-testid="home-workbench">
            {threadOverlayOpen && (
                <div className="fixed inset-0 z-[70] flex flex-col bg-background" data-testid="home-thread-overlay">
                    <div className="flex min-h-0 w-full flex-1 flex-col px-4 py-5 sm:px-6">
                        <CreativeGenerationFeed
                            launches={activeLaunches}
                            tasks={data.tasks}
                            logs={data.logs}
                            threadActive
                            composer={<CreativeLaunchPad variant="thread" onGenerated={recordLaunch} sharedProjectId={activeConversation?.canvasId} injectedDraft={editRequest} />}
                            onDismiss={dismissLaunch}
                            onOpenProject={openProject}
                            onPreview={setPreviewOutput}
                            onNewThread={startNewConversation}
                            onOpenHistory={() => setHistoryOpen(true)}
                            hasOtherConversations={otherConversationCount > 0}
                            onEditPrompt={(text) => setEditRequest(current => ({ text, nonce: current.nonce + 1 }))}
                            onContinueCanvas={(projectId, nodeId) => void continueEditing(projectId, nodeId)}
                            onBack={() => setThreadActivePersisted(false)}
                        />
                    </div>
                </div>
            )}
            <div className="mx-auto max-w-[1440px] px-4 pt-6 pb-24 sm:px-6 lg:px-8">
                <PageHeader
                    className="mb-5"
                    width="gallery"
                    title={t(hasWork ? "home.workbench.title" : "productionCanvas.entryTitle")}
                    description={!hasWork ? t("landing.canvasSubtitle") : undefined}
                    actions={pageActions}
                />
                {/* 影策 isEmpty 分支：非对话形态或活动会话还没有消息时，显示完整创作台（含示例与快捷入口）。 */}
                {(!threadActive || !activeConversation || activeLaunches.length === 0) && (
                    <CreativeLaunchPad
                        onGenerated={recordLaunch}
                        historyCount={totalLaunchCount}
                        sharedProjectId={activeConversation?.canvasId}
                        onOpenHistory={() => {
                            setThreadActivePersisted(true);
                            setHistoryOpen(true);
                        }}
                    />
                )}
                {threadOverlayOpen ? null : threadActive ? (
                    <CreativeGenerationFeed
                        launches={activeLaunches}
                        tasks={data.tasks}
                        logs={data.logs}
                        threadActive
                        composer={activeLaunches.length > 0 ? <CreativeLaunchPad variant="thread" onGenerated={recordLaunch} sharedProjectId={activeConversation?.canvasId} injectedDraft={editRequest} /> : undefined}
                        onDismiss={dismissLaunch}
                        onOpenProject={openProject}
                        onPreview={setPreviewOutput}
                        onNewThread={startNewConversation}
                        onOpenHistory={() => setHistoryOpen(true)}
                        hasOtherConversations={otherConversationCount > 0}
                        onEditPrompt={(text) => setEditRequest(current => ({ text, nonce: current.nonce + 1 }))}
                        onContinueCanvas={(projectId, nodeId) => void continueEditing(projectId, nodeId)}
                    />
                ) : totalLaunchCount > 0 ? (
                    <CreativeGenerationFeed
                        launches={flatLaunches}
                        tasks={data.tasks}
                        logs={data.logs}
                        onDismiss={dismissLaunch}
                        onOpenProject={openProject}
                        onPreview={setPreviewOutput}
                    />
                ) : null}
                {!hasWork && creationActions}
                {data.connected && (data.errors.length > 0 || data.dramaError) && (
                    <Alert
                        className="mb-5"
                        type="warning"
                        showIcon
                        title={t("home.workbench.loadFailed", { sections: [...data.errors.map((key) => t(`home.workbench.section_${key}`)), ...(data.dramaError ? [t("home.workbench.drama")] : [])].join(" / ") })}
                        action={
                            <Button size="small" loading={data.loading} onClick={data.refresh}>
                                {t("home.workbench.retry")}
                            </Button>
                        }
                    />
                )}
                <section className="mb-6" aria-label={t("home.workbench.continue")} data-testid="home-resume">
                    <div className={cn(surface, "flex min-w-0 overflow-hidden", latestCover ? "flex-col sm:min-h-44 sm:flex-row" : "min-h-36")}>
                        {!hydrated ? <div className="w-full p-4"><Skeleton active paragraph={{ rows: 2 }} /></div> : latest ? <>
                            <button
                                type="button"
                                className={cn("relative shrink-0 overflow-hidden bg-muted/30", latestCover ? "h-40 w-full sm:h-auto sm:w-[28%]" : "w-20 sm:w-36")}
                                onClick={() => void continueEditing(latest.id)}
                                aria-label={t("landing.openCanvasNamed", { name: latest.title })}
                            >
                                <div className="absolute inset-0"><WorkbenchMediaPreview media={latestCover} label={latestCover ? latest.title : t("landing.noPreview")} /></div>
                            </button>
                            <div className="flex min-w-0 flex-1 flex-col justify-center gap-3 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5 sm:p-5">
                                <div className="min-w-0">
                                    <span className="ui-caption text-muted-foreground">{t("home.workbench.lastEdited")}</span>
                                    <h2 className="ui-panel-title mt-1 line-clamp-2" title={latest.title}>{latest.title}</h2>
                                    <p className="ui-caption mt-1 flex min-w-0 items-center gap-2 text-muted-foreground">
                                        <span className="truncate">{folderFor(latest)?.name || t("home.workbench.canvas")}</span>
                                        <span aria-hidden="true">·</span>
                                        <span className="shrink-0">{date(latest.updatedAt)}</span>
                                    </p>
                                </div>
                                <div className="flex shrink-0 flex-col items-start gap-2">
                                    <Button icon={<ArrowRight className="size-4" />} iconPlacement="end" onClick={() => void continueEditing(latest.id)}>{t("home.workbench.continue")}</Button>
                                    {isDrama(latest) && <Link to={dramaDestination(latest)} className="ui-caption inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">{t("productionCanvas.backDrama")}<ArrowRight className="size-4" /></Link>}
                                </div>
                            </div>
                        </> : <div className="flex items-start gap-4 p-5"><Workflow className="mt-0.5 size-6 shrink-0 text-muted-foreground" /><div><h2 className="ui-panel-title">{t("home.workbench.firstProject")}</h2><p className="ui-body mt-1 text-muted-foreground">{t("home.workbench.firstProjectHint")}</p></div></div>}
                    </div>
                </section>
                <section aria-label={t("home.workbench.recentProjects")}>
                    <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-border pb-3">
                        <h2 className="ui-panel-title mr-1">{t("home.workbench.projects")}</h2>
                        <Segmented
                            value={filter}
                            options={["all", "canvas", "drama", "pinned"].map((value) => ({ value, label: t(`home.workbench.${value}`) }))}
                            onChange={(value) => {
                                setFilter(value as ProjectFilter);
                                setVisibleCount(12);
                            }}
                        />
                        <Input
                            className="!w-full sm:!ml-auto sm:!w-52"
                            allowClear
                            prefix={<Search className="mr-1 size-4 text-muted-foreground" />}
                            placeholder={t("home.workbench.search")}
                            aria-label={t("home.workbench.search")}
                            value={query}
                            onChange={(event) => {
                                setQuery(event.target.value);
                                setVisibleCount(12);
                            }}
                        />
                        <div className="flex gap-1">
                            {(["grid", "list"] as const).map((mode) => (
                                <Tooltip key={mode} title={t(`home.workbench.${mode}`)}>
                                    <Button
                                        aria-label={t(`home.workbench.${mode}`)}
                                        aria-pressed={view === mode}
                                        className="ui-icon-button"
                                        type={view === mode ? "default" : "text"}
                                        icon={mode === "grid" ? <LayoutGrid className="size-4" /> : <List className="size-4" />}
                                        onClick={() => {
                                            setView(mode);
                                            try {
                                                localStorage.setItem("home-project-view", mode);
                                            } catch {
                                                /* optional view preference */
                                            }
                                        }}
                                    />
                                </Tooltip>
                            ))}
                        </div>
                    </div>
                    {!hydrated || (!data.dramaReady && !data.dramaError) ? (
                        <div aria-busy="true" data-testid="home-projects-loading" className={cn(view === "grid" ? "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" : "flex flex-col gap-2")}>
                            {Array.from({ length: 3 }, (_, index) => <div key={index} className={cn(surface, "overflow-hidden", view === "list" && "flex items-center")}>
                                <div className={cn("shrink-0 animate-pulse bg-muted", view === "grid" ? "aspect-[16/9] w-full" : "h-24 w-24 sm:w-36")} />
                                <div className="flex-1 p-3.5"><Skeleton active title={{ width: "60%" }} paragraph={{ rows: 2 }} /></div>
                            </div>)}
                        </div>
                    ) : !data.dramaReady ? (
                        <div className={cn(surface, "py-10")}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("home.workbench.loadFailed", { sections: t("home.workbench.drama") })} /></div>
                    ) : !filtered.length ? (
                        <div className={cn(surface, "py-10")}>
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t(query || filter !== "all" ? "home.workbench.noMatches" : "home.workbench.noProjects")} />
                        </div>
                    ) : (
                        <div className={cn(view === "grid" ? "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" : "flex flex-col gap-2")}>
                            {filtered.slice(0, visibleCount).map((entry) => {
                                if (entry.kind === "drama") {
                                    const folder = entry.folder;
                                    return (
                                        <Link key={`drama:${folder.id}`} to={`/production?dramaId=${encodeURIComponent(folder.id)}`} className={cn(surface, "group overflow-hidden text-foreground transition-colors hover:border-foreground/30", view === "list" && "flex items-center")}>
                                            <div className={cn("relative shrink-0 overflow-hidden bg-muted", view === "grid" ? "aspect-[16/9] w-full" : "h-24 w-24 sm:w-36")}>
                                                <WorkbenchMediaPreview media={folder.coverStorageKey ? { kind: "image", storageKey: folder.coverStorageKey } : null} label={folder.name} />
                                                {view === "grid" && <span className="absolute left-3 top-3 ui-caption rounded bg-background/95 px-2 py-1">{t("home.workbench.drama")}</span>}
                                            </div>
                                            <div className="min-w-0 flex-1 p-3.5">
                                                <h3 className="ui-panel-title line-clamp-2" title={folder.name}>{folder.name}</h3>
                                                <p className="ui-caption mt-1.5 truncate text-muted-foreground">{t("home.workbench.drama")}</p>
                                                <p className="ui-caption mt-1 text-muted-foreground">{date(entry.updatedAt)}</p>
                                            </div>
                                        </Link>
                                    );
                                }
                                const p = entry.project;
                                const pinned = Boolean(data.settings[`homePinnedProject:${p.id}`]);
                                return (
                                    <article key={p.id} className={cn(surface, "group overflow-hidden transition-colors hover:border-foreground/30", view === "list" && "flex flex-wrap items-center")}>
                                        <button
                                            type="button"
                                            className={cn("relative block shrink-0 cursor-pointer overflow-hidden bg-muted", view === "grid" ? "aspect-[16/9] w-full" : "h-24 w-24 sm:w-36")}
                                            onClick={() => openProject(p.id)}
                                            aria-label={t("landing.openCanvasNamed", { name: p.title })}
                                        >
                                            <WorkbenchMediaPreview media={cover(p)} label={cover(p) ? p.title : t("landing.noPreview")} />
                                            {view === "grid" && <span className="absolute left-3 top-3 ui-caption rounded bg-background/95 px-2 py-1 text-foreground">{t("home.workbench.canvas")}</span>}
                                        </button>
                                        <div className="flex min-w-0 flex-1 items-center gap-2 p-3.5">
                                            <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => openProject(p.id)}>
                                                <h3 className="ui-panel-title line-clamp-2" title={p.title}>
                                                    {p.title}
                                                </h3>
                                                <p className="ui-caption mt-1.5 truncate text-muted-foreground">{folderFor(p)?.name || t("home.workbench.canvas")}</p>
                                                <p className="ui-caption mt-1 text-muted-foreground">{date(p.updatedAt)}</p>
                                            </button>
                                            <Tooltip title={t(pinned ? "home.workbench.unpin" : "home.workbench.pin")}>
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    aria-pressed={pinned}
                                                    className="ui-icon-button"
                                                    aria-label={t(pinned ? "home.workbench.unpin" : "home.workbench.pin")}
                                                    disabled={!data.connected || !data.settingsReady || data.pinning}
                                                    icon={pinned ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4 text-muted-foreground" />}
                                                    onClick={() => pin(p.id)}
                                                />
                                            </Tooltip>
                                        </div>
                                        <div className={cn("flex items-center justify-between gap-2 border-t border-border px-3.5 py-2.5", view === "list" && "w-full")}>{isDrama(p) && <Link className="ui-caption inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground" to={dramaDestination(p)}>{t("productionCanvas.backDrama")}<ArrowRight className="size-3" /></Link>}<Button type="text" size="small" icon={<Eye className="size-4" />} aria-label={t("home.workbench.previewNamed", { name: p.title })} onClick={() => setPreviewProject(p)}>{t("landing.preview")}</Button></div>
                                    </article>
                                );
                            })}
                        </div>
                    )}
                    <div className="mt-4 flex items-center justify-between gap-3">
                        <Button type="text" onClick={() => navigate("/canvas")}>
                            {t("home.workbench.manageProjects")}
                            <ArrowRight className="size-4" />
                        </Button>
                        {visibleCount < filtered.length && <Button onClick={() => setVisibleCount((count) => count + 12)}>{t("home.workbench.moreProjects")}</Button>}
                    </div>
                </section>
                <section className="mt-6 border-t border-border pt-6" aria-label={t("home.workbench.recentOutputs")}>
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <h2 className="ui-panel-title">{t("home.workbench.recentOutputs")}</h2>
                        <Button type="text" onClick={() => setOutputsOpen(true)}>
                            {t("home.workbench.viewResults")}
                            <ArrowRight className="size-4" />
                        </Button>
                    </div>
                    {data.loading && !data.logs.length ? (
                        <Skeleton active paragraph={{ rows: 2 }} />
                    ) : outputs.length ? (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">{outputs.slice(0, 6).map(outputCard)}</div>
                    ) : (
                        <div className="ui-body rounded-[10px] border border-dashed border-border py-7 text-center text-muted-foreground">{t(data.connected ? "home.workbench.noOutputs" : "home.workbench.offlineOutputs")}</div>
                    )}
                </section>
            </div>
            <Modal open={creating} title={t("canvas.create")} onCancel={() => setCreating(false)} onOk={create} okText={t("home.workbench.createOpen")} okButtonProps={{ disabled: !name.trim() || !data.connected }} destroyOnHidden>
                <label className="ui-group-title mb-2 block" htmlFor="home-project-name">
                    {t("home.workbench.projectName")}
                </label>
                <Input id="home-project-name" value={name} onChange={(e) => setName(e.target.value)} onPressEnter={create} autoFocus />
            </Modal>
            <Modal
                open={Boolean(previewProject)}
                title={previewProject?.title}
                onCancel={() => setPreviewProject(null)}
                footer={
                    previewProject ? (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <Button danger type="text" icon={<Trash2 className="size-4" />} onClick={() => { setDeleteProjectIds([previewProject.id]); setPreviewProject(null); }}>
                                {t("common.delete")}
                            </Button>
                            <Button type="primary" onClick={() => openProject(previewProject.id)}>
                                {t("home.workbench.continue")}
                                <ArrowRight className="size-4" />
                            </Button>
                        </div>
                    ) : null
                }
                width={800}
                destroyOnHidden
            >
                {previewProject && (
                    <>
                        <div className="h-[min(50vh,420px)] overflow-hidden rounded-lg bg-muted">
                            <WorkbenchMediaPreview media={cover(previewProject)} label={stats(previewProject)} controls />
                        </div>
                        <p className="ui-body mt-3 text-muted-foreground">
                            {stats(previewProject)} · {date(previewProject.updatedAt)}
                        </p>
                    </>
                )}
            </Modal>
            <Modal
                open={outputsOpen}
                title={t("home.workbench.recentOutputs")}
                onCancel={() => setOutputsOpen(false)}
                footer={
                    data.hasMore ? (
                        <Button loading={data.loading} onClick={data.loadMore}>
                            {t("home.workbench.moreResults")}
                        </Button>
                    ) : null
                }
                width={960}
                destroyOnHidden
            >
                <div className="max-h-[65vh] overflow-y-auto">{outputs.length ? <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">{outputs.map(outputCard)}</div> : <Empty description={t("home.workbench.noOutputs")} />}</div>
            </Modal>
            <Modal
                open={Boolean(previewOutput)}
                title={previewOutput ? outputTitle(previewOutput) : ""}
                onCancel={() => setPreviewOutput(null)}
                footer={
                    previewOutput && projectIds.has(previewOutput.log.projectId) ? (
                        <Button onClick={() => openProject(previewOutput.log.projectId)}>
                            {t("home.workbench.sourceProject")}
                            <ArrowRight className="size-4" />
                        </Button>
                    ) : null
                }
                width={900}
                destroyOnHidden
            >
                {previewOutput && (
                    <>
                        <div className="flex h-[min(55vh,480px)] items-center justify-center overflow-hidden rounded-lg bg-muted">
                            <WorkbenchMediaPreview media={previewOutput} label={outputTitle(previewOutput)} controls />
                        </div>
                        <p className="ui-caption mt-3 text-muted-foreground">
                            {previewOutput.log.model} · {date(previewOutput.log.createdAt)}
                        </p>
                        {previewOutput.log.prompt && <p className="ui-body mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{previewOutput.log.prompt}</p>}
                    </>
                )}
            </Modal>
            <Modal
                open={tasksOpen}
                title={t("home.workbench.recentTasks")}
                onCancel={() => setTasksOpen(false)}
                footer={
                    <Button loading={data.loading} icon={<RefreshCw className="size-4" />} onClick={data.refresh}>
                        {t("home.workbench.refresh")}
                    </Button>
                }
                width={720}
                destroyOnHidden
            >
                <div className="max-h-[65vh] overflow-y-auto">
                    {!data.connected ? null : data.tasks.length ? (
                        data.tasks.map((task) => {
                            const destination = taskDestination(task, projectIds);
                            return (
                                <div key={task.id} className="border-b border-border py-4 last:border-0">
                                    <div className="flex flex-wrap items-start gap-2">
                                        <div className="min-w-0 flex-1">
                                            <p className="ui-group-title truncate">{projects.find((p) => p.id === task.projectId)?.title || task.model || task.kind || t("home.workbench.task")}</p>
                                            <p className="ui-caption mt-1 text-muted-foreground">
                                                {task.model} · {date(task.updatedAt || task.createdAt || "")}
                                            </p>
                                        </div>
                                        <Tag color={task.status === "failed" ? "error" : task.status === "running" ? "processing" : task.status === "succeeded" ? "success" : "default"}>{t(`home.workbench.status_${task.status}`)}</Tag>
                                        {destination && (
                                            <Button size="small" onClick={() => openDestination(destination)}>
                                                {t("home.workbench.openSource")}
                                            </Button>
                                        )}
                                    </div>
                                    {task.status === "running" && <Progress className="!mt-2" percent={Math.min(100, Math.max(0, Math.round((Number(task.progress) || 0) * 100)))} size="small" />}
                                    {task.error && <p className="ui-body mt-2 whitespace-pre-wrap break-words text-destructive">{task.error}</p>}
                                </div>
                            );
                        })
                    ) : (
                        <Empty description={t("home.workbench.noTasks")} />
                    )}
                </div>
            </Modal>
            <Drawer
                open={historyOpen}
                title={t("home.workbench.threadHistory")}
                onClose={() => setHistoryOpen(false)}
                width={380}
                data-testid="creative-history-drawer"
            >
                {conversations.length ? (
                    <div className="flex flex-col gap-2">
                        {conversations.map(conversation => (
                            <div
                                key={conversation.id}
                                className={cn("group flex min-w-0 items-center gap-2 rounded-lg border border-border p-3 transition-colors", conversation.id === activeConversation?.id ? "border-primary/50 bg-muted/40" : "hover:bg-muted/30")}
                                data-testid="creative-history-item"
                            >
                                <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => selectConversation(conversation.id)}>
                                    <p className="ui-group-title truncate">{conversation.title || t("home.workbench.threadEmpty")}</p>
                                    <p className="ui-caption mt-1 text-muted-foreground">
                                        {t("home.workbench.threadMessageCount", { count: conversation.launches.length })} · {date(conversation.updatedAt)}
                                    </p>
                                </button>
                                <Button type="text" size="small" className="ui-icon-button" aria-label={t("home.workbench.threadRename")} icon={<Pencil className="size-3.5" />} onClick={() => { setRenamingConversation(conversation); setRenameText(conversation.title); }} />
                                <Popconfirm title={t("home.workbench.threadDeleteConfirm")} onConfirm={() => deleteConversation(conversation.id)} okText={t("common.delete")} cancelText={t("common.cancel")}>
                                    <Button type="text" size="small" className="ui-icon-button" danger aria-label={t("common.delete")} icon={<Trash2 className="size-3.5" />} />
                                </Popconfirm>
                            </div>
                        ))}
                    </div>
                ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("home.workbench.threadHistoryEmpty")} />
                )}
            </Drawer>
            <Modal
                open={Boolean(renamingConversation)}
                title={t("home.workbench.threadRename")}
                onCancel={() => setRenamingConversation(null)}
                onOk={renameConversation}
                okText={t("common.save")}
                cancelText={t("common.cancel")}
                okButtonProps={{ disabled: !renameText.trim() }}
                destroyOnHidden
            >
                <Input value={renameText} onChange={event => setRenameText(event.target.value)} onPressEnter={renameConversation} autoFocus maxLength={60} />
            </Modal>
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
