import type { CanvasConnection, CanvasNodeContext, CanvasNodeData } from "@infinite-canvas/plugin-sdk";
import type { H3Ref } from "../types";
import { sameRef } from "./h3-compatibility";

// H3 参考素材的运行上限（与 ComfyUI 侧 NanFengH3MultiReferenceGeneratorV15 的输入数一致：
// 图片1..图片9、视频1..视频3、音频1..音频3）。ref 槽位本身不限数量，超过上限的素材提交时会被拒绝。
export const H3_RUNTIME_REF_LIMITS: Record<H3Ref["type"], number> = { image: 9, video: 3, audio: 3 };

// H3 节点自身的节点类型（画布插件 id + 节点名），用于把上游 H3 节点的 Clip 成品当参考。
const H3_NODE_TYPE = "minimax-h3:video";
const CHARACTER_IMAGE_ROLES = ["character_identity", "character_turnaround", "storyboard", "scene", "blocking", "keyframe", "motion_reference", "style", "palette", "prop", "other"] as const;

function characterImageRole(value: unknown): H3Ref["role"] {
    return CHARACTER_IMAGE_ROLES.includes(value as typeof CHARACTER_IMAGE_ROLES[number]) ? value as H3Ref["role"] : "character_turnaround";
}

function storageKeyOf(value: Record<string, unknown>) {
    const nested = value.assetRef;
    const nestedKey = nested && typeof nested === "object" ? (nested as Record<string, unknown>).storageKey : undefined;
    return String(value.storageKey || nestedKey || "") || undefined;
}

export function readH3Refs(ctx: CanvasNodeContext): H3Ref[] {
    const currentNode = ctx.getNode(ctx.node.id) || ctx.node;
    const connected = ctx.getUpstream().flatMap((node) => {
        const media = node.metadata || {};
        const role = inferredRole(String(node.type || ""), node.title);
        const subjectId = role === "character_turnaround" ? node.id : undefined;
        // Character 节点是身份/资产节点，不是四视图节点；H3 只接受显式四视图图片。
        if (node.type === "character") return [];
        const sceneImage = node.type === "scene" && media.sceneImage && typeof media.sceneImage === "object" ? media.sceneImage as Record<string, unknown> : undefined;
        const source = sceneImage || media;
        const url = String(source.content || source.url || source.localUrl || source.sourceUrl || "").trim();
        const storageKey = storageKeyOf(source);
        if (!url && !storageKey) return [];
        const mime = String(source.mimeType || "");
        const type = mime.startsWith("video/") || node.type === "video" ? "video" : mime.startsWith("audio/") || node.type === "audio" ? "audio" : "image";
        return [{ url, type: type as H3Ref["type"], name: String(media.sceneName || node.title || type), storageKey, mimeType: mime || undefined, ...(role ? { role } : {}), ...(subjectId ? { subjectId } : {}), ...(node.type === "scene" ? { nodeId: node.id } : {}) }];
    });
    const legacy = currentNode.metadata?.h3Refs;
    const legacyRefs = legacy && typeof legacy === "object" ? Object.entries(legacy as Record<string, unknown>).flatMap(([kind, values]) => (Array.isArray(values) ? values : []).flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        const url = String(item.url || item.dataUrl || item.localUrl || item.originalLocalUrl || item.sourceUrl || item.path || "").trim();
        if (!url) return [];
        return [{ url, type: (kind === "video" ? "video" : kind === "audio" ? "audio" : "image") as H3Ref["type"], name: String(item.name || `${kind}-ref`), storageKey: storageKeyOf(item), mimeType: String(item.mimeType || "") || undefined, ...(item.role ? { role: String(item.role) as H3Ref["role"] } : {}), ...(item.subjectId ? { subjectId: String(item.subjectId) } : {}), ...(item.nodeId ? { nodeId: String(item.nodeId) } : {}) }];
    })) : [];
    return [...connected, ...legacyRefs]
        .filter((item, index, all) => all.findIndex((other) => sameRef(other, item)) === index)
        .map((item, order) => ({ ...item, order }));
}

function inferredRole(type: string, title?: string): H3Ref["role"] | undefined {
    const value = `${type} ${title || ""}`.toLowerCase();
    if (/四视图|turnaround/.test(value)) return "character_turnaround";
    if (/分镜|storyboard/.test(value)) return "storyboard";
    if (/场景|scene/.test(value)) return "scene";
    return undefined;
}

export type H3RefCandidate = { key: string; nodeId: string; nodeTitle: string; nodeType: string; ref: H3Ref };

/**
 * 从生图历史快照中找出本次生成实际使用过的 character 节点。
 * 角色参考图的 ReferenceImage id 由画布生成链路按 `${nodeId}-image-${index}` 生成；
 * 兼容旧的 `canvas:${nodeId}` 和直接使用 nodeId 的快照。
 */
export function storyboardSubjectIdsForNode(node: CanvasNodeData | null, nodes: CanvasNodeData[], connections: CanvasConnection[] = []) {
    if (!node) return [];
    const metadata = node.metadata || {};
    const images = Array.isArray(metadata.images) ? metadata.images.map(imageRecordOf) : [];
    const selectedId = String(metadata.activeImageHistoryExplicit ? metadata.activeImageHistoryId || metadata.primaryImageId || "" : metadata.primaryImageId || "");
    const selected = selectedId ? images.find((image) => String(image.id || "") === selectedId) : undefined;
    const snapshots = (selected ? [selected] : images).flatMap((image) => {
        const snapshot = image.generationSnapshot;
        return snapshot && typeof snapshot === "object" ? [snapshot as Record<string, unknown>] : [];
    });
    const referenceIds = [
        ...(Array.isArray(metadata.referenceIds) ? metadata.referenceIds.map(String) : []),
        ...snapshots.flatMap((snapshot) => Array.isArray(snapshot.references)
        ? snapshot.references.flatMap((reference) => reference && typeof reference === "object" ? [String((reference as Record<string, unknown>).id || "")] : [])
        : []),
    ].filter(Boolean);
    const characters = nodes.filter((candidate) => candidate.type === "character");
    const matched = characters
        .filter((candidate) => candidate.type === "character")
        .filter((character) => referenceIds.some((referenceId) => referenceId === character.id || referenceId === `canvas:${character.id}` || referenceId.startsWith(`${character.id}-`) || referenceId.includes(`:${character.id}-`)))
        .map((character) => character.id);
    if (matched.length || referenceIds.length) return matched;

    // 旧图片节点没有 referenceIds 时，沿当前生成输入连线回溯 character 节点。
    const incoming = new Map<string, string[]>();
    connections.forEach((connection) => incoming.set(connection.toNodeId, [...(incoming.get(connection.toNodeId) || []), connection.fromNodeId]));
    const characterIds = new Set(characters.map((character) => character.id));
    const found = new Set<string>();
    const queue = [node.id];
    const visited = new Set<string>();
    while (queue.length) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const sourceId of incoming.get(current) || []) {
            if (characterIds.has(sourceId)) found.add(sourceId);
            else if (!visited.has(sourceId)) queue.push(sourceId);
        }
    }
    return characters.filter((character) => found.has(character.id)).map((character) => character.id);
}

export function refreshSmartImageReference(ref: H3Ref, node: CanvasNodeData | null): H3Ref {
    if (!node || node.id !== ref.nodeId || node.type !== "config" || node.metadata?.smart !== true || (node.metadata.generationMode || "image") !== "image" || ref.type !== "image") return ref;
    const metadata = node.metadata;
    const images = Array.isArray(metadata.images) ? metadata.images.map(imageRecordOf) : [];
    const primary = images.find((image) => image.id === metadata.primaryImageId && (image.content || image.storageKey)) || images.find((image) => image.content || image.storageKey);
    if (!primary && !metadata.content && !metadata.storageKey) return ref;
    const url = String(primary?.content || metadata.content || "");
    const storageKey = String((primary ? primary.storageKey : metadata.storageKey) || "") || undefined;
    const mimeType = String(primary?.mimeType || metadata.mimeType || ref.mimeType || "") || undefined;
    return ref.url === url && ref.storageKey === storageKey && ref.mimeType === mimeType
        ? ref
        : { ...ref, url, storageKey, mimeType };
}

function imageRecordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

// 点击空 ref 槽时用它在画布上「选用节点作为 Ref」。展开口径与拖拽路径（h3-refs.readH3Refs /
// project.tsx 的 referenceDrag）保持一致：普通节点读 metadata.content，角色节点按 outfit 展开，
// 场景节点读 sceneImage，H3 节点按 Clip 成品展开。
export function h3RefCandidates(nodes: CanvasNodeData[], selfId: string, allNodes: CanvasNodeData[] = nodes, connections: CanvasConnection[] = []): H3RefCandidate[] {
    const out: H3RefCandidate[] = [];
    const push = (node: CanvasNodeData, ref: H3Ref) => {
        const storyboardSubjectIds = storyboardSubjectIdsForNode(node, allNodes, connections);
        out.push({ key: `${node.id}:${ref.storageKey || ref.url}`, nodeId: node.id, nodeTitle: node.title || String(node.type || ""), nodeType: String(node.type || ""), ref: { ...ref, nodeId: node.id, ...(storyboardSubjectIds.length ? { storyboardSubjectIds } : {}) } });
    };
    for (const node of nodes) {
        if (node.id === selfId || node.type === "group") continue;
        const metadata = node.metadata || {};
        if (node.type === "character") {
            // 角色节点只能走正式 character group 绑定；不生成无 groupId 的普通 image candidate。
            continue;
        }
        if (node.type === "scene") {
            const image = imageRecordOf(metadata.sceneImage);
            const url = String(image.url || "").trim();
            const storageKey = storageKeyOf(image);
            if (url || storageKey) push(node, { url, type: "image", role: "scene", name: node.title || "场景", storageKey, mimeType: String(image.mimeType || "") || undefined });
            continue;
        }
        if (node.type === H3_NODE_TYPE) {
            const segments = Array.isArray(metadata.segments) ? metadata.segments : [];
            for (const [index, raw] of segments.entries()) {
                const segment = imageRecordOf(raw);
                const single = typeof segment.result === "string" ? segment.result.trim() : "";
                if (single) push(node, { url: single, type: "video", name: `${node.title || "H3"} · Clip ${index + 1}`, storageKey: typeof segment.resultStorageKey === "string" ? segment.resultStorageKey : undefined, mimeType: "video/mp4" });
                for (const rawResult of Array.isArray(segment.results) ? segment.results : []) {
                    const result = imageRecordOf(rawResult);
                    const url = String(result.url || "").trim();
                    if (!url || url === single) continue;
                    const mimeType = String(result.mimeType || "") || undefined;
                    push(node, { url, type: mimeType?.startsWith("image/") ? "image" : mimeType?.startsWith("audio/") ? "audio" : "video", name: String(result.name || `${node.title || "H3"} · Clip ${index + 1}`), storageKey: typeof result.storageKey === "string" ? result.storageKey : undefined, mimeType: mimeType || "video/mp4" });
                }
            }
            continue;
        }
        const images = node.type === "config" && metadata.smart === true && (metadata.generationMode || "image") === "image" && Array.isArray(metadata.images) ? metadata.images.map(imageRecordOf) : [];
        const primary = images.find((image) => image.id === metadata.primaryImageId && (image.content || image.storageKey)) || images.find((image) => image.content || image.storageKey);
        const url = String(primary?.content || metadata.content || metadata.url || metadata.localUrl || metadata.sourceUrl || "").trim();
        if (!url) continue;
        const mime = String(metadata.mimeType || "");
        const type: H3Ref["type"] = mime.startsWith("video/") || node.type === "video" ? "video" : mime.startsWith("audio/") || node.type === "audio" ? "audio" : "image";
        const role = inferredRole(String(node.type || ""), node.title);
        push(node, { url, type, name: node.title || type, storageKey: storageKeyOf(primary || metadata), mimeType: primary?.mimeType ? String(primary.mimeType) : mime || undefined, ...(role ? { role } : {}) });
    }
    return out.filter((item, index, all) => all.findIndex((other) => sameRef(other.ref, item.ref)) === index);
}

export class CharacterGroupParseError extends Error {
    readonly code = "character_group_source_missing";
    constructor(message: string) {
        super(message);
        this.name = "CharacterGroupParseError";
    }
}

export function normalizeDroppedH3Ref(event: React.DragEvent<HTMLElement>): H3Ref | null {
    const encoded = event.dataTransfer.getData("application/x-infinite-canvas-ref");
    const fallback = event.dataTransfer.getData("text/uri-list").split(/\r?\n/).find((line) => line && !line.startsWith("#")) || event.dataTransfer.getData("text/plain");
    if (!encoded && !fallback) return null;
    let value: Record<string, unknown> = {};
    try { value = JSON.parse(encoded || fallback) as Record<string, unknown>; } catch { value = { url: fallback }; }
    const url = String(value.url || value.dataUrl || value.localUrl || value.originalLocalUrl || value.sourceUrl || value.path || "").trim();
    if (!url) return null;
    const kind = String(value.kind || value.type || "image").toLowerCase();
    const role = referenceRoleOf(value.role);
    return {
        url,
        name: String(value.name || url.split(/[\\/]/).pop() || "Ref"),
        type: kind.startsWith("video") ? "video" : kind.startsWith("audio") ? "audio" : "image",
        storageKey: storageKeyOf(value),
        mimeType: String(value.mimeType || "") || undefined,
        ...(role ? { role } : {}),
        ...(value.subjectId ? { subjectId: String(value.subjectId) } : {}),
        ...(Number.isFinite(Number(value.order)) ? { order: Number(value.order) } : {}),
    };
}

function referenceRoleOf(value: unknown): H3Ref["role"] | undefined {
    return value === "character_turnaround" || value === "storyboard" || value === "scene" || value === "motion_reference" || value === "audio_reference" ? value : undefined;
}

// 解析拖拽事件：如果是角色资产 / 角色节点 payload，返回每张 outfit 拆出的 image ref 列表；否则返回空。
export function readCharacterImagesFromDrop(event: React.DragEvent<HTMLElement> | { dataTransfer: { getData: (mime: string) => string } }): H3Ref[] {
    const transfer = event.dataTransfer;
    const encoded = transfer.getData("application/x-infinite-canvas-ref");
    const fallback = transfer.getData("text/plain");
    if (!encoded && !fallback) return [];
    let value: Record<string, unknown> = {};
    try { value = JSON.parse(encoded || fallback) as Record<string, unknown>; } catch { return []; }
    const kind = String(value.type || value.kind || "").toLowerCase();
    if (kind !== "character") return [];
    const images = Array.isArray(value.characterImages) ? value.characterImages : [];
    const characterName = String(value.characterName || value.name || "角色");
    return images.flatMap((image) => {
        if (!image || typeof image !== "object") return [];
        const ref = image as Record<string, unknown>;
        const url = String(ref.url || ref.dataUrl || ref.localUrl || ref.originalLocalUrl || ref.sourceUrl || ref.path || "").trim();
        if (!url) return [];
        return [{ url, type: "image" as const, name: `${characterName} · ${String(ref.outfit || ref.name || "outfit")}`, storageKey: storageKeyOf(ref), mimeType: String(ref.mimeType || "") || undefined, role: characterImageRole(ref.role), usage: "reference" as const }];
    });
}

// 解析拖拽事件：如果是角色资产 / 角色节点 payload，返回完整 H3CharacterGroup 入参（不含 id，id 由 upsertCharacterGroup 生成）；
// voice 字段从 characterVoiceUrl / characterVoiceName / characterVoiceStorageKey / characterVoiceAssetId 或 voice / voiceName / voiceAssetId 读取。
export function readCharacterGroupFromDrop(event: React.DragEvent<HTMLElement> | { dataTransfer: { getData: (mime: string) => string } }): {
    characterName: string;
    characterAssetId?: string;
    characterNodeId: string;
    outfits: Array<{ url: string; name: string; storageKey?: string; mimeType?: string; role?: H3Ref["role"] }>;
    selectedOutfitKeys?: string[];
    defaultVoiceEnabled?: boolean;
    voice?: { url: string; name: string; description?: string; storageKey?: string; assetId?: string };
} | null {
    const transfer = event.dataTransfer;
    const encoded = transfer.getData("application/x-infinite-canvas-ref");
    const fallback = transfer.getData("text/plain");
    if (!encoded && !fallback) return null;
    let value: Record<string, unknown> = {};
    try { value = JSON.parse(encoded || fallback) as Record<string, unknown>; } catch { return null; }
    const kind = String(value.type || value.kind || "").toLowerCase();
    if (kind !== "character") return null;
    const characterName = String(value.characterName || value.name || "角色");
    const characterAssetId = typeof value.characterAssetId === "string" ? value.characterAssetId : undefined;
    const characterNodeId = typeof value.characterNodeId === "string" ? value.characterNodeId : undefined;
    if (!characterNodeId) throw new CharacterGroupParseError("角色参考必须绑定已有 character 画布节点，不能降级为普通图片");
    const images = Array.isArray(value.characterImages) ? value.characterImages : [];
    const outfits = images.flatMap((image) => {
        if (!image || typeof image !== "object") return [];
        const ref = image as Record<string, unknown>;
        const url = String(ref.url || ref.dataUrl || ref.localUrl || ref.originalLocalUrl || ref.sourceUrl || ref.path || "").trim();
        if (!url) return [];
        return [{ url, name: String(ref.outfit || ref.name || "outfit"), storageKey: typeof ref.storageKey === "string" ? ref.storageKey : undefined, mimeType: typeof ref.mimeType === "string" ? ref.mimeType : undefined, role: characterImageRole(ref.role) }];
    });
    if (!outfits.length) return null;
    // voice 字段兼容：老 payload 用 characterVoice*，新 payload 用 voice*；character 节点 metadata 也用 characterVoice*
    const voiceUrl = String(value.characterVoiceUrl || value.voice || "").trim();
    const voiceName = String(value.characterVoiceName || value.voiceName || "声线");
    const voiceDescription = String(value.characterVoiceDescription || value.voiceDescription || "").trim();
    const voiceStorageKey = typeof value.characterVoiceStorageKey === "string" ? value.characterVoiceStorageKey : (typeof value.voiceStorageKey === "string" ? value.voiceStorageKey : undefined);
    const voiceAssetId = typeof value.characterVoiceAssetId === "string" ? value.characterVoiceAssetId : (typeof value.voiceAssetId === "string" ? value.voiceAssetId : undefined);
    const voice = voiceUrl ? { url: voiceUrl, name: voiceName, description: voiceDescription || undefined, storageKey: voiceStorageKey, assetId: voiceAssetId } : undefined;
    const selectedOutfitKeys = Array.isArray(value.selectedOutfitKeys)
        ? value.selectedOutfitKeys.filter((key): key is string => typeof key === "string")
        : undefined;
    const defaultVoiceEnabled = typeof value.defaultVoiceEnabled === "boolean" ? value.defaultVoiceEnabled : undefined;
    return { characterName, characterAssetId, characterNodeId, outfits, selectedOutfitKeys, defaultVoiceEnabled, voice };
}

// 从画布上的角色节点读同一份角色组入参（字段口径与上面拖拽 payload 一致），
// 用于「点空 ref 槽 → 在画布上选节点作参考」这条不做拖拽的路径。
export function readCharacterGroupFromNode(node: CanvasNodeData): {
    characterName: string;
    characterAssetId?: string;
    characterNodeId: string;
    outfits: Array<{ url: string; name: string; storageKey?: string; mimeType?: string; role?: H3Ref["role"] }>;
    voice?: { url: string; name: string; description?: string; storageKey?: string; assetId?: string };
} | null {
    const metadata = (node.metadata || {}) as Record<string, unknown>;
    if (!Array.isArray(metadata.characterImages)) return null;
    const outfits = metadata.characterImages.flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const image = raw as Record<string, unknown>;
        const url = String(image.url || image.dataUrl || image.localUrl || "").trim();
        const storageKey = storageKeyOf(image);
        if (!url && !storageKey) return [];
        return [{ url, name: String(image.outfit || image.name || "outfit"), storageKey, mimeType: String(image.mimeType || "") || undefined, role: characterImageRole(image.role) }];
    });
    const voiceUrl = String(metadata.characterVoiceUrl || "").trim();
    return {
        characterName: String(metadata.characterName || node.title || "角色"),
        characterAssetId: typeof metadata.characterAssetId === "string" ? metadata.characterAssetId : undefined,
        characterNodeId: node.id,
        outfits,
        voice: voiceUrl ? {
            url: voiceUrl,
            name: String(metadata.characterVoiceName || "声线"),
            description: String(metadata.characterVoiceDescription || "") || undefined,
            storageKey: typeof metadata.characterVoiceStorageKey === "string" ? metadata.characterVoiceStorageKey : undefined,
            assetId: typeof metadata.characterVoiceAssetId === "string" ? metadata.characterVoiceAssetId : undefined,
        } : undefined,
    };
}
