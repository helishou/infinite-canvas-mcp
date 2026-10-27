import type { CanvasNodeData } from "@/types/canvas";

export function propNodeAssetImage(node: CanvasNodeData) {
    if (node.type !== "prop") return undefined;
    const image = node.metadata?.propImage;
    return image?.url || image?.storageKey ? image : undefined;
}
