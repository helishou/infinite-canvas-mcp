import { useMemo, useRef, useState } from "react";
import { App, Modal, Input } from "antd";
import {
    Users, Shirt, Package, MapPin, Sparkles, Plus, Lock, LockOpen, Image as ImageIcon,
    Save, Trash2, Wand2, RefreshCw, Upload, Mic,
} from "lucide-react";

import {
    editEpisodeProduction,
    backendMediaUrl,
    prepareProductionTargets,
    fetchEpisodeProduction,
} from "@/services/backend-api";
import type { ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { createManualDirectorAsset } from "@/pages/drama/manual-director-assets";
import { withArtStyle } from "@basketikun/canvas-agent/drama/art-style";
import { artStyleOptions } from "@/pages/drama/planning-topic-logic";
import { uploadMediaFile } from "@/services/file-storage";
import { nanoid } from "nanoid";
import { useAssetStore, type AudioAsset } from "@/stores/use-asset-store";
import { StudioLooksPanel } from "./studio-looks-panel";
import { cn } from "@/lib/utils";

/** 一集制作稿的可编辑快照：source（真值）+ revision（乐观锁基线）+ 生成状态。 */
export type AssetProduction = { source: Record<string, unknown> | null; revision: number; assets: Record<string, unknown>; assetCards: unknown[] };
/** 汇总到资产库的单集来源（带 episodeId + revision 供写回）。 */
export type CastSource = { episodeNo: number; episodeId: string; revision: number; source: Record<string, unknown> | null; assets: Record<string, unknown>; assetCards: unknown[] };

type Row = Record<string, any>;
type CastKind = "角色" | "造型" | "道具" | "场景";
type Entity = "character" | "environment" | "asset";
type GenStatus = "ready" | "failed" | "busy" | "idle";

/**
 * 影策角色设定新增字段在本地的真实落点（不造假数据）：
 * patch_director_source 对 character 采用严格字段白名单（name/appearance/description/
 * prompt_description/identity/voice_description/voice），新键（alias_names 等）会被后端
 * 400 拒绝，实证确认。故：别名与单独风格以 JSON 存进白名单字段 identity；参考图生成
 * 提示词存进资产卡 prompt（真正驱动生图的字段）；声音样本仍是 character.voice 记录。
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
    // 声音样本（真实：character.voice 记录）
    voiceAssetId: string; voiceStorageKey: string; voiceUrl: string;
};

type CastDraft = {
    key: string; name: string; description: string; voice: string;
    aliasNames: string[]; hasOwnStyle: boolean;
    imageStyleId: string; imageStyleName: string; imageStylePrompt: string; imagePrompt: string;
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
});

/**
 * 影策「项目资产 / 资产库」——各集制作稿真值汇总 + 真实写回。
 * 保存/新增/删除/锁定走 backend 的 editEpisodeProduction（patch_director_source /
 * create_manual_director_asset / delete_director_asset），带 revision 乐观锁。
 */
export function StudioCastPanel({ sharedAssetCanvasId, sources, artStyle, onOpenCanvas, onChanged, voiceProfiles }: {
    sharedAssetCanvasId: string | null;
    sources: CastSource[];
    artStyle: string;
    onOpenCanvas: () => void;
    onChanged: () => void;
    /** 制作设置「音色库」登记的音色档案（sampleRef=storageKey），可在角色声音选择里直接绑定。 */
    voiceProfiles?: Array<{ id: string; name: string; description: string; sampleRef: string }>;
}) {
    const { message } = App.useApp();
    const allAssets = useAssetStore((s) => s.assets);
    const audioAssets = useMemo(() => allAssets.filter((a): a is AudioAsset => a.kind === "audio"), [allAssets]);
    // 音色库里登记了有效 sampleRef 的档案，作为声音选项合并进素材库音频（真实写 character.voice）。
    const profileAudioOptions = useMemo(
        () => (voiceProfiles || []).filter(p => p.sampleRef.trim()).map(p => ({ id: `voiceprofile:${p.id}`, title: `${p.name || p.id}（音色库）`, storageKey: p.sampleRef.trim(), url: "" })),
        [voiceProfiles],
    );
    const [kind, setKind] = useState<CastKind>("角色");
    const [lookCount, setLookCount] = useState(0);
    const [filter, setFilter] = useState<"all" | "failed" | "busy" | "locked">("all");
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [draft, setDraft] = useState<CastDraft | null>(null);
    const [saving, setSaving] = useState(false);
    const [generating, setGenerating] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [addDraft, setAddDraft] = useState<{ kind: CastKind; name: string; description: string; voice: string }>({ kind: "角色", name: "", description: "", voice: "" });
    const [aliasInput, setAliasInput] = useState("");
    const [voiceBusy, setVoiceBusy] = useState(false);
    const [recording, setRecording] = useState(false);
    const audioFileRef = useRef<HTMLInputElement>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);

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
            for (const raw of rows(src.source.character_registry)) {
                const aid = assetIdFor(str(raw.id), str(raw.id));
                const g = gen(aid);
                const extra = parseExtra(raw.identity);
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
                    ...parseVoice(raw.voice),
                });
            }
            for (const raw of rows(src.source.scene_registry)) {
                const aid = assetIdFor(str(raw.id), str(raw.id));
                const g = gen(aid);
                out.push({
                    key: `environment:${src.episodeId}:${str(raw.id)}`,
                    id: str(raw.id), name: str(raw.name || raw.scene_name) || str(raw.id),
                    kind: "场景", role: "环境", description: str(raw.description), appearance: str(raw.prompt_description || raw.appearance || ""),
                    voice: "", coverUrl: str(raw.coverUrl || raw.reference_image),
                    ...loc, entity: "environment", entityId: str(raw.id), assetId: aid, locked: isLocked(raw),
                    genStatus: g.status, thumb: g.thumb, prompt: promptFor(aid),
                    aliasNames: [], imageStyleId: "", imageStyleName: "", imageStylePrompt: "", imagePrompt: "",
                    voiceAssetId: "", voiceStorageKey: "", voiceUrl: "",
                });
            }
            for (const raw of rows(src.source.asset_plan)) {
                const k = str(raw.kind || raw.asset_type).toLowerCase();
                const kindCast: CastKind | null = k === "prop" || k === "道具" ? "道具" : k === "look" || k === "造型" ? "造型" : null;
                if (!kindCast) continue;
                const aid = str(raw.id || raw.asset_id);
                const g = gen(aid);
                out.push({
                    key: `asset:${src.episodeId}:${aid}`,
                    id: aid, name: str(raw.name || raw.asset_name) || aid,
                    kind: kindCast, role: kindCast === "道具" ? "道具" : "妆造", description: str(raw.description || raw.prompt),
                    appearance: "", voice: "", coverUrl: str(raw.coverUrl || raw.reference_image),
                    ...loc, entity: "asset", entityId: aid, assetId: aid, locked: isLocked(raw),
                    genStatus: g.status, thumb: g.thumb, prompt: promptFor(aid),
                    aliasNames: [], imageStyleId: "", imageStyleName: "", imageStylePrompt: "", imagePrompt: "",
                    voiceAssetId: "", voiceStorageKey: "", voiceUrl: "",
                });
            }
            void epLabel;
        }
        const seen = new Set<string>();
        return out.filter(e => { const k = `${e.kind}:${e.name}`; if (seen.has(k)) return false; seen.add(k); return true; });
    }, [sources]);

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

    // 切换选中项时载入受控草稿（草稿带 key，切项自动回落到该条目的真实值）
    const selectEntry = (e: Entry) => { setSelectedKey(e.key); setDraft(draftOf(e)); setAliasInput(""); };
    const shownDraft = draft && current && draft.key === current.key ? draft : (current ? draftOf(current) : null);
    const patchDraft = (patch: Partial<CastDraft>) => { if (shownDraft) setDraft({ ...shownDraft, ...patch }); };

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
        // 参考图生成提示词 → 资产卡 prompt（真正驱动生图的字段），用 assetId 定位卡片而非 entityId。
        if (current.entity === "character" && current.assetId) {
            ops.push({ type: "patch_director_source", entity: "asset_card", id: current.assetId, patch: { prompt: shownDraft.imagePrompt } });
        }
        setSaving(true);
        try {
            await editEpisodeProduction(current.episodeId as never, current.revision, ops);
            message.success(`已保存「${shownDraft.name.trim()}」到第 ${sources.find(s => s.episodeId === current.episodeId)?.episodeNo ?? "?"} 集制作稿`);
            setDraft(null);
            onChanged();
        } catch (error) {
            message.error(`保存失败：${(error as Error).message}`);
        } finally {
            setSaving(false);
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

    /** 绑定声音样本：写 character.voice 记录（真实字段）；支持参考音频的视频模型会在该角色开口段带上。 */
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
            const ops: ProductionOperation[] = [{
                type: "patch_director_source", entity: "character", id: current.entityId,
                patch: { voice: voiceRecord, voice_description: pickedTitle },
            }];
            await editEpisodeProduction(current.episodeId as never, current.revision, ops);
            message.success(pickedTitle ? `已为「${current.name}」绑定声音样本「${pickedTitle}」` : `已清除「${current.name}」的声音样本`);
            setDraft(null);
            onChanged();
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

    /** 声音样本「录制」：浏览器 MediaRecorder 真实录音 → 走同一上传/绑定链路。 */
    const toggleRecord = async () => {
        if (recording) { recorderRef.current?.stop(); setRecording(false); return; }
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
            return void message.warning("当前浏览器不支持录音，请用「上传音频」");
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const rec = new MediaRecorder(stream);
            chunksRef.current = [];
            rec.ondataavailable = (ev) => { if (ev.data.size) chunksRef.current.push(ev.data); };
            rec.onstop = () => {
                stream.getTracks().forEach((t) => t.stop());
                const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
                if (blob.size) void handleVoiceFile(new File([blob], `录音-${Date.now()}.webm`, { type: blob.type }));
            };
            rec.start();
            recorderRef.current = rec;
            setRecording(true);
            message.info("正在录音，再次点击「停止录音」即上传并绑定");
        } catch {
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

    // 删除设定：delete_director_asset
    const handleDelete = () => {
        if (!current) return;
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
        if (!targetEpisode || !targetEpisode.source) return void message.warning("目标集制作稿尚未就绪");
        const kindMap = { 角色: "character", 场景: "scene", 道具: "prop" } as const;
        const k = kindMap[addDraft.kind as keyof typeof kindMap] || "prop";
        const stamp = Date.now().toString(36);
        const assetId = `MANUAL_${k.toUpperCase()}_${stamp}`;
        const entityId = k === "prop" ? undefined : `${k === "character" ? "CHAR" : "SCENE"}_MANUAL_${stamp}`;
        setAdding(true);
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
        } catch (error) {
            message.error(`新增失败：${(error as Error).message}`);
        } finally {
            setAdding(false);
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

            {/* 造型 tab：剧目级造型真值在画布角色节点，读写走画布 update_node op */}
            {kind === "造型" ? (
                <StudioLooksPanel
                    sharedAssetCanvasId={sharedAssetCanvasId}
                    episodeIds={looksEpisodeIds}
                    onOpenCanvas={onOpenCanvas}
                    onCountChange={setLookCount}
                />
            ) : entries.length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Users className="size-9 opacity-40" />
                    各集制作稿还没有登记角色/场景/道具。点「新增设定」创建，或在精修画布的设定资产里创建后汇总到这里。
                    <button type="button" onClick={() => setAdding(true)} className="mt-2 underline-offset-2 hover:underline">新增设定</button>
                </div>
            ) : (
                <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px]">
                    {/* 卡片网格 */}
                    <div className="min-h-0 overflow-y-auto p-4">
                        <div className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                            <Sparkles className="mt-0.5 size-3.5 shrink-0" />
                            先核对名称与外观描述，满意后到画布生成参考图；参考图随剧情段视频请求一起发送，保持人物和道具一致。
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
                                    {kind}设定 <span className="text-[10px] font-normal text-muted-foreground">第 {sources.find(s => s.episodeId === current.episodeId)?.episodeNo} 集</span>
                                    <button type="button" onClick={() => void handleToggleLock()} disabled={saving}
                                        className="ml-auto flex items-center gap-1 text-[10px] font-normal text-muted-foreground hover:text-foreground disabled:opacity-50">
                                        {current.locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />} {current.locked ? "已锁定" : "锁定形象"}
                                    </button>
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
                                            </label>
                                            <div className="flex gap-1.5" data-studio-cast-voice-actions>
                                                <button type="button" disabled={saving || voiceBusy} onClick={() => audioFileRef.current?.click()}
                                                    className="flex h-8 flex-1 items-center justify-center gap-1 rounded-md border border-border text-[11px] text-muted-foreground transition hover:bg-muted disabled:opacity-50">
                                                    <Upload className="size-3" /> {voiceBusy ? "处理中…" : "上传音频"}
                                                </button>
                                                <button type="button" disabled={saving || voiceBusy} onClick={() => void toggleRecord()} data-studio-cast-voice-record
                                                    className={cn("flex h-8 flex-1 items-center justify-center gap-1 rounded-md border text-[11px] transition disabled:opacity-50", recording ? "border-rose-500 bg-rose-500/10 text-rose-500" : "border-border text-muted-foreground hover:bg-muted")}>
                                                    <Mic className="size-3" /> {recording ? "停止录音" : "录制声音"}
                                                </button>
                                                <input ref={audioFileRef} type="file" accept="audio/*" hidden data-studio-cast-voice-upload
                                                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void handleVoiceFile(f); }} />
                                            </div>
                                        </>
                                    ) : null}

                                    <button type="button" onClick={() => void handleSave()} disabled={saving}
                                        className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-foreground text-xs font-medium text-background disabled:opacity-60">
                                        <Save className="size-3.5" /> {saving ? "保存中…" : "保存设定"}
                                    </button>
                                    <div className="grid grid-cols-2 gap-1.5">
                                        <button type="button" onClick={() => void handleGenerate()} disabled={generating === current.key || saving}
                                            className="flex h-8 items-center justify-center gap-1 rounded-md border border-border text-[11px] text-muted-foreground transition hover:bg-muted disabled:opacity-50">
                                            <Wand2 className={cn("size-3", generating === current.key && "animate-spin")} /> {generating === current.key ? "提交中…" : current.genStatus === "ready" ? "重新生成" : "生成参考图"}
                                        </button>
                                        <button type="button" onClick={onOpenCanvas} className="flex h-8 items-center justify-center gap-1 rounded-md border border-border text-[11px] text-muted-foreground hover:bg-muted"><ImageIcon className="size-3" /> 画布精修</button>
                                    </div>
                                    <button type="button" onClick={handleDelete} className="flex h-7 w-full items-center justify-center gap-1 rounded-md text-[10px] text-rose-500 hover:bg-rose-500/10"><Trash2 className="size-3" /> 删除设定</button>
                                    <p className="text-[10px] leading-relaxed text-muted-foreground">参考图在本地画布的智能图片节点上生成，生成后在画布确认即锁定；本面板负责设定字段与资产计划。</p>
                                </div>
                            </>
                        ) : (
                            <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">选中一个{kind}查看设定</div>
                        )}
                    </aside>
                </div>
            )}

            {/* 新增设定弹窗 */}
            <Modal open={adding} title={`新增${addDraft.kind}设定`} onCancel={() => setAdding(false)} onOk={() => void handleAdd()}
                okText="创建" cancelText="取消" confirmLoading={adding} okButtonProps={{ disabled: !addDraft.name.trim() }} destroyOnClose>
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
                        <Input value={addDraft.name} onChange={(e) => setAddDraft({ ...addDraft, name: e.target.value })} placeholder="如：崇良 / 七绝山 / 铁鞭" /></label>
                    <label className="block"><span className="mb-1 block text-xs text-muted-foreground">外观 / 描述</span>
                        <Input.TextArea value={addDraft.description} onChange={(e) => setAddDraft({ ...addDraft, description: e.target.value })} rows={4} placeholder="外貌、衣着、性格；场景写位置与氛围" /></label>
                    {addDraft.kind === "角色" ? (
                        <label className="block"><span className="mb-1 block text-xs text-muted-foreground">声线（可选）</span>
                            <Input value={addDraft.voice} onChange={(e) => setAddDraft({ ...addDraft, voice: e.target.value })} placeholder="少年音，坚毅，语速偏快" /></label>
                    ) : null}
                    <p className="text-[10px] leading-relaxed text-muted-foreground">新设定写入第 {targetEpisode?.episodeNo ?? "—"} 集制作稿的资产计划与注册表；造型依赖画布角色节点，本地请在画布里创建造型。</p>
                </div>
            </Modal>
        </div>
    );
}
