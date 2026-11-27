import { lazy, startTransition, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Checkbox, Input } from "antd";
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
    ChevronRight,
    CircleAlert,
    Clock3,
    XCircle,
    LoaderCircle,
    CheckCircle2,
    CheckCheck,
    Clapperboard,
    UsersRound,
    Inbox,
    Settings2,
    ExternalLink,
    MoreHorizontal,
    Pencil,
    BookOpen,
    ScrollText,
    Film,
    Scissors,
    Sparkles,
    Wand2,
    Zap,
    Copy,
    Crosshair,
    FileArchive,
    X,
    FileUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { WorkspaceViewSwitcher } from "@/components/production/workspace-view-switcher";
import { backendMediaUrl } from "@/services/backend-api";
import { resolveBackendAgentEndpoint, runVideoConcatTask } from "@/services/api/comfyui";
import { saveAs } from "file-saver";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useStudioData, type StudioEpisode, type StudioStatus, type StudioInboxItem } from "./use-studio-data";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Dropdown, Modal, type MenuProps } from "antd";
import { dramaWorkbenchPath } from "@/pages/drama/workbench-entry";
import { WorkbenchCanvas } from "@/pages/drama/workbench-canvas";
import { useWorkbenchCanvas } from "@/lib/canvas/canvas-host";
import { loadStudioSettings, type StudioProductionSettings } from "./studio-settings-store";
import { skillInstruction } from "./studio-skill-picker";
import { fetchSkillDetail } from "@/services/api/skill-market";
import { launchPlanningDirector } from "@/pages/drama/planning-director-launch";
import { planningPrompt } from "@/pages/drama/planning-director-prompt";
import { fetchBackendDramaEpisodes, fetchEpisodeProduction, fetchProductionReadiness, previewJianyingDraft, exportJianyingDraft, editEpisodeProduction, fetchBackendGenerationLogs, fetchDramaPlanningState, episodeConfirmRequired, type BackendGenerationLog, type DramaJianyingDraftPreview, type DramaSourceFormat } from "@/services/backend-api";
import { exportAchengDeliveryBundle } from "@/lib/acheng-delivery-export";
import { buildPackFromProduction, importDirectorPackIntoEpisode } from "@/pages/drama/director-pack-bar";
import { packToZip, zipToPack } from "@/lib/director-pack-io";
import type { DirectorPack } from "@/lib/director-pack";
import { strFromU8, strToU8, zipSync } from "fflate";
import { collectPackClips, buildPackGroupMedia } from "@/lib/director-pack-canvas";
import { collectPackRefs, importPackRefs } from "@/lib/director-pack-assets";
import { productionCanvasNodes } from "@/pages/drama/production-canvas-nodes";
import {
    startDramaPipeline, pauseDramaPipeline, resumeDramaPipeline, fetchDramaPipelineStatus,
    retryFailedDramaPipeline, retryDramaPipelineJob, approveDramaPipelineEpisode, releaseDramaPipelineMedia, rewriteDramaEpisodeScript, type DramaPipelineStatus,
} from "@/services/backend-api";
import { StudioDetailPanel, type DetailTab } from "./studio-detail-panel";
import { deriveReviewBanners } from "./studio-review-banner";
import type { DirectorWorkspace } from "@/pages/drama/director-panel";
import { EPISODE_SOURCE_CHARS } from "@basketikun/canvas-agent/drama/chapter-episodes";
import { orderStudioQueue } from "./studio-queue-order";
import { updateRescriptingIds } from "./studio-rescript-state";

/**
 * 首屏按需分包：默认 tab=制作/剧本 只需要左栏 + 剧本面板；
 * 资产/待处理/设置三个 tab、空态开场卡与「拆镜」弹窗都是非首屏交互，拆成独立 chunk 后再加载。
 * 组件本身不变，只把静态 import 换成 lazy（默认导出包装），行为与原先一致。
 */
const StudioAssetsTab = lazy(() => import("./studio-assets-tab").then((m) => ({ default: m.StudioAssetsTab })));
const StudioInboxTab = lazy(() => import("./studio-inbox-tab").then((m) => ({ default: m.StudioInboxTab })));
const StudioSettingsTab = lazy(() => import("./studio-settings-tab").then((m) => ({ default: m.StudioSettingsTab })));
const StudioGenesis = lazy(() => import("./studio-genesis").then((m) => ({ default: m.StudioGenesis })));
const AdaptStoryboardPanel = lazy(() => import("@/pages/drama/adapt-storyboard-panel").then((m) => ({ default: m.AdaptStoryboardPanel })));
const StudioChapterPickerModal = lazy(() => import("./studio-chapter-picker").then((m) => ({ default: m.StudioChapterPickerModal })));
const StudioVersionCompare = lazy(() => import("./studio-version-compare").then((m) => ({ default: m.StudioVersionCompare })));

/** 分块加载占位：与原有「加载制作稿…」同款，不新增布局跳动。 */
function TabChunkFallback() {
    return (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground" data-studio-tab-chunk-loading>
            <LoaderCircle className="size-4 animate-spin" /> 加载中…
        </div>
    );
}

/**
 * 影策（open-ai-canvas）短剧制作台的像素级复刻 + 真实数据/逻辑接线。
 * UI 参照 `tmp/oac/studio.png`；数据走 backend-api，不新增第二份真值。
 */

type TopTab = "制作" | "项目资产" | "待处理" | "设置";
type EpisodeFilter = "全部" | StudioStatus;

const TOP_TABS: TopTab[] = ["制作", "项目资产", "待处理", "设置"];
/** 影策 detail.tsx:443-460 的四个视图图标；与本地 TopTab 一一对应。 */
const TOP_TAB_ICONS: Record<TopTab, typeof Clapperboard> = {
    "制作": Clapperboard,
    "项目资产": UsersRound,
    "待处理": Inbox,
    "设置": Settings2,
};
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

/** 影策 episode-delete-modal.tsx:13 的 compact：去所有空白（含空格/换行/全角空格 \u3000）。 */
const compact = (value: string) => value.replace(/\s+/g, "");

/** 影策 AddEpisodeModal：单集原文文件上限 2MB，字数口径与后端（去空白）一致。 */
const EPISODE_FILE_MAX_BYTES = 2 * 1024 * 1024;
const EPISODE_TEXT_FILE = /\.(txt|md|markdown|csv|tsv)$/i;
/** 与后端去空白字数口径一致；逐字符计数，避免长原文每次击键都分配百万级字符数组。 */
const episodeSourceChars = (text: string) => {
    let count = 0;
    for (const char of text) if (!/\s/.test(char)) count += 1;
    return count;
};

/** 建集弹窗状态：add 追加到末尾；insert 插到锚点集前/后。 */
type EpisodeDraft = { mode: "add" | "insert"; no?: number; position?: "before" | "after" };
/** 删集弹窗状态：needsTyped 由客户端初判，serverDriven 表示服务端 409 强制切成输入确认。 */
type EpisodeDeleteDraft = { ep: StudioEpisode; needsTyped: boolean; confirmText: string; reasons: string[]; serverDriven?: boolean };

/** 影策 use-studio.ts:108-112 的 isTypingTarget：输入框/选择器/弹层内不触发全局快捷键。 */
function isTypingTarget(target: EventTarget | null) {
    const element = target as HTMLElement | null;
    if (!element) return false;
    return element.isContentEditable
        || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
        || Boolean(element.closest(".ant-select, .ant-modal, .ant-drawer, .ant-popover, .ant-dropdown, [role='dialog'], [role='listbox'], [aria-haspopup]"));
}

/** 影策 detail.tsx:821 的分集规划门禁文案（planDone=false 时禁止追加/插入）。 */
const PLAN_GATE_TIP_ADD = "前面的章节还在分集规划，完成后才能追加新的一集。";
const PLAN_GATE_TIP_INSERT = "前面的章节还在分集规划，完成后才能插入新的一集。";

/** 影策 drama-shared.tsx:117-131 的动态状态文案：只用 StudioEpisode 真实字段，缺少的计数不编造。
 *  videoReady / durationMs 由数据层按真值派生；任一字段缺失时沿用旧文案，
 *  不拿 publishedVersion / shotCount 冒充已就绪段数。 */
type EpisodeVideoTruth = { videoReady?: number | null; durationMs?: number | null };
/** 已完成 · 分秒：durationMs 是产物真值，0 也视为有值。 */
function formatEpisodeDurationMs(ms: number): string {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
}
function episodeStatusText(ep: StudioEpisode): string {
    const truth = ep as StudioEpisode & EpisodeVideoTruth;
    // 只有当前未恢复的失败(ep.error=lastError)才算需要处理；累计历史失败(jobs.failed)
    // 已被后续成功覆盖时不该永久挂红条——与影策 episodeTone 的 latest-failure-recovered 语义一致。
    if (ep.error) return "需要处理";
    if (ep.status === "已完成" || ep.publishedVersion > 0) {
        if (typeof truth.durationMs === "number" && Number.isFinite(truth.durationMs) && truth.durationMs >= 0)
            return `已完成 · ${formatEpisodeDurationMs(truth.durationMs)}`;
        return `已完成 · 发布 v${ep.publishedVersion}`;
    }
    if (ep.shotCount > 0 && ep.segmentCount === 0) return `剧本就绪 · ${ep.shotCount} 镜 · 待生成画面`;
    if (ep.segmentCount > 0) {
        // 分子分母都要有真值才显示 N/M，缺任一字段沿用旧文案。
        if (typeof truth.videoReady === "number" && Number.isFinite(truth.videoReady) && truth.videoReady >= 0)
            return `视频 ${truth.videoReady}/${ep.segmentCount}`;
        return `视频 ${ep.segmentCount} 段 · ${ep.status === "制作中" ? "制作中" : "待生成"}`;
    }
    if (ep.shotCount > 0) return `分镜 ${ep.shotCount} 镜`;
    return ep.status;
}

/** 影策 drama-ep-meta：普通文本，只有失败(error)与审阅(review)着色，不再用彩色胶囊背景。 */
function StatusChip({ episode }: { episode: StudioEpisode }) {
    const text = episodeStatusText(episode);
    const review = episode.status === "待生成" && episode.shotCount > 0;
    return (
        <span
            className={cn(
                "min-w-0 truncate whitespace-nowrap text-[10px] text-muted-foreground",
                episode.error && "text-rose-500",
                !episode.error && review && "text-amber-600 dark:text-amber-400",
            )}
            title={text}
        >
            {text}
        </span>
    );
}

/** 影策 drama-shared.tsx:106-115 的 episodeTone 六态：完成/制作中/待生成(条纹)/待审阅/失败 + idle。
 *  关键区别：awaitingMedia（已拆镜有镜头、成片未发布 = 本地 status「待生成」）在影策是 **ready 条纹**，
 *  不是「待审阅」；橙色 review 只在 stage==="review"（提示词等人工确认）出现。本地流水线没有独立 review
 *  阶段，所以 review 不会被派生出来——宁可留空也不把「待生成」涂成待审阅。 */
type EpisodeTone = "done" | "working" | "pending" | "review" | "failed" | "ready";
const EPISODE_TONE_ORDER: EpisodeTone[] = ["done", "working", "ready", "review", "failed"];
const EPISODE_TONE_LABEL: Record<EpisodeTone, string> = {
    done: "完成",
    working: "制作中",
    ready: "剧本就绪 · 待生成画面",
    pending: "待生成",
    review: "待审阅",
    failed: "失败",
};
/** 图例用短标签（影策 legend 写「待生成」）；格子 title 用 LABEL 里的完整口径。 */
const EPISODE_TONE_LEGEND_LABEL: Record<EpisodeTone, string> = {
    done: "完成",
    working: "制作中",
    ready: "待生成",
    pending: "待生成",
    review: "待审阅",
    failed: "失败",
};
/** 图例圆点（影策 drama.css:1365 9px：完成绿 / 制作中主色 / 待生成条纹 / 待审阅橙 / 失败红）。 */
const EPISODE_TONE_DOT: Record<EpisodeTone, string> = {
    done: "bg-emerald-500",
    working: "bg-primary",
    ready: "",
    pending: "bg-foreground/20",
    review: "bg-amber-500",
    failed: "bg-rose-500",
};
/** 待生成（ready）在影策是一条 135° 斜条纹（drama.css:4431），用主题色叠出来而不是纯色块。 */
const EPISODE_TONE_READY_STYLE: React.CSSProperties = {
    background:
        "repeating-linear-gradient(135deg, color-mix(in oklab, var(--primary) 55%, transparent) 0 3px, color-mix(in oklab, var(--primary) 22%, transparent) 3px 6px)",
};
/** 状态格子的底色；前景色保证深浅主题下都可读（不写死浅色分支）。
 *  对齐影策 drama.css:1378-1406 的 .drama-cell：方格、色块为主、集号 hover 才显形。 */
const EPISODE_TONE_CELL: Record<EpisodeTone, string> = {
    done: "bg-emerald-500 text-white hover:bg-emerald-500/90",
    working: "bg-primary text-background hover:bg-primary/90",
    ready: "text-foreground hover:brightness-110",
    pending: "bg-foreground/10 text-foreground/70 hover:bg-foreground/15",
    review: "bg-amber-500/90 text-amber-950 hover:bg-amber-500",
    failed: "bg-rose-500 text-white hover:bg-rose-500/90",
};
function episodeTone(ep: StudioEpisode): EpisodeTone {
    if (ep.status === "需要处理" || ep.error) return "failed";
    if (ep.status === "已完成") return "done";
    if (ep.status === "制作中") return "working";
    // 影策 awaitingMedia（ready 条纹）= 剧本就绪但还没出片；已有段视频产出并仍在推进的集是 video 阶段 → active(灰)。
    if (ep.shotCount > 0 && (ep.videoReady ?? 0) > 0) return "working";
    if (ep.shotCount > 0) return "ready";
    return "pending";
}
/** 影策 episode-rail.tsx:21-28 分页：待生成=ready、待处理=失败+待审阅、制作中=active、已完成=done。
 *  计数与过滤共用这一个判定，保证 tab 数字与实际格子数始终一致。 */
function episodeMatchesFilter(ep: StudioEpisode, filter: EpisodeFilter): boolean {
    const tone = episodeTone(ep);
    if (filter === "全部") return true;
    if (filter === "待生成") return tone === "ready";
    if (filter === "需要处理") return tone === "failed" || tone === "review";
    if (filter === "制作中") return tone === "working";
    if (filter === "已完成") return tone === "done";
    return true;
}

/** 队列任务状态图标（对齐影策 job-detail.tsx 的 JobStatusIcon 分类）。 */
function JobStatusIcon({ status, className = "size-3.5 shrink-0" }: { status: string; className?: string }) {
    const s = String(status || "").toLowerCase();
    if (["running", "checking", "compiling", "applying"].includes(s))
        return <LoaderCircle className={cn(className, "animate-spin text-rose-500")} />;
    if (["queued", "waiting", "pending"].includes(s))
        return <Clock3 className={cn(className, "text-amber-500")} />;
    if (["succeeded", "success", "done", "completed"].includes(s))
        return <CheckCircle2 className={cn(className, "text-emerald-500")} />;
    if (["canceled", "cancelled"].includes(s))
        return <XCircle className={cn(className, "text-muted-foreground")} />;
    // failed / rejected / retry / error
    return <XCircle className={cn(className, "text-rose-500")} />;
}

/** 影策 job-detail.tsx:40-55 的时间/用时格式；无字段或非法值返回「—」，不编造。 */
function formatJobTime(value?: string): string {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return date.toLocaleString("zh-CN", sameDay ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function formatJobElapsed(start?: string, end?: string): string {
    if (!start || !end) return "—";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "—";
    return formatJobDuration(ms);
}
/** 队列行 64px 时间列：当天显示 HH:MM，跨天显示 MM-DD；缺失/非法值返回「—」。 */
function formatJobClock(value?: string): string {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
        ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
        : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/** 后端按作业补的 durationMs（finished-started）→ 中文用时；缺失不编造。 */
function formatJobDuration(ms?: number | null): string {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
    const seconds = Math.round(ms / 1000);
    return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}
/** 后端状态码本地化：paused_by_user 等只在内部分支里出现，展示层不把原始码丢给用户。 */
const JOB_ERROR_LABEL: Record<string, string> = {
    paused_by_user: "已暂停取消",
    canceled_by_user: "已取消",
    cancelled_by_user: "已取消",
    paused: "已暂停",
};
function localizeJobText(value?: string | null): string {
    if (!value) return "";
    return String(value).replace(/\b(paused_by_user|paused|canceled_by_user|cancelled_by_user)\b/g, (code) => JOB_ERROR_LABEL[code] || code);
}

/** 影策 queue-bar.tsx:88 的 JOB_KIND_LABEL：队列行里显示中文工作类型，而不是原始 kind。 */
const JOB_KIND_LABEL: Record<string, string> = {
    video: "视频", image: "图片", text: "文本", audio: "音频", render: "合成",
    concat: "合成", cast_image: "设定图", asset: "资产", prompt: "提示词",
};
/** 流水线阶段作业的中文名（后端 pipeline.jobs[].stage），队列把这些真实操作一并展示。 */
const PIPELINE_STAGE_LABEL: Record<string, string> = {
    script: "改编拆镜", assets: "资产参考图", prompts: "段提示词",
    video: "生成视频", render: "合成成片", review: "等待审阅",
};
/**
 * 后端 attempts_json 的投影：每次真实尝试一条（失败带 error、成功带 result）。
 * attempt 是那一轮 DB 里的重试计数；老数据/老作业没有该数组，按「未采集」处理，不臆造。
 */
type QueueAttemptRecord = { at?: string; attempt?: number; error?: string; result?: Record<string, unknown> };
function queueAttemptsOf(value: unknown): QueueAttemptRecord[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is QueueAttemptRecord => Boolean(item) && typeof item === "object");
}
/** 成功记录的简短摘要：把制作稿/流水线常见结果字段翻成中文，未知字段回退成 key 列表。
 *  只做展示层翻译，不改结果真值；数组/对象不展开，避免一行塞满。 */
const ATTEMPT_RESULT_LABEL: Record<string, string> = {
    total: "共", created: "新建", images: "出图", imageFailed: "失败图",
    segments: "段", shots: "镜", prompts: "提示词", videos: "视频",
    durationMs: "耗时ms", storageKey: "产物", nodes: "节点", restoredAssets: "复用资产",
};
function attemptResultSummary(result?: Record<string, unknown>): string {
    if (!result || typeof result !== "object") return "";
    const parts: string[] = [];
    for (const [key, value] of Object.entries(result)) {
        if (parts.length >= 4) break;
        if (value === null || value === undefined) continue;
        if (typeof value === "object") continue;
        const label = ATTEMPT_RESULT_LABEL[key];
        parts.push(label ? `${label} ${String(value)}` : `${key}=${String(value)}`);
    }
    return parts.join(" · ");
}
/** 队列行状态文案（影策 drama-job.is-* 的本地对齐）。 */
const JOB_STATUS_LABEL: Record<string, string> = {
    running: "运行中", queued: "排队中", waiting: "排队中", pending: "排队中",
    succeeded: "已完成", success: "已完成", done: "已完成", completed: "已完成",
    failed: "失败", error: "失败", retry: "重试中", rejected: "已拒绝",
    cancelled: "已取消", canceled: "已取消", paused: "已暂停",
    // 暂停取消：后端把 running 退回 queued 并写 error=paused_by_user，展示层按中文状态呈现。
    paused_by_user: "已暂停取消", canceled_by_user: "已取消", cancelled_by_user: "已取消",
    checking: "检查中", compiling: "编译中", applying: "应用中", blocked: "等待上游",
};
/** 队列行状态文案：优先中文状态表，未收录的原始码也保持原样而非隐藏真值。 */
function jobStatusText(status?: string): string {
    const key = String(status || "").toLowerCase();
    return JOB_STATUS_LABEL[key] || localizeJobText(key) || "—";
}

/** 影策 job-detail.tsx:57-65 的请求参数显示名；未列出的键按原始 key 展示，不编造参数。 */
const GENERATION_PARAM_LABEL: Record<string, string> = {
    size: "尺寸", imageResolution: "分辨率", quality: "质量", count: "张数",
    videoSeconds: "时长（秒）", vquality: "清晰度", videoGenerateAudio: "同步生成声音",
    width: "宽度", height: "高度", seed: "随机种子", steps: "步数", model: "模型",
};
function formatParamValue(value: unknown): string {
    if (value == null) return "—";
    if (typeof value === "object") {
        try { return JSON.stringify(value); } catch { return String(value); }
    }
    return String(value);
}

/** 生成结果：只渲染 generation_logs.outputs 里真实存在的 storageKey / 文本；没有就显示「无」。 */
function GenerationOutputs({ outputs }: { outputs: Array<Record<string, unknown>> }) {
    const rows = outputs.filter((o) => o && typeof o === "object");
    if (!rows.length) return <span className="text-[11px] text-muted-foreground">无</span>;
    return (
        <div className="space-y-1.5">
            {rows.map((o, i) => {
                const sk = String(o.storageKey || "");
                const mime = String(o.mimeType || "");
                const rawUrl = String(o.url || "");
                const src = sk ? backendMediaUrl(sk) : /^(https?:\/\/|\/)/.test(rawUrl) ? rawUrl : "";
                const text = typeof o.text === "string" ? o.text
                    : typeof o.resultText === "string" ? o.resultText
                        : typeof o.content === "string" ? o.content : "";
                if (mime.startsWith("video/") || sk.startsWith("video:") || (!mime && sk.startsWith("video"))) {
                    return src
                        ? <video key={i} src={src} controls playsInline preload="metadata" className="max-h-40 w-full rounded border border-border bg-black" />
                        : <div key={i} className="text-[11px] text-muted-foreground">视频产物缺少可读取地址</div>;
                }
                if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(sk)) {
                    return src
                        ? <img key={i} src={src} alt={String(o.name || `生成结果 ${i + 1}`)} className="max-h-40 rounded border border-border object-contain" loading="lazy" />
                        : <div key={i} className="text-[11px] text-muted-foreground">图片产物缺少可读取地址</div>;
                }
                if (mime.startsWith("text/") || text) {
                    return <pre key={i} className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/40 p-2 text-[11px] leading-relaxed">{text || rawUrl}</pre>;
                }
                return <div key={i} className="break-all text-[11px] text-muted-foreground">{rawUrl || formatParamValue(o)}</div>;
            })}
        </div>
    );
}

/** 剪映草稿目录示例（照影策 drama-export.ts:100-103）。 */
const JIANYING_ROOT_WIN = "C:\\Users\\你的用户名\\AppData\\Local\\JianyingPro\\User Data\\Projects\\com.lveditor.draft";
const JIANYING_ROOT_MAC = "/Users/你的用户名/Movies/JianyingPro/User Data/Projects/com.lveditor.draft";
function jianyingRootProblem(value: string): string {
    const root = value.trim();
    if (!root) return "请填写剪映草稿目录";
    if (root.includes("你的用户名")) return "请把路径里的「你的用户名」换成电脑上的实际用户名";
    if (!/^[A-Za-z]:[\\/]|^\/\//.test(root) && !root.startsWith("/")) return "需要绝对路径，例如 C:\\Users\\… 或 /Users/…";
    return "";
}

/** 影策 4 段阶段进度：剧本 / 段提示词 / 视频 / 成片，每段按真实产物填充 0..1。 */
const STAGE_PIPS = [
    { key: "script", label: "剧本" },
    { key: "prompts", label: "段提示词" },
    { key: "video", label: "视频" },
    { key: "render", label: "成片" },
] as const;

/**
 * 影策 detail.tsx:602-604 / drama-shared.tsx:18-26 的 STAGE_LABEL：
 * 排队中 / 改编剧本 / 撰写段提示词 / 等待审阅 / 生成视频 / 合成成片 / 已完成。
 * 本地 StudioStage 只有 draft/script/assets/shots/video，没有独立 prompts/review/render；
 * 只用真实 stage + 产物计数派生能对齐的文案，不编造「合成成片」等本地不存在的阶段。
 */
function headStageLabel(ep: StudioEpisode): string {
    if (ep.error) return "需要处理";
    // 「已完成」必须同时满足：已发布成片 + 每段都有真实视频（视频 0/47 却显示已完成是被 publish 标记骗了）。
    const allVideoReady = ep.segmentCount === 0 || (ep.videoReady ?? 0) >= ep.segmentCount;
    if (ep.publishedVersion > 0 && allVideoReady) return "已完成";
    // 已拆镜未发布 = 影策 awaitingMedia：0 段视频时是「待生成画面」，已有视频产出并继续推进的是「生成视频」。
    // 不再写「等待审阅」——本地流水线没有独立 review 阶段，那样会把待生成的集误标成等人确认。
    if (ep.status === "待生成" && ep.shotCount > 0) return (ep.videoReady ?? 0) > 0 ? "生成视频" : "待生成画面";
    if (ep.status === "已完成") return "已完成";
    if (ep.stage === "video") return "生成视频";
    if (ep.stage === "shots") return "撰写段提示词";
    // 影策无独立「资产」阶段；本地 assets 表示剧本已就绪、尚未拆镜，折到改编剧本。
    if (ep.stage === "assets" || ep.stage === "script") return "改编剧本";
    return "排队中"; // draft
}

/** 只从真实字段派生，不拿代理字段冒充完成：有正文/有段/有发布版本才算推进。 */
function stageFills(ep: StudioEpisode): number[] {
    const total = ep.segmentCount;
    const ready = Math.max(0, ep.videoReady ?? 0);
    const script = ep.hasScript || ["assets", "shots", "video"].includes(ep.stage) ? 1 : 0;
    const prompts = total > 0 ? 1 : ep.shotCount > 0 ? 0.5 : 0;
    // 视频阶段按真实出片比例填，不能因为「有段」或「旧 publish 标记」直接点满（曾出现 视频 0/47 却四段全绿）。
    const video = total > 0 ? Math.min(1, ready / total) : ep.publishedVersion > 0 ? 1 : 0;
    // 成片只有「每段都有视频且已发布」才算完成，避免空成片把最后一段点亮。
    const render = ep.publishedVersion > 0 && (total === 0 || ready >= total) ? 1 : 0;
    return [script, prompts, video, render];
}

/** 影策 drama-shared.tsx:146-160 的 StagePips：14x4(md 22x5)、gap 4、强轨道色、
 *  scaleX 250ms 过渡；填充色随 error/review/done 切 err/warn/ok。 */
function StagePips({ episode, size = "sm" }: { episode: StudioEpisode; size?: "sm" | "md" }) {
    const fills = stageFills(episode);
    const bar = size === "md" ? "h-[5px] w-[22px]" : "h-1 w-[14px]";
    const fillTone = episode.error
        ? "bg-rose-500"
        : episode.status === "已完成" || episode.publishedVersion > 0
            ? "bg-emerald-500"
            : episode.status === "待生成" && episode.shotCount > 0
                ? "bg-amber-500"
                : "bg-primary";
    return (
        <span className="flex shrink-0 items-center gap-1" aria-label={`阶段进度：${STAGE_PIPS.map((s, i) => `${s.label}${Math.round(fills[i] * 100)}%`).join("，")}`}>
            {fills.map((fill, i) => (
                <span key={STAGE_PIPS[i].key} title={STAGE_PIPS[i].label} className={cn("relative overflow-hidden rounded-full bg-foreground/20", bar)}>
                    <span
                        className={cn("absolute inset-0 origin-left rounded-full transition-transform duration-[250ms] ease-out", fillTone)}
                        style={{ transform: `scaleX(${fill})` }}
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

/** 后端 /pipeline/status 的暂停真值（backend pipeline.status().pause）：前端类型尚未同步该字段，读侧容忍。 */
type PipelinePauseLite = {
    paused?: boolean;
    reason?: string | null;
    lastResult?: { canceledTasks?: number; canceledQueuedTasks?: number; failedTasks?: number; pausedJobs?: number } | null;
};
const pipelinePauseOf = (status: DramaPipelineStatus | null | undefined): PipelinePauseLite | undefined =>
    (status as { pause?: PipelinePauseLite } | null | undefined)?.pause;

/**
 * 流水线轮询签名：3s 回包每次都是新对象，只有界面真正消费的字段变化才更新 state。
 * 刻意不含 last_tick_at / logs 等调度器每次 tick 都会变的非展示字段，否则守卫形同虚设。
 */
function pipelineStateSignature(status: DramaPipelineStatus | null | undefined): string {
    if (!status) return "";
    const pause = (status as DramaPipelineStatus & { pause?: { paused?: boolean; reason?: string | null } }).pause;
    const jobs = (status.jobs || []).map((job) => [
        job.id, job.stage, job.kind, job.status, job.attempt, job.episodeId, job.error,
        job.retryExhausted, job.createdAt, job.startedAt, job.finishedAt, job.durationMs,
        job.runtimeTaskId, job.waitReason, Array.isArray(job.attempts) ? job.attempts.length : 0,
    ].join("\u0001")).join("\u0002");
    return [
        status.pipeline?.status, status.pipeline?.review_mode, status.pipeline?.media_mode,
        status.pipeline?.pause_reason, status.pipeline?.revision,
        (status.approvals || []).join(","), (status.releasedMedia || []).join(","), status.sampleMode,
        status.budget?.limitMicrocredits, status.budget?.spentMicrocredits, status.budget?.exceeded,
        pause?.paused, pause?.reason, jobs,
    ].join("\u0003");
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

    // 全自动流水线状态（影策服务端自动编排的本地等价物），运行时每 3s 轮询。
    // 提前到 useStudioData 之前声明：数据 hook 需要「流水线是否在跑」来决定是否轮询制作稿/成片。
    const [pipeline, setPipeline] = useState<DramaPipelineStatus | null>(null);
    /** 运行期轮询信号：流水线运行中，或确有 running 作业（暂停残留的 queued 不计，避免空闲空转）。 */
    const pipelinePollActive = pipeline?.pipeline?.status === "running"
        || (pipeline?.jobs || []).some((job) => String(job.status).toLowerCase() === "running");

    const data = useStudioData(dramaId, query.get("episodeId"), { pollActive: pipelinePollActive });
    // 参考图绑定里常有空的 name（历史数据只存 <Picture N>）：把资产真名整理成表，传给段弹窗做兜底。
    const detailAssetNames = useMemo(() => {
        const out: Record<string, string> = {};
        for (const asset of data.assets || []) {
            const key = String(asset.id || "");
            const name = String(asset.title || "");
            if (!name) continue;
            if (key) out[key] = name;
            // 段参考图绑定优先带 sourceNodeId（shared 资产节点 id），一并登记成兜底键。
            const nodeId = String(asset.sourceNodeId || "");
            if (nodeId) out[nodeId] = name;
        }
        return out;
    }, [data.assets]);
    const {
        episodes, rawEpisodes, assets, stage, production, batches, counts, queue,
        jobCounts, inbox: hookInbox, productionState, clipMedia, clipFailureByTarget,
        sourceChapterTruth, bibleReady, firstSampleReady,
        loading, detailLoading, connected, refreshAll, addEpisode, batchCreateEpisodes, insertEpisode, removeEpisode, adaptEpisode, extractEpisodeAssets, writeSegmentPrompt, approveEpisodeVideo, renameEpisode, toggleBatch,
    } = data;

    // 强一致分集游标：plan_done=true 后设置页的分集方式/结果一律锁写。
    const [planningState, setPlanningState] = useState<{ planDone: boolean; planCursor: number; lastChapterIndex: number }>({ planDone: false, planCursor: 0, lastChapterIndex: 0 });
    // 区分「规划信号还没拉回来」与「确实正在分集」，避免默认 planDone=false 造成误报。
    const [planningLoaded, setPlanningLoaded] = useState(false);
    useEffect(() => {
        if (!dramaId) { setPlanningState({ planDone: false, planCursor: 0, lastChapterIndex: 0 }); setPlanningLoaded(false); return; }
        let cancelled = false;
        setPlanningLoaded(false);
        void fetchDramaPlanningState(dramaId).then((res) => {
            if (!cancelled) {
                setPlanningState({
                    planDone: Boolean(res.planDone), planCursor: Number(res.planCursor || 0), lastChapterIndex: Number(res.lastChapterIndex || 0),
                });
                setPlanningLoaded(true);
            }
        }).catch(() => { if (!cancelled) setPlanningLoaded(true); });
        return () => { cancelled = true; };
    }, [dramaId, episodes.length]);

    const [topTab, setTopTab] = useState<TopTab>("制作");
    const [assetsInitialSub, setAssetsInitialSub] = useState<"library" | "audit" | "versions" | undefined>(undefined);
    const [assetsInitialKind, setAssetsInitialKind] = useState<"角色" | "道具" | "场景" | undefined>(undefined);
    /** 按集核查「打开资产设定」：资产库要选中的真实资产记录（ID+名称+分类）。 */
    const [assetsFocus, setAssetsFocus] = useState<{ assetId: string; name: string; kind: string } | null>(null);
    const [pipelineBusy, setPipelineBusy] = useState(false);
    const [bannerBusy, setBannerBusy] = useState<"release" | "approve" | null>(null);
    const [splitOpen, setSplitOpen] = useState(false);
    /** 版本记录与对比弹窗：真版本对比，入口在工具菜单；数据全部来自 version-compare API。 */
    const [versionCompareOpen, setVersionCompareOpen] = useState(false);
    const [filter, setFilter] = useState<EpisodeFilter>("全部");
    const [chapterPickerOpen, setChapterPickerOpen] = useState(false);
    const urlWorkspace = query.get("workspace");
    // 影策详情区只有 剧本/分镜/成片 三页；工具菜单里的辅助 workspace 也合法，不回退。
    const ALL_WORKSPACES: DirectorWorkspace[] = ["story", "shots", "clips", "overview", "assets", "continuity", "production", "advanced"];
    const workspace = (ALL_WORKSPACES.includes(urlWorkspace as DirectorWorkspace) ? urlWorkspace : "story") as DirectorWorkspace;
    const activeStudioTab = ((DETAIL_WORKSPACES.includes(workspace as DetailTab) ? workspace : WORKSPACE_PARENT[workspace]) || "story") as DetailTab;
    const detailTab = activeStudioTab;
    const [search, setSearch] = useState("");
    // 影策 episode-rail.tsx:78：搜索防抖，输入时列表不卡顿（React 内置 useDeferredValue，纯 UI）。
    const deferredSearch = useDeferredValue(search);
    // 影策 episode-rail.tsx:78：列表滚动容器，供 useVirtualizer 与切集 scrollToIndex 使用。
    const episodeListRef = useRef<HTMLDivElement>(null);
    // 影策 episode-rail.tsx:77,93：矩阵/列表视图偏好用 localStorage 记忆（纯 UI，不碰业务数据）。
    const episodeViewKey = "drama-studio:episode-view";
    const [view, setView] = useState<"list" | "grid">(() => {
        try { return localStorage.getItem(episodeViewKey) === "grid" ? "grid" : "list"; } catch { return "list"; }
    });
    const setViewPersist = (next: "list" | "grid") => {
        setView(next);
        try { localStorage.setItem(episodeViewKey, next); } catch { /* 隐私模式忽略 */ }
    };
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
    // 后端真值校正只做一次/剧目：避免轮询把用户刚点的本地状态反复覆盖。
    const pauseSyncedRef = useRef<string | null>(null);
    const [queueOpen, setQueueOpen] = useState(false);
    const [queueFilter, setQueueFilter] = useState<"all" | "active" | "failed">("all");
    const [queueDetail, setQueueDetail] = useState<{
        id: string; title: string; error: string; prompt?: string; status?: string; episodeId?: string; kind?: string;
        createdAt?: string; startedAt?: string; finishedAt?: string; durationMs?: number; runtimeTaskId?: string;
        attempt?: number; waitReason?: string; attempts?: QueueAttemptRecord[];
    } | null>(null);
    const [queueAttempts, setQueueAttempts] = useState<BackendGenerationLog[] | null>(null);
    const [queueAttemptsLoading, setQueueAttemptsLoading] = useState(false);
    /** 详情日志与选中作业的关联口径：job=按 runtimeTaskId 命中本作业；episode=仅本集上下文（非本作业）。 */
    const [queueLogScope, setQueueLogScope] = useState<"job" | "episode" | "none">("none");
    // 队列行只来自流水线作业（影策 DramaJob）：generation_logs 是单次模型请求，
    // 在作业详情里按 runtimeTaskId 查看，不单独占一行（影策队列没有这种行）。
    /** 影策 job-detail.tsx:105-128 的 facts：只取该作业自己的真实字段，缺失显示「—」。 */
    const queueFacts = useMemo(() => {
        // 后端已给每个 job 补 createdAt/startedAt/finishedAt/durationMs：facts 只用作业自身字段，
        // 不再跨整集日志聚合（之前把整集 44 条日志的跨度当成本作业用时）。
        const started = String(queueDetail?.startedAt || "");
        const ended = String(queueDetail?.finishedAt || "");
        const joined = String(queueDetail?.createdAt || started || "");
        const elapsed = typeof queueDetail?.durationMs === "number"
            ? formatJobDuration(queueDetail.durationMs)
            : formatJobElapsed(started, ended);
        // 尝试次数：流水线作业用后端 attempt；生成日志行按 runtimeTaskId 命中条数；关联不到就「—」。
        const attempts = typeof queueDetail?.attempt === "number"
            ? queueDetail.attempt
            : queueLogScope === "job" && queueAttempts
                ? queueAttempts.length
                : null;
        return { joined, started, ended, elapsed, attempts };
    }, [queueDetail?.startedAt, queueDetail?.finishedAt, queueDetail?.createdAt, queueDetail?.durationMs, queueDetail?.attempt, queueLogScope, queueAttempts]);
    /** 「尝试记录」展示顺序：后端数组最旧在前（slice(-20) 保留最近 20 条），这里按时间倒序。 */
    const queueDetailAttempts = useMemo(() => (queueDetail?.attempts || []).slice().reverse(), [queueDetail]);
    // #2 剪映草稿预检弹窗：真预检 API 的三分类清单（可用 / 缺失 / 旧版本是可用子集）。
    const [jianyingOpen, setJianyingOpen] = useState(false);
    const [jianyingRoot, setJianyingRoot] = useState(() => {
        try { return localStorage.getItem("drama-studio:jianying-root") || JIANYING_ROOT_WIN; } catch { return JIANYING_ROOT_WIN; }
    });
    const [jianyingCaptions, setJianyingCaptions] = useState(true);
    const [jianyingPreview, setJianyingPreview] = useState<DramaJianyingDraftPreview | null>(null);
    const [jianyingLoading, setJianyingLoading] = useState(false);
    // 影策 asset-transfer.tsx:446：预检失败内联持久错误（role=alert），关掉 toast 也不丢。
    const [jianyingError, setJianyingError] = useState("");
    const [jianyingRequested, setJianyingRequested] = useState(false);
    const [jianyingSkipMissing, setJianyingSkipMissing] = useState(false);
    const [jianyingSkipStale, setJianyingSkipStale] = useState(false);
    // #5 一键打包全部资产：多选剧集 + 媒体/提示词选项。
    const [packModalOpen, setPackModalOpen] = useState(false);
    const [packPicked, setPackPicked] = useState<Set<string> | null>(null);
    const [packMedia, setPackMedia] = useState(true);
    const [packPrompts, setPackPrompts] = useState(true);
    // #6 导入资产包：先预览 plan 再确认写入。
    const [importModalOpen, setImportModalOpen] = useState(false);
    const [importPack, setImportPack] = useState<DirectorPack | null>(null);
    const [importFileName, setImportFileName] = useState("");
    const [importOpening, setImportOpening] = useState(false);
    const [importRefs, setImportRefs] = useState(true);
    const [importPrompts, setImportPrompts] = useState(true);
    // 详情弹窗的任务是否活跃收敛成基础类型，避免 episodes 数组身份变化重启轮询。
    // 影策 job-detail.tsx:72 refetchInterval: running/queued ? 3000 : false。
    const queueDetailRuntimeTaskId = String(queueDetail?.runtimeTaskId || "");
    const queueDetailActive = ["running", "queued", "waiting", "pending", "checking", "compiling", "applying"]
        .includes(String(queueDetail?.status || "").toLowerCase());
    useEffect(() => {
        if (!queueDetail) { setQueueAttempts(null); setQueueLogScope("none"); return; }
        // 影策作业详情只列「这个任务自己的重试历史」。本地流水线阶段作业没有 runtimeTaskId，
        // 拿不到作业级日志时宁可不列，也不把本集其它任务的历史日志混进来当成本作业的重试记录。
        if (!queueDetailRuntimeTaskId) {
            setQueueAttempts([]); setQueueAttemptsLoading(false); setQueueLogScope("none");
            return;
        }
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let active = queueDetailActive;
        setQueueAttemptsLoading(true);
        setQueueLogScope("job");
        // 弹窗开着且任务含 running/queued 时每 3 秒真拉一次 generation logs，全部终态即停。
        // 只在首次/切换任务时翻 loading，轮询刷新不翻，避免卸载列表重置用户滚动位置。
        const load = (first: boolean) => {
            // 详情弹窗必须读全量日志：summary=true 会把 params 清成 {}（server.ts:1949-1953），
            // 「请求参数」表取自这里真实返回的 params，不用 summary 的假空值充数。
            void fetchBackendGenerationLogs({ runtimeTaskId: queueDetailRuntimeTaskId, limit: 50 })
                .then((r) => {
                    if (!alive) return;
                    // 后端过滤之外再精确过滤一次：只保留本作业这条 runtimeTaskId 的记录。
                    const scopedLogs = (r.logs || []).filter((l) => String(l.runtimeTaskId || "") === queueDetailRuntimeTaskId);
                    setQueueAttempts(scopedLogs);
                    // 已有日志以日志真实状态为准；尚未拉到日志时沿用任务状态等待日志出现。
                    active = scopedLogs.length
                        ? scopedLogs.some((l) => l.status === "running" || l.status === "queued")
                        : active;
                    if (active) timer = setTimeout(() => load(false), 3000);
                })
                .catch(() => {
                    if (!alive) return;
                    setQueueAttempts([]);
                    if (active) timer = setTimeout(() => load(false), 3000);
                })
                .finally(() => { if (alive && first) setQueueAttemptsLoading(false); });
        };
        load(true);
        return () => { alive = false; if (timer) clearTimeout(timer); };
    }, [queueDetail?.id, queueDetailRuntimeTaskId, queueDetailActive]);
    /** #6 真实导入计划：全部数量从已解包的 DirectorPack 内容算出，不编造接口或数字。 */
    const importPlan = useMemo(() => {
        if (!importPack) return null;
        const segments = importPack.timeline?.segments || [];
        const imageCount = importPack.groups.reduce((sum, g) => sum + (g.images?.length || 0), 0);
        const withPrompt = segments.filter((s) => Boolean(String((s as { prompt?: unknown }).prompt || "").trim())).length;
        return {
            title: String((importPack.pack as Record<string, unknown>).title || importFileName || "未命名资产包"),
            segmentCount: segments.length,
            imageCount,
            withPrompt,
            skipped: segments.length - withPrompt,
        };
    }, [importPack, importFileName]);
    /** #5 可打包剧集：与影策一致，只列真实拆出分镜（shotCount>0）的集。 */
    const packSelectable = useMemo(() => episodes.filter((ep) => ep.shotCount > 0), [episodes]);
    const packSelected = packPicked ?? new Set(packSelectable.map((ep) => ep.id));
    const packChosen = packSelectable.filter((ep) => packSelected.has(ep.id));
    /** #2 剪映预检清单：直接用后端真预检逐段结论，不再用 readiness status/notice 近似。 */
    const jianyingSegments = useMemo(() => (jianyingPreview?.segments || []).map((s) => ({
        index: s.index + 1,
        title: s.title,
        included: s.included,
        stale: s.stale,
        reason: s.reason || "",
        durationMs: s.durationMs,
        durationEstimated: s.durationEstimated,
    })), [jianyingPreview]);
    const jianyingReady = jianyingPreview?.availableSegments ?? 0;
    const jianyingMissing = jianyingPreview?.missingSegments ?? 0;
    const jianyingStale = jianyingPreview?.staleSegments ?? 0;
    const [studioSettings, setStudioSettings] = useState<StudioProductionSettings>(() => loadStudioSettings(dramaId));
    const [savingSettings, setSavingSettings] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    // 重新改编按集独立（影策每集一个 rescript.isPending）：改编 A 集不占住 B 集的改编按钮，
    // 也不把全局 busy 置真影响其它页签操作。按钮各自显示「改编中…」loading。
    const [rescriptingIds, setRescriptingIds] = useState<ReadonlySet<string>>(() => new Set<string>());
    const markRescripting = (id: string, on: boolean) => setRescriptingIds((prev) => updateRescriptingIds(prev, id, on));
    // 集标题内联编辑（对齐影策 detail.tsx：回车保存 / Esc 取消 / 失焦保存）
    const [renaming, setRenaming] = useState(false);

    // 建集/插集原文弹窗（对齐影策 AddEpisodeModal：标题 + 素材类型 + 原文 + 文件导入）。
    const [episodeDraft, setEpisodeDraft] = useState<EpisodeDraft | null>(null);
    const [episodeTitle, setEpisodeTitle] = useState("");
    const [episodeFormat, setEpisodeFormat] = useState<DramaSourceFormat>("novel");
    const [episodeText, setEpisodeText] = useState("");
    const episodeSourceCharCount = useMemo(() => episodeSourceChars(episodeText.trim()), [episodeText]);
    const episodeFileRef = useRef<HTMLInputElement>(null);

    // 删集确认弹窗：客户端初判可先给快速确认，最终以服务端 409 为准动态切换成输入确认。
    const [episodeDeleteDraft, setEpisodeDeleteDraft] = useState<EpisodeDeleteDraft | null>(null);
    const [episodeDeleteTyped, setEpisodeDeleteTyped] = useState("");

    // 剧目切换时重载该剧目的制作设置
    useEffect(() => { setStudioSettings(loadStudioSettings(dramaId)); }, [dramaId]);

    // 全自动流水线状态轮询：仅在有 dramaId 时每 3s 拉一次（对齐影策调度器 tick）。
    useEffect(() => {
        if (!dramaId || !connected) { setPipeline(null); return; }
        let alive = true;
        const poll = () => {
            if (document.hidden) return;
            void fetchDramaPipelineStatus(dramaId).then(s => {
                if (!alive || !s?.ok) return;
                setPipeline(prev => pipelineStateSignature(prev) === pipelineStateSignature(s) ? prev : s);
                // 初始化（每剧目一次）用后端 pause 真值校正本地暂停态：刷新后按钮不会与后端相反。
                const pause = pipelinePauseOf(s);
                if (pause && pause.paused !== undefined && pauseSyncedRef.current !== dramaId) {
                    pauseSyncedRef.current = dramaId;
                    setPausedPersist(Boolean(pause.paused));
                }
            }).catch(() => undefined);
        };
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
            planModel: studioSettings.planModel || undefined,
            imageResolution: studioSettings.imageResolution,
            // 剧目级段视频分辨率 + 画幅：后端 video 段真实写 H3 Clip 出片参数，不是空开关。
            videoResolution: studioSettings.videoResolution || undefined,
            videoAspectRatio: studioSettings.videoAspectRatio,
            textThinking: {
                plan: studioSettings.textThinking.plan,
                storyboard: studioSettings.textThinking.storyboard,
                extract: studioSettings.textThinking.extract,
                prompt: studioSettings.textThinking.prompt,
            },
            // 写作技能真实透传：一键全自动/恢复流水线时把设置页选的 extract/storyboard/prompt
            // 技能引用下发给后端（schema 已支持，后端 resolveTextSkill 按 name 读 SKILL.md 注入）。
            // 不传则后端拿不到技能，提示词退化成内置素材稿格式（用户所选技能形同虚设）。
            textSkills: {
                plan: studioSettings.textSkills.plan || undefined,
                extract: studioSettings.textSkills.extract || undefined,
                storyboard: studioSettings.textSkills.storyboard || undefined,
                prompt: studioSettings.textSkills.prompt || undefined,
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
                segmentMode: studioSettings.segmentMode,
                segmentRange: studioSettings.segmentRange,
                dialogueDensity: studioSettings.dialogueDensity,
                transitionMode: studioSettings.transitionMode,
                transitionMs: studioSettings.transitionMs,
                pacing: studioSettings.pacing,
            },
            // 参考图提示词模板（制作设置「角色/场景/默认提示词」）：只下发非空项，空则由后端用内置方案模板。
            ...(studioSettings.assetPromptTemplates && Object.values(studioSettings.assetPromptTemplates).some((v) => String(v || "").trim())
                ? { assetPromptTemplates: Object.fromEntries(Object.entries(studioSettings.assetPromptTemplates).filter(([, v]) => String(v || "").trim())) }
                : {}),
            budgetMicrocredits: studioSettings.budgetMicrocredits, // 影策预算护栏，0/不设=不限
            // 影策单值并发：后端 text/image/video/render 四池各自按它计数。
            concurrency: studioSettings.concurrency,
        },
    };
    /** 全自动已全部完成：所有 job 都 succeeded（此时点「全自动」是幂等的，不该显示成还在跑）。 */
    const pipelineAllDone = Boolean(pipeline?.jobs?.length) && (pipeline?.jobs || []).every((j) => String(j.status) === "succeeded");
    /** 影策「重试失败」入口的 N：只取 pipeline jobs 里 status=failed 的真实数量，不拿 generation-logs 近似。 */
    const pipelineFailedCount = useMemo(() => (pipeline?.jobs || []).filter((j) => String(j.status) === "failed").length, [pipeline]);
    /** 「待重试」只算后端真会重排的作业；熔断终态需人工介入，点了重试也不会变。 */
    const pipelineRetryableCount = useMemo(() => (pipeline?.jobs || []).filter((j) => String(j.status) === "failed" && !j.retryExhausted).length, [pipeline]);
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

    /**
     * 按章编辑原文 →「确定(保存并重新改编)」：走服务端 rescript 真链（清旧分镜→按新稿重拆→同步画布），
     * 轮询本集 script 作业到终态后刷新真值；instruction（写作技能/钩子悬念/分镜规则/思考深度）原样透传。
     */
    const runRescript = async (episodeId: string, instruction?: string, model?: string, options?: Record<string, unknown>) => {
        if (!dramaId) throw new Error("尚未选择剧目");
        const res = await rewriteDramaEpisodeScript(episodeId, { instruction, model, options });
        if (!res?.ok) throw new Error("重新改编提交失败");
        const deadline = Date.now() + 6 * 60 * 1000;
        let failed = "";
        let done = false;
        let failedStreak = 0;
        while (Date.now() < deadline) {
            const status = await fetchDramaPipelineStatus(dramaId);
            const job = (status?.jobs || []).find((j) => String(j.episodeId) === episodeId && String(j.stage) === "script");
            if (job && String(job.status) === "succeeded") { done = true; break; }
            // 后端失败会带退避自动 requeue，单次 failed 是重试中间态；连续多次仍 failed 才判终态。
            if (job && String(job.status) === "failed") {
                failedStreak += 1;
                if (failedStreak >= 3) { failed = String(job.error || "改编拆镜作业失败"); break; }
            } else failedStreak = 0;
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        setPipeline(await fetchDramaPipelineStatus(dramaId));
        await refreshAll();
        if (failed) throw new Error(failed);
        return done;
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
        const q = deferredSearch.trim();
        // 影策 episode-rail.tsx:81-89：集号支持「第N集」归一化，标题与简介都参与匹配。
        const noQuery = q.replace(/^第|集$/g, "").trim();
        return episodes.filter((ep) => {
            if (!episodeMatchesFilter(ep, filter)) return false;
            if (!q) return true;
            const no = String(ep.no);
            return no === noQuery || `第${no}集`.includes(q.replace(/\s+/g, "")) || ep.title.includes(q) || ep.synopsis.includes(q);
        });
    }, [episodes, filter, deferredSearch]);
    // 影策 episode-rail.tsx:90 + drama.css:1247：卡片固定 60px + 行间 2px，虚拟化高度与布局一致。
    const episodeVirtualizer = useVirtualizer({ count: visibleEpisodes.length, getScrollElement: () => episodeListRef.current, estimateSize: () => 62, overscan: 8 });

    // 影策 episode-rail 的状态分页：全部 / 待生成 / 待处理 / 制作中 / 已完成。
    // 计数与 visibleEpisodes 共用 episodeMatchesFilter，tab 数字即实际可显示的集数。
    const statusTabCounts = useMemo(() => {
        const countsByFilter: Record<"全部" | "待生成" | "需要处理" | "制作中" | "已完成", number> = { 全部: episodes.length, 待生成: 0, 需要处理: 0, 制作中: 0, 已完成: 0 };
        for (const ep of episodes) {
            if (episodeMatchesFilter(ep, "待生成")) countsByFilter.待生成 += 1;
            else if (episodeMatchesFilter(ep, "需要处理")) countsByFilter.需要处理 += 1;
            else if (episodeMatchesFilter(ep, "已完成")) countsByFilter.已完成 += 1;
            else if (episodeMatchesFilter(ep, "制作中")) countsByFilter.制作中 += 1;
        }
        return countsByFilter;
    }, [episodes]);
    // 影策 episode-rail.tsx:142：待生成分页在没有此类集时不显示（选中时仍保留）。
    const allFilters: { key: EpisodeFilter; label: string; count: number }[] = [
        { key: "全部", label: "全部", count: statusTabCounts.全部 },
        { key: "待生成", label: "待生成", count: statusTabCounts.待生成 },
        { key: "需要处理", label: "待处理", count: statusTabCounts.需要处理 },
        { key: "制作中", label: "制作中", count: statusTabCounts.制作中 },
        { key: "已完成", label: "已完成", count: statusTabCounts.已完成 },
    ];
    const filters = allFilters.filter((item) => item.key !== "待生成" || item.count > 0 || filter === "待生成");

    const selectedId = query.get("episodeId");
    const current: StudioEpisode | undefined = episodes.find((ep) => ep.id === selectedId) || episodes[0];
    const episodeById = useMemo(() => new Map(episodes.map((ep) => [ep.id, ep])), [episodes]);
    /** 传给详情面板的作业行：父级每帧重建数组会让整棵剧本/分镜子树跟着重渲。 */
    const processJobs = useMemo(
        () => (pipeline?.jobs || []).filter((job) => job.episodeId === current?.id).map((job) => ({
            id: String(job.id), stage: String(job.stage), status: String(job.status),
            attempt: Number(job.attempt) || 0, error: job.error ? String(job.error) : null,
        })),
        [pipeline?.jobs, current?.id],
    );
    // 影策 episode-rail.tsx:94：切换集时把当前集滚进可视范围，长列表不丢位置（仅列表模式）。
    useEffect(() => {
        if (view !== "list") return;
        const index = visibleEpisodes.findIndex((ep) => ep.id === current?.id);
        if (index >= 0) episodeVirtualizer.scrollToIndex(index, { align: "auto" });
    }, [current?.id, view, visibleEpisodes, episodeVirtualizer]);

    // ── 顶部审阅/放行横幅（对齐影策 detail.tsx:374-409 / 679-729）──────────────
    // 判定收敛到纯函数 studio-review-banner.ts，只吃 status() 真实字段与每集派生状态。
    const { awaitingMedia, reviewing, sampleReview, sampleWaiting } = useMemo(
        () => deriveReviewBanners(pipeline, episodes, current),
        [pipeline, episodes, current],
    );
    const firstEpisode = episodes.find((ep) => ep.no === 1);

    /** 横幅「生成本集视频」：本地 media 闸门只认 all/assets，episodes 目标不参与 jobAllowed，
     *  故用唯一能同时解开 assets 与 render 两个闸门的真实 target=all（与「放行媒体」按钮一致）。 */
    const handleBannerReleaseMedia = async () => {
        if (!dramaId) return void message.warning("请先选择剧目");
        setBannerBusy("release");
        try {
            await releaseDramaPipelineMedia(dramaId, "all");
            setPipeline(await fetchDramaPipelineStatus(dramaId));
            message.success("媒体闸门已放行，流水线继续推进");
        } catch (error) { message.error(`放行失败：${(error as Error).message}`); }
        finally { setBannerBusy(null); }
    };

    /** 与详情面板同一条审批链：先写持久化 reviewApproval，再放行流水线持久化闸门，最后刷新状态。 */
    const handleApproveVideo = async () => {
        if (!current) return { ok: false as const, missing: [] as string[], assetCount: 0 };
        const result = await data.approveEpisodeVideo(current.id);
        if (result.ok && dramaId) {
            await approveDramaPipelineEpisode(dramaId, current.id);
            setPipeline(await fetchDramaPipelineStatus(dramaId));
        }
        return result;
    };

    const handleBannerApprove = async () => {
        setBannerBusy("approve");
        try {
            const result = await handleApproveVideo();
            if (!result.ok) {
                message.warning(`还有 ${result.missing.length} 项资产未生成参考图：${result.missing.slice(0, 4).join("、")}${result.missing.length > 4 ? "…" : ""}。请到「项目资产」先生成并锁定。`);
                setAssetsInitialSub("audit");
                setAssetsFocus(null);
                setTopTab("项目资产");
                return;
            }
            message.success(sampleReview ? "样片已确认，其余各集继续推进" : "审阅通过，开始按段生成视频");
        } catch (error) { message.error(`确认失败：${(error as Error).message}`); }
        finally { setBannerBusy(null); }
    };

    const selectEpisode = (ep: StudioEpisode) => {
        const next = new URLSearchParams(query);
        next.set("episodeId", ep.id);
        setQuery(next);
    };

    // [ / ] 上一集 / 下一集（对齐影策 detail.tsx:161-172）：输入框与修饰键不触发，边界不回绕。
    // 依赖 query/setQuery 让监听闭包随 URL 更新；卸载时移除，避免热更新/切页后残留多个监听。
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
            if (event.key !== "[" && event.key !== "]") return;
            const activeId = selectedId || current?.id;
            const idx = episodes.findIndex((ep) => ep.id === activeId);
            if (idx < 0) return;
            const neighbor = episodes[idx + (event.key === "]" ? 1 : -1)];
            if (neighbor) selectEpisode(neighbor);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [episodes, selectedId, current?.id, query, setQuery]);

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

    /** 共享条目换参考图：打开【共享资产画布】而不是当前集画布；openInCanvas 永远指向集画布，故单独提供。 */
    const openSharedCanvas = () => {
        const sharedId = String((currentFolder as Record<string, unknown> | null)?.sharedAssetCanvasId || "") || null;
        if (sharedId && canvasHost) canvasHost.openCanvas({ projectId: sharedId });
    };

    /** 影策成片页「导出剪映草稿 / 导出交付包」：剪映走后端真导出；交付包仍沿用浏览器内 fflate 打包。 */
    const exportJianying = async (variant: "jianying" | "delivery" = "jianying", opts?: { root?: string; captions?: boolean; revision?: string; allowIncomplete?: boolean; allowStale?: boolean }) => {
        if (!current) { message.warning("请先选一集"); return false; }
        if (!production) { message.warning("本集制作稿尚未就绪，无法导出"); return false; }
        const canvasId = current.canvasId || "";
        setBusy("export");
        try {
            let output: Blob;
            if (variant === "jianying") {
                // 草稿构建、字幕与 ZIP 全部在服务端；revision 来自 preflight，下载时后端现场复核（不一致 409）。
                const draftRoot = opts?.root || undefined;
                const captions = opts?.captions;
                // 直接从按钮进入（未走预检弹窗）时先取一次 revision，保证任何导出链路都带防篡改指纹。
                const revision = opts?.revision || (await previewJianyingDraft(current.id as never, {
                    ...(draftRoot ? { draftRoot } : {}), ...(captions !== undefined ? { captions } : {}),
                })).preview.revision;
                output = await exportJianyingDraft(current.id as never, {
                    ...(draftRoot ? { draftRoot } : {}),
                    captions,
                    revision,
                    allowIncomplete: opts?.allowIncomplete,
                    allowStale: opts?.allowStale,
                });
            } else {
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
                ...(opts?.root ? { jianying: { root: opts.root } } : {}),
            });
            output = bundle;
            }
            const url = URL.createObjectURL(output);
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
            return true;
        } catch (error) {
            message.error(`导出失败：${(error as Error).message}`);
            return false;
        } finally {
            setBusy(null);
        }
    };

    /** 影策 asset-transfer.tsx:327-335：目录/字幕一变就作废上次预检与提交态。 */
    const invalidateJianying = () => {
        setJianyingPreview(null);
        setJianyingRequested(false);
        setJianyingError("");
        setJianyingSkipMissing(false);
        setJianyingSkipStale(false);
    };
    /** #2 打开剪映弹窗只重置状态，不再一打开就自动预检（影策三步式 footer）。 */
    const openJianyingModal = () => {
        if (!current) return void message.warning("请先选一集");
        if (!production) return void message.warning("本集制作稿尚未就绪，无法导出");
        invalidateJianying();
        setJianyingOpen(true);
    };
    /** 显式预检：调真预检 API，拿逐段 included/reason/stale 与内容 revision。 */
    const runJianyingPrecheck = async () => {
        if (!current || jianyingLoading) return;
        setJianyingPreview(null);
        setJianyingRequested(false);
        setJianyingError("");
        setJianyingLoading(true);
        try {
            const { preview } = await previewJianyingDraft(current.id as never, {
                draftRoot: jianyingRoot.trim(), captions: jianyingCaptions,
            });
            setJianyingPreview(preview);
        } catch (error) {
            const text = `预检失败：${(error as Error).message}`;
            setJianyingError(text);
            message.error(text);
        } finally {
            setJianyingLoading(false);
        }
    };
    const confirmJianying = async () => {
        const problem = jianyingRootProblem(jianyingRoot);
        if (problem) return void message.warning(problem);
        if (!jianyingPreview) return void message.warning("预检尚未完成，请稍候");
        if (!jianyingReady) return void message.warning("没有可导出的视频段，请先生成或修复素材");
        if (jianyingMissing && !jianyingSkipMissing) return void message.warning(`还有 ${jianyingMissing} 段不可导出，请勾选跳过后再继续`);
        if (jianyingStale && !jianyingSkipStale) return void message.warning(`还有 ${jianyingStale} 段为旧版本，请勾选确认使用旧版本`);
        const ok = await exportJianying("jianying", {
            root: jianyingRoot.trim(), captions: jianyingCaptions,
            revision: jianyingPreview?.revision,
            allowIncomplete: jianyingSkipMissing, allowStale: jianyingSkipStale,
        });
        if (ok) {
            setJianyingRequested(true);
            try { localStorage.setItem("drama-studio:jianying-root", jianyingRoot.trim()); } catch { /* 隐私模式忽略 */ }
        }
    };
    /** #5 一键打包全部资产：多选剧集（全选/取消）+ 媒体/提示词选项，选中集逐个产出真实 .mmxpack.zip。 */
    const exportPack = async (episodeIds: string[], opts: { media: boolean; prompts: boolean }) => {
        const chosen = episodes.filter((ep) => episodeIds.includes(ep.id) && ep.shotCount > 0);
        if (!chosen.length) return void message.warning("请先选择至少一个已拆分的剧集");
        if (!opts.media && !opts.prompts) return void message.warning("请至少选择媒体或提示词其中一项");
        setBusy("pack");
        try {
            const files: Record<string, Uint8Array> = {};
            let segmentTotal = 0;
            let refTotal = 0;
            for (const ep of chosen) {
                const epProduction = (await fetchEpisodeProduction(ep.id as never)).production;
                if (!epProduction) { message.warning(`第 ${ep.no} 集没有制作稿，已跳过`); continue; }
                const canvasClips = opts.media && ep.canvasId ? await collectPackClips(ep.canvasId).catch(() => null) : null;
                const clipPrompts = new Map<string, string>();
                if (opts.prompts) for (const [targetId, clip] of canvasClips || []) if (clip.prompt) clipPrompts.set(targetId, clip.prompt);
                const pack = buildPackFromProduction({
                    title: `第 ${ep.no} 集 ${ep.title}`,
                    production: epProduction as Parameters<typeof buildPackFromProduction>[0]["production"],
                    ...(opts.prompts ? { clipPrompts } : {}),
                });
                if (!opts.prompts) for (const segment of pack.timeline.segments) (segment as { prompt?: string }).prompt = "";
                let refCount = 0;
                if (opts.media) {
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
                } else {
                    for (const group of pack.groups) group.images = [];
                }
                const fileName = `E${String(ep.no).padStart(2, "0")}-${ep.title.replace(/[^\p{L}\p{N}._-]+/gu, "_")}-r${epProduction.revision}.mmxpack.zip`;
                files[fileName] = packToZip(pack);
                segmentTotal += pack.timeline.segments.length;
                refTotal += refCount;
            }
            const names = Object.keys(files);
            if (!names.length) throw new Error("没有可打包的剧集");
            const single = names.length === 1;
            const bytes = single ? files[names[0]] : zipSync(files);
            const blob = new Blob([bytes as unknown as BlobPart], { type: "application/zip" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = single ? names[0] : `影策资产包-共${names.length}集.zip`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1500);
            message.success(`资产包已导出（${names.length} 集 · ${segmentTotal} 段 · ${refTotal} 张参考图）`);
            setPackModalOpen(false);
        } catch (error) {
            message.error(`打包失败：${(error as Error).message}`);
        } finally {
            setBusy(null);
        }
    };

    /** #6 导入资产包：先解包并算出真实 plan 供预览，确认前不写入任何数据。 */
    const importPackFile = async (file: File) => {
        if (!current) return void message.warning("请先选一集");
        setImportOpening(true);
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const pack = zipToPack(bytes);
            setImportPack(pack);
            setImportFileName(file.name);
            setImportModalOpen(true);
            setImportRefs(true);
            setImportPrompts(true);
        } catch (error) {
            message.error(`无法读取资产包：${(error as Error).message}`);
        } finally {
            setImportOpening(false);
            if (packFileRef.current) packFileRef.current.value = "";
        }
    };
    /** #6 确认后按选项写入：参考图入库 + 段提示词/分镜写回制作稿并上画布。 */
    const confirmImportPack = async () => {
        if (!importPack || !current) return;
        const rawEp = rawEpisodes.find((ep) => ep.id === current.id);
        if (!rawEp) return void message.warning("找不到本集的原始数据");
        if (!importRefs && !importPrompts) return void message.warning("请至少选择一项导入内容");
        setBusy("import-pack");
        try {
            const packName = importFileName.replace(/\.mmxpack\.zip$/i, "").replace(/\.zip$/i, "");
            let uploaded = 0;
            let written = 0;
            if (importRefs) {
                const refs = await importPackRefs({ episodeId: rawEp.id, dramaId: rawEp.dramaId, packName, groups: importPack.groups });
                uploaded = refs.uploaded;
            }
            if (importPrompts) {
                const result = await importDirectorPackIntoEpisode(rawEp, importPack);
                written = result.written;
            }
            message.success(`资产包已导入（${written} 段 · ${uploaded} 张参考图）`);
            setImportModalOpen(false);
            setImportPack(null);
            await refreshAll();
        } catch (error) {
            message.error(`导入失败：${(error as Error).message}`);
        } finally {
            setBusy(null);
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

    /** 待处理 cast_failed：跳项目资产页并选中出错集（真实导航）。 */
    const openAssetsFor = (episodeId?: string) => {
        if (episodeId) {
            const params = new URLSearchParams(query);
            params.set("episodeId", episodeId);
            setQuery(params);
        }
        setAssetsInitialSub("library");
        setAssetsInitialKind(undefined);
        setAssetsFocus(null);
        setTopTab("项目资产");
    };

    /** 待处理 segment_failed：跳到出错集的对应段（复用画布 segmentId 定位的真实路径）。 */
    const openSegmentFor = (episodeId?: string, segmentId?: string) => {
        if (!dramaId || !episodeId) return;
        openEpisodeWorkspace(episodeId, "shots");
        if (segmentId) navigate(dramaWorkbenchPath(dramaId, episodeId, "shots") + `&segmentId=${encodeURIComponent(segmentId)}`);
    };

    /** 按集核查「打开资产设定」：切回资产库并按资产真值选中；分类用本地 CastKind。 */
    const openAssetSettings = (asset: { assetId: string; name: string; kind: string }) => {
        setAssetsFocus(asset);
        setAssetsInitialKind(asset.kind === "scene" ? "场景" : asset.kind === "prop" ? "道具" : asset.kind === "character" ? "角色" : undefined);
        setAssetsInitialSub("library");
        setTopTab("项目资产");
    };

    /** 按集核查/资产库：读某集制作稿 source + revision + 生成状态（真实数据，不经第二份真值）。 */
    // 稳定引用：作为 StudioAssetsTab 汇总 effect 的依赖，渲染体内新建会让每次父级重渲染都重拉全剧制作稿。
    const productionOf = useCallback(async (episodeId: string): Promise<{ source: Record<string, unknown> | null; revision: number; assets: Record<string, unknown>; assetCards: unknown[]; artifacts: Array<Record<string, unknown>> } | null> => {
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
                // h3 artifact.references 是该段真实附图请求记录；按集核查据此判 not-sent/not-selected。
                artifacts: Array.isArray(director.artifacts) ? director.artifacts as Array<Record<string, unknown>> : [],
            };
        } catch { return null; }
    }, []);

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

    /** 镜头级「跟导演讨论」（影策「与小影讨论」）：把当前镜头上下文带进导演对话。 */
    const discussShotWithDirector = (shot: { title?: string; visual?: string; camera?: unknown; duration_seconds?: number; dialogues?: unknown }) => {
        if (!dramaId || !current) return void message.warning("请先选一集");
        const dialogues = Array.isArray(shot.dialogues)
            ? shot.dialogues.map((d: { speaker?: string; text?: string }) => `${d?.speaker || ""}：${d?.text || ""}`.trim()).filter(Boolean).join("；")
            : "";
        const focus = [
            `第 ${current.no} 集「${current.title}」镜头「${shot.title || "未命名"}」`,
            shot.visual ? `画面：${shot.visual}` : "",
            shot.camera ? `运镜：${typeof shot.camera === "string" ? shot.camera : JSON.stringify(shot.camera)}` : "",
            shot.duration_seconds ? `时长：${shot.duration_seconds} 秒` : "",
            dialogues ? `台词：${dialogues}` : "",
        ].filter(Boolean).join("\n");
        const result = launchPlanningDirector(planningPrompt("script", {
            dramaId,
            name: currentFolder?.name || dramaId,
            pendingEpisodes: episodes.filter((ep) => ep.status === "需要处理").map((ep) => ep.no),
            focus,
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

    /** 影策 AddEpisodeModal：追加/插入共用同一个原文弹窗；真值由用户填写，提交时写后端落库。 */
    const openEpisodeDraft = (draft: EpisodeDraft) => {
        setEpisodeTitle("");
        setEpisodeFormat("novel");
        setEpisodeText("");
        setEpisodeDraft(draft);
    };

    const handleAddEpisode = (options?: { ignorePlanningGate?: boolean }) => {
        // 影策 episode-rail.tsx:123-124：顶部「+ 添加第 N 集」**不受分集规划门禁**，随时可加；
        // 只有底部整行入口在 planning 时隐藏/禁用（:232）。本地原来两处都卡门禁，导致规划没跑完加不出第 4 集。
        if (!options?.ignorePlanningGate && planningState.planDone === false) return void message.warning(PLAN_GATE_TIP_ADD);
        openEpisodeDraft({ mode: "add" });
    };

    /** 单集素材导入的文件解析：TXT/MD/CSV/TSV ≤2MB，UTF-8 失败回退 GBK（与新建页同口径）。 */
    const importEpisodeFile = async (file: File) => {
        if (!EPISODE_TEXT_FILE.test(file.name)) return void message.warning("支持 TXT、Markdown、CSV、TSV 文本文件");
        if (file.size > EPISODE_FILE_MAX_BYTES) return void message.warning("单集文件不超过 2MB");
        try {
            let text = await file.text();
            if (text.includes("\uFFFD")) {
                try { text = new TextDecoder("gbk").decode(await file.arrayBuffer()); } catch { /* 保留 UTF-8 解码结果 */ }
            }
            text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
            if (!text.trim()) return void message.warning("文件内容为空");
            setEpisodeText(text);
            setEpisodeTitle((prev) => prev || file.name.replace(/\.[^.]+$/, "").slice(0, 60));
        } catch (error) {
            message.error(`读取文件失败：${(error as Error).message}`);
        }
    };

    /** 提交建集：原文去空白计数拦截超限，sourceFormat/sourceText 透传到后端 POST 真落库。 */
    const submitEpisodeDraft = async () => {
        const draft = episodeDraft;
        if (!draft) return;
        const cleanText = episodeText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
        const chars = episodeSourceChars(cleanText);
        if (chars > EPISODE_SOURCE_CHARS)
            return void message.error(`本集原文 ${chars} 字，单集不超过 ${EPISODE_SOURCE_CHARS} 字，请拆成多集分别添加`);
        const isAdd = draft.mode === "add";
        const title = episodeTitle.trim();
        const source = { sourceFormat: episodeFormat, sourceText: cleanText };
        setBusy(isAdd ? "add" : "insert");
        try {
            const created = isAdd
                ? await addEpisode(title || undefined, source)
                : await insertEpisode(draft.no!, draft.position!, title || undefined, undefined, source);
            message.success(created
                ? `已${isAdd ? "添加" : "插入"}第 ${created.episodeNumber} 集，原文已落库`
                : `已${isAdd ? "添加" : "插入"}剧集`);
            setEpisodeDraft(null);
            if (created) {
                const next = new URLSearchParams(query);
                next.set("episodeId", created.id);
                setQuery(next);
            }
        } catch (error) {
            message.error(`${isAdd ? "添加" : "插入"}失败：${(error as Error).message}`);
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
            // 重放后立即刷新 pipeline 状态，让顶部失败计数/按钮随真值变化。
            await fetchDramaPipelineStatus(dramaId).then((s) => setPipeline(s)).catch(() => undefined);
            await refreshAll();
            const requeued = Number(result?.requeued || 0);
            const skipped = Number(result?.skippedByLimit || 0);
            // 熔断作业保留 failed 终态：只说「没有可重试」会让人误以为错误已解决，必须点明需人工介入。
            if (skipped > 0) {
                message.warning(requeued > 0
                    ? `已重新排队 ${requeued} 项失败任务；另有 ${skipped} 项已达重试上限，需人工处理`
                    : `${skipped} 项已达重试上限，需人工处理（已刷新制作数据；重试不会重排这些作业）`);
            } else {
                message.success(requeued > 0 ? `已重新排队 ${requeued} 项失败任务` : "没有可重试的失败任务，已刷新全部制作数据");
            }
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
                // 显式赋值：快速连点时 (p)=>!p 会按旧闭包反转，可能落成相反状态。
                const nextPaused = !paused;
                setPausedPersist(nextPaused);
                message.success(nextPaused ? "已暂停当前生成" : "已继续当前生成");
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
                if (paused) {
                    await resumeDramaPipeline(dramaId);
                    setPausedPersist(false);
                    message.success("已恢复全自动流水线");
                } else {
                    // 影策语义：暂停只停止派发新作业，已提交的生成任务继续跑完并回写。
                    await pauseDramaPipeline(dramaId);
                    setPausedPersist(true);
                    message.success("已暂停派发新作业；已提交的生成任务会继续完成");
                }
                setPipeline(await fetchDramaPipelineStatus(dramaId));
            } catch (error) {
                message.error(`操作失败：${(error as Error).message}`);
            } finally {
                setBusy(null);
            }
        }
    };

    /** 影策语义：暂停不是硬闸门。点生成/重试时先把全局暂停转回运行（对应暂停横幅里那句
     *  「重新改编、生成视频或重试会自动继续制作」），失败则抛出由调用方就地提示。 */
    const resumeIfPaused = async () => {
        if (!paused) return;
        if (!dramaId) throw new Error("请先选择剧目");
        await resumeDramaPipeline(dramaId);
        setPausedPersist(false);
        setPipeline(await fetchDramaPipelineStatus(dramaId));
        message.success("已自动继续制作");
    };

    /** 人工确认的重试：后端按作业重置 attempt 绕过熔断上限；暂停时先恢复，否则重排了也不会派发。 */
    const handleRetryJobs = async (jobIds: string[]) => {
        if (!dramaId) return void message.warning("请先选择剧目");
        if (!jobIds.length) return;
        setBusy("retry");
        try {
            await resumeIfPaused();
            let requeued = 0;
            const failures: string[] = [];
            for (const jobId of jobIds) {
                try {
                    const res = await retryDramaPipelineJob(dramaId, jobId);
                    if (res?.ok) requeued += 1;
                    else failures.push(`${jobId}：后端未确认`);
                } catch (error) {
                    failures.push(`${jobId}：${(error as Error).message}`);
                }
            }
            await fetchDramaPipelineStatus(dramaId).then((s) => setPipeline(s)).catch(() => undefined);
            await refreshAll();
            if (failures.length) message.warning(`已手动重新排队 ${requeued} 项；${failures.length} 项失败：${failures[0]}`);
            else message.success(`已手动重新排队 ${requeued} 项失败任务（尝试次数已重置）`);
        } catch (error) {
            message.error(`手动重试失败：${(error as Error).message}`);
        } finally {
            setBusy(null);
        }
    };

    const completed = counts["已完成"];
    const total = episodes.length;
    const progressPct = total ? Math.round((completed / total) * 100) : 0;
    // 影策 detail.tsx:420-430 顶部状态胶囊：等待媒体时优先显示「剧本就绪 · 待生成视频」。
    // 复用审批横幅同款 awaitingMedia 真实信号（studio-review-banner 派生，依赖运行中的流水线闸门），
    // 暂停态/全部完成不抢占，避免与「已暂停」「已完成」并列冲突。
    const capsuleAwaitingMedia = !paused && productionState.status !== "paused" && productionState.stage !== "done" && awaitingMedia;

    // 影策 detail.tsx:370 三态文案：运行中=暂停；停止且从未产出=开始制作；否则=继续制作。
    const productionStarted = productionState.stage !== "plan" && (completed > 0 || episodes.some((ep) => ep.shotCount > 0 || ep.status === "制作中"));
    const runLabel = !paused ? "暂停" : productionStarted ? "继续制作" : "开始制作";

    // 顶栏「一键全自动」收在「…」菜单里：菜单项文案/aria-label 复用同一套状态文案，不丢语义。
    const pipelineLabel = pipelineBusy ? "处理中…" : pipelineAllDone ? "已全部完成" : pipeline?.pipeline?.status === "running" ? "全自动·运行中" : "一键全自动";
    const pipelineRunning = !pipelineBusy && !pipelineAllDone && pipeline?.pipeline?.status === "running";

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

    // 影策 inbox：真实生成错误 + 阶段缺口，已由数据层按集归并。
    // 数据层的 inbox 只来自 generation_logs，不含 pipeline.jobs 的失败作业（script/assets/
    // prompts/video/render）。这些作业失败是流水线真正的错误，底部队列能看到、待处理页却
    // 显示「一切顺利」，两处口径不一致。这里把失败的 pipeline 作业补进待处理页。
    const inbox = useMemo<StudioInboxItem[]>(() => {
        const items: StudioInboxItem[] = [...hookInbox];
        for (const j of pipeline?.jobs || []) {
            if (String(j.status || "").toLowerCase() !== "failed") continue;
            const stage = String(j.stage || "");
            const ep = episodeById.get(String(j.episodeId || ""));
            const label = PIPELINE_STAGE_LABEL[stage] || stage || "作业";
            items.push({
                id: `pipeline:${String(j.id || "")}`,
                kind: "job_failed",
                severity: "error",
                title: `${ep ? `第 ${ep.no} 集` : "剧目"} · ${label}失败`,
                detail: String(j.error || `${label}作业失败${Number(j.attempt) > 1 ? `（已重试 ${j.attempt} 次）` : ""}`),
                episodeId: ep?.id,
                episodeNo: ep?.no,
                retryExhausted: Boolean(j.retryExhausted),
                jobId: String(j.id || ""),
            });
        }
        return items;
    }, [hookInbox, pipeline?.jobs, episodeById]);

    // 底部队列失败项：覆盖 inbox 全部真实失败 kind（cast_failed 参考图 / segment_failed 段视频 /
    // episode_error 分集错误 / job_failed 任务失败），排除 stage_gap（规划缺口非生成失败）。
    // 之前只取 episode_error|job_failed，漏掉 cast_failed（如缺主图1参考图）→ 队列显示「无失败任务」但「待重试6」。
    const errorInbox = useMemo(() => inbox.filter((item) => item.kind !== "stage_gap"), [inbox]);

    // 影策 awaitingMedia = 本地 status「待生成」：已拆镜有镜头、但尚未发布成片（publishedVersion===0）。
    // 见 use-studio-data.ts:205 状态派生；stage=video 反而是"已发布成片"，不能用来判 awaiting。
    const awaitingCount = episodes.filter((ep) => !ep.error && ep.status === "待生成").length;

    // 底部队列统一视图（对齐影策 queue-bar）：errorInbox + 批次，带筛选状态。
    // 时间字段全部来自后端按作业补的真值（pipeline.jobs / generation_logs），缺失才留空显示「—」。
    type QueueJob = {
        id: string; title: string; error: string; prompt?: string; status: string; episodeId?: string; kind?: string;
        createdAt?: string; startedAt?: string; finishedAt?: string; durationMs?: number;
        runtimeTaskId?: string; waitReason?: string; stage?: string; attempt?: number;
        attempts?: QueueAttemptRecord[];
    };
    // 影策队列行 = DramaJob（流水线作业 + 失败 inbox + 批次），不把 generation_logs 的单次模型请求当行。
    const QUEUE_ALL_LIMIT = 120;
    // 队列派生包含 JSON.stringify(b.plan) 与 O(n log n) 排序，队列收起时不必每次父级渲染都跑。
    const filteredQueue = useMemo<QueueJob[]>(() => {
        const queueJobs: QueueJob[] = [
            // inbox 的 pipeline:<jobId> 项与下面的流水线行同源，且去重时排在前面：把该作业自己的
            // 时间/attempt/attempts 一并带上，否则详情里只剩最终错误，逐次尝试不可查。
            ...errorInbox.map((it) => {
                const jobId = it.id.startsWith("pipeline:") ? it.id.slice("pipeline:".length) : "";
                const job = jobId ? (pipeline?.jobs || []).find((j) => String(j.id || "") === jobId) : undefined;
                return {
                    id: it.id, title: it.title, error: it.detail || "", prompt: undefined,
                    status: "failed", episodeId: it.episodeId,
                    kind: it.kind === "cast_failed" ? "参考图失败"
                        : it.kind === "segment_failed" ? "段视频失败"
                            : it.kind === "job_failed" ? "任务失败"
                                : it.kind === "stage_gap" ? "阶段缺口" : "分集错误",
                    ...(job ? {
                        stage: String(job.stage || "") || undefined,
                        attempt: Number(job.attempt) || 0,
                        createdAt: job.createdAt ? String(job.createdAt) : undefined,
                        startedAt: job.startedAt ? String(job.startedAt) : undefined,
                        finishedAt: job.finishedAt ? String(job.finishedAt) : undefined,
                        durationMs: typeof job.durationMs === "number" ? job.durationMs : undefined,
                        runtimeTaskId: job.runtimeTaskId ? String(job.runtimeTaskId) : undefined,
                        attempts: queueAttemptsOf(job.attempts),
                    } : {}),
                };
            }),
            ...batches.map((b) => ({
                id: b.runId, title: `批次 v${b.version} · ${b.targets?.length || 0} 目标`,
                error: b.error || "", status: (b.status || "").toLowerCase(), episodeId: b.episodeId,
                prompt: b.plan ? JSON.stringify(b.plan, null, 2) : undefined,
                kind: "批次生成", createdAt: b.createdAt,
            })),
            // 流水线阶段作业（script/assets/prompts/video/render）是真正在跑的操作，
            // 后端 status.jobs 已带 stage/status/attempt/error/episodeId 与 createdAt/startedAt/finishedAt/durationMs。
            ...(pipeline?.jobs || []).map((j) => {
                const stage = String(j.stage || "");
                const ep = episodeById.get(String(j.episodeId || ""));
                const status = String(j.status || "").toLowerCase();
                const err = j.error ? String(j.error) : "";
                const durationMs = typeof j.durationMs === "number" ? j.durationMs : undefined;
                return {
                    id: `pipeline:${String(j.id || "")}`,
                    title: `${ep ? `第 ${ep.no} 集` : "剧目"} · ${PIPELINE_STAGE_LABEL[stage] || stage || "作业"}${Number(j.attempt) > 1 ? `（第 ${j.attempt} 次）` : ""}`,
                    error: err, status, episodeId: ep?.id,
                    kind: PIPELINE_STAGE_LABEL[stage] || undefined,
                    stage, attempt: Number(j.attempt) || 0,
                    waitReason: j.waitReason ? String(j.waitReason) : undefined,
                    createdAt: j.createdAt ? String(j.createdAt) : undefined,
                    startedAt: j.startedAt ? String(j.startedAt) : undefined,
                    finishedAt: j.finishedAt ? String(j.finishedAt) : undefined,
                    durationMs,
                    // 逐次尝试记录：后端 attempts_json 投影，旧作业没有该字段 → 空数组（详情里如实说明未采集）。
                    attempts: queueAttemptsOf(j.attempts),
                } as QueueJob;
            }),
        ];
        // 三个页签都是同一批流水线作业，只是过滤状态不同；按 id 去重后按状态桶+真实时间排序。
        const seenQueueIds = new Set<string>();
        const rows = queueJobs
            .filter((j) => {
                if (queueFilter === "all") return true;
                if (queueFilter === "failed") return ["failed", "error", "retry"].includes(j.status) || Boolean(j.error);
                return ["running", "checking", "compiling", "applying", "queued"].includes(j.status);
            })
            .filter((j) => {
                if (seenQueueIds.has(j.id)) return false;
                seenQueueIds.add(j.id);
                return true;
            });
        const ordered = orderStudioQueue(rows);
        return queueFilter === "all" ? ordered.slice(0, QUEUE_ALL_LIMIT) : ordered;
    }, [errorInbox, batches, pipeline?.jobs, episodeById, queueFilter]);

    /** 作品/分集方式展示用的真实分集口径（来自 folder.productionPlan.sourceSplit / episodeMode）。 */
    const sourceSplit = (currentFolder?.productionPlan as Record<string, unknown> | undefined)?.sourceSplit as Record<string, unknown> | undefined;
    const planMode = (currentFolder?.productionPlan as Record<string, unknown> | undefined)?.episodeMode;
    const studioInfo = {
        dramaName: currentFolder?.name || "",
        episodeCount: episodes.length,
        chapterCount: productionState.chapterCount,
        perEpisode: Number(sourceSplit?.perEpisode) || 1,
        excludedCount: Array.isArray(sourceSplit?.excluded) ? (sourceSplit!.excluded as number[]).length : 0,
        episodeMode: planMode === "auto" ? "auto" as const : "chapter" as const,
        planDone: planningState.planDone,
        planCursor: planningState.planCursor,
        lastChapterIndex: planningState.lastChapterIndex,
    };

    /** 影策：插入集与追加共用同一个原文弹窗，新集取插入位置集号、后面顺延。 */
    const handleInsertEpisode = (no: number, position: "before" | "after") => {
        // 影策 detail.tsx:821：planDone=false（前面的章节还在分集规划）时禁止插入。
        if (planningState.planDone === false) return void message.warning(PLAN_GATE_TIP_INSERT);
        openEpisodeDraft({ mode: "insert", no, position });
    };

    /** 影策删除保护：先做客户端快速初判，最终以服务端 409 EPISODE_CONFIRM_REQUIRED 为准。 */
    const handleRemoveEpisode = (ep: StudioEpisode) => {
        if (ep.jobs.running > 0) return void message.warning(`第 ${ep.no} 集还有 ${ep.jobs.running} 个生成任务进行中，请等完成或先暂停`);
        if (episodes.length <= 1) return void message.warning("作品只剩一集，不能删除");
        // 删除保护用的是「实际制作进度」，不是剧目级 planning 的 stage.done。
        // 从原文直接建、由全自动流水线出片的剧目，planning.topic/outline 从没填过，
        // /drama/:id/stage 会误报「还在规划阶段」，但它早已分集出片——不能因此禁止删除。
        const hasRealProgress = episodes.some((item) =>
            item.shotCount > 0 || item.publishedVersion > 0
            || Boolean(String(item.synopsis || "").trim()) || Boolean(String(item.fullPlot || "").trim()));
        if (!hasRealProgress) return void message.warning("本剧还没有任何分集内容，请先在规划台确认分集后再删除");

        // 客户端初判（快速提示用，不是最终口径）：segmentCount / publishedVersion / finalResource。
        // 真值以服务端 dramaEpisodeDeleteGuard 为准；初判漏掉时 409 会把弹窗切成输入确认。
        let hasFinalResource = false;
        try {
            const prod = ep.id === current?.id ? production : undefined; // 当前集直接用缓存，非当前集交给服务端判
            hasFinalResource = Boolean(
                (((prod?.draft as Record<string, any> | undefined)?.director as Record<string, any> | undefined)?.workflow as Record<string, any> | undefined)?.finalResource?.storageKey
            );
        } catch { hasFinalResource = false; }
        const clientReasons = [
            ep.segmentCount > 0 ? `已生成 ${ep.segmentCount} 段视频` : null,
            ep.publishedVersion > 0 ? `已发布 v${ep.publishedVersion}` : null,
            hasFinalResource ? "已有成片" : null,
        ].filter(Boolean) as string[];

        setEpisodeDeleteTyped("");
        setEpisodeDeleteDraft({
            ep,
            needsTyped: clientReasons.length > 0,
            confirmText: `第 ${ep.no} 集`,
            reasons: clientReasons,
        });
    };

    /** 真删除：未带/错带确认文字时接住服务端 409，把弹窗动态切成「输入第 N 集」。 */
    const performEpisodeDelete = async (typedText?: string) => {
        const draft = episodeDeleteDraft;
        if (!draft) return;
        const ep = draft.ep;
        setBusy(`del-${ep.id}`);
        try {
            await removeEpisode(ep.id, typedText);
            message.success(`已删除第 ${ep.no} 集，后续集号已前移；本集原文已退回原著章节`);
            // 影策 detail.tsx:835-840：删后停在原位置的下一集，没有下一集回上一集；不清空 episodeId。
            const idx = episodes.findIndex((item) => item.id === ep.id);
            const neighbor = episodes[idx + 1] || episodes[idx - 1];
            if (ep.id === selectedId && neighbor) selectEpisode(neighbor);
            setEpisodeDeleteDraft(null);
            setEpisodeDeleteTyped("");
        } catch (error) {
            const required = episodeConfirmRequired(error);
            if (required) {
                // 服务端 409 是本集删除保护的唯一真值：reasons/stats 来自后端 dramaEpisodeDeleteGuard。
                const nested = (required as unknown as { details?: { reasons?: string[] } }).details;
                const reasons = (Array.isArray(required.reasons) && required.reasons.length
                    ? required.reasons
                    : Array.isArray(nested?.reasons) ? nested!.reasons! : []);
                setEpisodeDeleteDraft((prev) => prev ? {
                    ...prev,
                    needsTyped: true,
                    serverDriven: true,
                    confirmText: required.confirmText,
                    reasons: reasons.length ? reasons : prev.reasons,
                } : prev);
                setEpisodeDeleteTyped("");
                const serverErrorText = (required as unknown as { error?: string }).error;
                message.warning(serverErrorText || `该集${reasons.join("、") || "已有视频/成片/历史版本"}，请输入「${required.confirmText}」确认删除`);
                return; // 弹窗保持打开，等用户输入正确的确认文字后重发
            }
            message.error(`删除失败：${(error as Error).message}`);
        } finally {
            setBusy(null);
        }
    };

    const confirmEpisodeDelete = () => {
        const draft = episodeDeleteDraft;
        if (!draft) return;
        if (draft.needsTyped) {
            if (compact(episodeDeleteTyped) !== compact(draft.confirmText)) {
                message.error(`输入不匹配，需输入「${draft.confirmText}」`);
                return; // 输入错绝不删
            }
            void performEpisodeDelete(episodeDeleteTyped);
            return;
        }
        // 客户端初判不需输入 → 直接 DELETE；若服务端判定需要确认，409 会在上面切弹窗。
        void performEpisodeDelete();
    };

    // 影策 detail.tsx:821：规划未完成时插入集禁用并给出原因（title）。
    const insertDisabled = !planningState.planDone;
    const episodeMenu = (ep: StudioEpisode): MenuProps => ({
        items: [
            { key: "before", label: <span title={insertDisabled ? PLAN_GATE_TIP_INSERT : undefined}>在前面插入一集</span>, disabled: insertDisabled, onClick: () => void handleInsertEpisode(ep.no, "before") },
            { key: "after", label: <span title={insertDisabled ? PLAN_GATE_TIP_INSERT : undefined}>在后面插入一集</span>, disabled: insertDisabled, onClick: () => void handleInsertEpisode(ep.no, "after") },
            { type: "divider" },
            { key: "delete", label: "删除本集", danger: true, disabled: episodes.length <= 1, onClick: () => void handleRemoveEpisode(ep) },
        ],
    });

    /** 顶栏「资产包」：影策一键打包/导入/交付，全部接真接口（导演包 zip + 交付包）。 */
    const assetPackMenu: MenuProps = {
        items: [
            { key: "pack", label: "一键打包全部资产", onClick: () => setPackModalOpen(true) },
            { key: "import", label: "导入资产包", onClick: () => packFileRef.current?.click() },
            { type: "divider" },
            { key: "delivery", label: "导出交付包（成片+SRT+提示词）", onClick: () => void exportJianying("delivery") },
            { key: "jianying", label: <span title="检查可用剧情段、缺段与旧版本后，导出剪映草稿">导出剪映草稿</span>, onClick: () => openJianyingModal() },
        ],
    };

    /** 顶栏「…」→「工具…」子菜单：影策制作能力逐项接入本地 /production 各 workspace。 */
    const toolsMenu: MenuProps = {
        items: [
            { key: "discuss", label: "与本集导演讨论（小影）", onClick: discussWithDirector },
            { type: "divider" },
            { key: "story", label: "剧本分场", onClick: () => openWorkspace("story") },
            { key: "assets", label: "设定与资产库", onClick: () => openWorkspace("assets") },
            { key: "shots", label: "分镜全屏工作台", onClick: () => openWorkspace("shots") },
            { key: "continuity", label: "连续性 / 尾帧台账", onClick: () => openWorkspace("continuity") },
            { key: "clips", label: "成片与交付", onClick: () => openWorkspace("clips") },
            { key: "versions", label: "版本记录与对比", onClick: () => {
                if (!dramaId) return void message.warning("请先选择剧目");
                if (!current) return void message.warning("请先选一集");
                setVersionCompareOpen(true);
            } },
        ],
    };

    /** 顶栏「…」：本地特有入口（影策没有）全部收进一个菜单，主行右侧只留影策四个动作。 */
    const moreActionsLabel = pipelineRetryableCount > 0
        ? `更多操作：${pipelineLabel} / 重试失败 ${pipelineRetryableCount} / 工具`
        : `更多操作：${pipelineLabel} / 工具`;
    const moreMenu: MenuProps = {
        items: [
            {
                key: "pipeline",
                icon: <Zap className="size-3.5" />,
                title: paused ? "已暂停，继续后可生成" : `${pipelineLabel}：全自动流水线，一键从剧本推进到成片（对齐影策服务端自动编排）`,
                disabled: pipelineBusy || paused,
                label: (
                    <span data-studio-pipeline-toggle-menu={pipelineLabel}>
                        {pipelineBusy
                            ? "全自动流水线 · 处理中…"
                            : pipelineAllDone
                                ? "全自动流水线 · 已全部完成"
                                : pipelineRunning ? "全自动·运行中" : "全自动流水线"}
                    </span>
                ),
                onClick: () => handlePipelineStart(),
            },
            {
                key: "retry",
                icon: <CircleAlert className="size-3.5" />,
                danger: true,
                title: busy === "retry" ? "重试中…" : `重试流水线里 ${pipelineRetryableCount} 个可重排的失败任务（已达上限的需人工介入）`,
                disabled: pipelineRetryableCount === 0 || busy === "retry",
                label: (
                    <span data-studio-retry-failed-menu={pipelineRetryableCount}>
                        {busy === "retry" ? "重试中…" : `重试失败（${pipelineRetryableCount}）`}
                    </span>
                ),
                onClick: () => void handleRetryAll(),
            },
            { type: "divider" },
            {
                key: "tools",
                icon: <Wand2 className="size-3.5" />,
                title: "工具：影策制作能力（分镜/资产/连续性/成片/版本/导演讨论）",
                label: <span data-studio-tools-menu>工具…</span>,
                children: toolsMenu.items ?? [],
            },
        ],
    };

    /** 详情头「…」：本集二级动作（分镜改编 / 拆镜 / 导演讨论）。
     *  影策 detail 头右侧只保留「剧本 / 分镜 / 成片 + 在画布中打开本集」，这三个本地入口原先平铺在
     *  同一行，窄屏会把右缘按钮推出可视区；收进真实菜单后功能不丢，头部也不会被裁。 */
    const detailMoreMenu: MenuProps = {
        items: [
            { key: "adapt", icon: <Wand2 className="size-3.5" />, disabled: !current, label: <span title="切到剧本页改编本集剧本并生成分镜">分镜改编</span>, onClick: () => openWorkspace("story") },
            { key: "split", icon: <Scissors className="size-3.5" />, disabled: !current, label: <span title="把本集分场剧本拆成结构化镜头并同步到画布">拆镜</span>, onClick: () => setSplitOpen(true) },
            { key: "discuss", icon: <Sparkles className="size-3.5" />, disabled: !current, label: <span title="带上本集上下文打开导演对话，优化台词/动作/景别/运镜">导演讨论</span>, onClick: () => discussWithDirector() },
        ],
    };

    /** 影策状态格子（drama.css:1378-1406）：一格一集，按真实状态着色；选中集 2px 描边；
     *  title / aria-label 带集号+标题+状态，点击切换当前集。格子默认只显示色块，hover 才显示集号。 */
    const renderStatusCell = (ep: StudioEpisode) => {
        const tone = episodeTone(ep);
        const active = current?.id === ep.id;
        const label = EPISODE_TONE_LABEL[tone];
        return (
            <button
                key={ep.id}
                type="button"
                data-studio-status-cell={tone}
                data-studio-status-cell-no={ep.no}
                aria-current={active}
                aria-pressed={active}
                aria-label={`第 ${ep.no} 集 · ${ep.title} · ${label}`}
                title={`第 ${ep.no} 集 · ${ep.title} · ${label}`}
                onClick={() => selectEpisode(ep)}
                style={tone === "ready" ? EPISODE_TONE_READY_STYLE : undefined}
                className={cn(
                    "group flex aspect-square w-full min-w-0 items-center justify-center rounded-[4px] text-[11px] font-semibold tabular-nums transition-colors",
                    EPISODE_TONE_CELL[tone],
                    active && "outline-2 outline-offset-1 outline-foreground",
                )}
            >
                <span className="text-transparent transition-colors group-hover:text-current">{ep.no}</span>
            </button>
        );
    };

    /** 影策 episode-rail.tsx:200-216 / drama.css:1242-1314：60px 单行卡，38px 序号列，
     *  标题单行 ellipsis，状态文本与阶段条同处 meta 行两端（列表与网格共用）。 */
    const renderEpisodeCard = (ep: StudioEpisode) => (
        <div
            className={cn(
                "group relative h-[60px] overflow-hidden rounded-lg border transition-colors",
                current?.id === ep.id
                    ? "border-foreground/20 bg-background shadow-sm"
                    : "border-transparent bg-transparent hover:bg-muted/60",
            )}
        >
            <button
                type="button"
                aria-current={current?.id === ep.id}
                onClick={() => selectEpisode(ep)}
                className="grid h-full w-full grid-cols-[30px_minmax(0,1fr)] items-center gap-2 pl-2 pr-2 text-left"
            >
                {/* 影策 .drama-rail-item 行内是纯序号文本（无彩色方块），副行显示「视频 ready/段数」。 */}
                <span className="text-[11px] font-semibold tabular-nums text-muted-foreground">
                    {String(ep.no).padStart(2, "0")}
                </span>
                <span className="flex min-w-0 flex-col">
                    <span className="block truncate pr-6 text-[13px] font-medium" title={ep.title}>{ep.title}</span>
                    <span className="mt-0.5 flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate tabular-nums">视频 {ep.videoReady ?? 0}/{ep.segmentCount || ep.shotCount || 0}</span>
                            {ep.status === "需要处理" ? <StatusChip episode={ep} /> : null}
                            {/* 只在当前有未恢复失败(ep.error)时显示红色失败数；历史失败已被成功覆盖不再挂红条 */}
                            {ep.error && ep.jobs.failed > 0 ? (
                                <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-rose-500" title={`${ep.jobs.failed} 次生成失败`}>
                                    <CircleAlert className="size-3" />{ep.jobs.failed}
                                </span>
                            ) : null}
                        </span>
                        <StagePips episode={ep} />
                    </span>
                </span>
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
    );

    return (
        /* 影策全局 button 是 cursor:pointer、disabled 是 not-allowed；本地 Tailwind preflight 默认 default，
           整页按钮「看不出能点」。在制作台作用域一次性对齐，不改全局样式表。 */
        <div
            data-drama-studio="shell"
            className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground [&_button:not(:disabled)]:cursor-pointer [&_button:disabled]:cursor-not-allowed [&_summary]:cursor-pointer"
        >
            {/* 制作台 ↔ 画布 切换器（复用老版制作台同款，两态同一工作台） */}
            <WorkspaceViewSwitcher
                mode={canvasHost?.visible ? "canvas" : "production"}
                onSelect={(next) => { if (next === "canvas") openInCanvas(); else canvasHost?.collapse?.(); }}
            />
            {/* 标题区 */}
            <div className="shrink-0 border-b border-border">
                {/* 影策 .drama-topbar：padding 0 16 0 8 / 高 56 / gap 12；返回键与左栏内边距成同一条竖线（8px）。 */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 pl-2 pr-4">
                    <button
                        type="button"
                        aria-label="返回"
                        onClick={() => navigate(-1)}
                        className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
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
                                className="h-8 max-w-[220px] cursor-pointer appearance-none truncate rounded-md border border-transparent bg-transparent pl-0 pr-5 text-base font-semibold outline-none transition hover:border-border hover:pl-2"
                                aria-label="切换剧目"
                                title={currentFolder.name}
                            >
                                {dramaFolders.map((folder) => (
                                    <option key={folder.id} value={folder.id}>{folder.name}</option>
                                ))}
                            </select>
                            <ChevronDown className="pointer-events-none absolute right-0 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        </div>
                    ) : (
                        <h1 className="max-w-[220px] truncate text-base font-semibold" title={urlDramaId && !currentFolder ? "加载中…" : hydrated ? "暂无剧目" : "加载中…"}>{urlDramaId && !currentFolder ? "加载中…" : hydrated ? "暂无剧目" : "加载中…"}</h1>
                    )}
                    <button
                        type="button"
                        aria-label="新建短剧"
                        title="新建短剧：从小说原文/剧本/分镜开始"
                        onClick={() => navigate("/drama-studio/new")}
                        className="flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    >
                        <Plus className="size-3.5" /> 新建短剧
                    </button>
                    <Modal
                        title="拆镜 · 分场剧本转结构化镜头"
                        open={splitOpen}
                        onCancel={() => setSplitOpen(false)}
                        footer={null}
                        width={960}
                        destroyOnClose
                    >
                        {dramaId ? <Suspense fallback={<TabChunkFallback />}><AdaptStoryboardPanel
                            dramaId={dramaId}
                            episodes={rawEpisodes}
                            defaultEpisodeId={current?.id}
                            // 拆镜写稿会发布制作稿；资产建档会在其后单独进行（create_manual_director_asset 会标 stale），
                            // 所以这里只刷新，不自动建档——避免刚发布的镜头被标 stale。
                            onWritten={() => { void refreshAll(); }}
                        /></Suspense> : null}
                    </Modal>
                    {/* 影策 detail.tsx:420-430：等待媒体显示「剧本就绪 · 待生成视频」，否则制作状态。 */}
                    {/* 数据未就绪（URL 有剧目但 folders 还没到）时显示加载态，避免「制作中 0/0 集」的假状态闪烁 */}
                    {urlDramaId && !currentFolder ? (
                        <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-[11px] text-muted-foreground"><LoaderCircle className="size-3 animate-spin" /> 加载中…</span>
                    ) : (
                    <>
                    <span
                        data-studio-capsule={capsuleAwaitingMedia ? "ready" : paused ? "paused" : productionState.stage === "done" ? "done" : "producing"}
                        className={cn(
                            "inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-[11px]",
                            paused || productionState.status === "paused"
                                ? "bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400"
                                : capsuleAwaitingMedia
                                    ? "bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-400"
                                    : "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400",
                        )}
                        title={`制作阶段：${productionState.stage}${capsuleAwaitingMedia ? " · 剧本已就绪待生成视频" : ""}`}
                    >
                        <span className={cn(
                            "size-2 rounded-full",
                            paused || productionState.status === "paused"
                                ? "bg-amber-500"
                                : capsuleAwaitingMedia ? "bg-sky-500" : "bg-emerald-500",
                            !paused && productionState.status !== "paused" && !capsuleAwaitingMedia && productionState.stage !== "done" ? "animate-pulse" : "",
                        )} />
                        {paused || productionState.status === "paused"
                            ? "已暂停"
                            : capsuleAwaitingMedia
                                ? "剧本就绪 · 待生成视频"
                                : productionState.stage === "done" ? "已完成" : "制作中"}
                    </span>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="h-[5px] w-[120px] overflow-hidden rounded-full bg-muted">
                            <span className="block h-full rounded-full bg-gradient-to-r from-emerald-500/70 to-emerald-400 transition-all" style={{ width: `${progressPct}%` }} />
                        </span>
                        <span className="whitespace-nowrap tabular-nums">{completed}/{total} 集成片 · {total} 集</span>
                        {productionState.chapterCount > total ? <span>· 原著 {productionState.chapterCount} 章 · 已选 {total} 集</span> : null}
                        {!connected ? <span className="text-amber-500">· 后台未连接</span> : null}
                    </div>
                    </>
                    )}

                    {/* 右侧操作区整组：宽屏与左侧同一行（ml-auto 顶到最右），窄屏整组换行，不会只掉一个按钮到第二行。 */}
                    {/* 顶层 Tab：影策 .drama-nav 是进度条之后的独立子项（margin-left 12），不并进右侧动作组；位置与影策一致。 */}
                    <nav className="ml-3 flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-muted/50 p-1 shadow-inner" aria-label="制作台视图">
                            {TOP_TABS.map((tab) => {
                                const Icon = TOP_TAB_ICONS[tab];
                                const active = topTab === tab;
                                return (
                                    <button
                                        key={tab}
                                        type="button"
                                        aria-current={active ? "page" : undefined}
                                        title={tab}
                                        onClick={() => setTopTab(tab)}
                                        className={cn(
                                            "inline-flex h-[30px] shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 text-xs transition",
                                            active
                                                ? "bg-background font-medium text-foreground shadow-sm"
                                                : "text-muted-foreground hover:text-foreground",
                                        )}
                                    >
                                        <Icon className="size-4 shrink-0" aria-hidden />
                                        {tab}
                                        {tab === "待处理" && inbox.length ? (
                                            <span className="ml-0.5 min-w-[18px] rounded-full bg-rose-500 px-1 text-[10px] font-semibold leading-[18px] text-white tabular-nums">{inbox.length}</span>
                                        ) : null}
                                    </button>
                                );
                            })}
                        </nav>

                    {/* 右侧动作组：影策 .drama-topbar-actions（gap 8、margin-left auto 贴右缘、按钮 padding 12）。 */}
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                            {/* 影策同款四个动作，顺序与影策一致；本地特有入口全部收进右侧「…」菜单，不再占主行。 */}
                            <Dropdown menu={assetPackMenu} trigger={["click"]} placement="bottomRight">
                                <button
                                    type="button"
                                    className="flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
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
                            <button
                                type="button"
                                onClick={() => openInCanvas()}
                                className="flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                            >
                                <Palette className="size-3.5" /> 精修画布
                            </button>
                            {awaitingCount > 0 ? (
                                <button
                                    type="button"
                                    data-studio-release-all
                                    aria-label={`全部生成视频 · ${awaitingCount} 集`}
                                    title={paused ? "已暂停，继续后可生成" : `全部生成视频 · ${awaitingCount} 集`}
                                    onClick={confirmReleaseAll}
                                    disabled={paused}
                                    className="flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-60"
                                >
                                    <Play className="size-3.5" /> 全部生成视频 · {awaitingCount} 集
                                </button>
                            ) : null}
                            {productionState.stage !== "done" ? (
                                <button
                                    type="button"
                                    onClick={handleTogglePause}
                                    disabled={busy === "pause"}
                                    aria-label={runLabel}
                                    title={runLabel}
                                    className="flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-60"
                                >
                                    {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                                    {runLabel}
                                </button>
                            ) : null}
                            {/* 本地特有入口（一键全自动 / 重试失败 / 工具）收进一个「…」菜单，主行只留影策四个动作。 */}
                            <Dropdown menu={moreMenu} trigger={["click"]} placement="bottomRight">
                                <button
                                    type="button"
                                    data-studio-more-actions
                                    aria-label={moreActionsLabel}
                                    aria-haspopup="menu"
                                    title={moreActionsLabel}
                                    className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                >
                                    <MoreHorizontal className="size-4" aria-hidden />
                                    {pipelineFailedCount > 0 ? (
                                        <span className="absolute -right-1 -top-1 min-w-[14px] rounded-full bg-rose-500 px-1 text-[10px] font-semibold leading-[14px] text-white tabular-nums">{pipelineFailedCount}</span>
                                    ) : null}
                                </button>
                            </Dropdown>
                        </div>
                    </div>
                </div>
            </div>

            {/* 主体两栏 */}
            <div className="flex min-h-0 flex-1">
                {/* 左栏：剧集列表。影策只有「制作」页带集列表侧栏；项目资产 / 待处理 / 设置是全宽页面。 */}
                {topTab === "制作" ? <aside className="flex w-[292px] shrink-0 flex-col border-r border-border bg-card/40">
                    {/* 影策 .drama-rail-head：padding 8 / gap 8；搜索框高 32，左缘与顶栏返回键同一竖线（8px）。 */}
                    <div className="flex items-center gap-2 px-2 pt-2">
                        <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-background px-2">
                            <Search className="size-3.5 shrink-0 text-muted-foreground" />
                            <input
                                value={search}
                                onChange={(e) => { const value = e.target.value; startTransition(() => setSearch(value)); }}
                                onKeyDown={(e) => { if (e.key === "Enter" && visibleEpisodes[0]) selectEpisode(visibleEpisodes[0]); }}
                                placeholder="集号或标题"
                                aria-label="搜索剧集"
                                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
                            />
                            {search ? (
                                <button type="button" aria-label="清空搜索" onClick={() => setSearch("")} className="shrink-0 text-muted-foreground transition hover:text-foreground">
                                    <X className="size-3.5" />
                                </button>
                            ) : null}
                        </div>
                        <button
                            type="button"
                            aria-label={`添加第 ${total + 1} 集`}
                            onClick={() => handleAddEpisode({ ignorePlanningGate: true })}
                            disabled={busy === "add"}
                            title={`添加第 ${total + 1} 集：粘贴或导入下一集的原文、剧本或分镜`}
                            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-60"
                        >
                            {busy === "add" ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
                        </button>
                        {/* 影策 episode-rail.tsx:135-139：列表/矩阵是同「一个」32×32 按钮来回切（aria-pressed 表示当前是矩阵），
                            不是两个 24px 小按钮；热区与语义都按影策来。 */}
                        <button type="button" data-studio-view={view} aria-pressed={view === "grid"}
                            aria-label={view === "grid" ? "切换列表视图" : "切换矩阵视图"}
                            title={view === "grid" ? "列表视图" : "矩阵视图：一屏看清全剧进度"}
                            onClick={() => setViewPersist(view === "grid" ? "list" : "grid")}
                            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground">
                            {view === "grid" ? <List className="size-4" /> : <LayoutGrid className="size-4" />}
                        </button>
                    </div>

                    {/* 影策 episode-rail 状态分页：全部 / 待处理 / 制作中 / 已完成，选中为深底胶囊。 */}
                    <div className="thin-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto px-2 pt-2" role="group" aria-label="分集状态分页" data-studio-status-tabs>
                        {filters.map((f) => (
                            <button
                                key={f.key}
                                type="button"
                                data-studio-status-tab={f.key}
                                aria-pressed={filter === f.key}
                                onClick={() => setFilter(f.key)}
                                className={cn(
                                    "h-[26px] shrink-0 rounded-full px-2 text-[11px] leading-none transition-colors",
                                    filter === f.key
                                        ? "bg-foreground/10 font-medium text-foreground ring-1 ring-foreground/15"
                                        : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                                )}
                            >
                                {f.label}
                                {/* 影策 .drama-filter.is-alert b：待处理有内容时只把计数标红。 */}
                                <b className={cn("ml-0.5 font-semibold tabular-nums", f.key === "需要处理" && f.count > 0 ? "text-rose-500" : "opacity-70")}>{f.count}</b>
                            </button>
                        ))}
                    </div>

                    {/* 影策 episode-rail.tsx:150-191：图例与状态格子只属于矩阵（宫格）视图；
                        列表视图只有集行，不出宫格也不出图例。 */}
                    {view === "grid" ? (
                        <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-2 pt-2 text-[10px] text-muted-foreground" role="group" aria-label="分集状态图例">
                            {EPISODE_TONE_ORDER.map((tone) => (
                                <span key={tone} className="inline-flex items-center gap-1">
                                    <i aria-hidden className={cn("size-2 rounded-full", EPISODE_TONE_DOT[tone])} style={tone === "ready" ? EPISODE_TONE_READY_STYLE : undefined} /> {EPISODE_TONE_LEGEND_LABEL[tone]}
                                </span>
                            ))}
                        </div>
                    ) : null}

                    <div ref={episodeListRef} className={cn("min-h-0 flex-1 overflow-y-auto p-2", view === "grid" && "grid grid-cols-10 content-start gap-1")} data-studio-status-grid={view === "grid" ? "grid" : "list"}>
                        {loading ? (
                            <div className={cn("flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground", view === "grid" && "col-span-10")}>
                                <LoaderCircle className="size-4 animate-spin" /> 加载剧集…
                            </div>
                        ) : null}
                        {view === "grid" ? (
                            visibleEpisodes.map((ep) => renderStatusCell(ep))
                        ) : visibleEpisodes.length ? (
                            <div className="relative w-full" style={{ height: episodeVirtualizer.getTotalSize() }}>
                                {episodeVirtualizer.getVirtualItems().map((item) => (
                                    <div
                                        key={visibleEpisodes[item.index].id}
                                        data-index={item.index}
                                        ref={episodeVirtualizer.measureElement}
                                        className="absolute left-0 top-0 w-full pb-0.5"
                                        style={{ transform: `translateY(${item.start}px)` }}
                                    >
                                        {renderEpisodeCard(visibleEpisodes[item.index])}
                                    </div>
                                ))}
                            </div>
                        ) : null}
                        {!loading && visibleEpisodes.length === 0 ? (
                            <div className={cn("py-10 text-center text-xs text-muted-foreground", view === "grid" && "col-span-10")}>
                                {dramaId ? "没有匹配的剧集" : "请先在剧目列表创建一个短剧"}
                            </div>
                        ) : null}
                        {/* 影策 episode-rail.tsx:225：planning（!planDone）时提示「后续章节正在分集…」。
                            本地真实信号 planningState.planDone（fetchDramaPlanningState），
                            且必须等信号拉回（planningLoaded）才显示，默认未加载不误报。 */}
                        {planningLoaded && !planningState.planDone && dramaId ? (
                            <div className={cn("py-3 pl-1 text-left text-[10px] text-muted-foreground/70", view === "grid" && "col-span-10")}>后续章节正在分集…</div>
                        ) : null}
                    </div>

                    <div className="shrink-0 space-y-1.5 border-t border-border p-2">
                        {studioInfo.excludedCount > 0 ? (
                            <button
                                type="button"
                                aria-label="继续选章"
                                onClick={() => setChapterPickerOpen(true)}
                                className="flex h-9 w-full items-center justify-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
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
                                className="flex h-9 w-full items-center justify-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2 text-[11px] text-primary transition hover:bg-primary/10 disabled:opacity-60"
                            >
                                <BookOpen className="size-3.5" /> 按原文批量建集
                            </button>
                        ) : null}
                        <button
                            type="button"
                            onClick={() => handleAddEpisode()}
                            disabled={busy === "add" || !planningState.planDone}
                            title={!planningState.planDone ? PLAN_GATE_TIP_ADD : undefined}
                            className="flex h-9 w-full items-center justify-center gap-1 rounded-md border border-dashed border-border text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-60"
                        >
                            <Plus className="size-3.5" /> {total ? `添加第 ${total + 1} 集` : "添加第一集"}
                        </button>
                    </div>
                </aside> : null}

                {/* 右栏：详情 */}
                <section className="flex min-w-0 flex-1 flex-col bg-background">
                    {/* 详情头：影策只在「制作」页显示集头 + 剧本/分镜/成片分页 */}
                    {topTab === "制作" ? <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-2">
                        {/* 左组（集号/标题/统计）：min-w-0 + flex-1，空间不够时自身换行，右组 shrink-0 永不被裁。 */}
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
                            <span className="shrink-0 text-xs text-muted-foreground">
                                {current ? `第 ${current.no} 集 · ${headStageLabel(current)}` : "未选择剧集"}
                            </span>
                            {/* 影策 detail.tsx:602-633 的 eyebrow（集号·阶段）与标题是两行；本地并排在同一行，
                                用极细分隔线断开，避免「第1集·排队中 第1集·标题」读起来像连成一串。 */}
                            {current ? <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" /> : null}
                            {current && renaming ? (
                                <span className="flex min-w-0 items-center gap-2">
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
                                        className="h-7 w-56 min-w-0 rounded-md border border-primary bg-background px-2 text-sm font-semibold outline-none"
                                    />
                                    <span className="shrink-0 text-[10px] text-muted-foreground">回车保存 · Esc 取消</span>
                                </span>
                            ) : (
                                <h2 className="min-w-0 max-w-[46ch] truncate text-sm font-semibold" title={current?.title || undefined}>{current?.title || "—"}</h2>
                            )}
                            {current && !renaming ? (
                                <button
                                    type="button"
                                    aria-label="重命名本集"
                                    title="重命名本集"
                                    onClick={() => handleRenameEpisode(current)}
                                    className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                >
                                    <Pencil className="size-3.5" />
                                </button>
                            ) : null}
                            {/* 影策 detail.tsx:635-639 只有「N 镜」；场次/段数是本地额外信息，弱化保留不强删。 */}
                            <span
                                className="whitespace-nowrap text-[10px] text-muted-foreground/70"
                                title="本地额外信息：真实制作稿的镜头数 / 场次 / 剧情段数"
                            >
                                {shots.length} 镜{headDurationSec > 0 ? ` · ${Math.floor(headDurationSec / 60)}分${String(Math.round(headDurationSec % 60)).padStart(2, "0")}秒` : ""} · {scenes.length} 场 · {clipGroups.length} 段
                            </span>
                            {current ? <span className="shrink-0"><StagePips episode={current} size="md" /></span> : null}
                        </div>
                        {/* 右组：分页 + 「…」+ 主操作。shrink-0 保证按钮自身不被压缩；整组放不下时由外层
                            flex-wrap 换行，且组内也允许换行——任何宽度都不会把按钮推出可视区。 */}
                        <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
                            <div className="flex items-center rounded-md border border-border p-1" aria-label="制作工作台">
                                {WORKSPACE_TABS.map((tab) => {
                                    /* 影策 .drama-tab：高 30 / 左右内边距 16 / 图标 14 + 8 间距，整枚按钮可点；
                                       本地原先只有 8px 内边距且无图标，热区比影策窄一截。 */
                                    const TabIcon = tab.key === "story" ? ScrollText : tab.key === "shots" ? Clapperboard : Film;
                                    return (
                                    <button
                                        key={tab.key}
                                        type="button"
                                        data-studio-workspace={tab.key}
                                        onClick={() => openWorkspace(tab.key)}
                                        className={cn(
                                            "inline-flex h-[30px] shrink-0 items-center gap-2 whitespace-nowrap rounded px-4 text-[11px] transition",
                                            activeStudioTab === tab.key ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                                        )}
                                    >
                                        <TabIcon className="size-3.5 shrink-0" aria-hidden />
                                        {tab.label}
                                    </button>
                                    );
                                })}
                            </div>
                            {/* 本地三个二级动作收进「…」：影策同一行没有这些按钮，功能不丢、头部不溢出。 */}
                            <Dropdown menu={detailMoreMenu} trigger={["click"]} placement="bottomRight">
                                <button
                                    type="button"
                                    data-studio-detail-more=""
                                    aria-label="更多本集操作"
                                    title="更多本集操作：分镜改编 / 拆镜 / 导演讨论"
                                    className="flex h-8 shrink-0 items-center justify-center rounded-md border border-border px-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                >
                                    <MoreHorizontal className="size-3.5" />
                                </button>
                            </Dropdown>
                            <button
                                type="button"
                                onClick={() => openInCanvas()}
                                className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                            >
                                <ExternalLink className="size-3.5" /> 在画布中打开本集
                            </button>
                        </div>
                    </div> : null}

                    {/* 顶部 tab 内容区统一加载门控：loading/detailLoading 来自 react-query isLoading
                        （仅首次拉取且无缓存时为真），切剧目/剧集/tab 未到位时先显示骨架，
                        缓存命中不闪屏；断连时 query enabled=false 不会误显加载态。 */}
                    {loading || detailLoading ? (
                        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6" role="status" aria-busy="true">
                            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">加载中…</span>
                            <div className="w-full max-w-md animate-pulse space-y-2">
                                <div className="h-3 w-4/5 rounded bg-muted" />
                                <div className="h-3 w-3/5 rounded bg-muted" />
                                <div className="h-3 w-2/3 rounded bg-muted" />
                            </div>
                        </div>
                    ) : topTab === "制作" ? (
                        <>
                            {/* 影策 detail.tsx:669-677：暂停横幅（原因 + 继续制作）。暂停是服务端真值，
                                没有暂停就不渲染；继续按钮复用同一 handleTogglePause，不另造入口。 */}
                            {paused && productionState.stage !== "done" ? (
                                <div data-studio-banner="paused" className="mx-5 mt-3 flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
                                    <span className="font-medium">制作已暂停</span>
                                    <span className="min-w-0 flex-1 truncate text-amber-700/80 dark:text-amber-200/70" title={productionState.pauseReason || undefined}>
                                        {productionState.pauseReason || "不会再派发新的生成任务；重新改编、生成视频或重试会自动继续制作。"}
                                    </span>
                                    <button type="button" onClick={handleTogglePause} disabled={busy === "pause"}
                                        className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 text-[11px] font-medium text-background transition hover:bg-primary/90 disabled:opacity-60"
                                        data-studio-banner-resume>
                                        <Play className="size-3" /> 继续制作
                                    </button>
                                </div>
                            ) : null}
                            {current?.error ? (
                                <div className="mx-5 mt-3 flex shrink-0 items-center gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300">
                                    <CircleAlert className="size-3.5 shrink-0" />
                                    <span className="font-medium">本集遇到问题</span>
                                    <span className="truncate text-rose-500/80 dark:text-rose-300/70" title={current.error}>{current.error}</span>
                                    <span className="ml-auto shrink-0 text-rose-500/80 dark:text-rose-300/70">{current.jobs.failed} 次失败 · 可在底部全部重试</span>
                                </div>
                            ) : null}

                            {/* 审阅/放行横幅：三类状态都来自流水线闸门真实运行态，无对应信号则不渲染 */}
                            {awaitingMedia ? (
                                <div data-studio-banner="awaiting-media" className="mx-5 mt-3 flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
                                    <Clapperboard className="size-3.5 shrink-0" />
                                    <span className="font-medium">本集剧本与镜头已就绪，等待媒体放行</span>
                                    <span className="text-amber-700/80 dark:text-amber-200/70">手动放行模式下参考图闸门还未放行；确认素材已就绪后放行，流水线继续生成本集视频。</span>
                                    <button
                                        type="button"
                                        disabled={paused || bannerBusy !== null}
                                        title={paused ? "已暂停，继续后可生成" : undefined}
                                        onClick={() => void handleBannerReleaseMedia()}
                                        className="ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] text-primary-foreground hover:opacity-90 disabled:opacity-50"
                                    >
                                        {bannerBusy === "release" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                                        生成本集视频
                                    </button>
                                </div>
                            ) : null}
                            {reviewing ? (
                                <div data-studio-banner="reviewing" className="mx-5 mt-3 flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] text-sky-800 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">
                                    <CheckCheck className="size-3.5 shrink-0" />
                                    <div className="min-w-0 flex-1">
                                        <div className="font-medium">{sampleReview ? "样片已完成，确认画风与角色形象" : "本集视频提示词已就绪，等待你的确认"}</div>
                                        <div className="text-sky-700/80 dark:text-sky-200/70">{sampleReview ? "在成片页看样片；满意后确认，其余各集继续全自动推进。" : "核对各段提示词与参考图；确认后按剧情段顺序生成视频。"}</div>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={paused || bannerBusy !== null}
                                        title={paused ? "已暂停，继续后可生成" : undefined}
                                        onClick={() => void handleBannerApprove()}
                                        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] text-primary-foreground hover:opacity-90 disabled:opacity-50"
                                    >
                                        {bannerBusy === "approve" ? <LoaderCircle className="size-3.5 animate-spin" /> : <CheckCheck className="size-3.5" />}
                                        {sampleReview ? "确认样片，继续全剧" : "确认，生成视频"}
                                    </button>
                                </div>
                            ) : null}
                            {sampleWaiting && firstEpisode ? (
                                <div data-studio-banner="sample-waiting" className="mx-5 mt-3 flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[11px] text-muted-foreground">
                                    <div className="min-w-0 flex-1">
                                        <div className="font-medium text-foreground">剧本已就绪，等待样片确认</div>
                                        <div>第 1 集样片确认后，本集会按剧情段顺序生成视频。</div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => selectEpisode(firstEpisode)}
                                        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] hover:bg-muted/60"
                                    >
                                        去看样片
                                    </button>
                                </div>
                            ) : null}

                            {detailLoading ? (
                                <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
                                    <LoaderCircle className="size-4 animate-spin" /> 加载制作稿…
                                </div>
                            ) : !current ? (
                                // 影策 detail.tsx: !episodes.length → StudioGenesis；没有剧目时才退回空态兜底。
                                dramaId ? (
                                    <Suspense fallback={<TabChunkFallback />}><StudioGenesis
                                        productionState={productionState}
                                        paused={paused}
                                        chapterTruth={sourceChapterTruth}
                                        bibleReady={bibleReady}
                                        episodeCount={episodes.length}
                                        firstSampleReady={firstSampleReady}
                                    /></Suspense>
                                ) : (
                                    <EmptyState
                                        icon={<Film className="size-9 text-muted-foreground/40" />}
                                        title="还没有剧集"
                                        description="在左侧点击「添加第一集」开始，或先到剧目列表创建一个短剧。"
                                    />
                                )
                            ) : (
                                <StudioDetailPanel
                                    tab={detailTab}
                                    episode={current}
                                    production={production}
                                    assetNames={detailAssetNames}
                                    clipMedia={clipMedia}
                                    clipFailureByTarget={clipFailureByTarget}
                                    dramaId={dramaId}
                                    busy={Boolean(busy)}
                                    paused={paused}
                                    onAutoResume={resumeIfPaused}
                                    processJobs={processJobs}
                                    onDiscussShot={discussShotWithDirector}
                                    onRescript={() => void (async () => {
                                        const rescriptId = current.id;
                                        markRescripting(rescriptId, true);
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
                                                instruction = instruction ? `${instruction}\n${beatText}`.slice(0, 1200) : beatText.slice(0, 1200);
                                            }
                                            // 分镜规则软约束：单集时长/对白密度/转场/节奏并入改编指令（手动改编也读到设置）。
                                            const ruleBits: string[] = [];
                                            if (studioSettings.episodeSeconds) ruleBits.push(`本集约 ${studioSettings.episodeSeconds} 秒`);
                                            if (studioSettings.dialogueDensity !== "standard") ruleBits.push(`对白${{ dense: "密集", restrained: "克制", custom: "按需" }[studioSettings.dialogueDensity] || ""}`);
                                            if (studioSettings.transitionMode !== "smart") ruleBits.push(`转场${{ hard: "硬切", fade: "黑场过渡", flash: "闪白" }[studioSettings.transitionMode] || ""}`);
                                            if (studioSettings.pacing !== "标准") ruleBits.push(`节奏${studioSettings.pacing}`);
                                            if (ruleBits.length) {
                                                const ruleText = `分镜要求：${ruleBits.join("，")}。`;
                                                instruction = instruction ? `${instruction}\n${ruleText}`.slice(0, 1200) : ruleText.slice(0, 1200);
                                            }
                                            const planEffort = studioSettings.textThinking.plan;
                                            const finalInstruction = planEffort && planEffort !== "auto"
                                                ? (instruction ? `请以 ${planEffort} 的思考深度规划。\n${instruction}` : `请以 ${planEffort} 的思考深度规划。`).slice(0, 1200)
                                                : instruction;
                                            // 文字模型设置随重编下发后端：重编即用当前设置（尤其 hermes），不再读 start 时的旧内存 options。
                                            const rescriptOptions = {
                                                planModel: studioSettings.planModel,
                                                storyboardModel: studioSettings.storyboardModel,
                                                extractModel: studioSettings.assetExtractModel,
                                                videoPromptModel: studioSettings.videoPromptModel,
                                                textThinking: studioSettings.textThinking,
                                                textSkills: studioSettings.textSkills,
                                                storyboardRules: {
                                                    episodeSeconds: studioSettings.episodeSeconds, segmentMode: studioSettings.segmentMode,
                                                    segmentRange: studioSettings.segmentRange, dialogueDensity: studioSettings.dialogueDensity,
                                                    transitionMode: studioSettings.transitionMode, transitionMs: studioSettings.transitionMs, pacing: studioSettings.pacing,
                                                },
                                            };
                                            const done = await runRescript(current.id, finalInstruction, studioSettings.planModel || undefined, rescriptOptions);
                                            const how = skillRef || beats.length
                                                ? `已按${skillRef ? `写作技能「${skillRef.title}」` : ""}${skillRef && beats.length ? "与" : ""}${beats.length ? "钩子/悬念设置" : ""}`
                                                : "已";
                                            message.success(done ? `${how}重新改编本集，分镜已重拆并同步画布` : "已提交重新改编，分镜正在后台重拆，完成后请刷新查看");
                                        } catch (error) {
                                            message.error(`改编失败：${(error as Error).message}`);
                                        } finally { markRescripting(rescriptId, false); }
                                    })()}
                                    rescripting={rescriptingIds.has(current.id)}
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
                                    onExportJianying={() => openJianyingModal()}
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
                                    onSaveSegmentPrompt={(segmentId, text) => data.saveSegmentPrompt(current.id, segmentId, text, true)}
                                    onListSegmentVersions={(segmentId) => data.listSegmentVideoVersions(current.id, segmentId)}
                                    onSetSegmentCurrentVideo={(segmentId, version) => data.setSegmentCurrentVideo(current.id, segmentId, version)}
                                    onListSegmentVideoModels={() => data.listSegmentVideoModels(current.id)}
                                    onSetSegmentVideoModel={(segmentId, model) => data.setSegmentVideoModel(current.id, segmentId, model)}
                                    onApproveVideo={handleApproveVideo}
                                    onSwitchToAssets={() => { setAssetsInitialSub("audit"); setAssetsFocus(null); setTopTab("项目资产"); }}
                                    onChanged={() => void refreshAll()}
                                />
                            )}
                        </>
                    ) : topTab === "项目资产" ? (
                        <Suspense fallback={<TabChunkFallback />}><StudioAssetsTab
                            dramaId={dramaId}
                            sharedAssetCanvasId={String((currentFolder as Record<string, unknown> | null)?.sharedAssetCanvasId || "") || null}
                            artStyle={String(((currentFolder?.productionPlan as Record<string, unknown> | undefined)?.topic as Record<string, unknown> | undefined)?.artStyle || "")}
                            episodes={episodes}
                            loading={loading}
                            onOpenCanvas={openInCanvas}
                            onOpenSharedCanvas={openSharedCanvas}
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
                            initialKind={assetsInitialKind}
                            focusAsset={assetsFocus}
                            onOpenSegment={(episodeId, segmentId) => openSegmentFor(episodeId, segmentId)}
                            onOpenCast={openAssetSettings}
                        /></Suspense>
                    ) : topTab === "待处理" ? (
                        <Suspense fallback={<TabChunkFallback />}><StudioInboxTab
                            inbox={inbox}
                            episodes={episodes}
                            loading={loading || detailLoading}
                            busy={Boolean(busy)}
                            onOpenEpisode={(id) => openEpisodeWorkspace(id, "shots")}
                            onReview={(id) => openEpisodeWorkspace(id, "shots")}
                            onOpenSettings={() => setTopTab("设置")}
                            onStartVideo={() => void handlePipelineStart()}
                            onRetryAll={() => void handleRetryAll()}
                            onRetryJobs={(jobIds) => void handleRetryJobs(jobIds)}
                            onReleaseMedia={handleReleaseMedia}
                            onOpenAssets={openAssetsFor}
                            onOpenSegment={openSegmentFor}
                        /></Suspense>
                    ) : (
                        <Suspense fallback={<TabChunkFallback />}><StudioSettingsTab
                            dramaId={dramaId}
                            settings={studioSettings}
                            onChange={setStudioSettings}
                            onSave={saveStudioSettings}
                            onReset={() => setStudioSettings(loadStudioSettings(dramaId))}
                            saving={savingSettings}
                            studioInfo={studioInfo}
                            onRedoRefs={(kind) => { setAssetsInitialSub("library"); setAssetsInitialKind(kind); setTopTab("项目资产"); }}
                            onEpisodesChanged={refreshAll}
                            onPlanningChanged={async () => {
                                if (!dramaId) return;
                                const res = await fetchDramaPlanningState(dramaId);
                                setPlanningState({
                                    planDone: Boolean(res.planDone), planCursor: Number(res.planCursor || 0), lastChapterIndex: Number(res.lastChapterIndex || 0),
                                });
                            }}
                        /></Suspense>
                    )}
                </section>
            </div>

            {/* 底部任务队列栏 */}
            <div className="relative shrink-0 border-t border-border bg-card/40" data-studio-queue-bar>
                {/* 展开区在底部汇总条上方 in-flow 占位（影策 queue-bar 同款）：不再用 absolute 浮层盖住画布内容。 */}
                {queueOpen ? (
                    <div className="border-b border-border px-2 pb-2 pt-2" data-studio-queue-panel id="studio-queue-panel">
                        <div className="mb-1.5 flex h-[26px] items-center gap-1.5" role="tablist" aria-label="队列筛选">
                            {(["all", "active", "failed"] as const).map((key) => (
                                <button key={key} type="button" role="tab" aria-selected={queueFilter === key}
                                    onClick={() => setQueueFilter(key)}
                                    className={cn("h-[26px] rounded-full px-3 !text-[11px] leading-none transition",
                                        queueFilter === key ? "bg-foreground/[0.08] font-medium text-foreground" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground")}>
                                    {key === "all" ? "全部" : key === "active" ? "进行中" : "失败"}
                                </button>
                            ))}
                            <span className="ml-auto truncate text-[11px] text-muted-foreground">点击任一行查看作业详情</span>
                        </div>
                        {/* 影策：7 列 grid + 34px 行高 + 11px 字号 + 圆角 8 / hover 底色；列表 max-h 280（约 8 行）。 */}
                        <div className="max-h-[280px] overflow-y-auto overflow-x-hidden thin-scrollbar" role="list" data-studio-queue-list>
                            {filteredQueue.map((job) => {
                                const rowTone = ["succeeded", "success", "done", "completed"].includes(job.status)
                                    ? "text-emerald-500"
                                    : ["queued", "waiting", "pending"].includes(job.status)
                                        ? "text-amber-500"
                                        : ["running", "checking", "compiling", "applying"].includes(job.status)
                                            ? "text-foreground"
                                            : "text-rose-500";
                                // 只有真实排队（后端写入了 waitReason）才替换状态文案；错误码先本地化。
                                const waitNote = job.status === "queued" && job.waitReason ? job.waitReason : "";
                                const jobError = localizeJobText(job.error);
                                const statusText = waitNote || jobError || jobStatusText(job.status);
                                const statusTitle = jobError || waitNote || jobStatusText(job.status);
                                const timeValue = job.startedAt || job.createdAt || job.finishedAt;
                                const timeTitle = [
                                    job.createdAt ? `加入 ${formatJobTime(job.createdAt)}` : "",
                                    job.startedAt ? `开始 ${formatJobTime(job.startedAt)}` : "",
                                    job.finishedAt ? `结束 ${formatJobTime(job.finishedAt)}` : "",
                                    typeof job.durationMs === "number" ? `用时 ${formatJobDuration(job.durationMs)}` : "",
                                ].filter(Boolean).join(" · ");
                                return (
                                    <button key={job.id} type="button" role="listitem"
                                        onClick={() => setQueueDetail({
                                            id: job.id, title: job.title, error: job.error, prompt: job.prompt, status: job.status,
                                            episodeId: job.episodeId, kind: job.kind, createdAt: job.createdAt,
                                            startedAt: job.startedAt, finishedAt: job.finishedAt, durationMs: job.durationMs,
                                            runtimeTaskId: job.runtimeTaskId, attempt: job.attempt,
                                            attempts: job.attempts,
                                            ...(job.waitReason ? { waitReason: job.waitReason } : {}),
                                        })}
                                        className="grid h-[34px] w-full grid-cols-[16px_72px_1.1fr_2fr_64px_72px_14px] items-center gap-2 rounded-[8px] px-2 text-left !text-[11px] leading-none text-muted-foreground transition hover:bg-foreground/[0.04]"
                                        title={job.title}
                                        data-studio-queue-row={job.id}
                                    >
                                        <JobStatusIcon status={job.status} className="size-4 shrink-0" />
                                        <span className="truncate">{job.kind ? (JOB_KIND_LABEL[job.kind] || job.kind) : "—"}</span>
                                        {/* 影策 queue-bar.tsx:89-92：完整标题走 title，窄列只显示省略文本。 */}
                                        <span className="truncate text-foreground/90" title={job.title}>{job.title}</span>
                                        <span className={cn("truncate", rowTone)} title={statusTitle}>{statusText}</span>
                                        {/* 时间列：优先 startedAt，其次 createdAt；后端按作业补的 durationMs 放 title。 */}
                                        <span className="truncate tabular-nums text-muted-foreground/70" title={timeTitle || "后端未提供该作业时间"}>{formatJobClock(timeValue)}</span>
                                        {/* 花费列：后端没有按作业计费字段，displayed 为「—」，不写 0。 */}
                                        <span className="truncate text-muted-foreground/50" title="后端暂未提供按作业计费字段">—</span>
                                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
                                    </button>
                                );
                            })}
                            {!filteredQueue.length ? (
                                <div className="py-2 text-center text-[11px] text-muted-foreground">
                                    {queueFilter === "failed" ? "没有失败的工作" : queueFilter === "active" ? "没有进行中的工作" : "还没有调度记录"}
                                </div>
                            ) : null}
                        </div>
                    </div>
                ) : null}
                {/* 影策 .drama-queue-bar：padding 0 8 0 16 / 高 42 / gap 16；统计靠左、预算与展开按钮靠右。
                    pr-28 给右侧固定「导演」浮钮留位：浮钮 86×40 在视口右下，之前正好压住队列开关导致点不开。 */}
                <div className="flex h-[42px] items-center gap-4 overflow-x-auto pl-4 pr-28 text-[11px] tabular-nums thin-scrollbar">
                    {(() => {
                        // 统计与队列列表同源：把流水线阶段作业一并计入，避免列表有「运行中」顶部却写 0。
                        const pj = pipeline?.jobs || [];
                        const pjRunning = pj.filter((j) => ["running", "checking", "compiling", "applying"].includes(String(j.status || ""))).length;
                        const pjQueued = pj.filter((j) => ["queued", "waiting", "pending"].includes(String(j.status || ""))).length;
                        const pjDone = pj.filter((j) => ["succeeded", "success", "done", "completed"].includes(String(j.status || ""))).length;
                        const running = jobCounts.running + queue.running + pjRunning;
                        const queued = queue.queued + pjQueued;
                        const done = jobCounts.succeeded + pjDone;
                        return (
                            <div className="flex shrink-0 items-center gap-4">
                                <span className="flex items-center gap-2 text-muted-foreground">{running > 0 ? <LoaderCircle className="size-3.5 animate-spin" /> : <span className="size-3.5 rounded-full bg-muted-foreground/40" />} 运行中 <b className="font-semibold text-foreground">{running}</b></span>
                                <span className="flex items-center gap-2 text-muted-foreground"> 排队 <b className="font-semibold text-foreground">{queued}</b></span>
                                <span className="flex items-center gap-2 text-muted-foreground"> 已完成 <b className="font-semibold text-foreground">{done}</b></span>
                            </div>
                        );
                    })()}
                    {/* 待重试要把流水线失败作业算进去：待处理页已显示 pipeline.jobs 失败项，
                        这里若只算日志/批次会与待处理页数字打架。三处口径统一：日志失败 + 批次重试 + 流水线失败。 */}
                    {jobCounts.failed + queue.retry + pipelineRetryableCount > 0 ? (
                        <>
                            <span className="flex items-center gap-2 text-rose-600"><CircleAlert className="size-3.5" /> 待重试 <b className="font-semibold">{jobCounts.failed + queue.retry + pipelineRetryableCount}</b></span>
                            <button
                                type="button"
                                onClick={handleRetryAll}
                                disabled={busy === "retry"}
                                className="inline-flex h-6 items-center rounded px-1.5 font-medium text-foreground underline-offset-2 hover:bg-foreground/5 hover:underline disabled:opacity-60"
                            >
                                {busy === "retry" ? "重试中…" : "全部重试"}
                            </button>
                        </>
                    ) : null}
                    <div className="ml-auto flex shrink-0 items-center gap-4 text-muted-foreground">
                        {(() => {
                            const b = pipeline?.budget;
                            if (!b) return null;
                            const limit = Number(b.limitMicrocredits || 0);
                            const spent = Number(b.spentMicrocredits || 0);
                            const usage = limit > 0 ? Math.min(1, spent / limit) : 0;
                            return (
                                <span className="flex items-center gap-2 text-muted-foreground" title="运行期预算（后端 status.budget 真值）">
                                    {limit > 0 ? <span className="inline-block h-1.5 w-12 overflow-hidden rounded-full bg-muted"><span className={cn("block h-full rounded-full", usage >= 0.9 ? "bg-rose-500" : "bg-emerald-500")} style={{ width: `${Math.max(usage * 100, spent ? 3 : 0)}%` }} /></span> : null}
                                    已用 <b className="font-semibold text-foreground">{spent}</b> 积分
                                    {limit > 0 ? <> / {limit} 积分</> : <> · 不限预算</>}
                                </span>
                            );
                        })()}
                        <span>{assets.length} 项资产 · {inbox.length} 项待处理</span>
                        <button type="button" onClick={() => setQueueOpen((o) => !o)} data-studio-queue-toggle
                            aria-expanded={queueOpen} aria-controls="studio-queue-panel"
                            className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 hover:bg-foreground/5 hover:text-foreground">
                            {queueOpen ? "收起队列" : "展开队列"}
                            <ChevronDown className={cn("size-3.5 transition", queueOpen && "rotate-180")} />
                        </button>
                    </div>
                </div>
            </div>

            {/* #2 导出剪映草稿预检：真预检 API 的三分类清单 + 跳过勾选 */}
            <Modal
                title={current ? `导出剪映草稿 · ${current.title}` : "导出剪映草稿"}
                open={jianyingOpen}
                onCancel={() => setJianyingOpen(false)}
                width={720}
                destroyOnClose
                footer={
                    <div className="flex items-center gap-2">
                        <span className="flex-1" />
                        <button type="button" onClick={() => setJianyingOpen(false)} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted">{jianyingRequested ? "关闭" : "取消"}</button>
                        {jianyingRequested ? (
                            <button type="button" onClick={() => void runJianyingPrecheck()} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted">未收到下载，重新检查</button>
                        ) : jianyingPreview ? (
                            <>
                                <button type="button" disabled={jianyingLoading} onClick={() => void runJianyingPrecheck()} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50">重新检查</button>
                                <button type="button" disabled={jianyingLoading || busy === "export" || Boolean(jianyingRootProblem(jianyingRoot))} onClick={() => void confirmJianying()} className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50">{busy === "export" ? "导出中…" : "确认并请求下载"}</button>
                            </>
                        ) : (
                            <button type="button" disabled={jianyingLoading || Boolean(jianyingRootProblem(jianyingRoot))} onClick={() => void runJianyingPrecheck()} className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50">{jianyingLoading ? "检查中…" : "检查导出内容"}</button>
                        )}
                    </div>
                }
            >
                <div className="space-y-3 py-1 text-xs" data-studio-jianying-precheck>
                    <p className="text-muted-foreground">① 填写草稿目录与字幕 → ② 点「检查导出内容」→ ③ 确认并请求下载。逐段核对真实结果文件与媒体元数据：可用段必须同时具备当前结果、可用媒体、有效时长并可读取首字节；旧版本是可用段的子集。预检 revision 是内容指纹，下载链路仍是原有前端 ZIP 构建，下载时无法再做 revision 复核。</p>
                    {jianyingError ? <p className="text-[11px] text-rose-500" role="alert" data-studio-jianying-error>{jianyingError}</p> : null}
                    <label className="block space-y-1">
                        <span className="font-medium">本机剪映草稿目录</span>
                        <Input value={jianyingRoot} spellCheck={false} aria-label="本机剪映草稿目录" status={jianyingRootProblem(jianyingRoot) ? "warning" : undefined} onChange={(e) => {
                            setJianyingRoot(e.target.value);
                            invalidateJianying();
                            try { localStorage.setItem("drama-studio:jianying-root", e.target.value); } catch { /* 隐私模式忽略 */ }
                        }} />
                        <span className="text-[11px] text-muted-foreground">{jianyingRootProblem(jianyingRoot) || "此路径会写进导出的草稿配置；本地导出不会访问你的电脑。"}</span>
                    </label>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => setJianyingRoot(JIANYING_ROOT_WIN)} className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted">Windows 路径示例</button>
                        <button type="button" onClick={() => setJianyingRoot(JIANYING_ROOT_MAC)} className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted">macOS 路径示例</button>
                        <button type="button" aria-label="清空草稿目录" onClick={() => setJianyingRoot("")} className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"><X className="size-3" /></button>
                    </div>
                    <Checkbox checked={jianyingCaptions} onChange={(e) => { setJianyingCaptions(e.target.checked); invalidateJianying(); }}>附带台词字幕轨及 SRT（分镜估时，导入后需核对；取消勾选将从包内移除 subtitles/）</Checkbox>
                    {jianyingRequested ? <p className="text-[11px] text-emerald-600" role="status">已提交下载请求。请在浏览器下载列表确认进度与最终结果；页面无法确认文件已下载完成，可关闭此窗口。</p> : null}
                    {jianyingLoading ? <p className="text-[11px] text-muted-foreground">正在逐段核对结果文件与媒体元数据…</p> : null}
                    {jianyingPreview ? (
                        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2" data-studio-jianying-readiness>
                            <strong>可用 {jianyingReady} / {jianyingPreview.totalSegments} 段 · 缺失 {jianyingMissing} · 旧版本 {jianyingStale}（含在可用内）</strong>
                            <div className="text-[11px] text-muted-foreground">
                                预计时长 {Math.round(jianyingPreview.durationMs / 1000)} 秒 · 媒体 {(jianyingPreview.mediaBytes / 1024 / 1024).toFixed(1)} MB · 字幕 {jianyingPreview.captionCount} 条 · 指纹 <code>{jianyingPreview.revision.slice(0, 12)}</code>
                            </div>
                            {!jianyingReady ? <p className="text-rose-500">没有可导出的视频，请先生成或修复素材后重新检查。</p> : null}
                            {jianyingPreview.warnings.length ? (
                                <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-amber-600">
                                    {jianyingPreview.warnings.map((warning, i) => <li key={i}>{warning}</li>)}
                                </ul>
                            ) : (
                                <p className="text-[11px] text-muted-foreground">已检查所选视频的资源记录与读取状态。下载时仍会再次核对。</p>
                            )}
                            <details open={jianyingMissing > 0 || jianyingStale > 0}>
                                <summary className="cursor-pointer">查看剧情段清单</summary>
                                <ul className="mt-1 space-y-0.5 pl-4 text-[11px]">
                                    {jianyingSegments.map((s) => (
                                        <li key={s.index}>
                                            第 {s.index} 段 · {s.title}：{s.included ? (s.stale ? "可导出 · 旧版本" : "可导出") : `缺失 · ${s.reason || "不可用"}`}
                                            {s.included ? ` · ${Math.round(s.durationMs / 1000)} 秒${s.durationEstimated ? "（估时）" : ""}` : ""}
                                        </li>
                                    ))}
                                    {!jianyingSegments.length ? <li>本集没有可检查的剧情段。</li> : null}
                                </ul>
                            </details>
                            {jianyingMissing > 0 ? <Checkbox checked={jianyingSkipMissing} onChange={(e) => setJianyingSkipMissing(e.target.checked)}>确认跳过 {jianyingMissing} 个不可用剧情段，仅导出当前可用片段</Checkbox> : null}
                            {jianyingStale > 0 ? <Checkbox checked={jianyingSkipStale} onChange={(e) => setJianyingSkipStale(e.target.checked)}>确认使用 {jianyingStale} 个剧情段的旧版本视频</Checkbox> : null}
                        </div>
                    ) : null}
                    <ol className="list-decimal space-y-0.5 pl-5 text-[11px] text-muted-foreground">
                        <li>下载完成后关闭剪映，将 ZIP 解压到填写的目录；草稿文件夹直接放在该目录下，不要改名或多套一层。</li>
                        <li>重新打开剪映，尝试从草稿列表打开同名草稿；不同客户端版本可能不识别外部草稿。</li>
                        <li>若提示素材丢失，重新链接草稿内 materials 文件夹；若草稿无法识别，仍可按文件名顺序导入视频及台词字幕.srt。</li>
                    </ol>
                </div>
            </Modal>

            {/* #5 一键打包全部资产：多选剧集（全选/取消）+ 媒体/提示词选项 */}
            <Modal
                title="一键打包全部资产"
                open={packModalOpen}
                onCancel={() => setPackModalOpen(false)}
                width={640}
                destroyOnClose
                footer={
                    <div className="flex items-center gap-2">
                        <span className="mr-auto text-[11px] text-muted-foreground">已选 {packChosen.length} 集{packMedia ? ` · ${packChosen.reduce((sum, ep) => sum + ep.segmentCount, 0)} 个剧情段` : ""}</span>
                        <button type="button" onClick={() => setPackModalOpen(false)} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted">取消</button>
                        <button type="button" disabled={!packChosen.length || (!packMedia && !packPrompts) || Boolean(busy)} onClick={() => void exportPack(packChosen.map((ep) => ep.id), { media: packMedia, prompts: packPrompts })} className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50">{busy === "pack" ? "打包中…" : "确认打包"}</button>
                    </div>
                }
            >
                <div className="space-y-3 py-1 text-xs" data-studio-pack-modal>
                    <p className="text-muted-foreground">全剧设定随每集包一起导出；剧集仅已拆解分镜的可选。选中多集时下载一个包含各集 .mmxpack.zip 的总包。</p>
                    <div className="flex items-center gap-2">
                        <span className="font-medium">剧集</span>
                        <button type="button" disabled={!packSelectable.length} onClick={() => setPackPicked(packChosen.length === packSelectable.length ? new Set<string>() : new Set(packSelectable.map((ep) => ep.id)))} className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted">{packChosen.length === packSelectable.length && packSelectable.length ? "取消全选" : "全选"}</button>
                    </div>
                    <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                        {episodes.map((ep) => {
                            const disabled = ep.shotCount <= 0;
                            const selected = packSelected.has(ep.id) && !disabled;
                            return (
                                <button key={ep.id} type="button" disabled={disabled} title={disabled ? "还没有拆解分镜" : ep.title} onClick={() => {
                                    const next = new Set(packSelected);
                                    if (next.has(ep.id)) next.delete(ep.id); else next.add(ep.id);
                                    setPackPicked(next);
                                }} className={cn("rounded border px-2 py-1 text-[11px]", selected ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground hover:bg-muted", disabled && "opacity-40")}>
                                    第{String(ep.no).padStart(2, "0")}集
                                </button>
                            );
                        })}
                        {!episodes.length ? <p className="text-[11px] text-muted-foreground">还没有剧集。</p> : null}
                    </div>
                    <div className="space-y-1.5">
                        <Checkbox checked={packMedia} onChange={(e) => setPackMedia(e.target.checked)}>媒体文件：段参考图（按画布 H3 段 &lt;Picture N&gt; 顺序下载）与段级引用</Checkbox>
                        <Checkbox checked={packPrompts} onChange={(e) => setPackPrompts(e.target.checked)}>提示词：段视频提示词（画布 H3 优先，缺则取编译产物/镜头拼稿）与分镜画面结构（timeline.json）</Checkbox>
                    </div>
                    <p className="text-[11px] text-muted-foreground">包内 timeline.json / pack.json 记录真实分镜结构与提示词，可在其他作品里用「导入资产包」套用；导出不消耗积分。当前导演包不含角色声音样本、剧情段视频与成片文件，也不单独生成设定参考图 MD / 镜头运动 MD——这些请用顶栏「导出交付包（成片+SRT+提示词）」或剪映草稿导出。</p>
                </div>
            </Modal>

            {/* #6 导入资产包：先预览真实 plan（从包内容算出）再确认写入 + 可配置选项 */}
            <Modal
                title="导入资产包"
                open={importModalOpen}
                onCancel={() => { if (!busy) { setImportModalOpen(false); setImportPack(null); } }}
                width={680}
                destroyOnClose
                footer={
                    <div className="flex items-center gap-2">
                        <button type="button" disabled={Boolean(busy)} onClick={() => { setImportModalOpen(false); setImportPack(null); }} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted">取消</button>
                        <button type="button" disabled={!importPlan || (!importRefs && !importPrompts) || Boolean(busy)} onClick={() => void confirmImportPack()} className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50">{busy === "import-pack" ? "导入中…" : "确认导入"}</button>
                    </div>
                }
            >
                <div className="space-y-3 py-1 text-xs" data-studio-import-plan>
                    <div className="flex items-start gap-2 rounded border border-border bg-muted/30 p-2">
                        <FileArchive className="mt-0.5 size-5 shrink-0" />
                        <div className="min-w-0">
                            <strong className="block truncate" title={importFileName}>{importFileName}</strong>
                            <span className="text-[11px] text-muted-foreground">来自「{importPlan?.title || "—"}」 · {importPlan?.segmentCount ?? 0} 段 · {importPlan?.imageCount ?? 0} 张参考图</span>
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <Checkbox checked={importRefs} disabled={Boolean(busy)} onChange={(e) => setImportRefs(e.target.checked)}>参考图：把包内图片写入资产库（每图一条，带本集与段号标签）</Checkbox>
                        <Checkbox checked={importPrompts} disabled={Boolean(busy)} onChange={(e) => setImportPrompts(e.target.checked)}>剧情段提示词与分镜：写入当前集「{current?.title || "—"}」的制作稿并上画布</Checkbox>
                    </div>
                    <div className="rounded border border-border bg-muted/30 p-2" role="status">
                        <strong>将导入：参考图 {importRefs ? importPlan?.imageCount ?? 0 : 0} 张 · 段提示词 {importPrompts ? importPlan?.withPrompt ?? 0 : 0} 段</strong>
                        <p className="mt-1 text-[11px] text-muted-foreground">包内共 {importPlan?.segmentCount ?? 0} 段，其中 {importPlan?.skipped ?? 0} 段没有提示词，将被跳过；已生成的视频不会自动重做。</p>
                    </div>
                </div>
            </Modal>

            {chapterPickerOpen ? <Suspense fallback={null}>
                <StudioChapterPickerModal
                    folder={currentFolder || null}
                    episodes={rawEpisodes}
                    open={chapterPickerOpen}
                    onClose={() => setChapterPickerOpen(false)}
                    onDone={refreshAll}
                    onProduced={(ids) => Promise.all(ids.map((id) => adaptEpisode(id))).then(() => undefined)}
                />
            </Suspense> : null}

            {/* 版本记录与对比：真版本对比弹窗，版本列表与 diff 全部由 version-compare API 派生 */}
            {versionCompareOpen ? <Suspense fallback={null}>
                <StudioVersionCompare
                    open={versionCompareOpen}
                    onClose={() => setVersionCompareOpen(false)}
                    episodeId={current?.id || ""}
                    episodeTitle={current?.title}
                    dramaId={dramaId || undefined}
                />
            </Suspense> : null}

            {/* 队列任务详情（对齐影策 JobDetailModal：复制错误信息 / 复制提示词） */}
            <Modal
                title={queueDetail?.title || "任务详情"}
                open={Boolean(queueDetail)}
                onCancel={() => setQueueDetail(null)}
                footer={null}
                width={760}
                destroyOnClose
            >
                {queueDetail ? (
                    <div className="space-y-3 py-2" data-studio-queue-detail>
                        <div className="flex items-center gap-2">
                            <JobStatusIcon status={queueDetail.status || ""} />
                            <div className="text-[11px] text-muted-foreground">状态：{jobStatusText(queueDetail.status)}</div>
                            {queueDetail.episodeId ? (
                                <button type="button" onClick={() => { openEpisodeWorkspace(queueDetail.episodeId!, "shots"); setQueueDetail(null); }}
                                    className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted" data-studio-queue-locate>
                                    <Crosshair className="size-3" /> 定位到镜头
                                </button>
                            ) : null}
                        </div>
                        {queueDetail.waitReason ? (
                            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-400" data-studio-queue-wait-reason>
                                排队原因：{queueDetail.waitReason}
                            </div>
                        ) : null}
                        {/* facts 全部来自该作业自身字段（后端已补 createdAt/startedAt/finishedAt/durationMs），
                            不再把整集日志跨度当成本作业用时；关联不到就是「—」。 */}
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-border bg-muted/30 p-2.5 text-[11px]" data-studio-queue-facts>
                            <div><span className="text-muted-foreground">任务类型：</span>{queueDetail.kind || "—"}</div>
                            <div><span className="text-muted-foreground">加入队列：</span>{formatJobTime(queueFacts.joined)}</div>
                            <div><span className="text-muted-foreground">开始：</span>{formatJobTime(queueFacts.started)}</div>
                            <div><span className="text-muted-foreground">结束：</span>{formatJobTime(queueFacts.ended)}</div>
                            <div><span className="text-muted-foreground">用时：</span>{queueFacts.elapsed}</div>
                            <div><span className="text-muted-foreground">尝试次数：</span>{queueFacts.attempts === null ? "—" : queueFacts.attempts >= 100 ? `${queueFacts.attempts}+ 次（日志上限）` : `${queueFacts.attempts} 次`}</div>
                            <div className="col-span-2 text-[11px] text-muted-foreground">
                                作业标识：<code>{queueDetail.id}</code>
                                {queueDetail.runtimeTaskId ? <> · runtimeTaskId <code>{queueDetail.runtimeTaskId}</code></> : <> · 后端未提供 runtimeTaskId</>}
                            </div>
                        </div>
                        <div>
                            <div className="mb-1 flex items-center justify-between text-xs font-medium">
                                <span>错误信息</span>
                                <button type="button" onClick={() => void navigator.clipboard.writeText(queueDetail.error || "").then(() => message.success("已复制错误信息"))}
                                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"><Copy className="size-3" /> 复制错误信息</button>
                            </div>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-relaxed">{localizeJobText(queueDetail.error) || "无错误信息"}</pre>
                        </div>
                        {/* 尝试记录：后端 attempts_json 的逐次真值（失败/熔断/成功各一条），回答「重试到上限前几次为什么失败」。
                            与下方按 generation_logs 关联的「请求记录」区分：那是 provider 请求日志，这里只讲本作业每一轮的结果。 */}
                        <div data-studio-queue-try-log>
                            <div className="mb-1 flex items-baseline gap-2 text-xs font-medium">
                                <span>尝试记录</span>
                                <span className="text-[11px] font-normal text-muted-foreground">本作业每一轮的结果与时间（最多留最近 20 条）。</span>
                                {(queueDetail.attempt || 0) > queueDetailAttempts.length ? (
                                    <span className="text-[11px] font-normal text-amber-500" data-studio-queue-try-partial>共尝试 {queueDetail.attempt} 次，只有 {queueDetailAttempts.length} 条逐次记录（更早的失败未被采集）</span>
                                ) : null}
                            </div>
                            {queueDetailAttempts.length ? (
                                <div className="max-h-48 space-y-1 overflow-y-auto">
                                    {queueDetailAttempts.map((record, i) => {
                                        // 第 N 次：失败记录带 DB 的 attempt 真值；成功记录未记 attempt，按总数回推该轮序号。
                                        const order = typeof record.attempt === "number" && record.attempt > 0
                                            ? record.attempt
                                            : queueDetailAttempts.length - i;
                                        const resultSummary = attemptResultSummary(record.result);
                                        return (
                                            <div key={`${record.at || "na"}-${i}`} className="flex items-baseline gap-2 rounded border border-border bg-muted/30 px-2 py-1 text-[11px]" data-studio-queue-try>
                                                <span className="shrink-0 font-medium">第 {order} 次</span>
                                                {record.error ? (
                                                    <span className="min-w-0 truncate text-rose-400" title={record.error}>{localizeJobText(record.error)}</span>
                                                ) : (
                                                    <span className="min-w-0 truncate text-emerald-500" title={resultSummary || "成功"}>成功{resultSummary ? ` · ${resultSummary}` : ""}</span>
                                                )}
                                                <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">{formatJobTime(record.at)}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="rounded border border-dashed border-border px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground" data-studio-queue-try-empty>
                                    该作业没有逐次记录（历史数据未采集），只有最终错误。
                                </div>
                            )}
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
                        {queueLogScope === "job" ? (
                            <div data-studio-queue-attempts>
                                <div className="mb-1 flex items-baseline gap-2 text-xs font-medium">
                                    <span>请求记录</span>
                                    <span className="text-[11px] font-normal text-muted-foreground">只列该 runtimeTaskId 的请求记录（生成日志口径），用时与尝试次数取自本作业。</span>
                                </div>
                                {queueAttemptsLoading ? (
                                    <p className="text-[11px] text-muted-foreground">正在读取请求记录…</p>
                                ) : queueAttempts && queueAttempts.length ? (
                                    <div className="max-h-48 space-y-1.5 overflow-y-auto">
                                        {queueAttempts.map((log, i) => (
                                            <div key={log.id} className="rounded border border-border bg-muted/30 px-2 py-1.5 text-[11px]">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-medium">第 {queueAttempts.length - i} 次</span>
                                                    <span className={log.status === "success" ? "text-emerald-500" : log.status === "failed" ? "text-rose-500" : "text-amber-500"}>{jobStatusText(log.status)}</span>
                                                    <span className="text-muted-foreground">{log.taskMode || log.platform}</span>
                                                    <span className="ml-auto text-[10px] text-muted-foreground">{log.startedAt ? new Date(log.startedAt).toLocaleString("zh-CN") : ""}</span>
                                                </div>
                                                <div className="mt-0.5 text-[10px] text-muted-foreground">{log.model || "—"}{log.runtimeTaskId ? ` · task ${log.runtimeTaskId.slice(0, 16)}…` : ""}</div>
                                                {/* A6 生成依据回执：全部取自本条日志真实字段，没有的真值不臆造。 */}
                                                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground" data-studio-queue-receipt>
                                                    {log.model ? <span>模型 <span className="text-foreground/80">{log.model}</span></span> : null}
                                                    {Object.keys(log.inputCounts || {}).length ? (
                                                        <span>实发 {Object.entries(log.inputCounts).map(([k, v]) => `${GENERATION_PARAM_LABEL[k] || k} ${v}`).join(" / ")}</span>
                                                    ) : null}
                                                    {Array.isArray(log.references) && log.references.length ? <span>附图 {log.references.length}</span> : null}
                                                    {typeof log.durationMs === "number" && log.durationMs > 0 ? <span>耗时 {(log.durationMs / 1000).toFixed(1)}s</span> : null}
                                                    <span>提示词 {log.prompt ? <span className="text-emerald-500/80">已记录</span> : <span className="text-amber-500/80">无</span>}</span>
                                                </div>
                                                {log.error ? <div className="mt-0.5 truncate text-[10px] text-rose-400" title={log.error}>{localizeJobText(log.error)}</div> : null}
                                                <div className="mt-1.5 border-t border-border pt-1.5" data-studio-queue-result>
                                                    <div className="mb-1 text-[11px] font-medium">生成结果</div>
                                                    <GenerationOutputs outputs={Array.isArray(log.outputs) ? log.outputs : []} />
                                                </div>
                                                <div className="mt-1.5 border-t border-border pt-1.5" data-studio-queue-params>
                                                    <div className="mb-1 text-[11px] font-medium">请求参数</div>
                                                    {log.params && Object.keys(log.params).length ? (
                                                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                                                            {Object.entries(log.params).map(([key, value]) => (
                                                                <div key={key} className="flex justify-between gap-2 text-[10px]">
                                                                    <span className="shrink-0 text-muted-foreground">{GENERATION_PARAM_LABEL[key] || key}</span>
                                                                    <span className="truncate text-right" title={formatParamValue(value)}>{formatParamValue(value)}</span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    ) : <span className="text-[11px] text-muted-foreground">无</span>}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="text-[11px] text-muted-foreground">该作业暂无生成日志</p>
                                )}
                            </div>
                        ) : queueDetail ? (
                            <div className="rounded border border-dashed border-border px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground" data-studio-queue-attempts-empty>
                                该作业没有可关联的 runtimeTaskId（后端流水线作业未下发），拿不到它自己的请求记录；这里不展示本集其它任务的历史日志。用时与尝试次数取自本作业自身。
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </Modal>
            {/* 建集/插集原文弹窗：对齐影策 AddEpisodeModal；原文与素材类型真实写入后端。 */}
            <Modal
                title={episodeDraft?.mode === "insert"
                    ? `在第 ${episodeDraft.no} 集${episodeDraft.position === "before" ? "前" : "后"}插入一集`
                    : `添加第 ${episodes.reduce((max, ep) => Math.max(max, ep.no), 0) + 1} 集`}
                open={Boolean(episodeDraft)}
                onCancel={() => { if (!busy) setEpisodeDraft(null); }}
                width={720}
                destroyOnClose
                footer={
                    <div className="flex items-center gap-2">
                        <span className={cn("mr-auto text-[11px]", episodeSourceCharCount > EPISODE_SOURCE_CHARS ? "text-rose-500" : "text-muted-foreground")} data-studio-episode-chars>
                            {episodeSourceCharCount} / {EPISODE_SOURCE_CHARS} 字{episodeSourceCharCount > EPISODE_SOURCE_CHARS ? " · 超出部分会丢台词，请拆成多集" : ""}
                        </span>
                        <button type="button" disabled={Boolean(busy)} onClick={() => setEpisodeDraft(null)} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted">取消</button>
                        <button type="button" disabled={Boolean(busy) || episodeSourceCharCount > EPISODE_SOURCE_CHARS} onClick={() => void submitEpisodeDraft()} className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50" data-studio-episode-submit>
                            {busy === "add" || busy === "insert" ? "提交中…" : (episodeDraft?.mode === "insert" ? "插入" : "添加")}
                        </button>
                    </div>
                }
            >
                <div className="space-y-3 py-1 text-xs" data-studio-episode-modal>
                    <p className="text-muted-foreground">一次只放这一集的内容，前面已做好的集不会受影响；素材类型与原文会真实保存到本集。</p>
                    <div className="flex items-end gap-3">
                        <label className="flex min-w-0 flex-1 flex-col gap-1">
                            <span className="font-medium">集标题</span>
                            <input value={episodeTitle} maxLength={60} placeholder="留空为自动生成" aria-label="集标题" data-studio-episode-title
                                onChange={(e) => setEpisodeTitle(e.target.value)}
                                className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" />
                        </label>
                        <label className="flex w-40 shrink-0 flex-col gap-1">
                            <span className="font-medium">素材类型</span>
                            <select value={episodeFormat} aria-label="素材类型" data-studio-episode-format
                                onChange={(e) => setEpisodeFormat(e.target.value as DramaSourceFormat)}
                                className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary">
                                <option value="novel">小说原文</option>
                                <option value="script">剧本</option>
                                <option value="storyboard">分镜</option>
                            </select>
                        </label>
                    </div>
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={() => episodeFileRef.current?.click()} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-muted" data-studio-episode-import>
                            <FileUp className="size-3.5" /> 从文件导入
                        </button>
                        <span className="text-[11px] text-muted-foreground">TXT / Markdown / CSV / TSV，单文件不超过 2MB</span>
                        <input ref={episodeFileRef} type="file" accept=".txt,.md,.markdown,.csv,.tsv,text/plain,text/markdown" className="hidden" data-studio-episode-file
                            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void importEpisodeFile(file); }} />
                    </div>
                    <textarea value={episodeText} rows={12} aria-label="本集原文" data-studio-episode-text
                        placeholder="在这里粘贴本集原文，也可以把 TXT / Markdown 文件拖进来…"
                        onChange={(e) => setEpisodeText(e.target.value)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files?.[0]; if (file) void importEpisodeFile(file); }}
                        className="w-full resize-y rounded-md border border-border bg-background p-2 text-xs leading-relaxed outline-none focus:border-primary" />
                </div>
            </Modal>

            {/* 删集确认：对齐影策 episode-delete-modal.tsx:65-88；客户端初判可快速确认，
                服务端 409 时动态切成输入「第 N 集」，以服务端 reasons 为准。 */}
            <Modal
                title={episodeDeleteDraft ? `删除第 ${episodeDeleteDraft.ep.no} 集？` : "删除分集"}
                open={Boolean(episodeDeleteDraft)}
                onCancel={() => { if (!busy) { setEpisodeDeleteDraft(null); setEpisodeDeleteTyped(""); } }}
                okText="删除本集"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onOk={confirmEpisodeDelete}
                width={520}
                destroyOnClose
            >
                {episodeDeleteDraft ? (
                    <div className="space-y-2 py-1 text-xs" data-studio-delete-confirm>
                        <p>「{episodeDeleteDraft.ep.title}」的剧本、分镜与剧情段会一并删除，后面各集的集号前移一位。本集原文退回「原著章节」，之后可以重新加入制作。</p>
                        {episodeDeleteDraft.needsTyped ? (
                            <>
                                <p className="text-rose-600" role="alert">
                                    本集{episodeDeleteDraft.reasons.join("、") || "已生成过分镜视频"}，删除后这些视频、成片与历史版本都无法恢复。请输入「{episodeDeleteDraft.confirmText}」确认删除。
                                </p>
                                <input autoFocus value={episodeDeleteTyped} placeholder={episodeDeleteDraft.confirmText} aria-label={`输入"${episodeDeleteDraft.confirmText}"确认删除`} data-studio-delete-typed
                                    onChange={(e) => setEpisodeDeleteTyped(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirmEpisodeDelete(); } }}
                                    className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" />
                                {episodeDeleteDraft.serverDriven ? (
                                    <p className="text-[11px] text-muted-foreground">服务端检测到本集有必须确认的内容，请输入上方文字后重试。</p>
                                ) : null}
                            </>
                        ) : null}
                    </div>
                ) : null}
            </Modal>
        </div>
    );
}
