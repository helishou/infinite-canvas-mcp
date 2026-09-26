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

/**
 * 失败/取消槽位自动从 `images[]` 历史中清出；若主图指针指向被移除的槽，
 * 回退到剩余槽位中第一个带 content/storageKey 的成功图，没有则置 null，
 * 同步修正顶层 content/storageKey/mimeType/bytes/naturalWidth/naturalHeight。
 */
export function dropImageSlots(project: CanvasProject, nodeId: string, ids: string[]) {
    if (!ids.length) return {};
    const node = (project.nodes as Array<Record<string, any>>).find((node) => node.id === nodeId);
    if (!node) return {};
    const metadata = (node.metadata && typeof node.metadata === "object" && !Array.isArray(node.metadata)
        ? node.metadata as Record<string, unknown>
        : {});
    const images: Array<Record<string, unknown>> = Array.isArray(metadata.images) ? metadata.images : [];
    const idSet = new Set(ids.map(String));
    const kept = images.filter((image) => !idSet.has(String(image.id || "")));
    if (kept.length === images.length) return {};
    const patch: Record<string, unknown> = { images: kept };
    const primaryId = metadata.primaryImageId ? String(metadata.primaryImageId) : "";
    if (primaryId && idSet.has(primaryId)) {
        const fallback = kept.find((image) => Boolean(image.content || image.storageKey));
        if (fallback) {
            patch.primaryImageId = fallback.id;
            patch.content = fallback.content;
            patch.storageKey = fallback.storageKey;
            patch.mimeType = fallback.mimeType;
            patch.bytes = fallback.bytes;
            patch.naturalWidth = fallback.naturalWidth;
            patch.naturalHeight = fallback.naturalHeight;
        } else {
            patch.primaryImageId = null;
            patch.content = null;
            patch.storageKey = null;
            patch.mimeType = null;
            patch.bytes = null;
            patch.naturalWidth = null;
            patch.naturalHeight = null;
        }
    }
    const activeId = metadata.activeImageHistoryId ? String(metadata.activeImageHistoryId) : "";
    if (activeId && idSet.has(activeId)) {
        patch.activeImageHistoryId = null;
        patch.activeImageHistoryExplicit = false;
    }
    return patch;
}

export function completedImageSlots(metadata: Record<string, any>, ids: string[], media: Array<Record<string, unknown>>) {
    const completedIds = new Set<string>();
    const keptImages: Array<Record<string, unknown>> = [];
    const oldImages: Array<Record<string, unknown>> = Array.isArray(metadata.images) ? metadata.images : [];
    for (const image of oldImages) {
        const index = ids.indexOf(String(image.id));
        if (index < 0) {
            keptImages.push(image);
            continue;
        }
        const output = media.some((item) => item.imageId) ? media.find((item) => item.imageId === image.id) : media[index];
        if (!output?.url) {
            // 槽位失败直接清出，不在历史里留下占位卡片。
            continue;
        }
        completedIds.add(String(image.id));
        keptImages.push({ ...image, status: "success", errorDetails: undefined, content: output.url,
            storageKey: output.storageKey, naturalWidth: output.width, naturalHeight: output.height,
            bytes: output.bytes, mimeType: output.mimeType || "image/png" });
    }
    // 批量结果保持折叠；单张自动展示。运行中选择了另一张主图时不抢回选择。
    const primaryId = metadata.primaryImageId || (keptImages.length === 1 ? keptImages[0].id : undefined);
    const primary = keptImages.find((image) => String(image.id) === String(primaryId) && completedIds.has(String(image.id)));
    const patch: Record<string, unknown> = { images: keptImages };
    if (primary) {
        patch.primaryImageId = primary.id;
        patch.content = primary.content;
        patch.storageKey = primary.storageKey;
        patch.naturalWidth = primary.naturalWidth;
        patch.naturalHeight = primary.naturalHeight;
        patch.bytes = primary.bytes;
        patch.mimeType = primary.mimeType;
    }
    return patch;
}
