import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { canvasNodeImage } from "./canvas-image-renderability";

export function convertImageNodeToProp(node: CanvasNodeData): CanvasNodeData | null {
    const convertible = node.type === CanvasNodeType.Image
        || (node.type === CanvasNodeType.Config && node.metadata?.smart === true && (node.metadata.generationMode || "image") === "image");
    if (!convertible) return null;
    const sourceImage = canvasNodeImage(node);
    if (!sourceImage) return null;

    const metadata = { ...(node.metadata || {}) };
    delete metadata.smart;
    delete metadata.generationMode;
    delete metadata.images;
    delete metadata.primaryImageId;
    delete metadata.activeImageHistoryId;
    delete metadata.activeImageHistoryExplicit;
    delete metadata.generationResultsByMode;

    const title = String(node.title || "").trim();
    return {
        ...node,
        type: CanvasNodeType.Prop,
        title: title || "道具",
        metadata: {
            ...metadata,
            status: "success",
            propName: title || "道具",
            propDescription: typeof node.metadata?.prompt === "string" ? node.metadata.prompt : "",
            propImage: {
                url: sourceImage.content || "",
                storageKey: sourceImage.storageKey,
                name: title || "道具",
                width: sourceImage.naturalWidth || node.width,
                height: sourceImage.naturalHeight || node.height,
                bytes: sourceImage.bytes || 0,
                mimeType: sourceImage.mimeType || "image/png",
            },
        },
    };
}
