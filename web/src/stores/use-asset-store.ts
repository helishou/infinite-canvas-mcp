import { create } from "zustand";

import { nanoid } from "nanoid";
import { cleanupUnusedImages } from "@/services/image-storage";
import { cleanupUnusedMedia } from "@/services/file-storage";
import { deleteBackendAsset, deleteBackendAssetFolder, fetchBackendAssets, upsertBackendAsset, upsertBackendAssetFolder } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";

export type AssetKind = "text" | "image" | "video" | "audio" | "character";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type AudioAsset = AssetBase<"audio"> & {
    data: { url: string; storageKey?: string; bytes: number; mimeType: string; durationMs?: number };
};
/** 角色资产的一张参考图：参考源项目（Infinite-Canvas）的字段，含 outfit/outfitDescription/assetId。 */
export type CharacterImage = {
    url: string;
    storageKey?: string;
    name: string;
    assetId?: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
    outfit: string;
    outfitDescription: string;
};
export type CharacterAsset = AssetBase<"character"> & {
    data: {
        name: string;
        englishName: string;
        description: string;
        voice: string;
        voiceName: string;
        voiceAssetId: string;
        images: CharacterImage[];
    };
};
export type Asset = TextAsset | ImageAsset | VideoAsset | AudioAsset | CharacterAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    folderId?: string | null;
    dramaId?: string | null;
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

export type AssetFolder = { id: string; name: string; parentId: string | null; createdAt: string };

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    folders: AssetFolder[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt"> & { id?: string }) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    removeAssets: (ids: string[]) => void;
    replaceAssets: (assets: Asset[]) => void;
    addFolder: (name: string, parentId?: string | null) => string;
    renameFolder: (id: string, name: string) => void;
    removeFolder: (id: string) => void;
    cleanupImages: (extra?: unknown) => void;
};

/** 同步素材到总后台。 */
let knownAssetIds = new Set<string>();
let knownFolderIds = new Set<string>();

async function syncAssetsToBackend(assets: Asset[], folders: AssetFolder[]) {
    if (!useBackendStore.getState().connected) return;
    try {
        const assetIds = new Set(assets.map((asset) => asset.id));
        const folderIds = new Set(folders.map((folder) => folder.id));
        await Promise.all([
            ...assets.map((asset) => upsertBackendAsset(asset as unknown as Record<string, unknown>)),
            ...folders.map((folder) => upsertBackendAssetFolder(folder as unknown as Record<string, unknown>)),
            ...[...knownAssetIds].filter((id) => !assetIds.has(id)).map((id) => deleteBackendAsset(id)),
            ...[...knownFolderIds].filter((id) => !folderIds.has(id)).map((id) => deleteBackendAssetFolder(id)),
        ]);
        knownAssetIds = assetIds;
        knownFolderIds = folderIds;
    } catch { /* Backend 是唯一写入目标，失败由下一次同步重试 */ }
}

// ---------------------------------------------------------------------------
// 旧 composite 资产 → character 的一次性迁移
// ---------------------------------------------------------------------------
// 旧 schema：{ kind: "composite", data: { items: CompositeItem[] } }
//   CompositeItem 可能是 text / image / video / audio / assetRef。
// 迁移规则（与用户确认的方案）：
//   - text items  → 拼接进 description
//   - image items → character.images[]（outfit/outfitDescription/assetId 留空）
//   - video/audio items → 丢弃，但写入 metadata.legacyItems 备查
//   - assetRef items → 若指向 image，则解析为 character image；其余按其 kind 决定
//   旧 schema 的 kind 字段会被抹除，导出/导入也由本函数清洗。
// ---------------------------------------------------------------------------

type LegacyCompositeItem =
    | { itemType: "text"; content: string }
    | { itemType: "image"; url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string }
    | { itemType: "video"; url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string }
    | { itemType: "audio"; url: string; storageKey?: string; bytes: number; mimeType: string; durationMs?: number }
    | { itemType: "assetRef"; refId: string; refKind: "text" | "image" | "video" | "audio" | "composite" };

type LegacyCompositeAsset = {
    id: string;
    kind: "composite";
    title: string;
    coverUrl: string;
    tags: string[];
    folderId?: string | null;
    dramaId?: string | null;
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
    data: { items: LegacyCompositeItem[] };
};

function isLegacyComposite(asset: unknown): asset is LegacyCompositeAsset {
    if (!asset || typeof asset !== "object") return false;
    const record = asset as Record<string, unknown>;
    if (record.kind !== "composite") return false;
    const data = record.data as { items?: unknown } | undefined;
    return Boolean(data && Array.isArray(data.items));
}

/** 把单个旧 CompositeItem 解析为 character image 或 legacy 记录项。 */
function resolveLegacyItem(item: LegacyCompositeItem, allAssets: Asset[]): { image?: CharacterImage; legacy?: Record<string, unknown> } {
    if (item.itemType === "image") {
        return {
            image: {
                url: item.url,
                storageKey: item.storageKey,
                name: item.url.split("/").pop() || "image",
                width: item.width || 0,
                height: item.height || 0,
                bytes: item.bytes || 0,
                mimeType: item.mimeType || "image/*",
                outfit: "",
                outfitDescription: "",
            },
        };
    }
    if (item.itemType === "text") {
        return { legacy: { itemType: "text", content: item.content } };
    }
    if (item.itemType === "video" || item.itemType === "audio") {
        return { legacy: { ...item } };
    }
    // assetRef：尝试在当前资产里找到引用
    const ref = allAssets.find((candidate) => candidate.id === item.refId);
    if (!ref) return { legacy: { ...item, missing: true } };
    if (ref.kind === "image") {
        return {
            image: {
                url: ref.data.dataUrl,
                storageKey: ref.data.storageKey,
                name: ref.title || ref.data.dataUrl.split("/").pop() || "image",
                assetId: ref.id,
                width: ref.data.width,
                height: ref.data.height,
                bytes: ref.data.bytes,
                mimeType: ref.data.mimeType,
                outfit: "",
                outfitDescription: "",
            },
        };
    }
    if (ref.kind === "text") {
        return { legacy: { itemType: "text", content: ref.data.content, sourceAssetId: ref.id } };
    }
    return { legacy: { ...item, refKind: ref.kind, sourceAssetId: ref.id } };
}

/** 把 legacy composite 资产转换为 character 资产；调用方负责写回 store。 */
export function migrateCompositeToCharacter(asset: LegacyCompositeAsset, allAssets: Asset[]): CharacterAsset {
    const images: CharacterImage[] = [];
    const descriptionParts: string[] = [];
    const legacyItems: Array<Record<string, unknown>> = [];
    for (const item of asset.data.items) {
        const resolved = resolveLegacyItem(item, allAssets);
        if (resolved.image) images.push(resolved.image);
        if (resolved.legacy) legacyItems.push(resolved.legacy);
        if (item.itemType === "text" && item.content?.trim()) descriptionParts.push(item.content.trim());
    }
    const description = descriptionParts.join("\n\n");
    const coverUrl = images[0]?.url || asset.coverUrl || "";
    return {
        id: asset.id,
        kind: "character",
        title: asset.title,
        coverUrl,
        tags: asset.tags || [],
        folderId: asset.folderId ?? null,
        dramaId: asset.dramaId ?? null,
        source: asset.source,
        note: asset.note,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
        metadata: {
            ...(asset.metadata || {}),
            // 把无法放入新 schema 的旧 items 保留在 metadata，便于将来追溯或回退
            ...(legacyItems.length ? { legacyItems } : {}),
            migratedFrom: "composite",
        },
        data: {
            name: asset.title,
            englishName: "",
            description,
            voice: "",
            voiceName: "",
            voiceAssetId: "",
            images,
        },
    };
}

/** 对一批资产做迁移；返回新数组（已过滤掉 composite）。 */
function migrateAssetsInPlace(assets: Asset[]): Asset[] {
    const result: Asset[] = [];
    for (const asset of assets) {
        if (isLegacyComposite(asset)) {
            // 旧 composite 资产：转换为 character
            result.push(migrateCompositeToCharacter(asset, assets));
        } else if (asset && (asset as { kind?: string }).kind === "composite") {
            // 兜底：任何无法识别的 composite 都丢弃
            continue;
        } else {
            result.push(asset);
        }
    }
    return result;
}

async function hydrateAssetsFromBackend() {
    if (!useBackendStore.getState().connected) return false;
    try {
        const response = await fetchBackendAssets();
        const remoteAssets = Array.isArray(response.assets) ? response.assets as unknown as Asset[] : [];
        const remoteFolders = Array.isArray(response.folders) ? response.folders as unknown as AssetFolder[] : [];
        // 任何来自后端的 composite 资产都要先做迁移，确保前端 store 不会有 composite
        const migrated = migrateAssetsInPlace(remoteAssets);
        knownAssetIds = new Set(migrated.map((asset) => asset.id));
        knownFolderIds = new Set(remoteFolders.map((folder) => folder.id));
        useAssetStore.setState({ assets: migrated, folders: remoteFolders });
        // 如果发生了迁移，立即把清洗结果写回后端，避免老数据反复出现
        if (migrated.length !== remoteAssets.length || remoteAssets.some((a) => (a as { kind?: string }).kind === "composite")) {
            void syncAssetsToBackend(migrated, remoteFolders);
        }
        return true;
    } catch {
        return false;
    }
}

export async function hydrateAssets() {
    await hydrateAssetsFromBackend();
    useAssetStore.setState({ hydrated: true });
}

export const useAssetStore = create<AssetStore>()((set, get) => ({
            hydrated: false,
            assets: [],
            folders: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = asset.id || nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                scheduleAssetSync();
                return id;
            },
            updateAsset: (id, patch) => {
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                }));
                scheduleAssetSync();
            },
            removeAsset: (id) => {
                set((state) => {
                    const assets = state.assets.filter((asset) => asset.id !== id);
                    get().cleanupImages({ assets });
                    return { assets };
                });
                scheduleAssetSync();
            },
            removeAssets: (ids) => {
                set((state) => {
                    const idSet = new Set(ids);
                    const assets = state.assets.filter((asset) => !idSet.has(asset.id));
                    get().cleanupImages({ assets });
                    return { assets };
                });
                scheduleAssetSync();
            },
            replaceAssets: (assets) => {
                // 写入前先迁移：调用方如果传了 composite（如来自导入包或回放），由 store 兜底转换为 character
                const migrated = migrateAssetsInPlace(assets);
                set({ assets: migrated });
                scheduleAssetSync();
            },
            addFolder: (name, parentId = null) => {
                const id = nanoid();
                set((state) => ({ folders: [...state.folders, { id, name: name.trim() || "新文件夹", parentId, createdAt: new Date().toISOString() }] }));
                scheduleAssetSync();
                return id;
            },
            renameFolder: (id, name) => {
                set((state) => ({ folders: state.folders.map((folder) => (folder.id === id ? { ...folder, name: name.trim() || folder.name } : folder)) }));
                scheduleAssetSync();
            },
            removeFolder: (id) => {
                set((state) => {
                    const folders = state.folders.filter(folder => folder.id !== id && folder.parentId !== id);
                    const remaining = new Set(folders.map(folder => folder.id));
                    const assets = state.assets.map((asset) => (asset.folderId && asset.folderId !== id && remaining.has(asset.folderId) ? asset : { ...asset, folderId: null }));
                    return { folders, assets };
                });
                scheduleAssetSync();
            },
            cleanupImages: (extra) => {
                window.setTimeout(async () => {
                    const { loadAllCanvasProjects } = await import("@/stores/canvas/use-canvas-store");
                    const projects = await loadAllCanvasProjects();
                    await cleanupUnusedImages({ assets: get().assets, projects, extra });
                    await cleanupUnusedMedia({ assets: get().assets, projects, extra });
                }, 0);
            },
        }));

let assetSaveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAssetSync() {
    if (assetSaveTimer) clearTimeout(assetSaveTimer);
    assetSaveTimer = setTimeout(() => {
        assetSaveTimer = null;
        const state = useAssetStore.getState();
        void syncAssetsToBackend(state.assets, state.folders);
    }, 400);
}

if (typeof window !== "undefined") {
    window.addEventListener("backend-connected", () => {
        void hydrateAssets();
    });
    window.addEventListener("backend-event", (event) => {
        const detail = (event as CustomEvent<{ type?: string; entityId?: string; payload?: { deleted?: number } }>).detail;
        if (detail?.type !== "canvas-folder.updated" || !detail.entityId || !detail.payload?.deleted) return;
        useAssetStore.setState((state) => ({
            assets: state.assets.map((asset) => asset.dramaId === detail.entityId ? { ...asset, dramaId: null } : asset),
        }));
    });
}

export { syncAssetsToBackend, migrateAssetsInPlace, isLegacyComposite };
