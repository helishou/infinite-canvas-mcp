import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { App, Modal, Input } from "antd";
import { Package, History, CheckCircle2, CircleAlert, RotateCcw, ArrowLeftRight, ClipboardList, AlertCircle, Check, ArrowUpRight, ZoomIn, Clapperboard, ChevronDown, UsersRound, MapPin, Image as ImageIcon, Search, LoaderCircle } from "lucide-react";

import {
    fetchEpisodeProductionVersions,
    restoreEpisodeProduction,
    fetchProductionSharedAssets,
    request,
    backendMediaUrl,
    type ProductionTarget,
    type ApprovedSharedAsset,
} from "@/services/backend-api";
import { cn } from "@/lib/utils";
import type { StudioEpisode } from "./use-studio-data";
import { StudioCastPanel, type AssetProduction, type CastSource, type CastKind, type AssetsFocus } from "./studio-cast-panel";
import {
    buildAuditUsage, AUDIT_KINDS, AUDIT_KIND_LABEL, AUDIT_ISSUE_LABEL,
    type AuditAssetRow, type AuditKind, type AuditShotRow, type AuditUsage,
} from "./studio-audit-usage";
import "./asset-kind.css";

const AUDIT_KIND_ICON = { character: UsersRound, scene: MapPin, prop: Package, image: ImageIcon };

/** 资产类型 → asset-kind.css 的 data-asset-kind 值（徽章/chips 共用同一 token）。
 *  本地 AuditKind 已在派生层归一；image（附加素材）用 CSS 已定义的 reference token，不编造新色。 */
function auditKindAttr(kind: AuditKind): string {
    if (kind === "character") return "character";
    if (kind === "scene") return "scene";
    if (kind === "prop") return "prop";
    return "reference";
}

/** 制作台当前选中的集（URL episodeId）——「按集核查 / 版本记录」必须跟着左侧选集走，
 *  不能永远从第 1 集开始，否则左侧高亮第 2 集、核查区却显示第 1 集的资产。 */
function urlSelectedEpisodeId(): string {
    try {
        if (typeof window === "undefined") return "";
        return new URLSearchParams(window.location.search).get("episodeId") || "";
    } catch {
        return "";
    }
}

/** 一集制作稿的可编辑快照：source（真值）+ revision（乐观锁基线）。 */
export type { AssetProduction };

/**
 * 影策「项目资产」tab 增强：资产库 + 按集核查 + 版本对比。
 * - 资产库：已有 StudioAsset 卡片网格（承接原实现）。
 * - 按集核查（gap #21）：逐集读制作稿镜头/剧情段，对照资产库标出覆盖与缺失。
 * - 版本对比（gap #44）：fetchEpisodeProductionVersions 拉版本，并排对比 impact，可回滚。
 */

type SubView = "library" | "audit" | "versions";

type VersionRow = {
    version: number;
    stage: string;
    createdAt: string;
    impact: Record<string, unknown>;
};

function impactSummary(impact: Record<string, unknown>): string[] {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(impact || {})) {
        if (Array.isArray(value)) parts.push(`${key} ${value.length}`);
        else if (typeof value === "number") parts.push(`${key} ${value}`);
        else if (typeof value === "string" && value) parts.push(`${key}: ${value.slice(0, 30)}`);
    }
    return parts;
}

/** 空态 / 错误 / 加载 / 无结果统一视觉：图标 + 文案 + 重试或清除动作。
 *  loading 态补 animate-spin + role=status/aria-busy/aria-live 与轻量骨架，读屏和视觉都能感知进度。 */
function AuditStateView({ icon: Icon, title, description, action, loading = false }: {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    description?: string;
    action?: React.ReactNode;
    loading?: boolean;
}) {
    return (
        <div data-audit-state role={loading ? "status" : undefined} aria-busy={loading || undefined} aria-live={loading ? "polite" : undefined}
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
            <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
                <Icon className={cn("size-5", loading && "animate-spin")} />
            </span>
            <div className="text-sm font-medium text-foreground">{title}</div>
            {description ? <p className="max-w-md text-xs text-muted-foreground">{description}</p> : null}
            {loading ? (
                <div aria-hidden className="mt-1 w-full max-w-xs space-y-2">
                    <div className="h-2 w-3/4 animate-pulse rounded bg-muted" />
                    <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
                    <div className="h-2 w-2/3 animate-pulse rounded bg-muted" />
                </div>
            ) : null}
            {action}
        </div>
    );
}

/** 缩略图加载占位：固定框内先铺一层 pulse 色块，onLoad/onError 后淡入真图；只用 Tailwind，不引依赖。 */
function LoadingThumb({ src, alt, className, thumbAttr = false }: {
    src: string;
    alt: string;
    className?: string;
    thumbAttr?: boolean;
}) {
    const [ready, setReady] = useState(false);
    return (
        <>
            {!ready ? <span aria-hidden className="absolute inset-0 animate-pulse bg-muted/70" /> : null}
            <img {...(thumbAttr ? { "data-audit-thumb-img": "" } : {})} src={src} alt={alt} loading="lazy"
                onLoad={() => setReady(true)} onError={() => setReady(true)}
                className={cn("absolute inset-0 size-full object-contain transition-opacity", className, ready ? "opacity-100" : "opacity-0")} />
        </>
    );
}

function AuditAssetRowView({ asset, onOpenCast, onPreview }: {
    asset: AuditAssetRow;
    onOpenCast: (asset: { assetId: string; name: string; kind: AuditKind }) => void;
    onPreview: (asset: AuditAssetRow) => void;
}) {
    const Icon = AUDIT_KIND_ICON[asset.kind];
    // 影策 .drama-audit-asset：卡片自带 8px 内边距的底板 + 4/3 圆角媒体 + 12/8/8 文字区（标题/meta/状态/关联四行）。
    return (
        <div data-audit-asset className="flex min-w-0 flex-col rounded-[16px] bg-muted/40 p-2 transition-colors hover:bg-muted/60">
            <button type="button" data-audit-thumb disabled={!asset.storageKey} aria-label={`预览${asset.name}`}
                onClick={() => onPreview(asset)}
                className="relative grid aspect-[4/3] w-full min-h-0 place-items-center overflow-hidden rounded-md bg-muted/60 disabled:cursor-default">
                {asset.storageKey ? (
                    <>
                        <LoadingThumb src={backendMediaUrl(asset.storageKey)} alt={asset.name} thumbAttr className="min-h-0" />
                        <ZoomIn className="absolute bottom-1.5 right-1.5 size-4 rounded bg-background/80 text-muted-foreground" aria-hidden />
                    </>
                ) : <Icon className="size-6 opacity-40" aria-hidden />}
            </button>
            <div className="flex flex-col gap-2 px-2 pb-2 pt-3">
                <div className="flex min-w-0 items-center justify-between gap-1">
                    <span title={asset.name} className="line-clamp-2 min-w-0 flex-1 text-[13px] font-semibold leading-snug text-foreground">{asset.name}</span>
                    <button type="button" data-audit-open-cast aria-label={`打开${asset.name}的资产设定`}
                        title="打开资产设定"
                        onClick={() => onOpenCast({ assetId: asset.castId || asset.assetId, name: asset.name, kind: asset.kind })}
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground">
                        <ArrowUpRight className="size-3.5" />
                    </button>
                </div>
                <span className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span data-asset-kind={auditKindAttr(asset.kind)} className="studio-asset-badge inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium">
                        <Icon className="size-3" />
                        {AUDIT_KIND_LABEL[asset.kind]}
                    </span>
                    <span className="truncate">{asset.refLabel}</span>
                </span>
                <span data-audit-issue className={cn("flex min-w-0 items-start gap-1 text-[11px] leading-relaxed", asset.issue ? "text-amber-600" : "text-muted-foreground")}>
                    {asset.issue ? <AlertCircle className="size-3.5 shrink-0" /> : <Check className="size-3.5 shrink-0" />}
                    <span className="min-w-0 [overflow-wrap:anywhere]">{asset.status}</span>
                </span>
                <span className="text-[11px] leading-relaxed text-muted-foreground">{asset.shotCount ? `关联 ${asset.shotCount} 个镜头` : "本段附加参考"}</span>
            </div>
        </div>
    );
}

function AuditShotsView({ shots, onOpenCast }: {
    shots: AuditShotRow[];
    onOpenCast: (asset: { assetId: string; name: string; kind: AuditKind }) => void;
}) {
    return (
        <div data-audit-shots className="mt-2 flex flex-col gap-2">
            {shots.map((shot) => (
                <div key={shot.id} data-audit-shot className="grid grid-cols-[64px_minmax(0,1fr)_minmax(160px,1fr)] items-start gap-3 rounded-lg bg-muted/40 p-3">
                    <span data-audit-shot-number className="text-[11px] tabular-nums text-muted-foreground">镜头 {shot.position + 1}</span>
                    <div data-audit-shot-description className="min-w-0">
                        <p className="line-clamp-2 text-[13px] leading-relaxed text-foreground">{shot.description || "尚未填写镜头内容"}</p>
                        {/* 景别/机位在本地 AuditShotRow 中没有真值字段，留空不编造；时长是真字段。 */}
                        {shot.durationLabel ? <span className="mt-1 block text-[11px] text-muted-foreground">{shot.durationLabel}</span> : null}
                    </div>
                    <div data-audit-shot-assets className="flex flex-wrap gap-1">
                        {shot.chips.map((chip) => {
                            const Icon = AUDIT_KIND_ICON[chip.kind];
                            return (
                                <button key={chip.assetId} type="button" disabled={!chip.assetId}
                                    aria-label={`打开${chip.name}的资产设定`}
                                    title={chip.issue ? `${chip.name} · ${AUDIT_ISSUE_LABEL[chip.issue]}` : chip.name}
                                    onClick={() => onOpenCast({ assetId: chip.assetId, name: chip.name, kind: chip.kind })}
                                    data-asset-kind={auditKindAttr(chip.kind)}
                                    className="studio-asset-badge inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium">
                                    <Icon className="size-3" />
                                    {chip.name}
                                    {chip.issue ? <AlertCircle className="size-3" aria-label={AUDIT_ISSUE_LABEL[chip.issue]} /> : null}
                                </button>
                            );
                        })}
                        {!shot.chips.length ? <span className="text-[11px] text-muted-foreground">未配置镜头资产</span> : null}
                    </div>
                </div>
            ))}
        </div>
    );
}

/** 影策「项目资产 / 按集核查」形态：横向剧集条 + 常驻工具栏 + 只滚动内容区。 */
function EpisodeAuditView({ episodes, auditEp, setAuditEp, usage, loading, error, notice, onRefresh, onOpenSegment, onOpenCast }: {
    episodes: StudioEpisode[];
    auditEp: string;
    setAuditEp: (id: string) => void;
    usage: AuditUsage | null;
    loading: boolean;
    error: string | null;
    notice: string | null;
    onRefresh: () => void;
    onOpenSegment: (episodeId: string, segmentId: string) => void;
    onOpenCast: (asset: { assetId: string; name: string; kind: AuditKind }) => void;
}) {
    const [query, setQuery] = useState("");
    const [kindFilter, setKindFilter] = useState<"all" | AuditKind>("all");
    const [onlyPending, setOnlyPending] = useState(false);
    const [preview, setPreview] = useState<AuditAssetRow | null>(null);

    const q = query.trim().toLowerCase();
    const shown = usage ? usage.segments.map((seg) => ({
        ...seg,
        visibleAssets: seg.assets.filter((a) =>
            (kindFilter === "all" || a.kind === kindFilter) &&
            (!q || a.name.toLowerCase().includes(q) || a.assetId.toLowerCase().includes(q)) &&
            (!onlyPending || Boolean(a.issue)))
            // 角色 → 环境 → 道具 → 素材：排序 filter 产生的新数组，不改派生层数据。
            .sort((a, b) => AUDIT_KINDS.indexOf(a.kind) - AUDIT_KINDS.indexOf(b.kind)),
    })).filter((seg) => seg.visibleAssets.length > 0 || (!seg.assets.length && kindFilter === "all" && !onlyPending && !q)) : [];
    const resetFilters = () => { setQuery(""); setKindFilter("all"); setOnlyPending(false); };
    const selected = episodes.find((ep) => ep.id === auditEp);

    const filters: Array<{ key: "all" | AuditKind; label: string; count: number }> = [
        { key: "all", label: "全部", count: usage?.assetCount ?? 0 },
        ...AUDIT_KINDS.map((k) => ({ key: k as "all" | AuditKind, label: AUDIT_KIND_LABEL[k], count: usage?.counts[k] ?? 0 })),
    ];

    const stateAction = (label: string, onClick: () => void) => (
        <button type="button" data-audit-refresh onClick={onClick}
            className="mt-2 rounded-md border border-border px-3 py-1 text-foreground transition hover:bg-muted/60"><span className="text-[11px]">{label}</span></button>
    );

    return (
        <div data-audit-root className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5" aria-busy={loading}>
            {/* 影策 .drama-audit-intro：标题 + 说明在左，集数说明右对齐同一行。 */}
            <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                    <h2 className="text-base leading-tight text-foreground"><span className="font-semibold">分集资产配置</span></h2>
                    <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">逐段核对人物、环境与道具，查看镜头配置和当前请求使用的参考图。</p>
                </div>
                <span data-audit-intro-note className="text-[11px] text-muted-foreground">选择一集读取配置 · 共 {episodes.length} 集</span>
            </div>

            {episodes.length > 0 && (
                <nav aria-label="选择核查的集" className="thin-scrollbar -m-1 flex shrink-0 gap-2 overflow-x-auto p-1">
                    {episodes.map((ep) => {
                        const active = ep.id === auditEp;
                        return (
                            <button key={ep.id} type="button" data-audit-episode aria-pressed={active} onClick={() => { setAuditEp(ep.id); setPreview(null); }}
                                className={cn("flex w-[180px] shrink-0 flex-col gap-1 rounded-[12px] bg-muted/50 p-3 text-left transition-colors hover:bg-muted/70",
                                    active && "ring-1 ring-inset ring-foreground/20")}>
                                <span className="text-[11px] leading-relaxed text-muted-foreground">第 {ep.no} 集</span>
                                <span className="truncate text-[13px] font-semibold text-foreground">{ep.title || "未命名"}</span>
                                <span className="text-[11px] leading-relaxed text-muted-foreground">{ep.shotCount} 个镜头{active ? " · 当前核查" : " · 点击查看"}</span>
                            </button>
                        );
                    })}
                </nav>
            )}

            {!episodes.length ? (
                <AuditStateView icon={ClipboardList} title="还没有可核查的分集" description="完成分集与分镜后，可在这里核对每一段的资产配置。" />
            ) : error && !usage ? (
                <AuditStateView icon={CircleAlert} title="本集资产配置读取失败" description={error || undefined} action={stateAction("重试", onRefresh)} />
            ) : !usage || (loading && !usage) ? (
                <AuditStateView icon={LoaderCircle} title={`正在读取第 ${selected?.no ?? "—"} 集的资产配置`} description="尚未读取的集不会记为零资产。" loading />
            ) : (
                <>
                    <div className="flex shrink-0 flex-wrap items-center gap-3">
                        <div className="w-[220px] max-w-full shrink-0 [&_.ant-input-affix-wrapper]:h-[34px]">
                            <Input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索本集资产" placeholder="搜索本集资产"
                                prefix={<Search className="size-4 text-muted-foreground" />} allowClear />
                        </div>
                        {/* 影策 .drama-audit-filters：分类分片组包在浅底圆角容器里，选中项用更亮的 surface。 */}
                        <div className="flex flex-wrap items-center gap-1 rounded-md bg-muted/60 p-1" role="group" aria-label="资产类型">
                            {filters.map((f) => (
                                <button key={f.key} type="button" aria-pressed={kindFilter === f.key} onClick={() => setKindFilter(f.key)}
                                    className={cn("inline-flex h-[26px] items-center gap-2 rounded px-2 font-medium transition-colors",
                                        kindFilter === f.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                                    <span className="text-[11px]">{f.label}</span>
                                    <span className="text-[11px] tabular-nums text-muted-foreground/70">{f.count}</span>
                                </button>
                            ))}
                        </div>
                        <button type="button" data-audit-issues-only aria-pressed={onlyPending} onClick={() => setOnlyPending((v) => !v)}
                            className={cn("flex h-[34px] items-center gap-1.5 rounded-md border px-3 transition-colors",
                                onlyPending ? "border-amber-500/50 bg-amber-500/10 text-amber-600" : "border-border text-muted-foreground hover:bg-muted/60")}>
                            <AlertCircle className="size-4" /> <span className="text-[13px] font-medium">只看待核查</span>
                        </button>
                        <button type="button" data-audit-refresh onClick={onRefresh} disabled={loading}
                            className="ml-auto flex h-[34px] items-center gap-1.5 rounded-md border border-border px-2.5 text-muted-foreground transition hover:bg-muted/60 disabled:opacity-50">
                            <RotateCcw className="size-3.5" /> <span className="text-[11px]">刷新</span>
                        </button>
                    </div>

                    <div data-audit-content className="thin-scrollbar -m-1 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-1 [scrollbar-gutter:stable]" aria-busy={loading}>
                        {notice ? (
                            <div data-audit-notice role="alert" className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600">
                                <AlertCircle className="size-4 shrink-0" />
                                <span>刷新失败，以下为上次读取的配置：{notice}</span>
                                <button type="button" onClick={onRefresh} className="ml-auto shrink-0 rounded border border-current px-2 py-0.5">重试</button>
                            </div>
                        ) : null}
                        {usage.warnings.length ? (
                            <div data-audit-warning role="alert" className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600">
                                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                                <div>{usage.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>
                            </div>
                        ) : null}
                        <p className="text-[11px] text-muted-foreground">
                            以下展示当前配置；历史视频可能使用了不同版本的参考图。未附图的原因请进入对应剧情段查看。
                        </p>

                        {shown.map((seg) => (
                            <section key={seg.id} aria-label={`第 ${seg.index + 1} 段资产配置`} data-audit-segment className="flex flex-col gap-4">
                                <header className="flex flex-wrap items-center gap-3">
                                    <span className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-[16px] font-semibold tabular-nums text-foreground">{String(seg.index + 1).padStart(2, "0")}</span>
                                    <div className="min-w-0 flex-1">
                                        <h3 className="truncate text-sm leading-tight text-foreground"><span className="font-semibold">{seg.title}</span></h3>
                                        <span className="block text-[11px] leading-relaxed text-muted-foreground">
                                            {seg.shotCount} 个镜头 · {seg.durationLabel}{seg.pendingCount ? ` · ${seg.pendingCount} 项待核查` : ""}
                                        </span>
                                    </div>
                                    <button type="button" data-audit-open-segment
                                        onClick={() => onOpenSegment(auditEp, seg.id)}
                                        className="flex h-[34px] shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-foreground transition hover:bg-muted/60">
                                        <ArrowUpRight className="size-4" /> <span className="text-[13px] font-medium">进入剧情段</span>
                                    </button>
                                </header>
                                {seg.visibleAssets.length ? (
                                    <div data-audit-assets className="grid grid-cols-[repeat(auto-fill,minmax(min(156px,100%),1fr))] gap-3">
                                        {seg.visibleAssets.map((a) => <AuditAssetRowView key={`${seg.id}:${a.assetId}`} asset={a} onOpenCast={onOpenCast} onPreview={setPreview} />)}
                                    </div>
                                ) : (
                                    <p className="text-[11px] text-muted-foreground">本段尚未配置资产或参考图，可进入剧情段补充。</p>
                                )}
                                {seg.shots.length ? (
                                    <details className="group">
                                        {/* 全局 reset 给 summary 定死 display:list-item（layer 内工具类压不过），
                                            所以行内排版放内部 span，保持影策 summary 的单行「图标+文案+箭头」。 */}
                                        <summary className="w-fit cursor-pointer list-none py-2 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                                            <span className="flex w-fit items-center gap-2 text-[11px]">
                                                <Clapperboard className="size-4" /> 查看 {seg.shotCount} 个镜头的资产配置 <ChevronDown className="size-4" />
                                            </span>
                                        </summary>
                                        <AuditShotsView shots={seg.shots} onOpenCast={onOpenCast} />
                                    </details>
                                ) : null}
                            </section>
                        ))}

                        {usage.unassignedShots.length ? (
                            <section data-audit-unassigned className="flex flex-col gap-4">
                                <header className="flex flex-wrap items-center gap-3">
                                    <AlertCircle className="size-4 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0 flex-1">
                                        <h3 className="text-sm leading-tight text-foreground"><span className="font-semibold">{usage.unassignedShots.length} 个镜头尚未关联剧情段</span></h3>
                                        <span className="block text-[11px] leading-relaxed text-muted-foreground">保留镜头资产供核查，尚无可对照的段参考请求。</span>
                                    </div>
                                </header>
                                <AuditShotsView shots={usage.unassignedShots} onOpenCast={onOpenCast} />
                            </section>
                        ) : null}

                        {!shown.length && !usage.unassignedShots.length ? (
                            usage.segments.length ? (
                                <AuditStateView
                                    icon={Search}
                                    title={q ? `没有找到与“${query.trim()}”匹配的资产` : "没有符合筛选的资产"}
                                    description="试试更换关键词，或清除当前筛选条件后重新查看。"
                                    action={stateAction(q ? `清除筛选（${query.trim()}）` : "清除筛选", resetFilters)}
                                />
                            ) : (
                                <AuditStateView icon={ClipboardList} title="本集还没有分镜资产配置" description="剧本与分镜生成后，这里会显示每一段的角色、环境、道具和参考素材。" />
                            )
                        ) : null}
                    </div>
                </>
            )}
            <Modal open={Boolean(preview)} onCancel={() => setPreview(null)} footer={null} width="min(90vw, 1100px)" centered destroyOnHidden data-audit-preview>
                <div className="grid min-h-[50vh] w-full place-items-center overflow-hidden rounded-lg bg-muted/40">
                    {preview?.storageKey ? <img src={backendMediaUrl(preview.storageKey)} alt={`${preview.name} 参考图`} className="max-h-[80vh] w-full object-contain" /> : null}
                </div>
                <p className="mt-2 text-center text-xs text-muted-foreground">{preview?.name || ""} · 参考图放大查看</p>
            </Modal>
        </div>
    );
}

/** 单资产版本记录：assetVersions 是 ApprovedSharedAsset[]，storageKey 是真实图片。
 *  用真实存在的版本行做并排对比 + 点击放大；只有一个版本时显示单张，不编造 before/after。
 *  采纳走与 studio-cast-panel adoptImage 相同的真链 POST /drama/pipeline/assets/adopt-shared-image。 */
function AssetVersionCompare({ versions, loading = false, onAdopted }: { versions: ApprovedSharedAsset[]; loading?: boolean; onAdopted?: () => void }) {
    const { message } = App.useApp();
    const [leftId, setLeftId] = useState("");
    const [rightId, setRightId] = useState("");
    const [preview, setPreview] = useState<ApprovedSharedAsset | null>(null);
    const [adoptingId, setAdoptingId] = useState("");
    const [adoptedId, setAdoptedId] = useState("");

    const ordered = useMemo(
        () => [...versions].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
        [versions],
    );
    // 「当前采用」以真实 reviewStatus=approved 为准；本地刚采纳的版本次之；都没有时退回最新一条。
    const current = ordered.find((v) => v.reviewStatus === "approved") || ordered.find((v) => v.id === adoptedId) || ordered[0];

    // adopt-shared-image 的 strict schema 要 projectId/nodeId/storageKey（assetId 可选）：
    // 版本行的 sourceProjectId/sourceNodeId 正是共享画布 canonical 定位，assetId/storageKey 也在行内。
    // 缺任一项就不显示按钮，不伪造请求。sourceVersion 只是本行真值标签，schema 不接收，不硬塞。
    const canAdopt = (v: ApprovedSharedAsset) => Boolean(v.storageKey && v.sourceProjectId && v.sourceNodeId && v.assetId);

    const handleAdopt = async (v: ApprovedSharedAsset) => {
        if (!canAdopt(v) || v.reviewStatus === "approved" || v.id === adoptedId) return;
        setAdoptingId(v.id);
        try {
            await request("POST", "/drama/pipeline/assets/adopt-shared-image", {
                projectId: v.sourceProjectId,
                nodeId: v.sourceNodeId,
                storageKey: v.storageKey,
                assetId: v.assetId,
                imageId: `adopted:version:${v.id}`,
            });
            setAdoptedId(v.id);
            message.success(`已采纳 v${v.sourceVersion} 的参考图并锁定，消费分集按此图生成`);
            onAdopted?.();
        } catch (error) {
            message.error(`采纳失败：${(error as Error).message}`);
        } finally {
            setAdoptingId("");
        }
    };

    useEffect(() => {
        if (!ordered.length) return;
        const fallbackRight = current?.id || ordered[0].id;
        const fallbackLeft = ordered.find((v) => v.id !== fallbackRight)?.id || fallbackRight;
        setRightId((prev) => (ordered.some((v) => v.id === prev) ? prev : fallbackRight));
        setLeftId((prev) => (ordered.some((v) => v.id === prev) ? prev : fallbackLeft));
    }, [ordered, current?.id]);

    const left = ordered.find((v) => v.id === leftId) || ordered[0];
    const right = ordered.find((v) => v.id === rightId) || ordered[0];
    const shown = ordered.length >= 2 ? [left, right] : ordered.slice(0, 1);
    const versionLabel = (v: ApprovedSharedAsset) => `v${v.sourceVersion} · ${v.snapshot?.title || v.assetId}`;

    return (
        <div className="mt-5 border-t border-border pt-4">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs font-semibold">
                <History className="size-3.5 text-muted-foreground" /> 单资产版本记录
                <span className="font-normal text-muted-foreground">{loading ? "正在读取本集单资产版本…" : `共 ${ordered.length} 条 · 角色/场景/道具的历次采用（真实版本行，点击缩略图放大）`}</span>
            </div>
            {ordered.length >= 2 ? (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/40 p-2 text-[11px]">
                    <ArrowLeftRight className="size-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">左</span>
                    <select aria-label="左侧对比版本" value={leftId} onChange={(e) => setLeftId(e.target.value)}
                        className="h-7 max-w-[220px] rounded border border-border bg-background px-2 text-[11px]">
                        {ordered.map((v) => <option key={v.id} value={v.id}>{versionLabel(v)}</option>)}
                    </select>
                    <span className="text-muted-foreground">并排对比</span>
                    <span className="text-muted-foreground">右</span>
                    <select aria-label="右侧对比版本" value={rightId} onChange={(e) => setRightId(e.target.value)}
                        className="h-7 max-w-[220px] rounded border border-border bg-background px-2 text-[11px]">
                        {ordered.map((v) => <option key={v.id} value={v.id}>{versionLabel(v)}</option>)}
                    </select>
                </div>
            ) : null}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {loading ? (
                    <>
                        <div aria-hidden className="aspect-[4/3] animate-pulse rounded-lg bg-muted/50" />
                        <div aria-hidden className="aspect-[4/3] animate-pulse rounded-lg bg-muted/50" />
                    </>
                ) : shown.map((v, idx) => v ? (
                    <div key={`${v.id}:${idx}`} data-asset-version className="overflow-hidden rounded-lg border border-border bg-card/40">
                        <button type="button" aria-label={`放大${v.snapshot?.title || v.assetId}`} onClick={() => setPreview(v)}
                            className="relative grid aspect-[4/3] w-full place-items-center overflow-hidden bg-muted/40">
                            {v.storageKey ? (
                                <>
                                    <LoadingThumb src={backendMediaUrl(v.storageKey)} alt={v.snapshot?.title || v.assetId} />
                                    <ZoomIn className="absolute bottom-2 right-2 size-3.5 rounded bg-background/80 text-foreground" aria-hidden />
                                </>
                            ) : <ImageIcon className="size-6 opacity-40" aria-hidden />}
                            {v.id === current?.id ? (
                                <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                                    <Check className="size-3" /> 当前采用
                                </span>
                            ) : null}
                        </button>
                        <div className="flex flex-col gap-1 p-2">
                            <strong title={v.snapshot?.title || v.assetId} className="truncate text-xs font-semibold text-foreground">{v.snapshot?.title || v.assetId}</strong>
                            <span className="text-[10px] text-muted-foreground">v{v.sourceVersion} · {v.reviewStatus === "approved" ? "已审阅" : "未审阅"}</span>
                            <span className="text-[10px] text-muted-foreground">{v.createdAt ? new Date(v.createdAt).toLocaleString() : "—"}</span>
                            {canAdopt(v) ? (
                                <button type="button"
                                    disabled={v.reviewStatus === "approved" || v.id === adoptedId || Boolean(adoptingId)}
                                    title={v.reviewStatus === "approved" || v.id === adoptedId ? "该版本已是当前采用，不重复采纳" : `采纳 v${v.sourceVersion} 的参考图并锁定到共享资产`}
                                    onClick={() => void handleAdopt(v)}
                                    className="mt-1 flex h-6 w-fit items-center gap-1 rounded border border-primary/40 bg-primary/5 px-2 text-[10px] text-primary transition hover:bg-primary/10 disabled:cursor-default disabled:opacity-50">
                                    <CheckCircle2 className="size-3" />
                                    {adoptingId === v.id ? "采纳中…" : v.reviewStatus === "approved" || v.id === adoptedId ? "当前采用" : "采纳此版本"}
                                </button>
                            ) : null}
                        </div>
                    </div>
                ) : null)}
            </div>
            <Modal open={Boolean(preview)} onCancel={() => setPreview(null)} footer={null} width="min(90vw, 1100px)" centered destroyOnHidden data-asset-version-preview>
                <div className="grid min-h-[50vh] w-full place-items-center overflow-hidden rounded-lg bg-muted/40">
                    {preview?.storageKey ? <img src={backendMediaUrl(preview.storageKey)} alt={`${preview.snapshot?.title || preview.assetId} 版本图`} className="max-h-[80vh] w-full object-contain" /> : null}
                </div>
                <p className="mt-2 text-center text-xs text-muted-foreground">
                    {preview?.snapshot?.title || preview?.assetId || ""} · v{preview?.sourceVersion ?? "—"} · {preview?.reviewStatus === "approved" ? "已审阅" : "未审阅"} · 版本图放大查看
                </p>
            </Modal>
        </div>
    );
}

export function StudioAssetsTab({ dramaId, sharedAssetCanvasId, artStyle, episodes, loading, onOpenCanvas, onOpenSharedCanvas, onChanged, productionOf, onExtractAssets, initialSub, initialKind, voiceProfiles, onOpenSegment, onOpenCast, focusAsset }: {
    dramaId: string | null;
    sharedAssetCanvasId: string | null;
    artStyle: string;
    episodes: StudioEpisode[];
    loading: boolean;
    onOpenCanvas: () => void;
    /** 共享条目换参考图：打开共享资产画布（canvasHost.openCanvas({projectId: sharedAssetCanvasId})）。 */
    onOpenSharedCanvas?: () => void;
    onChanged: () => void;
    /** 制作设置音色库，透传给角色声音选择（真实绑定 character.voice）。 */
    voiceProfiles?: Array<{ id: string; name: string; description: string; sampleRef: string }>;
    /** 读某集制作稿（source + revision），由页面传入，复用已有 query 缓存思路。 */
    productionOf: (episodeId: string) => Promise<AssetProduction | null>;
    /** 影策资产段：从本集剧本提取设定并建档，返回新建数量。 */
    onExtractAssets?: (episodeId: string) => Promise<number>;
    /** 外部指定初始子视图（段编辑弹窗「按集核查」直达 audit）。 */
    initialSub?: SubView;
    /** 设置页「重做参考图」跳转时预选的资产分类。 */
    initialKind?: CastKind;
    /** 按集核查「进入剧情段」：定位到该集具体段（index.tsx 的 openSegmentFor）。 */
    onOpenSegment?: (episodeId: string, segmentId: string) => void;
    /** 资产行「打开资产设定」：切到资产库并按资产 ID/分类选中该资产。 */
    onOpenCast?: (asset: { assetId: string; name: string; kind: AuditKind }) => void;
    /** 由 onOpenCast 触发的资产库选中目标（真值 ID，不伪造）。 */
    focusAsset?: AssetsFocus | null;
}) {
    const { message, modal } = App.useApp();
    const [sub, setSub] = useState<SubView>(initialSub || "library");
    useEffect(() => { if (initialSub) setSub(initialSub); }, [initialSub]);
    const [extractEp, setExtractEp] = useState("");
    const [extracting, setExtracting] = useState(false);
    const [auditEp, setAuditEp] = useState<string>("");
    const [auditSource, setAuditSource] = useState<Record<string, unknown> | null>(null);
    const [auditAssets, setAuditAssets] = useState<Record<string, unknown>>({});
    const [auditArtifacts, setAuditArtifacts] = useState<Array<Record<string, unknown>>>([]);
    const [auditLoading, setAuditLoading] = useState(false);
    const [auditLoaded, setAuditLoaded] = useState(false);
    const [auditHasData, setAuditHasData] = useState(false);
    const [auditError, setAuditError] = useState<string | null>(null);
    const [reloadTick, setReloadTick] = useState(0);
    const [verEp, setVerEp] = useState<string>("");
    const [versions, setVersions] = useState<VersionRow[]>([]);
    const [assetVersions, setAssetVersions] = useState<ApprovedSharedAsset[]>([]);
    const [assetVerLoading, setAssetVerLoading] = useState(false);
    const [verLeft, setVerLeft] = useState<number | null>(null);
    const [verRight, setVerRight] = useState<number | null>(null);
    const [verLoading, setVerLoading] = useState(false);
    const [adoptedVersionTick, setAdoptedVersionTick] = useState(0);
    const [restoring, setRestoring] = useState(false);
    // 影策资产库：汇总各集制作稿里的角色/场景/道具（带 episodeId + revision 供写回）
    const [castSources, setCastSources] = useState<CastSource[]>([]);

    useEffect(() => {
        let disposed = false;
        void Promise.all(episodes.map(async (ep) => {
            const prod = await productionOf(ep.id);
            return {
                episodeNo: ep.no, episodeId: ep.id, revision: prod?.revision ?? 0, source: prod?.source || null,
                assets: prod?.assets || {}, assetCards: prod?.assetCards || [], canvasId: ep.canvasId || undefined,
            } as CastSource;
        }))
            .then(list => { if (!disposed) setCastSources(list); });
        return () => { disposed = true; };
    }, [episodes, productionOf, reloadTick]);

    // 跟随制作台当前选集：URL episodeId 变化时两个子视图一起切过去；
    // 用户在子视图里手动点集（只改本地 state、不改 URL）不会被拉回，仍可独立查看其它集。
    const urlEpisodeId = urlSelectedEpisodeId();
    const lastSyncedUrlEp = useRef<string | null>(null);

    // 切集当帧清空上一集派生数据，避免旧 usage / versions 配新集标题闪一帧。
    // handler 先清再切；layout effect 在浏览器绘制前跑，兜住 URL 驱动的切集。
    const resetAuditData = useCallback(() => {
        setAuditHasData(false);
        setAuditLoaded(false);
        setAuditError(null);
        setAuditSource(null);
        setAuditAssets({});
        setAuditArtifacts([]);
    }, []);
    const resetVersionData = useCallback(() => {
        setVersions([]);
        setAssetVersions([]);
        setVerLeft(null);
        setVerRight(null);
        // 没有可拉取的集时不要挂住 spinner（首帧 episodes 为空 / verEp 尚未同步）。
        if (verEp) {
            setVerLoading(true);
            setAssetVerLoading(true);
        }
    }, [verEp]);
    const selectAuditEp = useCallback((id: string) => {
        if (id === auditEp) return;
        resetAuditData();
        setAuditEp(id);
    }, [auditEp, resetAuditData]);
    const selectVerEp = useCallback((id: string) => {
        if (id === verEp) return;
        resetVersionData();
        setVerEp(id);
    }, [verEp, resetVersionData]);

    useEffect(() => {
        if (!episodes.length) return;
        if (lastSyncedUrlEp.current === urlEpisodeId) return;
        lastSyncedUrlEp.current = urlEpisodeId;
        const selected = episodes.find((ep) => ep.id === urlEpisodeId);
        const nextEp = selected ? selected.id : episodes[0].id;
        if (nextEp !== auditEp) resetAuditData();
        if (nextEp !== verEp) resetVersionData();
        setAuditEp(nextEp);
        setVerEp(nextEp);
    }, [urlEpisodeId, episodes, auditEp, verEp, resetAuditData, resetVersionData]);

    // 切换剧集/子视图时在绘制前清掉「已读到真值」标记；刷新 tick 不会触发，失败时仍保留上次数据。
    useLayoutEffect(() => {
        resetAuditData();
        resetVersionData();
    }, [auditEp, verEp, sub, resetAuditData, resetVersionData]);

    // 按集核查：拉该集制作稿 source + assets + artifacts（artifacts 是该段真实附图请求，用于 issue 判定）。
    useEffect(() => {
        let disposed = false;
        if (sub !== "audit" || !auditEp) return;
        setAuditLoading(true);
        void productionOf(auditEp).then((prod) => {
            if (disposed) return;
            if (!prod) {
                setAuditHasData(false);
                setAuditError("请重试，当前无法判断本集使用了哪些资产。");
                return;
            }
            setAuditSource(prod.source || null);
            setAuditAssets(prod.assets || {});
            setAuditArtifacts(prod.artifacts || []);
            setAuditHasData(true);
            setAuditError(null);
        }).catch((error: unknown) => {
            if (!disposed) setAuditError(error instanceof Error ? error.message : "请重试，当前无法判断本集使用了哪些资产。");
        }).finally(() => {
            if (!disposed) { setAuditLoading(false); setAuditLoaded(true); }
        });
        return () => { disposed = true; };
    }, [sub, auditEp, productionOf, reloadTick]);

    // 影策 refetchInterval：本地等价的「生成中」阶段每 4s 重读当前集制作稿。
    // 本地 stage：script=剧本、assets=参考图、shots=分镜/提示词、video=成片。
    const auditStage = episodes.find((ep) => ep.id === auditEp)?.stage;
    const auditGenerating = sub === "audit" && ["script", "assets", "shots", "video"].includes(auditStage || "");
    useEffect(() => {
        if (!auditGenerating) return;
        const timer = window.setInterval(() => setReloadTick((v) => v + 1), 4_000);
        return () => window.clearInterval(timer);
    }, [auditGenerating]);

    const auditUsage = useMemo(
        () => (auditLoaded && auditHasData ? buildAuditUsage(auditSource, auditAssets, auditArtifacts) : null),
        [auditLoaded, auditHasData, auditSource, auditAssets, auditArtifacts],
    );

    const onRefreshAudit = useCallback(() => setReloadTick((v) => v + 1), []);

    // 版本列表
    useEffect(() => {
        let disposed = false;
        if (sub !== "versions" || !verEp) return;
        setVerLoading(true);
        void fetchEpisodeProductionVersions(verEp as ProductionTarget)
            .then((r) => {
                if (disposed) return;
                setVersions((r.versions || []) as VersionRow[]);
                const nums = (r.versions || []).map((v) => v.version);
                setVerRight(nums[0] ?? null);
                setVerLeft(nums[1] ?? nums[0] ?? null);
            })
            .catch(() => { if (!disposed) setVersions([]); })
            .finally(() => { if (!disposed) setVerLoading(false); });
        return () => { disposed = true; };
    }, [sub, verEp]);

    // 单资产版本记录（真实表 drama_asset_versions，经 /production/shared-assets 暴露）
    useEffect(() => {
        let disposed = false;
        if (sub !== "versions" || !verEp) return;
        setAssetVerLoading(true);
        void fetchProductionSharedAssets(verEp as ProductionTarget)
            .then((r) => { if (!disposed) setAssetVersions(r.versions || []); })
            .catch(() => { if (!disposed) setAssetVersions([]); })
            .finally(() => { if (!disposed) setAssetVerLoading(false); });
        return () => { disposed = true; };
    }, [sub, verEp, adoptedVersionTick]);

    /** 版本采纳成功后：重读单资产版本列表 + 当前资产图（制作稿来源），保持真值一致。 */
    const handleAssetAdopted = useCallback(() => {
        setAdoptedVersionTick((v) => v + 1);
        setReloadTick((v) => v + 1);
        onChanged();
    }, [onChanged]);

    const handleRestore = async (version: number) => {
        setRestoring(true);
        try {
            await restoreEpisodeProduction(verEp as ProductionTarget, 0, version);
            message.success(`已回滚到第 ${version} 版`);
            onChanged();
        } catch (error) {
            message.error(`回滚失败：${(error as Error).message}`);
        } finally {
            setRestoring(false);
        }
    };

    // 回滚制作稿前的确认（V2 标准）：影策无此操作，本地独有的破坏性写回，确认后才真回滚。
    const confirmRestore = (version: number) => {
        modal.confirm({
            title: `回滚到第 ${version} 版？`,
            content: "回滚制作稿到该版本，当前提示词/成片可能标记为过期；此操作会写入制作稿 revision。请确认后再继续。",
            okText: "确认回滚",
            okButtonProps: { danger: true },
            cancelText: "取消",
            centered: true,
            onOk: () => handleRestore(version),
        });
    };

    const handleExtract = async () => {
        if (!onExtractAssets || !extractEp) return void message.warning("请先选择要提取设定的剧集");
        setExtracting(true);
        try {
            const n = await onExtractAssets(extractEp);
            message.success(n > 0 ? `已从剧本建档 ${n} 项设定，可为其生成参考图` : "没有新设定需要建档（可能已建过或剧本为空）");
            onChanged();
        } catch (error) { message.error(`提取失败：${(error as Error).message}`); }
        finally { setExtracting(false); }
    };

    const tabs: Array<{ key: SubView; label: string; icon: React.ReactNode }> = [
        { key: "library", label: "资产库", icon: <Package className="size-3.5" /> },
        { key: "audit", label: "按集核查", icon: <ClipboardList className="size-3.5" /> },
        { key: "versions", label: "版本记录与对比", icon: <History className="size-3.5" /> },
    ];

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-6 py-2.5">
                {tabs.map((tab) => (
                    <button key={tab.key} type="button" onClick={() => setSub(tab.key)}
                        className={cn("flex h-8 items-center gap-1.5 rounded-md px-3 text-xs transition",
                            sub === tab.key ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted/60")}>
                        {tab.icon}{tab.label}
                    </button>
                ))}
                {onExtractAssets ? (
                    <span className="ml-auto flex items-center gap-1.5" data-studio-asset-extract>
                        <select
                            aria-label="提取设定的剧集"
                            value={extractEp}
                            onChange={(e) => setExtractEp(e.target.value)}
                            className="h-7 rounded border border-border bg-transparent px-1.5 text-[11px] text-muted-foreground"
                        >
                            <option value="">选择剧集</option>
                            {episodes.map((ep) => <option key={ep.id} value={ep.id}>第 {ep.no} 集 · {ep.title}</option>)}
                        </select>
                        <button
                            type="button"
                            onClick={() => void handleExtract()}
                            disabled={extracting}
                            title="从本集分场剧本提取角色/场景/道具并建档（影策资产段）"
                            className="flex h-7 items-center gap-1 rounded border border-primary/40 bg-primary/5 px-2 text-[11px] text-primary transition hover:bg-primary/10 disabled:opacity-50"
                        >
                            {extracting ? "提取中…" : "从剧本提取设定"}
                        </button>
                    </span>
                ) : null}
                <button type="button" onClick={onOpenCanvas} className={onExtractAssets ? "text-xs text-muted-foreground hover:text-foreground" : "ml-auto text-xs text-muted-foreground hover:text-foreground"}>在画布中精修 →</button>
            </div>

            {sub === "library" ? (
                <StudioCastPanel dramaId={dramaId} sharedAssetCanvasId={sharedAssetCanvasId} sources={castSources} artStyle={artStyle} loading={loading} onOpenCanvas={onOpenCanvas} onOpenSharedCanvas={onOpenSharedCanvas} onChanged={onChanged} voiceProfiles={voiceProfiles} initialKind={initialKind} focusAsset={focusAsset} />
            ) : sub === "audit" ? (
                <EpisodeAuditView
                    episodes={episodes}
                    auditEp={auditEp}
                    setAuditEp={selectAuditEp}
                    usage={auditUsage}
                    loading={auditLoading}
                    error={auditHasData ? null : auditError}
                    notice={auditHasData ? auditError : null}
                    onRefresh={onRefreshAudit}
                    onOpenSegment={(episodeId, segmentId) => onOpenSegment?.(episodeId, segmentId)}
                    onOpenCast={(asset) => onOpenCast?.(asset)}
                />
            ) : (
                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                    <div className="mb-3 flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">剧集</span>
                        <select value={verEp} onChange={(e) => selectVerEp(e.target.value)}
                            className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none">
                            {episodes.map((ep) => <option key={ep.id} value={ep.id}>第 {ep.no} 集 · {ep.title}</option>)}
                        </select>
                        <span className="ml-auto text-[11px] text-muted-foreground">发布/回滚会写制作稿 revision</span>
                    </div>
                    {verLoading ? (
                        <AuditStateView icon={LoaderCircle} title="读取版本记录…" description="正在读取本集制作稿版本与单资产版本。" loading />
                    ) : versions.length || assetVersions.length || assetVerLoading ? (
                        <>
                            {versions.length ? (
                                <>
                                    <div className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-card/40 p-3 text-xs">
                                        <ArrowLeftRight className="size-4 text-muted-foreground" />
                                        <span className="text-muted-foreground">对比</span>
                                        <select value={verLeft ?? ""} onChange={(e) => setVerLeft(Number(e.target.value))} className="h-7 rounded border border-border bg-background px-2 text-xs">
                                            {versions.map((v) => <option key={v.version} value={v.version}>v{v.version} · {v.stage}</option>)}
                                        </select>
                                        <span className="text-muted-foreground">vs</span>
                                        <select value={verRight ?? ""} onChange={(e) => setVerRight(Number(e.target.value))} className="h-7 rounded border border-border bg-background px-2 text-xs">
                                            {versions.map((v) => <option key={v.version} value={v.version}>v{v.version} · {v.stage}</option>)}
                                        </select>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        {[verLeft, verRight].map((ver, idx) => {
                                            const v = versions.find((x) => x.version === ver);
                                            return (
                                                <div key={idx} className="rounded-lg border border-border bg-card/40 p-3">
                                                    <div className="mb-2 flex items-center justify-between">
                                                        <span className="text-sm font-semibold">v{v?.version ?? "—"} · {v?.stage || "—"}</span>
                                                        {v ? <button type="button" disabled={restoring} onClick={() => confirmRestore(v.version)}
                                                            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50">
                                                            <RotateCcw className="size-3" /> 回滚
                                                        </button> : null}
                                                    </div>
                                                    <div className="text-[11px] text-muted-foreground">{v?.createdAt ? new Date(v.createdAt).toLocaleString() : "—"}</div>
                                                    {/* impact 摘要作为文字信息保留（真实 impact 派生，不编造）。 */}
                                                    <div className="mt-2 flex flex-wrap gap-1">
                                                        {impactSummary(v?.impact || {}).map((part, i) => (
                                                            <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{part}</span>
                                                        ))}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
                            ) : null}
                            {assetVersions.length || assetVerLoading ? <AssetVersionCompare versions={assetVersions} loading={assetVerLoading} onAdopted={handleAssetAdopted} /> : null}
                        </>
                    ) : (
                        <AuditStateView icon={History} title="本集还没有发布版本" description="在分镜改编里点「写稿」发布后会出现版本记录。" />
                    )}
                </div>
            )}
        </div>
    );
}
