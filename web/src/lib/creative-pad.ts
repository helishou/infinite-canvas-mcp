import type { AgentAttachment } from "@/stores/use-agent-store";
import type { Asset, AssetKind } from "@/stores/use-asset-store";

/**
 * 创作启动台 / 参考素材库的纯数据层。
 *
 * 这里不碰 React、不碰 store、不碰网络：所有筛选、分面计数、分页、多选上限与
 * 「素材 → Agent 附件」的映射都是可单测的纯函数，UI 两侧（首页启动台与参考库弹层）
 * 共用同一套判定，避免「左栏数字」和「点进去看到的条数」分叉。
 */

export const CREATIVE_MODES = ["canvas", "image", "video", "storyboard", "text", "audio"] as const;
export type CreativeMode = typeof CREATIVE_MODES[number];

export type CreativeCapability = "image" | "video" | "text" | "audio";

/**
 * 创作模式 → 实际调用的模型能力。
 * 画布与分镜不直接生成，但仍要能选模型（画布用图片模型、分镜用视频模型），
 * 否则首页只能看到「没有模型」，进去画布才发现用错了默认模型。
 */
export function creativeCapabilityForMode(mode: CreativeMode): CreativeCapability {
    if (mode === "video" || mode === "storyboard") return "video";
    if (mode === "text") return "text";
    if (mode === "audio") return "audio";
    return "image";
}

/** 模式是否当场提交生成；画布 / 分镜只建画布并把想法交给 Agent。 */
export function creativeModeGenerates(mode: CreativeMode): boolean {
    return mode === "image" || mode === "video" || mode === "text" || mode === "audio";
}

export type CreativeModelKey = "imageModel" | "videoModel" | "textModel" | "audioModel";

export function creativeModelKey(capability: CreativeCapability): CreativeModelKey {
    return capability === "video" ? "videoModel" : capability === "text" ? "textModel" : capability === "audio" ? "audioModel" : "imageModel";
}

/** 左栏「媒体类型」维度。character/scene/prop 带图片，归到 image。 */
export const REFERENCE_MEDIA_TYPES = ["all", "image", "video", "audio", "other"] as const;
export type ReferenceMediaType = typeof REFERENCE_MEDIA_TYPES[number];

/** 左栏「分类」维度，对齐影策的 全部素材 / 角色 / 场景 / 道具 / 素材 / 其他。 */
export const REFERENCE_CATEGORIES = ["all", "character", "scene", "prop", "image", "other"] as const;
export type ReferenceCategory = typeof REFERENCE_CATEGORIES[number];

export type ReferenceAsset = {
    id: string;
    title: string;
    kind: AssetKind;
    mediaType: Exclude<ReferenceMediaType, "all">;
    category: Exclude<ReferenceCategory, "all">;
    coverUrl: string;
    url: string;
    dataUrl: string;
    storageKey?: string;
    mimeType: string;
    width: number;
    height: number;
    bytes: number;
    tags: string[];
    searchText: string;
};

export type ReferenceFilters = {
    keyword: string;
    mediaType: ReferenceMediaType;
    category: ReferenceCategory;
};

export const DEFAULT_REFERENCE_FILTERS: ReferenceFilters = { keyword: "", mediaType: "all", category: "all" };

export function referenceMediaTypeOf(kind: AssetKind): Exclude<ReferenceMediaType, "all"> {
    if (kind === "image" || kind === "character" || kind === "scene" || kind === "prop") return "image";
    if (kind === "video") return "video";
    if (kind === "audio") return "audio";
    return "other";
}

export function referenceCategoryOf(kind: AssetKind): Exclude<ReferenceCategory, "all"> {
    if (kind === "character") return "character";
    if (kind === "scene") return "scene";
    if (kind === "prop") return "prop";
    if (kind === "image") return "image";
    return "other";
}

/** 共享资产源已失效的条目与现有 AssetPickerModal 保持一致：不出现在可选列表里。 */
export function toReferenceAsset(asset: Asset): ReferenceAsset | null {
    if (asset.metadata?.sharedAssetMissing === true) return null;
    const base = {
        id: asset.id,
        title: asset.title,
        kind: asset.kind,
        mediaType: referenceMediaTypeOf(asset.kind),
        category: referenceCategoryOf(asset.kind),
        tags: asset.tags || [],
    };
    let media: { coverUrl: string; url: string; dataUrl: string; storageKey?: string; mimeType: string; width: number; height: number; bytes: number };
    if (asset.kind === "image") {
        media = {
            coverUrl: asset.coverUrl || asset.data.dataUrl,
            url: asset.data.dataUrl,
            dataUrl: asset.data.dataUrl,
            storageKey: asset.data.storageKey,
            mimeType: asset.data.mimeType || "image/*",
            width: asset.data.width || 0,
            height: asset.data.height || 0,
            bytes: asset.data.bytes || 0,
        };
    } else if (asset.kind === "video") {
        media = {
            coverUrl: asset.coverUrl || "",
            url: asset.data.url,
            dataUrl: "",
            storageKey: asset.data.storageKey,
            mimeType: asset.data.mimeType || "video/*",
            width: asset.data.width || 0,
            height: asset.data.height || 0,
            bytes: asset.data.bytes || 0,
        };
    } else if (asset.kind === "audio") {
        media = {
            coverUrl: asset.coverUrl || "",
            url: asset.data.url,
            dataUrl: "",
            storageKey: asset.data.storageKey,
            mimeType: asset.data.mimeType || "audio/*",
            width: 0,
            height: 0,
            bytes: asset.data.bytes || 0,
        };
    } else if (asset.kind === "text") {
        media = { coverUrl: "", url: "", dataUrl: "", mimeType: "text/plain", width: 0, height: 0, bytes: 0 };
    } else if (asset.kind === "character") {
        const image = asset.data.images[asset.data.primaryIndex ?? 0] || asset.data.images[0];
        media = {
            coverUrl: asset.coverUrl || image?.url || "",
            url: image?.url || "",
            dataUrl: "",
            storageKey: image?.storageKey,
            mimeType: image?.mimeType || "image/*",
            width: image?.width || 0,
            height: image?.height || 0,
            bytes: image?.bytes || 0,
        };
    } else {
        const image = asset.data.image;
        media = {
            coverUrl: asset.coverUrl || image?.url || "",
            url: image?.url || "",
            dataUrl: "",
            storageKey: image?.storageKey,
            mimeType: image?.mimeType || "image/*",
            width: image?.width || 0,
            height: image?.height || 0,
            bytes: image?.bytes || 0,
        };
    }
    const searchText = [asset.title, asset.source || "", asset.note || "", ...(asset.tags || []), asset.kind].join(" ").toLowerCase();
    return { ...base, ...media, searchText };
}

export function buildReferenceAssets(assets: readonly Asset[]): ReferenceAsset[] {
    return assets.map(toReferenceAsset).filter((item): item is ReferenceAsset => item !== null);
}

export function matchesReferenceFilters(item: ReferenceAsset, filters: ReferenceFilters): boolean {
    if (filters.mediaType !== "all" && item.mediaType !== filters.mediaType) return false;
    if (filters.category !== "all" && item.category !== filters.category) return false;
    const query = filters.keyword.trim().toLowerCase();
    return !query || item.searchText.includes(query);
}

export function filterReferenceAssets(items: readonly ReferenceAsset[], filters: ReferenceFilters): ReferenceAsset[] {
    return items.filter(item => matchesReferenceFilters(item, filters));
}

export type ReferenceFacets = {
    mediaType: Record<ReferenceMediaType, number>;
    category: Record<ReferenceCategory, number>;
};

/**
 * 分面计数只忽略自己那一维：切换「图片」后，分类栏的数字仍反映当前媒体类型下的分布，
 * 而媒体类型栏的数字只受关键词/分类影响。与 assets/asset-facet-counts.ts 的约定一致。
 */
export function countReferenceFacets(items: readonly ReferenceAsset[], filters: ReferenceFilters): ReferenceFacets {
    const mediaType = Object.fromEntries(REFERENCE_MEDIA_TYPES.map(key => [key, 0])) as Record<ReferenceMediaType, number>;
    const category = Object.fromEntries(REFERENCE_CATEGORIES.map(key => [key, 0])) as Record<ReferenceCategory, number>;
    for (const item of items) {
        // 媒体类型分组（含「全部类型」）忽略 mediaType 自身，但仍受当前分类与关键词约束。
        if (matchesReferenceFilters(item, { ...filters, mediaType: "all" })) {
            mediaType.all += 1;
            mediaType[item.mediaType] += 1;
        }
        // 分类分组（含「全部素材」）忽略 category 自身，但仍受当前媒体类型与关键词约束。
        if (matchesReferenceFilters(item, { ...filters, category: "all" })) {
            category.all += 1;
            category[item.category] += 1;
        }
    }
    return { mediaType, category };
}

export type ReferencePage<T> = {
    items: T[];
    page: number;
    totalPages: number;
    total: number;
    from: number;
    to: number;
};

export function paginateReferences<T>(items: readonly T[], page: number, pageSize: number): ReferencePage<T> {
    const size = Math.max(1, Math.floor(pageSize));
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
    const start = (current - 1) * size;
    const slice = items.slice(start, start + size);
    return { items: slice, page: current, totalPages, total, from: total ? start + 1 : 0, to: start + slice.length };
}

/** max <= 0 表示不限；达到上限时再点其它项不会静默挤掉已选。 */
export function toggleReferenceSelection(selected: readonly string[], id: string, max: number): string[] {
    if (selected.includes(id)) return selected.filter(item => item !== id);
    if (max > 0 && selected.length >= max) return [...selected];
    return [...selected, id];
}

export function isSelectionFull(selected: readonly string[], id: string, max: number): boolean {
    return max > 0 && !selected.includes(id) && selected.length >= max;
}

/** 只有带真实图像地址的素材能作为 Agent 图片附件；音视频/纯文本只登记，不伪造附件。 */
export function toAgentAttachments(items: readonly ReferenceAsset[]): AgentAttachment[] {
    return items
        .filter(item => item.mediaType === "image" && Boolean(item.dataUrl || item.url || item.coverUrl))
        .map(item => ({
            id: item.id,
            name: item.title,
            type: item.mimeType || "image/*",
            size: item.bytes || 0,
            width: item.width || 0,
            height: item.height || 0,
            url: item.url || item.coverUrl || item.dataUrl,
            dataUrl: item.dataUrl || item.url || item.coverUrl,
        }));
}

export function referenceAttachmentSummary(items: readonly ReferenceAsset[]) {
    const attached = toAgentAttachments(items).length;
    return { attached, registeredOnly: items.length - attached };
}

/** 画布标题取想法开头，不改写用户原文；过长时截断。 */
export function creativeProjectTitle(text: string, maxLength = 24): string {
    const value = text.trim().replace(/\s+/g, " ");
    return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

export const CREATIVE_QUICK_ACTIONS = ["exampleOne", "exampleTwo", "fromReference", "blankCanvas"] as const;
export type CreativeQuickAction = typeof CREATIVE_QUICK_ACTIONS[number];
