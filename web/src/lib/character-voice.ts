import type { AudioAsset } from "@/stores/use-asset-store";

/** 旧角色数据在声线文件仍存在时留下的占位名称。 */
const LEGACY_ARCHIVED_VOICE_NAME = "已归档角色声线";

export function findCharacterVoiceAsset(
    assets: AudioAsset[],
    fields: { assetId?: string; storageKey?: string; url?: string },
) {
    return assets.find((asset) =>
        (fields.assetId && asset.id === fields.assetId)
        || (fields.storageKey && asset.data.storageKey === fields.storageKey)
        || (fields.url && asset.data.url && asset.data.url === fields.url),
    );
}

export function resolveCharacterVoiceName(name: string | undefined, asset?: AudioAsset) {
    const value = name?.trim() || "";
    return value && value !== LEGACY_ARCHIVED_VOICE_NAME ? value : asset?.title || "";
}

export function hasCharacterVoiceSource(fields: { url?: string; storageKey?: string; assetId?: string }) {
    return Boolean(fields.url || fields.storageKey || fields.assetId);
}
