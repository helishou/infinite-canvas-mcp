import { useMemo, useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { App, Modal, Input, Checkbox, Switch } from "antd";
import {
    Users, Shirt, Package, MapPin, Sparkles, Plus, Lock, LockOpen, Image as ImageIcon,
    Save, Trash2, Wand2, RefreshCw, Upload, Mic, Maximize2, Play, Volume2, History,
    MicOff, AlertCircle, Pause, Link2,
} from "lucide-react";

import {
    editEpisodeProduction,
    applyBackendCanvasOperations,
    backendMediaUrl,
    prepareProductionTargets,
    fetchEpisodeProduction,
    fetchBackendProject,
    fetchBackendProjects,
    fetchBackendCanvasFolders,
    importWorkAssets,
    type WorkAssetImport,
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
import { normalizeAssetName } from "@basketikun/canvas-agent/drama/asset-extract";
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
export type CastSource = { episodeNo: number; episodeId: string; revision: number; source: Record<string, unknown> | null; assets: Record<string, unknown>; assetCards: unknown[]; /** 该集画布 ID：制作稿 media.nodeId 据此定位实体节点，存入共享画布时作为 canvasSource。 */ canvasId?: string; /** 分集实体节点上真实归档的造型图 storageKey（按 assetId）：制作稿残留但节点没有的图不算分集造型，避免与造型页不同步。 */ entityImages?: Record<string, string[]> };

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
    /** 影策 definition.aliases 同名字段，后端 buildCastIndex/auto-voice 从这里读。 */
    aliases?: string[];
    canonicalName?: string;
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
/** 影策 definition.aliases 归一读取：共享节点 characterAliases > draft identity.aliasNames/aliases > registry.aliases/alias > asset.data.aliases。 */
function readAliases(identity: unknown, row: Row | undefined, dataAliases: unknown): string[] {
    const extra = parseExtra(identity);
    const pick = (value: unknown): string[] => Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && Boolean(x.trim())).map(x => x.trim()) : [];
    const fromExtra = pick(extra.aliasNames).length ? pick(extra.aliasNames) : pick((extra as Record<string, unknown>).aliases);
    const fromRow = pick(row?.aliases ?? row?.alias);
    const candidates = fromExtra.length ? fromExtra : fromRow.length ? fromRow : pick(dataAliases);
    return Array.from(new Set(candidates));
}
/**
 * 画面指令的兜底来源：只用外观/描述这类自然语言，绝不带 name 前缀。
 * name 是稳定标识（可能就是章节标题等内部 ID），写进 prompt 会触发 INTERNAL_ID_IN_PROMPT 校验。
 */
function promptFromAppearance(e: { name: string; description: string; appearance: string }): string {
    const text = String(e.appearance || e.description || "").trim();
    if (!text) return "";
    // 极端情形：整段描述就是内部 ID（章节标题），退回中性自然语言。
    if (/^第[一二三四五六七八九十\d]+章[\s　]/.test(text) || text === e.name) return "";
    return text;
}
const styleSlug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "custom";

/** 图片网络加载占位：容器尺寸已固定，加载期间显示极轻扫光底色，补裸 img 的视觉占位。 */
const imgLoadingStyle = { backgroundImage: "linear-gradient(110deg, transparent 30%, color-mix(in oklab, var(--foreground) 5%, transparent) 50%, transparent 70%)", backgroundSize: "200% 100%" } as const;

/** 影策卡片上的波形是后端把「三视图 + 波形」合成进一张图里的；本地拿不到采样数据，因此不画波形，音频行只保留真实试听入口。 */

/** 从真实生成状态派生：状态可由共享节点兜底，图片真值必须优先分集自己归档的图。
 *  分集草稿的 assets 状态是冗余缓存，可能整集缺失（如半路蛇妻第 2 集 assets 为空）；
 *  共享资产画布节点才是统一数据源，有 storageKey 就应判为就绪，不能因缓存缺失误报"还没有生成"。
 *  但缩略图不能用共享图覆盖分集图：否则分集各自的造型图在角色卡上消失，造型页却还能看到，两页就不同步。 */
export function deriveGenStatus(assetId: string, assets: Record<string, unknown>, cards: unknown[], shared?: { storageKey: string; status: GenStatus }, nodeStorageKey = ""): { status: GenStatus; thumb: string } {
    const a = (assets[assetId] || {}) as Record<string, unknown>;
    const card = cards.find((c) => String((c as Row)?.asset_id || (c as Row)?.id || "") === assetId) as Row | undefined;
    const cardStatus = String(card?.generation_status || "").toLowerCase();
    const assetStatus = String(a.status || "").toLowerCase();
    // 图片真值优先取分集自己归档的图，其次画布实体节点上真实存在的图；共享节点只用于状态兜底。
    const storageKey = String(a.storageKey || card?.output_file || nodeStorageKey || "");
    let status: GenStatus = "idle";
    if (["generated", "ready", "approved"].includes(assetStatus) || ["generated", "ready"].includes(cardStatus)) status = "ready";
    else if (["failed", "error"].includes(assetStatus) || ["failed", "error"].includes(cardStatus)) status = "failed";
    else if (["queued", "running", "generating", "pending"].includes(assetStatus) || ["queued", "running", "generating", "pending"].includes(cardStatus)) status = "busy";
    // 已有真实归档图但状态字段缺失（历史草稿/仅回写节点）时视为就绪：
    // 否则「一键准备全部」会把已有图的资产反复当成待生成，覆盖提示词并重复建生成节点。
    if (status === "idle" && storageKey) status = "ready";
    // 状态兜底只解决"缓存缺失误报"，不改写分集自己的媒体真值。
    if (shared?.storageKey && status === "idle") status = shared.status === "ready" || shared.status === "busy" || shared.status === "failed" ? shared.status : "ready";
    const thumbKey = storageKey || (status === "idle" ? "" : shared?.storageKey || "");
    return { status, thumb: thumbKey ? backendMediaUrl(thumbKey) : "" };
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

/**
 * 资产卡副标题（影策同款）：只显示角色定位，且只认真实三分类。
 * 角色 role 是模型给的原文（可能是「男主角」等变体），按关键词归一到 主角/反派/配角；
 * 道具/场景没有角色定位，显示「—」——绝不用外观描述或别名顶替副标题。
 */
function roleLabelOf(kind: CastKind, role: string): string {
    if (kind !== "角色") return "—";
    const raw = role.trim();
    if (!raw) return "—";
    if (/主角/.test(raw)) return "主角";
    if (/反派|反角/.test(raw)) return "反派";
    if (/配角/.test(raw)) return "配角";
    return "—";
}

/**
 * 剔除生图模板前缀（影策描述里没有）：`道具设定图：刀剑。……` 这类模板标题句不是资产描述。
 * 先按「模板名：<资产名>。」整句剪掉；名称对不上时只剪「道具设定图/场景概念设定图：……。」这一句。
 */
function stripTemplatePrefix(text: string, name: string): string {
    const assetName = name.trim();
    if (assetName) {
        const escaped = assetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const withName = new RegExp(`^(?:道具设定图|场景概念设定图|角色定妆照|专业人物三视图设定板|角色四格资产参考图)\\s*[：:]\\s*${escaped}\\s*[。.]\\s*`);
        const removed = text.replace(withName, "");
        if (removed !== text) return removed.trim();
    }
    return text.replace(/^(?:道具设定图|场景概念设定图)\s*[：:][^。]*。\s*/, "").trim();
}

/**
 * 道具/场景卡副标题（影策实测）：该资产描述/外观的**首行**；描述整段都为空才显示「—」。
 * 首行若是生图模板前缀（如「道具设定图：刀剑。」）先剔除，剔除后为空再回落到原始首行。
 * 影策卡片只有一行且截断，绝不把描述折成两行。
 */
function descriptionLineOf(description: string, appearance: string, name: string): string {
    const text = String(description || appearance || "").trim();
    if (!text) return "—";
    const first = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
    if (!first) return "—";
    const stripped = stripTemplatePrefix(first, name);
    return stripped || first;
}

/**
 * 角色卡造型缩略图真值身份：lookId = 画布 characterImages[].id，storageKey = 该图媒体键。
 * 两者都来自画布角色节点（造型页同源），点缩略图时用它精确匹配造型，不靠 URL 猜。
 */
type CastLookThumb = { lookId: string; storageKey: string; url: string; name: string };

/** 角色卡造型横排真图：从 characterImages[]/images[] 带出 lookId + storageKey（本体由合并后第一张承担，渲染处丢弃）。 */
function lookThumbsOf(images: unknown, toUrl: (storageKey: string) => string): CastLookThumb[] {
    return rows(images).map(img => {
        const sk = String(img.storageKey || "");
        const url = sk ? toUrl(sk) : String(img.url || "");
        return { lookId: str(img.id), storageKey: sk || String(img.url || ""), url, name: str(img.outfit || img.name) };
    }).filter((img) => Boolean(img.url));
}

/**
 * 分集角色造型条：以该集角色节点真实归档的 storageKey 目录为准（CastSource.entityImages，与造型页同源），
 * 制作稿图片只用来补 lookId/造型名。节点没有真图时（如 writeThrough 共享引用残留）才退回制作稿数组，
 * 否则残留 storageKey 会被当成独立造型、点到造型页却找不到对应卡。
 */
function episodeLookThumbs(imageKeys: string[] | undefined, images: unknown): CastLookThumb[] {
    const fromDraft = lookThumbsOf(images, backendMediaUrl);
    const keys = (imageKeys || []).map(String).filter(Boolean);
    if (!keys.length) return fromDraft;
    return keys.map((sk) => {
        const hit = fromDraft.find((thumb) => thumb.storageKey === sk);
        return { lookId: hit?.lookId || "", storageKey: sk, url: backendMediaUrl(sk), name: hit?.name || "" };
    });
}

/**
 * 资产卡 4 拼设定图：主图（thumb）→ 记录 coverUrl → 多图真值（characterImages[]/images[]）→ 参考图 storageKey，
 * 去重保序、只留非空 URL。真值不足 4 张时由渲染处补空占位，绝不重复同一张图凑格。
 */
function cardImagesOf(input: { primary?: string; cover?: string; images?: unknown; referenceStorageKey?: string }): string[] {
    const out: string[] = [];
    const push = (url: string) => {
        const value = url.trim();
        if (!value || out.includes(value)) return;
        out.push(value);
    };
    push(input.primary || "");
    push(input.cover || "");
    for (const image of rows(input.images)) {
        const storageKey = str(image.storageKey);
        push(storageKey ? backendMediaUrl(storageKey) : str(image.url));
    }
    if (input.referenceStorageKey) push(backendMediaUrl(input.referenceStorageKey));
    return out;
}

/** 卡片网格只取小图：后端 /media 支持 ?w= 生成 WebP；详情与写回仍用原图 URL。 */
function asCardThumb(url: string, width = 320): string {
    return url.includes("/media/") && !url.includes("&w=") ? `${url}&w=${width}` : url;
}

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
    /** 影策 definition.aliases 归一主名：同一人物的别名卡归到这一张卡。 */
    canonicalName: string;
    /** 造型归属：非空表示本条是某主角的造型形态，不单独列为角色卡（造型在「造型」tab 独立成卡）。 */
    lookOf: string;
    /** 角色卡造型缩略图横排：同一身份归并后去掉本体（第一张真图）的造型图；每条带 lookId/storageKey 真值身份。 */
    lookThumbs: CastLookThumb[];
    /** 资产卡 4 拼设定图：真实图片 URL（主图优先），0~4 张；不足 4 张渲染处补空占位。 */
    images: string[];
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

export function StudioCastPanel({ dramaId, sharedAssetCanvasId, sources, loading, artStyle, onOpenCanvas, onOpenSharedCanvas, onChanged, voiceProfiles, initialKind, focusAsset }: {
    /** 当前剧目 ID：saveLibraryAsset 写共享画布必须的 dramaId。 */
    dramaId: string | null;
    sharedAssetCanvasId: string | null;
    sources: CastSource[];
    /** 顶层资产列表是否仍在读取；父级有 loading 时请显式传入，避免 sources 初值 [] 被误判为「没有设定」。 */
    loading?: boolean;
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
    // 带上 description：选中档案后同时作为该角色 voice_description（声线）写回，不只是塞一个 storageKey。
    const profileAudioOptions = useMemo(
        () => (voiceProfiles || []).filter(p => p.sampleRef.trim()).map(p => ({ id: `voiceprofile:${p.id}`, title: `${p.name || p.id}（音色库）`, description: p.description.trim(), storageKey: p.sampleRef.trim(), url: "" })),
        [voiceProfiles],
    );
    // 顶层 sources 无加载态：父级 castSources 由 Promise.all 异步填值，首帧恒为 []。
    // 显式 loading 优先；未传时用「sources 引用是否被父级更新过」兜底，避免首帧断言"没有设定"。
    // 父级 StudioAssetsTab 后续应把自身 loading 透传进来（本文件不能改父级）。
    const initialSourcesRef = useRef(sources);
    const [sourcesRefreshed, setSourcesRefreshed] = useState(false);
    useEffect(() => { if (sources !== initialSourcesRef.current) setSourcesRefreshed(true); }, [sources]);
    const sourcesPending = loading ?? (sources.length === 0 && !sourcesRefreshed);
    const [kind, setKind] = useState<CastKind>(initialKind || "角色");
    useEffect(() => { if (initialKind) setKind(initialKind); }, [initialKind]);
    const [lookCount, setLookCount] = useState(0);
    const [filter, setFilter] = useState<"all" | "failed" | "busy" | "locked">("all");
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    // 角色卡造型缩略图 → 造型页定位：带真值 lookId/storageKey + 自增 seq（同一造型连点也要重新定位）。
    const [focusLook, setFocusLook] = useState<{ castId: string; castName: string; lookId: string; storageKey: string; seq: number } | null>(null);
    const focusLookSeq = useRef(0);
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
    // effect 里才置 true 会让切设定的首帧沿用上一设定的旧影响；渲染期按查询键判 pending。
    const [castImpactKey, setCastImpactKey] = useState("");

    // 设定详情版本记录：真值 drama_asset_versions 按 (dramaId, assetId) 只读查询。
    const [assetVersions, setAssetVersions] = useState<ApprovedSharedAsset[]>([]);
    const [assetVersionsLoading, setAssetVersionsLoading] = useState(false);
    // 同上：版本列表按查询键判 pending，切设定首帧不显示上一设定的旧版本。
    const [assetVersionsKey, setAssetVersionsKey] = useState("");
    const [versionPreview, setVersionPreview] = useState<ApprovedSharedAsset | null>(null);
    const [restyleSubmitting, setRestyleSubmitting] = useState(false);

    // 共享资产画布真值节点（character/scene/prop），跨集共用；与造型面板同一拉取模式。
    type SharedNode = { id: string; type: string; title?: string; metadata?: Record<string, any> };
    const [rawSharedNodes, setRawSharedNodes] = useState<SharedNode[]>([]);
    // 渲染期派生门控：只暴露「已拉取完成且画布 id 与当前一致」的节点，切画布首帧绝不拿旧节点配新画布。
    const [sharedNodesCanvasId, setSharedNodesCanvasId] = useState<string | null>(null);
    const sharedNodes = sharedNodesCanvasId === sharedAssetCanvasId ? rawSharedNodes : [];
    const [sharedCanvasRev, setSharedCanvasRev] = useState(0);
    const [sharedLoading, setSharedLoading] = useState(false);
    const [sharedRefreshTick, setSharedRefreshTick] = useState(0);
    useEffect(() => {
        let alive = true;
        // 切画布立即清掉上一张画布的真值与 revision，避免写回落到旧画布。
        setRawSharedNodes([]);
        setSharedCanvasRev(0);
        setSharedLoading(true);
        if (!sharedAssetCanvasId) { setSharedNodesCanvasId(null); setSharedLoading(false); return; }
        void fetchBackendProject(sharedAssetCanvasId)
            .then((r) => {
                if (!alive) return;
                const nodes = ((r.project?.nodes || []) as SharedNode[]).filter(n => {
                    if (["character", "scene", "prop"].includes(n.type)) return true;
                    // 影策提升（promotion / adopt-shared-image）进共享画布的资产是 image 节点，
                    // 实体分类只记在 metadata.productionAssetId 前缀（AC-CHAR-/AC-SCENE-/AC-PROP-）。
                    // 不认这批节点，七绝山这类剧目的共享资产在新版制作台资产库里会全部消失。
                    if (n.type !== "image") return false;
                    return /^AC-(CHAR|SCENE|PROP)-/.test(String(n.metadata?.productionAssetId || ""));
                });
                setRawSharedNodes(nodes);
                setSharedNodesCanvasId(sharedAssetCanvasId);
                setSharedCanvasRev(Number(r.project?.revision || 0));
            })
            .catch(() => { if (alive) { setRawSharedNodes([]); setSharedNodesCanvasId(sharedAssetCanvasId); } })
            .finally(() => { if (alive) setSharedLoading(false); });
        return () => { alive = false; };
    }, [sharedAssetCanvasId, sharedRefreshTick]);

    // 关联已有作品素材：作品真值来自 canvas/folders（isDrama + sharedAssetCanvasId），
    // 再用 canvas/projects 摘要确认共享画布仍存在；资产只读来源作品共享画布节点。
    type ImportWork = { dramaId: string; name: string; sharedCanvasId: string };
    type ImportAsset = WorkAssetImport & { thumb: string; kindLabel: string };
    const [workImportOpen, setWorkImportOpen] = useState(false);
    const [importWorks, setImportWorks] = useState<ImportWork[]>([]);
    const [importWorkId, setImportWorkId] = useState("");
    const [importAssets, setImportAssets] = useState<ImportAsset[]>([]);
    const [importChecked, setImportChecked] = useState<string[]>([]);
    const [importWorksLoading, setImportWorksLoading] = useState(false);
    const [importAssetsLoading, setImportAssetsLoading] = useState(false);
    const [importSubmitting, setImportSubmitting] = useState(false);
    const [importError, setImportError] = useState("");

    const openWorkImport = () => {
        setWorkImportOpen(true);
        setImportWorks([]);
        setImportWorkId("");
        setImportAssets([]);
        setImportChecked([]);
        setImportError("");
        setImportWorksLoading(true);
        void Promise.all([fetchBackendCanvasFolders(), fetchBackendProjects(true)])
            .then(([folders, projects]) => {
                const aliveCanvasIds = new Set((projects.projects || []).map(p => String(p.id || "")));
                const works = (folders.folders || [])
                    .filter(f => f && f.isDrama !== false && String(f.id || "") !== String(dramaId || ""))
                    .map(f => ({ dramaId: String(f.id || ""), name: String(f.name || ""), sharedCanvasId: String(f.sharedAssetCanvasId || "") }))
                    .filter(w => w.dramaId && w.sharedCanvasId && aliveCanvasIds.has(w.sharedCanvasId))
                    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
                setImportWorks(works);
                setImportWorkId(works[0]?.dramaId || "");
                if (!works.length) setImportError("没有其他可关联的剧目作品");
            })
            .catch(() => { setImportWorks([]); setImportError("读取作品列表失败，请稍后重试"); })
            .finally(() => setImportWorksLoading(false));
    };

    useEffect(() => {
        let alive = true;
        const work = importWorks.find(w => w.dramaId === importWorkId);
        if (!workImportOpen || !work) { setImportAssets([]); return; }
        setImportAssetsLoading(true);
        setImportError("");
        void fetchBackendProject(work.sharedCanvasId)
            .then((r) => {
                if (!alive) return;
                const nodes = ((r.project?.nodes || []) as SharedNode[]).filter(n => ["character", "scene", "prop"].includes(n.type));
                const assets: ImportAsset[] = nodes.map(n => {
                    const md = n.metadata || {};
                    const kind = n.type as "character" | "scene" | "prop";
                    const images = Array.isArray(md.characterImages) ? md.characterImages : [];
                    const cover = kind === "character" ? images[0] : kind === "scene" ? md.sceneImage : md.propImage;
                    const storageKeys = kind === "character"
                        ? images.map((img: Record<string, unknown>) => String(img?.storageKey || "")).filter(Boolean)
                        : cover?.storageKey ? [String(cover.storageKey)] : [];
                    const name = kind === "character" ? md.characterName || md.characterCanonicalName || n.title
                        : kind === "scene" ? md.sceneName || n.title
                        : md.propName || md.itemName || n.title;
                    const description = kind === "character" ? md.characterDescription
                        : kind === "scene" ? md.sceneDescription
                        : md.propDescription || md.itemDescription;
                    const aliases = kind === "character" && Array.isArray(md.characterAliases)
                        ? md.characterAliases.map((a: unknown) => String(a)).filter(Boolean) : [];
                    return {
                        sourceNodeId: n.id,
                        kind,
                        name: String(name || n.id),
                        kindLabel: kind === "character" ? "角色" : kind === "scene" ? "场景" : "道具",
                        thumb: storageKeys[0] ? backendMediaUrl(storageKeys[0]) : "",
                        storageKeys,
                        ...(description ? { description: String(description) } : {}),
                        ...(aliases.length ? { aliases } : {}),
                    };
                });
                setImportAssets(assets);
                setImportChecked([]);
            })
            .catch(() => { if (alive) { setImportAssets([]); setImportError("读取该作品共享资产失败，请稍后重试"); } })
            .finally(() => { if (alive) setImportAssetsLoading(false); });
        return () => { alive = false; };
    }, [workImportOpen, importWorkId, importWorks]);

    const handleImportWork = async () => {
        const work = importWorks.find(w => w.dramaId === importWorkId);
        if (!dramaId || !work) { message.warning("未定位到当前剧目或来源作品"); return; }
        const chosen = importAssets.filter(a => importChecked.includes(a.sourceNodeId));
        if (!chosen.length) { message.warning("请先勾选要导入的素材"); return; }
        setImportSubmitting(true);
        setImportError("");
        try {
            const result = await importWorkAssets(dramaId, {
                sourceDramaId: work.dramaId,
                assets: chosen.map(({ sourceNodeId, kind, name, description, aliases, storageKeys }) => ({
                    sourceNodeId, kind, name,
                    ...(description ? { description } : {}),
                    ...(aliases?.length ? { aliases } : {}),
                    storageKeys,
                })),
            });
            if (!result.ok) { setImportError("导入失败，请稍后重试"); return; }
            message.success(`已导入 ${result.imported} 个素材${result.skipped ? `，跳过 ${result.skipped} 个` : ""}`);
            setWorkImportOpen(false);
            setImportChecked([]);
            setSharedRefreshTick(tick => tick + 1);
            onChanged();
        } catch (error) {
            setImportError(error instanceof Error ? error.message : "导入失败，请稍后重试");
        } finally {
            setImportSubmitting(false);
        }
    };

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
        // 统一数据源：共享资产画布节点是参考图真值。分集草稿的 assets 状态可能整集缺失，
        // 这里按资产 ID 与名称建索引，让下方 gen() 优先读共享节点，避免误报"还没有生成"。
        const sharedReady = new Map<string, { storageKey: string; status: GenStatus }>();
        for (const n of sharedNodes) {
            const md = (n.metadata || {}) as Row;
            let sk = "";
            if (n.type === "character") sk = String((md.characterImages as Row[] | undefined)?.[0]?.storageKey || md.storageKey || "");
            else if (n.type === "scene") sk = String((md.sceneImage as Row | undefined)?.storageKey || md.storageKey || "");
            else if (n.type === "prop") sk = String((md.propImage as Row | undefined)?.storageKey || md.storageKey || "");
            else if (n.type === "image") sk = String(md.storageKey || "");
            if (!sk) continue;
            const info = { storageKey: sk, status: "ready" as GenStatus };
            const entity = md.productionEntity as Row | undefined;
            for (const id of [md.productionAssetId, md.sharedLibraryAssetId, md.characterAssetId, md.assetId, entity?.entityId]) if (id) sharedReady.set(String(id), info);
            const nm = String(md.characterName || md.sceneName || md.propName || n.title || "");
            if (nm) sharedReady.set(nm, info);
        }
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
            const gen = (assetId: string, name?: string, ownOnly?: boolean) => deriveGenStatus(assetId, src.assets, src.assetCards,
                ownOnly ? undefined : (sharedReady.get(assetId) || (name ? sharedReady.get(name) : undefined)),
                (src.entityImages?.[assetId] || [])[0] || "");
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
                // 分集节点没有真实造型图（如 writeThrough 共享引用残留）时，允许共享图兜底，
                // 否则制作稿残留的 storageKey 会被当成独立造型，和造型页对不上。
                const nodeHasImages = (src.entityImages?.[aid]?.length || 0) > 0;
                const g = gen(aid, str(raw.name || raw.character_name), nodeHasImages);
                const extra = parseExtra(raw.identity);
                const media = (src.assets[aid] || {}) as Row;
                const card = src.assetCards.find((c) => String((c as Row)?.asset_id || (c as Row)?.id || "") === aid) as Row | undefined;
                const episodeNodeId = str(media.nodeId);
                out.push({
                    key: `character:${src.episodeId}:${str(raw.id)}`,
                    id: str(raw.id), name: str(raw.name || raw.character_name) || str(raw.id),
                    kind: "角色", role: str(raw.role || raw.character_role),
                    description: str(raw.description), appearance: str(raw.appearance || ""),
                    voice: str(raw.voice_description || raw.voice), coverUrl: str(raw.coverUrl || raw.reference_image),
                    ...loc, entity: "character", entityId: str(raw.id), assetId: aid, locked: isLocked(raw),
                    genStatus: g.status, thumb: g.thumb, prompt: promptFor(aid),
                    aliasNames: readAliases(raw.identity, raw, (media as Row)?.aliases ?? (media as Row)?.data?.aliases),
                    imageStyleId: str(extra.imageStyleId), imageStyleName: str(extra.imageStyleName), imageStylePrompt: str(extra.imageStylePrompt),
                    imagePrompt: promptFor(aid),
                    scheme: schemeFor(aid, "character"),
                    ...parseVoice(raw.voice),
                    scope: "episode",
                    ...(episodeNodeId && src.canvasId ? { canvasId: src.canvasId, nodeId: episodeNodeId } : {}),
                    libraryAssetId: aid || str(raw.id),
                    referenceStorageKey: str(media.storageKey || card?.output_file),
                    canonicalName: str(extra.canonicalName), lookOf: "",
                    // 造型条目身份来自角色节点归档图（entityImages） + 制作稿图片补 lookId，二者都是真值。
                    lookThumbs: episodeLookThumbs(src.entityImages?.[aid], (media as Row)?.images),
                    images: cardImagesOf({ primary: g.thumb, cover: str(raw.coverUrl || raw.reference_image), images: (media as Row)?.images, referenceStorageKey: str(media.storageKey || card?.output_file) }),
                });
            }
            for (const raw of rows(src.source.scene_registry)) {
                // 早期建档把「第N章 标题」场次标题误注册成 scene_registry 条目：无外观描述、name==id==章节标题。
                // 它不是场景资产，不该出现在资产库、更不该被一键准备（会把内部 ID 写进画面指令）。
                const rawName = str(raw.name || raw.scene_name);
                const rawId = str(raw.id);
                const hasLook = Boolean(str(raw.description) || str(raw.prompt_description) || str(raw.appearance));
                if (!hasLook && rawName === rawId && /^第[一二三四五六七八九十\d]+章[\s　]/.test(rawName)) continue;
                const aid = assetIdFor(str(raw.id), str(raw.id));
                const g = gen(aid, str(raw.name || raw.scene_name));
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
                    canonicalName: "", lookOf: "",
                    lookThumbs: [],
                    images: cardImagesOf({ primary: g.thumb, cover: str(raw.coverUrl || raw.reference_image), images: (media as Row)?.images, referenceStorageKey: str(media.storageKey || card?.output_file) }),
                });
            }
            for (const raw of rows(src.source.asset_plan)) {
                const k = str(raw.kind || raw.asset_type).toLowerCase();
                const kindCast: CastKind | null = k === "prop" || k === "道具" ? "道具" : k === "look" || k === "造型" ? "造型" : null;
                if (!kindCast) continue;
                const aid = str(raw.id || raw.asset_id);
                const g = gen(aid, str(raw.asset_name || raw.name));
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
                    canonicalName: "", lookOf: "",
                    lookThumbs: [],
                    images: cardImagesOf({ primary: g.thumb, cover: str(raw.coverUrl || raw.reference_image), images: (media as Row)?.images, referenceStorageKey: str(media.storageKey || card?.output_file) }),
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
        // 共享节点身份的权威口径与后端 canonicalSharedAssetIds 一致：优先节点上的显式资产 ID。
        // production-entity-* 节点没有 productionAssetId，只按节点 ID 兜底会把同一道具
        // 在分集条目（asset-prop-xxx）与共享条目（production-entity-xxx）算成两条。
        // sharedLibraryAssetId / productionEntity.entityId 是后端维护的 canonical id，必须认。
        const sharedIdentity = (node: SharedNode): string => {
            const md = node.metadata || {};
            const explicit = md.productionAssetId || md.characterAssetId || md.sceneAssetId
                || md.assetId || md.sharedLibraryAssetId || md.productionEntity?.entityId;
            return canonicalAssetId(node.id, explicit);
        };
        for (const n of sharedNodes) {
            const md = n.metadata || {};
            const thumbOf = (sk: unknown) => sk ? backendMediaUrl(String(sk)) : "";
            if (n.type === "character") {
                // 身份真值优先 productionAssetId（提升/迁移后的实体节点），其次历史 characterAssetId。
                // 与分集条目 assetId 对齐后，下方按身份去重才能消掉同一资产的两种名称。
                const identity = sharedIdentity(n);
                const imgs = Array.isArray(md.characterImages) ? md.characterImages : [];
                const primary = Number(md.characterPrimaryIndex || 0);
                const cover = imgs[primary] || imgs[0];
                out.push({
                    key: `shared:character:${n.id}`, id: identity,
                    name: String(md.characterName || n.title || n.id), kind: "角色",
                    role: String(md.characterRole || md.role || ""), description: String(md.characterDescription || ""),
                    appearance: String(md.characterDescription || ""), voice: String(md.characterVoiceDescription || ""),
                    coverUrl: thumbOf(cover?.storageKey),
                    episodeId: "", revision: 0, entity: "character", entityId: identity,
                    assetId: identity, locked: false,
                    genStatus: cover?.storageKey ? "ready" : "idle", thumb: thumbOf(cover?.storageKey), prompt: String(md.prompt || ""),
                    aliasNames: readAliases(undefined, undefined, md.characterAliases), imageStyleId: "", imageStyleName: "", imageStylePrompt: "", imagePrompt: String(md.prompt || ""),
                    scheme: defaultSchemeFor("character"),
                    voiceAssetId: String(md.characterVoiceAssetId || ""), voiceStorageKey: String(md.characterVoiceStorageKey || ""), voiceUrl: String(md.characterVoiceUrl || ""),
                    scope: "shared", canvasId: sharedAssetCanvasId || undefined, nodeId: n.id, canvasRevision: sharedCanvasRev,
                    libraryAssetId: identity,
                    referenceStorageKey: String(cover?.storageKey || md.storageKey || ""),
                    canonicalName: String(md.characterCanonicalName || ""),
                    lookOf: String(md.characterLookOf || ""),
                    lookThumbs: lookThumbsOf(md.characterImages, backendMediaUrl),
                    images: cardImagesOf({ primary: thumbOf(cover?.storageKey), images: md.characterImages, referenceStorageKey: String(cover?.storageKey || md.storageKey || "") }),
                });
            } else if (n.type === "scene") {
                const identity = sharedIdentity(n);
                out.push({
                    key: `shared:scene:${n.id}`, id: identity, name: String(md.sceneName || n.title || n.id),
                    kind: "场景", role: "环境", description: String(md.sceneDescription || ""), appearance: String(md.sceneDescription || ""),
                    voice: "", coverUrl: thumbOf(md.sceneImage?.storageKey),
                    episodeId: "", revision: 0, entity: "environment", entityId: identity, assetId: identity, locked: false,
                    genStatus: md.sceneImage?.storageKey ? "ready" : "idle", thumb: thumbOf(md.sceneImage?.storageKey), prompt: String(md.prompt || ""),
                    aliasNames: [], imageStyleId: "", imageStyleName: "", imageStylePrompt: "", imagePrompt: String(md.prompt || ""),
                    scheme: defaultSchemeFor("scene"), voiceAssetId: "", voiceStorageKey: "", voiceUrl: "",
                    scope: "shared", canvasId: sharedAssetCanvasId || undefined, nodeId: n.id, canvasRevision: sharedCanvasRev,
                    libraryAssetId: identity,
                    referenceStorageKey: String(md.sceneImage?.storageKey || md.storageKey || ""),
                    canonicalName: "", lookOf: "",
                    lookThumbs: [],
                    images: cardImagesOf({ primary: thumbOf(md.sceneImage?.storageKey), images: [md.sceneImage], referenceStorageKey: String(md.sceneImage?.storageKey || md.storageKey || "") }),
                });
            } else if (n.type === "prop") {
                const identity = sharedIdentity(n);
                out.push({
                    key: `shared:prop:${n.id}`, id: identity, name: String(md.propName || md.itemName || n.title || n.id),
                    kind: "道具", role: "道具", description: String(md.propDescription || md.itemDescription || ""), appearance: "",
                    voice: "", coverUrl: thumbOf(md.propImage?.storageKey),
                    episodeId: "", revision: 0, entity: "asset", entityId: identity, assetId: identity, locked: false,
                    genStatus: md.propImage?.storageKey ? "ready" : "idle", thumb: thumbOf(md.propImage?.storageKey), prompt: String(md.prompt || ""),
                    aliasNames: [], imageStyleId: "", imageStyleName: "", imageStylePrompt: "", imagePrompt: String(md.prompt || ""),
                    scheme: defaultSchemeFor("prop"), voiceAssetId: "", voiceStorageKey: "", voiceUrl: "",
                    scope: "shared", canvasId: sharedAssetCanvasId || undefined, nodeId: n.id, canvasRevision: sharedCanvasRev,
                    libraryAssetId: identity,
                    referenceStorageKey: String(md.propImage?.storageKey || md.storageKey || ""),
                    canonicalName: "", lookOf: "",
                    lookThumbs: [],
                    images: cardImagesOf({ primary: thumbOf(md.propImage?.storageKey), images: [md.propImage], referenceStorageKey: String(md.propImage?.storageKey || md.storageKey || "") }),
                });
            } else if (n.type === "image") {
                // 影策提升的共享资产是 image 节点，实体分类在 productionAssetId 前缀里。
                // 真值只有 title / storageKey / productionAssetId，描述类字段不编造，留空。
                const paid = String(md.productionAssetId || "");
                const identity = sharedIdentity(n);
                const kindCast: CastKind = paid.startsWith("AC-CHAR-") ? "角色" : paid.startsWith("AC-SCENE-") ? "场景" : "道具";
                const entity: Entity = kindCast === "角色" ? "character" : kindCast === "场景" ? "environment" : "asset";
                const storageKey = String(md.storageKey || "");
                out.push({
                    key: `shared:image:${n.id}`, id: identity, name: String(n.title || paid || n.id),
                    kind: kindCast, role: kindCast === "场景" ? "环境" : kindCast === "道具" ? "道具" : "",
                    description: "", appearance: "", voice: "",
                    coverUrl: thumbOf(storageKey),
                    episodeId: "", revision: 0, entity, entityId: identity, assetId: identity, locked: false,
                    genStatus: storageKey ? "ready" : "idle", thumb: thumbOf(storageKey), prompt: String(md.prompt || ""),
                    aliasNames: [], imageStyleId: "", imageStyleName: "", imageStylePrompt: "", imagePrompt: String(md.prompt || ""),
                    scheme: kindCast === "角色" ? defaultSchemeFor("character") : kindCast === "场景" ? defaultSchemeFor("scene") : defaultSchemeFor("prop"),
                    voiceAssetId: "", voiceStorageKey: "", voiceUrl: "",
                    scope: "shared", canvasId: sharedAssetCanvasId || undefined, nodeId: n.id, canvasRevision: sharedCanvasRev,
                    libraryAssetId: identity,
                    referenceStorageKey: storageKey,
                    canonicalName: "", lookOf: "",
                    lookThumbs: [],
                    images: cardImagesOf({ primary: thumbOf(storageKey), referenceStorageKey: storageKey }),
                });
            }
        }
        // 影策「别名同一人 + 造型归主卡」归一（存量资产不改 storageKey、不删节点、不动成片绑定）：
        // 1) shared 主卡写 characterCanonicalName + characterAliases；形态卡写 characterLookOf 或作为别名命中主卡；
        // 2) 形态卡/别名重复卡不单列，全部造型图并入保留的主卡（shared 优先）。
        // 共享资产优先：shared 排在前，归一时优先保留正式版本。
        const ordered = [...out].sort((a, b) => (a.scope === "shared" ? 0 : 1) - (b.scope === "shared" ? 0 : 1));
        // 归一走影策同款 normalizeAssetName（小写、去「角色：」前缀、去空格与 ·•・._- 分隔），
        // 再剥括号形态后缀（「崇良（铁鞭武人）」→「崇良」）。禁止裸名精确匹配，避免形态卡误绑独立身份。
        const normalizeName = (name: string) => normalizeAssetName(name).replace(/[（(].*$/, "");
        // 同一身份可有多个写法：完整归一 key + 去掉「蟒身/蛇身」形态后缀的 key（兼容旧 normalizeName 行为）。
        const identityKeysOf = (name: string): string[] => {
            const n = normalizeName(name);
            const stripped = n.replace(/(?:蟒身|蛇身)$/, "");
            return Array.from(new Set([n, stripped].filter(Boolean)));
        };
        // aliasKey → 规范化身份 key：shared 主卡取 productionAssetId，纯分集卡用自身 assetId 兜底。
        const aliasKeyToCanonical = new Map<string, string>();
        const keyPriority = new Map<string, number>();
        const identityById = new Map<string, string>();
        const registerIdentity = (identity: string, e: Entry, priority: number) => {
            if (!identity) return;
            for (const id of [e.assetId, e.id]) if (id) identityById.set(id, identity);
            for (const name of [e.name, e.canonicalName, ...e.aliasNames]) {
                for (const key of identityKeysOf(name)) {
                    // 主卡（无 lookOf 的 shared）优先登记；形态卡不得抢占主卡别名。
                    if (!aliasKeyToCanonical.has(key) || priority > (keyPriority.get(key) ?? -1)) {
                        aliasKeyToCanonical.set(key, identity);
                        keyPriority.set(key, priority);
                    }
                }
            }
        };
        const lookupIdentity = (e: Entry): string | undefined => [e.name, e.canonicalName, ...e.aliasNames]
            .flatMap(identityKeysOf)
            .map(k => aliasKeyToCanonical.get(k))
            .find(Boolean);
        // 第一遍：登记共享节点身份键 [characterName, characterCanonicalName, ...characterAliases] → 主卡 productionAssetId。
        // 主卡先登记（priority=1），形态卡后登记（priority=0），保证别名始终指回主卡。
        const sharedChars = ordered.filter(e => e.scope === "shared" && e.kind === "角色");
        for (const e of [...sharedChars.filter(e => !e.lookOf), ...sharedChars.filter(e => e.lookOf)]) {
            const mainIdentity = e.lookOf
                ? (identityById.get(e.lookOf) || lookupIdentity({ ...e, name: e.lookOf, canonicalName: "", aliasNames: [] }))
                : undefined;
            registerIdentity(mainIdentity || e.assetId || e.id, e, e.lookOf ? 0 : 1);
        }
        // 第二遍：分集条目按 aliasKeys 命中共享身份后，读时对齐（仅显示/去重字段，媒体真值不动）。
        for (const e of ordered) {
            if (e.kind !== "角色") continue;
            const ownIdentity = e.assetId || e.id;
            if (e.scope === "episode") {
                const hit = lookupIdentity(e);
                if (hit && hit !== ownIdentity) {
                    const main = sharedChars.find(s => !s.lookOf && (s.assetId || s.id) === hit);
                    e.canonicalName = main?.canonicalName || e.canonicalName;
                    e.assetId = hit;
                    e.entityId = hit;
                    // thumb / coverUrl / referenceStorageKey / libraryAssetId 保持各自真实媒体与写回定位。
                }
            }
            registerIdentity(e.assetId || e.id, e, 0);
        }
        const identityKeyOf = (e: Entry): string => `role:${lookupIdentity(e) || e.assetId || e.id}`;
        // 目标 key：造型卡按 lookOf 指回主卡身份，其余按自身规范化身份。
        const targetKeyOf = (e: Entry): string => {
            if (e.lookOf && e.kind === "角色") {
                const looked = identityById.get(e.lookOf)
                    || aliasKeyToCanonical.get(normalizeName(e.lookOf))
                    || e.lookOf;
                return `role:${looked}`;
            }
            return e.kind === "角色" ? identityKeyOf(e) : `${e.kind}:${e.assetId || e.name}`;
        };
        // 第一遍：谁保留（每个目标 key 第一张，shared 优先）；其余卡的设定图/造型图全部收集到保留卡。
        const seen = new Set<string>();
        const imagesByKey = new Map<string, string[]>();
        const lookThumbsByKey = new Map<string, CastLookThumb[]>();
        const result: Entry[] = [];
        for (const e of ordered) {
            const key = targetKeyOf(e);
            const isLook = Boolean(e.lookOf && e.kind === "角色");
            if (!seen.has(key) && !isLook) { seen.add(key); result.push(e); }
            const collectedImages = [...(imagesByKey.get(key) || []), ...e.images, ...(e.thumb ? [e.thumb] : [])];
            imagesByKey.set(key, Array.from(new Set(collectedImages.filter(Boolean))));
            // 造型真值与「造型」tab 同源：同一身份归并后的真实图片（shared 优先），本体由第一张承担。
            // 去重按 lookId/storageKey（旧记录没有 key 才退回 URL），否则同一张图会出两枚缩略图。
            const collectedThumbs: CastLookThumb[] = [
                ...(lookThumbsByKey.get(key) || []),
                ...e.lookThumbs,
                ...(e.thumb ? [{ lookId: "", storageKey: "", url: e.thumb, name: "" }] : []),
            ];
            const seenThumbKey = new Set<string>();
            const seenThumbUrl = new Set<string>();
            lookThumbsByKey.set(key, collectedThumbs.filter((thumb) => {
                if (!thumb.url) return false;
                const thumbKey = thumb.storageKey || thumb.url;
                if (seenThumbUrl.has(thumb.url) || seenThumbKey.has(thumbKey)) return false;
                seenThumbUrl.add(thumb.url);
                seenThumbKey.add(thumbKey);
                return true;
            }));
        }
        // 第二遍：合并完成后再写回主卡（主卡可能排在形态卡之前）；4 拼图只并真实图片，不足 4 张仍由占位补齐。
        for (const e of result) {
            const key = targetKeyOf(e);
            const extraImages = imagesByKey.get(key);
            if (extraImages?.length) e.images = Array.from(new Set([...e.images, ...extraImages]));
            // 角色卡横排 = 归并真图去掉本体（第一张）；没有造型数组为空，渲染处整行不渲染。
            e.lookThumbs = e.kind === "角色" ? (lookThumbsByKey.get(key) || []).slice(1) : [];
        }
        return result;
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
    /** 横幅标题只用真实状态：还有非 ready 的设定时才提示「还没有生成」。 */
    const hasPendingRefs = entries.some(e => e.genStatus !== "ready");
    const current = visible.find(e => e.key === selectedKey) || visible[0] || null;
    const librarySavedKind = (e: Entry) => e.entity === "character" ? "character" : e.entity === "environment" ? "scene" : "prop";
    const isLibrarySaved = Boolean(current && (current.scope === "shared" || allAssets.some(a => a.id === current.libraryAssetId && a.kind === librarySavedKind(current))));

    // 切换选中项时载入受控草稿（草稿带 key，切项自动回落到该条目的真实值）。
    // 不重置 restyle：影策 panels.tsx 的 restyle 是设定面板级开关（默认 true），切角色不自动关；
    // 换音色后的标脏依赖它保持用户选择。
    const selectEntry = (e: Entry) => { setSelectedKey(e.key); setDraft(draftOf(e)); setAliasInput(""); };
    /**
     * 角色卡造型缩略图点击：切到「造型」tab，并把该造型设为当前（右栏表单/预览跟着换）。
     * 定位只用真值身份（lookId=characterImages[].id，storageKey=媒体键）；造型页按它精确匹配，
     * 匹配不到就只切角色、不猜一张卡冒充。
     */
    const openCastLook = (e: Entry, thumb: CastLookThumb) => {
        focusLookSeq.current += 1;
        setKind("造型");
        setFocusLook({ castId: e.assetId || e.id, castName: e.name, lookId: thumb.lookId, storageKey: thumb.storageKey, seq: focusLookSeq.current });
    };
    const shownDraft = draft && current && draft.key === current.key ? draft : (current ? draftOf(current) : null);
    /** 详情大图真值：设定自身参考图（造型在「造型」tab 独立成卡，不再叠加选中态）。 */
    const detailHeroImage = current?.thumb || current?.coverUrl || "";
    const patchDraft = (patch: Partial<CastDraft>) => { if (shownDraft) setDraft({ ...shownDraft, ...patch }); };
    /**
     * 表单 disabled 的 busy 口径对齐影策 CastEditor：保存中或该设定参考图生成中时禁用字段编辑。
     */
    const formBusy = saving || (Boolean(current) && generating === current?.key);
    /** 草稿脏标记（对齐影策 dirty）：保存按钮在无改动或名称/描述为空时禁用。 */
    const draftBase = current ? draftOf(current) : null;
    const dirty = Boolean(shownDraft && draftBase && (
        shownDraft.name !== draftBase.name
        || shownDraft.description !== draftBase.description
        || shownDraft.voice !== draftBase.voice
        || shownDraft.aliasNames.join("|") !== draftBase.aliasNames.join("|")
        || shownDraft.hasOwnStyle !== draftBase.hasOwnStyle
        || shownDraft.imageStyleName !== draftBase.imageStyleName
        || shownDraft.imageStylePrompt !== draftBase.imageStylePrompt
        || shownDraft.imagePrompt !== draftBase.imagePrompt
        || shownDraft.scheme !== draftBase.scheme
    ));
    /** 字段标签按资产类型区分（影策 APPEARANCE_LABEL：角色外貌描述 / 道具外形描述 / 场景环境描述；造型沿用角色）。 */
    const appearanceLabel = !current ? "描述" : current.kind === "场景" ? "环境描述" : current.kind === "道具" ? "外形描述" : "外貌描述";
    /** 名称标签：造型卡在影策里叫「造型名称」。 */
    const nameLabel = current?.kind === "造型" ? "造型名称" : "名称";

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
    const castImpactQueryKey = dramaId && currentCastId ? `${dramaId}|${currentCastId}|${castImpactTick}` : "";
    const castImpactPending = Boolean(castImpactQueryKey) && castImpactKey !== castImpactQueryKey;
    useEffect(() => {
        let alive = true;
        if (!dramaId || !currentCastId) { setCastImpact(null); return; }
        setCastImpactLoading(true);
        fetchDramaCastImpact(dramaId, currentCastId)
            .then((result) => { if (alive) { setCastImpact(result.ok ? result : null); setCastImpactKey(castImpactQueryKey); } })
            .catch(() => { if (alive) { setCastImpact(null); setCastImpactKey(castImpactQueryKey); } })
            .finally(() => { if (alive) setCastImpactLoading(false); });
        return () => { alive = false; };
    }, [dramaId, currentCastId, castImpactTick]);

    // 版本记录：dramaId + 当前设定 assetId 决定真值查询；缺 ID 时清空，不造假列表。
    const currentVersionAssetId = current?.assetId || current?.libraryAssetId || "";
    const versionQueryKey = dramaId && currentVersionAssetId ? `${dramaId}|${currentVersionAssetId}` : "";
    const versionsPending = Boolean(versionQueryKey) && assetVersionsKey !== versionQueryKey;
    useEffect(() => {
        let alive = true;
        if (!dramaId || !currentVersionAssetId) { setAssetVersions([]); return; }
        setAssetVersionsLoading(true);
        fetchDramaAssetVersions(dramaId, currentVersionAssetId)
            .then((r) => { if (alive) { setAssetVersions(r.ok ? r.versions || [] : []); setAssetVersionsKey(versionQueryKey); } })
            .catch(() => { if (alive) { setAssetVersions([]); setAssetVersionsKey(versionQueryKey); } })
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
                // 影策 definition.aliases 同名字段：后端 buildCastIndex / auto-voice 从这里读别名，
                // 只写 aliasNames 会让「剧本称呼→同一人」归一断链。
                aliases: shownDraft.aliasNames,
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
                // 从分集节点存入资产库时沿用同图已有的造型，避免覆盖制作台里已命名的服装/造型。
                const priorImage = prior?.images?.find((item) => item.storageKey === storageKey);
                images = [{ ...image, outfit: priorImage?.outfit ?? "", outfitDescription: priorImage?.outfitDescription ?? "" }, ...images];
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
                    // 影策 definition.aliases：把这一人的别名写进共享资产，跨集引用按别名归一到同一份资产。
                    aliases: shownDraft.aliasNames.length ? shownDraft.aliasNames : (Array.isArray(md.characterAliases) ? md.characterAliases : prior?.aliases || []),
                    role: current.role || prior?.role || String(md.characterRole || "") || undefined,
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
            message.success(current.scope === "shared" || Boolean(previous) ? t("canvas.sharedLibrary.update") : t("canvas.nodeToolbar.saveAsset"));
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
        const basePrompt = shownDraft?.imagePrompt.trim() || current.prompt.trim() || promptFromAppearance(current);
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
                message.success(`已在共享画布为「${current.name}」准备好生成节点，生成在后台进行：采用后共享资产版本与 writeThrough 引用自动跟随`);
                onChanged();
                return;
            }
            const entityKind = current.entity === "environment" ? "scene" : current.entity === "asset" ? "prop" : "character";
            // 1) 把带画风的提示词写回资产卡（真实字段 asset_card.prompt），按 assetId 定位
            const ops: ProductionOperation[] = [{ type: "patch_director_source", entity: "asset_card", id: current.assetId, patch: { prompt: finalPrompt } }];
            await editEpisodeProduction(current.episodeId as never, current.revision, ops);
            // 2) 准备该实体的画布生成节点（重新读 revision，避免连写撞乐观锁）
            const fresh = await fetchEpisodeProduction(current.episodeId as never);
            await prepareProductionTargets(current.episodeId as never, fresh.production.revision, [`entity:${entityKind}:${current.entityId}`], `studio-ref-${nanoid()}`);
            message.success(`已为「${current.name}」准备好参考图生成节点，生成在后台进行：采用后写回并锁定`);
            onChanged();
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
        await runPrepare(pending);
    };

    /** 真实写回 + 准备生成节点（一键准备全部参考图，绝不伪造批量接口）。 */
    const runPrepare = async (pending: Entry[]) => {
        setBatchPrep({ done: 0, total: pending.length });
        let done = 0; let failed = 0;
        const failedDetails: string[] = [];
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
                        const base = e.imagePrompt.trim() || e.prompt.trim() || promptFromAppearance(e);
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
                    for (const e of sharedEntries) if (!usable.some(u => u.e.key === e.key)) failedDetails.push(`${e.name}（共享节点无正式实体绑定）`);
                    failed += sharedEntries.length - usable.length;
                } catch (err) { failed += sharedEntries.length; failedDetails.push(`共享画布准备失败：${(err as Error).message}`); }
                done += sharedEntries.length;
                setBatchPrep({ done, total: pending.length });
            }
            // 分集条目：原逻辑逐集保持不变。
            for (const e of pending) {
                if (e.scope === "shared") continue;
                try {
                    const basePrompt = e.imagePrompt.trim() || e.prompt.trim() || promptFromAppearance(e);
                    if (!basePrompt) { failed++; continue; }
                    const style = e.imageStylePrompt ? withArtStyle(basePrompt, e.imageStylePrompt) : withArtStyle(basePrompt, artStyle);
                    const entityKind = e.entity === "environment" ? "scene" : e.entity === "asset" ? "prop" : "character";
                    let fresh = await fetchEpisodeProduction(e.episodeId as never);
                    await editEpisodeProduction(e.episodeId as never, fresh.production.revision, [{ type: "patch_director_source", entity: "asset_card", id: e.assetId, patch: { prompt: style } }]);
                    fresh = await fetchEpisodeProduction(e.episodeId as never);
                    await prepareProductionTargets(e.episodeId as never, fresh.production.revision, [`entity:${entityKind}:${e.entityId}`], `studio-ref-${nanoid()}`);
                    episodePrepared++;
                } catch (err) { failed++; failedDetails.push(`${e.name}：${(err as Error).message}`); }
                done++;
                setBatchPrep({ done, total: pending.length });
            }
            onChanged();
            // 对齐影策：准备后不跳画布。节点已由 HTTP 备好，生成由后台 runner 完成；本页 onChanged 刷新即可见进度。
            message.success(`已准备 ${done - failed}/${pending.length} 个参考图生成节点（共享画布 ${sharedPrepared}、分集画布 ${episodePrepared}），生成在后台进行${failed ? `，${failed} 个失败：${failedDetails.slice(0, 3).join("；")}` : ""}`);
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
        // 音色库档案的「音色描述」就是角色声线，选中后真写进 character.voice_description；
        // 普通素材库音频仍沿用标题（历史行为）。两者都写 character.voice（含 storageKey）。
        const voiceDescription = profile ? (profile.description || pickedTitle) : pickedTitle;
        setSaving(true);
        try {
            if (current.scope === "shared" && current.canvasId && current.nodeId) {
                // 共享画布角色没有分集制作稿（episodeId 为空）：走画布节点 metadata 真值写回，与造型面板同款。
                await applyBackendCanvasOperations(current.canvasId, [
                    { type: "update_node", id: current.nodeId, metadata: {
                        characterVoiceAssetId: voiceRecord.assetId || "",
                        characterVoiceStorageKey: voiceRecord.storageKey || "",
                        characterVoiceUrl: voiceRecord.url || "",
                        characterVoiceDescription: voiceDescription,
                    } },
                ], current.canvasRevision);
            } else {
                const ops: ProductionOperation[] = [{
                    type: "patch_director_source", entity: "character", id: current.entityId,
                    patch: { voice: voiceRecord, voice_description: voiceDescription },
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
            // 统一数据源：新设定同时写入共享画布 canonical。分集制作稿只保留注册项供本集引用，
            // 制作台资产卡按共享节点优先展示，避免新建的设定只落在一集、共享画布缺失。
            try {
                const stampNow = new Date().toISOString();
                const image = { url: "", name, width: 0, height: 0, bytes: 0, mimeType: "" };
                const base = { id: assetId, title: name, coverUrl: "", tags: [] as string[], folderId: null, dramaId, source: "studio", createdAt: stampNow, updatedAt: stampNow, metadata: { source: "studio" } };
                let sharedAsset: Asset;
                if (k === "character") sharedAsset = { ...base, kind: "character", data: { name, englishName: "", description: addDraft.description.trim(), voice: "", voiceName: "", voiceDescription: addDraft.voice.trim(), voiceAssetId: "", images: [], primaryIndex: 0, aliases: [], role: "" } };
                else if (k === "scene") sharedAsset = { ...base, kind: "scene", data: { name, description: addDraft.description.trim(), image, colorCardPrompt: "" } };
                else sharedAsset = { ...base, kind: "prop", data: { name, description: addDraft.description.trim(), image } };
                await saveLibraryAsset(sharedAsset, { operationId: nanoid() });
            } catch (error) {
                message.warning(`设定已写入第 ${targetEpisode.episodeNo} 集，但同步共享画布失败：${(error as Error).message}`);
            }
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
            {/* 顶栏：分类 tab / 状态筛选 / 操作合成一条 flex-wrap 头栏（对齐影策 drama-view-head） */}
            <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-2">
                {/* 分类 tab：4px 内边距 + 下沉底 + 1px 描边 + 圆角分组（影策 drama-tabs） */}
                <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/60 p-1" role="tablist" aria-label="设定类型">
                    {KIND_TABS.map(({ key }) => (
                        <button key={key} type="button" role="tab" aria-selected={kind === key}
                            onClick={() => { setKind(key); setSelectedKey(null); setDraft(null); }}
                            className={cn("inline-flex h-[30px] items-center gap-2 rounded-md px-4 text-[11px] transition",
                                kind === key ? "bg-card font-medium text-foreground shadow-xs" : "text-muted-foreground hover:bg-card/60 hover:text-foreground")}>
                            {key} <span className="tabular-nums font-medium opacity-60">{key === "造型" ? lookCount : counts[key]}</span>
                        </button>
                    ))}
                </div>
                {/* 状态筛选：胶囊按钮 + 独立 <b> 计数（tabular-nums），失败项计数用 destructive 色 */}
                <div className="flex items-center gap-1 overflow-x-auto thin-scrollbar" role="group" aria-label="筛选">
                    {([
                        { key: "all", label: "全部", n: entries.length },
                        { key: "failed", label: "失败", n: failedCount },
                        { key: "busy", label: "生成中", n: busyCount },
                        { key: "locked", label: "已锁定", n: lockedCount },
                    ] as const).map(f => (
                        <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}
                            className={cn("inline-flex h-[26px] shrink-0 items-center whitespace-nowrap rounded-full border px-2 text-[11px] transition",
                                filter === f.key ? "border-border bg-card text-foreground" : "border-transparent text-muted-foreground hover:bg-muted/60")}>
                            {f.label}<b className={cn("ml-1 font-semibold tabular-nums", f.key === "failed" && f.n > 0 ? "text-destructive" : "text-muted-foreground/70")}>{f.n}</b>
                        </button>
                    ))}
                </div>
                {/* 影策 drama-cast-toolbar：两枚描边按钮（link / plus 图标），右对齐；真实动作分别是作品素材导入与新增设定 */}
                <div className="ml-auto flex flex-wrap items-center gap-2" data-asset-toolbar>
                    <button type="button" aria-label="关联已有作品素材" onClick={openWorkImport}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[12px] font-medium text-foreground transition hover:bg-muted"
                        data-asset-toolbar-import>
                        <Link2 className="size-3.5" /> 关联已有作品素材
                    </button>
                    <button type="button" aria-label="新增设定" onClick={() => setAdding(true)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[12px] font-medium text-foreground transition hover:bg-muted"
                        data-asset-toolbar-create>
                        <Plus className="size-3.5" /> 新增设定
                    </button>
                </div>
            </div>

            {/* 造型 tab：剧目级造型真值在画布角色节点，读写走画布 update_node op。
                始终挂载（非造型 tab 时 hidden）：onCountChange 的计数 effect 需要在 tab 未激活时也运行，
                否则「造型 N」分类计数会因面板未挂载一直显示 0（误以为没有造型）。 */}
            <div className={kind === "造型" ? "contents" : "hidden"}>
                <StudioLooksPanel
                    dramaId={dramaId}
                    sharedAssetCanvasId={sharedAssetCanvasId}
                    episodeIds={looksEpisodeIds}
                    focusLook={focusLook}
                    onOpenCanvas={onOpenCanvas}
                    onCountChange={setLookCount}
                    artStyle={artStyle}
                />
            </div>
            {kind !== "造型" && (sourcesPending ? (
                <div className="grid min-h-0 flex-1 place-content-center justify-items-center gap-2 px-4 py-16 text-center text-xs text-muted-foreground" data-studio-cast-sources-loading aria-busy="true">
                    <RefreshCw className="size-6 animate-spin opacity-50" />
                    <span>正在读取各集设定…</span>
                </div>
            ) : entries.length === 0 ? (
                <div className="grid min-h-0 flex-1 place-content-center justify-items-center gap-2 px-4 py-16 text-center text-xs text-muted-foreground">
                    <Users className="size-7 opacity-50" />
                    各集制作稿还没有登记角色/场景/道具。点「新增设定」创建，或在精修画布的设定资产里创建后汇总到这里。
                    <button type="button" onClick={() => setAdding(true)} className="mt-1 underline-offset-2 hover:underline">新增设定</button>
                </div>
            ) : (
                <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_380px]">
                    {/* 卡片网格 */}
                    <div className="min-h-0 overflow-y-auto px-5 pb-7 pt-4 thin-scrollbar">
                        {/* 生成参考图横幅：strong 标题 + 说明 + 主按钮；只在真有未就绪设定时出现 */}
                        {hasPendingRefs ? (
                        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[11px]" data-studio-cast-banner>
                            <Sparkles className="size-5 shrink-0 text-primary" />
                            <div className="min-w-0 flex-1 leading-relaxed">
                                <strong className="block font-semibold text-foreground">参考图还没有生成</strong>
                                <span className="text-muted-foreground">先核对角色、道具、场景与造型的名称和外观描述，满意后再准备生成节点；参考图会随剧情段视频请求一起发送，保持人物和道具一致。</span>
                            </div>
                            {batchPrep ? (
                                <span className="shrink-0 font-medium text-primary" data-studio-batch-prep-progress>准备中 {batchPrep.done}/{batchPrep.total}</span>
                            ) : (
                                <button type="button" disabled={Boolean(generating)} onClick={() => void handlePrepareAll()}
                                    className="flex h-8 shrink-0 items-center gap-1 rounded-md bg-primary px-3 text-[11px] font-medium text-background! transition hover:opacity-90 disabled:opacity-50"
                                    data-studio-batch-prep>
                                    <Sparkles className="size-3" /> 一键准备全部参考图
                                </button>
                            )}
                        </div>
                        ) : null}
                        {/* 影策 is-wide：按 220px 自适应列宽，卡片接近方形、主图 16:9 横幅；卡片间距按影策 12px */}
                        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
                            {sourcesPending ? (
                                <div className="col-span-full grid justify-items-center gap-2 py-16 text-center text-xs text-muted-foreground" data-studio-cast-sources-loading aria-busy="true">
                                    <RefreshCw className="size-5 animate-spin opacity-50" />
                                    <span>正在读取各集设定…</span>
                                </div>
                            ) : visible.length === 0 ? (
                                <div className="col-span-full grid justify-items-center gap-2 py-16 text-center text-xs text-muted-foreground">
                                    <Users className="size-7 opacity-50" />
                                    <span>当前筛选下没有设定</span>
                                </div>
                            ) : null}
                            {visible.map((e) => {
                                // 影策卡片封面是后端烘焙的一张多格合成图：只展示真实主图，16:9 铺满（同高裁切、不留白）；
                                // 0 张才用名字首字兜底。绝不复制同一张图凑格。
                                const coverImages = e.images.slice(0, 1);
                                const hasVoice = Boolean(e.voiceStorageKey || e.voiceUrl);
                                const roleLabel = roleLabelOf(e.kind, e.role);
                                // 影策实测：角色卡副标题=角色定位；道具/场景卡副标题=描述首行（剔除生图模板前缀，单行截断）。
                                const cardSubtitle = e.kind === "角色" ? roleLabel : descriptionLineOf(e.description, e.appearance, e.name);
                                const subtitleTitle = cardSubtitle !== "—" && e.kind !== "角色" ? (e.description || e.appearance || cardSubtitle) : (cardSubtitle === "—" ? undefined : cardSubtitle);
                                return (
                                <div key={e.key} className={cn("group relative overflow-hidden rounded-[8px] border text-left transition-colors duration-150",
                                    current?.key === e.key ? "border-foreground/40 bg-accent/40 ring-[3px] ring-foreground/5" : "border-border bg-card/40 hover:border-foreground/30 hover:bg-muted/50")}>
                                    <button type="button" onClick={() => selectEntry(e)} className="block w-full text-left">
                                        <div className="relative overflow-hidden text-muted-foreground" style={imgLoadingStyle}>
                                            <div className="relative isolate flex aspect-video w-full overflow-hidden bg-[#111114]" data-asset-cover data-asset-image-count={coverImages.length}>
                                                {coverImages.length ? (
                                                    <img src={asCardThumb(coverImages[0])} alt={`${e.name}设定图`} className="size-full object-cover" loading="lazy" draggable={false} />
                                                ) : (
                                                    <span className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle_at_50%_40%,rgba(255,255,255,.1),transparent_62%)]">
                                                        <span className="grid size-14 place-items-center rounded-full border border-white/15 text-2xl font-normal text-white/75">{Array.from(e.name.trim())[0] || "角"}</span>
                                                    </span>
                                                )}
                                                <span className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/55 to-transparent" />
                                            </div>
                                            {/* 媒体框状态覆盖层：busy/failed 由 deriveGenStatus 从真实状态字段派生；无图由占位格表达 */}
                                            {e.genStatus === "busy" ? (
                                                <div className="absolute inset-0 grid animate-pulse place-items-center bg-muted/70" data-studio-cast-card-busy
                                                    style={{ backgroundImage: "linear-gradient(110deg, transparent 30%, color-mix(in oklab, var(--foreground) 8%, transparent) 50%, transparent 70%)", backgroundSize: "200% 100%" }}>
                                                    <span className="text-[10px] font-medium text-muted-foreground">生成中…</span>
                                                </div>
                                            ) : e.genStatus === "failed" ? (
                                                <div className="absolute inset-0 grid place-items-center bg-background/75 p-2 text-center" data-studio-cast-card-failed>
                                                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-destructive"><AlertCircle className="size-3.5" /> 生成失败</span>
                                                </div>
                                            ) : null}
                                            {e.locked ? <span className="absolute right-1.5 top-1.5 z-10 grid size-5 place-items-center rounded-lg bg-background/80 text-amber-500 backdrop-blur"><Lock className="size-3.5" /></span> : null}
                                        </div>
                                        {/* 影策卡片信息层级：封面 → 名称（11/600）→ 副标题（11 muted，单行截断）；造型横条与音频行在其下。
                                            角色副标题=角色定位（主角/反派/配角，缺真值 —）；道具/场景=描述首行，空描述才 —。 */}
                                        <div className="px-2 pb-2 pt-2">
                                            <div className="truncate text-[11px] font-semibold" title={e.canonicalName && e.canonicalName !== e.name ? `${e.name}（归一为${e.canonicalName}）` : undefined}>{e.name || e.canonicalName}</div>
                                            <div className="mt-px truncate text-[11px] text-muted-foreground" data-studio-cast-card-role title={subtitleTitle}>
                                                {cardSubtitle}
                                            </div>
                                        </div>
                                    </button>
                                    {/* 影策角色卡造型缩略图横排（在名称之下、音频之上）：本体之外的真实造型图；无造型整行不渲染，不占位造假。
                                        影策缩略图是 button（点它切到该造型）；身份走真值 lookId/storageKey（角色节点 characterImages[]），
                                        点中即切到「造型」tab 并把该造型设为当前（右栏表单/预览跟着换），不用 URL 猜卡。 */}
                                    {e.kind === "角色" && e.lookThumbs.length ? (
                                        <div className="flex items-center gap-1 overflow-x-auto px-2 pb-2 thin-scrollbar" role="group" aria-label={`${e.name}的造型`} data-studio-cast-look-switcher>
                                            {e.lookThumbs.map((thumb, i) => (
                                                <button type="button" key={`${e.key}:look:${thumb.lookId || thumb.storageKey || thumb.url || i}`}
                                                    title={thumb.name ? `切到造型「${thumb.name}」` : `切到造型 ${i + 1}`} data-studio-cast-look-thumb
                                                    data-look-id={thumb.lookId || undefined} data-look-storage-key={thumb.storageKey || undefined}
                                                    aria-label={`切到${e.name}的造型${thumb.name ? `「${thumb.name}」` : ` ${i + 1}`}`}
                                                    onClick={() => openCastLook(e, thumb)}
                                                    className="block h-10 w-12 shrink-0 overflow-hidden rounded-lg border border-border bg-muted/50 transition-colors hover:border-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
                                                    <img src={asCardThumb(thumb.url, 160)} alt={`${e.name}造型 ${i + 1}`} className="size-full object-cover" loading="lazy" draggable={false} />
                                                </button>
                                            ))}
                                        </div>
                                    ) : null}
                                    {/* 影策声音行：有真实音频（character.voice 的 storageKey/url）才出现播放键 + 波形占位条；
                                        没有可播放真值就保留「无音频」+ 喇叭图标。占位条只是条高固定的视觉占位，不代表真实采样。 */}
                                    {e.kind === "角色" ? (
                                        <div className="px-2 pb-2" data-studio-cast-card-audio>
                                            {hasVoice ? (
                                                <div className="flex items-center gap-2">
                                                    <button type="button" data-studio-cast-card-voice-preview
                                                        aria-label={`${voicePlaying ? "暂停" : "试听"}${e.name}的声音样本`}
                                                        onClick={(ev) => { ev.stopPropagation(); playVoiceSample(e); }}
                                                        className="grid size-6 shrink-0 place-items-center rounded-full border border-border bg-background text-foreground transition hover:bg-muted">
                                                        {voicePlaying ? <Pause className="size-3" /> : <Play className="size-3" />}
                                                    </button>
                                                    {/* 真实音频真值只有 URL，没有采样数据，不画假波形；只给可点击的试听入口与文字。 */}
                                                    <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" data-studio-cast-card-voice-preview-label>{voicePlaying ? "播放中…" : "试听声音样本"}</span>
                                                </div>
                                            ) : (
                                                <button type="button" data-studio-cast-card-voice-none disabled
                                                    aria-label={`${e.name}无音频`}
                                                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                                    <MicOff className="size-3.5" /> 无音频
                                                </button>
                                            )}
                                        </div>
                                    ) : null}
                                </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* 右侧设定面板（受控可编辑） */}
                    <aside className="min-h-0 overflow-y-auto border-l border-border bg-card/30 p-4 thin-scrollbar" data-studio-cast-detail>
                        {current && shownDraft ? (
                            <>
                                {/* 影策右栏顺序：顶部主图（放大查看），其下才是「角色设定 + 锁定形象」标题行 */}
                                {detailHeroImage ? (
                                    <button type="button" onClick={() => setPreviewOpen(true)} className="group relative block aspect-video w-full overflow-hidden rounded-[12px] border border-border bg-background" style={imgLoadingStyle} data-studio-cast-preview-open aria-label="放大查看参考图">
                                        <img src={detailHeroImage} alt={current.name} className="size-full object-contain" />
                                        {current.genStatus === "busy" || current.genStatus === "failed" ? (
                                            <span className="absolute inset-x-0 bottom-0 bg-background/85 px-2 py-1 text-center text-[10px] text-muted-foreground">
                                                {current.genStatus === "failed" ? "参考图生成失败" : "参考图生成中…"}
                                            </span>
                                        ) : null}
                                        <span className="absolute bottom-1.5 right-1.5 grid size-6 place-items-center rounded bg-background/85 text-foreground opacity-0 backdrop-blur transition group-hover:opacity-100 group-focus-visible:opacity-100"><Maximize2 className="size-3.5" /></span>
                                    </button>
                                ) : (
                                    /* 状态（影策 hero 占位同款文案）：未生成 / 生成中 / 生成失败 */
                                    <div className="grid aspect-video place-items-center rounded-[12px] border border-border bg-background p-3 text-center text-[11px] leading-5 text-muted-foreground" style={imgLoadingStyle}>
                                        {current.genStatus === "failed" ? "参考图生成失败" : current.genStatus === "busy" ? "参考图生成中…" : "尚未生成参考图：确认描述后点下方生成，或上传已有的形象图"}
                                    </div>
                                )}
                                {/* 影策对齐：标题行只留「角色设定 + 锁定形象」；作用域信息改 title 提示，不占可见文案。
                                    mt-4 承担主图（按钮）/占位图（div）之后的行距：按钮上的 margin 工具类被全局
                                    `button { margin: 0 }` 重置压掉，主图改由这里给 16px，两种 hero 分支才能同距。 */}
                                <div className="mb-4 mt-4 flex items-center gap-2 text-[11px] font-semibold tracking-[0.06em] text-foreground/40" data-studio-cast-detail-head
                                    title={current.scope === "shared" ? "跨集共用的共享资产设定" : undefined}>
                                    {kind}设定
                                    {current.scope === "episode" ? <span className="text-[11px] font-normal tracking-normal text-foreground/40">第 {sources.find(s => s.episodeId === current.episodeId)?.episodeNo} 集</span> : null}
                                    {/* 锁定形象：影策同款 label + Switch；角色/场景的锁定在画布侧，点击给出真实引导（不伪造状态）。 */}
                                    <label className="ml-auto flex items-center gap-2 text-[11px] font-normal tracking-normal text-foreground/60">
                                        {current.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
                                        锁定形象
                                        <Switch size="small" checked={current.locked} disabled={saving}
                                            title={current.entity === "asset" ? undefined : "角色/场景的参考图锁定在画布上完成"}
                                            aria-label="锁定形象" onChange={() => void handleToggleLock()} />
                                    </label>
                                </div>
                                <div className="space-y-4 text-[13px]">
                                    <label className="block">
                                        <span className="mb-2 block text-[11px] font-semibold text-foreground/60">{nameLabel}</span>
                                        <input value={shownDraft.name} maxLength={60} disabled={formBusy} aria-label={nameLabel}
                                            onChange={(e) => patchDraft({ name: e.target.value })}
                                            className="h-[34px] w-full rounded-[12px] border border-border bg-background px-3 outline-none disabled:opacity-60" />
                                    </label>

                                    {/* 别名与称呼：存 character.identity（白名单字段）里的 aliasNames */}
                                    {current.entity === "character" ? (
                                        <div data-studio-cast-aliases>
                                            <div className="mb-2 flex items-baseline justify-between gap-2">
                                                <span className="shrink-0 text-[11px] font-semibold text-foreground/60">别名与称呼</span>
                                                <span className="min-w-0 truncate text-[11px] text-foreground/40">剧本里这些称呼都会归到此角色</span>
                                            </div>
                                            <div className="flex flex-wrap items-center gap-1.5 rounded-[12px] border border-border bg-background p-1">
                                                {shownDraft.aliasNames.map((a, i) => (
                                                    <span key={`${a}:${i}`} className="flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-[11px]">
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
                                                    className="min-w-20 flex-1 bg-transparent outline-none"
                                                />
                                            </div>
                                        </div>
                                    ) : null}

                                    <label className="block">
                                        <div className="mb-2 flex items-baseline justify-between gap-2">
                                            <span className="shrink-0 text-[11px] font-semibold text-foreground/60">{appearanceLabel}</span>
                                            <span className="min-w-0 truncate text-[11px] text-foreground/40">用于参考图与剧情段视频提示词</span>
                                        </div>
                                        <textarea value={shownDraft.description} maxLength={1000} disabled={formBusy} rows={4} aria-label={appearanceLabel}
                                            onChange={(e) => patchDraft({ description: e.target.value })}
                                            className="w-full resize-none rounded-[12px] border border-border bg-background px-3 py-1.5 leading-[21px] outline-none disabled:opacity-60" />
                                    </label>

                                    {/* 单独风格开关 + 风格选择器：沿用本地选题 artStyleOptions */}
                                    {current.entity === "character" ? (
                                        <div className="space-y-2 rounded-[12px] border border-border bg-background/50 p-3" data-studio-cast-style>
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
                                                        className="h-[34px] w-full rounded-[12px] border border-border bg-background px-3 outline-none"
                                                        data-studio-cast-style-select
                                                    >
                                                        {artStyleOptions(shownDraft.imageStyleName).map((s) => <option key={s} value={s}>{s}</option>)}
                                                    </select>
                                                    <textarea
                                                        value={shownDraft.imageStylePrompt}
                                                        onChange={(e) => patchDraft({ imageStylePrompt: e.target.value })}
                                                        rows={2}
                                                        placeholder="单独风格的画风约束语句（留空则沿用所选风格名）"
                                                        className="w-full resize-none rounded-[12px] border border-border bg-background px-3 py-1.5 leading-[21px] outline-none"
                                                    />
                                                </>
                                            ) : (
                                                <span className="block text-[11px] text-foreground/40">沿用作品风格；穿越、幼年或不同世界的造型可在此单独选择。</span>
                                            )}
                                        </div>
                                    ) : null}

                                    {/* 参考图方案：影策内置方案选择器，选中真实决定 pipeline 出图模板（横版16:9）。 */}
                                    <div data-studio-cast-scheme>
                                        <span className="mb-2 block text-[11px] font-semibold text-foreground/60">参考图方案（内置技能模板 · 横版16:9）</span>
                                        <select
                                            value={shownDraft.scheme}
                                            disabled={saving}
                                            onChange={(e) => patchDraft({ scheme: e.target.value as AssetSchemeId })}
                                            className="h-[34px] w-full rounded-[12px] border border-border bg-background px-3 outline-none"
                                        >
                                            {ASSET_SCHEMES.filter((s) => (s.kinds as readonly string[]).includes(
                                                current.entity === "character" ? "character" : current.entity === "environment" ? "scene" : "prop"
                                            )).map((s) => <option key={s.id} value={s.id}>{s.name} · {s.description}</option>)}
                                        </select>
                                        <span className="mt-1 block text-[11px] leading-[1.6] text-foreground/40">
                                            {ASSET_SCHEMES.find((s) => s.id === shownDraft.scheme)?.frameHint || "按资产类型自动匹配"}
                                            ；保存后由流水线按此方案拼装提示词出图。
                                        </span>
                                    </div>

                                    {/* 参考图生成提示词：存资产卡 prompt（真正驱动生图的字段）+ 重新编排 */}
                                    {current.entity === "character" ? (
                                        <div data-studio-cast-image-prompt>
                                            <div className="mb-2 flex items-center justify-between">
                                                <span className="shrink-0 text-[11px] font-semibold text-foreground/60">参考图生成提示词</span>
                                                <button type="button" onClick={rebuildPrompt} disabled={!shownDraft.description.trim()}
                                                    className="flex items-center gap-1 text-[11px] text-foreground/60 hover:text-foreground disabled:opacity-50">
                                                    <RefreshCw className="size-3" /> 重新编排提示词
                                                </button>
                                            </div>
                                            <textarea
                                                value={shownDraft.imagePrompt}
                                                onChange={(e) => patchDraft({ imagePrompt: e.target.value })}
                                                rows={4}
                                                maxLength={12000}
                                                disabled={formBusy}
                                                aria-label="参考图生成提示词"
                                                placeholder="留空按外观、风格和参考图方案自动编排；也可填写自己的生图要求"
                                                className="w-full resize-none rounded-[12px] border border-border bg-background px-3 py-1.5 leading-[21px] outline-none disabled:opacity-60"
                                            />
                                            <span className="mt-1 block text-[11px] leading-[1.6] text-foreground/40">切换风格后可重新编排提示词。编排不调用模型；保存设定后，点击生成才开始生图。</span>
                                        </div>
                                    ) : null}

                                    {current.entity === "character" ? (
                                        <>
                                            <label className="block">
                                                <div className="mb-2 flex items-baseline justify-between gap-2">
                                                    <span className="shrink-0 text-[11px] font-semibold text-foreground/60">声线</span>
                                                    <span className="min-w-0 truncate text-[11px] text-foreground/40">写进视频提示词，由视频模型生成对白</span>
                                                </div>
                                                <input value={shownDraft.voice} disabled={formBusy} aria-label="声线"
                                                    onChange={(e) => patchDraft({ voice: e.target.value })}
                                                    placeholder="少年音，坚毅，语速偏快"
                                                    className="h-[34px] w-full rounded-[12px] border border-border bg-background px-3 outline-none disabled:opacity-60" />
                                            </label>
                                            <label className="block">
                                                <div className="mb-2 flex items-baseline justify-between gap-2">
                                                    <span className="shrink-0 text-[11px] font-semibold text-foreground/60">声音样本</span>
                                                    <span className="min-w-0 truncate text-[11px] text-foreground/40">支持参考音频的视频模型会在该角色开口的剧情段带上这段声音</span>
                                                </div>
                                                <select
                                                    value={current.voiceAssetId || current.voiceStorageKey || ""}
                                                    disabled={saving || voiceBusy}
                                                    onChange={(e) => void handleVoiceChange(e.target.value)}
                                                    data-studio-cast-voice-select
                                                    className="h-[34px] w-full rounded-[12px] border border-border bg-background px-3 outline-none"
                                                >
                                                    <option value="">不绑定样本</option>
                                                    {profileAudioOptions.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                                                    {audioAssets.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                                                </select>
                                                {!audioAssets.length ? <span className="mt-1 block text-[11px] text-foreground/40">素材库还没有音频资产；可在下方上传，或到「资源库」添加。</span> : null}
                                                <button type="button" onClick={previewVoice} disabled={!current.voiceStorageKey && !current.voiceUrl}
                                                    className="mt-1.5 flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] text-foreground/60 transition hover:bg-muted disabled:opacity-40" data-studio-cast-voice-preview>
                                                    {voicePlaying ? <Volume2 className="size-3" /> : <Play className="size-3" />} {voicePlaying ? "播放中…" : "试听样本"}
                                                </button>
                                            </label>
                                            <div className="flex flex-col gap-1.5" data-studio-cast-voice-actions>
                                                <div className="flex gap-1.5">
                                                    <button type="button" disabled={saving || voiceBusy || recording} onClick={() => audioFileRef.current?.click()}
                                                        className="flex h-[34px] flex-1 items-center justify-center gap-1 rounded-[8px] border border-border bg-background text-[13px] font-medium text-foreground transition hover:bg-muted disabled:opacity-50">
                                                        <Upload className="size-3" /> {voiceBusy ? "处理中…" : "上传"}
                                                    </button>
                                                    <button type="button" disabled={saving || voiceBusy || recording} onClick={() => void toggleRecord()} data-studio-cast-voice-record
                                                        className="flex h-[34px] flex-1 items-center justify-center gap-1 rounded-[8px] border border-border bg-background text-[13px] font-medium text-foreground transition hover:bg-muted disabled:opacity-50">
                                                        <Mic className="size-3" /> {recording ? "录音中…" : "录制"}
                                                    </button>
                                                </div>
                                                {recording ? (
                                                    <div className="flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/5 px-2 py-1.5" data-studio-cast-voice-recording>
                                                        <span className="flex items-center gap-1.5 text-[11px] text-rose-500">
                                                            <span className="size-1.5 animate-pulse rounded-full bg-rose-500" />
                                                            正在录音 {VOICE_RECORD_LIMIT_SEC - recordRemain} / {VOICE_RECORD_LIMIT_SEC} 秒
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
                                    <div className="flex items-center gap-2 rounded-[8px] border border-border bg-muted/30 px-3 py-2" data-studio-cast-restyle>
                                        <Checkbox checked={restyle} disabled={saving || restyleSubmitting}
                                            onChange={(e) => setRestyle(e.target.checked)}>
                                            让引用它的剧情段视频重新生成
                                        </Checkbox>
                                        {castImpactLoading || castImpactPending ? <span className="text-[11px] text-foreground/40">影响查询中…</span> : castImpact ? (
                                            <span className="text-[11px] text-foreground/40">{castImpact.episodes} 集 · {castImpact.segments} 段</span>
                                        ) : null}
                                    </div>
                                    {/* 保存按钮校验对齐影策：无改动、名称或描述为空时禁用 */}
                                    <button type="button" onClick={() => void handleSave()} disabled={!dirty || formBusy || !shownDraft.name.trim() || !shownDraft.description.trim()}
                                        className="flex h-[34px] w-full items-center justify-center gap-1.5 rounded-[8px] border border-border bg-background text-[13px] font-medium text-foreground transition hover:bg-muted disabled:opacity-60">
                                        <Save className="size-3.5" /> {saving ? "保存中…" : "保存设定"}
                                    </button>
                                    {/* 存入资产库 = 写共享画布 canonical；已存在的显示"更新资产库"。
                                        与「保存设定」同属按钮栈：按钮 margin 工具类被全局 button 重置压掉（实测 0），
                                        这里用内联 margin 给 8px 行距、并补 16px 到尾随的 adopt 块。 */}
                                    <button type="button" onClick={() => void handleSaveToLibrary()} disabled={librarySaving || saving}
                                        style={{ marginTop: 8, marginBottom: 16 }}
                                        className="flex h-[34px] w-full items-center justify-center gap-1.5 rounded-[8px] border border-primary/40 bg-primary/10 text-[13px] font-medium text-primary transition hover:bg-primary/20 disabled:opacity-50"
                                        data-studio-cast-save-library aria-label={isLibrarySaved ? t("canvas.sharedLibrary.update") : t("canvas.nodeToolbar.saveAsset")}>
                                        {isLibrarySaved ? <RefreshCw className="size-3.5" /> : <Upload className="size-3.5" />}
                                        {librarySaving ? t("canvas.sharedLibrary.saving") : isLibrarySaved ? t("canvas.sharedLibrary.update") : t("canvas.nodeToolbar.saveAsset")}
                                    </button>
                                    {/* 形象图采用（影策「上传形象图 / 从素材库选择采用并锁定」的本地真链路）：
                                        选图写 storageKey + 实体节点，剧情段视频按此图生成且不被流水线重生成覆盖。 */}
                                    <div className="grid grid-cols-2 gap-1.5" data-studio-cast-adopt>
                                        <button type="button" disabled={imageAdopting || saving || generating === current.key} onClick={() => imageFileRef.current?.click()}
                                            className="flex h-[34px] items-center justify-center gap-1 rounded-[8px] border border-border bg-background text-[13px] font-medium text-foreground transition hover:bg-muted disabled:opacity-50">
                                            <Upload className="size-3" /> {imageAdopting ? "处理中…" : "上传形象图"}
                                        </button>
                                        <button type="button" disabled={imageAdopting || saving} onClick={() => setAdoptOpen(true)}
                                            className="flex h-[34px] items-center justify-center gap-1 rounded-[8px] border border-border bg-background text-[13px] font-medium text-foreground transition hover:bg-muted disabled:opacity-50">
                                            <ImageIcon className="size-3" /> 从素材库选择
                                        </button>
                                        <input ref={imageFileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden data-studio-cast-image-upload
                                            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void handleImageFile(f); }} />
                                    </div>
                                    <div className="grid grid-cols-2 gap-1.5">
                                        <button type="button" onClick={() => void handleGenerate()} disabled={generating === current.key || saving || current.genStatus === "busy" || !shownDraft.name.trim() || !shownDraft.description.trim()}
                                            title={!shownDraft.name.trim() || !shownDraft.description.trim() ? "请先填写名称与描述" : undefined}
                                            className="flex h-[34px] items-center justify-center gap-1 rounded-[8px] border border-transparent bg-foreground text-[13px] font-medium text-background transition hover:opacity-90 disabled:opacity-50">
                                            <Wand2 className={cn("size-3", generating === current.key && "animate-spin")} /> {generating === current.key ? "提交中…" : current.genStatus === "ready" ? "重新生成" : "生成参考图"}
                                        </button>
                                        <button type="button" onClick={onOpenCanvas} className="flex h-[34px] items-center justify-center gap-1 rounded-[8px] border border-border bg-background text-[13px] font-medium text-foreground hover:bg-muted"><ImageIcon className="size-3" /> 在画布中精修</button>
                                    </div>
                                    {current.scope === "episode" ? (
                                        <button type="button" onClick={handleDelete} className="flex h-7 w-full items-center justify-center gap-1 rounded-[8px] text-[11px] text-rose-500 hover:bg-rose-500/10"><Trash2 className="size-3" /> 删除设定</button>
                                    ) : (
                                        <p className="text-[11px] leading-[1.6] text-foreground/40">共享资产的设定请在画布里删除（本入口只删除分集制作稿里的设定）</p>
                                    )}
                                    <p className="text-[11px] leading-[1.6] text-foreground/40">上传或从素材库采用的形象图会自动锁定，之后的剧情段视频按这张图生成，并要求外貌、发型与服装以它为准；流水线不会自动重生成覆盖。</p>
                                </div>
                                {/* 版本记录：影策右栏不显示该卡片；本地保留只读真值视图，收进右栏最底部折叠区（默认收起），不再挤占名称/外貌描述。
                                    真值仍来自 drama_asset_versions（按 dramaId + assetId 查询），与改前同源；「设为当前」仍不提供（无真实写链）。 */}
                                {/* 标题左缘与字段左缘对齐：details 的 p-2 会把 summary 右推 9px，这里 -mx-2 抵回。 */}
                                <details className="mt-4 rounded-md border border-border bg-background/40 p-2" data-studio-cast-version-history>
                                    <summary className="-mx-2 flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium text-foreground/60 [&::-webkit-details-marker]:hidden">
                                        <History className="size-3.5 text-muted-foreground" /> 版本记录
                                        {assetVersions.length ? <span className="font-normal text-muted-foreground">共 {assetVersions.length} 条</span> : null}
                                    </summary>
                                    <div className="mt-2">
                                        {assetVersionsLoading || versionsPending ? (
                                            <div className="py-2 text-center text-[10px] text-muted-foreground">读取版本记录…</div>
                                        ) : assetVersions.length ? (
                                            <div className="max-h-44 space-y-1.5 overflow-y-auto pr-0.5">
                                                {assetVersions.map((v) => (
                                                    <div key={v.id} className="flex items-center gap-2 rounded border border-border bg-card/50 p-1.5" data-studio-cast-version-row>
                                                        <button type="button" disabled={!v.storageKey} onClick={() => setVersionPreview(v)}
                                                            aria-label={`放大查看 V${v.sourceVersion} 参考图`} title="放大预览历史版本"
                                                            className="relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted/40 disabled:cursor-default" style={imgLoadingStyle}>
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
                                                                <span className={cn("rounded-full px-1.5 py-0 text-[10px] font-normal", v.reviewStatus === "approved" ? "bg-emerald-500/10 text-emerald-500" : "bg-muted text-muted-foreground")}>
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
                                </details>
                            </>
                        ) : (
                            <div className="grid justify-items-center gap-2 px-2 py-8 text-[11px] text-muted-foreground"><Users className="size-7 opacity-50" />选中一个{kind}查看设定</div>
                        )}
                    </aside>
                </div>
            ))}

            {/* 关联已有作品素材：作品来自真实剧目目录，资产来自该作品共享画布真值节点 */}
            <Modal open={workImportOpen} title="关联已有作品素材"
                onCancel={() => { if (!importSubmitting) setWorkImportOpen(false); }}
                onOk={() => void handleImportWork()} okText="导入到本项目" cancelText="取消"
                confirmLoading={importSubmitting} maskClosable={!importSubmitting} closable={!importSubmitting} keyboard={!importSubmitting}
                okButtonProps={{ disabled: !importWorkId || importChecked.length === 0 || importSubmitting }}
                cancelButtonProps={{ disabled: importSubmitting }} destroyOnClose width={720} data-studio-cast-work-import>
                <div className="space-y-3 py-2" data-studio-cast-work-import-body>
                    <div>
                        <span className="mb-1 block text-xs text-muted-foreground">来源作品</span>
                        {importWorksLoading ? (
                            <div className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground"><RefreshCw className="size-3.5 animate-spin" /> 正在读取作品列表…</div>
                        ) : importWorks.length === 0 ? (
                            <p className="py-2 text-[11px] text-muted-foreground">没有其他可关联的作品（或这些作品尚未绑定共享资产画布）。</p>
                        ) : (
                            <div className="flex flex-wrap gap-1.5">
                                {importWorks.map(w => (
                                    <button key={w.dramaId} type="button" disabled={importSubmitting || importAssetsLoading}
                                        onClick={() => { setImportAssetsLoading(true); setImportWorkId(w.dramaId); }}
                                        className={cn("rounded-md border px-3 py-1 text-xs transition disabled:opacity-50",
                                            importWorkId === w.dramaId ? "border-primary bg-primary/5 text-foreground" : "border-border text-muted-foreground hover:bg-muted")}>
                                        {w.name || w.dramaId}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                    <div>
                        <span className="mb-1 block text-xs text-muted-foreground">共享画布资产{importChecked.length ? ` · 已选 ${importChecked.length} 项` : ""}</span>
                        {importAssetsLoading ? (
                            <div className="flex items-center gap-2 py-6 text-[11px] text-muted-foreground"><RefreshCw className="size-3.5 animate-spin" /> 正在读取该作品共享资产…</div>
                        ) : importAssets.length === 0 ? (
                            <div className="grid justify-items-center gap-2 py-6 text-[11px] text-muted-foreground"><Link2 className="size-6 opacity-50" />{importWorkId ? "该作品共享画布没有可导入的角色 / 场景 / 道具资产。" : "请选择一个来源作品。"}</div>
                        ) : (
                            <div className="max-h-[46vh] space-y-1.5 overflow-y-auto thin-scrollbar pr-1">
                                {importAssets.map(asset => (
                                    <label key={asset.sourceNodeId} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition",
                                        importChecked.includes(asset.sourceNodeId) ? "border-primary bg-primary/5" : "border-border hover:bg-muted/60")}>
                                        <Checkbox checked={importChecked.includes(asset.sourceNodeId)} disabled={importSubmitting}
                                            onChange={(e) => setImportChecked(prev => e.target.checked ? [...new Set([...prev, asset.sourceNodeId])] : prev.filter(id => id !== asset.sourceNodeId))} />
                                        <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted/40" style={imgLoadingStyle}>
                                            {asset.thumb ? <img src={asCardThumb(asset.thumb, 160)} alt={asset.name} className="size-full object-cover" loading="lazy" /> : <ImageIcon className="size-4 opacity-50" />}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate font-medium">{asset.name}</span>
                                            <span className="block text-[10px] text-muted-foreground">{asset.kindLabel} · {asset.storageKeys.length} 张参考图</span>
                                        </span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                    {importError ? <p className="text-[11px] text-destructive" role="alert">{importError}</p> : null}
                    <p className="text-[10px] leading-relaxed text-muted-foreground">仅导入所选作品的真实共享画布资产；同名资产按去重规则跳过，不会覆盖本项目已有设定。</p>
                </div>
            </Modal>
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
                {detailHeroImage ? (
                    <div className="grid min-h-[240px] place-items-center" style={imgLoadingStyle}>
                        <img src={detailHeroImage} alt={`${current?.name || ""} 参考图`} className="max-h-[80vh] w-full object-contain" />
                    </div>
                ) : null}
                <p className="mt-2 text-center text-xs text-muted-foreground">{current?.name || ""} · 参考图放大查看</p>
            </Modal>
            {/* 版本记录缩略图放大：storage_key 走真实 /media，仅查看历史版本，不切换当前设定参考图 */}
            <Modal open={Boolean(versionPreview)} onCancel={() => setVersionPreview(null)} footer={null} width="min(90vw, 1100px)" centered destroyOnClose data-studio-cast-version-preview>
                {versionPreview?.storageKey ? (
                    <div className="grid min-h-[240px] place-items-center" style={imgLoadingStyle}>
                        <img src={backendMediaUrl(versionPreview.storageKey)} alt={`V${versionPreview.sourceVersion} 参考图`} className="max-h-[80vh] w-full object-contain" />
                    </div>
                ) : null}
                <p className="mt-2 text-center text-xs text-muted-foreground">
                    {versionPreview ? `V${versionPreview.sourceVersion} · ${versionPreview.snapshot?.title || versionPreview.assetId} · 历史版本仅预览，不影响当前设定` : ""}
                </p>
            </Modal>
        </div>
    );
}
