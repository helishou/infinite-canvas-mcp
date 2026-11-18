import { useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { Package, History, CheckCircle2, CircleAlert, RotateCcw, ArrowLeftRight, ClipboardList } from "lucide-react";

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
import { StudioCastPanel, type AssetProduction, type CastSource } from "./studio-cast-panel";

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

/* ------------------------------------------------------------------ *
 * 按集核查（对齐影策 project-asset-audit）：全部取自当前集制作稿真值。
 * ------------------------------------------------------------------ */

type AuditKind = "character" | "scene" | "prop" | "image";
type AuditStatus = "随当前请求发送" | "本次请求不附图" | "未选为本段参考" | "缺少参考图" | "资产已缺失";

type AuditAssetRow = {
    assetId: string;
    name: string;
    kind: AuditKind;
    status: AuditStatus;
    refLabel: string;
    shotCount: number;
};
type AuditShotRow = {
    id: string;
    description: string;
    durationLabel: string;
    chips: Array<{ assetId: string; name: string; kind: AuditKind }>;
};
type AuditSegment = {
    id: string;
    title: string;
    shotCount: number;
    durationLabel: string;
    pendingCount: number;
    assets: AuditAssetRow[];
    shots: AuditShotRow[];
};

// 只把「对象」当行：注意 segments.shot_ids 是字符串数组，不能用 rows() 读。
const auditRows = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x)) : [];
const auditStr = (v: unknown): string => (typeof v === "string" || typeof v === "number") ? String(v) : "";

function auditDuration(frames: number): string {
    const total = Math.max(0, Math.round(frames / 24));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function auditKind(raw: string): AuditKind {
    const k = raw.toLowerCase();
    if (k === "scene" || k === "environment" || k === "场景" || k === "环境") return "scene";
    if (k === "prop" || k === "道具") return "prop";
    if (k === "image" || k === "附加素材") return "image";
    return "character";
}

const AUDIT_KIND_LABEL: Record<AuditKind, string> = {
    character: "角色", scene: "环境", prop: "道具", image: "附加素材",
};
const AUDIT_KIND_CLASS: Record<AuditKind, string> = {
    character: "bg-blue-500/10 text-blue-500",
    scene: "bg-emerald-500/10 text-emerald-500",
    prop: "bg-purple-500/10 text-purple-500",
    image: "bg-slate-500/10 text-slate-400",
};
const auditStatusClass = (status: AuditStatus): string => status === "随当前请求发送"
    ? "bg-emerald-500/10 text-emerald-500"
    : "bg-amber-500/10 text-amber-600";

/** 用制作稿真值构建「段 → 资产 / 镜头」核查视图。 */
function buildAuditSegments(source: Record<string, unknown> | null, assets: Record<string, unknown>): AuditSegment[] {
    const src = source || {};
    const shotById = new Map<string, Record<string, unknown>>();
    for (const s of auditRows(src.shots)) shotById.set(auditStr(s.id), s);

    const sceneName = new Map<string, string>();
    for (const sc of auditRows(src.scene_registry)) {
        sceneName.set(auditStr(sc.id), auditStr(sc.name || sc.scene_name || sc.id));
    }

    const planById = new Map<string, Record<string, unknown>>();
    for (const p of auditRows(src.asset_plan)) planById.set(auditStr(p.id), p);
    const planIds = new Set(planById.keys());

    // subjectId → assetId：优先用 subject_registry 的 pictureBindings（角色 SUB-AC-CHONGLIANG → AC-CHAR-CHONGLIANG）
    const subjectToAsset = new Map<string, string>();
    for (const s of auditRows(src.subject_registry)) {
        for (const b of auditRows(s.pictureBindings)) {
            const aid = auditStr(b.assetId).split(":")[0];
            if (aid && planIds.has(aid)) { subjectToAsset.set(auditStr(s.id), aid); break; }
        }
    }
    const resolveAssetId = (subjectId: string): string => {
        if (subjectToAsset.has(subjectId)) return subjectToAsset.get(subjectId)!;
        const stripped = subjectId.startsWith("SUB-") ? subjectId.slice(4) : subjectId;
        if (planIds.has(stripped)) return stripped;
        const tail = stripped.replace(/^AC-(CHAR|SCENE|PROP|IMAGE)-/, "");
        return [...planIds].find((id) => tail.length > 0 && id.endsWith(tail)) || stripped;
    };

    const out: AuditSegment[] = [];
    for (const seg of auditRows(src.segments)) {
        const rawIds = Array.isArray(seg.shot_ids) ? seg.shot_ids : [];
        const segShots = rawIds.map((id) => shotById.get(auditStr(id)))
            .filter((s): s is Record<string, unknown> => Boolean(s));

        // assetId → 该段内出现的镜头数（同一镜头多次引用只计一次）
        const useCount = new Map<string, number>();
        for (const shot of segShots) {
            const inShot = new Set<string>();
            for (const u of auditRows(shot.subject_usages)) {
                const aid = resolveAssetId(auditStr(u.subjectId));
                if (aid && !inShot.has(aid)) { inShot.add(aid); useCount.set(aid, (useCount.get(aid) || 0) + 1); }
            }
        }

        const assetRows: AuditAssetRow[] = [];
        let ref = 0;
        for (const [aid, count] of useCount) {
            ref += 1;
            const p = planById.get(aid) || {};
            const storageKey = auditStr((assets[aid] as Record<string, unknown> | undefined)?.storageKey);
            assetRows.push({
                assetId: aid,
                name: auditStr(p.asset_name || p.name || p.id) || aid,
                kind: auditKind(auditStr(p.kind || p.asset_type)),
                status: storageKey ? "随当前请求发送" : "本次请求不附图",
                refLabel: `参考图${ref}`,
                shotCount: count,
            });
        }

        const shots: AuditShotRow[] = segShots.map((shot) => {
            const chips: AuditShotRow["chips"] = [];
            const seen = new Set<string>();
            for (const u of auditRows(shot.subject_usages)) {
                const aid = resolveAssetId(auditStr(u.subjectId));
                if (!aid || seen.has(aid)) continue;
                seen.add(aid);
                const p = planById.get(aid) || {};
                chips.push({
                    assetId: aid,
                    name: auditStr(p.asset_name || p.name || p.id) || aid,
                    kind: auditKind(auditStr(p.kind || p.asset_type)),
                });
            }
            return {
                id: auditStr(shot.id),
                description: auditStr(shot.visual || shot.title),
                durationLabel: auditDuration(Number(shot.duration_frames) || 0),
                chips,
            };
        });

        const first = segShots[0] || {};
        const title = [sceneName.get(auditStr(first.scene_id)), auditStr(first.title)].filter(Boolean).join(" / ") || auditStr(seg.id);
        const frames = segShots.reduce((sum, s) => sum + (Number(s.duration_frames) || 0), 0);
        out.push({
            id: auditStr(seg.id),
            title,
            shotCount: segShots.length,
            durationLabel: auditDuration(frames),
            pendingCount: assetRows.filter((a) => a.status !== "随当前请求发送").length,
            assets: assetRows,
            shots,
        });
    }
    return out;
}

/** 影策「项目资产 / 按集核查」形态：剧集按钮组 + 工具栏 + 剧情段卡片 + 可折叠镜头明细。 */
function EpisodeAuditView({ episodes, auditEp, setAuditEp, source, assets, loading, onOpenCanvas }: {
    episodes: StudioEpisode[];
    auditEp: string;
    setAuditEp: (id: string) => void;
    source: Record<string, unknown> | null;
    assets: Record<string, unknown>;
    loading: boolean;
    onOpenCanvas: () => void;
}) {
    const [query, setQuery] = useState("");
    const [kindFilter, setKindFilter] = useState<"all" | AuditKind>("all");
    const [onlyPending, setOnlyPending] = useState(false);

    const segments = useMemo(() => buildAuditSegments(source, assets), [source, assets]);
    const allAssets = useMemo(() => {
        const map = new Map<string, AuditAssetRow>();
        for (const seg of segments) for (const a of seg.assets) if (!map.has(a.assetId)) map.set(a.assetId, a);
        return [...map.values()];
    }, [segments]);
    const counts = useMemo(() => {
        const c: Record<AuditKind, number> = { character: 0, scene: 0, prop: 0, image: 0 };
        for (const a of allAssets) c[a.kind] += 1;
        return c;
    }, [allAssets]);

    const filters: Array<{ key: "all" | AuditKind; label: string; count: number }> = [
        { key: "all", label: "全部", count: allAssets.length },
        { key: "character", label: "角色", count: counts.character },
        { key: "scene", label: "环境", count: counts.scene },
        { key: "prop", label: "道具", count: counts.prop },
        { key: "image", label: "附加素材", count: counts.image },
    ];

    const q = query.trim().toLowerCase();
    const shown = segments.map((seg) => ({
        ...seg,
        visibleAssets: seg.assets.filter((a) =>
            (kindFilter === "all" || a.kind === kindFilter) &&
            (!q || a.name.toLowerCase().includes(q) || a.assetId.toLowerCase().includes(q)) &&
            (!onlyPending || a.status !== "随当前请求发送")),
    })).filter((seg) => seg.visibleAssets.length > 0);

    return (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <div className="mb-4">
                <h2 className="text-base font-semibold text-foreground">分集资产配置</h2>
                <p className="mt-1 text-xs text-muted-foreground">逐段核对人物、环境与道具，查看镜头配置和当前请求使用的参考图。</p>
            </div>

            {episodes.length > 0 && (
                <div className="mb-4 flex flex-wrap gap-2">
                    {episodes.map((ep) => {
                        const active = ep.id === auditEp;
                        return (
                            <button key={ep.id} type="button" onClick={() => setAuditEp(ep.id)}
                                className={cn("min-w-[150px] rounded-lg border px-3 py-2 text-left text-xs transition",
                                    active ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card/40 text-muted-foreground hover:bg-muted/60")}>
                                <div className="font-medium">第 {ep.no} 集 · {ep.title}</div>
                                <div className="mt-0.5 text-[10px] opacity-80">{ep.shotCount} 个镜头 · {active ? "当前核查" : "点击查看"}</div>
                            </button>
                        );
                    })}
                </div>
            )}

            <div className="mb-3 flex flex-wrap items-center gap-2">
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索本集资产"
                    className="h-8 w-48 rounded-md border border-border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground" />
                <div className="flex flex-wrap items-center gap-1">
                    {filters.map((f) => (
                        <button key={f.key} type="button" onClick={() => setKindFilter(f.key)}
                            className={cn("h-8 rounded-md px-2.5 text-xs transition",
                                kindFilter === f.key ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted/60")}>
                            {f.label}{f.count}
                        </button>
                    ))}
                </div>
                <button type="button" onClick={() => setOnlyPending((v) => !v)}
                    className={cn("ml-auto flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition",
                        onlyPending ? "border-amber-500/50 bg-amber-500/10 text-amber-600" : "border-border text-muted-foreground hover:bg-muted/60")}>
                    <span className={cn("inline-block size-2 rounded-full", onlyPending ? "bg-amber-500" : "bg-muted-foreground/40")} />
                    只看待核查
                </button>
            </div>

            <p className="mb-4 text-[11px] text-muted-foreground">
                以下展示当前配置；历史视频可能使用了不同版本的参考图。未附图的原因请进入对应剧情段查看。
            </p>

            {loading ? (
                <div className="py-10 text-center text-xs text-muted-foreground">读取本集制作稿…</div>
            ) : shown.length ? (
                <div className="space-y-3">
                    {shown.map((seg, idx) => (
                        <div key={seg.id} className="overflow-hidden rounded-lg border border-border bg-card/50">
                            <div className="flex items-start gap-3 border-b border-border px-3 py-2.5">
                                <span className="mt-0.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                                    {String(idx + 1).padStart(2, "0")}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium text-foreground">{seg.title}</div>
                                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                                        {seg.shotCount} 个镜头 · {seg.durationLabel} · {seg.pendingCount} 项待核查
                                    </div>
                                </div>
                                <button type="button" onClick={onOpenCanvas}
                                    className="shrink-0 rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground">
                                    进入剧情段 →
                                </button>
                            </div>

                            <div className="divide-y divide-border">
                                {seg.visibleAssets.map((a) => (
                                    <div key={a.assetId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                                        <span className="min-w-0 flex-1 truncate text-foreground">{a.name}</span>
                                        <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px]", AUDIT_KIND_CLASS[a.kind])}>{AUDIT_KIND_LABEL[a.kind]}</span>
                                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{a.refLabel}</span>
                                        <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px]", auditStatusClass(a.status))}>{a.status}</span>
                                        <span className="shrink-0 text-[10px] text-muted-foreground">关联 {a.shotCount} 个镜头</span>
                                    </div>
                                ))}
                            </div>

                            <details className="group border-t border-border px-3 py-2">
                                <summary className="cursor-pointer list-none text-[11px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                                    查看 {seg.shotCount} 个镜头的资产配置
                                </summary>
                                <div className="mt-2 space-y-2">
                                    {seg.shots.map((shot, si) => (
                                        <div key={`${shot.id}-${si}`} className="rounded-md border border-border bg-background/40 p-2">
                                            <div className="flex items-center gap-2 text-[11px]">
                                                <span className="font-medium text-foreground">镜头 {si + 1}</span>
                                                <span className="truncate text-muted-foreground">{shot.description}</span>
                                                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{shot.durationLabel}</span>
                                            </div>
                                            <div className="mt-1.5 flex flex-wrap gap-1">
                                                {shot.chips.map((chip) => (
                                                    <span key={chip.assetId} className={cn("rounded px-1.5 py-0.5 text-[10px]", AUDIT_KIND_CLASS[chip.kind])}>{chip.name}</span>
                                                ))}
                                                {shot.chips.length === 0 && <span className="text-[10px] text-muted-foreground">无引用资产</span>}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </details>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="py-10 text-center text-xs text-muted-foreground">
                    {source ? "没有符合筛选条件的剧情段或资产。" : "本集还没有可核查的制作稿（无 segments / shots）。"}
                </div>
            )}
        </div>
    );
}

export function StudioAssetsTab({ sharedAssetCanvasId, artStyle, episodes, loading, onOpenCanvas, onChanged, productionOf, onExtractAssets, initialSub, voiceProfiles }: {
    sharedAssetCanvasId: string | null;
    artStyle: string;
    episodes: StudioEpisode[];
    loading: boolean;
    onOpenCanvas: () => void;
    onChanged: () => void;
    /** 制作设置音色库，透传给角色声音选择（真实绑定 character.voice）。 */
    voiceProfiles?: Array<{ id: string; name: string; description: string; sampleRef: string }>;
    /** 读某集制作稿（source + revision），由页面传入，复用已有 query 缓存思路。 */
    productionOf: (episodeId: string) => Promise<AssetProduction | null>;
    /** 影策资产段：从本集剧本提取设定并建档，返回新建数量。 */
    onExtractAssets?: (episodeId: string) => Promise<number>;
    /** 外部指定初始子视图（段编辑弹窗「按集核查」直达 audit）。 */
    initialSub?: SubView;
}) {
    const { message } = App.useApp();
    const [sub, setSub] = useState<SubView>(initialSub || "library");
    useEffect(() => { if (initialSub) setSub(initialSub); }, [initialSub]);
    const [extractEp, setExtractEp] = useState("");
    const [extracting, setExtracting] = useState(false);
    const [auditEp, setAuditEp] = useState<string>("");
    const [auditSource, setAuditSource] = useState<Record<string, unknown> | null>(null);
    const [auditAssets, setAuditAssets] = useState<Record<string, unknown>>({});
    const [auditLoading, setAuditLoading] = useState(false);
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
                assets: prod?.assets || {}, assetCards: prod?.assetCards || [],
            } as CastSource;
        }))
            .then(list => { if (!disposed) setCastSources(list); });
        return () => { disposed = true; };
    }, [episodes, productionOf]);

    useEffect(() => { if (!auditEp && episodes.length) setAuditEp(episodes[0].id); }, [episodes, auditEp]);
    useEffect(() => { if (!verEp && episodes.length) setVerEp(episodes[0].id); }, [episodes, verEp]);

    // 按集核查：拉该集制作稿 source
    useEffect(() => {
        let disposed = false;
        if (sub !== "audit" || !auditEp) return;
        setAuditLoading(true);
        void productionOf(auditEp).then((prod) => {
            if (!disposed) {
                setAuditSource(prod?.source || null);
                setAuditAssets(prod?.assets || {});
            }
        })
            .finally(() => { if (!disposed) setAuditLoading(false); });
        return () => { disposed = true; };
    }, [sub, auditEp, productionOf]);

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
                <StudioCastPanel sharedAssetCanvasId={sharedAssetCanvasId} sources={castSources} artStyle={artStyle} onOpenCanvas={onOpenCanvas} onChanged={onChanged} voiceProfiles={voiceProfiles} />
            ) : sub === "audit" ? (
                <EpisodeAuditView
                    episodes={episodes}
                    auditEp={auditEp}
                    setAuditEp={setAuditEp}
                    source={auditSource}
                    assets={auditAssets}
                    loading={auditLoading}
                    onOpenCanvas={onOpenCanvas}
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
                                                {v ? <button type="button" disabled={restoring} onClick={() => void handleRestore(v.version)}
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
