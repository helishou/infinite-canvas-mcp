import { App } from "antd";
import { useMemo } from "react";
import {
    CircleAlert, Clock3, Eye, Play, Sparkles, TriangleAlert, Inbox, RotateCcw, Settings, Unlock,
    UserRound, Film,
} from "lucide-react";
import type { StudioInboxItem, StudioEpisode } from "./use-studio-data";

/**
 * 影策「待处理」页原生复刻（对照 project studio/inbox）。
 * 按真实语义分组为可操作卡片：剧本与分镜已就绪 / 视频提示词待审阅 / 失败 / 阶段缺口。
 * 顶部统计条显示「N 项失败 · M 集待审阅 · 共 K 类」。
 * 所有分组与计数都从真实 episode / inbox 字段派生，动作绑真实导航，不造假生成。
 *
 * 第五轮对照核查（只读实证）：影策 panels.tsx 的 six categories 中，本地只对
 * media_ready/review/episode_error/stage_gap 有真值；paused 本地无全局 production 记录。
 *
 * 第六轮（本次）真拆分 cast_failed/segment_failed：不再编造「无信号」结论。实测本地
 * generation_logs 有两个写入时即落库的真实字段可区分两类失败——platform（图片=canvas-image；
 * 段视频=selected-video-model/comfyui/local/canvas-video）与 segment_id（段视频有真实 Clip 段 id）。
 * 分类逻辑在 studio-inbox-failures.ts，操作为真实导航：参考图失败→项目资产页，段视频失败→跳段。
 * 无法归类者（文本/音频/未知平台）仍归 episode_error，不伪造空分类。
 *
 * 两类「待审阅」的真实字段判定（见 use-studio-data.ts / deriveStageFromProduction）：
 * - 剧本与分镜已就绪：制作稿 shots>0 但 clipGroups(segments)=0、publishedVersion=0
 *   → episode.shotCount>0 && segmentCount===0 && publishedVersion===0（stage=shots）。
 * - 视频提示词待审阅：制作稿 clipGroups(segments)>0 但尚未发布成片（publishedVersion=0）
 *   → episode.segmentCount>0 && publishedVersion===0（stage 已到 video，但只是提示词就绪，尚未成片）。
 */

type GroupKind = "episode_error" | "review" | "stage_gap" | "cast_failed" | "segment_failed";
type Group = {
    key: string;
    kind: GroupKind;
    title: string;
    detail: string;
    reason?: string;
    items: StudioInboxItem[];
    episodeId?: string;
    segmentId?: string;
    severity: "error" | "warning" | "info";
};

/**
 * 原因区展示用「码标签」——真实派生，不伪造后端字段：
 * cast_failed / segment_failed 来自 studio-inbox-failures.ts 按 generation_logs
 * 真实 platform + segment_id 的派生分类；其余 kind 直接映射。
 */
function reasonCodeFor(g: Group): string {
    const kinds = new Set(g.items.map((i) => i.kind));
    if (kinds.has("cast_failed")) return "CAST_FAILED";
    if (kinds.has("segment_failed")) return "SEGMENT_FAILED";
    if (kinds.has("episode_error")) return "EPISODE_ERROR";
    if (kinds.has("job_failed")) return "JOB_FAILED";
    if (kinds.has("stage_gap")) return "STAGE_GAP";
    if (g.key === "media_ready") return "MEDIA_READY";
    if (g.kind === "review") return "REVIEW";
    return g.kind.toUpperCase();
}

export function StudioInboxTab({ inbox, episodes, busy, onOpenEpisode, onReview, onOpenSettings, onStartVideo, onRetryAll, onReleaseMedia, onOpenAssets, onOpenSegment }: {
    inbox: StudioInboxItem[];
    episodes: StudioEpisode[];
    busy: boolean;
    onOpenEpisode: (episodeId: string) => void;
    onReview: (episodeId: string) => void;
    onOpenSettings: () => void;
    onStartVideo: () => void;
    onRetryAll: () => void;
    onReleaseMedia?: () => void;
    /** 参考图生成失败 → 跳项目资产页（带出错的集） */
    onOpenAssets?: (episodeId?: string) => void;
    /** 段视频生成失败 → 跳到对应集的对应段 */
    onOpenSegment?: (episodeId?: string, segmentId?: string) => void;
}) {
    const { modal } = App.useApp();
    // 「全部开始生成」确认弹窗（对齐影策 detail.tsx:320「为 N 集开始生成视频？/全部开始/再看看」）
    const confirmStartVideo = (count: number) => {
        modal.confirm({
            title: `为 ${count} 集开始生成视频？`,
            content: "将启动全自动流水线，按剧本顺序逐段生成视频并合成成片。",
            okText: "全部开始",
            cancelText: "再看看",
            onOk: onStartVideo,
        });
    };
    const groups = useMemo<Group[]>(() => {
        const out: Group[] = [];
        // 1) 剧本与分镜已就绪（stage=shots）：有分镜、无视频提示词、未发布成片 → 去画布开始生成画面
        const readyEps = episodes.filter((ep) => !ep.error && ep.shotCount > 0 && ep.segmentCount === 0 && ep.publishedVersion === 0);
        if (readyEps.length) {
            out.push({
                key: "media_ready", kind: "review" as GroupKind, severity: "info",
                title: `${readyEps.length} 集剧本与分镜已就绪`,
                detail: "确认剧情、分镜与角色设定后再生成画面；可逐集生成，也可一次全部开始（在画布中操作）。",
                items: [], episodeId: readyEps[0].id,
            });
        }
        // 2) 视频提示词待审阅：segments 已生成但还没发布成片 → 去审阅各段提示词与参考图
        const reviewEps = episodes.filter((ep) => !ep.error && ep.segmentCount > 0 && ep.publishedVersion === 0);
        if (reviewEps.length) {
            out.push({
                key: "review", kind: "review", severity: "info",
                title: reviewEps.length > 1 ? `${reviewEps.length} 集视频提示词待审阅` : `第 ${reviewEps[0].no} 集视频提示词待审阅`,
                detail: "核对各段视频提示词与参考图后继续生成视频。",
                items: [], episodeId: reviewEps[0].id,
            });
        }
        // 3) 失败：每集生成错误归并成一张卡（影策 episode_error）
        const errors = inbox.filter((i) => i.kind === "episode_error" || i.kind === "job_failed");
        if (errors.length) {
            out.push({
                key: "errors", kind: "episode_error", severity: "error",
                title: errors.length > 1 ? `${errors.length} 项生成失败` : errors[0].title,
                detail: errors.length > 1 ? "逐集查看失败原因，可在底部队列全部重试。" : "本集生成任务失败，查看原因后可重试。",
                reason: errors.map((e) => e.detail).filter(Boolean).join("；").slice(0, 400),
                items: errors,
                episodeId: errors[0].episodeId,
            });
        }
        // 3b) 参考图生成失败（cast_failed）：generation_logs.platform=canvas-image 的真实失败
        const castFails = inbox.filter((i) => i.kind === "cast_failed");
        if (castFails.length) {
            out.push({
                key: "cast_failed", kind: "cast_failed", severity: "error",
                title: `${castFails.length} 项参考图生成失败`,
                detail: "角色/场景/道具等参考图生成失败，可到项目资产页修改外观后重做，或重试失败任务。",
                reason: castFails.map((e) => e.detail).filter(Boolean).join("；").slice(0, 400),
                items: castFails,
                episodeId: castFails[0].episodeId,
            });
        }
        // 3c) 段视频生成失败（segment_failed）：generation_logs 有 segment_id 的视频平台真实失败
        const segFails = inbox.filter((i) => i.kind === "segment_failed");
        if (segFails.length) {
            out.push({
                key: "segment_failed", kind: "segment_failed", severity: "error",
                title: `${segFails.length} 个剧情段视频生成失败`,
                detail: "剧情段视频生成失败，可定位到对应段查看原因，或重试失败任务。",
                reason: segFails.map((e) => e.detail).filter(Boolean).join("；").slice(0, 400),
                items: segFails,
                episodeId: segFails[0].episodeId,
                segmentId: segFails[0].segmentId,
            });
        }
        // 4) 阶段缺口：按 stage 归类
        const gaps = inbox.filter((i) => i.kind === "stage_gap");
        if (gaps.length) {
            out.push({
                key: "gaps", kind: "stage_gap", severity: "warning",
                title: `${gaps.length} 项阶段缺口`,
                detail: "各集剧情制作尚未推进到下一阶段，按提示继续改编或生成。",
                reason: gaps.map((g) => g.detail).slice(0, 6).join("；"),
                items: gaps,
            });
        }
        return out;
    }, [inbox, episodes]);

    const failCount = inbox.filter((i) => ["episode_error", "job_failed", "cast_failed", "segment_failed"].includes(i.kind)).length;
    // 对齐影策统计头「M 集待审阅」：仅计视频提示词待审阅（已就绪待开始生成的单列一类）
    const reviewCount = episodes.filter((ep) => !ep.error && ep.segmentCount > 0 && ep.publishedVersion === 0).length;
    const readyEpisodeCount = episodes.filter((ep) => !ep.error && ep.shotCount > 0 && ep.segmentCount === 0 && ep.publishedVersion === 0).length;

    if (!groups.length) {
        return (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center" data-studio-inbox>
                <div className="mb-4 flex size-20 items-center justify-center rounded-full border-4 border-muted"><Inbox className="size-8 text-muted-foreground/40" /></div>
                <h3 className="text-sm font-semibold">没有待处理项</h3>
                <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">所有生成任务与阶段判定都已就绪。</p>
            </div>
        );
    }

    const iconFor = (g: Group) => {
        if (g.kind === "cast_failed") return <UserRound className="size-4" />;
        if (g.kind === "segment_failed") return <Film className="size-4" />;
        if (g.kind === "episode_error") return <CircleAlert className="size-4" />;
        if (g.kind === "stage_gap") return <TriangleAlert className="size-4" />;
        if (g.key === "media_ready") return <Sparkles className="size-4" />;
        return <Eye className="size-4" />;
    };
    const actionFor = (g: Group) => {
        if (g.kind === "episode_error") return { label: "查看原因", fn: () => g.episodeId && onOpenEpisode(g.episodeId) };
        // 参考图失败：跳项目资产页（真实导航，带出错集），与影策 cast_failed「查看/改外观」对齐。
        if (g.kind === "cast_failed") return { label: "去资产页", fn: () => onOpenAssets?.(g.episodeId) };
        // 段视频失败：跳到对应集的对应段（真实定位），与影策 segment_failed「查看」对齐。
        if (g.kind === "segment_failed") return { label: "跳段", fn: () => onOpenSegment?.(g.episodeId, g.segmentId) };
        if (g.kind === "stage_gap") return { label: "去设置", fn: onOpenSettings };
        // 「全部开始生成」：对齐影策 media_ready → 确认弹窗 → 真实启动全自动流水线（不再只跳画布的死按钮）
        if (g.key === "media_ready") return { label: "全部开始生成", fn: () => confirmStartVideo(readyEpisodeCount) };
        // 「去审阅」：接 openEpisodeWorkspace(id,"shots")（分镜/提示词审阅台）
        return { label: "去审阅", fn: () => g.episodeId && onReview(g.episodeId) };
    };
    const openChip = (it: StudioInboxItem) => {
        if (it.kind === "cast_failed") { onOpenAssets?.(it.episodeId); return; }
        if (it.kind === "segment_failed") { onOpenSegment?.(it.episodeId, it.segmentId); return; }
        if (it.episodeId) onOpenEpisode(it.episodeId);
    };
    const chipLabel = (it: StudioInboxItem) => {
        if (it.kind === "cast_failed") return `第${it.episodeNo ?? "?"}集 · 参考图`;
        if (it.kind === "segment_failed") return `第${it.episodeNo ?? "?"}集 · 段${it.segmentId || ""}`;
        return it.episodeNo ? `第${it.episodeNo}集` : it.title.replace("阶段缺口 · ", "");
    };

    return (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4" data-studio-inbox>
            {/* 统计头（对齐影策） */}
            <div className="mb-4 flex flex-wrap items-center gap-4">
                <h2 className="text-sm font-semibold">待处理</h2>
                {failCount ? <span className="flex items-center gap-1 text-xs text-rose-600 dark:text-rose-400"><CircleAlert className="size-3.5" /> {failCount} 项失败</span> : null}
                {reviewCount ? <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"><Clock3 className="size-3.5" /> {reviewCount} 集待审阅</span> : null}
                {onReleaseMedia ? (
                    <button type="button" disabled={busy} onClick={onReleaseMedia}
                        title="放行流水线媒体闸门（manual 媒体模式下，参考图/素材就绪后推进段视频与合成）"
                        className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50">
                        <Unlock className="size-3" /> 放行媒体
                    </button>
                ) : null}
                <button type="button" disabled={busy} onClick={onRetryAll}
                    title="重新拉取全部制作数据 / 重试失败任务"
                    className={`flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50 ${onReleaseMedia ? "" : "ml-auto"}`}>
                    <RotateCcw className="size-3" /> 全部重试（{failCount} 项失败 · 共 {groups.length} 类）
                </button>
            </div>

            <div className="space-y-3">
                {groups.map((g) => {
                    const action = actionFor(g);
                    return (
                        <article key={g.key} data-studio-group={g.key} className={`rounded-lg border p-4 ${
                            g.severity === "error" ? "border-rose-200 bg-rose-50/60 dark:border-rose-500/20 dark:bg-rose-500/5"
                                : g.severity === "warning" ? "border-amber-200 bg-amber-50/60 dark:border-amber-500/20 dark:bg-amber-500/5"
                                    : "border-border bg-card/50"
                        }`}>
                            <div className="flex items-start gap-3">
                                <span className={`mt-0.5 shrink-0 ${
                                    g.severity === "error" ? "text-rose-500" : g.severity === "warning" ? "text-amber-500" : "text-sky-500"
                                }`}>{iconFor(g)}</span>
                                <div className="min-w-0 flex-1">
                                    <div className="text-xs font-semibold">{g.title}</div>
                                    <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{g.detail}</div>
                                    {g.reason ? <div className="mt-2 rounded-md border border-border/60 bg-background/50 p-2 text-[11px] leading-relaxed text-muted-foreground" title={g.reason}>
                                        <span className="mr-1.5 rounded bg-muted px-1 py-0.5 align-middle font-mono text-[10px] text-foreground/70" data-studio-reason-code>{reasonCodeFor(g)}</span>
                                        <span className="align-middle">{g.reason}</span>
                                    </div> : null}
                                    {g.items.length ? (
                                        <div className="mt-2 flex flex-wrap gap-1.5">
                                            {g.items.slice(0, 8).map((it) => (
                                                <button key={it.id} type="button" onClick={() => openChip(it)}
                                                    className="rounded border border-border bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
                                                    {chipLabel(it)}
                                                </button>
                                            ))}
                                            {g.items.length > 8 ? <span className="text-[10px] text-muted-foreground">另有 {g.items.length - 8} 项</span> : null}
                                        </div>
                                    ) : null}
                                </div>
                                <div className="flex shrink-0 flex-col items-end gap-1.5">
                                    <button type="button" disabled={busy} onClick={action.fn}
                                        className="h-8 rounded-md bg-foreground px-3 text-[11px] font-medium text-background transition hover:opacity-90 disabled:opacity-50">
                                        {g.kind === "review" ? <Play className="mr-1 inline size-3" /> : null}{action.label}
                                    </button>
                                    {(g.kind === "episode_error" || g.kind === "cast_failed" || g.kind === "segment_failed") && g.items.length ? (
                                        <button type="button" disabled={busy} onClick={onRetryAll}
                                            title="独立全部重试：重新拉取制作数据并重试全部失败任务（与顶部按钮同一真实链路）"
                                            data-studio-group-retry
                                            className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50">
                                            <RotateCcw className="size-3" /> 全部重试 {g.items.length} 项
                                        </button>
                                    ) : null}
                                </div>
                            </div>
                        </article>
                    );
                })}
            </div>
        </div>
    );
}
