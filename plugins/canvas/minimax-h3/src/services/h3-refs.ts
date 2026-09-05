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
        const url = String(media.content || media.url || media.localUrl || media.sourceUrl || "").trim();
        if (!url) return [];
        const mime = String(media.mimeType || "");
        const type = mime.startsWith("video/") || node.type === "video" ? "video" : mime.startsWith("audio/") || node.type === "audio" ? "audio" : "image";
        return [{ url, type: type as H3Ref["type"], name: node.title || type, storageKey: storageKeyOf(media), mimeType: String(media.mimeType || "") || undefined }];
    });
    const characterAssets = currentNode.metadata?.h3CharacterAssets;
    const characterRefs = Array.isArray(characterAssets) ? characterAssets.flatMap((asset) => {
        if (!asset || typeof asset !== "object") return [];
        const item = asset as Record<string, unknown>;
        const role = String(item.name || item.characterName || "角色");
        return (Array.isArray(item.images) ? item.images : []).flatMap((image) => {
            if (!image || typeof image !== "object") return [];
            const ref = image as Record<string, unknown>;
            const url = String(ref.url || ref.dataUrl || ref.localUrl || ref.originalLocalUrl || ref.sourceUrl || ref.path || "").trim();
            return url ? [{ url, type: "image" as const, name: `${role} · ${String(ref.name || "角色参考图")}`, storageKey: storageKeyOf(ref), mimeType: String(ref.mimeType || "") || undefined }] : [];
        });
    }) : [];
    const legacy = currentNode.metadata?.h3Refs;
    const legacyRefs = legacy && typeof legacy === "object" ? Object.entries(legacy as Record<string, unknown>).flatMap(([kind, values]) => (Array.isArray(values) ? values : []).flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        const url = String(item.url || item.dataUrl || item.localUrl || item.originalLocalUrl || item.sourceUrl || item.path || "").trim();
        if (!url) return [];
        return [{ url, type: (kind === "video" ? "video" : kind === "audio" ? "audio" : "image") as H3Ref["type"], name: String(item.name || `${kind}-ref`), storageKey: storageKeyOf(item), mimeType: String(item.mimeType || "") || undefined }];
    })) : [];
    return [...connected, ...characterRefs, ...legacyRefs].filter((item, index, all) => all.findIndex((other) => sameRef(other, item)) === index);
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
    return { url, name: String(value.name || url.split(/[\\/]/).pop() || "Ref"), type: kind.startsWith("video") ? "video" : kind.startsWith("audio") ? "audio" : "image", storageKey: storageKeyOf(value), mimeType: String(value.mimeType || "") || undefined };
}
