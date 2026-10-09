import type { CanvasNodeImage, CanvasNodeMetadata } from "@/types/canvas";

/** Browsing changes presentation only; it never restores inputs or changes formal reference selection. */
export function smartImageBrowsePatch(image: CanvasNodeImage): Partial<CanvasNodeMetadata> {
    return { primaryImageId: image.id, content: image.content, storageKey: image.storageKey, naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight, bytes: image.bytes, mimeType: image.mimeType,
        activeImageHistoryId: image.id, activeImageHistoryExplicit: false };
}

export function smartImageSettingsPatch(image: CanvasNodeImage): Partial<CanvasNodeMetadata> | undefined {
    const snapshot = image.generationSnapshot;
    if (!snapshot) return;
    return { prompt: snapshot.prompt, model: snapshot.model, size: snapshot.size, quality: snapshot.quality,
        background: snapshot.background, count: snapshot.count, comfyParams: snapshot.params,
        generationType: snapshot.maskEdit || snapshot.references.length ? "edit" : "generation", generationMode: "image",
        maskEdit: snapshot.maskEdit, references: snapshot.references.map(reference => reference.storageKey || reference.url || "").filter(Boolean),
        activeImageHistoryId: image.id, activeImageHistoryExplicit: true };
}
