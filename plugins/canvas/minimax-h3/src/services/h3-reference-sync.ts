import type { CanvasReferenceAsset, CanvasReferenceService } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";
import { inferH3ReferenceMediaType } from "./h3-data";

/** 每个 Clip 的绑定独立记录已提交快照；同一素材的不同用途不能互相使缓存失效。 */
type H3CatalogEntry = { key: string; signature: string; asset: Partial<CanvasReferenceAsset> & { label: string } };

function catalogEntries(segments: H3Segment[]): H3CatalogEntry[] {
    return segments.flatMap((segment) => (segment.referenceBindings || []).map((binding) => ({
        key: JSON.stringify([segment.id, binding.id]),
        signature: JSON.stringify({
            segmentId: segment.id,
            bindingId: binding.id,
            assetId: binding.assetId,
            label: binding.label,
            mediaType: inferH3ReferenceMediaType(binding),
            role: binding.role,
            tags: binding.tags || [],
            url: binding.url,
            storageKey: binding.storageKey,
            mimeType: binding.mimeType,
            sourceNodeId: binding.sourceNodeId,
            subjectId: binding.subjectId,
        }),
        asset: { id: binding.assetId, label: binding.label, mediaType: inferH3ReferenceMediaType(binding), role: binding.role, tags: binding.tags || [], url: binding.url, storageKey: binding.storageKey, mimeType: binding.mimeType, sourceNodeId: binding.sourceNodeId, subjectId: binding.subjectId },
    })));
}

/** 按当前遍历顺序编码所有缓存身份和实际提交字段；排除 enabled 等 UI/绑定开关状态。 */
export function referenceCatalogSignature(segments: H3Segment[]): string {
    return JSON.stringify(catalogEntries(segments).map(({ key, signature }) => [key, signature]));
}

export async function syncReferenceCatalog(segments: H3Segment[], synced: Map<string, string>, upsert: CanvasReferenceService["upsert"], upsertMany?: CanvasReferenceService["upsertMany"]) {
    const pending = catalogEntries(segments).filter(({ key, signature }) => {
        if (synced.get(key) === signature) return false;
        synced.set(key, signature);
        return true;
    });
    if (!pending.length) return;
    try {
        if (upsertMany) await upsertMany(pending.map(({ asset }) => asset));
        else await Promise.all(pending.map(async ({ key, signature, asset }) => {
            try { await upsert(asset); }
            catch { if (synced.get(key) === signature) synced.delete(key); }
        }));
    } catch {
        for (const { key, signature } of pending) if (synced.get(key) === signature) synced.delete(key);
    }
}
