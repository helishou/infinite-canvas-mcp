import type { CanvasNodeImage, CanvasNodeMetadata } from "@/types/canvas";

/** 设为主图：切换主显示，并把该图显式指定为当前有效结果（下一次生成以它为准）；新结果回写后恢复跟随最新。 */
export function smartImagePrimaryPatch(image: CanvasNodeImage): Partial<CanvasNodeMetadata> {
    return { primaryImageId: image.id, content: image.content, storageKey: image.storageKey, naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight, bytes: image.bytes, mimeType: image.mimeType,
        activeImageHistoryId: image.id, activeImageHistoryExplicit: true };
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
