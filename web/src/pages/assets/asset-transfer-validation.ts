/** An archive advertised as a backup must contain every referenced local media file. */
export function requireAssetBlob(blob: Blob | null | undefined): Blob {
    if (!blob) throw new Error("ASSET_MEDIA_INCOMPLETE");
    return blob;
}

export function validateAssetPackage(data: unknown, files: Map<string, Blob>): asserts data is { app: string; version: number; assets: unknown[]; files: { storageKey: string; path: string; mimeType: string; bytes: number }[] } {
    if (!data || typeof data !== "object") throw new Error("ASSET_PACKAGE_INVALID");
    const value = data as Record<string, unknown>;
    if (value.app !== "infinite-canvas" || value.version !== 1 || !Array.isArray(value.assets) || !Array.isArray(value.files)) throw new Error("ASSET_PACKAGE_INVALID");
    const keys = new Set<string>(), paths = new Set<string>();
    for (const entry of value.files) {
        if (!entry || typeof entry !== "object" || typeof entry.storageKey !== "string" || !entry.storageKey || typeof entry.path !== "string" || !/^files\/[^/\\]+$/.test(entry.path) || typeof entry.mimeType !== "string" || typeof entry.bytes !== "number" || !Number.isFinite(entry.bytes) || entry.bytes < 0 || keys.has(entry.storageKey) || paths.has(entry.path)) throw new Error("ASSET_PACKAGE_INVALID");
        keys.add(entry.storageKey); paths.add(entry.path);
        if (!files.has(entry.path) || files.get(entry.path)!.size !== entry.bytes) throw new Error("ASSET_MEDIA_INCOMPLETE");
    }
    const assetIds = new Set<string>();
    for (const asset of value.assets) {
        if (!asset || typeof asset !== "object" || typeof asset.id !== "string" || !["text", "image", "video", "audio", "character", "scene"].includes(asset.kind) || !asset.data || typeof asset.data !== "object") throw new Error("ASSET_PACKAGE_INVALID");
        if (!asset.id || assetIds.has(asset.id)) throw new Error("ASSET_PACKAGE_INVALID");
        assetIds.add(asset.id);
        if (asset.kind === "character" && !Array.isArray(asset.data.images)) throw new Error("ASSET_PACKAGE_INVALID");
        if (asset.kind === "scene" && !asset.data.image) throw new Error("ASSET_PACKAGE_INVALID");
        const refs = asset.kind === "character" ? [...asset.data.images, { storageKey: asset.data.voiceStorageKey }] : asset.kind === "scene" ? [asset.data.image, asset.data.colorCard] : asset.kind === "text" ? [] : [asset.data];
        for (const ref of refs) if (ref?.storageKey && !keys.has(ref.storageKey)) throw new Error("ASSET_MEDIA_INCOMPLETE");
    }
}

/** Do not download an HTTP error document under an image filename. */
export async function readAssetRemoteBlob(url: string): Promise<Blob> {
    const response = await fetch(url);
    if (!response.ok) throw new Error("ASSET_MEDIA_INCOMPLETE");
    return response.blob();
}
