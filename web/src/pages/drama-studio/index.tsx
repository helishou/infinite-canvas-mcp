import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App } from "antd";
import {
    ArrowLeft,
    Search,
    Plus,
    List,
    LayoutGrid,
    Package,
    Palette,
    Pause,
    Play,
    RefreshCw,
    ChevronDown,
    CircleAlert,
    LoaderCircle,
    CheckCircle2,
    ExternalLink,
    MoreHorizontal,
    Pencil,
    BookOpen,
    Film,
    Scissors,
    Sparkles,
    Wand2,
    Zap,
    Copy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { WorkspaceViewSwitcher } from "@/components/production/workspace-view-switcher";
import DramaPage from "@/pages/drama/index";
import { AdaptStoryboardPanel } from "@/pages/drama/adapt-storyboard-panel";
import { backendMediaUrl } from "@/services/backend-api";
import { resolveBackendAgentEndpoint, runVideoConcatTask } from "@/services/api/comfyui";
import { saveAs } from "file-saver";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useStudioData, type StudioEpisode, type StudioStatus } from "./use-studio-data";
import { Dropdown, Modal, type MenuProps } from "antd";
import { dramaWorkbenchPath } from "@/pages/drama/workbench-entry";
import { WorkbenchCanvas } from "@/pages/drama/workbench-canvas";
import { useWorkbenchCanvas } from "@/lib/canvas/canvas-host";
import { StudioSettingsTab, loadStudioSettings, type StudioProductionSettings } from "./studio-settings-tab";
import { skillInstruction } from "./studio-skill-picker";
import { fetchSkillDetail } from "@/services/api/skill-market";
import { launchPlanningDirector } from "@/pages/drama/planning-director-launch";
import { planningPrompt } from "@/pages/drama/planning-director-prompt";
import { fetchBackendDramaEpisodes, fetchEpisodeProduction, fetchProductionReadiness, editEpisodeProduction } from "@/services/backend-api";
import { exportAchengDeliveryBundle } from "@/lib/acheng-delivery-export";
import { buildPackFromProduction, importDirectorPackIntoEpisode } from "@/pages/drama/director-pack-bar";
import { packToZip, zipToPack } from "@/lib/director-pack-io";
import { collectPackClips, buildPackGroupMedia } from "@/lib/director-pack-canvas";
import { collectPackRefs, importPackRefs } from "@/lib/director-pack-assets";
import { productionCanvasNodes } from "@/pages/drama/production-canvas-nodes";
import {
    startDramaPipeline, pauseDramaPipeline, resumeDramaPipeline, fetchDramaPipelineStatus,
    retryFailedDramaPipeline, approveDramaPipelineEpisode, releaseDramaPipelineMedia, type DramaPipelineStatus,
} from "@/services/backend-api";
import { StudioAssetsTab } from "./studio-assets-tab";
import { StudioDetailPanel, type DetailTab } from "./studio-detail-panel";
import { StudioInboxTab } from "./studio-inbox-tab";
import type { DirectorWorkspace } from "@/pages/drama/director-panel";
import { StudioChapterPickerModal } from "./studio-chapter-picker";

/**
 * 影策（open-ai-canvas）短剧制作台的像素级复刻 + 真实数据/逻辑接线。
 * UI 参照 `tmp/oac/studio.png`；数据走 backend-api，不新增第二份真值。
 */

type TopTab = "制作" | "项目资产" | "待处理" | "设置";
type EpisodeFilter = "全部" | StudioStatus;

const TOP_TABS: TopTab[] = ["制作", "项目资产", "待处理", "设置"];
/** 影策详情区分页：剧本 / 分镜 / 成片（截图实测，只有这三个）。 */
const WORKSPACE_TABS: Array<{ key: DetailTab; label: string }> = [
    { key: "story", label: "剧本" },
    { key: "shots", label: "分镜" },
    { key: "clips", label: "成片" },
];
const DETAIL_WORKSPACES: DetailTab[] = ["story", "shots", "clips"];
/** 本地辅助 workspace 归到影策哪一页高亮（工具菜单入口不额外占 tab）。 */
const WORKSPACE_PARENT: Partial<Record<DirectorWorkspace, DirectorWorkspace>> = {
    overview: "story",
    assets: "story",
    continuity: "shots",
    production: "shots",
    advanced: "clips",
};

function StatusChip({ status }: { status: StudioStatus }) {
    return (
        <span
            className={cn(
                "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] leading-none",
                status === "待生成" && "bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-400",
                status === "需要处理" && "bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400",
                status === "制作中" && "bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400",
                status === "已完成" && "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400",
            )}
        >
            {status}
        </span>
    );
}

/** 影策 4 段阶段进度：剧本 / 段提示词 / 视频 / 成片，每段按真实产物填充 0..1。 */
const STAGE_PIPS = [
    { key: "script", label: "剧本" },
    { key: "prompts", label: "段提示词" },
    { key: "video", label: "视频" },
    { key: "render", label: "成片" },
] as const;

/** 影策详情头阶段文案：等待审阅 / 待生成 / 制作中 / 已完成（从真实 status 派生）。 */
function headStageLabel(ep: StudioEpisode): string {
    if (ep.status === "已完成") return "已完成";
    if (ep.status === "待生成") return "等待审阅";
    if (ep.status === "需要处理") return "需要处理";
    return "制作中";
}

/** 只从真实字段派生，不拿代理字段冒充完成：有正文/有段/有发布版本才算推进。 */
function stageFills(ep: StudioEpisode): number[] {
    const script = ep.hasScript || ["assets", "shots", "video"].includes(ep.stage) ? 1 : 0;
    const prompts = ep.segmentCount > 0 ? 1 : ep.shotCount > 0 ? 0.5 : 0;
    const video = ep.publishedVersion > 0 ? 1 : ep.segmentCount > 0 ? 0.5 : 0;
    const render = ep.publishedVersion > 0 ? 1 : 0;
    return [script, prompts, video, render];
}

function StagePips({ episode, size = "sm" }: { episode: StudioEpisode; size?: "sm" | "md" }) {
    const fills = stageFills(episode);
    const bar = size === "md" ? "h-2 w-6" : "h-1.5 w-4";
    return (
        <span className="flex items-center gap-[2px]" aria-label={`阶段进度：${STAGE_PIPS.map((s, i) => `${s.label}${Math.round(fills[i] * 100)}%`).join("，")}`}>
            {fills.map((fill, i) => (
                <span key={STAGE_PIPS[i].key} title={STAGE_PIPS[i].label} className={cn("relative overflow-hidden rounded-full bg-muted-foreground/20", bar)}>
                    <span
                        className="absolute inset-y-0 left-0 rounded-full bg-rose-500"
                        style={{ width: `${Math.round(fill * 100)}%` }}
                    />
                </span>
            ))}
        </span>
    );
}

function EmptyState({
    icon,
    title,
    description,
    actionLabel,
    actionIcon: ActionIcon,
    onAction,
    busy,
}: {
    icon: React.ReactNode;
    title: string;
    description: string;
    actionLabel?: string;
    actionIcon?: React.ComponentType<{ className?: string }>;
    onAction?: () => void;
    busy?: boolean;
}) {
    return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
            <div className="mb-5 flex size-24 items-center justify-center rounded-full border-4 border-muted">{icon}</div>
            <h3 className="text-sm font-semibold">{title}</h3>
            <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>
            {actionLabel && onAction ? (
                <button
                    type="button"
                    onClick={onAction}
                    disabled={busy}
                    className="mt-4 flex h-9 items-center gap-2 rounded-md bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-60"
                >
                    {ActionIcon ? <ActionIcon className={cn("size-3.5", busy && "animate-spin")} /> : null}
                    {busy ? "处理中…" : actionLabel}
                </button>
            ) : null}
        </div>
    );
}

export default function DramaStudioPage() {
    return <WorkbenchCanvas storageKey="drama-studio"><DramaStudioInner /></WorkbenchCanvas>;
}

function DramaStudioInner() {
    const navigate = useNavigate();
    const canvasHost = useWorkbenchCanvas();
    const { message, modal } = App.useApp();
    const [query, setQuery] = useSearchParams();
    const folders = useCanvasStore((state) => state.folders);
    const hydrated = useCanvasStore((state) => state.hydrated);

    const dramaFolders = useMemo(
        () => folders.filter((folder) => folder.isDrama).slice().sort((a, b) => (Date.parse(b.updatedAt || b.createdAt) || 0) - (Date.parse(a.updatedAt || a.createdAt) || 0)),
        [folders],
    );

    // dramaId 来自 URL；没有则默认取最近更新的剧目并写回 URL。
    const urlDramaId = query.get("dramaId");
    const dramaId = urlDramaId && dramaFolders.some((f) => f.id === urlDramaId)
        ? urlDramaId
        : dramaFolders[0]?.id || null;
    const currentFolder = dramaFolders.find((f) => f.id === dramaId);

    const data = useStudioData(dramaId, query.get("episodeId"));
    const {
        episodes, rawEpisodes, assets, stage, production, batches, counts, queue,
        jobCounts, inbox, productionState, clipMedia,
        loading, detailLoading, connected, refreshAll, addEpisode, batchCreateEpisodes, insertEpisode, removeEpisode, adaptEpisode, extractEpisodeAssets, writeSegmentPrompt, approveEpisodeVideo, renameEpisode, toggleBatch,
    } = data;

    const [topTab, setTopTab] = useState<TopTab>("制作");
    const [assetsInitialSub, setAssetsInitialSub] = useState<"library" | "audit" | "versions" | undefined>(undefined);
    // 全自动流水线状态（影策服务端自动编排的本地等价物），运行时每 3s 轮询。
    const [pipeline, setPipeline] = useState<DramaPipelineStatus | null>(null);
    const [pipelineBusy, setPipelineBusy] = useState(false);
    const [createWizardOpen, setCreateWizardOpen] = useState(() => query.get("new") === "1");
    const [splitOpen, setSplitOpen] = useState(false);
    const [filter, setFilter] = useState<EpisodeFilter>("全部");
    const [chapterPickerOpen, setChapterPickerOpen] = useState(false);
    const urlWorkspace = query.get("workspace");
    // 影策详情区只有 剧本/分镜/成片 三页；工具菜单里的辅助 workspace 也合法，不回退。
    const ALL_WORKSPACES: DirectorWorkspace[] = ["story", "shots", "clips", "overview", "assets", "continuity", "production", "advanced"];
    const workspace = (ALL_WORKSPACES.includes(urlWorkspace as DirectorWorkspace) ? urlWorkspace : "story") as DirectorWorkspace;
    const activeStudioTab = ((DETAIL_WORKSPACES.includes(workspace as DetailTab) ? workspace : WORKSPACE_PARENT[workspace]) || "story") as DetailTab;
    const detailTab = activeStudioTab;
    const [search, setSearch] = useState("");
    const [view, setView] = useState<"list" | "grid">("list");
    // 暂停态按剧目持久化（本地后端没有全局 production 记录）
    const pauseKey = `drama-studio:paused:${dramaId || ""}`;
    const [paused, setPaused] = useState(() => {
        try { return localStorage.getItem(pauseKey) === "1"; } catch { return false; }
    });
    useEffect(() => {
        try { setPaused(localStorage.getItem(pauseKey) === "1"); } catch { setPaused(false); }
    }, [pauseKey]);
    const setPausedPersist = (value: boolean | ((p: boolean) => boolean)) => {
        setPaused((current) => {
            const next = typeof value === "function" ? value(current) : value;
            try { localStorage.setItem(pauseKey, next ? "1" : "0"); } catch { /* 隐私模式忽略 */ }
            return next;
        });
    };
    const [queueOpen, setQueueOpen] = useState(false);
    const [queueFilter, setQueueFilter] = useState<"all" | "active" | "failed">("all");
    const [queueDetail, setQueueDetail] = useState<{ title: string; error: string; prompt?: string; status?: string } | null>(null);
    const [studioSettings, setStudioSettings] = useState<StudioProductionSettings>(() => loadStudioSettings(dramaId));
    const [savingSettings, setSavingSettings] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    // 集标题内联编辑（对齐影策 detail.tsx：回车保存 / Esc 取消 / 失焦保存）
    const [renaming, setRenaming] = useState(false);

    // 剧目切换时重载该剧目的制作设置
    useEffect(() => { setStudioSettings(loadStudioSettings(dramaId)); }, [dramaId]);

    // 全自动流水线状态轮询：仅在有 dramaId 时每 3s 拉一次（对齐影策调度器 tick）。
    useEffect(() => {
        if (!dramaId || !connected) { setPipeline(null); return; }
        let alive = true;
        const poll = () => { void fetchDramaPipelineStatus(dramaId).then(s => { if (alive && s?.ok) setPipeline(s); }).catch(() => undefined); };
        poll();
        const timer = window.setInterval(poll, 3000);
        return () => { alive = false; window.clearInterval(timer); };
    }, [dramaId, connected]);

    /** 制作设置真实驱动流水线：审阅方式/生成节奏 + 全部制作设置作为 options 下发到后端运行期。
     *  后端 startSchema 接受 options（模型/思考等级/视频模型/参考图上限/并发/分镜规则），各 job 消费点真实读取。 */
    const pipelineOpts = {
        reviewMode: studioSettings.reviewMode,
        mediaMode: studioSettings.mediaMode,
        options: {
            storyboardModel: studioSettings.storyboardModel || undefined,
            assetExtractModel: studioSettings.assetExtractModel || undefined,
            videoPromptModel: studioSettings.videoPromptModel || undefined,
            textThinking: {
                storyboard: studioSettings.textThinking.storyboard,
                extract: studioSettings.textThinking.extract,
                prompt: studioSettings.textThinking.prompt,
            },
            videoModel: studioSettings.videoModel || undefined,
            referenceLimit: studioSettings.referenceLimit || undefined,
            independent: studioSettings.continuationMode === "parallel",
            imageModelsByKind: {
                ...(studioSettings.characterImageModel ? { character: studioSettings.characterImageModel } : {}),
                ...(studioSettings.sceneImageModel ? { scene: studioSettings.sceneImageModel } : {}),
                ...(studioSettings.propImageModel ? { prop: studioSettings.propImageModel } : {}),
            },
            storyboardRules: {
                episodeSeconds: studioSettings.episodeSeconds,
                segmentRange: studioSettings.segmentRange,
                dialogueDensity: studioSettings.dialogueDensity,
                transitionMode: studioSettings.transitionMode,
                transitionMs: studioSettings.transitionMs,
                pacing: studioSettings.pacing,
            },
            // 前端 assemble 对应后端 render 池；image 池后端暂未使用，不下发。
            concurrency: {
                text: studioSettings.concurrency.text,
                video: studioSettings.concurrency.video,
                render: studioSettings.concurrency.assemble,
            },
        },
    };
    const pipelineModeLabel = `${studioSettings.reviewMode === "auto" ? "全自动" : studioSettings.reviewMode === "sample" ? "样片确认" : "每集审阅"} · ${studioSettings.mediaMode === "auto" ? "自动出片" : "手动放行"}`;

    const handlePipelineStart = () => {
        if (!dramaId) return void message.warning("请先选择剧目");
        setPipelineBusy(true);
        void (async () => {
            try {
                const running = pipeline?.pipeline?.status === "running";
                if (running) { await pauseDramaPipeline(dramaId); message.success("已暂停全自动流水线"); }
                else { await startDramaPipeline(dramaId, pipelineOpts); message.success(`流水线已启动（${pipelineModeLabel}）：脚本→拆镜→资产→提示词→视频→成片按设置推进`); }
                setPipeline(await fetchDramaPipelineStatus(dramaId));
            } catch (error) { message.error(`操作失败：${(error as Error).message}`); }
            finally { setPipelineBusy(false); }
        })();
    };

    /** 影策「全部生成视频·N集」确认弹窗（对齐 detail.tsx:320-328），确认后启动全自动流水线。 */
    const confirmReleaseAll = () => {
        modal.confirm({
            title: `为 ${awaitingCount} 集开始生成视频？`,
            content: "会生成角色、道具与场景参考图，并按剧情段为这些集生成带对白与音效的视频。建议先挑一集生成，确认画风与角色形象后再全部开始。",
            okText: "全部开始",
            cancelText: "再看看",
            centered: true,
            onOk: () => {
                if (!dramaId) return;
                void (async () => {
                    try {
                        await startDramaPipeline(dramaId, pipelineOpts);
                        message.success(`已为 ${awaitingCount} 集启动生成（${pipelineModeLabel}）`);
                        setPipeline(await fetchDramaPipelineStatus(dramaId));
                    } catch (error) { message.error(`操作失败：${(error as Error).message}`); }
                })();
            },
        });
    };

    const saveStudioSettings = () => {
        if (!dramaId) return void message.warning("请先选择剧目");
        setSavingSettings(true);
        void (async () => {
            try {
                localStorage.setItem(`drama-studio:settings:${dramaId}`, JSON.stringify(studioSettings));
                // 参考图模型真实落点：写进当前集制作稿的 settings.imageModelsByKind。
                // backend/drama/canvas-inputs.ts:143 生成参考图时按 character/scene/prop 读该字段，真实生效。
                const imageModelsByKind: Record<string, string> = {};
                if (studioSettings.characterImageModel) imageModelsByKind.character = studioSettings.characterImageModel;
                if (studioSettings.sceneImageModel) imageModelsByKind.scene = studioSettings.sceneImageModel;
                if (studioSettings.propImageModel) imageModelsByKind.prop = studioSettings.propImageModel;
                const targetId = current?.id || episodes[0]?.id;
                let appliedToProduction = false;
                if (targetId && Object.keys(imageModelsByKind).length) {
                    try {
                        const fresh = await fetchEpisodeProduction(targetId as never);
                        await editEpisodeProduction(targetId as never, fresh.production.revision, [
                            { type: "set_settings", patch: { imageModelsByKind } } as never,
                        ]);
                        appliedToProduction = true;
                    } catch { /* 制作稿未就绪时不阻断设置保存 */ }
                }
                message.success(appliedToProduction
                    ? "制作设置已保存，参考图模型已写入当前集制作稿"
                    : "制作设置已保存（参考图模型将在制作稿就绪后生效）");
                void refreshAll();
            } catch {
                message.error("保存失败：本地存储不可用");
            } finally {
                setSavingSettings(false);
            }
        })();
    };

    // 剧目切换：写回 URL，episodeId 清空让详情落到最新一集。
    useEffect(() => {
        if (!dramaId) return;
        if (urlDramaId !== dramaId) {
            const next = new URLSearchParams(query);
            next.set("dramaId", dramaId);
            next.delete("episodeId");
            setQuery(next, { replace: true });
        }
    }, [dramaId, urlDramaId, query, setQuery]);

    // 没有指定 episodeId 时，选中进度最靠前的一集（便于继续制作）。
    useEffect(() => {
        if (loading || episodes.length === 0 || query.get("episodeId")) return;
        const focus = episodes.find((ep) => ep.status === "制作中") || episodes[episodes.length - 1];
        const next = new URLSearchParams(query);
        next.set("episodeId", focus.id);
        setQuery(next, { replace: true });
    }, [loading, episodes, query, setQuery]);

    const visibleEpisodes = useMemo(() => {
        return episodes.filter((ep) => {
            if (filter !== "全部" && ep.status !== filter) return false;
            if (search.trim() && !ep.title.includes(search.trim()) && !String(ep.no).includes(search.trim())) return false;
            return true;
        });
    }, [episodes, filter, search]);

    const filters: { key: EpisodeFilter; count: number }[] = [
        { key: "全部", count: episodes.length },
        ...(counts["待生成"] || filter === "待生成" ? [{ key: "待生成" as EpisodeFilter, count: counts["待生成"] }] : []),
        { key: "需要处理", count: counts["需要处理"] },
        { key: "制作中", count: counts["制作中"] },
        { key: "已完成", count: counts["已完成"] },
    ];

    const selectedId = query.get("episodeId");
    const current: StudioEpisode | undefined = episodes.find((ep) => ep.id === selectedId) || episodes[0];

    const selectEpisode = (ep: StudioEpisode) => {
        const next = new URLSearchParams(query);
        next.set("episodeId", ep.id);
        setQuery(next);
    };

    const openInCanvas = (segmentId?: string) => {
        if (!dramaId || !current) return;
        // 影策「在画布中打开本集」是在制作台内原地打开精修画布浮层，不跳到老版 /production。
        // 当前集画布 id 即 canvas projectId；带 segmentId 时画布直接定位到该剧情段（生成/精修按钮用）。
        const projectId = current.canvasId || currentFolder?.sharedAssetCanvasId;
        if (projectId && canvasHost) {
            canvasHost.openCanvas({ projectId, ...(segmentId ? { segmentId } : {}) });
            return;
        }
        // 兜底：画布 host 不可用时（例如独立嵌入）才回退到路由，带 segmentId 定位。
        navigate(dramaWorkbenchPath(dramaId, current.id, "shots") + (segmentId ? `&segmentId=${encodeURIComponent(segmentId)}` : ""));
    };

    /** 影策成片页「导出剪映草稿 / 导出交付包」：真调交付包导出（剪映草稿 + SRT + 媒体 + 提示词）。 */
    const exportJianying = async (variant: "jianying" | "delivery" = "jianying") => {
        if (!current) return void message.warning("请先选一集");
        if (!production) return void message.warning("本集制作稿尚未就绪，无法导出");
        const canvasId = current.canvasId || "";
        setBusy("export");
        try {
            const readiness = (await fetchProductionReadiness(current.id as never)).readiness;
            const project = canvasId ? useCanvasStore.getState().projects.find((p) => p.id === canvasId) : undefined;
            const canvasNodes = productionCanvasNodes(canvasId, project ? {
                id: project.id, revision: project.revision, summary: project.summary, nodes: project.nodes,
            } : undefined, undefined);
            const bundle = await exportAchengDeliveryBundle({
                owner: { kind: "episode", id: current.id },
                title: current.title,
                projectId: canvasId,
                production,
                readiness,
                canvasNodes: canvasNodes as Parameters<typeof exportAchengDeliveryBundle>[0]["canvasNodes"],
                includeGeneratedMedia: true,
            });
            const url = URL.createObjectURL(bundle);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = variant === "delivery"
                ? `${current.title.replace(/[^\p{L}\p{N}._-]+/gu, "_")}-交付包-r${production.revision}.zip`
                : `${current.title.replace(/[^\p{L}\p{N}._-]+/gu, "_")}-剪映草稿-r${production.revision}.zip`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1500);
            message.success(variant === "delivery"
                ? "交付包已导出（成片 + SRT 字幕 + 段提示词 + 媒体）"
                : "剪映草稿交付包已导出（含草稿目录与字幕 SRT）");
        } catch (error) {
            message.error(`导出失败：${(error as Error).message}`);
        } finally {
            setBusy(null);
        }
    };

    /** 影策「一键打包全部资产」：导演包导出（段提示词 + H3 参考图 + 时间线），真出 .mmxpack.zip。 */
    const exportPack = async () => {
        if (!current) return void message.warning("请先选一集");
        if (!production) return void message.warning("本集制作稿尚未就绪，无法打包");
        setBusy("pack");
        try {
            const canvasClips = current.canvasId ? await collectPackClips(current.canvasId).catch(() => null) : null;
            const clipPrompts = new Map<string, string>();
            for (const [targetId, clip] of canvasClips || []) if (clip.prompt) clipPrompts.set(targetId, clip.prompt);
            const pack = buildPackFromProduction({
                title: current.title,
                production: production as Parameters<typeof buildPackFromProduction>[0]["production"],
                clipPrompts,
            });
            let refCount = 0;
            for (const group of pack.groups) {
                const clip = canvasClips?.get(group.segment.id);
                if (!clip?.images.length) continue;
                const media = await buildPackGroupMedia({ groupIndex: group.index, images: clip.images });
                group.images = media.images;
                group.segment.refs = media.refs;
                refCount += media.images.length;
            }
            for (const group of pack.groups) {
                const self = pack.timeline.segments.find((s) => s.id === group.segment.id);
                if (self) self.refs = group.segment.refs;
            }
            const bytes = packToZip(pack);
            const blob = new Blob([bytes as unknown as BlobPart], { type: "application/zip" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${current.title.replace(/[^\p{L}\p{N}._-]+/gu, "_")}-资产包-r${production.revision}.mmxpack.zip`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1500);
            message.success(`资产包已导出（${pack.timeline.segments.length} 段 · ${refCount} 张参考图）`);
        } catch (error) {
            message.error(`打包失败：${(error as Error).message}`);
        } finally {
            setBusy(null);
        }
    };

    /** 影策「导入资产包」：上传 .mmxpack.zip → 参考图入库 + 段提示词/分镜写回制作稿并上画布。 */
    const importPackFile = async (file: File) => {
        if (!current) return void message.warning("请先选一集");
        const rawEp = rawEpisodes.find((ep) => ep.id === current.id);
        if (!rawEp) return void message.warning("找不到本集的原始数据");
        setBusy("import-pack");
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const pack = zipToPack(bytes);
            const packName = file.name.replace(/\.mmxpack\.zip$/i, "").replace(/\.zip$/i, "");
            const refs = await importPackRefs({ episodeId: rawEp.id, dramaId: rawEp.dramaId, packName, groups: pack.groups });
            const result = await importDirectorPackIntoEpisode(rawEp, pack);
            message.success(`资产包已导入（${result.written} 段 · ${refs.uploaded} 张参考图）`);
            await refreshAll();
        } catch (error) {
            message.error(`导入失败：${(error as Error).message}`);
        } finally {
            setBusy(null);
            if (packFileRef.current) packFileRef.current.value = "";
        }
    };
    const packFileRef = useRef<HTMLInputElement | null>(null);

    /** 影策的每个制作能力直接在制作台详情区原地切换，不跳走、不降级成外链。 */
    const openWorkspace = (next: DirectorWorkspace) => {
        if (!dramaId) return void message.warning("请先选择剧目");
        if (!current) return void message.warning("请先选一集");
        setTopTab("制作");
        const params = new URLSearchParams(query);
        params.set("dramaId", dramaId);
        params.set("episodeId", current.id);
        params.set("workspace", next);
        setQuery(params);
    };

    /** 从待处理卡片跳到某集的指定 workspace（制作=story，审阅=shots）。 */
    const openEpisodeWorkspace = (episodeId: string, next: DirectorWorkspace) => {
        const params = new URLSearchParams(query);
        params.set("episodeId", episodeId);
        params.set("workspace", next);
        setQuery(params);
        setTopTab("制作");
    };

    /** 按集核查/资产库：读某集制作稿 source + revision + 生成状态（真实数据，不经第二份真值）。 */
    const productionOf = async (episodeId: string): Promise<{ source: Record<string, unknown> | null; revision: number; assets: Record<string, unknown>; assetCards: unknown[] } | null> => {
        try {
            const result = await fetchEpisodeProduction(episodeId as never);
            const draft = (result.production?.draft || {}) as Record<string, unknown>;
            const director = (draft.director || {}) as Record<string, unknown>;
            const source = (director.source as Record<string, unknown>) || null;
            return {
                source,
                revision: result.production?.revision ?? 0,
                assets: (director.assets && typeof director.assets === "object" ? director.assets : {}) as Record<string, unknown>,
                assetCards: Array.isArray(source?.asset_cards) ? source.asset_cards : [],
            };
        } catch { return null; }
    };

    /** 与本集「小影/导演」讨论：复用本地导演 agent 面板，带上剧目与本集上下文。 */
    const discussWithDirector = () => {
        if (!dramaId || !current) return void message.warning("请先选一集");
        const result = launchPlanningDirector(planningPrompt("script", {
            dramaId,
            name: currentFolder?.name || dramaId,
            pendingEpisodes: episodes.filter((ep) => ep.status === "需要处理").map((ep) => ep.no),
        }));
        if (result === "offline") message.warning("导演 Agent 未连接，请在右侧 Agent 面板先完成连接");
        else if (result === "busy") message.info("导演正在处理上一件事，请稍候");
    };

    const handleBatchCreateEpisodes = async () => {
        setBusy("add");
        try {
            const created = await batchCreateEpisodes();
            if (created > 0) {
                message.success(`已按原文批量建 ${created} 集`);
                void refreshAll();
            } else {
                message.info("没有可新建的集（原文已全部建集，或还没有原文）");
            }
        } catch (error) {
            message.error(`批量建集失败：${(error as Error).message}`);
        } finally { setBusy(null); }
    };

    const handleAddEpisode = async () => {
        setBusy("add");
        try {
            const created = await addEpisode();
            message.success(created ? `已添加第 ${created.episodeNumber} 集` : "已添加剧集");
            if (created) {
                const next = new URLSearchParams(query);
                next.set("episodeId", created.id);
                setQuery(next);
            }
        } catch (error) {
            message.error(`添加失败：${(error as Error).message}`);
        } finally {
            setBusy(null);
        }
    };

    /** 影策详情头：改本集标题，走后端 PATCH，落真实数据。 */
    const handleRenameEpisode = (ep: StudioEpisode) => {
        if (!ep) return;
        setRenaming(true);
    };

    /** 内联保存集标题（对齐影策：失焦/回车保存，Esc 取消）。 */
    const saveEpisodeTitle = async (ep: StudioEpisode, raw: string) => {
        const next = raw.trim();
        setRenaming(false);
        if (!next || next === ep.title) return;
        setBusy("rename");
        try {
            await renameEpisode(ep.id, next);
            message.success("已保存本集标题");
        } catch (error) {
            message.error(`保存失败：${(error as Error).message}`);
        } finally {
            setBusy(null);
        }
    };

    /** 影策 media/release：放行流水线的资产/成片媒体闸门（manual 媒体模式下发布素材后推进用）。 */
    const handleReleaseMedia = () => {
        if (!dramaId) return void message.warning("请先选择剧目");
        modal.confirm({
            title: "放行本剧媒体？",
            content: "确认角色/道具/场景参考图与素材已就绪后放行，流水线将继续生成段视频与合成成片。",
            okText: "放行媒体",
            cancelText: "再看看",
            centered: true,
            onOk: () => void (async () => {
                try {
                    await releaseDramaPipelineMedia(dramaId, "all");
                    await fetchDramaPipelineStatus(dramaId).then((s) => setPipeline(s));
                    message.success("媒体已放行，流水线继续推进");
                } catch (error) { message.error(`放行失败：${(error as Error).message}`); }
            })(),
        });
    };

    const handleRetryAll = async () => {
        if (!dramaId) return void message.warning("请先选择剧目");
        setBusy("retry");
        try {
            // 影策 /retry-failed：把流水线里失败的任务重新入队；后端新能力此前只 import 未调用。
            const result = await retryFailedDramaPipeline(dramaId);
            await refreshAll();
            const requeued = Number(result?.requeued || 0);
            message.success(requeued > 0 ? `已重新排队 ${requeued} 项失败任务` : "没有可重试的失败任务，已刷新全部制作数据");
        } catch (error) {
            message.error(`重试失败：${(error as Error).message}`);
        } finally {
            setBusy(null);
        }
    };

    const handleTogglePause = async () => {
        const running = batches.find((b) => ["running", "checking", "compiling", "applying"].includes((b.status || "").toLowerCase()));
        if (running) {
            setBusy("pause");
            try {
                await toggleBatch(running.runId, paused ? "resume" : "pause");
                setPausedPersist((p) => !p);
                message.success(paused ? "已继续当前生成" : "已暂停当前生成");
            } catch (error) {
                message.error(`操作失败：${(error as Error).message}`);
            } finally {
                setBusy(null);
            }
        } else {
            // 没有生产批次时，暂停/继续作用于全自动流水线（后端真接口），不再只写本地标记。
            if (!dramaId) return void message.warning("请先选择剧目");
            setBusy("pause");
            try {
                if (paused) { await resumeDramaPipeline(dramaId); message.success("已恢复全自动流水线"); }
                else { await pauseDramaPipeline(dramaId); message.success("已暂停全自动流水线"); }
                setPausedPersist((p) => !p);
                setPipeline(await fetchDramaPipelineStatus(dramaId));
            } catch (error) {
                message.error(`操作失败：${(error as Error).message}`);
            } finally {
                setBusy(null);
            }
        }
    };

    const completed = counts["已完成"];
    const total = episodes.length;
    const progressPct = total ? Math.round((completed / total) * 100) : 0;

    // v2 制作稿把场次/镜头/剧情段放在 director.source；同时兼容老结构的顶层数组。
    // 真实字段名：script_scenes / shots / segments（对齐 use-studio-data.deriveStageFromProduction）。
    const draft = (production?.draft || {}) as Record<string, unknown>;
    const directorSource = (draft.director as Record<string, unknown> | undefined)?.source as Record<string, unknown> | undefined;
    const scenes = Array.isArray(draft.scenes) ? draft.scenes
        : Array.isArray(directorSource?.script_scenes) ? directorSource!.script_scenes
            : Array.isArray(directorSource?.scenes) ? directorSource!.scenes : [];
    const shots = Array.isArray(draft.shots) ? draft.shots : Array.isArray(directorSource?.shots) ? directorSource!.shots : [];
    const clipGroups = Array.isArray(draft.clipGroups) ? draft.clipGroups
        : Array.isArray(directorSource?.segments) ? directorSource!.segments : [];
    // 影策详情头显示时长：帧按制作稿 fps_num/fps_den 换算（默认 24）。
    const headFps = Number(directorSource?.fps_num || 24) / Number(directorSource?.fps_den || 1) || 24;
    const headDurationSec = shots.reduce((sum, s) => {
        const f = Number((s as Record<string, unknown>)?.duration_frames || 0);
        return sum + (Number.isFinite(f) && f > 0 ? f / headFps : 0);
    }, 0);

    // 影策 inbox：真实生成错误 + 阶段缺口，已由数据层按集归并
    const errorInbox = inbox.filter((item) => item.kind === "episode_error" || item.kind === "job_failed");

    // 影策 awaitingMedia = 本地 status「待生成」：已拆镜有镜头、但尚未发布成片（publishedVersion===0）。
    // 见 use-studio-data.ts:205 状态派生；stage=video 反而是"已发布成片"，不能用来判 awaiting。
    const awaitingCount = episodes.filter((ep) => !ep.error && ep.status === "待生成").length;

    // 底部队列统一视图（对齐影策 queue-bar）：errorInbox + 批次，带筛选状态
    type QueueJob = { id: string; title: string; error: string; prompt?: string; status: string; episodeId?: string };
    const queueJobs: QueueJob[] = [
        ...errorInbox.map((it) => ({
            id: it.id, title: it.title, error: it.detail || "", prompt: undefined,
            status: "failed", episodeId: it.episodeId,
        })),
        ...batches.map((b) => ({
            id: b.runId, title: `批次 v${b.version} · ${b.targets?.length || 0} 目标`,
            error: b.error || "", status: (b.status || "").toLowerCase(), episodeId: b.episodeId,
            prompt: b.plan ? JSON.stringify(b.plan, null, 2) : undefined,
        })),
    ];
    const filteredQueue = queueJobs.filter((j) => {
        if (queueFilter === "all") return true;
        if (queueFilter === "failed") return ["failed", "error", "retry"].includes(j.status) || Boolean(j.error);
        return ["running", "checking", "compiling", "applying", "queued"].includes(j.status);
    });

    /** 作品/分集方式只读展示用的真实分集口径（来自 folder.productionPlan.sourceSplit）。 */
    const sourceSplit = (currentFolder?.productionPlan as Record<string, unknown> | undefined)?.sourceSplit as Record<string, unknown> | undefined;
    const studioInfo = {
        dramaName: currentFolder?.name || "",
        episodeCount: episodes.length,
        chapterCount: productionState.chapterCount,
        perEpisode: Number(sourceSplit?.perEpisode) || 1,
        excludedCount: Array.isArray(sourceSplit?.excluded) ? (sourceSplit!.excluded as number[]).length : 0,
    };

    /** 影策：插入集打开与追加相同的原文编辑弹窗，新集取插入位置集号、后面顺延。 */
    const handleInsertEpisode = (no: number, position: "before" | "after") => {
        const targetNo = position === "before" ? no : no + 1;
        let title = `第 ${targetNo} 集`;
        let synopsis = "";
        Modal.confirm({
            title: `在${position === "before" ? "前" : "后"}插入一集`,
            content: (
                <div className="space-y-2 pt-2">
                    <p className="text-xs text-muted-foreground">新集将编号为第 {targetNo} 集，后面各集集号顺延；已做好的集内容不受影响。</p>
                    <input defaultValue={title} placeholder="集标题" onChange={(e) => { title = e.target.value; }}
                        className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" />
                    <textarea defaultValue={synopsis} placeholder="本集原文（可留空，之后在原剧本里补）" rows={4} onChange={(e) => { synopsis = e.target.value; }}
                        className="w-full resize-y rounded-md border border-border bg-background p-2 text-xs outline-none focus:border-primary" />
                </div>
            ),
            okText: "插入",
            cancelText: "取消",
            onOk: async () => {
                setBusy("insert");
                try {
                    const created = await insertEpisode(no, position, title, synopsis);
                    message.success(created ? `已在第 ${no} 集${position === "before" ? "前" : "后"}插入第 ${created.episodeNumber} 集` : "已插入剧集");
                    if (created) {
                        const next = new URLSearchParams(query);
                        next.set("episodeId", created.id);
                        setQuery(next);
                    }
                } catch (error) {
                    message.error(`插入失败：${(error as Error).message}`);
                } finally {
                    setBusy(null);
                }
            },
        });
    };

    /** 影策删除保护：生成过分镜视频需输入「第N集」确认；有运行中任务/只剩一集/规划中禁删。 */
    const handleRemoveEpisode = (ep: StudioEpisode) => {
        if (ep.jobs.running > 0) return void message.warning(`第 ${ep.no} 集还有 ${ep.jobs.running} 个生成任务进行中，请等完成或先暂停`);
        if (episodes.length <= 1) return void message.warning("作品只剩一集，不能删除");
        const scriptDone = stage?.states?.find((s) => s.key === "script")?.done;
        if (!scriptDone) return void message.warning("本剧还在分集规划阶段，请先在规划台确认分集后再删除");

        const doDelete = async () => {
            setBusy(`del-${ep.id}`);
            try {
                await removeEpisode(ep.id);
                message.success(`已删除第 ${ep.no} 集，后续集号已前移；本集原文已退回原著章节`);
                const next = new URLSearchParams(query);
                next.delete("episodeId");
                setQuery(next, { replace: true });
            } catch (error) {
                message.error(`删除失败：${(error as Error).message}`);
            } finally {
                setBusy(null);
            }
        };

        if (ep.segmentCount > 0) {
            let typed = "";
            Modal.confirm({
                title: `删除第 ${ep.no} 集（该集已生成 ${ep.segmentCount} 段视频）`,
                content: (
                    <div className="space-y-2 pt-2">
                        <p className="text-xs text-rose-600">本集的剧本、分镜、剧情段、段视频与成片版本将一并删除。请输入「第 {ep.no} 集」确认。</p>
                        <input placeholder={`第 ${ep.no} 集`} onChange={(e) => { typed = e.target.value; }}
                            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" />
                    </div>
                ),
                okText: "确认删除",
                okButtonProps: { danger: true },
                cancelText: "取消",
                onOk: async () => {
                    if (typed.trim() !== `第 ${ep.no} 集`) {
                        message.error(`输入不匹配，需输入「第 ${ep.no} 集」`);
                        return Promise.reject(new Error("confirm text mismatch"));
                    }
                    await doDelete();
                },
            });
        } else {
            Modal.confirm({
                title: `删除第 ${ep.no} 集`,
                content: "本集内容将连同后面各集的集号前移一起处理，确定删除吗？",
                okText: "删除",
                okButtonProps: { danger: true },
                cancelText: "取消",
                onOk: doDelete,
            });
        }
    };

    const episodeMenu = (ep: StudioEpisode): MenuProps => ({
        items: [
            { key: "before", label: "在前面插入一集", onClick: () => void handleInsertEpisode(ep.no, "before") },
            { key: "after", label: "在后面插入一集", onClick: () => void handleInsertEpisode(ep.no, "after") },
            { type: "divider" },
            { key: "delete", label: "删除本集", danger: true, disabled: episodes.length <= 1, onClick: () => void handleRemoveEpisode(ep) },
        ],
    });

    /** 顶栏「资产包」：影策一键打包/导入/交付，全部接真接口（导演包 zip + 交付包）。 */
    const assetPackMenu: MenuProps = {
        items: [
            { key: "pack", label: "一键打包全部资产", onClick: () => void exportPack() },
            { key: "import", label: "导入资产包", onClick: () => packFileRef.current?.click() },
            { type: "divider" },
            { key: "delivery", label: "导出交付包（成片+SRT+提示词）", onClick: () => void exportJianying("delivery") },
            { key: "jianying", label: "导出剪映草稿", onClick: () => void exportJianying("jianying") },
        ],
    };

    /** 顶栏「工具」：影策制作能力逐项接入本地 /production 各 workspace。 */
    const toolsMenu: MenuProps = {
        items: [
            { key: "discuss", label: "与本集导演讨论（小影）", onClick: discussWithDirector },
            { type: "divider" },
            { key: "story", label: "剧本分场", onClick: () => openWorkspace("story") },
            { key: "assets", label: "设定与资产库", onClick: () => openWorkspace("assets") },
            { key: "shots", label: "分镜全屏工作台", onClick: () => openWorkspace("shots") },
            { key: "continuity", label: "连续性 / 尾帧台账", onClick: () => openWorkspace("continuity") },
            { key: "clips", label: "成片与交付", onClick: () => openWorkspace("clips") },
            { key: "versions", label: "版本记录与对比", onClick: () => openWorkspace("advanced") },
        ],
    };

    return (
        <div
            data-drama-studio="shell"
            className="flex h-[calc(100vh-56px)] min-h-[600px] flex-col overflow-hidden bg-background text-foreground"
        >
            {/* 制作台 ↔ 画布 切换器（复用老版制作台同款，两态同一工作台） */}
            <WorkspaceViewSwitcher
                mode={canvasHost?.visible ? "canvas" : "production"}
                onSelect={(next) => { if (next === "canvas") openInCanvas(); else canvasHost?.collapse?.(); }}
            />
            {/* 标题区 */}
            <div className="shrink-0 border-b border-border">
                <div className="flex items-center gap-1.5 px-5 pt-2.5 text-[11px] text-muted-foreground">
                    <button type="button" onClick={() => navigate("/projects")} className="transition hover:text-foreground" title="返回剧目列表">影策</button>
                    <span>/</span>
                    <span>短剧制作</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pb-2.5 pt-1.5">
                    <button
                        type="button"
                        aria-label="返回"
                        onClick={() => navigate(-1)}
                        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    >
                        <ArrowLeft className="size-4" />
                    </button>
                    {currentFolder ? (
                        <div className="relative">
                            <select
                                value={dramaId || ""}
                                onChange={(e) => {
                                    const next = new URLSearchParams(query);
                                    next.set("dramaId", e.target.value);
                                    next.delete("episodeId");
                                    setQuery(next);
                                }}
                                className="h-8 max-w-[220px] cursor-pointer appearance-none rounded-md border border-transparent bg-transparent pl-0 pr-5 text-base font-semibold outline-none transition hover:border-border hover:pl-2"
                                aria-label="切换剧目"
                            >
                                {dramaFolders.map((folder) => (
                                    <option key={folder.id} value={folder.id}>{folder.name}</option>
                                ))}
                            </select>
                            <ChevronDown className="pointer-events-none absolute right-0 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        </div>
                    ) : (
                        <h1 className="text-base font-semibold">{hydrated ? "暂无剧目" : "加载中…"}</h1>
                    )}
                    <button
                        type="button"
                        aria-label="新建短剧"
                        title="新建短剧：从小说原文/剧本/分镜开始"
                        onClick={() => navigate("/drama-studio/new")}
                        className="flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    >
                        <Plus className="size-3.5" /> 新建短剧
                    </button>
                    {createWizardOpen ? <DramaPage
                        createOnly
                        onCreated={(folderId) => {
                            setCreateWizardOpen(false);
                            const next = new URLSearchParams(query);
                            next.set("dramaId", folderId);
                            next.delete("episodeId");
                            next.delete("new");
                            setQuery(next);
                            void refreshAll();
                        }}
                    /> : null}
                    <Modal
                        title="拆镜 · 分场剧本转结构化镜头"
                        open={splitOpen}
                        onCancel={() => setSplitOpen(false)}
                        footer={null}
                        width={960}
                        destroyOnClose
                    >
                        {dramaId ? <AdaptStoryboardPanel
                            dramaId={dramaId}
                            episodes={rawEpisodes}
                            defaultEpisodeId={current?.id}
                            // 拆镜写稿会发布制作稿；资产建档会在其后单独进行（create_manual_director_asset 会标 stale），
                            // 所以这里只刷新，不自动建档——避免刚发布的镜头被标 stale。
                            onWritten={() => { void refreshAll(); }}
                        /> : null}
                    </Modal>
                    <span className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
                        paused || productionState.status === "paused"
                            ? "bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400"
                            : "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400",
                    )} title={`制作阶段：${productionState.stage}`}>
                        <span className={cn("size-1.5 rounded-full", paused ? "bg-amber-500" : "bg-emerald-500")} />
                        {paused ? "已暂停" : productionState.stage === "done" ? "已完成" : "制作中"}
                    </span>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="h-1 w-24 overflow-hidden rounded-full bg-muted">
                            <span className="block h-full rounded-full bg-foreground/70 transition-all" style={{ width: `${progressPct}%` }} />
                        </span>
                        <span>{completed}/{total} 集成片 · {total} 集</span>
                        {productionState.chapterCount > total ? <span>· 原著 {productionState.chapterCount} 章 · 已选 {total} 集</span> : null}
                        {!connected ? <span className="text-amber-500">· 后台未连接</span> : null}
                    </div>

                    {/* 顶层 Tab */}
                    <nav className="ml-auto flex items-center gap-0.5" aria-label="制作台视图">
                        {TOP_TABS.map((tab) => (
                            <button
                                key={tab}
                                type="button"
                                onClick={() => setTopTab(tab)}
                                className={cn(
                                    "relative flex h-8 items-center gap-1 rounded-md px-2.5 text-xs transition",
                                    topTab === tab
                                        ? "bg-accent font-medium text-accent-foreground"
                                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                                )}
                            >
                                {tab}
                                {tab === "待处理" && inbox.length ? (
                                    <span className="ml-0.5 rounded-full bg-rose-500 px-1.5 text-[10px] leading-4 text-white">{inbox.length}</span>
                                ) : null}
                            </button>
                        ))}
                    </nav>

                    <div className="flex items-center gap-1.5 border-l border-border pl-3">
                        <button
                            type="button"
                            onClick={handlePipelineStart}
                            disabled={pipelineBusy}
                            title="全自动流水线：一键从剧本推进到成片（对齐影策服务端自动编排）"
                            className={cn(
                                "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition disabled:opacity-60",
                                pipeline?.pipeline?.status === "running"
                                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400"
                                    : "border-primary/50 bg-primary/5 text-primary hover:bg-primary/10",
                            )}
                            data-studio-pipeline-toggle
                        >
                            <Zap className="size-3.5" />
                            {pipelineBusy ? "处理中…" : pipeline?.pipeline?.status === "running" ? "全自动·运行中" : "一键全自动"}
                        </button>
                        <Dropdown menu={assetPackMenu} trigger={["click"]} placement="bottomRight">
                            <button
                                type="button"
                                className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                            >
                                <Package className="size-3.5" /> 资产包
                            </button>
                        </Dropdown>
                        <input
                            ref={packFileRef}
                            type="file"
                            accept=".zip,.mmxpack"
                            className="hidden"
                            data-studio-pack-file
                            onChange={(e) => { const file = e.target.files?.[0]; if (file) void importPackFile(file); }}
                        />
                        <Dropdown menu={toolsMenu} trigger={["click"]} placement="bottomRight">
                            <button
                                type="button"
                                title="影策制作能力：分镜/资产/连续性/成片/版本/导演讨论"
                                className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                            >
                                <Wand2 className="size-3.5" /> 工具
                            </button>
                        </Dropdown>
                        <button
                            type="button"
                            onClick={() => openInCanvas()}
                            className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        >
                            <Palette className="size-3.5" /> 精修画布
                        </button>
                        {awaitingCount > 0 ? (
                            <button
                                type="button"
                                data-studio-release-all
                                aria-label={`全部生成视频 · ${awaitingCount} 集`}
                                title={`全部生成视频 · ${awaitingCount} 集`}
                                onClick={confirmReleaseAll}
                                className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                            >
                                <Play className="size-3.5" /> 全部生成视频 · {awaitingCount} 集
                            </button>
                        ) : null}
                        <button
                            type="button"
                            onClick={handleTogglePause}
                            disabled={busy === "pause"}
                            className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-60"
                        >
                            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                            {paused ? "继续" : "暂停"}
                        </button>
                    </div>
                </div>
            </div>

            {/* 主体两栏 */}
            <div className="flex min-h-0 flex-1">
                {/* 左栏：剧集列表 */}
                <aside className="flex w-[300px] shrink-0 flex-col border-r border-border bg-card/40">
                    <div className="flex items-center gap-1.5 px-3 pt-3">
                        <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-background px-2">
                            <Search className="size-3.5 shrink-0 text-muted-foreground" />
                            <input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="搜索剧集名称"
                                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
                            />
                        </div>
                        <button
                            type="button"
                            aria-label="添加剧集"
                            onClick={handleAddEpisode}
                            disabled={busy === "add"}
                            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-60"
                        >
                            {busy === "add" ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
                        </button>
                        <div className="flex shrink-0 items-center rounded-md border border-border p-0.5">
                            <button type="button" aria-label="列表视图" onClick={() => setView("list")} className={cn("flex size-6 items-center justify-center rounded", view === "list" ? "bg-accent text-accent-foreground" : "text-muted-foreground")}>
                                <List className="size-3.5" />
                            </button>
                            <button type="button" aria-label="网格视图" onClick={() => setView("grid")} className={cn("flex size-6 items-center justify-center rounded", view === "grid" ? "bg-accent text-accent-foreground" : "text-muted-foreground")}>
                                <LayoutGrid className="size-3.5" />
                            </button>
                        </div>
                    </div>

                    <div className="flex items-center gap-1 overflow-x-auto px-3 pb-2 pt-2.5">
                        {filters.map((f) => (
                            <button
                                key={f.key}
                                type="button"
                                onClick={() => setFilter(f.key)}
                                className={cn(
                                    "shrink-0 rounded-full px-2 py-1 text-[11px] transition",
                                    filter === f.key
                                        ? "bg-primary text-primary-foreground font-medium"
                                        : "bg-muted text-muted-foreground hover:text-foreground",
                                )}
                            >
                                {f.key} {f.count}
                            </button>
                        ))}
                    </div>

                    <div className={cn("min-h-0 flex-1 overflow-y-auto px-3 pb-2", view === "grid" && "grid grid-cols-2 content-start gap-2")}>
                        {loading ? (
                            <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
                                <LoaderCircle className="size-4 animate-spin" /> 加载剧集…
                            </div>
                        ) : null}
                        {visibleEpisodes.map((ep) => (
                            <div
                                key={ep.id}
                                className={cn(
                                    "group relative mb-1.5 rounded-lg border transition",
                                    view === "grid" && "mb-0",
                                    current?.id === ep.id
                                        ? "border-foreground/20 bg-accent/60"
                                        : "border-border bg-background hover:bg-muted/60",
                                )}
                            >
                                <button type="button" onClick={() => selectEpisode(ep)} className="w-full p-2.5 text-left">
                                    <div className="flex items-start gap-2">
                                        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded bg-rose-50 text-[11px] font-semibold text-rose-500 dark:bg-rose-500/10">
                                            {String(ep.no).padStart(2, "0")}
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate pr-5 text-xs font-medium">{ep.title}</div>
                                            <div className="mt-1 flex items-center gap-2">
                                                <StatusChip status={ep.status} />
                                                <StagePips episode={ep} />
                                                {ep.jobs.failed > 0 ? (
                                                    <span className="inline-flex items-center gap-0.5 text-[10px] text-rose-500" title={`${ep.jobs.failed} 次生成失败`}>
                                                        <CircleAlert className="size-3" />{ep.jobs.failed}
                                                    </span>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                </button>
                                <Dropdown menu={episodeMenu(ep)} trigger={["click"]} placement="bottomRight">
                                    <button
                                        type="button"
                                        aria-label={`第 ${ep.no} 集更多操作`}
                                        onClick={(e) => e.stopPropagation()}
                                        className="absolute right-1.5 top-2 flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:bg-muted group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
                                    >
                                        <MoreHorizontal className="size-3.5" />
                                    </button>
                                </Dropdown>
                            </div>
                        ))}
                        {!loading && visibleEpisodes.length === 0 ? (
                            <div className="py-10 text-center text-xs text-muted-foreground">
                                {dramaId ? "没有匹配的剧集" : "请先在剧目列表创建一个短剧"}
                            </div>
                        ) : null}
                    </div>

                    <div className="shrink-0 space-y-1.5 border-t border-border p-3">
                        {studioInfo.excludedCount > 0 ? (
                            <button
                                type="button"
                                aria-label="继续选章"
                                onClick={() => setChapterPickerOpen(true)}
                                className="flex h-8 w-full items-center justify-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                            >
                                <BookOpen className="size-3.5" /> 原著还有 {studioInfo.excludedCount} 章 · 继续选章
                            </button>
                        ) : null}
                        {total === 0 ? (
                            <button
                                type="button"
                                onClick={handleBatchCreateEpisodes}
                                disabled={busy === "add"}
                                title="读取剧目原文，按章节一次性建好全部集"
                                className="flex h-8 w-full items-center justify-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2 text-[11px] text-primary transition hover:bg-primary/10 disabled:opacity-60"
                            >
                                <BookOpen className="size-3.5" /> 按原文批量建集
                            </button>
                        ) : null}
                        <button
                            type="button"
                            onClick={handleAddEpisode}
                            disabled={busy === "add"}
                            className="flex h-8 w-full items-center justify-center gap-1 rounded-md border border-dashed border-border text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-60"
                        >
                            <Plus className="size-3.5" /> {total ? `添加第 ${total + 1} 集` : "添加第一集"}
                        </button>
                    </div>
                </aside>

                {/* 右栏：详情 */}
                <section className="flex min-w-0 flex-1 flex-col bg-background">
                    {/* 详情头：影策只在「制作」页显示集头 + 剧本/分镜/成片分页 */}
                    {topTab === "制作" ? <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-3">
                        <span className="text-xs text-muted-foreground">
                            {current ? `第 ${current.no} 集 · ${headStageLabel(current)}` : "未选择剧集"}
                        </span>
                        {current && renaming ? (
                            <span className="flex items-center gap-2">
                                <input
                                    autoFocus
                                    aria-label="集标题"
                                    defaultValue={current.title}
                                    maxLength={60}
                                    disabled={busy === "rename"}
                                    onFocus={(e) => e.currentTarget.select()}
                                    onBlur={(e) => void saveEpisodeTitle(current, e.currentTarget.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") e.currentTarget.blur();
                                        if (e.key === "Escape") {
                                            e.currentTarget.value = current.title;
                                            setRenaming(false);
                                            e.currentTarget.blur();
                                        }
                                    }}
                                    className="h-7 w-56 rounded-md border border-primary bg-background px-2 text-sm font-semibold outline-none"
                                />
                                <span className="text-[10px] text-muted-foreground">回车保存 · Esc 取消</span>
                            </span>
                        ) : (
                            <h2 className="text-sm font-semibold">{current?.title || "—"}</h2>
                        )}
                        {current && !renaming ? (
                            <button
                                type="button"
                                aria-label="重命名本集"
                                title="重命名本集"
                                onClick={() => handleRenameEpisode(current)}
                                className="flex size-6 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground"
                            >
                                <Pencil className="size-3.5" />
                            </button>
                        ) : null}
                        <span className="text-[11px] text-muted-foreground">
                            {shots.length} 镜{headDurationSec > 0 ? ` · ${Math.floor(headDurationSec / 60)}分${String(Math.round(headDurationSec % 60)).padStart(2, "0")}秒` : ""} · {scenes.length} 场 · {clipGroups.length} 段
                        </span>
                        {current ? <StagePips episode={current} size="md" /> : null}
                        <div className="ml-auto flex items-center gap-2">
                            <div className="flex items-center rounded-md border border-border p-0.5" aria-label="制作工作台">
                                {WORKSPACE_TABS.map((tab) => (
                                    <button
                                        key={tab.key}
                                        type="button"
                                        data-studio-workspace={tab.key}
                                        onClick={() => openWorkspace(tab.key)}
                                        className={cn(
                                            "rounded px-2 py-1 text-[11px] transition",
                                            activeStudioTab === tab.key ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                                        )}
                                    >
                                        {tab.label}
                                    </button>
                                ))}
                            </div>
                            <button
                                type="button"
                                onClick={() => openWorkspace("story")}
                                disabled={!current}
                                title="切到剧本页改编本集剧本并生成分镜"
                                className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                            >
                                <Wand2 className="size-3.5" /> 分镜改编
                            </button>
                            <button
                                type="button"
                                onClick={() => setSplitOpen(true)}
                                disabled={!current}
                                title="把本集分场剧本拆成结构化镜头并同步到画布"
                                className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                            >
                                <Scissors className="size-3.5" /> 拆镜
                            </button>
                            <button
                                type="button"
                                onClick={discussWithDirector}
                                disabled={!current}
                                title="带上本集上下文打开导演对话，优化台词/动作/景别/运镜"
                                className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                            >
                                <Sparkles className="size-3.5" /> 导演讨论
                            </button>
                            <button
                                type="button"
                                onClick={() => openInCanvas()}
                                className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                            >
                                <ExternalLink className="size-3.5" /> 在画布中打开本集
                            </button>
                        </div>
                    </div> : null}

                    {/* 制作视图 */}
                    {topTab === "制作" ? (
                        <>
                            {current?.error ? (
                                <div className="mx-5 mt-3 flex shrink-0 items-center gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300">
                                    <CircleAlert className="size-3.5 shrink-0" />
                                    <span className="font-medium">本集遇到问题</span>
                                    <span className="truncate text-rose-500/80 dark:text-rose-300/70" title={current.error}>{current.error}</span>
                                    <span className="ml-auto shrink-0 text-rose-500/80 dark:text-rose-300/70">{current.jobs.failed} 次失败 · 可在底部全部重试</span>
                                </div>
                            ) : null}

                            {detailLoading ? (
                                <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
                                    <LoaderCircle className="size-4 animate-spin" /> 加载制作稿…
                                </div>
                            ) : !current ? (
                                <EmptyState
                                    icon={<Film className="size-9 text-muted-foreground/40" />}
                                    title="还没有剧集"
                                    description="在左侧点击「添加第一集」开始，或先到剧目列表创建一个短剧。"
                                />
                            ) : (
                                <StudioDetailPanel
                                    tab={detailTab}
                                    episode={current}
                                    production={production}
                                    clipMedia={clipMedia}
                                    dramaId={dramaId}
                                    busy={Boolean(busy)}
                                    onRescript={() => void (async () => {
                                        setBusy("rescript");
                                        try {
                                            // 写作技能真实注入：选中「分镜拆分」技能时，取其 SKILL.md 方法要点作为 instruction
                                            // 传给改编请求（后端 instruction 上限 2000 字），让选择的技能真实影响生成。
                                            const skillRef = studioSettings.textSkills.storyboard;
                                            let instruction: string | undefined;
                                            if (skillRef) {
                                                const detail = await fetchSkillDetail(skillRef.name);
                                                instruction = skillInstruction(detail?.content || "", skillRef.title);
                                            }
                                            // 影策 hook/cliffhanger 结构化字段真实注入：作为创作方向并入改编指令（本集开篇钩子与结尾悬念）。
                                            const beats: string[] = [];
                                            if (studioSettings.hook.trim()) beats.push(`开篇钩子：${studioSettings.hook.trim()}`);
                                            if (studioSettings.cliffhanger.trim()) beats.push(`结尾悬念：${studioSettings.cliffhanger.trim()}`);
                                            if (beats.length) {
                                                const beatText = beats.join("；");
                                                instruction = instruction ? `${instruction}\n${beatText}`.slice(0, 2000) : beatText.slice(0, 2000);
                                            }
                                            // 分镜规则软约束：单集时长/对白密度/转场/节奏并入改编指令（手动改编也读到设置）。
                                            const ruleBits: string[] = [];
                                            if (studioSettings.episodeSeconds) ruleBits.push(`本集约 ${studioSettings.episodeSeconds} 秒`);
                                            if (studioSettings.dialogueDensity !== "standard") ruleBits.push(`对白${{ dense: "密集", restrained: "克制", custom: "按需" }[studioSettings.dialogueDensity] || ""}`);
                                            if (studioSettings.transitionMode !== "smart") ruleBits.push(`转场${{ hard: "硬切", fade: "黑场过渡", flash: "闪白" }[studioSettings.transitionMode] || ""}`);
                                            if (studioSettings.pacing !== "标准") ruleBits.push(`节奏${studioSettings.pacing}`);
                                            if (ruleBits.length) {
                                                const ruleText = `分镜要求：${ruleBits.join("，")}。`;
                                                instruction = instruction ? `${instruction}\n${ruleText}`.slice(0, 2000) : ruleText.slice(0, 2000);
                                            }
                                            await data.adaptEpisode(current.id, instruction);
                                            message.success(skillRef || beats.length ? `已按${skillRef ? `写作技能「${skillRef.title}」` : ""}${skillRef && beats.length ? "与" : ""}${beats.length ? "钩子/悬念设置" : ""}重新改编本集` : "已重新改编本集，请查看剧本与分镜");
                                        } catch (error) {
                                            message.error(`改编失败：${(error as Error).message}`);
                                        } finally { setBusy(null); }
                                    })()}
                                    onCompose={() => void (async () => {
                                        const videos = clipMedia
                                            .filter((c) => String(c.storageKey || "").startsWith("video:"))
                                            .map((c, i) => ({ name: `Clip-${i + 1}.mp4`, storageKey: c.storageKey, url: "" }));
                                        if (!videos.length) { message.warning("本集还没有可用的段视频，无法合成"); return; }
                                        setBusy("compose");
                                        try {
                                            const { endpoint, token } = resolveBackendAgentEndpoint();
                                            const result = videos.length === 1
                                                ? { url: backendMediaUrl(videos[0].storageKey!), storageKey: videos[0].storageKey }
                                                : await runVideoConcatTask(endpoint, token, videos, undefined, { layout: "sequence", longEdge: "auto" });
                                            saveAs(result.url, `${current?.title || "成片"}-合成.mp4`);
                                            // 影策 render：成片 storageKey 落库，供「下载成片」与真实状态文案使用。
                                            const finalKey = result.storageKey || (videos.length === 1 ? videos[0].storageKey : undefined);
                                            if (finalKey) await data.saveFinalResource(current.id, finalKey);
                                            message.success(`已合成 ${videos.length} 段视频并开始下载，成片已保存`);
                                            await refreshAll();
                                        } catch (error: unknown) {
                                            message.error(`合成失败：${error instanceof Error ? error.message : String(error)}`);
                                        } finally { setBusy(null); }
                                    })()}
                                    onExportJianying={() => void exportJianying()}
                                    onOpenCanvas={openInCanvas}
                                    onSwitchToScript={() => openWorkspace("story")}
                                    onWriteSegmentPrompt={(segmentId) => (async () => {
                                        // 写作技能真实注入：选中「提示词撰写」技能时取 SKILL.md 方法要点，
                                        // 与全剧画风一起传给段提示词撰写器（影策 prompts 阶段）。
                                        const skillRef = studioSettings.textSkills.prompt;
                                        let skillContent: string | undefined;
                                        let skillName: string | undefined;
                                        if (skillRef) {
                                            const detail = await fetchSkillDetail(skillRef.name);
                                            skillContent = skillInstruction(detail?.content || "", skillRef.title);
                                            skillName = skillRef.title;
                                        }
                                        const artStyle = String(((currentFolder?.productionPlan as Record<string, unknown> | undefined)?.topic as Record<string, unknown> | undefined)?.artStyle || "");
                                        // 设置项真实注入：表演强度/运镜动感 → 表演与运镜风格；并行出片 → independent（不依赖上一段画面）。
                                        const independent = studioSettings.continuationMode === "parallel";
                                        return data.writeSegmentPrompt(current.id, segmentId, {
                                            artStyle, skillContent, skillName,
                                            performanceIntensity: studioSettings.performanceIntensity,
                                            cameraDynamics: studioSettings.cameraDynamics,
                                            independent,
                                            // 设置页「视频提示词」模型 + 思考等级真实透传到生成请求。
                                            model: studioSettings.videoPromptModel,
                                            reasoningEffort: studioSettings.textThinking.prompt,
                                        });
                                    })()}
                                    onSaveSegmentPrompt={(segmentId, text) => data.saveSegmentPrompt(current.id, segmentId, text)}
                                    onApproveVideo={async () => {
                                        const result = await data.approveEpisodeVideo(current.id);
                                        if (result.ok && dramaId) {
                                            // 本地审批已写；再放行流水线闸门（审阅模式下 video 阶段被 needsReview 卡住时需要）。
                                            await approveDramaPipelineEpisode(dramaId, current.id);
                                            setPipeline(await fetchDramaPipelineStatus(dramaId));
                                        }
                                        return result;
                                    }}
                                    onSwitchToAssets={() => { setAssetsInitialSub("audit"); setTopTab("项目资产"); }}
                                    onChanged={() => void refreshAll()}
                                />
                            )}
                        </>
                    ) : topTab === "项目资产" ? (
                        <StudioAssetsTab
                            sharedAssetCanvasId={String((currentFolder as Record<string, unknown> | null)?.sharedAssetCanvasId || "") || null}
                            artStyle={String(((currentFolder?.productionPlan as Record<string, unknown> | undefined)?.topic as Record<string, unknown> | undefined)?.artStyle || "")}
                            episodes={episodes}
                            loading={loading}
                            onOpenCanvas={openInCanvas}
                            onChanged={() => void refreshAll()}
                            productionOf={productionOf}
                            voiceProfiles={studioSettings.voiceProfiles}
                            onExtractAssets={(episodeId) => (async () => {
                                // 「提取设定」写作技能真实注入：与改编/提示词一致，取 SKILL.md 方法要点作 instruction。
                                const skillRef = studioSettings.textSkills.extract;
                                let instruction: string | undefined;
                                if (skillRef) {
                                    const detail = await fetchSkillDetail(skillRef.name).catch(() => null);
                                    instruction = skillInstruction(detail?.content || "", skillRef.title);
                                }
                                // 设置页「提取设定」模型 + 思考等级真实透传。
                                return extractEpisodeAssets(episodeId, instruction, {
                                    model: studioSettings.assetExtractModel,
                                    reasoningEffort: studioSettings.textThinking.extract,
                                });
                            })()}
                            initialSub={assetsInitialSub}
                        />
                    ) : topTab === "待处理" ? (
                        <StudioInboxTab
                            inbox={inbox}
                            episodes={episodes}
                            busy={Boolean(busy)}
                            onOpenEpisode={(id) => openEpisodeWorkspace(id, "story")}
                            onReview={(id) => openEpisodeWorkspace(id, "shots")}
                            onOpenSettings={() => setTopTab("设置")}
                            onStartVideo={() => void handlePipelineStart()}
                            onRetryAll={() => void handleRetryAll()}
                            onReleaseMedia={handleReleaseMedia}
                        />
                    ) : (
                        <StudioSettingsTab
                            dramaId={dramaId}
                            settings={studioSettings}
                            onChange={setStudioSettings}
                            onSave={saveStudioSettings}
                            onReset={() => setStudioSettings(loadStudioSettings(dramaId))}
                            saving={savingSettings}
                            studioInfo={studioInfo}
                        />
                    )}
                </section>
            </div>

            {/* 底部任务队列栏 */}
            <div className="shrink-0 border-t border-border bg-card/40">
                {queueOpen ? (
                    <div className="border-b border-border px-5 py-2">
                        <div className="mb-1.5 flex items-center gap-2" role="tablist" aria-label="队列筛选">
                            {(["all", "active", "failed"] as const).map((key) => (
                                <button key={key} type="button" role="tab" aria-selected={queueFilter === key}
                                    onClick={() => setQueueFilter(key)}
                                    className={cn("rounded px-2 py-0.5 text-[11px] transition", queueFilter === key ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>
                                    {key === "all" ? "全部" : key === "active" ? "进行中" : "失败"}
                                </button>
                            ))}
                            <span className="ml-auto text-[10px] text-muted-foreground">点击任一行查看请求详情</span>
                        </div>
                        <div className="max-h-36 space-y-1 overflow-y-auto" role="list">
                            {filteredQueue.map((job) => {
                                const busyFlag = ["running", "checking", "compiling", "applying", "queued"].includes(job.status);
                                return (
                                    <button key={job.id} type="button" role="listitem"
                                        onClick={() => setQueueDetail({ title: job.title, error: job.error, prompt: job.prompt, status: job.status })}
                                        className="flex w-full items-center gap-2 text-left text-[11px] text-muted-foreground transition hover:text-foreground">
                                        {busyFlag ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-rose-500" /> : <CircleAlert className="size-3.5 shrink-0 text-rose-500" />}
                                        <span className="truncate">{job.title}</span>
                                        <span className="ml-auto shrink-0 truncate text-rose-500/80">{job.error || job.status}</span>
                                    </button>
                                );
                            })}
                            {!filteredQueue.length ? (
                                <div className="py-1 text-center text-[11px] text-muted-foreground">
                                    {queueFilter === "failed" ? "没有失败的工作" : queueFilter === "active" ? "没有进行中的工作" : "没有排队或失败的任务"}
                                </div>
                            ) : null}
                        </div>
                    </div>
                ) : null}
                <div className="flex items-center gap-4 px-5 py-2 text-[11px]">
                    <span className="flex items-center gap-1.5 text-muted-foreground"><LoaderCircle className="size-3.5" /> 运行中 {jobCounts.running + queue.running}</span>
                    <span className="flex items-center gap-1.5 text-muted-foreground"><span className="size-1.5 rounded-full bg-muted-foreground/50" /> 排队 {queue.queued}</span>
                    <span className="flex items-center gap-1.5 text-muted-foreground"><CheckCircle2 className="size-3.5 text-emerald-500" /> 已完成 {jobCounts.succeeded}</span>
                    <span className="flex items-center gap-1.5 text-rose-600"><CircleAlert className="size-3.5" /> 待重试 {jobCounts.failed + queue.retry}</span>
                    <button
                        type="button"
                        onClick={handleRetryAll}
                        disabled={busy === "retry"}
                        className="font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-60"
                    >
                        {busy === "retry" ? "重试中…" : "全部重试"}
                    </button>
                    <div className="ml-auto flex items-center gap-3 text-muted-foreground">
                        <span>{assets.length} 项资产 · {inbox.length} 项待处理</span>
                        <button type="button" onClick={() => setQueueOpen((o) => !o)} className="flex items-center gap-1 hover:text-foreground">
                            {queueOpen ? "收起队列" : "展开队列"}
                            <ChevronDown className={cn("size-3.5 transition", queueOpen && "rotate-180")} />
                        </button>
                    </div>
                </div>
            </div>

            <StudioChapterPickerModal
                folder={currentFolder || null}
                episodes={rawEpisodes}
                open={chapterPickerOpen}
                onClose={() => setChapterPickerOpen(false)}
                onDone={refreshAll}
            />

            {/* 队列任务详情（对齐影策 JobDetailModal：复制错误信息 / 复制提示词） */}
            <Modal
                title={queueDetail?.title || "任务详情"}
                open={Boolean(queueDetail)}
                onCancel={() => setQueueDetail(null)}
                footer={null}
                width={640}
                destroyOnClose
            >
                {queueDetail ? (
                    <div className="space-y-3 py-2">
                        <div className="text-[11px] text-muted-foreground">状态：{queueDetail.status || "—"}</div>
                        <div>
                            <div className="mb-1 flex items-center justify-between text-xs font-medium">
                                <span>错误信息</span>
                                <button type="button" onClick={() => void navigator.clipboard.writeText(queueDetail.error || "").then(() => message.success("已复制错误信息"))}
                                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"><Copy className="size-3" /> 复制错误信息</button>
                            </div>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-relaxed">{queueDetail.error || "无错误信息"}</pre>
                        </div>
                        {queueDetail.prompt ? (
                            <div>
                                <div className="mb-1 flex items-center justify-between text-xs font-medium">
                                    <span>提示词 / 请求详情</span>
                                    <button type="button" onClick={() => void navigator.clipboard.writeText(queueDetail.prompt || "").then(() => message.success("已复制提示词"))}
                                        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"><Copy className="size-3" /> 复制提示词</button>
                                </div>
                                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-relaxed">{queueDetail.prompt}</pre>
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </Modal>
        </div>
    );
}
