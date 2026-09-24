import { saveAs } from "file-saver";

import { createZip, readZip } from "@/lib/zip";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import type { Asset, AudioAsset, CharacterAsset, ImageAsset, VideoAsset, SceneAsset } from "@/stores/use-asset-store";

type AssetExportFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    assets: Asset[];
    files: AssetExportItem[];
};

type AssetExportItem = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

export async function exportAssets(assets: Asset[], filename: string) {
    const files: AssetExportItem[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const requestedKeys = new Set<string>();

    await Promise.all(
        assets.map(async (asset) => {
            if (asset.kind === "image") {
                if (!asset.data.storageKey) return;
                if (requestedKeys.has(asset.data.storageKey)) return;
                requestedKeys.add(asset.data.storageKey);
                const blob = await getImageBlob(asset.data.storageKey);
                if (!blob) return;
                const path = `files/${safeFileName(asset.data.storageKey)}.${fileExtension(blob.type, "image")}`;
                files.push({ storageKey: asset.data.storageKey, path, mimeType: blob.type || asset.data.mimeType, bytes: blob.size });
                zipFiles.push({ name: path, data: blob });
            } else if (asset.kind === "video" || asset.kind === "audio") {
                if (!asset.data.storageKey) return;
                if (requestedKeys.has(asset.data.storageKey)) return;
                requestedKeys.add(asset.data.storageKey);
                const blob = await getMediaBlob(asset.data.storageKey);
                if (!blob) return;
                const path = `files/${safeFileName(asset.data.storageKey)}.${fileExtension(blob.type, asset.kind)}`;
                files.push({ storageKey: asset.data.storageKey, path, mimeType: blob.type || asset.data.mimeType, bytes: blob.size });
                zipFiles.push({ name: path, data: blob });
            } else if (asset.kind === "character") {
                // 角色资产的每一张图都打包到 zip，并把 storageKey 一起导出，导入端按 storageKey 还原
                for (const image of asset.data.images) {
                    if (!image.storageKey) continue;
                    if (requestedKeys.has(image.storageKey)) continue;
                    requestedKeys.add(image.storageKey);
                    const blob = await getImageBlob(image.storageKey);
                    if (!blob) continue;
                    const path = `files/${safeFileName(image.storageKey)}.${fileExtension(blob.type, "image")}`;
                    files.push({ storageKey: image.storageKey, path, mimeType: blob.type || image.mimeType, bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }
                if (asset.data.voiceStorageKey && !requestedKeys.has(asset.data.voiceStorageKey)) {
                    requestedKeys.add(asset.data.voiceStorageKey);
                    const blob = await getMediaBlob(asset.data.voiceStorageKey);
                    if (blob) {
                        const path = `files/${safeFileName(asset.data.voiceStorageKey)}.${fileExtension(blob.type, "audio")}`;
                        files.push({ storageKey: asset.data.voiceStorageKey, path, mimeType: blob.type || "audio/*", bytes: blob.size });
                        zipFiles.push({ name: path, data: blob });
                    }
                }
            } else if (asset.kind === "scene") {
                for (const image of [asset.data.image, asset.data.colorCard].filter((item): item is NonNullable<SceneAsset["data"]["colorCard"]> => Boolean(item))) {
                    if (!image.storageKey || requestedKeys.has(image.storageKey)) continue;
                    requestedKeys.add(image.storageKey);
                    const blob = await getImageBlob(image.storageKey);
                    if (!blob) continue;
                    const path = `files/${safeFileName(image.storageKey)}.${fileExtension(blob.type, "image")}`;
                    files.push({ storageKey: image.storageKey, path, mimeType: blob.type || image.mimeType, bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }
            }
        }),
    );

    const data: AssetExportFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), assets, files };
    const zip = await createZip([{ name: "assets.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, filename);
}

export async function exportCharacterImages(asset: CharacterAsset, filename: string) {
    const files: { name: string; data: BlobPart }[] = [];
    for (const [index, image] of asset.data.images.entries()) {
        let blob = image.storageKey ? await getImageBlob(image.storageKey) : null;
        if (!blob && image.url) {
            try {
                const response = await fetch(image.url);
                if (response.ok) blob = await response.blob();
            } catch { /* 单张远程图片不可读时继续导出其余图片 */ }
        }
        if (!blob) continue;
        const label = safeFileName(image.outfit || image.name || `image-${index + 1}`) || `image-${index + 1}`;
        files.push({ name: `${String(index + 1).padStart(2, "0")}-${label}.${fileExtension(blob.type || image.mimeType, "image")}`, data: blob });
    }
    if (!files.length) throw new Error("character images unavailable");
    saveAs(await createZip(files), filename);
}

export async function readAssetPackage(file: File) {
    const zip = await readZip(file);
    const assetFile = zip.get("assets.json");
    if (!assetFile) throw new Error("missing assets.json");
    const data = JSON.parse(await assetFile.text()) as AssetExportFile;
    await Promise.all(
        data.files.map(async (item) => {
            const blob = zip.get(item.path);
            if (!blob) return;
            const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
            await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
        }),
    );
    return data.assets;
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, kind: Asset["kind"]) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mp3") || mimeType.includes("mpeg")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("m4a")) return "m4a";
    return kind === "image" ? "png" : "bin";
}
