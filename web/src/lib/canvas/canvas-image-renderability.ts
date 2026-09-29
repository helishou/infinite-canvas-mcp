import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** The image shown by an image node or an image-mode smart node. */
export function canvasNodeImage(node: CanvasNodeData) {
    const isSmartImage = node.type === CanvasNodeType.Config && node.metadata?.smart === true && (node.metadata.generationMode || "image") === "image";
    if (node.type !== CanvasNodeType.Image && !isSmartImage) return null;
    const metadata = node.metadata;
    const images = metadata?.images || [];
    const primaryId = metadata?.primaryImageId || images[0]?.id;
    const primary = images.find((image) => image.id === primaryId);
    if (primary?.content || primary?.storageKey) return {
        content: primary.content,
        storageKey: primary.storageKey,
        naturalWidth: primary.naturalWidth,
        naturalHeight: primary.naturalHeight,
        bytes: primary.bytes,
        mimeType: primary.mimeType,
    };
    if (!metadata?.content && !metadata?.storageKey) return null;
    return {
        content: metadata.content || "",
        storageKey: metadata.storageKey,
        naturalWidth: metadata.naturalWidth || 0,
        naturalHeight: metadata.naturalHeight || 0,
        bytes: metadata.bytes || 0,
        mimeType: metadata.mimeType || "image/png",
    };
}

export function hasRenderableCanvasImage(node: CanvasNodeData) {
    return Boolean(canvasNodeImage(node) || node.metadata?.images?.some((image) => image.content || image.storageKey));
}
