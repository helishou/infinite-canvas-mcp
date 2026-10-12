import type { Asset } from "@/stores/use-asset-store";

type MediaEntry = { storageKey: string; path: string; mimeType: string; bytes: number };
/** Import allocates new identities. Never upsert media under a package's existing key. */
export async function importAssetMedia(
    assets: Asset[], files: MediaEntry[], blobs: Map<string, Blob>,
    createKey: (oldKey: string) => string,
    save: (key: string, blob: Blob, image: boolean) => Promise<string>,
): Promise<Asset[]> {
    const replacements = new Map<string, { key: string; url: string }>();
    const newKeys = new Set<string>();
    // Allocate and validate all identities before the first upload.
    for (const item of files) {
        const key = createKey(item.storageKey);
        if (!key || files.some(file => file.storageKey === key) || newKeys.has(key)) throw new Error("ASSET_IMPORT_KEY_COLLISION");
        if (!blobs.has(item.path)) throw new Error("ASSET_MEDIA_INCOMPLETE");
        newKeys.add(key); replacements.set(item.storageKey, { key, url: "" });
    }
    for (const item of files) {
        const blob = blobs.get(item.path)!;
        const replacement = replacements.get(item.storageKey)!;
        replacement.url = await save(replacement.key, blob.type ? blob : blob.slice(0, blob.size, item.mimeType), item.storageKey.startsWith("image:"));
    }
    const urls = new Map<string, string>();
    const collectUrls = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(collectUrls); return; }
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        const replacement = typeof record.storageKey === "string" ? replacements.get(record.storageKey) : undefined;
        if (replacement) for (const field of ["url", "dataUrl"]) if (typeof record[field] === "string" && record[field]) urls.set(record[field], replacement.url);
        Object.values(record).forEach(collectUrls);
    };
    assets.forEach(collectUrls);
    const remap = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(remap);
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(Object.entries(value).map(([key, item]) => {
            if ((key === "storageKey" || key === "voiceStorageKey") && typeof item === "string") return [key, replacements.get(item)?.key || item];
            if (["url", "dataUrl", "coverUrl"].includes(key) && typeof item === "string") return [key, urls.get(item) || item];
            return [key, remap(item)];
        }));
    };
    return assets.map(asset => {
        const result = remap(asset) as Asset;
        // Image covers can point at a URL absent from dataUrl in older packages.
        if (asset.kind === "image" && asset.data.storageKey && replacements.has(asset.data.storageKey)) result.coverUrl = replacements.get(asset.data.storageKey)!.url;
        return result;
    });
}
