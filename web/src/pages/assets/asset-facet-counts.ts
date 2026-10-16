import type { Asset, AssetKind } from "@/stores/use-asset-store";

/** 剧目筛选：不限 / 未归属 / 具体剧目 id。 */
export const ALL_DRAMAS = "__all-dramas__";
export const UNASSIGNED_DRAMA = "__unassigned-drama__";
/** 文件夹筛选：未归档（没有任何 folderId）。null 表示不限文件夹。 */
export const ROOT_FOLDER = "__root-folder__";
export const TAG_FOLDER_PREFIX = "tag:";

export type AssetLibraryFilters = {
    keyword: string;
    kind: AssetKind | "all";
    /** ALL_DRAMAS | UNASSIGNED_DRAMA | 剧目 id */
    dramaId: string;
    /** null | ROOT_FOLDER | tag:<名称> | 文件夹 id */
    folderId: string | null;
    /** 当前存在的剧目 id；归属到已删除剧目的资产按未归属处理。 */
    dramaIds: readonly string[];
};

export function isTagFolder(folderId: string | null) {
    return Boolean(folderId && folderId.startsWith(TAG_FOLDER_PREFIX));
}

export function assetSearchText(asset: Asset) {
    const extra = asset.kind === "text" ? asset.data.content
        : asset.kind === "character" ? `${asset.data.name} ${asset.data.description} ${asset.data.voiceName} ${asset.data.voiceDescription || ""} ${asset.data.images.length} images`
        : asset.kind === "scene" ? `${asset.data.name} ${asset.data.description} ${asset.data.colorCardPrompt}`
        : asset.kind === "prop" ? `${asset.data.name} ${asset.data.description}`
        : asset.data.mimeType;
    return [asset.title, asset.source || "", asset.note || "", asset.kind === "character" || asset.kind === "scene" || asset.kind === "prop" ? "" : (asset.tags || []).join(" "), extra].join(" ").toLowerCase();
}

export function matchesAssetDrama(asset: Asset, dramaId: string, dramaIds: readonly string[]) {
    if (dramaId === ALL_DRAMAS) return true;
    if (dramaId === UNASSIGNED_DRAMA) return !asset.dramaId || !dramaIds.includes(asset.dramaId);
    return dramaIds.includes(dramaId) && asset.dramaId === dramaId;
}

export function matchesAssetFolder(asset: Asset, folderId: string | null) {
    if (!folderId) return true;
    if (folderId === ROOT_FOLDER) return !asset.folderId;
    if (isTagFolder(folderId)) return asset.kind !== "character" && asset.kind !== "scene" && asset.kind !== "prop" && (asset.tags || []).includes(folderId.slice(TAG_FOLDER_PREFIX.length));
    return asset.folderId === folderId;
}

export function matchesAssetKindAndKeyword(asset: Asset, kind: AssetKind | "all", keyword: string) {
    if (kind !== "all" && asset.kind !== kind) return false;
    const query = keyword.trim().toLowerCase();
    return !query || assetSearchText(asset).includes(query);
}

/** 列表与侧栏共用同一套判定，避免「侧栏数字」与「点进去看到的条数」分叉。 */
export function filterAssets(assets: readonly Asset[], filters: AssetLibraryFilters) {
    return assets.filter((asset) => matchesAssetDrama(asset, filters.dramaId, filters.dramaIds)
        && matchesAssetFolder(asset, filters.folderId)
        && matchesAssetKindAndKeyword(asset, filters.kind, filters.keyword));
}

/** 剧目入口的计数：只忽略剧目维度，其余筛选与列表一致，保证点进去看到的条数就是这里的数字。 */
export function countByDrama(assets: readonly Asset[], filters: AssetLibraryFilters, dramaId: string) {
    return assets.filter((asset) => matchesAssetDrama(asset, dramaId, filters.dramaIds)
        && matchesAssetFolder(asset, filters.folderId)
        && matchesAssetKindAndKeyword(asset, filters.kind, filters.keyword)).length;
}

/** 文件夹入口的计数：只忽略文件夹维度，其余筛选与列表一致。 */
export function countByFolder(assets: readonly Asset[], filters: AssetLibraryFilters, folderId: string | null) {
    return assets.filter((asset) => matchesAssetDrama(asset, filters.dramaId, filters.dramaIds)
        && matchesAssetFolder(asset, folderId)
        && matchesAssetKindAndKeyword(asset, filters.kind, filters.keyword)).length;
}
