import type { CanvasNodeData } from "@/types/canvas";

export function hasRenderableCanvasImage(node: CanvasNodeData) {
    const metadata = node.metadata;
    return Boolean(
        metadata?.content
        || metadata?.storageKey
        || metadata?.images?.some((image) => image.content || image.storageKey),
    );
}
