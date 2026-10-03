import type { CanvasMediaPreview } from "@infinite-canvas/plugin-sdk";
import type { H3Ref } from "../types";

/** Snapshot the currently visible Output cards, retaining their display order and media identity. */
export function buildH3OutputPreview(outputs: H3Ref[], index: number, mediaUrl: (key: string) => string): CanvasMediaPreview | null {
    if (!Number.isInteger(index) || !outputs[index]) return null;
    const gallery = outputs.map((item) => ({ url: item.storageKey ? mediaUrl(item.storageKey) : item.url, name: item.name, type: item.type }));
    return { ...gallery[index], gallery, galleryIndex: index };
}
