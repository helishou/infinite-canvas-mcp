import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Modal } from "antd";
import { Package, History, CheckCircle2, CircleAlert, RotateCcw, ArrowLeftRight, ClipboardList, AlertCircle, Check, ArrowUpRight, ZoomIn, Clapperboard, ChevronDown, UsersRound, MapPin, Image as ImageIcon } from "lucide-react";

import {
    fetchEpisodeProductionVersions,
    restoreEpisodeProduction,
    fetchProductionSharedAssets,
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

const AUDIT_KIND_ICON = { character: UsersRound, scene: MapPin, prop: Package, image: ImageIcon };
const AUDIT_KIND_CLASS: Record<AuditKind, string> = {
    character: "bg-blue-500/10 text-blue-500",
    scene: "bg-emerald-500/10 text-emerald-500",
    prop: "bg-purple-500/10 text-purple-500",
    image: "bg-slate-500/10 text-slate-400",
};

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

function AuditAssetRowView({ asset, onOpenCast, onPreview }: {
    asset: AuditAssetRow;
    onOpenCast: (asset: { assetId: string; name: string; kind: AuditKind }) => void;
    onPreview: (asset: AuditAssetRow) => void;
}) {
    const Icon = AUDIT_KIND_ICON[asset.kind];
    return (
        <div data-audit-asset className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
            <button type="button" data-audit-thumb disabled={!asset.storageKey} aria-label={`预览${asset.name}`}
                onClick={() => onPreview(asset)}
                className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted/40 disabled:cursor-default">
                {asset.storageKey ? (
                    <>
                        <img data-audit-thumb-img src={backendMediaUrl(asset.storageKey)} alt={asset.name} loading="lazy" className="size-full object-cover" />
                        <ZoomIn className="absolute bottom-0.5 right-0.5 size-3 bg-background/80 text-foreground" aria-hidden />
                    </>
                ) : <Icon className="size-5 opacity-40" aria-hidden />}
            </button>
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1">
                    <strong title={asset.name} className="truncate font-medium text-foreground">{asset.name}</strong>
                    <button type="button" data-audit-open-cast aria-label={`打开${asset.name}的资产设定`}
                        title="打开资产设定"
                        onClick={() => onOpenCast({ assetId: asset.castId || asset.assetId, name: asset.name, kind: asset.kind })}
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground">
                        <ArrowUpRight className="size-3.5" />
                    </button>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span className={cn("rounded px-1.5 py-0.5", AUDIT_KIND_CLASS[asset.kind])}>{AUDIT_KIND_LABEL[asset.kind]}</span>
                    <span>{asset.refLabel}</span>
                    <span data-audit-issue className={cn("flex items-center gap-1 rounded px-1.5 py-0.5", asset.issue ? "bg-amber-500/10 text-amber-600" : "bg-emerald-500/10 text-emerald-500")}>
                        {asset.issue ? <AlertCircle className="size-3" /> : <Check className="size-3" />}
                        {asset.status}
                    </span>
                    <span>{asset.shotCount ? `关联 ${asset.shotCount} 个镜头` : "本段附加参考"}</span>
                </div>
            </div>
        </div>
    );
}

function AuditShotsView({ shots, onOpenCast }: {
    shots: AuditShotRow[];
    onOpenCast: (asset: { assetId: string; name: string; kind: AuditKind }) => void;
}) {
    return (
        <div data-audit-shots className="space-y-2">
            {shots.map((shot) => (
                <div key={shot.id} className="rounded-md border border-border bg-background/40 p-2">
                    <div className="flex items-center gap-2 text-[11px]">
                        <span className="font-medium text-foreground">镜头 {shot.position + 1}</span>
                        <span className="truncate text-muted-foreground">{shot.description || "尚未填写镜头内容"}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{shot.durationLabel}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                        {shot.chips.map((chip) => {
                            const Icon = AUDIT_KIND_ICON[chip.kind];
                            return (
                                <button key={chip.assetId} type="button" disabled={!chip.assetId}
                                    aria-label={`打开${chip.name}的资产设定`}
                                    title={chip.issue ? `${chip.name} · ${AUDIT_ISSUE_LABEL[chip.issue]}` : chip.name}
                                    onClick={() => onOpenCast({ assetId: chip.assetId, name: chip.name, kind: chip.kind })}
                                    className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]", AUDIT_KIND_CLASS[chip.kind])}>
                                    <Icon className="size-3" />
                                    {chip.name}
                                    {chip.issue ? <AlertCircle className="size-3" aria-label={AUDIT_ISSUE_LABEL[chip.issue]} /> : null}
                                </button>
                            );
                        })}
                        {!shot.chips.length ? <span className="text-[10px] text-muted-foreground">未配置镜头资产</span> : null}
                    </div>
                </div>
            ))}
        </div>
    );
}

/** 影策「项目资产 / 按集核查」形态：剧集按钮组 + 工具栏 + 剧情段卡片 + 可折叠镜头明细。 */
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
            (!onlyPending || Boolean(a.issue))),
    })).filter((seg) => seg.visibleAssets.length > 0 || (!seg.assets.length && kindFilter === "all" && !onlyPending && !q)) : [];
    const resetFilters = () => { setQuery(""); setKindFilter("all"); setOnlyPending(false); };
    const selected = episodes.find((ep) => ep.id === auditEp);

    const filters: Array<{ key: "all" | AuditKind; label: string; count: number }> = [
        { key: "all", label: "全部", count: usage?.assetCount ?? 0 },
        ...AUDIT_KINDS.map((k) => ({ key: k as "all" | AuditKind, label: AUDIT_KIND_LABEL[k], count: usage?.counts[k] ?? 0 })),
    ];

    return (
        <div data-audit-root className="min-h-0 flex-1 overflow-y-auto px-6 py-4" aria-busy={loading}>
            <div className="mb-4">
                <h2 className="text-base font-semibold text-foreground">分集资产配置</h2>
                <p className="mt-1 text-xs text-muted-foreground">逐段核对人物、环境与道具，查看镜头配置和当前请求使用的参考图。</p>
                <p className="mt-1 text-[11px] text-muted-foreground">选择一集读取配置 · 共 {episodes.length} 集</p>
            </div>

            {episodes.length > 0 && (
                <nav aria-label="选择核查的集" className="thin-scrollbar mb-4 flex flex-wrap gap-2">
                    {episodes.map((ep) => {
                        const active = ep.id === auditEp;
                        return (
                            <button key={ep.id} type="button" data-audit-episode aria-pressed={active} onClick={() => { setAuditEp(ep.id); setPreview(null); }}
                                className={cn("min-w-[150px] rounded-lg border px-3 py-2 text-left text-xs transition",
                                    active ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card/40 text-muted-foreground hover:bg-muted/60")}>
                                <span className="block font-medium">第 {ep.no} 集 · {ep.title || "未命名"}</span>
                                <span className="mt-0.5 block text-[10px] opacity-80">{ep.shotCount} 个镜头 · {active ? "当前核查" : "点击查看"}</span>
                            </button>
                        );
                    })}
                </nav>
            )}

            {!episodes.length ? (
                <div data-audit-empty className="py-10 text-center">
                    <div className="text-sm font-medium text-foreground">还没有可核查的分集</div>
                    <p className="mt-1 text-xs text-muted-foreground">完成分集与分镜后，可在这里核对每一段的资产配置。</p>
                </div>
            ) : error && !usage ? (
                <div data-audit-error role="alert" className="py-10 text-center">
                    <CircleAlert className="mx-auto mb-2 size-5 text-amber-600" />
                    <div className="text-sm font-medium text-foreground">本集资产配置读取失败</div>
                    <p className="mt-1 text-xs text-muted-foreground">{error}</p>
                    <button type="button" data-audit-refresh onClick={onRefresh} className="mt-3 rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-muted/60">重试</button>
                </div>
            ) : !usage || (loading && !usage) ? (
                <div data-audit-loading className="py-10 text-center">
                    <div className="text-xs text-foreground">正在读取第 {selected?.no ?? "—"} 集的资产配置</div>
                    <p className="mt-1 text-[11px] text-muted-foreground">尚未读取的集不会记为零资产。</p>
                </div>
            ) : (
                <>
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                        <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索本集资产" placeholder="搜索本集资产"
                            className="h-8 w-48 rounded-md border border-border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground" />
                        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="资产类型">
                            {filters.map((f) => (
                                <button key={f.key} type="button" aria-pressed={kindFilter === f.key} onClick={() => setKindFilter(f.key)}
                                    className={cn("h-8 rounded-md px-2.5 text-xs transition",
                                        kindFilter === f.key ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted/60")}>
                                    {f.label}<span className="ml-1 opacity-60">{f.count}</span>
                                </button>
                            ))}
                        </div>
                        <button type="button" aria-pressed={onlyPending} onClick={() => setOnlyPending((v) => !v)}
                            className={cn("flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition",
                                onlyPending ? "border-amber-500/50 bg-amber-500/10 text-amber-600" : "border-border text-muted-foreground hover:bg-muted/60")}>
                            <AlertCircle className="size-3.5" /> 只看待核查
                        </button>
                        <button type="button" data-audit-refresh onClick={onRefresh} disabled={loading}
                            className="ml-auto flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition hover:bg-muted/60 disabled:opacity-50">
                            <RotateCcw className="size-3.5" /> 刷新
                        </button>
                    </div>

                    {notice ? (
                        <div data-audit-notice role="alert" className="mb-3 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
                            <AlertCircle className="size-4" />
                            <span>刷新失败，以下为上次读取的配置：{notice}</span>
                            <button type="button" onClick={onRefresh} className="ml-auto shrink-0 rounded border border-current px-2 py-0.5">重试</button>
                        </div>
                    ) : null}
                    {usage.warnings.length ? (
                        <div data-audit-warning role="alert" className="mb-3 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
                            <AlertCircle className="mt-0.5 size-4 shrink-0" />
                            <div>{usage.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>
                        </div>
                    ) : null}
                    <p className="mb-4 text-[11px] text-muted-foreground">
                        以下展示当前配置；历史视频可能使用了不同版本的参考图。未附图的原因请进入对应剧情段查看。
                    </p>

                    {shown.map((seg) => (
                        <section key={seg.id} aria-label={`第 ${seg.index + 1} 段资产配置`} data-audit-segment className="mb-3 overflow-hidden rounded-lg border border-border bg-card/50">
                            <header className="flex items-start gap-3 border-b border-border px-3 py-2.5">
                                <span className="mt-0.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{String(seg.index + 1).padStart(2, "0")}</span>
                                <div className="min-w-0 flex-1">
                                    <h3 className="truncate text-sm font-medium text-foreground">{seg.title}</h3>
                                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                                        {seg.shotCount} 个镜头 · {seg.durationLabel}{seg.pendingCount ? ` · ${seg.pendingCount} 项待核查` : ""}
                                    </div>
                                </div>
                                <button type="button" data-audit-open-segment
                                    onClick={() => onOpenSegment(auditEp, seg.id)}
                                    className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground">
                                    进入剧情段 <ArrowUpRight className="size-3.5" />
                                </button>
                            </header>
                            <div className="divide-y divide-border">
                                {seg.visibleAssets.map((a) => <AuditAssetRowView key={`${seg.id}:${a.assetId}`} asset={a} onOpenCast={onOpenCast} onPreview={setPreview} />)}
                            </div>
                            {seg.shots.length ? (
                                <details className="group border-t border-border px-3 py-2">
                                    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                                        <Clapperboard className="size-4" /> 查看 {seg.shotCount} 个镜头的资产配置 <ChevronDown className="size-4" />
                                    </summary>
                                    <div className="mt-2"><AuditShotsView shots={seg.shots} onOpenCast={onOpenCast} /></div>
                                </details>
                            ) : null}
                        </section>
                    ))}

                    {usage.unassignedShots.length ? (
                        <section data-audit-unassigned className="mb-3 overflow-hidden rounded-lg border border-amber-500/30 bg-card/50">
                            <header className="flex items-start gap-3 border-b border-border px-3 py-2.5">
                                <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                                <div className="min-w-0 flex-1">
                                    <h3 className="text-sm font-medium text-foreground">{usage.unassignedShots.length} 个镜头尚未关联剧情段</h3>
                                    <p className="mt-0.5 text-[11px] text-muted-foreground">保留镜头资产供核查，尚无可对照的段参考请求。</p>
                                </div>
                            </header>
                            <div className="p-3"><AuditShotsView shots={usage.unassignedShots} onOpenCast={onOpenCast} /></div>
                        </section>
                    ) : null}

                    {!shown.length && !usage.unassignedShots.length ? (
                        usage.segments.length ? (
                            <div data-audit-no-results className="py-10 text-center">
                                <div className="text-sm font-medium text-foreground">没有符合筛选的资产</div>
                                <button type="button" onClick={resetFilters} className="mt-2 rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground">清除筛选</button>
                            </div>
                        ) : (
                            <div data-audit-empty className="py-10 text-center">
                                <div className="text-sm font-medium text-foreground">本集还没有分镜资产配置</div>
                                <p className="mt-1 text-xs text-muted-foreground">剧本与分镜生成后，这里会显示每一段的角色、环境、道具和参考素材。</p>
                            </div>
                        )
                    ) : null}
                </>
            )}
            <Modal open={Boolean(preview)} onCancel={() => setPreview(null)} footer={null} width="min(90vw, 1100px)" centered destroyOnHidden data-audit-preview>
                {preview?.storageKey ? <img src={backendMediaUrl(preview.storageKey)} alt={`${preview.name} 参考图`} className="max-h-[80vh] w-full object-contain" /> : null}
                <p className="mt-2 text-center text-xs text-muted-foreground">{preview?.name || ""} · 参考图放大查看</p>
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
    const [verLeft, setVerLeft] = useState<number | null>(null);
    const [verRight, setVerRight] = useState<number | null>(null);
    const [verLoading, setVerLoading] = useState(false);
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
    }, [episodes, productionOf]);

    // 跟随制作台当前选集：URL episodeId 变化时两个子视图一起切过去；
    // 用户在子视图里手动点集（只改本地 state、不改 URL）不会被拉回，仍可独立查看其它集。
    const urlEpisodeId = urlSelectedEpisodeId();
    const lastSyncedUrlEp = useRef<string | null>(null);
    useEffect(() => {
        if (!episodes.length) return;
        if (lastSyncedUrlEp.current === urlEpisodeId) return;
        lastSyncedUrlEp.current = urlEpisodeId;
        const selected = episodes.find((ep) => ep.id === urlEpisodeId);
        const fallback = episodes[0].id;
        setAuditEp(selected ? selected.id : fallback);
        setVerEp(selected ? selected.id : fallback);
    }, [urlEpisodeId, episodes]);

    // 切换剧集/子视图时清掉「已读到真值」标记；刷新 tick 不会触发，失败时仍保留上次数据。
    useEffect(() => { setAuditHasData(false); }, [auditEp, sub]);

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
        void fetchProductionSharedAssets(verEp as ProductionTarget)
            .then((r) => { if (!disposed) setAssetVersions(r.versions || []); })
            .catch(() => { if (!disposed) setAssetVersions([]); });
        return () => { disposed = true; };
    }, [sub, verEp]);

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
                <StudioCastPanel dramaId={dramaId} sharedAssetCanvasId={sharedAssetCanvasId} sources={castSources} artStyle={artStyle} onOpenCanvas={onOpenCanvas} onOpenSharedCanvas={onOpenSharedCanvas} onChanged={onChanged} voiceProfiles={voiceProfiles} initialKind={initialKind} focusAsset={focusAsset} />
            ) : sub === "audit" ? (
                <EpisodeAuditView
                    episodes={episodes}
                    auditEp={auditEp}
                    setAuditEp={setAuditEp}
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
                        <select value={verEp} onChange={(e) => setVerEp(e.target.value)}
                            className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none">
                            {episodes.map((ep) => <option key={ep.id} value={ep.id}>第 {ep.no} 集 · {ep.title}</option>)}
                        </select>
                        <span className="ml-auto text-[11px] text-muted-foreground">发布/回滚会写制作稿 revision</span>
                    </div>
                    {verLoading ? (
                        <div className="py-10 text-center text-xs text-muted-foreground">读取版本记录…</div>
                    ) : versions.length ? (
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
                                            <div className="mt-2 flex flex-wrap gap-1">
                                                {impactSummary(v?.impact || {}).map((part, i) => (
                                                    <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{part}</span>
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            {/* 单资产版本记录：drama_asset_versions 真实数据 */}
                            {assetVersions.length ? (
                                <div className="mt-5 border-t border-border pt-4">
                                    <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
                                        <History className="size-3.5 text-muted-foreground" /> 单资产版本记录
                                        <span className="font-normal text-muted-foreground">共 {assetVersions.length} 条 · 角色/场景/道具的历次采用</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
                                        {assetVersions.map((v) => (
                                            <div key={v.id} className="flex items-center gap-2 rounded-lg border border-border bg-card/40 p-2">
                                                <img src={backendMediaUrl(v.storageKey)} alt={v.snapshot?.title || v.assetId} className="size-12 shrink-0 rounded object-cover" loading="lazy" />
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-[11px] font-medium" title={v.snapshot?.title || v.assetId}>{v.snapshot?.title || v.assetId}</div>
                                                    <div className="mt-0.5 text-[10px] text-muted-foreground">v{v.sourceVersion} · {v.reviewStatus === "approved" ? "已审阅" : "未审阅"}</div>
                                                    <div className="truncate text-[10px] text-muted-foreground" title={v.createdAt}>{v.createdAt ? new Date(v.createdAt).toLocaleString() : ""}</div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ) : null}
                        </>
                    ) : assetVersions.length ? (
                        // 无整集版本但有单资产版本时也要展示
                        <div className="mt-2">
                            <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
                                <History className="size-3.5 text-muted-foreground" /> 单资产版本记录
                                <span className="font-normal text-muted-foreground">共 {assetVersions.length} 条 · 角色/场景/道具的历次采用</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
                                {assetVersions.map((v) => (
                                    <div key={v.id} className="flex items-center gap-2 rounded-lg border border-border bg-card/40 p-2">
                                        <img src={backendMediaUrl(v.storageKey)} alt={v.snapshot?.title || v.assetId} className="size-12 shrink-0 rounded object-cover" loading="lazy" />
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-[11px] font-medium" title={v.snapshot?.title || v.assetId}>{v.snapshot?.title || v.assetId}</div>
                                            <div className="mt-0.5 text-[10px] text-muted-foreground">v{v.sourceVersion} · {v.reviewStatus === "approved" ? "已审阅" : "未审阅"}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <div className="py-10 text-center text-xs text-muted-foreground">本集还没有发布版本。在分镜改编里点「写稿」发布后会出现版本记录。</div>
                    )}
                </div>
            )}
        </div>
    );
}
