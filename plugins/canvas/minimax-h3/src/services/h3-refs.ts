import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref } from "../types";
import { sameRef } from "./h3-compatibility";

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
        const url = String(media.content || media.url || media.localUrl || media.sourceUrl || "").trim();
        if (!url) return [];
        const mime = String(media.mimeType || "");
        const type = mime.startsWith("video/") || node.type === "video" ? "video" : mime.startsWith("audio/") || node.type === "audio" ? "audio" : "image";
        return [{ url, type: type as H3Ref["type"], name: node.title || type, storageKey: storageKeyOf(media), mimeType: String(media.mimeType || "") || undefined, ...(role ? { role } : {}), ...(subjectId ? { subjectId } : {}) }];
    });
    const legacy = currentNode.metadata?.h3Refs;
    const legacyRefs = legacy && typeof legacy === "object" ? Object.entries(legacy as Record<string, unknown>).flatMap(([kind, values]) => (Array.isArray(values) ? values : []).flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        const url = String(item.url || item.dataUrl || item.localUrl || item.originalLocalUrl || item.sourceUrl || item.path || "").trim();
        if (!url) return [];
        return [{ url, type: (kind === "video" ? "video" : kind === "audio" ? "audio" : "image") as H3Ref["type"], name: String(item.name || `${kind}-ref`), storageKey: storageKeyOf(item), mimeType: String(item.mimeType || "") || undefined, ...(item.role ? { role: String(item.role) as H3Ref["role"] } : {}), ...(item.subjectId ? { subjectId: String(item.subjectId) } : {}) }];
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
        return [{ url, type: "image" as const, name: `${characterName} · ${String(ref.outfit || ref.name || "outfit")}`, storageKey: storageKeyOf(ref), mimeType: String(ref.mimeType || "") || undefined }];
    });
}

// 解析拖拽事件：如果是角色资产 / 角色节点 payload，返回完整 H3CharacterGroup 入参（不含 id，id 由 upsertCharacterGroup 生成）；
// voice 字段从 characterVoiceUrl / characterVoiceName / characterVoiceStorageKey / characterVoiceAssetId 或 voice / voiceName / voiceAssetId 读取。
export function readCharacterGroupFromDrop(event: React.DragEvent<HTMLElement> | { dataTransfer: { getData: (mime: string) => string } }): {
    characterName: string;
    characterAssetId?: string;
    characterNodeId?: string;
    outfits: Array<{ url: string; name: string; storageKey?: string; mimeType?: string }>;
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
    const images = Array.isArray(value.characterImages) ? value.characterImages : [];
    const outfits = images.flatMap((image) => {
        if (!image || typeof image !== "object") return [];
        const ref = image as Record<string, unknown>;
        const url = String(ref.url || ref.dataUrl || ref.localUrl || ref.originalLocalUrl || ref.sourceUrl || ref.path || "").trim();
        if (!url) return [];
        return [{ url, name: String(ref.outfit || ref.name || "outfit"), storageKey: typeof ref.storageKey === "string" ? ref.storageKey : undefined, mimeType: typeof ref.mimeType === "string" ? ref.mimeType : undefined }];
    });
    if (!outfits.length) return null;
    // voice 字段兼容：老 payload 用 characterVoice*，新 payload 用 voice*；character 节点 metadata 也用 characterVoice*
    const voiceUrl = String(value.characterVoiceUrl || value.voice || "").trim();
    const voiceName = String(value.characterVoiceName || value.voiceName || "声线");
    const voiceDescription = String(value.characterVoiceDescription || value.voiceDescription || "").trim();
    const voiceStorageKey = typeof value.characterVoiceStorageKey === "string" ? value.characterVoiceStorageKey : (typeof value.voiceStorageKey === "string" ? value.voiceStorageKey : undefined);
    const voiceAssetId = typeof value.characterVoiceAssetId === "string" ? value.characterVoiceAssetId : (typeof value.voiceAssetId === "string" ? value.voiceAssetId : undefined);
    const voice = voiceUrl ? { url: voiceUrl, name: voiceName, description: voiceDescription || undefined, storageKey: voiceStorageKey, assetId: voiceAssetId } : undefined;
    return { characterName, characterAssetId, characterNodeId, outfits, voice };
}
