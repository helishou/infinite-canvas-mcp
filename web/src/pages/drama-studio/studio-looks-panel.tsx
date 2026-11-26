import { useEffect, useMemo, useRef, useState } from "react";
import { App, InputNumber, Modal } from "antd";
import { Shirt, RefreshCw, Plus, Pencil, Trash2, Play, Upload, Library, Sparkles, Lock, AlertCircle, Check, X } from "lucide-react";

import {
    fetchBackendProject,
    fetchBackendDramaEpisode,
    applyBackendCanvasOperations,
    backendMediaUrl,
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
};
type LookStatus = NonNullable<LookImage["status"]>;
type LookStatusInfo = { status: LookStatus; error?: string; generationLogId?: string };
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
};
const emptyForm: LookForm = { name: "", appearance: "", from: "", to: "", storageKey: "", url: "", role: "" };
const MAX_EXTRA_LOOKS = 6;

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

export function StudioLooksPanel({ dramaId, sharedAssetCanvasId, episodeIds, onOpenCanvas, onCountChange }: {
    /** 剧目 ID：单设定 restyle 影响集查询/提交必须带它，null 时只保留诚实提示。 */
    dramaId: string | null;
    sharedAssetCanvasId: string | null;
    episodeIds?: string[];
    onOpenCanvas: () => void;
    /** 汇报剧目级额外妆造总数（每个角色本体之外），供分类 tab 显示真实计数。 */
    onCountChange?: (count: number) => void;
}) {
    const { message, modal } = App.useApp();
    const config = useConfigStore((s) => s.config);
    const allAssets = useAssetStore((s) => s.assets);
    const imageAssets = useMemo(() => allAssets.filter((a): a is ImageAsset => a.kind === "image"), [allAssets]);
    const [characters, setCharacters] = useState<CharacterLook[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
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
    // 造型卡选中态：仅面板内 UI 焦点，不写回画布（对齐影策造型行选中描边反馈）。
    // index=null 表示该角色本体（基础造型）；选中的卡所属角色同时决定右栏上下文。
    const [selectedLook, setSelectedLook] = useState<{ castId: string; index: number | null } | null>(null);
    const customRef = useRef<HTMLInputElement | null>(null);

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
        if (!images.length) { setDerivedStatuses({}); return; }
        const byNode = new Map<string, string>();
        for (const { im, canvasId } of images) {
            if (im._srcNodeId && im._srcCanvasId) {
                if (!byNode.has(im._srcNodeId)) byNode.set(im._srcNodeId, im._srcCanvasId);
            } else if (im._srcNodeId && canvasId && !byNode.has(im._srcNodeId)) {
                byNode.set(im._srcNodeId, canvasId);
            }
        }
        if (!byNode.size) { setDerivedStatuses({}); return; }
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
            for (const { im } of images) {
                if (!im.storageKey) continue;
                const matched = logs
                    .filter((log) => (log.outputs || []).some((o) => o && String(o.storageKey || "") === im.storageKey))
                    .sort((a, b) => String(b.createdAt || b.startedAt || "").localeCompare(String(a.createdAt || a.startedAt || "")))[0];
                if (matched) next[`log:${im.storageKey}`] = toLookStatusInfo(matched);
            }
            setDerivedStatuses(next);
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
    /** 卡片/右栏共用：真值优先的造型状态（generation_logs 派生 + 本面板即时反馈 + 面板内生成中兜底）。 */
    const lookStatus = (ch: CharacterLook, im: LookImage, i: number) => {
        const info = mergeLookStatus(instantStatuses[lookStateKey(im, ch.castId, i)], im.storageKey ? derivedStatuses[`log:${im.storageKey}`] : undefined);
        const failed = info?.status === "failed";
        const busy = !failed && (info?.status === "queued" || info?.status === "running" || (ch.castId === selectedCast && generatingIndex === i));
        const badge = failed ? "生成失败" : busy ? "生成中" : im.locked ? "已锁定" : im.storageKey ? "已生成" : "待生成";
        return { info, failed, busy, badge };
    };

    /** 真提交单设定 restyle：先查真实影响集→用户确认→后端标脏引用段，正在生成的段由后端跳过。 */
    const doRestyle = async (ch: CharacterLook) => {
        if (!dramaId) {
            message.warning("当前未定位到剧目，无法查询影响段；请从剧目页进入造型面板");
            return;
        }
        setRestyleSubmitting(true);
        try {
            const result = await fetchDramaCastImpact(dramaId, ch.castId);
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
            const submitted = await restyleDramaCast(dramaId, ch.castId, { restyleSegments: true });
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
    const commit = async (ch: CharacterLook, images: LookImage[], primaryIndex: number, withRestyle: boolean) => {
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
            if (withRestyle) await doRestyle(ch);
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
        });
        setEditing({ castId: ch.castId, index });
    };
    /** 点独立造型卡：选中该造型并把右栏切到它的编辑表单（复用同一套 editing/form 状态，不建第二套编辑逻辑）。 */
    const openLookCard = (ch: CharacterLook, index: number) => {
        setSelectedCast(ch.castId);
        setSelectedLook({ castId: ch.castId, index });
        openEditFor(ch, index);
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
        };
        const next = [...selected.images];
        if (editing.index === null) next.push(im); else next[editing.index] = im;
        void commit(selected, next, selected.primaryIndex, restyle);
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
        const prompt = [
            identity ? `角色本体设定：${identity}` : "",
            `本次造型：${lookName}${outfit ? ` —— ${outfit}` : ""}`,
            "五官与脸型严格沿用参考的角色本体图，保持同一张脸；只改变服装、发型与妆容。",
        ].filter(Boolean).join("\n");

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
    const onEditActiveLook = () => { if (selected && activeLookIndex !== null) openEditFor(selected, activeLookIndex); };
    const onGenerateActiveLook = () => { if (activeLookIndex !== null && activeLookImage) triggerGenerate(activeLookIndex, activeLookImage); };
    const onRemoveActiveLook = () => { if (activeLookIndex !== null) removeLook(activeLookIndex); };

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
                    <button type="button" onClick={() => setRefreshTick((t) => t + 1)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"><RefreshCw className="size-3" /> 刷新</button>
                    <button type="button" onClick={onOpenCanvas} className="text-[11px] text-muted-foreground hover:text-foreground">在画布中精修造型 →</button>
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
                        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                            <Sparkles className="mt-0.5 size-3.5 shrink-0" />
                            角色本体即基础造型（唯一，取自画布节点的主图索引）；新增妆造建议不超过 {MAX_EXTRA_LOOKS} 套；存量跨集合并可能更多。改名、换图、删除都会按来源写回画布角色节点。
                        </div>

                        {lookCards.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-border py-8 text-center text-[11px] text-muted-foreground" data-studio-look-empty>
                                还没有造型。点「添加造型」新建，或在画布角色节点里添加造型/服装图后刷新。
                            </div>
                        ) : (
                            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
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
                                            {/* 封面真值 = 该造型 storageKey；无图用占位并由徽标标注「待生成」。 */}
                                            <span className="relative block aspect-[4/3] overflow-hidden bg-muted/40" data-studio-look-cover>
                                                {im.storageKey ? (
                                                    <img src={backendMediaUrl(im.storageKey)} alt={lookName} className="size-full object-cover" loading="lazy" draggable={false} />
                                                ) : (
                                                    <span className="grid size-full place-items-center text-muted-foreground"><Shirt className="size-6 opacity-40" /></span>
                                                )}
                                                <LookThumbStates locked={im.locked} busy={st.busy} failed={st.failed} error={st.info?.error} />
                                                <span className={cn("absolute left-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium backdrop-blur",
                                                    st.failed ? "bg-rose-500/90 text-white" : st.busy ? "bg-primary/90 text-background" : im.locked ? "bg-amber-500/90 text-black" : "bg-background/85 text-foreground")} data-studio-look-status>{st.badge}</span>
                                            </span>
                                            <span className="block p-2">
                                                <span className="block truncate text-[11px] font-medium" title={lookName}>{lookName}</span>
                                                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{ch.castName} · {chapterLabel(im.fromChapter, im.toChapter)}</span>
                                                <span className="mt-1 block line-clamp-2 text-[11px] text-muted-foreground">{im.outfitDescription || "（无外观描述）"}</span>
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
                </div>

                {/* 右：现有造型编辑流程（本体 + 选中造型；复用 editing/form 与生成/删除写回，不建第二套逻辑） */}
                <aside className="min-h-0 overflow-y-auto border-l border-border bg-card/30 p-4 thin-scrollbar" data-studio-look-detail>
                    {selected ? (
                        <div className="space-y-4">
                        {/* 角色本体 = 基础造型 */}
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

                            {editing && editing.castId === selected.castId ? (
                                <div className="space-y-2 rounded-md border border-border bg-muted/40 p-2.5 text-[13px]" data-studio-look-form>
                                    {/* 对齐影策 .drama-look-form：容器 gap 8 / padding 10 / radius 8 / 中性描边 + 下沉底，控件字号统一 13。 */}
                                    <div className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">{editing.index === null ? "新增造型" : "编辑造型"}</div>
                                    {/* 字段与顺序对齐影策 cast-looks.tsx LookForm：造型名 → 造型外观 → 参考图 → 说明 → 章节区间 → 按钮。 */}
                                    <input aria-label="造型名" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="造型名，如 外门弟子、霸道总裁"
                                        className="h-[34px] w-full rounded-[12px] border border-border bg-background px-3 text-[13px] outline-none" />
                                    <textarea aria-label="造型外观" value={form.appearance} maxLength={1000} onChange={(e) => setForm({ ...form, appearance: e.target.value })} rows={2}
                                        placeholder="这套造型的服装、发型与妆容；五官脸型沿用角色本体"
                                        className="w-full resize-none rounded-[12px] border border-border bg-background px-3 py-1.5 text-[13px] leading-[21px] outline-none" />
                                    <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground" data-studio-look-image-source>
                                        <Library className="size-3.5" />
                                        <select aria-label="造型图片素材库" value={form.storageKey} onChange={(e) => pickLibraryImage(e.target.value)}
                                            className="h-[34px] max-w-52 rounded-[12px] border border-border bg-background px-3 text-foreground outline-none">
                                            <option value="">素材库（选择图片）</option>
                                            {imageAssets.map((a) => <option key={a.id} value={a.data.storageKey || a.id}>{a.title}</option>)}
                                        </select>
                                        <button type="button" onClick={() => customRef.current?.click()} className="flex h-[34px] items-center gap-1 rounded-[12px] border border-border px-3 text-foreground transition hover:bg-muted">
                                            <Upload className="size-3" /> 自定义图
                                        </button>
                                        <input ref={(el) => { customRef.current = el; }} type="file" accept="image/*" hidden data-studio-look-upload
                                            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadCustom(f); }} />
                                        {form.storageKey ? <span className="text-[11px] text-emerald-500">已设置造型图，保存后写回并锁定</span> : null}
                                    </div>
                                    <small className="block text-foreground/90">以角色本体图保持人物一致。确认只保存设定，点击“生成造型图”才调用模型。</small>
                                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                                        <span className="shrink-0 whitespace-nowrap" title="本段视频按本集章节序号自动选默认造型：范围包含本集第一章；多套命中取起点最晚、范围最窄；0 或留空不限，无命中回退角色本体">默认适用</span>
                                        <InputNumber size="small" min={0} precision={0} style={{ width: 88, height: 28, borderRadius: "12px" }} value={form.from === "" ? null : Number(form.from)}
                                            placeholder="起始章" aria-label="起始章" onChange={(value) => setForm((f) => ({ ...f, from: value === null || value === undefined ? "" : String(value) }))} />
                                        <span className="shrink-0">至</span>
                                        <InputNumber size="small" min={0} precision={0} style={{ width: 88, height: 28, borderRadius: "12px" }} value={form.to === "" ? null : Number(form.to)}
                                            placeholder="结束章" aria-label="结束章" onChange={(value) => setForm((f) => ({ ...f, to: value === null || value === undefined ? "" : String(value) }))} />
                                        <small className="w-full">0 或留空表示该端不限；对应章节的分集默认用这套造型</small>
                                    </div>
                                    <div className="flex items-center justify-end gap-1.5 text-[12px]">
                                        <button type="button" onClick={() => setEditing(null)} className="flex h-7 items-center gap-2 rounded-md border border-border px-2 text-foreground hover:bg-muted">
                                            <X className="size-3.5" /> 取消
                                        </button>
                                        <button type="button" onClick={submitForm} disabled={saving || !form.name.trim() || !form.appearance.trim()}
                                            className="flex h-7 items-center gap-2 rounded-md bg-foreground px-2 font-medium text-background disabled:opacity-50">
                                            <Check className="size-3.5" /> {saving ? "保存中…" : "确认保存"}
                                        </button>
                                    </div>
                                </div>
                            ) : null}

                            {activeLookIndex !== null && activeLookImage && activeLookStatus ? (
                                <div className="rounded-lg border border-border bg-card/40 p-2" data-studio-look-selected>
                                    <div className="relative overflow-hidden rounded-md bg-muted/30">
                                        {activeLookStorageKey ? (
                                            <img src={backendMediaUrl(activeLookStorageKey)} alt={activeLookName}
                                                className="max-h-[260px] w-full cursor-zoom-in object-contain" data-studio-look-preview
                                                onClick={() => setPreview({ key: activeLookStorageKey, title: `${selectedCastName} · ${activeLookName}` })} />
                                        ) : (
                                            <div className="grid h-32 place-items-center text-muted-foreground"><Shirt className="size-6 opacity-40" /></div>
                                        )}
                                        <LookThumbStates locked={activeLookImage.locked} busy={activeLookStatus.busy} failed={activeLookStatus.failed} error={activeLookStatus.info?.error} />
                                    </div>
                                    <div className="mt-2 flex items-center gap-2 text-[11px]">
                                        <span className="truncate font-medium" title={activeLookName}>{activeLookName}</span>
                                        <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                                            activeLookStatus.failed ? "bg-rose-500/15 text-rose-500" : activeLookStatus.busy ? "bg-primary/15 text-primary" : activeLookImage.locked ? "bg-amber-500/15 text-amber-600" : "bg-muted text-muted-foreground")}>{activeLookStatus.badge}</span>
                                    </div>
                                    <div className="mt-0.5 text-[11px] text-muted-foreground">所属角色 {selected.castName} · {chapterLabel(activeLookImage.fromChapter, activeLookImage.toChapter)}</div>
                                    <div className="mt-1 line-clamp-3 text-[11px] text-muted-foreground">{activeLookImage.outfitDescription || "（无外观描述）"}</div>
                                    <div className="mt-2 flex flex-wrap items-center gap-2" data-studio-look-actions>
                                        <button type="button" onClick={onGenerateActiveLook} data-studio-look-generate
                                            disabled={!baseImage?.storageKey || activeLookStatus.busy}
                                            title={!baseImage?.storageKey
                                                ? "请先生成或上传角色本体参考图，造型图需要以它为底图"
                                                : activeLookStatus.failed
                                                    ? "上次造型图生成失败，点此重试"
                                                    : activeLookImage.locked
                                                        ? "已锁定：重新生成会覆盖当前造型图"
                                                        : activeLookImage.storageKey ? "按外观描述重新生成造型图" : "生成这套造型图"}
                                            className={cn("flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50", activeLookStatus.busy && "text-primary", activeLookStatus.failed && "text-rose-500")}>
                                            <Play className="size-3" /> {activeLookStatus.busy ? "生成中…" : activeLookStatus.failed ? "重试生成" : activeLookImage.locked ? "重新生成" : activeLookImage.storageKey ? "重新生成" : "生成造型图"}
                                        </button>
                                        <button type="button" onClick={onEditActiveLook} aria-label={`编辑造型 ${activeLookName}`}
                                            className="rounded-md border border-border p-1 text-muted-foreground hover:bg-muted"><Pencil className="size-3" /></button>
                                        <button type="button" onClick={onRemoveActiveLook} aria-label={`删除造型 ${activeLookName}`}
                                            className="rounded-md border border-border p-1 text-rose-500 hover:bg-rose-500/10"><Trash2 className="size-3" /></button>
                                        <button type="button" onClick={onEditActiveLook} className="flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted"><Library className="size-3" /> 素材库</button>
                                        <button type="button" onClick={onEditActiveLook} className="flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted"><Upload className="size-3" /> 自定义图</button>
                                    </div>
                                </div>
                            ) : (
                                <div className="rounded-lg border border-dashed border-border p-3 text-[11px] text-muted-foreground" data-studio-look-detail-hint>
                                    点左侧造型卡，在右栏编辑名称、外观与章节区间，或生成/上传造型图；「添加造型」给当前角色新建。
                                </div>
                            )}
                        </div>
                    ) : null}
                </aside>
            </div>

            {/* 造型图放大预览（对齐影策 cast-looks 放大查看） */}
            <Modal title={preview?.title || "造型图"} open={Boolean(preview)} onCancel={() => setPreview(null)} footer={null} width={560} centered>
                {preview ? <img src={backendMediaUrl(preview.key)} alt={preview.title} className="mx-auto max-h-[70vh] max-w-full object-contain" /> : null}
            </Modal>
        </div>
    );
}
