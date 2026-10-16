import { selectSmartImageResult } from "@basketikun/canvas-agent/reference-contract";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeImage } from "@/types/canvas";

/**
 * 智能图片节点被引用的那张图必须是一个「引用」而不是快照：缺省跟随最新成功归档结果，
 * 用户在历史里显式钉选某张时锁定那张（`smartImageReferenceSelection`），失效选择回落最新。
 * 解析交给共享的 `selectSmartImageResult`，保证预览和真正提交的字节是同一张。
 * 字段缺失（只有顶层 content/storageKey 的旧画布）继续走顶层兜底。
 */
function resolveSmartImageReference(metadata: CanvasNodeData["metadata"]) {
    // 失效/非法的钉选不能让引用方拿到空图：回落到最新成功归档结果，与 Backend 解析一致。
    let resolved = selectSmartImageResult(metadata, { mode: "node_selection" });
    if (resolved.error) resolved = selectSmartImageResult(metadata, { mode: "latest_success" });
    if (resolved.error) return null;
    const image = resolved.image as CanvasNodeImage | undefined;
    if (!image || (!image.content && !image.storageKey)) return null;
    return {
        content: image.content || "",
        storageKey: image.storageKey,
        naturalWidth: image.naturalWidth || 0,
        naturalHeight: image.naturalHeight || 0,
        bytes: image.bytes || 0,
        mimeType: image.mimeType || metadata?.mimeType || "image/png",
    };
}

/** The image shown by an image node or an image-mode smart node. */
export function canvasNodeImage(node: CanvasNodeData) {
    const isSmartImage = node.type === CanvasNodeType.Config && node.metadata?.smart === true && (node.metadata.generationMode || "image") === "image";
    if (node.type !== CanvasNodeType.Image && !isSmartImage) return null;
    const metadata = node.metadata;
    // 有归档结果集合时（智能节点，或带 images[] 的图片节点）：由引用选择策略解析当前
    // 真正被引用的那张结果，缺省跟随最新成功归档结果，而不是停在 primaryImageId 快照。
    if (node.metadata?.images?.length) {
        const resolved = resolveSmartImageReference(metadata);
        if (resolved) return resolved;
    }
    // 没有归档历史，或归档集合里没有可引用结果：回落到顶层字段（旧画布 / 结果写在顶层）。
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

/** The image node's visible primary result, for actions that save the image currently shown to the user. */
export function canvasNodePrimaryImage(node: CanvasNodeData) {
    const metadata = node.metadata;
    const isSmartImage = node.type === CanvasNodeType.Config && metadata?.smart === true && (metadata.generationMode || "image") === "image";
    if (isSmartImage && metadata.images?.length) {
        // Match ImageContent exactly: a missing or stale primaryImageId displays images[0].
        const primary = metadata.images.find(image => image.id === metadata.primaryImageId) || metadata.images[0];
        if (primary && (primary.status === "success" || primary.status === undefined) && (primary.content || primary.storageKey)) {
            return {
                content: primary.content || "",
                storageKey: primary.storageKey,
                naturalWidth: primary.naturalWidth || 0,
                naturalHeight: primary.naturalHeight || 0,
                bytes: primary.bytes || 0,
                mimeType: primary.mimeType || metadata.mimeType || "image/png",
            };
        }
        return null;
    }
    return canvasNodeImage(node);
}

export function hasRenderableCanvasImage(node: CanvasNodeData) {
    return Boolean(canvasNodeImage(node) || node.metadata?.images?.some((image) => image.content || image.storageKey));
}
