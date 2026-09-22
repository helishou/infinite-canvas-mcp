import type { CanvasReferenceService } from "@infinite-canvas/plugin-sdk";
import type { H3Segment } from "../types";

/** 每个 Clip 的绑定独立记录已提交快照；同一素材的不同用途不能互相使缓存失效。 */
export async function syncReferenceCatalog(segments: H3Segment[], synced: Map<string, string>, upsert: CanvasReferenceService["upsert"], upsertMany?: CanvasReferenceService["upsertMany"]) {
    const pending = segments.flatMap((segment) => (segment.referenceBindings || []).flatMap((binding) => {
        const key = JSON.stringify([segment.id, binding.id]);
        const asset = { id: binding.assetId, label: binding.label, mediaType: binding.mediaType || "image" as const, role: binding.role, tags: binding.tags || [], url: binding.url, storageKey: binding.storageKey, mimeType: binding.mimeType, sourceNodeId: binding.sourceNodeId, subjectId: binding.subjectId };
        const signature = JSON.stringify(asset);
        if (synced.get(key) === signature) return [];
        synced.set(key, signature);
        return [{ key, signature, asset }];
    }));
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
