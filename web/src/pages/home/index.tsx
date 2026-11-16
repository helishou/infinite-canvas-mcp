import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Drawer, Empty, Input, Modal, Popconfirm, Progress, Skeleton, Tag } from "antd";
import { ArrowRight, Clapperboard, ImagePlus, LayoutGrid, Pencil, RefreshCw, Trash2, Workflow, Sparkles } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";
import { fetchProductionCanvasContext, BackendApiError, createBackendGenerationLog } from "@/services/backend-api";
import { flushCanvasProjectBeforeGeneration, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { creativeProjectTitle } from "@/lib/creative-pad";
import { subscribeCreativeLaunches } from "@/lib/creative-conversation-bus";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { useWorkbenchCanvas } from "@/lib/canvas/canvas-host";
import { canvasHostLocation } from "@/lib/canvas/canvas-host-navigation";
import { WorkbenchCanvas } from "@/pages/drama/workbench-canvas";
import { dramaWorkbenchPath } from "@/pages/drama/workbench-entry";
import { WorkspaceViewSwitcher } from "@/components/production/workspace-view-switcher";
import { cn } from "@/lib/utils";
import { CreativeLaunchPad } from "./creative-launch-pad";
import { CreativeGenerationFeed } from "./creative-generation-feed";
import { CreativeRecentCanvases } from "./creative-recent-canvases";
import {
    appendConversationLaunch,
    collectOutputs,
    launchTextResults,
    resolveLaunchOutputs,
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

const surface = "ch-surface";

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
    const data = useWorkbenchData();
    // 「剧目和画布」项目列表已下线：筛选/搜索/网格/预览等状态随模块一并移除，
    // 项目入口统一收敛到页头的「剧目」「画布」和下方最近画布卡片。
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
    const [editRequest, setEditRequest] = useState<{ text: string; nonce: number; submit?: boolean; mode?: CreativeLaunch["mode"]; params?: CreativeLaunch["params"] }>({ text: "", nonce: 0 });
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
    const [creatingCanvas, setCreatingCanvas] = useState(false);
    // 首页画布覆盖层里没有制作台工作台，记录当前打开的画布以便「切回制作台视图」按归属导航。
    const [overlayProjectId, setOverlayProjectId] = useState("");
    const openDestinationRequest = useRef(0);
    // 「最近生成」取独立的一段媒体日志（见 use-workbench-data），避免被最近的纯文本对话挤空；
    // 对话阶段还没落画布的成果从任务详情补进来，点「新建画布」写日志后会自动去重。
    const outputs = useMemo(() => {
        const archived = collectOutputs(data.mediaLogs);
        const seen = new Set(archived.map(output => output.storageKey || output.url || ""));
        const conversationOutputs = activeLaunches.flatMap(launch => {
            const task = data.tasks.find(item => item.id === launch.taskId);
            return resolveLaunchOutputs(task, [], launch);
        }).filter(output => {
            const key = output.storageKey || output.url || "";
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        return [...conversationOutputs, ...archived].sort((a, b) => Date.parse(b.log.createdAt) - Date.parse(a.log.createdAt));
    }, [data.mediaLogs, data.tasks, activeLaunches]);
    const folderFor = (p: CanvasProject) => data.canvasOwners.get(p.id);
    const isDrama = (p: CanvasProject) => data.canvasOwners.has(p.id);
    const dramaDestination = (p: CanvasProject) => {
        const episode = data.canvasEpisodes.get(p.id);
        return episode ? dramaWorkbenchPath(episode.dramaId, episode.episodeId) : `/production?dramaId=${encodeURIComponent(folderFor(p)?.id || "")}&workspace=series`;
    };
    const sorted = [...projects].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const latest = sorted[0];
    const projectIds = new Set(projects.map((p) => p.id));
    const date = (value: string) => (Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(i18n.resolvedLanguage, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
    const openDestination = async (destination: string) => {
        const requestId = ++openDestinationRequest.current;
        // 从「最近生成」的预览弹窗点「源画布」（或结果列表里跳画布）时，先收起结果浮层，
        // 否则路由/画布覆盖层切换后旧弹窗仍挂在首页 DOM 上，看起来像没跳过去。
        setPreviewOutput(null);
        setOutputsOpen(false);
        const target = canvasHostLocation(destination, "");
        if (target) {
            const openInOverlay = () => {
                setOverlayProjectId(target.projectId);
                canvasHost?.openCanvas({ projectId: target.projectId, nodeId: target.search.get("nodeId") || undefined, segmentId: target.search.get("segmentId") || undefined });
            };
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
    // Agent 面板的站点工具也走无画布生成：把任务登记到当前创作会话，避免「每轮对话自动建一张画布」。
    const recordLaunchRef = useRef<(launch: CreativeLaunch) => void>(() => {});
    useEffect(() => subscribeCreativeLaunches(launch => recordLaunchRef.current(launch)), []);
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
    recordLaunchRef.current = recordLaunch;
    // 影策「生成同款」：按该条消息的模式与参数再提交一次；nonce 驱动 composer 回填并直接生成。
    const regenerateLaunch = (launch: CreativeLaunch) => {
        setEditRequest(current => ({ text: launch.prompt, nonce: current.nonce + 1, submit: true, mode: launch.mode, params: launch.params }));
        setThreadActivePersisted(true);
    };
    // 最近画布首卡：与创作台「新建空白画布」一致，建完直接进入。
    const createBlankCanvas = () => {
        if (!hydrated) return;
        try {
            const id = createProject(t("canvas.defaultTitle", { count: projects.length + 1 }));
            openProject(id);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
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
        // 空会话回到创作台（此处不渲染对话工作台），滚回顶部让用户直接看到输入框。
        window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
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
    // 对话阶段零画布：只有用户点「新建画布」才把已完成的成果落成一张真实画布。
    const canCreateCanvas = activeLaunches.some(launch => {
        const task = data.tasks.find(item => item.id === launch.taskId);
        return task?.status === "succeeded" || data.logs.some(log => log.runtimeTaskId === launch.taskId && log.status === "success");
    }) || Boolean(activeConversation?.canvasId);
    const createCanvasFromConversation = async () => {
        if (!hydrated || !activeConversation || creatingCanvas) return;
        // 会话已经建过画布时直接回到那张画布，不重复创建。
        if (activeConversation.canvasId && projects.some(project => project.id === activeConversation.canvasId)) {
            await continueEditing(activeConversation.canvasId);
            return;
        }
        const results = activeLaunches.flatMap(launch => {
            const task = data.tasks.find(item => item.id === launch.taskId);
            if (!task || task.status !== "succeeded") return [];
            const media = (task.result?.media || []).map(item => ({
                url: item.url,
                storageKey: item.storageKey,
                mimeType: item.mimeType,
                width: item.width,
                height: item.height,
                bytes: item.bytes,
            }));
            const texts = launch.mode === "text" ? launchTextResults(task, []) : [];
            return media.length || texts.length ? [{ launch, media, texts }] : [];
        });
        if (!results.length) {
            message.info(t("home.workbench.threadCanvasPending"));
            return;
        }
        setCreatingCanvas(true);
        try {
            const id = createProject(creativeProjectTitle(activeConversation.title || results[0].launch.prompt));
            const nodes: CanvasNodeData[] = [];
            const connections: CanvasConnection[] = [];
            const logEntries: Array<{ nodeId: string; launch: CreativeLaunch; outputs: Array<Record<string, unknown>> }> = [];
            results.forEach(({ launch, media, texts }, row) => {
                const configId = nanoid();
                const y = 40 + row * 380;
                const configMetadata = {
                    smart: true,
                    generationMode: launch.mode,
                    prompt: launch.prompt,
                    composerContent: launch.prompt,
                    model: launch.model,
                    status: "success",
                    generationType: "generation",
                    generationEngine: "backend",
                } as CanvasNodeMetadata;
                nodes.push({ id: configId, type: "config", title: creativeProjectTitle(launch.prompt, 18), position: { x: 40, y }, width: 380, height: 300, metadata: configMetadata });
                media.forEach((item, index) => {
                    const nodeId = nanoid();
                    const mimeType = String(item.mimeType || "");
                    const kind = mimeType.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(item.url || "") ? "video"
                        : mimeType.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac)$/i.test(item.url || "") ? "audio" : "image";
                    const metadata = {
                        content: item.url,
                        storageKey: item.storageKey,
                        status: "success",
                        mimeType,
                        prompt: launch.prompt,
                        model: launch.model,
                        generationEngine: "backend",
                        ...(item.width ? { naturalWidth: item.width } : {}),
                        ...(item.height ? { naturalHeight: item.height } : {}),
                        ...(item.bytes ? { bytes: item.bytes } : {}),
                    } as CanvasNodeMetadata;
                    nodes.push({ id: nodeId, type: kind, title: creativeProjectTitle(launch.prompt, 18), position: { x: 480 + index * 380, y }, width: 340, height: kind === "audio" ? 140 : 190, metadata });
                    connections.push({ id: nanoid(), fromNodeId: configId, toNodeId: nodeId });
                });
                texts.forEach((text, index) => {
                    const nodeId = nanoid();
                    nodes.push({
                        id: nodeId, type: "text", title: creativeProjectTitle(launch.prompt, 18),
                        position: { x: 480 + index * 380, y }, width: 340, height: 220,
                        metadata: { content: text, status: "success", prompt: launch.prompt, model: launch.model, generationEngine: "backend" } as CanvasNodeMetadata,
                    });
                    connections.push({ id: nanoid(), fromNodeId: configId, toNodeId: nodeId });
                });
                if (media.length) logEntries.push({ nodeId: configId, launch, outputs: media.map(item => ({ url: item.url, storageKey: item.storageKey, mimeType: item.mimeType })) });
            });
            useCanvasStore.getState().updateProject(id, { nodes, connections });
            // 后台同步是 best-effort：节点已经落在本地 store，即使同步慢或后端暂时不可达，
            // 也不该把用户卡在对话里；恢复连接后自动同步会补上。
            try {
                await Promise.race([
                    flushCanvasProjectBeforeGeneration(id),
                    new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("画布同步超时，已保留本地草稿")), 1800)),
                ]);
            } catch (error) {
                console.warn("新建画布同步未完成，节点仍保留在本地草稿中", error);
            }
            // 补一条生成日志：让「最近生成」与画布封面立刻能看到这批刚落地的成果。
            await Promise.allSettled(logEntries.map(entry => createBackendGenerationLog({
                projectId: id,
                nodeId: entry.nodeId,
                status: "success",
                platform: `${entry.launch.mode}-canvas`,
                model: entry.launch.model,
                prompt: entry.launch.prompt,
                runtimeTaskId: entry.launch.taskId,
                startedAt: entry.launch.createdAt,
                finishedAt: entry.launch.createdAt,
                durationMs: 0,
                outputs: entry.outputs,
                references: [],
                inputCounts: {},
                params: {},
            })));
            const stamped = new Set(results.map(item => item.launch.taskId));
            persistConversations(conversations.map(conversation => conversation.id !== activeConversation.id ? conversation : {
                ...conversation,
                canvasId: id,
                launches: conversation.launches.map(launch => stamped.has(launch.taskId) ? { ...launch, projectId: id } : launch),
            }));
            data.refresh();
            message.success(t("home.workbench.threadCanvasCreated"));
            await continueEditing(id);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setCreatingCanvas(false);
        }
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
    // 仍为「最近画布」与「继续编辑」卡提供真实封面，但不再依赖已下线的筛选/分页状态。
    const coverProjects = sorted.slice(0, 4);
    const extraCover = useProjectCoverResults(coverProjects.filter((p) => !projectCover(p, outputs, folderFor(p))).map((p) => [p.id, p.updatedAt]));
    const coverKey = (p: CanvasProject) => JSON.stringify([data.backendUrl, p.id, p.updatedAt]);
    const stableCovers = useStableProjectCovers(coverProjects.map((p) => ({ key: coverKey(p), media: projectCover(p, outputs, folderFor(p)) || extraCover(p.id, p.updatedAt) })));
    const cover = (p: CanvasProject) => stableCovers[coverKey(p)] || null;
    const hasWork = Boolean(latest || folders.some((folder) => folder.isDrama));
    const latestCover = latest ? cover(latest) : null;
    const outputTitle = (o: WorkbenchOutput) => projects.find((p) => p.id === o.log.projectId)?.title || o.log.model || t("home.workbench.result");
    const outputCard = (o: WorkbenchOutput) => (
        <button key={o.id} type="button" className="ch-output-card group min-w-0 cursor-pointer text-left" onClick={() => setPreviewOutput(o)} aria-label={t("home.workbench.previewNamed", { name: outputTitle(o) })}>
            <div className="ch-output-cover">
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

    // 对齐影策：对话形态是全屏页（fixed 覆盖层），有活动会话且已有消息时接管整个视口；
    // 「返回」或「新对话」（空会话）退出覆盖层，回到创作台。
    const threadOverlayOpen = threadActive && Boolean(activeConversation) && activeLaunches.length > 0;
    useEffect(() => {
        if (!threadOverlayOpen) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => { document.body.style.overflow = previous; };
    }, [threadOverlayOpen]);
    // 画布覆盖层（z-900）打开时同样给出制作台/画布视图切换器：首页没有制作台工作台，
    // 「切回制作台视图」按当前画布归属导航——分集画布进分集制作台，共享资产画布进剧目规划。
    const overlayOwner = overlayProjectId ? data.canvasOwners.get(overlayProjectId) : undefined;
    const overlayEpisode = overlayProjectId ? data.canvasEpisodes.get(overlayProjectId) : undefined;
    const canSwitchToProduction = Boolean(canvasHost?.visible && overlayProjectId && (overlayOwner || overlayEpisode));
    const switchToProduction = () => {
        if (!overlayProjectId) return;
        canvasHost?.collapse?.();
        if (overlayEpisode) navigate(dramaWorkbenchPath(overlayEpisode.dramaId, overlayEpisode.episodeId));
        else if (overlayOwner) navigate(`/production?${new URLSearchParams({ dramaId: overlayOwner.id, workspace: "series", seriesView: "planning" })}`);
    };
    return (
        <main className="ui-controls min-h-full bg-background text-foreground" data-testid="home-workbench">
            {canSwitchToProduction && <WorkspaceViewSwitcher mode="canvas" onSelect={next => { if (next === "production") switchToProduction(); }} />}
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
                            onOpenProject={(id) => { if (id) openProject(id); else void createCanvasFromConversation(); }}
                            onPreview={setPreviewOutput}
                            onNewThread={startNewConversation}
                            onOpenHistory={() => setHistoryOpen(true)}
                            hasOtherConversations={otherConversationCount > 0}
                            onEditPrompt={(text) => setEditRequest(current => ({ text, nonce: current.nonce + 1 }))}
                            onCreateCanvas={() => void createCanvasFromConversation()}
                            canCreateCanvas={canCreateCanvas || creatingCanvas}
                            onBack={() => setThreadActivePersisted(false)}
                            onRegenerate={regenerateLaunch}
                        />
                    </div>
                </div>
            )}
            <div className="mx-auto max-w-[1440px] px-4 pt-6 pb-24 sm:px-6 lg:px-8">
                {/* 页头整块已下线（对齐影策的极简首页）：剧目/画布/任务入口在全局顶栏与导航中已有，
                    新建画布走创作台快捷卡「新建空白画布」；页面直接从创作台开始，不再有红框标题条。 */}
                {/* 影策 isEmpty 分支：非对话形态或活动会话还没有消息时，显示完整创作台（含示例与快捷入口）。 */}
                {(!threadActive || !activeConversation || activeLaunches.length === 0) && (
                    <>
                        <CreativeLaunchPad
                            onGenerated={recordLaunch}
                            historyCount={totalLaunchCount}
                            sharedProjectId={activeConversation?.canvasId}
                            injectedDraft={editRequest}
                            onOpenHistory={() => {
                                setThreadActivePersisted(true);
                                setHistoryOpen(true);
                            }}
                        />
                        {!threadOverlayOpen && (
                            <CreativeRecentCanvases
                                projects={sorted}
                                cover={cover}
                                onOpen={(id) => void continueEditing(id)}
                                onCreate={createBlankCanvas}
                                loading={!hydrated}
                            />
                        )}
                    </>
                )}
                {/* 「生成动态」历史卡片网格已下线；对话工作台统一由上面的全屏覆盖层承载：
                    有消息 → 全屏对话页；空会话（点「新对话」）→ 回到创作台输入，绝不在创作台里再挂一个
                    没有输入框的空对话壳。故这里不再内联渲染 CreativeGenerationFeed。 */}
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
                <section className="mt-6 border-t border-border pt-6" aria-label={t("home.workbench.recentOutputs")}>
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <h2 className="ui-panel-title inline-flex items-center gap-2"><Sparkles className="size-3.5 text-muted-foreground" aria-hidden="true" />{t("home.workbench.recentOutputs")}</h2>
                        <Button type="text" onClick={() => setOutputsOpen(true)}>
                            {t("home.workbench.viewResults")}
                            <ArrowRight className="size-4" />
                        </Button>
                    </div>
                    {data.mediaLoading && !data.mediaLogs.length ? (
                        <Skeleton active paragraph={{ rows: 2 }} />
                    ) : outputs.length ? (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">{outputs.slice(0, 6).map(outputCard)}</div>
                    ) : (
                        <div className="ui-body rounded-[10px] border border-dashed border-border py-7 text-center text-muted-foreground">{t(data.connected ? "home.workbench.noOutputs" : "home.workbench.offlineOutputs")}</div>
                    )}
                </section>
            </div>
            <Modal
                open={outputsOpen}
                title={t("home.workbench.recentOutputs")}
                onCancel={() => setOutputsOpen(false)}
                footer={
                    data.mediaHasMore ? (
                        <Button loading={data.mediaLoading} onClick={data.loadMoreMedia}>
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
                width={1100}
                destroyOnHidden
            >
                {previewOutput && (
                    <>
                        <div className="flex h-[min(70vh,640px)] items-center justify-center overflow-hidden rounded-lg bg-muted">
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
        </main>
    );
}
