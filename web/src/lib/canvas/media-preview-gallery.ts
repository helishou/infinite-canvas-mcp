import type { CanvasMediaPreview, CanvasMediaPreviewSource } from "@/types/canvas-plugin";

export function mediaPreviewSources(request: CanvasMediaPreview | null): CanvasMediaPreviewSource[] {
    if (!request) return [];
    const gallery = Array.isArray(request.gallery) ? request.gallery.filter((item) => item && typeof item.url === "string" && item.url) : [];
    return gallery.length ? gallery : request.url ? [request] : [];
}

export function mediaPreviewStartIndex(request: CanvasMediaPreview | null, sources: CanvasMediaPreviewSource[]) {
    const preferred = request?.galleryIndex;
    if (typeof preferred === "number" && Number.isInteger(preferred) && preferred >= 0 && preferred < sources.length && sources[preferred].url === request?.url) return preferred;
    return Math.max(0, sources.findIndex((source) => source.url === request?.url && source.type === request?.type));
}
