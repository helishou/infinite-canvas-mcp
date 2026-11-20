import { useMemo, useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { App, Modal, Input, Checkbox } from "antd";
import {
    Users, Shirt, Package, MapPin, Sparkles, Plus, Lock, LockOpen, Image as ImageIcon,
    Save, Trash2, Wand2, RefreshCw, Upload, Mic, Maximize2, Play, Volume2, History,
} from "lucide-react";

import {
    editEpisodeProduction,
    applyBackendCanvasOperations,
    backendMediaUrl,
    prepareProductionTargets,
    fetchEpisodeProduction,
    fetchBackendProject,
    fetchDramaCastImpact,
    fetchDramaAssetVersions,
    restyleDramaCast,
    type ApprovedSharedAsset,
    request,
    BackendApiError,
    type SharedAssetWrite,
} from "@/services/backend-api";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import type { ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { createManualDirectorAsset } from "@/pages/drama/manual-director-assets";
import { withArtStyle } from "@basketikun/canvas-agent/drama/art-style";
import { ASSET_SCHEMES, defaultSchemeFor, schemeAppliesTo, type AssetSchemeId } from "@basketikun/canvas-agent/drama/asset-spec";
import { artStyleOptions } from "@/pages/drama/planning-topic-logic";
import { uploadMediaFile } from "@/services/file-storage";
import { nanoid } from "nanoid";
import { saveLibraryAsset, libraryErrorText, useAssetStore, type Asset, type AudioAsset, type CharacterImage, type SceneImage } from "@/stores/use-asset-store";
import { StudioLooksPanel } from "./studio-looks-panel";
import { cn } from "@/lib/utils";

/** 一集制作稿的可编辑快照：source（真值）+ revision（乐观锁基线）+ 生成状态。 */
export type AssetProduction = { source: Record<string, unknown> | null; revision: number; assets: Record<string, unknown>; assetCards: unknown[]; /** 段请求附图真值（director.artifacts 的 h3），按集核查用它判 issue。 */ artifacts?: Array<Record<string, unknown>> };
/** 「打开资产设定」跳转目标：来自按集核查的真实资产记录 ID / 名称 / 分类。 */
export type AssetsFocus = { assetId: string; name: string; kind: string };
/** 汇总到资产库的单集来源（带 episodeId + revision 供写回）。 */
export type CastSource = { episodeNo: number; episodeId: string; revision: number; source: Record<string, unknown> | null; assets: Record<string, unknown>; assetCards: unknown[]; /** 该集画布 ID：制作稿 media.nodeId 据此定位实体节点，存入共享画布时作为 canvasSource。 */ canvasId?: string };

type Row = Record<string, any>;
export type CastKind = "角色" | "造型" | "道具" | "场景";
type Entity = "character" | "environment" | "asset";
type GenStatus = "ready" | "failed" | "busy" | "idle";

/**
 * 影策角色设定新增字段在本地的真实落点（不造假数据）：
 * patch_director_source 对 character 采用严格字段白名单（name/appearance/description/
 * prompt_description/identity/voice_description/voice），新键（alias_names 等）会被后端
 * 400 拒绝，实证确认。故：别名与单独风格以 JSON 存进白名单字段 identity；参考图生成
 * 提示词存进资产卡 prompt（真正驱动生图的字段）；声音样本仍是 character.voice 记录。
 *
 * 第五轮对照「上传形象图 / 从素材库选择采用并锁定」的真值链路（只读实证）：
 * 后端存在真实可调用路由 POST /drama/pipeline/assets/bind-image（drama-pipeline-routes.ts:102）
 * → bindPipelineAssetImage 校验媒体真实归档并算 sha256，写 draft/published.director.assets[assetId]
 * 与实体节点 metadata（characterImages/sceneImage/propImage）——这正是剧情段视频取参考图的来源，
 * 状态写 generated 使流水线不再自动重生成覆盖。上传走 uploadMediaFile→/media（真实归档），
 * 选图复用本地素材库 AssetPickerModal（allowedKinds=image）。分集实体走 bind-image；
 * 共享画布条目走 POST /drama/pipeline/assets/adopt-shared-image：把图片写到共享画布
 * canonical 节点，经 writeThrough 派生同步传播到消费分集 director.assets 与段视频参考图。
 */
type CastExtra = {
    aliasNames?: string[];
    imageStyleId?: string;
    imageStyleName?: string;
    imageStylePrompt?: string;
};
function parseExtra(v: unknown): CastExtra {
    if (typeof v !== "string" || !v.trim().startsWith("{")) return {};
    try {
        const o = JSON.parse(v);
        return o && typeof o === "object" && !Array.isArray(o) ? o as CastExtra : {};
    } catch { return {}; }
}
const stringifyExtra = (extra: CastExtra): string => JSON.stringify(extra);
const styleSlug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "custom";

/** 从真实生成状态派生：director.assets[id].status + asset_card.generation_status。 */
function deriveGenStatus(assetId: string, assets: Record<string, unknown>, cards: unknown[]): { status: GenStatus; thumb: string } {
    const a = (assets[assetId] || {}) as Record<string, unknown>;
    const card = cards.find((c) => String((c as Row)?.asset_id || (c as Row)?.id || "") === assetId) as Row | undefined;
    const cardStatus = String(card?.generation_status || "").toLowerCase();
    const assetStatus = String(a.status || "").toLowerCase();
    const storageKey = String(a.storageKey || card?.output_file || "");
    let status: GenStatus = "idle";
    if (["generated", "ready", "approved"].includes(assetStatus) || ["generated", "ready"].includes(cardStatus)) status = "ready";
    else if (["failed", "error"].includes(assetStatus) || ["failed", "error"].includes(cardStatus)) status = "failed";
    else if (["queued", "running", "generating", "pending"].includes(assetStatus) || ["queued", "running", "generating", "pending"].includes(cardStatus)) status = "busy";
    return { status, thumb: status === "ready" && storageKey ? backendMediaUrl(storageKey) : "" };
}

/** 声音样本：character.voice 记录（可能是对象或旧字符串）。 */
function parseVoice(v: unknown): { voiceAssetId: string; voiceStorageKey: string; voiceUrl: string } {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    return {
        voiceAssetId: str(o.assetId),
        voiceStorageKey: str(o.storageKey),
        voiceUrl: str(o.url),
    };
}

const rows = (v: unknown): Row[] => Array.isArray(v) ? v.filter((x): x is Row => Boolean(x) && typeof x === "object" && !Array.isArray(x)) : [];
const str = (v: unknown): string => (typeof v === "string" || typeof v === "number") ? String(v) : "";

type Entry = {
    key: string;
    id: string; name: string; kind: CastKind; role: string;
    description: string; appearance: string; voice: string; coverUrl: string;
    // 写回定位：真值来自哪一集制作稿 + 哪个 registry 实体
    episodeId: string; revision: number; entity: Entity; entityId: string;
    /** 资产卡 ID（AC-CHAR-xxx）；资产卡提示词按它写回，不是 entityId。 */
    assetId: string;
    locked: boolean;
    genStatus: GenStatus; thumb: string;
    prompt: string;
    // 影策对齐字段（真实落点见文件头注释）
    aliasNames: string[];
    imageStyleId: string; imageStyleName: string; imageStylePrompt: string;
    imagePrompt: string;
    scheme: AssetSchemeId;
    // 声音样本（真实：character.voice 记录）
    voiceAssetId: string; voiceStorageKey: string; voiceUrl: string;
    /** 资产作用域：shared=共享资产画布节点（跨集共用）；episode=某集制作稿里的资产。 */
    scope: "shared" | "episode";
    /** 共享画布节点的画布ID/节点ID/revision，仅供 shared 写回定位。 */
    canvasId?: string; nodeId?: string; canvasRevision?: number;
    /** 存入共享画布时使用的资产记录 ID：shared 取 canonical assetId，episode 取 asset_plan.id。 */
    libraryAssetId: string;
    /** 真实参考图 storageKey（共享节点 metadata 或制作稿 media.storageKey/output_file）。 */
    referenceStorageKey: string;
};

type CastDraft = {
    key: string; name: string; description: string; voice: string;
    aliasNames: string[]; hasOwnStyle: boolean;
    imageStyleId: string; imageStyleName: string; imageStylePrompt: string; imagePrompt: string;
    scheme: AssetSchemeId;
};

const KIND_TABS: Array<{ key: CastKind; icon: React.ComponentType<{ className?: string }> }> = [
    { key: "角色", icon: Users },
    { key: "造型", icon: Shirt },
    { key: "道具", icon: Package },
    { key: "场景", icon: MapPin },
];

/** 从 raw 记录判定参考图是否锁定：asset_plan.status=approved 或资产卡有 approved 图。 */
function isLocked(raw: Row): boolean {
    return String(raw.status || "").toLowerCase() === "approved";
}

const draftOf = (e: Entry): CastDraft => ({
    key: e.key, name: e.name, description: e.description || e.appearance, voice: e.voice,
    aliasNames: [...e.aliasNames],
    hasOwnStyle: Boolean(e.imageStyleName || e.imageStylePrompt),
    imageStyleId: e.imageStyleId, imageStyleName: e.imageStyleName, imageStylePrompt: e.imageStylePrompt,
    imagePrompt: e.imagePrompt,
    scheme: e.scheme,
});

/**
 * 影策「项目资产 / 资产库」——各集制作稿真值汇总 + 真实写回。
 * 保存/新增/删除/锁定走 backend 的 editEpisodeProduction（patch_director_source /
 * create_manual_director_asset / delete_director_asset），带 revision 乐观锁。
 */
/** 换音色录音上限（秒）：与影策一致，到点由真实计时器自动停止并走完成上传绑定。 */
const VOICE_RECORD_LIMIT_SEC = 30;

export function StudioCastPanel({ dramaId, sharedAssetCanvasId, sources, artStyle, onOpenCanvas, onOpenSharedCanvas, onChanged, voiceProfiles, initialKind, focusAsset }: {
    /** 当前剧目 ID：saveLibraryAsset 写共享画布必须的 dramaId。 */
    dramaId: string | null;
    sharedAssetCanvasId: string | null;
    sources: CastSource[];
    artStyle: string;
    onOpenCanvas: () => void;
    /** 共享条目换参考图：打开共享资产画布（owner=canvas），不是当前集画布。 */
    onOpenSharedCanvas?: () => void;
    onChanged: () => void;
    /** 制作设置「音色库」登记的音色档案（sampleRef=storageKey），可在角色声音选择里直接绑定。 */
    voiceProfiles?: Array<{ id: string; name: string; description: string; sampleRef: string }>;
    initialKind?: CastKind;
    /** 按集核查「打开资产设定」：切到资产库后按真值 ID/名称选中对应条目。 */
    focusAsset?: AssetsFocus | null;
}) {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const allAssets = useAssetStore((s) => s.assets);
    const audioAssets = useMemo(() => allAssets.filter((a): a is AudioAsset => a.kind === "audio"), [allAssets]);
    // 音色库里登记了有效 sampleRef 的档案，作为声音选项合并进素材库音频（真实写 character.voice）。
    const profileAudioOptions = useMemo(
        () => (voiceProfiles || []).filter(p => p.sampleRef.trim()).map(p => ({ id: `voiceprofile:${p.id}`, title: `${p.name || p.id}（音色库）`, storageKey: p.sampleRef.trim(), url: "" })),
        [voiceProfiles],
    );
    const [kind, setKind] = useState<CastKind>(initialKind || "角色");
    useEffect(() => { if (initialKind) setKind(initialKind); }, [initialKind]);
    const [lookCount, setLookCount] = useState(0);
    const [filter, setFilter] = useState<"all" | "failed" | "busy" | "locked">("all");
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [draft, setDraft] = useState<CastDraft | null>(null);
    const [saving, setSaving] = useState(false);
    const [generating, setGenerating] = useState<string | null>(null);
    const [batchPrep, setBatchPrep] = useState<{ done: number; total: number } | null>(null);
    const [adding, setAdding] = useState(false);
    // 真新建提交 pending：与弹窗 open(adding) 分离，避免一打开 OK 就常驻 loading；
    // 也用它锁住 Esc/遮罩/X/取消，禁止提交中关闭（对齐影策 cast-create-dialog.tsx create.isPending）。
    const [addPending, setAddPending] = useState(false);
    const [addDraft, setAddDraft] = useState<{ kind: CastKind; name: string; description: string; voice: string }>({ kind: "角色", name: "", description: "", voice: "" });
    const [aliasInput, setAliasInput] = useState("");
    const [voiceBusy, setVoiceBusy] = useState(false);
    const [recording, setRecording] = useState(false);
    const [recordRemain, setRecordRemain] = useState(VOICE_RECORD_LIMIT_SEC); // 录音倒计时剩余秒数
    const audioFileRef = useRef<HTMLInputElement>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const recordStreamRef = useRef<MediaStream | null>(null); // 当前麦克风流，取消/结束/卸载时释放
    const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null); // 30 秒上限计时器
    const recordLeftRef = useRef(VOICE_RECORD_LIMIT_SEC); // 计时器用的剩余秒数（避免 updater 内做副作用）
    const recordUploadRef = useRef(true); // onstop 是否上传绑定：取消置 false

    // 卸载时兜底清理：停计时器、停录音（不上传）、释放麦克风流，避免麦克风一直占用。
    useEffect(() => () => {
        if (recordTimerRef.current !== null) clearInterval(recordTimerRef.current);
        const rec = recorderRef.current;
        if (rec && rec.state !== "inactive") { recordUploadRef.current = false; rec.stop(); }
        recordStreamRef.current?.getTracks().forEach((t) => t.stop());
    }, []);
    // 形象图采用：上传/素材库选图 → bind-image 真实写回 storageKey + 实体节点（剧情段视频据此取参考图并锁定）
    const imageFileRef = useRef<HTMLInputElement>(null);
    const [adoptOpen, setAdoptOpen] = useState(false);
    const [imageAdopting, setImageAdopting] = useState(false);

    // 设定级 restyle（对齐影策 panels.tsx:367/497-505）：默认 true，只读影响集 + 保存/换音色时真标脏引用段。
    // 影策 CastVoiceField 把同一 restyle 作为 setDramaCastVoice 的 restyleSegments 传入，默认勾选。
    const [restyle, setRestyle] = useState(true);
    const [castImpact, setCastImpact] = useState<Awaited<ReturnType<typeof fetchDramaCastImpact>> | null>(null);
    const [castImpactLoading, setCastImpactLoading] = useState(false);
    const [castImpactTick, setCastImpactTick] = useState(0);

    // 设定详情版本记录：真值 drama_asset_versions 按 (dramaId, assetId) 只读查询。
    const [assetVersions, setAssetVersions] = useState<ApprovedSharedAsset[]>([]);
    const [assetVersionsLoading, setAssetVersionsLoading] = useState(false);
    const [versionPreview, setVersionPreview] = useState<ApprovedSharedAsset | null>(null);
    const [restyleSubmitting, setRestyleSubmitting] = useState(false);

    // 共享资产画布真值节点（character/scene/prop），跨集共用；与造型面板同一拉取模式。
    type SharedNode = { id: string; type: string; title?: string; metadata?: Record<string, any> };
    const [sharedNodes, setSharedNodes] = useState<SharedNode[]>([]);
    const [sharedCanvasRev, setSharedCanvasRev] = useState(0);
    const [sharedLoading, setSharedLoading] = useState(false);
    const [sharedRefreshTick, setSharedRefreshTick] = useState(0);
    useEffect(() => {
        let alive = true;
        if (!sharedAssetCanvasId) { setSharedNodes([]); return; }
        setSharedLoading(true);
        void fetchBackendProject(sharedAssetCanvasId)
            .then((r) => {
                if (!alive) return;
                const nodes = ((r.project?.nodes || []) as SharedNode[]).filter(n => ["character", "scene", "prop"].includes(n.type));
                setSharedNodes(nodes);
                setSharedCanvasRev(Number(r.project?.revision || 0));
            })
            .catch(() => { if (alive) { setSharedNodes([]); } })
            .finally(() => { if (alive) setSharedLoading(false); });
        return () => { alive = false; };
    }, [sharedAssetCanvasId, sharedRefreshTick]);

    /**
     * 共享画布节点的正式生成目标：节点 ID 不是生产实体 ID，必须读 metadata.productionEntity 的真实绑定。
     * 同时按 entity_id 找到 asset_plan / asset_card，供提示词真实写回共享制作稿（不拿 nodeId 当资产卡 ID）。
     * 没有正式实体绑定的库节点返回 null —— 不伪造目标。
     */
    const sharedEntityForNode = (nodeId: string | undefined, source: Record<string, unknown> | null): { target: string; assetCardId: string } | null => {
        const node = sharedNodes.find(n => n.id === nodeId);
        const binding = node?.metadata?.productionEntity as Row | undefined;
        if (!binding || typeof binding !== "object") return null;
        if (String(binding.ownerKind || "") !== "canvas") return null;
        if (sharedAssetCanvasId && String(binding.ownerId || "") !== sharedAssetCanvasId) return null;
        const kind = String(binding.kind || ""), entityId = String(binding.entityId || "");
        if (!["character", "scene", "prop"].includes(kind) || !entityId) return null;
        const plan = rows(source?.asset_plan).find(p => String(p.entity_id || p.id || p.asset_id) === entityId);
        return { target: `entity:${kind}:${entityId}`, assetCardId: String(plan?.id || plan?.asset_id || "") };
    };

    const entries = useMemo<Entry[]>(() => {
        const out: Entry[] = [];
        for (const src of sources) {
            if (!src.source) continue;
            const epLabel = `第 ${src.episodeNo} 集`;
            const loc = { episodeId: src.episodeId, revision: src.revision };
            // entityId(CHAR-AC-xxx) → asset_plan.id(AC-CHAR-xxx) → director.assets 状态
            const planRows = rows(src.source.asset_plan);
            const assetIdFor = (entityId: string, fallback: string): string => {
                const plan = planRows.find(p => str(p.entity_id) === entityId || str(p.id) === entityId || str(p.asset_id) === entityId);
                return plan ? str(plan.id || plan.asset_id) : fallback;
            };
            const gen = (assetId: string) => deriveGenStatus(assetId, src.assets, src.assetCards);
            const promptFor = (assetId: string): string => {
                const card = src.assetCards.find((c) => String((c as Row)?.asset_id || (c as Row)?.id || "") === assetId) as Row | undefined;
                return String(card?.prompt || "");
            };
            const schemeFor = (assetId: string, kind: "character" | "scene" | "prop"): AssetSchemeId => {
                const card = src.assetCards.find((c) => String((c as Row)?.asset_id || (c as Row)?.id || "") === assetId) as Row | undefined;
                const raw = String(card?.view_layout || "").trim() as AssetSchemeId;
                return raw && schemeAppliesTo(raw, kind) ? raw : defaultSchemeFor(kind);
            };
            for (const raw of rows(src.source.character_registry)) {
                const aid = assetIdFor(str(raw.id), str(raw.id));
                const g = gen(aid);
                const extra = parseExtra(raw.identity);
                const media = (src.assets[aid] || {}) as Row;
                const card = src.assetCards.find((c) => String((c as Row)?.asset_id || (c as Row)?.id || "") === aid) as Row | undefined;
                const episodeNodeId = str(media.nodeId);
                out.push({
                    key: `character:${src.episodeId}:${str(raw.id)}`,
                    id: str(raw.id), name: str(raw.name || raw.character_name) || str(raw.id),
                    kind: "角色", role: str(raw.role || raw.character_role || "配角"),
                    description: str(raw.description), appearance: str(raw.appearance || ""),
                    voice: str(raw.voice_description || raw.voice), coverUrl: str(raw.coverUrl || raw.reference_image),
                    ...loc, entity: "character", entityId: str(raw.id), assetId: aid, locked: isLocked(raw),
                    genStatus: g.status, thumb: g.thumb, prompt: promptFor(aid),
                    aliasNames: Array.isArray(extra.aliasNames) ? extra.aliasNames.filter(x => typeof x === "string") : [],
                    imageStyleId: str(extra.imageStyleId), imageStyleName: str(extra.imageStyleName), imageStylePrompt: str(extra.imageStylePrompt),
                    imagePrompt: promptFor(aid),
                    scheme: schemeFor(aid, "character"),
                    ...parseVoice(raw.voice),
                    scope: "episode",
                    ...(episodeNodeId && src.canvasId ? { canvasId: src.canvasId, nodeId: episodeNodeId } : {}),
                    libraryAssetId: aid || str(raw.id),
                    referenceStorageKey: str(media.storageKey || card?.output_file),
                });
            }
            for (const raw of rows(src.source.scene_registry)) {
                const aid = assetIdFor(str(raw.id), str(raw.id));
                const g = gen(aid);
                const media = (src.assets[aid] || {}) as Row;
                const card = src.assetCards.find((c) => String((c as Row)?.asset_id || (c as Row)?.id || "") === aid) as Row | undefined;
                const episodeNodeId = str(media.nodeId);
                out.push({
                    key: `environment:${src.episodeId}:${str(raw.id)}`,
                    id: str(raw.id), name: str(raw.name || raw.scene_name) || str(raw.id),
                    kind: "场景", role: "环境", description: str(raw.description), appearance: str(raw.prompt_description || raw.appearance || ""),
                    voice: "", coverUrl: str(raw.coverUrl || raw.reference_image),
                    ...loc, entity: "environment", entityId: str(raw.id), assetId: aid, locked: isLocked(raw),
                    genStatus: g.status, thumb: g.thumb, prompt: promptFor(aid),
                    aliasNames: [], imageStyleId: "", imageStyleName: "", imageStylePrompt: "", imagePrompt: "",
                    scheme: schemeFor(aid, "scene"),
                    voiceAssetId: "", voiceStorageKey: "", voiceUrl: "",
                    scope: "episode",
                    ...(episodeNodeId && src.canvasId ? { canvasId: src.canvasId, nodeId: episodeNodeId } : {}),
                    libraryAssetId: aid || str(raw.id),
                    referenceStorageKey: str(media.storageKey || card?.output_file),
                });
            }
            for (const raw of rows(src.source.asset_plan)) {
                const k = str(raw.kind || raw.asset_type).toLowerCase();
                const kindCast: CastKind | null = k === "prop" || k === "道具" ? "道具" : k === "look" || k === "造型" ? "造型" : null;
                if (!kindCast) continue;
                const aid = str(raw.id || raw.asset_id);
                const g = gen(aid);
                const media = (src.assets[aid] || {}) as Row;
                const card = src.assetCards.find((c) => String((c as Row)?.asset_id || (c as Row)?.id || "") === aid) as Row | undefined;
                const episodeNodeId = str(media.nodeId);
                out.push({
                    key: `asset:${src.episodeId}:${aid}`,
                    id: aid, name: str(raw.name || raw.asset_name) || aid,
                    kind: kindCast, role: kindCast === "道具" ? "道具" : "妆造", description: str(raw.description || raw.prompt),
                    appearance: "", voice: "", coverUrl: str(raw.coverUrl || raw.reference_image),
                    ...loc, entity: "asset", entityId: aid, assetId: aid, locked: isLocked(raw),
                    genStatus: g.status, thumb: g.thumb, prompt: promptFor(aid),
                    aliasNames: [], imageStyleId: "", imageStyleName: "", imageStylePrompt: "", imagePrompt: "",
                    scheme: schemeFor(aid, "prop"),
                    voiceAssetId: "", voiceStorageKey: "", voiceUrl: "",
                    scope: "episode",
                    ...(episodeNodeId && src.canvasId ? { canvasId: src.canvasId, nodeId: episodeNodeId } : {}),
                    libraryAssetId: aid || str(raw.id),
                    referenceStorageKey: str(media.storageKey || card?.output_file),
                });
            }
            void epLabel;
        }
        // 合入共享资产画布真值节点（跨集共用），scope=shared；按 kind:name 去重时共享优先。
        // canonical 资产记录 ID = library- 节点 ID 的后缀；character 节点另有 characterAssetId 可直接给出。
        const canonicalAssetId = (nodeId: string, explicit: unknown): string => {
            const value = String(explicit || "");
            return value || (nodeId.startsWith("library-") ? nodeId.slice("library-".length) : nodeId);
        };
        for (const n of sharedNodes) {
            const md = n.metadata || {};
            const thumbOf = (sk: unknown) => sk ? backendMediaUrl(String(sk)) : "";
            if (n.type === "character") {
                const imgs = Array.isArray(md.characterImages) ? md.characterImages : [];
                const primary = Number(md.characterPrimaryIndex || 0);
                const cover = imgs[primary] || imgs[0];
                out.push({
                    key: `shared:character:${n.id}`, id: String(md.characterAssetId || n.id),
                    name: String(md.characterName || n.title || n.id), kind: "角色",
                    role: String(md.characterRole || "配角"), description: String(md.characterDescription || ""),
                    appearance: String(md.characterDescription || ""), voice: String(md.characterVoiceDescription || ""),
                    coverUrl: thumbOf(cover?.storageKey),
                    episodeId: "", revision: 0, entity: "character", entityId: String(md.characterAssetId || n.id),
                    assetId: String(md.characterAssetId || n.id), locked: false,
                    genStatus: cover?.storageKey ? "ready" : "idle", thumb: thumbOf(cover?.storageKey), prompt: String(md.prompt || ""),
                    aliasNames: [], imageStyleId: "", imageStyleName: "", imageStylePrompt: "", imagePrompt: String(md.prompt || ""),
                    scheme: defaultSchemeFor("character"),
                    voiceAssetId: String(md.characterVoiceAssetId || ""), voiceStorageKey: String(md.characterVoiceStorageKey || ""), voiceUrl: String(md.characterVoiceUrl || ""),
                    scope: "shared", canvasId: sharedAssetCanvasId || undefined, nodeId: n.id, canvasRevision: sharedCanvasRev,
                    libraryAssetId: canonicalAssetId(n.id, md.characterAssetId),
                    referenceStorageKey: String(cover?.storageKey || md.storageKey || ""),
                });
            } else if (n.type === "scene") {
                out.push({
                    key: `shared:scene:${n.id}`, id: n.id, name: String(md.sceneName || n.title || n.id),
                    kind: "场景", role: "环境", description: String(md.sceneDescription || ""), appearance: String(md.sceneDescription || ""),
                    voice: "", coverUrl: thumbOf(md.sceneImage?.storageKey),
                    episodeId: "", revision: 0, entity: "environment", entityId: n.id, assetId: n.id, locked: false,
                    genStatus: md.sceneImage?.storageKey ? "ready" : "idle", thumb: thumbOf(md.sceneImage?.storageKey), prompt: String(md.prompt || ""),
                    aliasNames: [], imageStyleId: "", imageStyleName: "", imageStylePrompt: "", imagePrompt: String(md.prompt || ""),
                    scheme: defaultSchemeFor("scene"), voiceAssetId: "", voiceStorageKey: "", voiceUrl: "",
                    scope: "shared", canvasId: sharedAssetCanvasId || undefined, nodeId: n.id, canvasRevision: sharedCanvasRev,
                    libraryAssetId: canonicalAssetId(n.id, md.sceneAssetId || md.assetId),
                    referenceStorageKey: String(md.sceneImage?.storageKey || md.storageKey || ""),
                });
            } else if (n.type === "prop") {
                out.push({
                    key: `shared:prop:${n.id}`, id: n.id, name: String(md.propName || md.itemName || n.title || n.id),
                    kind: "道具", role: "道具", description: String(md.propDescription || md.itemDescription || ""), appearance: "",
                    voice: "", coverUrl: thumbOf(md.propImage?.storageKey),
                    episodeId: "", revision: 0, entity: "asset", entityId: n.id, assetId: n.id, locked: false,
                    genStatus: md.propImage?.storageKey ? "ready" : "idle", thumb: thumbOf(md.propImage?.storageKey), prompt: String(md.prompt || ""),
                    aliasNames: [], imageStyleId: "", imageStyleName: "", imageStylePrompt: "", imagePrompt: String(md.prompt || ""),
                    scheme: defaultSchemeFor("prop"), voiceAssetId: "", voiceStorageKey: "", voiceUrl: "",
                    scope: "shared", canvasId: sharedAssetCanvasId || undefined, nodeId: n.id, canvasRevision: sharedCanvasRev,
                    libraryAssetId: canonicalAssetId(n.id, md.productionAssetId || md.assetId),
                    referenceStorageKey: String(md.propImage?.storageKey || md.storageKey || ""),
                });
            }
        }
        const seen = new Set<string>();
        // 共享资产优先：先放 shared 再放 episode，同名时保留前者。
        const ordered = [...out].sort((a, b) => (a.scope === "shared" ? 0 : 1) - (b.scope === "shared" ? 0 : 1));
        return ordered.filter(e => { const k = `${e.kind}:${e.name}`; if (seen.has(k)) return false; seen.add(k); return true; });
    }, [sources, sharedNodes, sharedCanvasRev, sharedAssetCanvasId]);

    // 按集核查「打开资产设定」：从该资产行的真值 ID/名称/分类定位资产库条目并选中。
    // 依赖 entries：制作稿异步就绪后仍能选中；找不到就不伪造选中项（落到原逻辑）。
    useEffect(() => {
        if (!focusAsset) return;
        const wantedKind: CastKind | null = focusAsset.kind === "scene" ? "场景"
            : focusAsset.kind === "prop" ? "道具"
            : focusAsset.kind === "character" ? "角色" : null;
        const matches = entries.filter((e) =>
            e.assetId === focusAsset.assetId || e.libraryAssetId === focusAsset.assetId
            || e.id === focusAsset.assetId || (focusAsset.name && e.name === focusAsset.name));
        const entry = (wantedKind ? matches.find((e) => e.kind === wantedKind) : undefined) || matches[0];
        if (entry) {
            setKind(entry.kind);
            setFilter("all");
            setSelectedKey(entry.key);
            setDraft(draftOf(entry));
        }
    }, [focusAsset, entries]);

    // 造型 tab 的集 ID 列表要稳定引用，避免子组件读取Effect每次渲染都重跑。
    const looksEpisodeIds = useMemo(() => sources.map(s => s.episodeId), [sources]);

    const counts = useMemo(() => {
        const c: Record<CastKind, number> = { 角色: 0, 造型: 0, 道具: 0, 场景: 0 };
        for (const e of entries) c[e.kind] += 1;
        return c;
    }, [entries]);

    const visible = entries.filter(e => {
        if (e.kind !== kind) return false;
        if (filter === "failed") return e.genStatus === "failed";
        if (filter === "busy") return e.genStatus === "busy";
        if (filter === "locked") return e.locked;
        return true;
    });
    const failedCount = entries.filter(e => e.genStatus === "failed").length;
    const busyCount = entries.filter(e => e.genStatus === "busy").length;
    const lockedCount = entries.filter(e => e.locked).length;
    const current = visible.find(e => e.key === selectedKey) || visible[0] || null;
    const librarySavedKind = (e: Entry) => e.entity === "character" ? "character" : e.entity === "environment" ? "scene" : "prop";
    const isLibrarySaved = Boolean(current && (current.scope === "shared" || allAssets.some(a => a.id === current.libraryAssetId && a.kind === librarySavedKind(current))));

    // 切换选中项时载入受控草稿（草稿带 key，切项自动回落到该条目的真实值）。
    // 不重置 restyle：影策 panels.tsx 的 restyle 是设定面板级开关（默认 true），切角色不自动关；
    // 换音色后的标脏依赖它保持用户选择。
    const selectEntry = (e: Entry) => { setSelectedKey(e.key); setDraft(draftOf(e)); setAliasInput(""); };
    const shownDraft = draft && current && draft.key === current.key ? draft : (current ? draftOf(current) : null);
    const patchDraft = (patch: Partial<CastDraft>) => { if (shownDraft) setDraft({ ...shownDraft, ...patch }); };

    // 设定级 restyle 的 castId 必须能被后端 h3CharacterGroups/referenceBindings 反查：
    // 共享画布角色节点没有 characterAssetId（productionEntity.entityId 是 C_XXX），
    // 裸 nodeId 反查恒为 0 段；各集制作稿 character_registry.id 才是 CHAR_/SHARED_ 真值。
    // 按角色名取真值，不编造 ID；没有匹配时仍退回 entityId（影响集为 0，诚实显示）。
    const resolvableCastIdByName = useMemo(() => {
        const map = new Map<string, string>();
        for (const src of sources) {
            for (const raw of rows(src.source?.character_registry)) {
                const id = str(raw.id), name = str(raw.name || raw.character_name);
                if (name && /^(CHAR_|SHARED_)/.test(id) && !map.has(name)) map.set(name, id);
            }
        }
        return map;
    }, [sources]);

    // 设定详情的 restyle 影响集：只读真实查询；没有 dramaId / 设定 ID 时保持 null，不造假数字。
    const currentCastId = current ? (resolvableCastIdByName.get(current.name) || current.entityId || "") : "";
    useEffect(() => {
        let alive = true;
        if (!dramaId || !currentCastId) { setCastImpact(null); return; }
        setCastImpactLoading(true);
        fetchDramaCastImpact(dramaId, currentCastId)
            .then((result) => { if (alive) setCastImpact(result.ok ? result : null); })
            .catch(() => { if (alive) setCastImpact(null); })
            .finally(() => { if (alive) setCastImpactLoading(false); });
        return () => { alive = false; };
    }, [dramaId, currentCastId, castImpactTick]);

    // 版本记录：dramaId + 当前设定 assetId 决定真值查询；缺 ID 时清空，不造假列表。
    const currentVersionAssetId = current?.assetId || current?.libraryAssetId || "";
    useEffect(() => {
        let alive = true;
        if (!dramaId || !currentVersionAssetId) { setAssetVersions([]); return; }
        setAssetVersionsLoading(true);
        fetchDramaAssetVersions(dramaId, currentVersionAssetId)
            .then((r) => { if (alive) setAssetVersions(r.ok ? r.versions || [] : []); })
            .catch(() => { if (alive) setAssetVersions([]); })
            .finally(() => { if (alive) setAssetVersionsLoading(false); });
        return () => { alive = false; };
    }, [dramaId, currentVersionAssetId]);

    /** 真提交设定级 restyle：查真实影响集 → 确认 → 复用造型面板同款 restyleDramaCast 标脏引用段。 */
    const doCastRestyle = async () => {
        if (!dramaId || !currentCastId) {
            message.warning("当前未定位到剧目或设定，无法查询影响段；请从剧目页进入设定面板");
            return;
        }
        setRestyleSubmitting(true);
        try {
            const impact = await fetchDramaCastImpact(dramaId, currentCastId);
            const generated = impact.targets.filter((target) => target.hasVideo && !target.inputOutdated);
            if (!generated.length) {
                message.info(impact.segments
                    ? `查到 ${impact.segments} 个引用段，但没有已出片、需要重做的视频`
                    : "没有找到引用该设定的剧情段，无需重生成");
                return;
            }
            let confirmed = false;
            await new Promise<void>((resolve) => {
                modal.confirm({
                    title: `让引用「${shownDraft?.name.trim() || current?.name || "该设定"}」的剧情段视频重新生成？`,
                    content: `真实影响 ${impact.episodes} 集 · ${impact.segments} 段；其中 ${generated.length} 段已出片将被标记为需重新生成，正在生成的段自动跳过。此操作写入画布段状态，不会删除原视频。`,
                    okText: "确认提交重生成",
                    cancelText: "取消",
                    onOk: () => { confirmed = true; resolve(); },
                    onCancel: () => resolve(),
                });
            });
            if (!confirmed) return;
            const submitted = await restyleDramaCast(dramaId, currentCastId, { restyleSegments: true });
            if (submitted.affectedSegments) {
                message.success(`已提交 ${submitted.affectedSegments} 个剧情段重新生成（引用该设定的视频已标脏）`);
            } else {
                message.info("没有可标脏的引用段（可能已全部过期或正在生成）");
            }
            setCastImpactTick((tick) => tick + 1);
        } catch (error) {
            message.error(`设定 restyle 失败：${(error as Error).message}`);
        } finally {
            setRestyleSubmitting(false);
        }
    };

    // 保存：patch_director_source 按实体字段白名单写回；影策新增字段落在 identity / 资产卡 prompt。
    const handleSave = async () => {
        if (!current || !shownDraft) return;
        const patch: Record<string, unknown> = {};
        const ops: ProductionOperation[] = [];
        if (current.entity === "character") {
            patch.name = shownDraft.name.trim();
            patch.description = shownDraft.description;
            patch.appearance = shownDraft.description;
            patch.voice_description = shownDraft.voice.trim();
            patch.identity = stringifyExtra({
                aliasNames: shownDraft.aliasNames,
                ...(shownDraft.hasOwnStyle ? {
                    imageStyleId: shownDraft.imageStyleId || styleSlug(shownDraft.imageStyleName),
                    imageStyleName: shownDraft.imageStyleName,
                    imageStylePrompt: shownDraft.imageStylePrompt,
                } : {}),
            });
        } else if (current.entity === "environment") {
            patch.name = shownDraft.name.trim();
            patch.description = shownDraft.description;
            patch.prompt_description = shownDraft.description;
        } else {
            patch.asset_name = shownDraft.name.trim();
            patch.description = shownDraft.description;
        }
        if (!patch.name && !patch.asset_name) return void message.warning("名称不能为空");
        ops.push({ type: "patch_director_source", entity: current.entity, id: current.entityId, patch });
        // 参考图方案 + 生成提示词 → 资产卡（真正驱动生图的字段），用 assetId 定位卡片而非 entityId。
        // view_layout 是白名单字段，pipeline 读它选方案模板；scene/prop 固定对应场景/道具方案。
        if (current.assetId) {
            ops.push({ type: "patch_director_source", entity: "asset_card", id: current.assetId,
                patch: { prompt: shownDraft.imagePrompt, view_layout: shownDraft.scheme } });
        }
        setSaving(true);
        try {
            await editEpisodeProduction(current.episodeId as never, current.revision, ops);
            message.success(`已保存「${shownDraft.name.trim()}」到第 ${sources.find(s => s.episodeId === current.episodeId)?.episodeNo ?? "?"} 集制作稿`);
            setDraft(null);
            onChanged();
            // 影策对齐：勾选「让引用它的剧情段视频重新生成」时，保存后走真实 restyle 标脏链路。
            if (restyle) await doCastRestyle();
        } catch (error) {
            message.error(`保存失败：${(error as Error).message}`);
        } finally {
            setSaving(false);
        }
    };

    /**
     * 存入资产库 = 写共享画布：saveLibraryAsset → POST /canvas/assets → writeDramaAsset。
     * 带 canvasSource（共享节点或分集实体节点）时回写 canonical 并把本集节点变引用；
     * 没有则新建 canonical。不另造 promotion，不写 drama_asset_versions。
     */
    const [librarySaving, setLibrarySaving] = useState(false);
    const handleSaveToLibrary = async () => {
        if (!current || !shownDraft) return;
        if (!dramaId) return void message.warning(t("canvas.sharedLibrary.unavailable"));
        const name = shownDraft.name.trim();
        if (!name) return void message.warning("名称不能为空");

        const assetKind = current.entity === "character" ? "character" : current.entity === "environment" ? "scene" : "prop";
        const previous = allAssets.find((a) => a.id === current.libraryAssetId && a.kind === assetKind);
        const sharedNode = current.scope === "shared" ? sharedNodes.find((n) => n.id === current.nodeId) : undefined;
        const md = (sharedNode?.metadata || {}) as Record<string, any>;
        const now = new Date().toISOString();
        const storageKey = current.referenceStorageKey;
        const imageUrl = storageKey ? backendMediaUrl(storageKey) : current.thumb;

        // 真实参考图记录：优先共享节点 metadata 里的原图（含尺寸/字节/mime），否则用制作稿里真实存在的 storageKey；
        // 制作稿没记录的尺寸/字节只能是 0、mimeType 空串，不编造来源。
        const rawImage = (assetKind === "character"
            ? (Array.isArray(md.characterImages) ? md.characterImages[Number(md.characterPrimaryIndex || 0)] || md.characterImages[0] : undefined)
            : assetKind === "scene" ? md.sceneImage : md.propImage) as Record<string, any> | undefined || {};
        const image: SceneImage = {
            url: String(rawImage.url || imageUrl),
            ...(storageKey || rawImage.storageKey ? { storageKey: String(storageKey || rawImage.storageKey) } : {}),
            name: String(rawImage.name || name),
            width: Number(rawImage.width ?? rawImage.naturalWidth ?? 0),
            height: Number(rawImage.height ?? rawImage.naturalHeight ?? 0),
            bytes: Number(rawImage.bytes ?? 0),
            mimeType: String(rawImage.mimeType || ""),
        };

        // 基础字段沿用已有资产记录，避免把共享画布里真实存在的标签/目录/来源/时间清掉；
        // backend 维护的 sharedAssetSource 不回传（否则 writeDramaAsset 会按伪造来源拒绝）。
        const previousMeta = { ...(previous?.metadata || {}) } as Record<string, unknown>;
        delete previousMeta.sharedAssetSource;
        const base = {
            id: current.libraryAssetId || nanoid(),
            title: name,
            coverUrl: imageUrl || current.coverUrl,
            tags: previous?.tags || [],
            folderId: previous?.folderId ?? null,
            dramaId,
            source: previous?.source || "studio",
            note: previous?.note ?? undefined,
            createdAt: previous?.createdAt || now,
            updatedAt: now,
            metadata: { ...previousMeta, source: "studio", ...(current.canvasId && current.nodeId ? { projectId: current.canvasId, nodeId: current.nodeId } : {}) },
        };

        let asset: Asset;
        if (assetKind === "character") {
            const prior = previous?.kind === "character" ? previous.data : undefined;
            const sourceImages: Array<Record<string, any>> = Array.isArray(md.characterImages) ? md.characterImages : [];
            let images: CharacterImage[] = sourceImages.map((img) => ({
                url: String(img.url || (img.storageKey ? backendMediaUrl(String(img.storageKey)) : "")),
                ...(img.storageKey ? { storageKey: String(img.storageKey) } : {}),
                name: String(img.name || ""),
                ...(img.assetId ? { assetId: String(img.assetId) } : {}),
                width: Number(img.width ?? img.naturalWidth ?? 0),
                height: Number(img.height ?? img.naturalHeight ?? 0),
                bytes: Number(img.bytes ?? 0),
                mimeType: String(img.mimeType || ""),
                outfit: String(img.outfit || ""),
                outfitDescription: String(img.outfitDescription || ""),
                ...(img.role ? { role: String(img.role) } : {}),
            }));
            if (storageKey && !images.some((i) => i.storageKey === storageKey)) {
                images = [{ ...image, outfit: "", outfitDescription: "" }, ...images];
            }
            if (!images.length && prior?.images?.length) images = prior.images;
            asset = {
                ...base, kind: "character",
                data: {
                    name,
                    englishName: String(md.characterEnglishName || prior?.englishName || ""),
                    description: shownDraft.description || String(md.characterDescription || prior?.description || ""),
                    voice: String(md.characterVoiceUrl || prior?.voice || ""),
                    voiceName: String(md.characterVoiceName || prior?.voiceName || ""),
                    voiceDescription: shownDraft.voice.trim() || String(md.characterVoiceDescription || prior?.voiceDescription || ""),
                    voiceStorageKey: current.voiceStorageKey || String(md.characterVoiceStorageKey || prior?.voiceStorageKey || ""),
                    voiceAssetId: current.voiceAssetId || String(md.characterVoiceAssetId || prior?.voiceAssetId || ""),
                    images,
                    primaryIndex: Number(md.characterPrimaryIndex ?? prior?.primaryIndex ?? 0),
                },
            };
        } else if (assetKind === "scene") {
            const prior = previous?.kind === "scene" ? previous.data : undefined;
            const card = md.sceneColorCard as Record<string, any> | undefined;
            const colorCard: SceneImage | undefined = card ? {
                url: String(card.url || ""),
                ...(card.storageKey ? { storageKey: String(card.storageKey) } : {}),
                name: String(card.name || ""),
                width: Number(card.width ?? 0), height: Number(card.height ?? 0),
                bytes: Number(card.bytes ?? 0), mimeType: String(card.mimeType || ""),
            } : prior?.colorCard;
            asset = {
                ...base, kind: "scene",
                data: {
                    name,
                    description: shownDraft.description || String(md.sceneDescription || prior?.description || ""),
                    image,
                    ...(colorCard ? { colorCard } : {}),
                    ...(Array.isArray(md.sceneColorPalette) ? { colorPalette: md.sceneColorPalette.map((v: unknown) => String(v)) } : prior?.colorPalette ? { colorPalette: prior.colorPalette } : {}),
                    colorCardPrompt: String(md.sceneColorCardPrompt || prior?.colorCardPrompt || ""),
                },
            };
        } else {
            asset = { ...base, kind: "prop", data: { name, description: shownDraft.description || String(md.propDescription || ""), image } };
        }

        const command: SharedAssetWrite = {
            operationId: nanoid(),
            ...(current.canvasId && current.nodeId ? { canvasSource: { projectId: current.canvasId, nodeId: current.nodeId } } : {}),
        };
        setLibrarySaving(true);
        const hideLoading = message.loading(t("canvas.sharedLibrary.saving"), 0);
        try {
            try {
                await saveLibraryAsset(asset, command);
            } catch (error) {
                if (!(error instanceof BackendApiError) || error.details.code !== "FIELD_CONFLICT") throw error;
                const applied = await new Promise<boolean>((resolve, reject) => {
                    modal.confirm({
                        title: t("canvas.sharedLibrary.conflictTitle"),
                        content: t("canvas.sharedLibrary.conflictDescription"),
                        okText: t("canvas.sharedLibrary.useLocal"),
                        cancelText: t("canvas.sharedLibrary.keepDraft"),
                        onOk: async () => {
                            try { await saveLibraryAsset(asset, { ...command, operationId: nanoid(), resolveConflicts: "local" }); resolve(true); }
                            catch (failure) { reject(failure); }
                        },
                        onCancel: () => resolve(false),
                    });
                });
                if (!applied) return;
            }
            message.success(current.scope === "shared" || Boolean(previous) ? t("canvas.sharedLibrary.update") : t("nodeToolbar.saveAsset"));
            setDraft(null);
            setSharedRefreshTick((v) => v + 1); // 重新拉共享画布，新 canonical 节点立即出现在列表
            onChanged();
        } catch (error) {
            message.error(libraryErrorText(error));
        } finally {
            hideLoading();
            setLibrarySaving(false);
        }
    };

    // 锁定/解锁形象：asset 用真实 status 字段；角色/场景的审批在画布侧，这里引导
    const handleToggleLock = async () => {
        if (!current) return;
        if (current.entity !== "asset") {
            message.info("角色/场景的参考图锁定在画布上完成；点「生成参考图」到画布确认后即锁定");
            return;
        }
        setSaving(true);
        try {
            const ops: ProductionOperation[] = [{ type: "patch_director_source", entity: "asset", id: current.entityId, patch: { status: current.locked ? "planned" : "approved" } }];
            await editEpisodeProduction(current.episodeId as never, current.revision, ops);
            message.success(current.locked ? "已取消锁定" : "已锁定形象（资产标记 approved）");
            setDraft(null);
            onChanged();
        } catch (error) {
            message.error(`操作失败：${(error as Error).message}`);
        } finally {
            setSaving(false);
        }
    };

    /** 生成参考图（本地真实链路）：把画风写进资产卡 prompt → 为该实体准备画布生成节点 → 打开画布生成并采用。 */
    const handleGenerate = async () => {
        if (!current) return;
        const basePrompt = shownDraft?.imagePrompt.trim() || current.prompt.trim() || `${current.name}：${current.description || current.appearance}`.trim();
        if (!basePrompt) return void message.warning("该设定还没有可用的提示词，请先保存外观描述");
        setGenerating(current.key);
        try {
            // 单独风格优先于全剧画风；都是本地纯字符串拼接（withArtStyle，不调模型）。
            const style = shownDraft?.hasOwnStyle && shownDraft.imageStylePrompt ? shownDraft.imageStylePrompt : artStyle;
            const finalPrompt = withArtStyle(basePrompt, style);
            if (current.scope === "shared" && current.canvasId) {
                // 共享条目：目标在共享资产画布（owner=canvas）上准备，绝不写当前集画布。
                const projectId = current.canvasId;
                const sharedProd = await fetchEpisodeProduction({ projectId });
                const source = ((sharedProd.production.draft as Row | undefined)?.director as Row | undefined)?.source as Record<string, unknown> | null;
                const resolved = sharedEntityForNode(current.nodeId, source);
                if (!resolved) throw new Error("该共享节点没有正式制作实体绑定，无法在共享画布准备生成节点");
                // 1) 带画风的提示词真实写回共享画布制作稿的资产卡（按实体绑定→asset_plan 定位，不用 nodeId 冒充资产卡 ID）
                if (resolved.assetCardId) await editEpisodeProduction({ projectId }, sharedProd.production.revision, [
                    { type: "patch_director_source", entity: "asset_card", id: resolved.assetCardId, patch: { prompt: finalPrompt } },
                ]);
                // 2) 回读 revision 后在共享画布准备该实体，避免连写撞乐观锁
                const fresh = await fetchEpisodeProduction({ projectId });
                await prepareProductionTargets({ projectId }, fresh.production.revision, [resolved.target], `studio-ref-${nanoid()}`);
                message.success(`已在共享画布为「${current.name}」准备好生成节点：生成并采用后，共享资产版本与 writeThrough 引用自动跟随`);
                onChanged();
                onOpenSharedCanvas?.();
                return;
            }
            const entityKind = current.entity === "environment" ? "scene" : current.entity === "asset" ? "prop" : "character";
            // 1) 把带画风的提示词写回资产卡（真实字段 asset_card.prompt），按 assetId 定位
            const ops: ProductionOperation[] = [{ type: "patch_director_source", entity: "asset_card", id: current.assetId, patch: { prompt: finalPrompt } }];
            await editEpisodeProduction(current.episodeId as never, current.revision, ops);
            // 2) 准备该实体的画布生成节点（重新读 revision，避免连写撞乐观锁）
            const fresh = await fetchEpisodeProduction(current.episodeId as never);
            await prepareProductionTargets(current.episodeId as never, fresh.production.revision, [`entity:${entityKind}:${current.entityId}`], `studio-ref-${nanoid()}`);
            message.success(`已为「${current.name}」准备好参考图生成节点，正在打开画布：生成后采用即写回并锁定`);
            onChanged();
            onOpenCanvas();
        } catch (error) {
            message.error(`准备生成失败：${(error as Error).message}`);
        } finally {
            setGenerating(null);
        }
    };

    /** 一键准备全部参考图：对所有缺图资产写提示词 + 准备画布生成节点，进度同步在制作台横幅。 */
    const handlePrepareAll = async () => {
        const pending = entries.filter(e => e.genStatus !== "ready" && e.assetId && e.entityId);
        if (!pending.length) return void message.info("所有设定都已有参考图");
        setBatchPrep({ done: 0, total: pending.length });
        let done = 0; let failed = 0;
        let sharedPrepared = 0; let episodePrepared = 0;
        try {
            // 共享条目：同一共享画布只回读一次 revision，所有实体目标一次 prepare，互不撞乐观锁。
            const sharedEntries = pending.filter(e => e.scope === "shared" && e.canvasId);
            if (sharedEntries.length) {
                const projectId = sharedEntries[0].canvasId!;
                try {
                    const sharedProd = await fetchEpisodeProduction({ projectId });
                    const source = ((sharedProd.production.draft as Row | undefined)?.director as Row | undefined)?.source as Record<string, unknown> | null;
                    const usable: Array<{ e: Entry; r: { target: string; assetCardId: string } }> = [];
                    for (const e of sharedEntries) {
                        const r = sharedEntityForNode(e.nodeId, source);
                        if (r) usable.push({ e, r });
                    }
                    const promptOps: ProductionOperation[] = [];
                    for (const { e, r } of usable) {
                        if (!r.assetCardId) continue;
                        const base = e.imagePrompt.trim() || e.prompt.trim() || `${e.name}：${e.description || e.appearance}`.trim();
                        if (!base) continue;
                        promptOps.push({ type: "patch_director_source", entity: "asset_card", id: r.assetCardId,
                            patch: { prompt: e.imageStylePrompt ? withArtStyle(base, e.imageStylePrompt) : withArtStyle(base, artStyle) } });
                    }
                    if (promptOps.length) await editEpisodeProduction({ projectId }, sharedProd.production.revision, promptOps);
                    const targets = [...new Set(usable.map(x => x.r.target))];
                    if (targets.length) {
                        const fresh = await fetchEpisodeProduction({ projectId });
                        await prepareProductionTargets({ projectId }, fresh.production.revision, targets, `studio-ref-${nanoid()}`);
                        sharedPrepared = usable.length;
                    }
                    failed += sharedEntries.length - usable.length;
                } catch { failed += sharedEntries.length; }
                done += sharedEntries.length;
                setBatchPrep({ done, total: pending.length });
            }
            // 分集条目：原逻辑逐集保持不变。
            for (const e of pending) {
                if (e.scope === "shared") continue;
                try {
                    const basePrompt = e.imagePrompt.trim() || e.prompt.trim() || `${e.name}：${e.description || e.appearance}`.trim();
                    if (!basePrompt) { failed++; continue; }
                    const style = e.imageStylePrompt ? withArtStyle(basePrompt, e.imageStylePrompt) : withArtStyle(basePrompt, artStyle);
                    const entityKind = e.entity === "environment" ? "scene" : e.entity === "asset" ? "prop" : "character";
                    let fresh = await fetchEpisodeProduction(e.episodeId as never);
                    await editEpisodeProduction(e.episodeId as never, fresh.production.revision, [{ type: "patch_director_source", entity: "asset_card", id: e.assetId, patch: { prompt: style } }]);
                    fresh = await fetchEpisodeProduction(e.episodeId as never);
                    await prepareProductionTargets(e.episodeId as never, fresh.production.revision, [`entity:${entityKind}:${e.entityId}`], `studio-ref-${nanoid()}`);
                    episodePrepared++;
                } catch { failed++; }
                done++;
                setBatchPrep({ done, total: pending.length });
            }
            onChanged();
            message.success(`已准备 ${done - failed}/${pending.length} 个参考图生成节点（共享画布 ${sharedPrepared}、分集画布 ${episodePrepared}）${failed ? `，${failed} 个失败` : ""}`);
            // 有共享目标时优先打开共享画布；真实采用由画布既有 runner 完成（生成→采用→登记共享版本→writeThrough 引用跟随）。
            if (sharedPrepared) onOpenSharedCanvas?.();
            else if (episodePrepared) onOpenCanvas();
        } finally {
            setBatchPrep(null);
        }
    };

    /**
     * 影策 setDramaCastImage 的本地真实等价：POST /drama/pipeline/assets/bind-image
     * 把真实归档 storageKey 写进 draft/published.director.assets[assetId] + 实体节点 metadata，
     * 剧情段视频据此取参考图；状态写 generated → 流水线不再自动重生成覆盖（=锁定）。
     * 后端只接受真实存在、能算出 sha256 的媒体，绝不写伪造 key。
     */
    const adoptImage = async (storageKey: string, label: string) => {
        if (!current) { setImageAdopting(false); return; }
        try {
            if (current.scope === "shared") {
                // 共享条目：写共享画布 canonical 节点 → writeThrough 同步到消费分集与段视频参考图。
                if (!current.canvasId || !current.nodeId) throw new Error("共享条目缺少画布/节点定位");
                await request("POST", "/drama/pipeline/assets/adopt-shared-image", {
                    projectId: current.canvasId,
                    nodeId: current.nodeId,
                    assetId: current.libraryAssetId,
                    storageKey,
                    imageId: `adopted:${nanoid()}`,
                });
                message.success(`已采用「${label}」为共享资产「${current.name}」的参考图并锁定：引用它的活动分集剧情段视频按此图生成（已归档分集保持冻结）`);
            } else {
                if (!current.episodeId || !current.assetId || !current.nodeId) throw new Error("分集设定缺少实体节点定位，请先在画布准备实体");
                await request("POST", "/drama/pipeline/assets/bind-image", {
                    episodeId: current.episodeId,
                    assetId: current.assetId,
                    nodeId: current.nodeId,
                    storageKey,
                    imageId: `adopted:${nanoid()}`,
                });
                message.success(`已采用「${label}」为「${current.name}」的参考图并锁定：后续剧情段视频按此图生成，流水线不会自动重生成覆盖`);
            }
            if (storageKey === current.referenceStorageKey) message.info("已在使用这张图");
            setAdoptOpen(false);
            setDraft(null);
            onChanged();
        } catch (error) {
            message.error(`采用失败：${(error as Error).message}`);
        } finally {
            setImageAdopting(false);
        }
    };

    /** 上传形象图：真实上传到本地媒体库（uploadMediaFile）后走 bind-image 采用链路；顺带登记素材库（失败不阻断采用）。 */
    const handleImageFile = async (file: File) => {
        if (!current) return;
        if (!file.type.startsWith("image/")) return void message.warning("请选择 PNG、JPG 或 WebP 图片");
        if (file.size > 20 * 1024 * 1024) return void message.warning("图片不超过 20MB");
        setImageAdopting(true);
        try {
            const uploaded = await uploadMediaFile(file, "cast-image", "library");
            if (!uploaded.storageKey) throw new Error("上传未返回 storageKey");
            try {
                await useAssetStore.getState().addAsset({
                    id: nanoid(), kind: "image", title: file.name.replace(/\.[^.]+$/, ""),
                    coverUrl: uploaded.url, tags: [],
                    data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: Number(uploaded.width || 0), height: Number(uploaded.height || 0), bytes: uploaded.bytes, mimeType: uploaded.mimeType },
                });
            } catch { /* 素材库登记失败不阻断参考图采用 */ }
            await adoptImage(uploaded.storageKey, file.name);
        } catch (error) {
            message.error(`上传失败：${(error as Error).message}`);
            setImageAdopting(false);
        }
    };

    /** 素材库选图：优先复用已归档 storageKey；仅有本机 dataUrl 的先上传再采用。 */
    const handleLibraryPick = async (payload: InsertAssetPayload) => {
        if (payload.kind !== "image") return;
        setImageAdopting(true);
        try {
            const storageKey = payload.storageKey || (await uploadMediaFile(payload.dataUrl, "cast-image", "library")).storageKey;
            if (!storageKey) throw new Error("所选素材没有可归档的图片");
            await adoptImage(storageKey, payload.title);
        } catch (error) {
            message.error(`采用失败：${(error as Error).message}`);
            setImageAdopting(false);
        }
    };

    /** 绑定声音样本：写 character.voice 记录（真实字段）；支持参考音频的视频模型会在该角色开口段带上。 */
    /** 试听声音样本：storageKey 走后端 media URL，url 直接播；不落库、只播放。卡片与详情共用。 */
    const playVoiceSample = (e: Entry) => {
        const src = e.voiceStorageKey ? backendMediaUrl(e.voiceStorageKey) : e.voiceUrl;
        if (!src) return void message.warning("该设定还没有绑定可试听的声音样本");
        try {
            const audio = new Audio(src);
            audio.onended = () => setVoicePlaying(false);
            audio.onerror = () => { setVoicePlaying(false); message.error("声音样本播放失败"); };
            audio.play().then(() => setVoicePlaying(true)).catch(() => { setVoicePlaying(false); message.error("声音样本播放失败"); });
        } catch { message.error("声音样本播放失败"); }
    };
    const previewVoice = () => { if (current) playVoiceSample(current); };
    const [voicePlaying, setVoicePlaying] = useState(false);

    const handleVoiceChange = async (assetId: string) => {
        if (!current || current.entity !== "character") return;
        const isProfile = assetId.startsWith("voiceprofile:");
        const profile = isProfile ? profileAudioOptions.find((p) => p.id === assetId) : undefined;
        const picked = isProfile ? undefined : audioAssets.find((a) => a.id === assetId);
        const voiceRecord = profile
            ? { assetId, storageKey: profile.storageKey, url: "", name: profile.title }
            : picked
                ? { assetId: picked.id, storageKey: picked.data.storageKey || "", url: picked.data.url || "", name: picked.title }
                : {};
        const pickedTitle = profile?.title || picked?.title || "";
        setSaving(true);
        try {
            if (current.scope === "shared" && current.canvasId && current.nodeId) {
                // 共享画布角色没有分集制作稿（episodeId 为空）：走画布节点 metadata 真值写回，与造型面板同款。
                await applyBackendCanvasOperations(current.canvasId, [
                    { type: "update_node", id: current.nodeId, metadata: {
                        characterVoiceAssetId: voiceRecord.assetId || "",
                        characterVoiceStorageKey: voiceRecord.storageKey || "",
                        characterVoiceUrl: voiceRecord.url || "",
                        characterVoiceDescription: pickedTitle,
                    } },
                ], current.canvasRevision);
            } else {
                const ops: ProductionOperation[] = [{
                    type: "patch_director_source", entity: "character", id: current.entityId,
                    patch: { voice: voiceRecord, voice_description: pickedTitle },
                }];
                await editEpisodeProduction(current.episodeId as never, current.revision, ops);
            }
            message.success(pickedTitle ? `已为「${current.name}」绑定声音样本「${pickedTitle}」` : `已清除「${current.name}」的声音样本`);
            setDraft(null);
            onChanged();
            // 缺口B：对齐影策 cast-voice.tsx:101-107 的 setDramaCastVoice(...,{restyleSegments})。
            // 换音色是 H3 视频生成的真实输入，勾选 restyle 时复用设定级真链路：只读反查引用段 →
            // 用户确认 → restyleDramaCast 写 inputOutdated 标脏，并展示真实影响集数（不发起计费生成）。
            if (restyle) await doCastRestyle();
        } catch (error) {
            message.error(`绑定失败：${(error as Error).message}`);
        } finally {
            setSaving(false);
        }
    };

    /** 声音样本「上传」：真实上传到本地素材库（uploadMediaFile + addAsset），再绑定到该角色。 */
    const handleVoiceFile = async (file: File) => {
        if (!current || current.entity !== "character") return;
        if (!file.type.startsWith("audio/")) return void message.warning("请选择音频文件");
        if (file.size > 20 * 1024 * 1024) return void message.warning("音频不超过 20MB");
        setVoiceBusy(true);
        try {
            const result = await uploadMediaFile(file, "audio", "library");
            const id = nanoid();
            await useAssetStore.getState().addAsset({
                id, kind: "audio", title: file.name.replace(/\.[^.]+$/, ""), coverUrl: "", tags: [],
                data: { url: result.url, storageKey: result.storageKey, bytes: result.bytes, mimeType: result.mimeType, durationMs: result.durationMs },
            });
            await handleVoiceChange(id);
            message.success("声音样本已上传并绑定到该角色");
        } catch (error) {
            message.error(`上传失败：${(error as Error).message}`);
        } finally {
            setVoiceBusy(false);
        }
    };

    /** 录音会话清理：停掉 30 秒上限计时器（完成/取消/自动到点共用）。 */
    const clearRecordTimer = () => {
        if (recordTimerRef.current !== null) {
            clearInterval(recordTimerRef.current);
            recordTimerRef.current = null;
        }
    };

    /** 结束录音：upload=true 走完成上传绑定，upload=false 为取消（丢弃数据、释放麦克风流）。 */
    const finishRecord = (upload: boolean) => {
        if (!recorderRef.current) return;
        recordUploadRef.current = upload;
        clearRecordTimer();
        if (recorderRef.current.state !== "inactive") recorderRef.current.stop();
        recorderRef.current = null; // 立即解绑，避免 stop→onstop 间隙里重开录音被旧 onstop 清掉
        setRecording(false);
        setRecordRemain(VOICE_RECORD_LIMIT_SEC);
    };

    /** 声音样本「录制」：浏览器 MediaRecorder 真实录音 → 走同一上传/绑定链路。
     *  真实计时器限制 30 秒上限并显示倒计时；到点自动完成。录制中可取消或完成。 */
    const toggleRecord = async () => {
        if (recording) { finishRecord(true); return; } // 兼容原「再次点击停止」= 完成上传
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
            return void message.warning("当前浏览器不支持录音，请用「上传音频」");
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            recordStreamRef.current = stream;
            const rec = new MediaRecorder(stream);
            chunksRef.current = [];
            rec.ondataavailable = (ev) => { if (ev.data.size) chunksRef.current.push(ev.data); };
            rec.onstop = () => {
                clearRecordTimer();
                // 无论完成还是取消都释放麦克风流，避免占用摄像头权限指示。
                recordStreamRef.current?.getTracks().forEach((t) => t.stop());
                recordStreamRef.current = null;
                recorderRef.current = null;
                const shouldUpload = recordUploadRef.current;
                const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
                chunksRef.current = [];
                if (shouldUpload && blob.size) void handleVoiceFile(new File([blob], `录音-${Date.now()}.webm`, { type: blob.type }));
            };
            rec.start();
            recorderRef.current = rec;
            recordUploadRef.current = true;
            recordLeftRef.current = VOICE_RECORD_LIMIT_SEC;
            setRecording(true);
            setRecordRemain(VOICE_RECORD_LIMIT_SEC);
            // 真实计时器：每秒递减倒计时，到 30 秒自动停止并按「完成」上传绑定。
            recordTimerRef.current = setInterval(() => {
                recordLeftRef.current -= 1;
                if (recordLeftRef.current <= 0) {
                    message.info("录音已达 30 秒上限，已自动停止并上传绑定");
                    finishRecord(true);
                } else {
                    setRecordRemain(recordLeftRef.current);
                }
            }, 1000);
            message.info("正在录音（最长 30 秒），点「完成」上传绑定，「取消」放弃");
        } catch {
            recordStreamRef.current?.getTracks().forEach((t) => t.stop());
            recordStreamRef.current = null;
            message.warning("无法访问麦克风，请检查权限或用「上传音频」");
        }
    };

    /** 重新编排提示词：影策的编排接口在本地无等价物；用同一套 withArtStyle 做本地纯字符串编排（不调模型）。 */
    const rebuildPrompt = () => {
        if (!shownDraft || !current) return;
        const appearance = shownDraft.description.trim() || current.description || current.appearance || "";
        if (!appearance) return void message.warning("请先填写外貌/描述");
        const style = shownDraft.hasOwnStyle ? (shownDraft.imageStylePrompt || shownDraft.imageStyleName) : artStyle;
        patchDraft({ imagePrompt: withArtStyle(appearance, style) });
        message.success("提示词已按外貌与画风重新编排，保存后用于生成参考图");
    };

    // 删除设定：delete_director_asset（真实 op，需 confirmed:true + 乐观锁 revision）。
    // 只对分集制作稿实体可用：共享画布条目的 episodeId 为空，editEpisodeProduction 无法定位，
    // 点下去只会报错——不造假按钮，共享条目引导到画布删除。
    const handleDelete = () => {
        if (!current || current.scope !== "episode" || !current.episodeId) {
            message.info("共享资产画布的设定请在画布里删除；本入口只删除分集制作稿里的设定");
            return;
        }
        Modal.confirm({
            title: `删除设定「${current.name}」`,
            content: "会从对应集制作稿移除该资产；引用它的镜头需要重新核对。",
            okText: "删除", okButtonProps: { danger: true }, cancelText: "取消",
            onOk: async () => {
                try {
                    const ops: ProductionOperation[] = [{ type: "delete_director_asset", id: current.entityId, confirmed: true }];
                    await editEpisodeProduction(current.episodeId as never, current.revision, ops);
                    message.success("已删除设定");
                    setDraft(null); setSelectedKey(null);
                    onChanged();
                } catch (error) {
                    message.error(`删除失败：${(error as Error).message}`);
                    throw error;
                }
            },
        });
    };

    // 新增设定：createManualDirectorAsset helper → create_manual_director_asset op，写到当前选中的集
    const targetEpisode = sources.find(s => s.episodeId === (current?.episodeId || sources[0]?.episodeId)) || sources[0];
    const handleAdd = async () => {
        const name = addDraft.name.trim();
        if (!name) return void message.warning("请填写名称");
        if (!addDraft.description.trim()) return void message.warning("请填写外观 / 描述");
        if (!targetEpisode || !targetEpisode.source) return void message.warning("目标集制作稿尚未就绪");
        const kindMap = { 角色: "character", 场景: "scene", 道具: "prop" } as const;
        const k = kindMap[addDraft.kind as keyof typeof kindMap] || "prop";
        const stamp = Date.now().toString(36);
        const assetId = `MANUAL_${k.toUpperCase()}_${stamp}`;
        const entityId = k === "prop" ? undefined : `${k === "character" ? "CHAR" : "SCENE"}_MANUAL_${stamp}`;
        setAddPending(true);
        try {
            const built = createManualDirectorAsset(targetEpisode.source, {
                id: assetId, ...(entityId ? { entityId } : {}), kind: k, name,
                description: addDraft.description.trim() || name,
                ...(addDraft.voice.trim() ? { voiceDescription: addDraft.voice.trim() } : {}),
                prompt: addDraft.description.trim() || name, purpose: "手工新增设定",
                registerSubject: false, ownerKind: "episode", ownerId: targetEpisode.episodeId,
            });
            const operation = {
                type: "create_manual_director_asset" as const,
                assetPlan: built.assetPlan, assetCard: built.assetCard,
                ...(built.registryKind && built.registryEntity ? { registryKind: built.registryKind, registryEntity: built.registryEntity } : {}),
                ...(built.subject ? { subject: built.subject } : {}),
            } as Extract<ProductionOperation, { type: "create_manual_director_asset" }>;
            await editEpisodeProduction(targetEpisode.episodeId as never, targetEpisode.revision, [operation]);
            message.success(`已新增${addDraft.kind}「${name}」到第 ${targetEpisode.episodeNo} 集`);
            setAddDraft({ kind: "角色", name: "", description: "", voice: "" });
            onChanged();
            setAdding(false); // 成功才关闭弹窗（对齐影策 onSuccess 的 onClose）；失败保留草稿供重试
        } catch (error) {
            message.error(`新增失败：${(error as Error).message}`);
        } finally {
            setAddPending(false);
        }
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col" data-studio-cast>
            {/* 分类 tab + 统计 */}
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-6 py-2">
                {KIND_TABS.map(({ key, icon: Icon }) => (
                    <button key={key} type="button" onClick={() => { setKind(key); setSelectedKey(null); setDraft(null); }}
                        className={cn("flex h-7 items-center gap-1.5 rounded px-2.5 text-xs transition",
                            kind === key ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted")}>
                        <Icon className="size-3.5" /> {key} <span className="opacity-60">{key === "造型" ? lookCount : counts[key]}</span>
                    </button>
                ))}
                <div className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
                    <button type="button" aria-label="新增设定" onClick={() => setAdding(true)} className="flex items-center gap-1 transition hover:text-foreground"><Plus className="size-3" /> 新增设定</button>
                </div>
            </div>

            {/* 状态筛选（影策：全部/失败/生成中/已锁定） */}
            <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-6 py-1.5 text-[11px]">
                {([
                    { key: "all", label: "全部", n: entries.length },
                    { key: "failed", label: "失败", n: failedCount },
                    { key: "busy", label: "生成中", n: busyCount },
                    { key: "locked", label: "已锁定", n: lockedCount },
                ] as const).map(f => (
                    <button key={f.key} type="button" onClick={() => setFilter(f.key)}
                        className={cn("rounded-full px-2 py-0.5 transition", filter === f.key ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted/60")}>
                        {f.label} {f.n}
                    </button>
                ))}
            </div>

            {/* 造型 tab：剧目级造型真值在画布角色节点，读写走画布 update_node op。
                始终挂载（非造型 tab 时 hidden）：onCountChange 的计数 effect 需要在 tab 未激活时也运行，
                否则「造型 N」分类计数会因面板未挂载一直显示 0（误以为没有造型）。 */}
            <div className={kind === "造型" ? "contents" : "hidden"}>
                <StudioLooksPanel
                    dramaId={dramaId}
                    sharedAssetCanvasId={sharedAssetCanvasId}
                    episodeIds={looksEpisodeIds}
                    onOpenCanvas={onOpenCanvas}
                    onCountChange={setLookCount}
                />
            </div>
            {kind !== "造型" && (entries.length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Users className="size-9 opacity-40" />
                    各集制作稿还没有登记角色/场景/道具。点「新增设定」创建，或在精修画布的设定资产里创建后汇总到这里。
                    <button type="button" onClick={() => setAdding(true)} className="mt-2 underline-offset-2 hover:underline">新增设定</button>
                </div>
            ) : (
                <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px]">
                    {/* 卡片网格 */}
                    <div className="min-h-0 overflow-y-auto p-4">
                        <div className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                            <Sparkles className="size-3.5 shrink-0" />
                            <span className="min-w-0 flex-1">先核对名称与外观描述，满意后一键准备生成节点；参考图随剧情段视频请求一起发送，保持人物和道具一致。</span>
                            {batchPrep ? (
                                <span className="shrink-0 text-primary" data-studio-batch-prep-progress>准备中 {batchPrep.done}/{batchPrep.total}</span>
                            ) : (
                                <button type="button" disabled={Boolean(generating)} onClick={() => void handlePrepareAll()}
                                    className="flex shrink-0 items-center gap-1 rounded bg-primary px-2 py-1 text-[10px] text-background! transition hover:opacity-90 disabled:opacity-50"
                                    data-studio-batch-prep>
                                    <Sparkles className="size-3" /> 一键准备全部参考图
                                </button>
                            )}
                        </div>
                        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-4">
                            {visible.length === 0 ? (
                                <div className="col-span-full py-10 text-center text-xs text-muted-foreground">
                                    当前筛选下没有设定
                                </div>
                            ) : null}
                            {visible.map((e) => (
                                <button key={e.key} type="button" onClick={() => selectEntry(e)}
                                    className={cn("overflow-hidden rounded-lg border text-left transition",
                                        current?.key === e.key ? "border-foreground/40 bg-accent/40" : "border-border bg-card/40 hover:bg-muted/50")}>
                                    <div className="relative flex aspect-[4/3] items-center justify-center bg-muted/40 text-muted-foreground">
                                        {(e.thumb || e.coverUrl) ? <img src={e.thumb || e.coverUrl} alt={e.name} className="size-full object-cover" loading="lazy" /> : <ImageIcon className="size-7 opacity-30" />}
                                        {e.locked ? <span className="absolute right-1 top-1 rounded bg-background/80 p-0.5"><Lock className="size-3" /></span> : null}
                                        {e.genStatus === "failed" ? <span className="absolute left-1 top-1 rounded bg-rose-500 px-1 py-0.5 text-[9px] text-white">失败</span> : null}
                                        {e.genStatus === "busy" ? <span className="absolute left-1 top-1 rounded bg-amber-500 px-1 py-0.5 text-[9px] text-white">生成中</span> : null}
                                    </div>
                                    <div className="p-2">
                                        <div className="truncate text-xs font-medium">{e.name}</div>
                                        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                            <span>{e.role}</span>
                                            {e.genStatus === "ready" ? <span className="text-emerald-500">有参考图</span> : e.genStatus === "idle" ? <span>未生成</span> : null}
                                            {e.kind === "角色" && e.voiceStorageKey ? (
                                                <span role="button" tabIndex={0} data-studio-cast-card-voice-preview
                                                    aria-label={`试听${e.name}的声音样本`}
                                                    onClick={(ev) => { ev.stopPropagation(); playVoiceSample(e); }}
                                                    onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); playVoiceSample(e); } }}
                                                    className="ml-auto flex items-center gap-0.5 rounded border border-border px-1 py-0.5 text-[9px] text-foreground hover:bg-muted">
                                                    <Volume2 className="size-3" /> 试听
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 右侧设定面板（受控可编辑） */}
                    <aside className="min-h-0 overflow-y-auto border-l border-border bg-card/30 p-3" data-studio-cast-detail>
                        {current && shownDraft ? (
                            <>
                                <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
                                    {kind}设定 <span className="text-[10px] font-normal text-muted-foreground">{current.scope === "shared" ? "共享资产画布" : `第 ${sources.find(s => s.episodeId === current.episodeId)?.episodeNo} 集`}</span>
                                    <button type="button" onClick={() => void handleToggleLock()} disabled={saving}
                                        className="ml-auto flex items-center gap-1 text-[10px] font-normal text-muted-foreground hover:text-foreground disabled:opacity-50">
                                        {current.locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />} {current.locked ? "已锁定" : "锁定形象"}
                                    </button>
                                </div>
                                {(current.thumb || current.coverUrl) ? (
                                    <button type="button" onClick={() => setPreviewOpen(true)} className="group relative mb-3 block w-full overflow-hidden rounded-md border border-border" data-studio-cast-preview-open aria-label="放大查看参考图">
                                        <img src={current.thumb || current.coverUrl} alt={current.name} className="max-h-40 w-full object-contain" />
                                        <span className="absolute bottom-1 right-1 flex items-center gap-1 rounded bg-background/85 px-1.5 py-0.5 text-[10px] text-foreground opacity-0 transition group-hover:opacity-100"><Maximize2 className="size-3" /> 放大</span>
                                    </button>
                                ) : null}
                                {/* 设定版本记录：影策 DramaTakeList kind='cast' 等价。真值 drama_asset_versions 按 asset_id 只读。
                                    影策的「设为当前」只对 kind='video' 开放；本地资产版本也没有任何真实写链，故不提供该按钮。 */}
                                <div className="mb-3 rounded-md border border-border bg-background/40 p-2" data-studio-cast-version-history>
                                    <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium">
                                        <History className="size-3.5 text-muted-foreground" /> 版本记录
                                        {assetVersions.length ? <span className="font-normal text-muted-foreground">共 {assetVersions.length} 条</span> : null}
                                    </div>
                                    {assetVersionsLoading ? (
                                        <div className="py-2 text-center text-[10px] text-muted-foreground">读取版本记录…</div>
                                    ) : assetVersions.length ? (
                                        <div className="max-h-44 space-y-1.5 overflow-y-auto pr-0.5">
                                            {assetVersions.map((v) => (
                                                <div key={v.id} className="flex items-center gap-2 rounded border border-border bg-card/50 p-1.5" data-studio-cast-version-row>
                                                    <button type="button" disabled={!v.storageKey} onClick={() => setVersionPreview(v)}
                                                        aria-label={`放大查看 V${v.sourceVersion} 参考图`} title="放大预览历史版本"
                                                        className="relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted/40 disabled:cursor-default">
                                                        {v.storageKey ? (
                                                            <>
                                                                <img src={backendMediaUrl(v.storageKey)} alt={`V${v.sourceVersion}`} className="size-full object-cover" loading="lazy" />
                                                                <Maximize2 className="absolute bottom-0.5 right-0.5 size-3 bg-background/80" />
                                                            </>
                                                        ) : <ImageIcon className="size-4 opacity-40" />}
                                                    </button>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-1.5 text-[10px] font-medium">
                                                            <span>V{v.sourceVersion}</span>
                                                            <span className={cn("rounded px-1 py-0.5 text-[9px] font-normal", v.reviewStatus === "approved" ? "bg-emerald-500/10 text-emerald-500" : "bg-muted text-muted-foreground")}>
                                                                {v.reviewStatus === "approved" ? "已审阅采用" : "自动登记"}
                                                            </span>
                                                        </div>
                                                        <div className="mt-0.5 truncate text-[9px] text-muted-foreground" title={v.snapshot?.title || v.assetId}>{v.snapshot?.title || v.assetId}</div>
                                                        <div className="truncate text-[9px] text-muted-foreground" title={`来源画布 ${v.sourceProjectId || ""} · 节点 ${v.sourceNodeId || ""}${v.evidence ? ` · 审阅：${v.evidence}` : ""}`}>
                                                            来源 {v.sourceProjectId || v.sourceNodeId || "—"}
                                                        </div>
                                                        <div className="truncate text-[9px] text-muted-foreground">{v.createdAt ? new Date(v.createdAt).toLocaleString() : ""}</div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="py-1 text-[10px] text-muted-foreground">该设定暂无版本记录（采用或生成参考图后在这里留痕）。</p>
                                    )}
                                    <p className="mt-1.5 text-[9px] leading-relaxed text-muted-foreground">旧版本保留在版本记录中；本地资产版本为只读，当前版本由设定参考图决定。</p>
                                </div>
                                <div className="space-y-2.5 text-[11px]">
                                    <label className="block">
                                        <span className="mb-1 block text-muted-foreground">名称</span>
                                        <input value={shownDraft.name} onChange={(e) => patchDraft({ name: e.target.value })} className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none" />
                                    </label>

                                    {/* 别名与称呼：存 character.identity（白名单字段）里的 aliasNames */}
                                    {current.entity === "character" ? (
                                        <div data-studio-cast-aliases>
                                            <span className="mb-1 block text-muted-foreground">别名与称呼（剧本里这些称呼归到此角色）</span>
                                            <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-background p-1.5">
                                                {shownDraft.aliasNames.map((a, i) => (
                                                    <span key={`${a}:${i}`} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px]">
                                                        {a}
                                                        <button type="button" aria-label={`移除别名 ${a}`} onClick={() => patchDraft({ aliasNames: shownDraft.aliasNames.filter((_, j) => j !== i) })} className="text-muted-foreground hover:text-foreground">×</button>
                                                    </span>
                                                ))}
                                                <input
                                                    value={aliasInput}
                                                    onChange={(e) => setAliasInput(e.target.value)}
                                                    onKeyDown={(e) => {
                                                        if (["Enter", ",", "，", "、"].includes(e.key) && aliasInput.trim()) {
                                                            e.preventDefault();
                                                            patchDraft({ aliasNames: [...new Set([...shownDraft.aliasNames, aliasInput.trim()])] });
                                                            setAliasInput("");
                                                        } else if (e.key === "Backspace" && !aliasInput && shownDraft.aliasNames.length) {
                                                            patchDraft({ aliasNames: shownDraft.aliasNames.slice(0, -1) });
                                                        }
                                                    }}
                                                    placeholder="输入后回车"
                                                    className="min-w-20 flex-1 bg-transparent text-[11px] outline-none"
                                                />
                                            </div>
                                        </div>
                                    ) : null}

                                    <label className="block">
                                        <span className="mb-1 block text-muted-foreground">外貌 / 描述</span>
                                        <textarea value={shownDraft.description} onChange={(e) => patchDraft({ description: e.target.value })} rows={5} className="w-full resize-none rounded-md border border-border bg-background p-2 text-xs leading-5 outline-none" />
                                    </label>

                                    {/* 单独风格开关 + 风格选择器：沿用本地选题 artStyleOptions */}
                                    {current.entity === "character" ? (
                                        <div className="space-y-2 rounded-md border border-border bg-background/50 p-2" data-studio-cast-style>
                                            <button type="button" onClick={() => patchDraft({ hasOwnStyle: !shownDraft.hasOwnStyle })} className="flex w-full items-center gap-2 text-left text-[11px]">
                                                <span className={cn("flex size-3.5 items-center justify-center rounded border", shownDraft.hasOwnStyle ? "border-primary bg-primary text-primary-foreground" : "border-border")}>
                                                    {shownDraft.hasOwnStyle ? "✓" : ""}
                                                </span>
                                                为此设定单独设置风格
                                            </button>
                                            {shownDraft.hasOwnStyle ? (
                                                <>
                                                    <select
                                                        value={shownDraft.imageStyleName || artStyleOptions("")[0] || ""}
                                                        onChange={(e) => {
                                                            const name = e.target.value;
                                                            patchDraft({ imageStyleName: name, imageStyleId: styleSlug(name), imageStylePrompt: withArtStyle("", name) });
                                                        }}
                                                        className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none"
                                                        data-studio-cast-style-select
                                                    >
                                                        {artStyleOptions(shownDraft.imageStyleName).map((s) => <option key={s} value={s}>{s}</option>)}
                                                    </select>
                                                    <textarea
                                                        value={shownDraft.imageStylePrompt}
                                                        onChange={(e) => patchDraft({ imageStylePrompt: e.target.value })}
                                                        rows={2}
                                                        placeholder="单独风格的画风约束语句（留空则沿用所选风格名）"
                                                        className="w-full resize-none rounded-md border border-border bg-background p-2 text-[11px] outline-none"
                                                    />
                                                </>
                                            ) : (
                                                <small className="block text-[10px] text-muted-foreground">沿用作品风格；穿越、幼年或不同世界的造型可在此单独选择。</small>
                                            )}
                                        </div>
                                    ) : null}

                                    {/* 参考图方案：影策内置方案选择器，选中真实决定 pipeline 出图模板（横版16:9）。 */}
                                    <div data-studio-cast-scheme>
                                        <span className="mb-1 block text-muted-foreground">参考图方案（内置技能模板 · 横版16:9）</span>
                                        <select
                                            value={shownDraft.scheme}
                                            disabled={saving}
                                            onChange={(e) => patchDraft({ scheme: e.target.value as AssetSchemeId })}
                                            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none"
                                        >
                                            {ASSET_SCHEMES.filter((s) => (s.kinds as readonly string[]).includes(
                                                current.entity === "character" ? "character" : current.entity === "environment" ? "scene" : "prop"
                                            )).map((s) => <option key={s.id} value={s.id}>{s.name} · {s.description}</option>)}
                                        </select>
                                        <small className="mt-1 block text-[10px] text-muted-foreground">
                                            {ASSET_SCHEMES.find((s) => s.id === shownDraft.scheme)?.frameHint || "按资产类型自动匹配"}
                                            ；保存后由流水线按此方案拼装提示词出图。
                                        </small>
                                    </div>

                                    {/* 参考图生成提示词：存资产卡 prompt（真正驱动生图的字段）+ 重新编排 */}
                                    {current.entity === "character" ? (
                                        <div data-studio-cast-image-prompt>
                                            <div className="mb-1 flex items-center justify-between">
                                                <span className="text-muted-foreground">参考图生成提示词</span>
                                                <button type="button" onClick={rebuildPrompt} disabled={!shownDraft.description.trim()}
                                                    className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50">
                                                    <RefreshCw className="size-3" /> 重新编排提示词
                                                </button>
                                            </div>
                                            <textarea
                                                value={shownDraft.imagePrompt}
                                                onChange={(e) => patchDraft({ imagePrompt: e.target.value })}
                                                rows={4}
                                                placeholder="留空按外观、风格和参考图方案自动编排；也可填写自己的生图要求"
                                                className="w-full resize-none rounded-md border border-border bg-background p-2 text-[11px] leading-5 outline-none"
                                            />
                                            <small className="mt-1 block text-[10px] text-muted-foreground">切换风格后可重新编排。编排是本地画风拼接，不调用模型；保存后点生成才开始生图。</small>
                                        </div>
                                    ) : null}

                                    {current.entity === "character" ? (
                                        <>
                                            <label className="block">
                                                <span className="mb-1 block text-muted-foreground">声线（写进视频提示词）</span>
                                                <input value={shownDraft.voice} onChange={(e) => patchDraft({ voice: e.target.value })} placeholder="少年音，坚毅，语速偏快" className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none" />
                                            </label>
                                            <label className="block">
                                                <span className="mb-1 block text-muted-foreground">声音样本（素材库音频，随角色开口段发送）</span>
                                                <select
                                                    value={current.voiceAssetId || current.voiceStorageKey || ""}
                                                    disabled={saving || voiceBusy}
                                                    onChange={(e) => void handleVoiceChange(e.target.value)}
                                                    className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none"
                                                >
                                                    <option value="">不绑定样本</option>
                                                    {profileAudioOptions.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                                                    {audioAssets.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                                                </select>
                                                {!audioAssets.length ? <span className="mt-1 block text-[10px] text-muted-foreground">素材库还没有音频资产；可在下方上传，或到「资源库」添加。</span> : null}
                                                <button type="button" onClick={previewVoice} disabled={!current.voiceStorageKey && !current.voiceUrl}
                                                    className="mt-1.5 flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[10px] text-muted-foreground transition hover:bg-muted disabled:opacity-40" data-studio-cast-voice-preview>
                                                    {voicePlaying ? <Volume2 className="size-3" /> : <Play className="size-3" />} {voicePlaying ? "播放中…" : "试听样本"}
                                                </button>
                                            </label>
                                            <div className="flex flex-col gap-1.5" data-studio-cast-voice-actions>
                                                <div className="flex gap-1.5">
                                                    <button type="button" disabled={saving || voiceBusy || recording} onClick={() => audioFileRef.current?.click()}
                                                        className="flex h-8 flex-1 items-center justify-center gap-1 rounded-md border border-border text-[11px] text-muted-foreground transition hover:bg-muted disabled:opacity-50">
                                                        <Upload className="size-3" /> {voiceBusy ? "处理中…" : "上传音频"}
                                                    </button>
                                                    <button type="button" disabled={saving || voiceBusy || recording} onClick={() => void toggleRecord()} data-studio-cast-voice-record
                                                        className="flex h-8 flex-1 items-center justify-center gap-1 rounded-md border border-border text-[11px] text-muted-foreground transition hover:bg-muted disabled:opacity-50">
                                                        <Mic className="size-3" /> {recording ? "录音中…" : "录制声音"}
                                                    </button>
                                                </div>
                                                {recording ? (
                                                    <div className="flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/5 px-2 py-1.5" data-studio-cast-voice-recording>
                                                        <span className="flex items-center gap-1.5 text-[11px] text-rose-500">
                                                            <span className="size-1.5 animate-pulse rounded-full bg-rose-500" />
                                                            录音中 · 剩余 {recordRemain}s / {VOICE_RECORD_LIMIT_SEC}s
                                                        </span>
                                                        <button type="button" onClick={() => finishRecord(false)} data-studio-cast-voice-record-cancel
                                                            className="ml-auto h-7 rounded-md border border-border px-2 text-[11px] text-muted-foreground transition hover:bg-muted">
                                                            取消
                                                        </button>
                                                        <button type="button" onClick={() => finishRecord(true)} data-studio-cast-voice-record-finish
                                                            className="h-7 rounded-md border border-rose-500 bg-rose-500/10 px-2 text-[11px] text-rose-500 transition hover:bg-rose-500/20">
                                                            完成
                                                        </button>
                                                    </div>
                                                ) : null}
                                                <input ref={audioFileRef} type="file" accept="audio/*" hidden data-studio-cast-voice-upload
                                                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void handleVoiceFile(f); }} />
                                            </div>
                                        </>
                                    ) : null}

                                    {/* 影策 panels.tsx:497-505 设定级 restyle：勾选后显示真实影响集，保存时真标脏引用段。 */}
                                    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2" data-studio-cast-restyle>
                                        <Checkbox checked={restyle} disabled={saving || restyleSubmitting}
                                            onChange={(e) => setRestyle(e.target.checked)}>
                                            让引用它的剧情段视频重新生成
                                        </Checkbox>
                                        {castImpactLoading ? <span className="text-[10px] text-muted-foreground">影响查询中…</span> : castImpact ? (
                                            <span className="text-[10px] text-muted-foreground">{castImpact.episodes} 集 · {castImpact.segments} 段</span>
                                        ) : null}
                                    </div>
                                    <button type="button" onClick={() => void handleSave()} disabled={saving}
                                        className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-foreground text-xs font-medium text-background disabled:opacity-60">
                                        <Save className="size-3.5" /> {saving ? "保存中…" : "保存设定"}
                                    </button>
                                    {/* 存入资产库 = 写共享画布 canonical；已存在的显示"更新资产库" */}
                                    <button type="button" onClick={() => void handleSaveToLibrary()} disabled={librarySaving || saving}
                                        className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 text-xs font-medium text-primary transition hover:bg-primary/20 disabled:opacity-50"
                                        data-studio-cast-save-library aria-label={isLibrarySaved ? t("canvas.sharedLibrary.update") : t("nodeToolbar.saveAsset")}>
                                        {isLibrarySaved ? <RefreshCw className="size-3.5" /> : <Upload className="size-3.5" />}
                                        {librarySaving ? t("canvas.sharedLibrary.saving") : isLibrarySaved ? t("canvas.sharedLibrary.update") : t("nodeToolbar.saveAsset")}
                                    </button>
                                    {/* 形象图采用（影策「上传形象图 / 从素材库选择采用并锁定」的本地真链路）：
                                        选图写 storageKey + 实体节点，剧情段视频按此图生成且不被流水线重生成覆盖。 */}
                                    <div className="grid grid-cols-2 gap-1.5" data-studio-cast-adopt>
                                        <button type="button" disabled={imageAdopting || saving || generating === current.key} onClick={() => imageFileRef.current?.click()}
                                            className="flex h-8 items-center justify-center gap-1 rounded-md border border-border text-[11px] text-muted-foreground transition hover:bg-muted disabled:opacity-50">
                                            <Upload className="size-3" /> {imageAdopting ? "处理中…" : "上传形象图"}
                                        </button>
                                        <button type="button" disabled={imageAdopting || saving} onClick={() => setAdoptOpen(true)}
                                            className="flex h-8 items-center justify-center gap-1 rounded-md border border-border text-[11px] text-muted-foreground transition hover:bg-muted disabled:opacity-50">
                                            <ImageIcon className="size-3" /> 从素材库选择并锁定
                                        </button>
                                        <input ref={imageFileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden data-studio-cast-image-upload
                                            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void handleImageFile(f); }} />
                                    </div>
                                    <div className="grid grid-cols-2 gap-1.5">
                                        <button type="button" onClick={() => void handleGenerate()} disabled={generating === current.key || saving}
                                            className="flex h-8 items-center justify-center gap-1 rounded-md border border-border text-[11px] text-muted-foreground transition hover:bg-muted disabled:opacity-50">
                                            <Wand2 className={cn("size-3", generating === current.key && "animate-spin")} /> {generating === current.key ? "提交中…" : current.genStatus === "ready" ? "重新生成" : "生成参考图"}
                                        </button>
                                        <button type="button" onClick={onOpenCanvas} className="flex h-8 items-center justify-center gap-1 rounded-md border border-border text-[11px] text-muted-foreground hover:bg-muted"><ImageIcon className="size-3" /> 画布精修</button>
                                    </div>
                                    {current.scope === "episode" ? (
                                        <button type="button" onClick={handleDelete} className="flex h-7 w-full items-center justify-center gap-1 rounded-md text-[10px] text-rose-500 hover:bg-rose-500/10"><Trash2 className="size-3" /> 删除设定</button>
                                    ) : (
                                        <p className="text-center text-[10px] leading-relaxed text-muted-foreground">共享资产画布的设定请在画布里删除（本入口只删除分集制作稿里的设定）</p>
                                    )}
                                    <p className="text-[10px] leading-relaxed text-muted-foreground">参考图可在画布生成后采用，也可直接上传或从素材库选图采用——选图会真实写回设定参考图并锁定，后续剧情段视频按此图生成，流水线不会自动重生成覆盖。</p>
                                </div>
                            </>
                        ) : (
                            <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">选中一个{kind}查看设定</div>
                        )}
                    </aside>
                </div>
            ))}

            {/* 新增设定弹窗：提交中(addPending)锁住 Esc/遮罩/X/取消，confirmLoading 用真 pending 而非 open 状态 */}
            <Modal open={adding} title={`新增${addDraft.kind}设定`}
                onCancel={() => { if (!addPending) setAdding(false); }} onOk={() => void handleAdd()}
                okText="创建" cancelText="取消" confirmLoading={addPending}
                maskClosable={!addPending} closable={!addPending} keyboard={!addPending}
                okButtonProps={{ disabled: !addDraft.name.trim() || !addDraft.description.trim() }}
                cancelButtonProps={{ disabled: addPending }} destroyOnClose>
                <div className="space-y-3 py-2">
                    <div>
                        <span className="mb-1 block text-xs text-muted-foreground">类型</span>
                        <div className="flex gap-2">
                            {(["角色", "场景", "道具"] as CastKind[]).map(k => (
                                <button key={k} type="button" onClick={() => setAddDraft({ ...addDraft, kind: k })}
                                    className={cn("rounded-md border px-3 py-1 text-xs", addDraft.kind === k ? "border-primary bg-primary/5" : "border-border")}>{k}</button>
                            ))}
                        </div>
                    </div>
                    <label className="block"><span className="mb-1 block text-xs text-muted-foreground">名称</span>
                        <Input value={addDraft.name} maxLength={60} onChange={(e) => setAddDraft({ ...addDraft, name: e.target.value })} placeholder="如：崇良 / 七绝山 / 铁鞭" /></label>
                    <label className="block"><span className="mb-1 block text-xs text-muted-foreground">外观 / 描述（必填）</span>
                        <Input.TextArea value={addDraft.description} maxLength={1000} onChange={(e) => setAddDraft({ ...addDraft, description: e.target.value })} rows={4} placeholder="外貌、衣着、性格；场景写位置与氛围" /></label>
                    {addDraft.kind === "角色" ? (
                        <label className="block"><span className="mb-1 block text-xs text-muted-foreground">声线（可选）</span>
                            <Input value={addDraft.voice} onChange={(e) => setAddDraft({ ...addDraft, voice: e.target.value })} placeholder="少年音，坚毅，语速偏快" /></label>
                    ) : null}
                    <p className="text-[10px] leading-relaxed text-muted-foreground">新设定写入第 {targetEpisode?.episodeNo ?? "—"} 集制作稿的资产计划与注册表；造型依赖画布角色节点，本地请在画布里创建造型。</p>
                </div>
            </Modal>
            {/* 素材库选图：复用本地真实素材库资产（allowedKinds=image），选中即写 storageKey 并锁定 */}
            <AssetPickerModal open={adoptOpen} allowedKinds={["image"]} onClose={() => setAdoptOpen(false)} onInsert={(payload) => void handleLibraryPick(payload)} />
            <Modal open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={null} width="min(90vw, 1100px)" centered destroyOnClose data-studio-cast-preview>
                {current && (current.thumb || current.coverUrl) ? (
                    <img src={current.thumb || current.coverUrl} alt={`${current.name} 参考图`} className="max-h-[80vh] w-full object-contain" />
                ) : null}
                <p className="mt-2 text-center text-xs text-muted-foreground">{current?.name || ""} · 参考图放大查看</p>
            </Modal>
            {/* 版本记录缩略图放大：storage_key 走真实 /media，仅查看历史版本，不切换当前设定参考图 */}
            <Modal open={Boolean(versionPreview)} onCancel={() => setVersionPreview(null)} footer={null} width="min(90vw, 1100px)" centered destroyOnClose data-studio-cast-version-preview>
                {versionPreview?.storageKey ? (
                    <img src={backendMediaUrl(versionPreview.storageKey)} alt={`V${versionPreview.sourceVersion} 参考图`} className="max-h-[80vh] w-full object-contain" />
                ) : null}
                <p className="mt-2 text-center text-xs text-muted-foreground">
                    {versionPreview ? `V${versionPreview.sourceVersion} · ${versionPreview.snapshot?.title || versionPreview.assetId} · 历史版本仅预览，不影响当前设定` : ""}
                </p>
            </Modal>
        </div>
    );
}
