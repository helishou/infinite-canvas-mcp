import { nanoid } from "nanoid";

import { backendMediaUrl, fetchBackendAssets, upsertBackendAsset } from "@/services/backend-api";
import { uploadMediaFile } from "@/services/file-storage";

/**
 * 导演包里的参考图（`asset_groups/NN/PictureN.png`）在画布侧的落脚点。
 *
 * 画布还没有「一个 Clip 挂 N 张参考图」的原生字段（draft 的 shot 只有 visual/camera/duration，
 * 参考图要么走资产身份、要么走镜头关键帧，都需要先有画布节点）。所以这里把它落成**图片资产**：
 * 打上 `导演包` / `导演包:<episodeId>` / `导演包:<episodeId>:<段号>` 三个标签，
 * 资产库里能看见、能用，导出时也能按段号原样装回包里 —— 不做「假装已绑定参考图」。
 */

export const PACK_REF_TAG = "导演包";
export const packEpisodeTag = (episodeId: string) => `${PACK_REF_TAG}:${episodeId}`;
export const packGroupTag = (episodeId: string, groupIndex: number) => `${packEpisodeTag(episodeId)}:${groupIndex}`;

/** 从标签里取段号；不是本集的导演包资产返回 null。 */
export function packGroupOf(asset: Record<string, unknown>, episodeId: string): number | null {
    const tags = Array.isArray(asset.tags) ? (asset.tags as unknown[]).map(String) : [];
    const prefix = `${packGroupTag(episodeId, 0)}`.replace(/:0$/, ":");
    const hit = tags.find((tag) => tag.startsWith(prefix));
    if (!hit) return null;
    const index = Number(hit.slice(prefix.length));
    return Number.isFinite(index) && index > 0 ? index : null;
}

type PackRefImage = { name: string; bytes: Uint8Array };
export type PackRefs = Map<number, { images: PackRefImage[]; refs: Array<{ index: number; fileName: string; type: "input"; subfolder: string; imageFile: string }> }>;

/** 包里的图片 → 画布图片资产（一个段一组，标题带段号，标签带本集 ID）。 */
export async function importPackRefs(input: {
    episodeId: string;
    dramaId?: string;
    packName: string;
    groups: Array<{ index: number; images: Array<{ name: string; bytes: Uint8Array }> }>;
}): Promise<{ uploaded: number; failed: number }> {
    let uploaded = 0, failed = 0;
    for (const group of input.groups) {
        if (!group.images.length) continue;
        for (let i = 0; i < group.images.length; i += 1) {
            const image = group.images[i];
            try {
                const blob = new Blob([image.bytes as unknown as BlobPart], { type: "image/png" });
                const file = await uploadMediaFile(blob, `director-pack-${input.packName}-${group.index}-${i + 1}`, "library");
                await upsertBackendAsset({
                    id: `PACKREF_${nanoid()}`,
                    kind: "image",
                    title: `${input.packName} · 第 ${group.index} 段参考图 ${i + 1}`,
                    coverUrl: file.url,
                    tags: [PACK_REF_TAG, packEpisodeTag(input.episodeId), packGroupTag(input.episodeId, group.index)],
                    folderId: null,
                    dramaId: input.dramaId || null,
                    data: { dataUrl: file.url, storageKey: file.storageKey, mimeType: "image/png", bytes: file.bytes, width: file.width, height: file.height },
                    source: "导演包导入",
                    note: `${input.packName}/${image.name}`,
                });
                uploaded += 1;
            } catch {
                failed += 1;
            }
        }
    }
    return { uploaded, failed };
}

/** 导出前把本集导入过的参考图取回来（按段号分组，带真实字节）。 */
export async function collectPackRefs(input: { episodeId: string; dramaId?: string }): Promise<PackRefs> {
    const response = await fetchBackendAssets({ kind: "image", ...(input.dramaId ? { dramaId: input.dramaId } : {}) });
    const assets = (response.assets || []) as Array<Record<string, unknown>>;
    const buckets = new Map<number, Array<Record<string, unknown>>>();
    for (const asset of assets) {
        const group = packGroupOf(asset, input.episodeId);
        if (group === null) continue;
        const list = buckets.get(group) || [];
        list.push(asset);
        buckets.set(group, list);
    }
    const result: PackRefs = new Map();
    for (const [group, list] of buckets) {
        const sorted = [...list].sort((left, right) => String(left.title || "").localeCompare(String(right.title || ""), "zh-Hans-CN", { numeric: true }));
        const images: PackRefImage[] = [];
        for (const asset of sorted) {
            const data = (asset.data || {}) as Record<string, unknown>;
            const storageKey = String(data.storageKey || "");
            if (!storageKey) continue;
            try {
                const responseBytes = await fetch(backendMediaUrl(storageKey));
                if (!responseBytes.ok) continue;
                images.push({ name: `Picture${images.length + 1}.png`, bytes: new Uint8Array(await responseBytes.arrayBuffer()) });
            } catch {
                // 单张失败不影响其余；缺的图片不会进包，也不会写假的 refs。
            }
        }
        if (!images.length) continue;
        const subfolder = `asset_groups/${String(group).padStart(2, "0")}`;
        result.set(group, {
            images,
            refs: images.map((image, index) => ({ index, fileName: image.name, type: "input" as const, subfolder, imageFile: `${subfolder}/${image.name}` })),
        });
    }
    return result;
}
