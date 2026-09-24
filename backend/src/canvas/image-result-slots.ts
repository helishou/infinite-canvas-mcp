import type { CanvasProject } from "../db.js";
import type { CanvasOperation } from "./project-ops.js";

export function imageSourceStatus(project: CanvasProject, nodeId: string, sourceNodeId: string | undefined, taskId: string, status: string, binding = false): CanvasOperation[] {
    if (!sourceNodeId || sourceNodeId === nodeId) return [];
    const source = (project.nodes as Array<Record<string, any>>).find((node) => node.id === sourceNodeId);
    if (source?.type !== "config" || (!binding && source.metadata?.runtimeTaskId !== taskId)) return [];
    return [{ type: "update_node", id: sourceNodeId, metadata: { status, ...(binding ? { runtimeTaskId: taskId } : {}) },
        metadataDelete: binding ? ["errorDetails"] : ["runtimeTaskId", "errorDetails"] }];
}

/** 仅修改本次绑定的现有槽位；远端删除的槽位不能被迟到结果重建。 */
export function imageSlotStatus(project: CanvasProject, nodeId: string, ids: string[] | undefined, status: string, errorDetails?: string) {
    if (!ids) return {};
    const node = (project.nodes as Array<Record<string, any>>).find((node) => node.id === nodeId);
    return { images: (node?.metadata?.images || []).map((image: Record<string, unknown>) => ids.includes(String(image.id))
        ? { ...image, status, errorDetails } : image) };
}

export function completedImageSlots(metadata: Record<string, any>, ids: string[], media: Array<Record<string, unknown>>) {
    const images = (metadata.images || []).map((image: Record<string, any>) => {
        const index = ids.indexOf(String(image.id));
        if (index < 0) return image;
        const output = media.some((item) => item.imageId) ? media.find((item) => item.imageId === image.id) : media[index];
        if (!output?.url) return { ...image, status: "error", errorDetails: "模型未返回该槽位的图片" };
        return { ...image, status: "success", errorDetails: undefined, content: output.url,
            storageKey: output.storageKey, naturalWidth: output.width, naturalHeight: output.height,
            bytes: output.bytes, mimeType: output.mimeType || "image/png" };
    });
    // 批量结果保持折叠；单张自动展示。运行中选择了另一张主图时不抢回选择。
    const primaryId = metadata.primaryImageId || (images.length === 1 ? images[0].id : undefined);
    const primary = images.find((image: Record<string, any>) => image.id === primaryId && ids.includes(image.id) && image.status === "success");
    return { images, ...(primary ? { primaryImageId: primary.id, content: primary.content, storageKey: primary.storageKey,
        naturalWidth: primary.naturalWidth, naturalHeight: primary.naturalHeight, bytes: primary.bytes, mimeType: primary.mimeType } : {}) };
}
