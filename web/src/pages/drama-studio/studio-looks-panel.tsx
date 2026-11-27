import { useEffect, useMemo, useRef, useState } from "react";
import { App, InputNumber, Modal, Switch } from "antd";
import { Shirt, RefreshCw, Plus, Trash2, Play, Upload, Library, Sparkles, Lock, AlertCircle, Check } from "lucide-react";

import {
    fetchBackendProject,
    fetchBackendDramaEpisode,
    applyBackendCanvasOperations,
    backendMediaUrl,
    backendThumbUrl,
    fetchDramaCastImpact,
    restyleDramaCast,
    startCanvasGeneration,
    fetchBackendTask,
    fetchBackendGenerationLogs,
    type BackendGenerationLog,
} from "@/services/backend-api";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore, type ImageAsset } from "@/stores/use-asset-store";
import { resolveModelForCapability, useConfigStore } from "@/stores/use-config-store";
import { nanoid } from "nanoid";
import { cn } from "@/lib/utils";
import { withArtStyle } from "@basketikun/canvas-agent/drama/art-style";
import { artStyleOptions } from "@/pages/drama/planning-topic-logic";

/**
 * 剧目级造型——真值在画布角色节点 metadata.characterImages[]，不在别处另建副本。
 * 读取范围：共享资产画布 + 各集制作画布（本剧角色节点在分集画布上，共享画布只有 image 节点）。
 * 新增/改名/换图/删除走后端现成的画布 update_node op（metadata.characterImages 整体替换），
 * 不造假 CRUD；造型图模型生成仍引导到画布精修，素材库/自定义图可就地写回。
 */
type LookImage = {
    storageKey: string;
    url?: string;
    outfit?: string;
    outfitDescription?: string;
    name?: string;
    role?: string;
    width?: number;
    height?: number;
    fromChapter?: number;
    toChapter?: number;
    id?: string;
    /** 影策别名归一：该造型图来源节点（多节点聚合成一个角色时按来源分别写回，不混写）。 */
    _srcNodeId?: string;
    _srcCanvasId?: string;
    _srcRevision?: number;
    _srcCastId?: string;
    /** 面板内生成或上传自定义图后置位：重新生成需先解锁（对齐影策 look.locked）。 */
    locked?: boolean;
    /** 造型图状态层：由 generation_logs 按产物 storageKey 派生（跨刷新真值），对齐影策 drama_cast.image_status。 */
    status?: "queued" | "running" | "failed" | "ready";
    error?: string;
    generationLogId?: string;
    /** 影策 CastImageFields：单独风格与参考图生成提示词，真值与 outfit 一起存在画布 characterImages[]。 */
    imageStyleId?: string;
    imageStyleName?: string;
    imageStylePrompt?: string;
    imagePrompt?: string;
};
type LookStatus = NonNullable<LookImage["status"]>;
type LookStatusInfo = { status: LookStatus; error?: string; generationLogId?: string };
/** 一条造型形象图的历史版本：真值来自 generation_logs（同产物 storageKey 的多条日志），不编造版本号。 */
type LookVersion = { id: string; createdAt: string; status: string; model: string };
/** 版本行日期：与影策「11月17日」同粒度（月日，本地时区）。 */
function versionDate(value: string) {
    const time = new Date(value);
    if (!value || Number.isNaN(time.getTime())) return "—";
    return `${time.getMonth() + 1}月${time.getDate()}日`;
}
/** generation_logs.status → 造型图状态；success 即 ready，cancelled 按失败处理。 */
function toLookStatusInfo(log: BackendGenerationLog): LookStatusInfo {
    const status: LookStatus = log.status === "success" ? "ready"
        : log.status === "failed" || log.status === "cancelled" ? "failed"
            : log.status === "running" ? "running" : "queued";
    return {
        status,
        ...(log.error ? { error: String(log.error) } : {}),
        generationLogId: log.id,
    };
}
/** 即时态与日志真值合并：本地 running/queued/failed 与日志里的非 ready 态优先；旧 ready 不盖住真值失败。 */
function mergeLookStatus(instant?: LookStatusInfo, derived?: LookStatusInfo): LookStatusInfo | undefined {
    if (instant?.status === "running" || instant?.status === "queued" || instant?.status === "failed") return instant;
    if (derived?.status === "failed" || derived?.status === "running" || derived?.status === "queued") return derived;
    return instant || derived;
}
/** 即时状态键：优先稳定 id，其次 storageKey，最后 castId+index（仅内存态，不写画布）。 */
function lookStateKey(im: LookImage, castId: string, index: number) {
    return im.id || im.storageKey || `${castId}:idx-${index}`;
}
type CharacterLook = {
    castId: string;
    castName: string;
    description: string;
    images: LookImage[];
    primaryIndex: number;
    canvasId: string;
    nodeId: string;
    canvasRevision: number;
    source: string;
    /** 影策别名归一：本节点声明的规范名/别名/造型归属（用于把多形态节点并到主卡）。 */
    canonicalName?: string;
    aliases?: string[];
    lookOf?: string;
    /** 影策别名归一：共享节点的生产资产 ID，作为共享身份索引键之一。 */
    productionAssetId?: string;
};
type LookForm = {
    name: string;
    appearance: string;
    from: string;
    to: string;
    storageKey: string;
    url: string;
    role: string;
    /** 影策 CastImageFields：单独风格开关与风格/提示词字段。 */
    hasOwnStyle: boolean;
    imageStyleId: string;
    imageStyleName: string;
    imageStylePrompt: string;
    imagePrompt: string;
};
const emptyForm: LookForm = { name: "", appearance: "", from: "", to: "", storageKey: "", url: "", role: "", hasOwnStyle: false, imageStyleId: "", imageStyleName: "", imageStylePrompt: "", imagePrompt: "" };
const MAX_EXTRA_LOOKS = 6;
const styleSlug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "custom";

function chapterLabel(from?: number, to?: number) {
    if (from && to) return `第 ${from}–${to} 章`;
    if (from) return `第 ${from} 章起`;
    if (to) return `第 ${to} 章前`;
    return "不限章节";
}

/**
 * 造型缩略图状态层（对齐影策 drama-look-thumb）：locked 来自画布 metadata.characterImages；
 * busy 来自 queued/running 真值或面板内 generatingIndex；failed 来自 generation_logs 派生状态
 * 或本面板内失败的即时反馈（error 只作 title，不编造日志文本）。
 */
function LookThumbStates({ locked, busy, failed, error }: { locked?: boolean; busy?: boolean; failed?: boolean; error?: string }) {
    return (
        <>
            {busy ? (
                <span className="studio-look-busy pointer-events-none absolute inset-0 bg-[length:200%_100%] bg-gradient-to-tr from-transparent via-primary/30 to-transparent" style={{ animation: "studio-look-shimmer 1.3s linear infinite" }} role="status" aria-label="造型图生成中" />
            ) : null}
            {failed ? (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-rose-500/15 text-rose-500"
                    title={error ? `造型图失败，可重试：${error}` : "造型图失败，可重试"} role="status" aria-label="造型图失败，可重试">
                    <AlertCircle className="size-4" />
                </span>
            ) : null}
            {locked ? (
                <span className="pointer-events-none absolute bottom-0.5 right-0.5 flex size-4 items-center justify-center rounded-[4px] bg-background/90 text-foreground shadow-sm" title="自定义图已锁定" aria-label="自定义图已锁定">
                    <Lock className="size-2.5" />
                </span>
            ) : null}
        </>
    );
}

export function StudioLooksPanel({ dramaId, sharedAssetCanvasId, episodeIds, focusLook, onOpenCanvas, onCountChange, artStyle }: {
    /** 剧目 ID：单设定 restyle 影响集查询/提交必须带它，null 时只保留诚实提示。 */
    dramaId: string | null;
    sharedAssetCanvasId: string | null;
    episodeIds?: string[];
    /** 角色卡造型缩略图点进来的定位目标：lookId/storageKey 是画布真值身份，seq 变化即重新定位。 */
    focusLook?: { castId?: string; castName?: string; lookId?: string; storageKey?: string; seq: number } | null;
    onOpenCanvas: () => void;
    /** 汇报剧目级额外妆造总数（每个角色本体之外），供分类 tab 显示真实计数。 */
    onCountChange?: (count: number) => void;
    /** 剧目规划 topic.artStyle 真值：只有确有值时卡片副标题才写「沿用作品风格」（对齐影策），无真值只写角色名。 */
    artStyle?: string;
}) {
    const { message, modal } = App.useApp();
    const config = useConfigStore((s) => s.config);
    const allAssets = useAssetStore((s) => s.assets);
    const imageAssets = useMemo(() => allAssets.filter((a): a is ImageAsset => a.kind === "image"), [allAssets]);
    const [characters, setCharacters] = useState<CharacterLook[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    /** 锁定开关写回中/写回失败的当前造型：失败只就地报错，不改 UI（刷新后才按真值显示）。 */
    const [lockSaving, setLockSaving] = useState(false);
    const [lockError, setLockError] = useState<{ key: string; message: string } | null>(null);
    const [selectedCast, setSelectedCast] = useState<string>("");
    const [refreshTick, setRefreshTick] = useState(0);
    const [editing, setEditing] = useState<{ castId: string; index: number | null } | null>(null);
    // 造型图放大预览（对齐影策 cast-looks.tsx:134/220「放大查看」）
    const [preview, setPreview] = useState<{ key: string; title: string } | null>(null);
    const [form, setForm] = useState<LookForm>(emptyForm);
    const [restyle, setRestyle] = useState(true);
    const [impact, setImpact] = useState<Awaited<ReturnType<typeof fetchDramaCastImpact>> | null>(null);
    const [impactLoading, setImpactLoading] = useState(false);
    const [impactTick, setImpactTick] = useState(0);
    const [restyleSubmitting, setRestyleSubmitting] = useState(false);
    const [generatingIndex, setGeneratingIndex] = useState<number | null>(null);
    // 造型图状态层：derived 由 generation_logs 按产物 storageKey 派生（跨刷新真值）；
    // instant 只记本面板 generateLook 的即时反馈（新槽位无 storageKey，日志无法按图定位，非跨刷新真值）。
    const [derivedStatuses, setDerivedStatuses] = useState<Record<string, LookStatusInfo>>({});
    const [instantStatuses, setInstantStatuses] = useState<Record<string, LookStatusInfo>>({});
    /** 版本记录真值：按产物 storageKey 命中 generation_logs（同一条链派生状态），不另建版本表。 */
    const [lookVersions, setLookVersions] = useState<Record<string, LookVersion[]>>({});
    /** 「从素材库选择」弹层：复用 pickLibraryImage 的真实素材写入链路。 */
    const [libraryOpen, setLibraryOpen] = useState(false);
    // 造型卡选中态：仅面板内 UI 焦点，不写回画布（对齐影策造型行选中描边反馈）。
    // index=null 表示该角色本体（基础造型）；选中的卡所属角色同时决定右栏上下文。
    const [selectedLook, setSelectedLook] = useState<{ castId: string; index: number | null } | null>(null);
    const customRef = useRef<HTMLInputElement | null>(null);
    /** 已应用的缩略图定位序号：刷新导致 characters 变化时不重复抢选中态。 */
    const appliedFocusSeq = useRef(0);

    const episodeKey = (episodeIds || []).join("|");
    useEffect(() => {
        let disposed = false;
        if (!sharedAssetCanvasId && !episodeKey) return;
        setLoading(true);
        const collect = (project: Record<string, unknown> | null | undefined, fallbackSource: string) => {
            const list: CharacterLook[] = [];
            const nodes = (project?.nodes || []) as Array<Record<string, unknown>>;
            for (const n of nodes) {
                if (n.type !== "character") continue;
                const md = (n.metadata || {}) as Record<string, unknown>;
                const rawImages = (Array.isArray(md.characterImages) ? md.characterImages : []) as LookImage[];
                const entity = (md.productionEntity || {}) as Record<string, unknown>;
                const images = rawImages
                    .filter((im) => im && typeof im === "object" && typeof im.storageKey === "string")
                    .map((im) => ({ ...im, _srcNodeId: String(n.id), _srcCanvasId: String(project?.id || ""), _srcRevision: Number(project?.revision || 0), _srcCastId: String(md.characterAssetId || entity.entityId || n.id) }));
                list.push({
                    castId: String(md.characterAssetId || entity.entityId || n.id),
                    castName: String(md.characterName || n.title || "未命名"),
                    description: String(md.characterDescription || ""),
                    images,
                    primaryIndex: Number(md.characterPrimaryIndex || 0),
                    canvasId: String(project?.id || ""),
                    nodeId: String(n.id),
                    canvasRevision: Number(project?.revision || 0),
                    source: fallbackSource,
                    canonicalName: md.characterCanonicalName ? String(md.characterCanonicalName) : undefined,
                    aliases: Array.isArray(md.characterAliases) ? md.characterAliases.map(String) : undefined,
                    lookOf: md.characterLookOf ? String(md.characterLookOf) : undefined,
                    productionAssetId: md.productionAssetId ? String(md.productionAssetId) : undefined,
                });
            }
            return list;
        };
        const jobs: Promise<CharacterLook[]>[] = [];
        if (sharedAssetCanvasId) jobs.push(fetchBackendProject(sharedAssetCanvasId).then(r => collect(r.project, "共享画布")).catch(() => []));
        for (const epId of episodeIds || []) {
            jobs.push(fetchBackendDramaEpisode(epId).then(r => collect(r.canvas, "分集画布")).catch(() => []));
        }
        Promise.all(jobs)
            .then((groups) => {
                if (disposed) return;
                const all = groups.flat();
                // 影策 aliasKeys 归一：完整名/规范名/别名/形态名统一走归一 key，禁止裸名精确匹配。
                // 与 asset-extract.normalizeAssetName 同款：小写、去「角色：」前缀、去空格与 ·•・._- 分隔；
                // 另去尾部括号限定（崇良（铁鞭武人）→崇良）与形态分支（蟒妻·蟒身→蟒妻）。
                const stripQualifier = (value: string) => String(value || "")
                    .replace(/^角色[：:]\s*/, "")
                    .replace(/[（(][^）)]*[）)]\s*$/, "")
                    .trim();
                const aliasKey = (value: string) => stripQualifier(value).toLocaleLowerCase("zh-CN").replace(/[\s·•・._-]+/g, "");
                const identityKeys = (value?: string) => {
                    const stripped = stripQualifier(value || "");
                    if (!stripped) return [] as string[];
                    return Array.from(new Set([
                        aliasKey(stripped),
                        aliasKey(stripped.split(/[·•・._-]/)[0]),
                    ].filter(Boolean)));
                };
                const keysOf = (c: CharacterLook) => Array.from(new Set([
                    ...identityKeys(c.castName),
                    ...identityKeys(c.canonicalName),
                    ...(c.aliases || []).flatMap(identityKeys),
                    ...(c.productionAssetId ? [`production:${c.productionAssetId}`] : []),
                ].filter(Boolean)));
                // 共享画布身份索引：完整主卡名 ← 其 identityKeys（productionAssetId / canonicalName / aliases / castName）。
                // 先注册主卡，形态节点(lookOf)仅在自身未被任何主卡 key 覆盖时补注册，避免抢注主卡名。
                const shared = all.filter(c => c.source === "共享画布");
                const sharedDisplayByKey = new Map<string, string>();
                const canonicalKeyByDisplay = new Map<string, string>();
                const register = (c: CharacterLook) => {
                    for (const k of keysOf(c)) if (!sharedDisplayByKey.has(k)) sharedDisplayByKey.set(k, c.castName);
                };
                const sharedMain = shared.filter(c => !c.lookOf).sort((a, b) => b.images.length - a.images.length);
                const sharedForms = shared.filter(c => c.lookOf);
                for (const c of sharedMain) { register(c); canonicalKeyByDisplay.set(c.castName, keysOf(c)[0] || ""); }
                for (const c of sharedForms) if (!keysOf(c).some(k => sharedDisplayByKey.has(k))) register(c);
                // 每个角色按归一 key 命中共享主卡，展示名用共享主卡的完整名；未命中的保留自身名。
                const resolved = new Map<CharacterLook, { groupKey: string; displayName: string }>();
                for (const c of all) {
                    const keys = keysOf(c);
                    let groupKey = keys[0] || "";
                    let displayName = c.canonicalName || c.castName;
                    for (const k of keys) {
                        const sharedName = sharedDisplayByKey.get(k);
                        if (sharedName) { groupKey = canonicalKeyByDisplay.get(sharedName) || k; displayName = sharedName; break; }
                    }
                    resolved.set(c, { groupKey, displayName });
                }
                // 按归一 key 分组：每组选一个主卡（优先共享画布 + 造型多），形态节点的图并入主卡且保留来源。
                type Group = { canonical: string; displayName: string; description: string; members: CharacterLook[] };
                const groups2 = new Map<string, Group>();
                for (const c of all) {
                    const { groupKey, displayName } = resolved.get(c)!;
                    let g = groups2.get(groupKey);
                    if (!g) { g = { canonical: groupKey, displayName, description: c.description, members: [] }; groups2.set(groupKey, g); }
                    g.members.push(c);
                }
                const list: CharacterLook[] = [];
                for (const g of groups2.values()) {
                    // 主卡：共享画布优先，其次造型图最多；名称用规范名。
                    const sorted = [...g.members].sort((a, b) =>
                        (b.source === "共享画布" ? 1 : 0) - (a.source === "共享画布" ? 1 : 0) || b.images.length - a.images.length);
                    const primary = sorted[0];
                    // 聚合所有成员的造型图（带 _src 来源），按 storageKey 去重。
                    const mergedImages: LookImage[] = [];
                    const seenKey = new Set<string>();
                    for (const m of sorted) for (const im of m.images) {
                        if (seenKey.has(im.storageKey)) continue;
                        seenKey.add(im.storageKey);
                        mergedImages.push(im);
                    }
                    list.push({
                        ...primary,
                        castName: g.displayName,
                        description: g.description || primary.description,
                        images: mergedImages,
                        primaryIndex: 0,
                        canonicalName: g.canonical,
                    });
                }
                list.sort((a, b) => a.castName.localeCompare(b.castName));
                setCharacters(list);
                // 影策造型计数 = 有父级的额外妆造数；本地 = 每个角色本体之外的造型图总数。
                const total = list.reduce((sum, c) => sum + Math.max(0, c.images.length - 1), 0);
                onCountChange?.(total);
            })
            .catch((error) => { if (!disposed) message.error(`读取画布造型失败：${(error as Error).message}`); })
            .finally(() => { if (!disposed) setLoading(false); });
        return () => { disposed = true; };
    }, [sharedAssetCanvasId, episodeKey, refreshTick, message, onCountChange]);

    useEffect(() => {
        if (!characters.length) return;
        setSelectedCast((cur) => characters.some((c) => c.castId === cur) ? cur : characters[0].castId);
    }, [characters]);

    // 逐图状态真值：按来源节点查现成的 GET /generation-logs，用产物 storageKey 命中「生成该图」的最近一条日志。
    // 影策 drama_cast.image_status 本地无此列，这里按其派生口径只读，不新建后端 API。
    useEffect(() => {
        let disposed = false;
        const images = characters.flatMap((c) => c.images.map((im) => ({ im, canvasId: c.canvasId })));
        if (!images.length) { setDerivedStatuses({}); setLookVersions({}); return; }
        const byNode = new Map<string, string>();
        for (const { im, canvasId } of images) {
            if (im._srcNodeId && im._srcCanvasId) {
                if (!byNode.has(im._srcNodeId)) byNode.set(im._srcNodeId, im._srcCanvasId);
            } else if (im._srcNodeId && canvasId && !byNode.has(im._srcNodeId)) {
                byNode.set(im._srcNodeId, canvasId);
            }
        }
        if (!byNode.size) { setDerivedStatuses({}); setLookVersions({}); return; }
        void Promise.all([...byNode].map(async ([nodeId, projectId]) => {
            try {
                const res = await fetchBackendGenerationLogs({ nodeId, projectId, limit: 200 });
                return res.logs || [];
            } catch {
                return [] as BackendGenerationLog[]; // 查询失败保持诚实：不派生状态
            }
        })).then((groups) => {
            if (disposed) return;
            const logs = groups.flat();
            const next: Record<string, LookStatusInfo> = {};
            const versions: Record<string, LookVersion[]> = {};
            for (const { im } of images) {
                if (!im.storageKey) continue;
                const matchedAll = logs
                    .filter((log) => (log.outputs || []).some((o) => o && String(o.storageKey || "") === im.storageKey))
                    .sort((a, b) => String(b.createdAt || b.startedAt || "").localeCompare(String(a.createdAt || a.startedAt || "")));
                const matched = matchedAll[0];
                if (matched) next[`log:${im.storageKey}`] = toLookStatusInfo(matched);
                // 版本记录：同一产物被多次生成的日志按时间倒序，最新一条即「当前」。
                if (matchedAll.length) {
                    versions[`log:${im.storageKey}`] = matchedAll.slice(0, 5).map((log) => ({
                        id: String(log.id),
                        createdAt: String(log.createdAt || log.startedAt || ""),
                        status: String(log.status || ""),
                        model: String(log.model || ""),
                    }));
                }
            }
            setDerivedStatuses(next);
            setLookVersions(versions);
        });
        return () => { disposed = true; };
    }, [characters, refreshTick]);

    // 单设定 restyle：真实查询「引用该角色的剧情段」影响集，不用假数字。
    useEffect(() => {
        let disposed = false;
        if (!dramaId || !selectedCast) { setImpact(null); return; }
        setImpactLoading(true);
        fetchDramaCastImpact(dramaId, selectedCast, undefined)
            .then((result) => { if (!disposed) setImpact(result.ok ? result : null); })
            .catch(() => { if (!disposed) setImpact(null); })
            .finally(() => { if (!disposed) setImpactLoading(false); });
        return () => { disposed = true; };
    }, [dramaId, selectedCast, impactTick, refreshTick]);

    const selected = characters.find((c) => c.castId === selectedCast);
    const baseIndexOf = (c: CharacterLook) => Math.min(Math.max(c.primaryIndex, 0), Math.max(0, c.images.length - 1));
    const baseIndex = selected ? baseIndexOf(selected) : 0;
    const baseImage = selected?.images[baseIndex];
    const extra = selected ? selected.images.map((im, i) => ({ im, i })).filter(x => x.i !== baseIndex) : [];
    /** 全部角色的额外妆造（角色本体之外）：每条造型独立成卡，不按当前角色截断。 */
    const lookCards = characters.flatMap((ch) => ch.images.map((im, i) => ({ ch, im, i })).filter((x) => x.i !== baseIndexOf(x.ch)));
    const extraTotal = lookCards.length;
    /** 卡片/右栏共用：造型名（生成结果常把角色名误填进图的 name，按影策视为未命名）。 */
    const lookLabel = (ch: CharacterLook, im: LookImage) => {
        const raw = String(im.outfit || im.name || "").trim();
        const isRoleName = !raw || raw === ch.castName || raw === ch.canonicalName || raw === "主角" || raw === "配角";
        return isRoleName ? "未命名造型" : raw;
    };
    /**
     * 影策卡片副标题第二段（角色 · 风格来源）：单条造型本地没有独立风格真值字段，
     * 只用剧目 planning topic.artStyle 判定是否沿用作品风格；无真值就只写角色名，不编「沿用作品风格」。
     */
    const styleInherited = Boolean(String(artStyle || "").trim());
    const styleSubtitle = (ch: CharacterLook) => styleInherited ? `${ch.castName} · 沿用作品风格` : ch.castName;
    /** 卡片/右栏共用：真值优先的造型状态（generation_logs 派生 + 本面板即时反馈 + 面板内生成中兜底）。 */
    const lookStatus = (ch: CharacterLook, im: LookImage, i: number) => {
        const info = mergeLookStatus(instantStatuses[lookStateKey(im, ch.castId, i)], im.storageKey ? derivedStatuses[`log:${im.storageKey}`] : undefined);
        const failed = info?.status === "failed";
        const busy = !failed && (info?.status === "queued" || info?.status === "running" || (ch.castId === selectedCast && generatingIndex === i));
        // 不再派生「已生成/待生成/已锁定」文案徽标：影策卡片只有图 + 两行文字，锁定由缩略图角标表示。
        return { info, failed, busy };
    };

    /** 真提交单设定 restyle：先查真实影响集→用户确认→后端标脏引用段，正在生成的段由后端跳过。 */
    const doRestyle = async (ch: CharacterLook, lookId?: string) => {
        if (!dramaId) {
            message.warning("当前未定位到剧目，无法查询影响段；请从剧目页进入造型面板");
            return;
        }
        setRestyleSubmitting(true);
        try {
            const result = await fetchDramaCastImpact(dramaId, ch.castId, undefined, undefined, lookId);
            const generated = result.targets.filter((target) => target.hasVideo && !target.inputOutdated);
            if (!generated.length) {
                message.info(result.segments
                    ? `查到 ${result.segments} 个引用段，但没有已出片、需要重做的视频`
                    : "没有找到引用该角色的剧情段，无需重生成");
                return;
            }
            let confirmed = false;
            await new Promise<void>((resolve) => {
                modal.confirm({
                    title: `让引用「${ch.castName}」的剧情段视频重新生成？`,
                    content: `真实影响 ${result.episodes} 集 · ${result.segments} 段；其中 ${generated.length} 段已出片将被标记为需重新生成，正在生成的段自动跳过。此操作写入画布段状态，不会删除原视频。`,
                    okText: "确认提交重生成",
                    cancelText: "取消",
                    onOk: () => { confirmed = true; resolve(); },
                    onCancel: () => resolve(),
                });
            });
            if (!confirmed) return;
            const submitted = await restyleDramaCast(dramaId, ch.castId, { restyleSegments: true, lookId });
            if (submitted.affectedSegments) {
                message.success(`已提交 ${submitted.affectedSegments} 个剧情段重新生成（引用该角色的视频已标脏）`);
            } else {
                message.info("没有可标脏的引用段（可能已全部过期或正在生成）");
            }
            setImpactTick((t) => t + 1);
        } catch (error) {
            message.error(`单设定 restyle 失败：${(error as Error).message}`);
        } finally {
            setRestyleSubmitting(false);
        }
    };

    /** 真实写回画布角色节点：按每张造型图的来源节点分组写回，归一化聚合不混写节点。 */
    const commit = async (ch: CharacterLook, images: LookImage[], primaryIndex: number, withRestyle: boolean, lookId?: string) => {
        setSaving(true);
        try {
            // 按来源节点分组；新增/无来源的图写到主卡节点。
            const byNode = new Map<string, { canvasId: string; revision: number; images: LookImage[] }>();
            for (const im of images) {
                const key = im._srcNodeId || ch.nodeId;
                let bucket = byNode.get(key);
                if (!bucket) {
                    bucket = { canvasId: im._srcCanvasId || ch.canvasId, revision: im._srcRevision ?? ch.canvasRevision, images: [] };
                    byNode.set(key, bucket);
                }
                bucket.images.push(im);
            }
            // 每个节点各自的 primaryIndex：主卡节点用传入值，形态节点归零（其本体图即第0张）。
            for (const [nodeId, bucket] of byNode) {
                const usePrimary = nodeId === ch.nodeId ? primaryIndex : 0;
                await applyBackendCanvasOperations(bucket.canvasId, [
                    { type: "update_node", id: nodeId, metadata: { characterImages: bucket.images.map(({ _srcNodeId, _srcCanvasId, _srcRevision, _srcCastId, ...rest }) => rest), characterPrimaryIndex: usePrimary } },
                ], bucket.revision);
            }
            message.success("造型已保存到画布角色节点");
            setEditing(null);
            // 刷新后造型数组可能增删，清掉按索引定位的选中态，避免右栏指到别的造型。
            setSelectedLook(null);
            setRefreshTick((t) => t + 1);
            if (withRestyle) await doRestyle(ch, lookId);
        } catch (error) {
            message.error(`保存造型失败：${(error as Error).message}`);
        } finally {
            setSaving(false);
        }
    };

    const openAdd = () => {
        if (!selected || extra.length >= MAX_EXTRA_LOOKS) return;
        setForm(emptyForm);
        setEditing({ castId: selected.castId, index: null });
        setSelectedLook({ castId: selected.castId, index: null });
    };
    const openEditFor = (ch: CharacterLook, index: number) => {
        const im = ch.images[index];
        if (!im) return;
        setForm({
            name: im.outfit || im.name || "", appearance: im.outfitDescription || "",
            from: im.fromChapter ? String(im.fromChapter) : "", to: im.toChapter ? String(im.toChapter) : "",
            storageKey: im.storageKey || "", url: im.url || "", role: im.role || "",
            hasOwnStyle: Boolean(im.imageStyleId || im.imageStyleName || im.imageStylePrompt),
            imageStyleId: im.imageStyleId || "", imageStyleName: im.imageStyleName || "",
            imageStylePrompt: im.imageStylePrompt || "", imagePrompt: im.imagePrompt || "",
        });
        setEditing({ castId: ch.castId, index });
    };
    /** 点独立造型卡：选中该造型并把右栏切到它的编辑表单（复用同一套 editing/form 状态，不建第二套编辑逻辑）。 */
    const openLookCard = (ch: CharacterLook, index: number) => {
        setSelectedCast(ch.castId);
        setSelectedLook({ castId: ch.castId, index });
        openEditFor(ch, index);
    };
    /**
     * 角色卡造型缩略图点进来：按画布真值身份定位造型并设为当前（右栏表单/预览跟着换）。
     * lookId（characterImages[].id）优先，其次 storageKey（媒体键）；两者都精确匹配，不靠 URL/序号猜。
     * 匹配不到时只切角色，绝不选中一张别的造型冒充。
     */
    useEffect(() => {
        if (!focusLook || focusLook.seq === appliedFocusSeq.current) return;
        // 造型还没读到时先不消费序号：等 characters 到位后同一 effect 再应用。
        if (!characters.length) return;
        appliedFocusSeq.current = focusLook.seq;
        const hit = characters
            .map((ch) => ({
                ch,
                index: ch.images.findIndex((im) => (focusLook.lookId && String(im.id || "") === focusLook.lookId)
                    || (focusLook.storageKey && String(im.storageKey || "") === focusLook.storageKey)),
            }))
            .find((item) => item.index >= 0);
        if (hit) { openLookCard(hit.ch, hit.index); return; }
        const target = characters.find((c) => (focusLook.castId && c.castId === focusLook.castId)
            || (focusLook.castName && c.castName === focusLook.castName));
        if (target) setSelectedCast(target.castId);
    }, [focusLook, characters]);
    /** 影策 CastForm 的 dirty：保存按钮只有真有改动才可点。 */
    const formDirty = Boolean(editing && selected && (() => {
        const prior: LookImage | undefined = editing.index === null ? undefined : selected.images[editing.index];
        return form.name.trim() !== String(prior?.outfit || prior?.name || "").trim()
            || form.appearance.trim() !== String(prior?.outfitDescription || "").trim()
            || (Number(form.from) || 0) !== (prior?.fromChapter || 0)
            || (Number(form.to) || 0) !== (prior?.toChapter || 0)
            || form.hasOwnStyle !== Boolean(prior?.imageStyleId || prior?.imageStyleName || prior?.imageStylePrompt)
            || form.imageStyleName !== (prior?.imageStyleName || "")
            || form.imageStylePrompt !== (prior?.imageStylePrompt || "")
            || form.imagePrompt !== (prior?.imagePrompt || "");
    })());
    /** 重新编排提示词：影策 rebuildDramaCastImagePrompt 的本地纯字符串等价（withArtStyle，不调模型）。 */
    const rebuildPrompt = () => {
        if (!form.appearance.trim()) return void message.warning("请先填写外貌描述");
        const style = form.hasOwnStyle ? (form.imageStylePrompt || form.imageStyleName) : artStyle;
        setForm((f) => ({ ...f, imagePrompt: withArtStyle(f.appearance.trim(), style || "") }));
        message.success("提示词已按外貌与画风重新编排，保存后用于生成参考图");
    };
    const submitForm = () => {
        if (!selected || !editing || editing.castId !== selected.castId) return;
        // 影策 LookForm：valid = name.trim() && appearance.trim()，两项都必填。
        const name = form.name.trim();
        const appearance = form.appearance.trim();
        if (!name || !appearance) return void message.warning("请填写造型名和造型外观");
        const prior: LookImage = editing.index === null ? { storageKey: "" } : selected.images[editing.index];
        const im: LookImage = {
            ...prior,
            storageKey: form.storageKey,
            ...(form.url ? { url: form.url } : {}),
            outfit: name,
            outfitDescription: appearance,
            name,
            ...(form.role ? { role: form.role } : {}),
            ...(Number(form.from) ? { fromChapter: Number(form.from) } : { fromChapter: undefined }),
            ...(Number(form.to) ? { toChapter: Number(form.to) } : { toChapter: undefined }),
            id: prior.id || `look-${nanoid()}`,
            ...(form.storageKey ? { locked: true } : {}),
            // 影策 CastImageFields：关掉单独风格就清空三个字段；提示词保留用户编排结果。
            ...(form.hasOwnStyle
                ? {
                    imageStyleId: form.imageStyleId || styleSlug(form.imageStyleName || artStyle || ""),
                    imageStyleName: form.imageStyleName || artStyle || "",
                    imageStylePrompt: form.imageStylePrompt || withArtStyle("", form.imageStyleName || artStyle || ""),
                }
                : { imageStyleId: undefined, imageStyleName: undefined, imageStylePrompt: undefined }),
            ...(form.imagePrompt.trim() ? { imagePrompt: form.imagePrompt.trim() } : { imagePrompt: undefined }),
        };
        const next = [...selected.images];
        if (editing.index === null) next.push(im); else next[editing.index] = im;
        void commit(selected, next, selected.primaryIndex, restyle, im.id);
    };
    const removeLook = (index: number) => {
        if (!selected) return;
        const name = String(selected.images[index]?.name || `第 ${index + 1} 套造型`);
        modal.confirm({
            title: `删除造型「${name}」？`,
            content: "会从画布角色节点移除这套妆造；引用该造型的参考图需重新生成。此操作写回画布角色节点。",
            okText: "删除造型",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: () => {
                const next = selected.images.filter((_, j) => j !== index);
                const primaryIndex = Math.min(selected.primaryIndex, Math.max(0, next.length - 1));
                void commit(selected, next, primaryIndex, restyle);
            },
        });
    };
    const pickLibraryImage = (id: string) => {
        const asset = imageAssets.find((a) => a.id === id);
        if (!asset) return;
        setForm((f) => ({ ...f, storageKey: asset.data.storageKey || "", url: asset.data.dataUrl || "" }));
    };
    const uploadCustom = async (file: File) => {
        if (!file.type.startsWith("image/")) return void message.warning("请选择图片文件");
        if (file.size > 20 * 1024 * 1024) return void message.warning("图片不超过 20MB");
        try {
            const r = await uploadImage(file, { category: "library" });
            setForm((f) => ({ ...f, storageKey: r.storageKey || "", url: r.url || "" }));
            message.success("自定义图已上传；点确认保存后写入画布节点并锁定该造型");
        } catch (error) {
            message.error(`上传失败：${(error as Error).message}`);
        }
    };
    /**
     * 面板内出图：复用画布既有出图链路，不新建造型表、不造后端接口。
     * mode=image 提交到角色节点 → Backend 用造型 prompt + 本体图作参考新建图片结果节点并执行；
     * 任务成功后把真实 storageKey 写回 metadata.characterImages[] 并锁定该造型。
     * 本体图必须 ready（有 storageKey），否则 disable 并说明原因——造型图以它为底图保持同一张脸。
     */
    const generateLook = async (ch: CharacterLook, index: number, im: LookImage) => {
        if (!baseImage?.storageKey) {
            message.warning("请先生成或上传角色本体参考图，造型图需要以它为底图");
            return;
        }
        const model = resolveModelForCapability(config, config.imageModel, "image");
        if (!model) return void message.warning("没有可用的图片生成模型，请到制作设置里配置参考图模型");

        const lookName = String(im.outfit || im.name || "造型").trim();
        const outfit = String(im.outfitDescription || "").trim();
        const identity = String(ch.description || "").trim();
        // 归一聚合后，造型图属于它自己的来源节点；生成与写回都定位到该节点，不混写主卡。
        const srcNodeId = im._srcNodeId || ch.nodeId;
        const srcCanvasId = im._srcCanvasId || ch.canvasId;
        const srcCastId = im._srcCastId || ch.castId;
        // 影策 CastImageFields：用户编排/手写的 imagePrompt 是完整提示词，直接采用；
        // 没有才按外观拼装，并注入单独风格（优先）或全剧画风。
        const fallback = [
            identity ? `角色本体设定：${identity}` : "",
            `本次造型：${lookName}${outfit ? ` —— ${outfit}` : ""}`,
            "五官与脸型严格沿用参考的角色本体图，保持同一张脸；只改变服装、发型与妆容。",
        ].filter(Boolean).join("\n");
        const prompt = String(im.imagePrompt || "").trim()
            || withArtStyle(fallback, String(im.imageStylePrompt || im.imageStyleName || artStyle || ""));

        const stateKey = lookStateKey(im, ch.castId, index);
        setInstantStatuses((s) => ({ ...s, [stateKey]: { status: "running" } }));
        setGeneratingIndex(index);
        try {
            const started = await startCanvasGeneration({
                mode: "image",
                projectId: srcCanvasId,
                nodeId: srcNodeId,
                prompt,
                references: [{
                    id: `look-base-${srcCastId}`,
                    name: `${ch.castName}-本体`,
                    storageKey: baseImage.storageKey,
                    mimeType: "image/png",
                }],
                count: 1,
                // 每次点击都是一次新的生成（含重新生成）；用随机 key 避免复用上次任务结果。
                idempotencyKey: `look-gen:${srcNodeId}:${im.id || `slot-${index}`}:${nanoid(8)}`,
                model,
            });

            // 轮询权威任务：Backend 把结果写进结果节点，task.result.media 带真实 storageKey。
            const deadline = Date.now() + 180_000;
            let storageKey = "";
            for (;;) {
                const { task } = await fetchBackendTask(started.taskId);
                if (!task) throw new Error("造型生成任务不存在");
                if (task.status === "succeeded") {
                    const media = task.result?.media?.[0] || task.result?.images?.[0];
                    storageKey = String(media?.storageKey || "");
                    break;
                }
                if (task.status === "failed" || task.status === "cancelled") throw new Error(String(task.error || "造型生成失败"));
                if (Date.now() > deadline) throw new Error("造型生成超时");
                await new Promise((resolve) => setTimeout(resolve, 1500));
            }
            if (!storageKey) throw new Error("生成成功但没有可用的图片存储键");

            // 写回真值：重新读取角色节点，避免生成期间 revision 变化导致基线过期。
            const fresh = await fetchBackendProject(srcCanvasId);
            const node = ((fresh.project?.nodes || []) as Array<Record<string, unknown>>)
                .find((n) => String(n.id) === srcNodeId);
            if (!node) throw new Error("画布角色节点已不存在");
            const md = (node.metadata || {}) as Record<string, unknown>;
            const currentImages = (Array.isArray(md.characterImages) ? md.characterImages : []) as LookImage[];
            const matches = (entry: LookImage, i: number) => im.id
                ? String(entry.id) === String(im.id)
                : i === index;
            if (!currentImages.some(matches)) throw new Error("该造型已从画布移除，未写回生成结果");
            const nextImages = currentImages.map((entry, i) => matches(entry, i)
                ? {
                    ...entry,
                    storageKey,
                    url: backendMediaUrl(storageKey),
                    outfit: im.outfit || entry.outfit,
                    outfitDescription: im.outfitDescription || entry.outfitDescription,
                    name: im.name || im.outfit || entry.name,
                    locked: true,
                }
                : entry);
            await applyBackendCanvasOperations(srcCanvasId, [
                { type: "update_node", id: srcNodeId, metadata: { characterImages: nextImages } },
            ], Number(fresh.project?.revision || 0));

            message.success(`已生成「${lookName}」造型图并写回画布角色节点（已锁定）`);
            setInstantStatuses((s) => ({ ...s, [stateKey]: { status: "ready" } }));
            setRefreshTick((t) => t + 1);
        } catch (error) {
            const err = (error as Error).message;
            message.error(`造型图生成失败：${err}`);
            setInstantStatuses((s) => ({ ...s, [stateKey]: { status: "failed", error: err } }));
        } finally {
            setGeneratingIndex(null);
        }
    };

    const triggerGenerate = (index: number, im: LookImage) => {
        if (!selected || !baseImage?.storageKey) return;
        if (generatingIndex !== null) return;
        const current = mergeLookStatus(instantStatuses[lookStateKey(im, selected.castId, index)], im.storageKey ? derivedStatuses[`log:${im.storageKey}`] : undefined);
        if (current?.status === "queued" || current?.status === "running") return;
        // 已锁定的造型重新生成需先确认解锁（对齐影策 cast-looks.tsx:166）。
        if (im.locked) {
            modal.confirm({
                title: `重新生成「${im.outfit || im.name || "造型"}」？`,
                content: "将按已保存的外观描述生成新图，并覆盖当前已锁定的造型图。",
                okText: "解锁并生成",
                cancelText: "取消",
                onOk: () => { void generateLook(selected, index, im); },
            });
            return;
        }
        void generateLook(selected, index, im);
    };

    // 右栏当前造型：只要仍属于当前角色；index=null 表示本体（基础造型）。
    const activeLook = selected && selectedLook && selectedLook.castId === selected.castId ? selectedLook : null;
    const selectedCastName = selected?.castName || "";
    const activeLookIndex = activeLook?.index ?? null;
    const activeLookImage = selected && activeLookIndex !== null ? selected.images[activeLookIndex] : undefined;
    const activeLookName = selected && activeLookImage ? lookLabel(selected, activeLookImage) : "";
    const activeLookStorageKey = activeLookImage?.storageKey || "";
    const activeLookStatus = selected && activeLookImage && activeLookIndex !== null ? lookStatus(selected, activeLookImage, activeLookIndex) : null;
    /** 造型粒度影响集：按 characterImages[].id 精确反查引用段（后端 planRestyle lookId）。 */
    useEffect(() => {
        if (!dramaId || !selected || !activeLookImage?.id) { setImpact(null); return; }
        let disposed = false;
        setImpactLoading(true);
        fetchDramaCastImpact(dramaId, selected.castId, undefined, undefined, activeLookImage.id)
            .then((result) => { if (!disposed) setImpact(result); })
            .catch(() => { if (!disposed) setImpact(null); })
            .finally(() => { if (!disposed) setImpactLoading(false); });
        return () => { disposed = true; };
    }, [dramaId, selected?.castId, activeLookImage?.id, impactTick]);
    /** 当前造型的版本记录（真值：生成该形象图的 generation_logs，按时间倒序，首条为「当前」）。 */
    const activeLookVersions = activeLookStorageKey ? lookVersions[`log:${activeLookStorageKey}`] || [] : [];
    const onGenerateActiveLook = () => { if (activeLookIndex !== null && activeLookImage) triggerGenerate(activeLookIndex, activeLookImage); };
    const onRemoveActiveLook = () => { if (activeLookIndex !== null) removeLook(activeLookIndex); };
    /** 当前造型唯一键：锁定写回的 saving/错误提示都按它定位，不串到别的造型。 */
    const activeLookKey = selected && activeLookImage && activeLookIndex !== null ? lookStateKey(activeLookImage, selected.castId, activeLookIndex) : "";
    /**
     * 锁定开关真值写回：locked 真值 = 画布角色节点 metadata.characterImages[]（造型页读的同一数组）。
     * 先重读画布拿最新 revision，再只改该造型的 locked，走现成 update_node op；
     * 失败只就地报错、不做乐观改 UI，成功后刷新按真值重读。
     */
    const toggleLookLock = async (nextLocked: boolean) => {
        if (!selected || !activeLookImage || activeLookIndex === null) return;
        const im = activeLookImage;
        const key = activeLookKey;
        const canvasId = im._srcCanvasId || selected.canvasId;
        const nodeId = im._srcNodeId || selected.nodeId;
        setLockSaving(true);
        setLockError(null);
        try {
            if (!canvasId || !nodeId) throw new Error("找不到该造型所属的画布角色节点");
            const fresh = await fetchBackendProject(canvasId);
            const node = ((fresh.project?.nodes || []) as Array<Record<string, unknown>>).find((n) => String(n.id) === nodeId);
            if (!node) throw new Error("造型所属画布节点已不存在");
            const md = (node.metadata || {}) as Record<string, unknown>;
            const images = (Array.isArray(md.characterImages) ? md.characterImages : []) as LookImage[];
            // 只认精确身份（lookId → storageKey），旧记录两者都缺时才退回按下标；
            // 匹配不到就报错，绝不把 locked 写到别的造型上。
            const matches = (entry: LookImage, index: number) => Boolean(im.id && String(entry.id || "") === String(im.id))
                || Boolean(im.storageKey && String(entry.storageKey || "") === im.storageKey)
                || (!im.id && !im.storageKey && index === activeLookIndex);
            if (!images.some(matches)) throw new Error("该造型已不在画布节点上，请刷新后重试");
            const nextImages = images.map((entry, index) => matches(entry, index) ? { ...entry, locked: nextLocked } : entry);
            await applyBackendCanvasOperations(canvasId, [
                { type: "update_node", id: nodeId, metadata: { characterImages: nextImages } },
            ], Number(fresh.project?.revision || 0));
            message.success(nextLocked ? "已锁定该造型形象图" : "已解锁该造型形象图");
            setRefreshTick((t) => t + 1);
        } catch (error) {
            setLockError({ key, message: (error as Error).message });
        } finally {
            setLockSaving(false);
        }
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col" data-studio-looks>
            {/* 缩略图生成中 shimmer（对齐影策 drama-look-busy；减少动态时停用）。 */}
            <style>{`@keyframes studio-look-shimmer{to{background-position:-200% 0}}@media(prefers-reduced-motion:reduce){.studio-look-busy{animation:none!important}}`}</style>
            <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-6 py-2.5">
                <span className="flex items-center gap-1.5 text-xs font-semibold"><Shirt className="size-3.5" /> 剧目造型</span>
                {characters.length > 1 ? (
                    <select value={selectedCast} onChange={(e) => { setSelectedCast(e.target.value); setEditing(null); setSelectedLook(null); }}
                        className="h-8 max-w-52 rounded-md border border-border bg-background px-2 text-xs outline-none" data-studio-look-cast>
                        {characters.map((c) => <option key={c.castId} value={c.castId}>{c.castName}</option>)}
                    </select>
                ) : selected ? <span className="text-xs text-muted-foreground">{selected.castName}</span> : null}
                <span className="text-[11px] text-muted-foreground">
                    共 {characters.length} 个角色 · 全部造型 {extraTotal} 套 · 当前「{selected?.castName || "—"}」额外妆造 {extra.length}/{Math.max(MAX_EXTRA_LOOKS, extra.length)} · 画布角色节点真实数据
                </span>
                <div className="ml-auto flex items-center gap-3">
                    <label className="flex items-center gap-1 text-[11px] text-muted-foreground" data-studio-look-restyle
                        title="勾选后保存造型会真实查询引用该角色的剧情段，并把已出片视频标记为需重新生成（对齐影策单设定 restyle）">
                        <input type="checkbox" checked={restyle} onChange={(e) => setRestyle(e.target.checked)} />
                        让引用它的剧情段重新生成
                        {dramaId && impact ? (
                            <span className="ml-1 font-medium text-primary" data-studio-look-restyle-impact>
                                {impact.episodes} 集 · {impact.segments} 段
                            </span>
                        ) : (
                            <span className="ml-1 text-[11px] opacity-70" data-studio-look-restyle-hint>
                                {dramaId ? (impactLoading ? "影响段查询中…" : "影响段暂不可查") : "需从剧目页进入才可查影响段"}
                            </span>
                        )}
                        {restyleSubmitting ? <span className="ml-1 text-[11px] text-primary">提交中…</span> : null}
                    </label>
                    {/* 影策页头工具按钮 ≥24px 高；这两个文字入口原只有 22px，热区偏小。 */}
                    <button type="button" onClick={() => setRefreshTick((t) => t + 1)} className="flex h-6 items-center gap-1 rounded px-1 text-[11px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"><RefreshCw className="size-3" /> 刷新</button>
                    <button type="button" onClick={onOpenCanvas} className="flex h-6 items-center rounded px-1 text-[11px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground">在画布中精修造型 →</button>
                </div>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
                {/* 左：每条造型独立卡片（全部角色；含所属角色名与真实状态徽标） */}
                <div className="min-h-0 overflow-y-auto px-4 py-3 thin-scrollbar" data-studio-look-extra>
                {loading ? (
                    <div className="grid place-content-center gap-2 py-16 text-center text-xs text-muted-foreground" aria-busy="true">
                        <RefreshCw className="mx-auto size-5 animate-spin opacity-50" /> 读取画布角色节点造型…
                    </div>
                ) : !selected ? (
                    <div className="py-10 text-center text-xs text-muted-foreground">
                        没有找到画布角色节点。请先在精修画布/分集制作里建立角色设定，其造型图会出现在这里。
                    </div>
                ) : (
                    <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                            <span className="font-semibold">造型（{extraTotal}）</span>
                            <span className="text-muted-foreground">每条造型独立成卡；点卡片在右栏编辑</span>
                            {extra.length < MAX_EXTRA_LOOKS ? (
                                <button type="button" onClick={openAdd} disabled={saving} data-studio-look-add
                                    className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 font-normal text-muted-foreground transition hover:bg-muted disabled:opacity-50">
                                    <Plus className="size-3" /> 给「{selected.castName}」添加造型
                                </button>
                            ) : null}
                        </div>
                        {/* 影策造型卡：封面 + 两行文字（造型名 / 角色 · 风格来源）；不放状态徽标与外观描述行。 */}
                        {lookCards.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-border py-8 text-center text-[11px] text-muted-foreground" data-studio-look-empty>
                                还没有造型。点「添加造型」新建，或在画布角色节点里添加造型/服装图后刷新。
                            </div>
                        ) : (
                            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
                                {lookCards.map(({ ch, im, i }) => {
                                    const lookName = lookLabel(ch, im);
                                    const st = lookStatus(ch, im, i);
                                    const isSelected = selectedLook?.castId === ch.castId && selectedLook.index === i;
                                    return (
                                        <button type="button" key={`${ch.castId}:${im.storageKey}:${i}`}
                                            data-studio-look data-studio-look-card aria-pressed={isSelected}
                                            onClick={() => openLookCard(ch, i)}
                                            className={cn("overflow-hidden rounded-[8px] border bg-card/40 text-left transition-colors duration-150 hover:border-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                                                isSelected ? "border-primary ring-1 ring-primary/60" : "border-border")}>
                                            {/* 封面真值 = 该造型 storageKey；无图只留占位，不再用「待生成」徽标刷屏。 */}
                                            <span className="relative block aspect-[4/3] overflow-hidden bg-muted/40" data-studio-look-cover>
                                                {im.storageKey ? (
                                                    // 影策 drama-look-thumb：缩略图点击只放大预览，不触发卡片编辑。
                                                    <span role="button" tabIndex={0} aria-label={`放大查看${lookName}`}
                                                        onClick={(e) => { e.stopPropagation(); setPreview({ key: im.storageKey!, title: `${ch.castName} · ${lookName}` }); }}
                                                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setPreview({ key: im.storageKey!, title: `${ch.castName} · ${lookName}` }); } }}
                                                        className="block size-full cursor-zoom-in">
                                                        <img src={backendThumbUrl(im.storageKey, 240)} alt={lookName} className="size-full object-cover" loading="lazy" draggable={false} />
                                                    </span>
                                                ) : (
                                                    <span className="grid size-full place-items-center text-muted-foreground"><Shirt className="size-6 opacity-40" /></span>
                                                )}
                                                <LookThumbStates locked={im.locked} busy={st.busy} failed={st.failed} error={st.info?.error} />
                                                {/* 只有真在生成/失败时才出状态标（对齐影策：状态交给缩略图覆盖层与分类筛选）。 */}
                                                {st.failed || st.busy ? (
                                                    <span className={cn("absolute left-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium backdrop-blur",
                                                        st.failed ? "bg-rose-500/90 text-white" : "bg-primary/90 text-background")} data-studio-look-status>{st.failed ? "失败" : "生成中"}</span>
                                                ) : null}
                                            </span>
                                            <span className="block px-2 py-1.5">
                                                <span className="block truncate text-[12px] font-medium" title={lookName}>{lookName}</span>
                                                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground" data-studio-look-subtitle
                                                    title={styleInherited ? `角色 · 沿用作品风格${artStyle ? `（${artStyle}）` : ""}` : "角色"}>
                                                    {styleSubtitle(ch)}
                                                </span>
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
                </div>

                {/* 右：造型设定（对齐影策右栏顺序：形象图 → 造型设定 → 名称/外观 → 章节 → restyle → 按钮组 → 说明 → 版本记录；本体选择器保留在底部） */}
                <aside className="min-h-0 overflow-y-auto border-l border-border bg-card/30 p-4 thin-scrollbar" data-studio-look-detail>
                    {selected ? (
                        <div className="space-y-3">
                            {activeLookIndex !== null && activeLookImage && activeLookStatus ? (
                                <div className="relative overflow-hidden rounded-[8px] border border-border bg-muted/30" data-studio-look-selected>
                                    {activeLookStorageKey ? (
                                        <img src={backendMediaUrl(activeLookStorageKey)} alt={activeLookName}
                                            className="max-h-[200px] w-full cursor-zoom-in object-contain" data-studio-look-preview
                                            onClick={() => setPreview({ key: activeLookStorageKey, title: `${selectedCastName} · ${activeLookName}` })} />
                                    ) : (
                                        <div className="grid h-32 place-items-center text-muted-foreground"><Shirt className="size-6 opacity-40" /></div>
                                    )}
                                    <LookThumbStates locked={activeLookImage.locked} busy={activeLookStatus.busy} failed={activeLookStatus.failed} error={activeLookStatus.info?.error} />
                                </div>
                            ) : null}

                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[12px] font-semibold">造型设定</span>
                                {/* 锁定形象：真值在画布角色节点 metadata.characterImages[].locked；写回失败就地报错，不乐观改开关。 */}
                                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground" data-studio-look-lock>
                                    {activeLookImage ? (
                                        <>
                                            {activeLookImage.locked ? <Lock className="size-3.5 text-amber-500" /> : null}
                                            <span>{activeLookImage.locked ? "已锁定形象" : "未锁定形象"}</span>
                                            <Switch size="small" checked={Boolean(activeLookImage.locked)} loading={lockSaving}
                                                disabled={lockSaving || !activeLookStorageKey}
                                                title={activeLookStorageKey ? "锁定后重新生成需先解锁；开关写回画布角色节点" : "该造型还没有形象图，上传或生成后才能锁定"}
                                                aria-label="锁定造型形象图" data-studio-look-lock-switch
                                                onChange={(next) => void toggleLookLock(next)} />
                                        </>
                                    ) : editing ? "新增造型" : "未选择造型"}
                                </span>
                            </div>
                            {lockError && lockError.key === activeLookKey ? (
                                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
                                    role="alert" data-studio-look-lock-error>
                                    锁定写回失败：{lockError.message}
                                </p>
                            ) : null}
                            <p className="text-[11px] leading-relaxed text-muted-foreground">
                                所属角色：{selected.castName}。造型沿用角色本体的五官与脸型，服装、发型与妆容独立设置；保存写回画布角色节点。
                            </p>

                            {editing && editing.castId === selected.castId ? (
                                <div className="space-y-2" data-studio-look-form>
                                    <label className="block text-[11px] text-muted-foreground" htmlFor="studio-look-name">造型名称</label>
                                    <input id="studio-look-name" aria-label="造型名称" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })}
                                        placeholder="造型名，如 农夫装、囚服"
                                        className="h-[34px] w-full rounded-[12px] border border-border bg-background px-3 text-[13px] outline-none" />
                                    <label className="block text-[11px] text-muted-foreground" htmlFor="studio-look-appearance">外貌描述</label>
                                    <textarea id="studio-look-appearance" aria-label="外貌描述" value={form.appearance} maxLength={1000} onChange={(e) => setForm({ ...form, appearance: e.target.value })} rows={3}
                                        placeholder="这套造型的服装、发型与妆容；五官脸型沿用角色本体"
                                        className="w-full resize-none rounded-[12px] border border-border bg-background px-3 py-1.5 text-[13px] leading-[21px] outline-none" />
                                    {/* 影策 CastImageFields：单独风格开关 + 风格选择器 + 画风约束 */}
                                    <div className="space-y-2 rounded-[12px] border border-border bg-background/50 p-3" data-studio-look-style>
                                        <button type="button" onClick={() => setForm((f) => ({ ...f, hasOwnStyle: !f.hasOwnStyle }))} className="flex w-full items-center gap-2 text-left text-[11px]">
                                            <span className={cn("flex size-3.5 items-center justify-center rounded border", form.hasOwnStyle ? "border-primary bg-primary text-primary-foreground" : "border-border")}>
                                                {form.hasOwnStyle ? "✓" : ""}
                                            </span>
                                            为此造型单独设置风格
                                        </button>
                                        {form.hasOwnStyle ? (
                                            <>
                                                <select value={form.imageStyleName || artStyleOptions("")[0] || ""} aria-label="造型风格"
                                                    onChange={(e) => {
                                                        const name = e.target.value;
                                                        setForm((f) => ({ ...f, imageStyleName: name, imageStyleId: styleSlug(name), imageStylePrompt: withArtStyle("", name) }));
                                                    }}
                                                    className="h-[34px] w-full rounded-[12px] border border-border bg-background px-3 text-[13px] outline-none" data-studio-look-style-select>
                                                    {artStyleOptions(form.imageStyleName).map((s) => <option key={s} value={s}>{s}</option>)}
                                                </select>
                                                <textarea value={form.imageStylePrompt} aria-label="单独风格画风约束" rows={2}
                                                    onChange={(e) => setForm((f) => ({ ...f, imageStylePrompt: e.target.value }))}
                                                    placeholder="单独风格的画风约束语句（留空则沿用所选风格名）"
                                                    className="w-full resize-none rounded-[12px] border border-border bg-background px-3 py-1.5 text-[13px] leading-[21px] outline-none" />
                                            </>
                                        ) : (
                                            <span className="block text-[11px] text-foreground/40">沿用作品风格；穿越、幼年或不同世界的造型可在此单独选择。</span>
                                        )}
                                    </div>
                                    {/* 影策 CastImageFields：参考图生成提示词 + 重新编排（本地纯字符串，不调模型） */}
                                    <div className="space-y-1" data-studio-look-image-prompt>
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-[11px] text-muted-foreground">参考图生成提示词</span>
                                            <button type="button" onClick={rebuildPrompt} disabled={!form.appearance.trim()}
                                                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/10 disabled:opacity-40">
                                                <RefreshCw className="size-3" /> 重新编排提示词
                                            </button>
                                        </div>
                                        <textarea value={form.imagePrompt} aria-label="参考图生成提示词" rows={3}
                                            onChange={(e) => setForm((f) => ({ ...f, imagePrompt: e.target.value }))}
                                            placeholder="留空按外观、风格和参考图方案自动编排；也可填写自己的生图要求"
                                            className="w-full resize-none rounded-[12px] border border-border bg-background px-3 py-1.5 text-[13px] leading-[21px] outline-none" />
                                        <small className="block text-[11px] text-muted-foreground">切换风格后可重新编排提示词。编排不调用模型；保存设定后，点击生成才开始生图。</small>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2 text-[11px]" data-studio-look-image-source>
                                        <input ref={(el) => { customRef.current = el; }} type="file" accept="image/*" hidden data-studio-look-upload
                                            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadCustom(f); }} />
                                        {form.storageKey
                                            ? <span className="text-emerald-500">已设置形象图：保存后写回画布角色节点并锁定这套造型</span>
                                            : <span className="text-muted-foreground">当前用角色本体图；上传形象图或从素材库选择可替换这套造型的形象图</span>}
                                    </div>

                                    <div className="space-y-1 border-t border-border pt-2 text-[11px] text-muted-foreground">
                                        <span className="block font-medium text-foreground">默认适用章节<span className="font-normal text-muted-foreground">（留空=不限）</span></span>
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <span className="shrink-0 whitespace-nowrap">起始章</span>
                                            <InputNumber size="small" min={0} precision={0} style={{ width: 88, height: 28, borderRadius: "12px" }} value={form.from === "" ? null : Number(form.from)}
                                                placeholder="留空" aria-label="起始章" onChange={(value) => setForm((f) => ({ ...f, from: value === null || value === undefined ? "" : String(value) }))} />
                                            <span className="shrink-0">至</span>
                                            <InputNumber size="small" min={0} precision={0} style={{ width: 88, height: 28, borderRadius: "12px" }} value={form.to === "" ? null : Number(form.to)}
                                                placeholder="留空" aria-label="结束章" onChange={(value) => setForm((f) => ({ ...f, to: value === null || value === undefined ? "" : String(value) }))} />
                                            <span className="shrink-0">结束章</span>
                                            <small className="w-full">当前 {chapterLabel(form.from === "" ? undefined : Number(form.from), form.to === "" ? undefined : Number(form.to))}</small>
                                        </div>
                                    </div>

                                    {/* 单条造型的引用段统计：后端只提供按角色的影响集（/cast/:assetId/impact），
                                        拿不到造型粒度就显示 —，不用角色数字冒充造型数字。 */}
                                    <label className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2 text-[11px] text-muted-foreground" data-studio-look-restyle-look
                                        title="勾选后保存设定会把明确引用这套造型的剧情段视频标脏（按 outfitId 精确反查）">
                                        <input type="checkbox" checked={restyle} onChange={(e) => setRestyle(e.target.checked)} />
                                        让引用它的剧情段视频重新生成
                                        <span className="ml-auto font-medium text-foreground" data-studio-look-restyle-look-impact>
                                            {impactLoading ? "查询中…" : impact ? `${impact.episodes} 集 · ${impact.segments} 段` : "0 集 · 0 段"}
                                        </span>
                                        <small className="w-full">
                                            {impact
                                                ? `按造型图 ID 精确反查：${impact.targets.filter(t => t.hasVideo && !t.inputOutdated && !t.hasActiveTask).length} 段已出片待重做；不拿角色级命中冒充。`
                                                : "按造型图 ID（characterImages[].id）精确反查引用段；无引用时如实显示 0。"}
                                        </small>
                                    </label>

                                    <div className="flex flex-wrap items-center gap-1.5" data-studio-look-actions>
                                        <button type="button" onClick={submitForm} disabled={saving || !formDirty || !form.name.trim() || !form.appearance.trim()} data-studio-look-save
                                            className="flex h-7 items-center gap-1 rounded-md bg-foreground px-2 text-[12px] font-medium text-background disabled:opacity-50">
                                            <Check className="size-3.5" /> {saving ? "保存中…" : "保存设定"}
                                        </button>
                                        <button type="button" onClick={() => customRef.current?.click()}
                                            className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[12px] text-foreground hover:bg-muted">
                                            <Upload className="size-3.5" /> 上传形象图
                                        </button>
                                        <button type="button" onClick={() => setLibraryOpen(true)}
                                            title={imageAssets.length ? "从素材库挑一张已有图片作为这套造型的形象图" : "素材库还没有图片"}
                                            className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[12px] text-foreground hover:bg-muted disabled:opacity-50">
                                            <Library className="size-3.5" /> 从素材库选择
                                        </button>
                                        {activeLookImage ? (
                                            <button type="button" onClick={onGenerateActiveLook} data-studio-look-generate
                                                disabled={!baseImage?.storageKey || activeLookStatus?.busy || formDirty}
                                                title={!baseImage?.storageKey
                                                    ? "请先生成或上传角色本体参考图，造型图需要以它为底图"
                                                    : formDirty
                                                        ? "设定已修改，请先保存再生成"
                                                        : activeLookStatus?.failed
                                                            ? "上次造型图生成失败，点此重试"
                                                            : activeLookImage.locked
                                                                ? "已锁定：重新生成会覆盖当前造型图"
                                                                : activeLookImage.storageKey ? "按外观描述重新生成造型图" : "生成这套造型图"}
                                                className={cn("flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[12px] text-muted-foreground hover:bg-muted disabled:opacity-50",
                                                    activeLookStatus?.busy && "text-primary", activeLookStatus?.failed && "text-rose-500")}>
                                                <Play className="size-3.5" /> {activeLookStatus?.busy ? "生成中…" : formDirty ? "保存后生成" : activeLookImage.storageKey ? "重新生成" : "生成造型图"}
                                            </button>
                                        ) : null}
                                        <button type="button" onClick={onOpenCanvas}
                                            className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[12px] text-foreground hover:bg-muted">
                                            <Sparkles className="size-3.5" /> 在画布中精修
                                        </button>
                                        {activeLookImage ? (
                                            <button type="button" onClick={onRemoveActiveLook}
                                                className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[12px] text-rose-500 hover:bg-rose-500/10">
                                                <Trash2 className="size-3.5" /> 删除造型
                                            </button>
                                        ) : null}
                                    </div>

                                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                                        旧版本保留在版本记录里；锁定后形象图不会被重新生成。上传或从素材库采用的形象图会自动锁定，生成剧情段视频时随请求发送，并要求外貌、发型与服装以它为准。
                                    </p>

                                    <div className="space-y-1 border-t border-border pt-2" data-studio-look-versions>
                                        <div className="flex items-center justify-between text-[11px] font-semibold">
                                            <span>版本记录</span>
                                            <span className="font-normal text-muted-foreground">{activeLookVersions.length ? `${activeLookVersions.length} 个版本` : "暂无"}</span>
                                        </div>
                                        {activeLookVersions.length ? activeLookVersions.map((version, vi) => (
                                            <div key={version.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground" data-studio-look-version>
                                                <span className="font-medium text-foreground">V{activeLookVersions.length - vi}</span>
                                                <span>{version.status === "success" ? "生成" : version.status === "failed" ? "失败" : "生成中"}</span>
                                                {version.model ? <span>{version.model}</span> : null}
                                                <span className="ml-auto">{versionDate(version.createdAt)}</span>
                                                {vi === 0 ? <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">当前</span> : null}
                                            </div>
                                        )) : (
                                            <p className="text-[11px] text-muted-foreground">没有匹配到生成日志（形象图可能来自素材库采用、上传或其它画布）；在本面板生成后按生成日志记录版本。</p>
                                        )}
                                    </div>
                                </div>
                            ) : (
                                <div className="rounded-lg border border-dashed border-border p-3 text-[11px] text-muted-foreground" data-studio-look-detail-hint>
                                    点左侧造型卡，在右栏编辑名称、外观与章节区间，或生成/上传造型图；「添加造型」给当前角色新建。
                                </div>
                            )}

                            {/* 角色本体 = 基础造型：既有交互保留（点它把右栏切回本体图说明）。 */}
                            <div data-studio-look-base>
                                <div className="mb-2 text-[11px] font-semibold">角色本体 · 基础造型</div>
                                <div
                                    role="button"
                                    tabIndex={0}
                                    aria-pressed={activeLook?.index === null}
                                    onClick={() => setSelectedLook({ castId: selectedCast, index: null })}
                                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedLook({ castId: selectedCast, index: null }); } }}
                                    className={cn(
                                        "flex cursor-pointer items-center gap-2 rounded-[8px] border bg-card/40 p-2 text-left transition-colors duration-150 hover:border-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                                        activeLook?.index === null ? "border-primary ring-1 ring-primary/60" : "border-foreground/30",
                                    )}
                                >
                                    {/* 缩略图对齐影策：40×40 / radius8 / object-cover（本地 rounded-lg 为 10px，故用精确 8px 定值）。 */}
                                    <div className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-muted/40">
                                        {baseImage?.storageKey ? <img src={backendMediaUrl(baseImage.storageKey)} alt={selected.castName} className="size-full object-cover cursor-zoom-in" data-studio-look-preview onClick={(e) => { e.stopPropagation(); setPreview({ key: baseImage.storageKey!, title: `${selected.castName} · 本体` }); }} /> : <Shirt className="size-4 opacity-40" />}
                                    </div>
                                    <div className="min-w-0 text-[11px]">
                                        <div className="font-medium">{selected.castName}</div>
                                        <div className="mt-0.5 line-clamp-2 text-muted-foreground">{selected.description || "（无角色描述）"}</div>
                                        <div className="mt-1 text-[11px] text-muted-foreground">
                                            {baseImage?.storageKey
                                                ? "主图已设为本体参考"
                                                : "本体参考图尚未就绪：请先在画布生成或上传本体图，造型图需要以它为底图（当前已禁用生成）"}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : null}
                </aside>

            </div>

            {/* 造型图放大预览（对齐影策 cast-looks 放大查看） */}
            <Modal title={preview?.title || "造型图"} open={Boolean(preview)} onCancel={() => setPreview(null)} footer={null} width={560} centered>
                {preview ? <img src={backendMediaUrl(preview.key)} alt={preview.title} className="mx-auto max-h-[70vh] max-w-full object-contain" /> : null}
            </Modal>

            {/* 从素材库选择：点图走 pickLibraryImage 真值写入（storageKey/url），保存设定才写回画布。 */}
            <Modal title="从素材库选择形象图" open={libraryOpen} onCancel={() => setLibraryOpen(false)} footer={null} width={640} centered>
                {imageAssets.length ? (
                    <div className="grid max-h-[60vh] grid-cols-4 gap-2 overflow-y-auto thin-scrollbar" data-studio-look-library>
                        {imageAssets.map((asset) => (
                            <button type="button" key={asset.id} onClick={() => { pickLibraryImage(asset.id); setLibraryOpen(false); }}
                                className="overflow-hidden rounded-[8px] border border-border bg-card/40 text-left transition hover:border-foreground/50">
                                <span className="block aspect-square overflow-hidden bg-muted/40">
                                    <img src={asset.data.dataUrl || (asset.data.storageKey ? backendMediaUrl(asset.data.storageKey) : "")} alt={asset.title}
                                        className="size-full object-cover" loading="lazy" draggable={false} />
                                </span>
                                <span className="block truncate px-1.5 py-1 text-[11px]">{asset.title}</span>
                            </button>
                        ))}
                    </div>
                ) : (
                    <p className="py-6 text-center text-[11px] text-muted-foreground" data-studio-look-library-empty>素材库还没有图片；先到资产库上传，或用「上传形象图」直接选本地文件。</p>
                )}
            </Modal>
        </div>
    );
}
