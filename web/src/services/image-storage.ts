import localforage from "localforage";
import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { createImageThumbnail } from "@/lib/image-thumbnail";
import { uploadBackendMedia, deleteBackendMedia, backendMediaUrl, resolveComfyMediaUrl } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";
import { withLocalProxy } from "@/stores/use-config-store";

export type UploadedImage = {
    url: string;
    storageKey?: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const IMAGE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_REMOTE_LOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_DECODE_TIMEOUT_MS = 10_000;
const IMAGE_RESPONSE_ERROR = "ImageResponseError";
const IMAGE_TIMEOUT_ERROR = "ImageTimeoutError";
const IMAGE_PREVIEW_VERSION = 1;
const previewStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_previews" });
const previewUrls = new Map<string, string>();
const previewListeners = new Set<() => void>();
const previewListenersByKey = new Map<string, Set<() => void>>();
const previewRevisionsByKey = new Map<string, number>();
const previewJobs = new Set<string>();
let previewRevision = 0;
let previewQueue: Promise<unknown> = Promise.resolve();

type ImageReadOptions = { signal?: AbortSignal; category?: "input" | "output" | "library" };
type StoredImagePreview = { version: number; blob?: Blob };

// 预览是浏览器本地的可丢弃缓存；同一个 storageKey 在不同 Backend 中不能共用。
function previewCacheKey(storageKey: string) {
    return `${useBackendStore.getState().url || "local"}\u0000${storageKey}`;
}

export async function uploadImage(input: string | Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    if (typeof input !== "string") return storeImage(input, options);

    let blob: Blob;
    try {
        blob = await fetchImageBlob(input, options);
    } catch (error) {
        if (options?.signal?.aborted || isNamedError(error, IMAGE_RESPONSE_ERROR) || isNamedError(error, IMAGE_TIMEOUT_ERROR) || !/^https?:\/\//i.test(input)) throw error;
        const meta = await loadImageMeta(input, options, IMAGE_REMOTE_LOAD_TIMEOUT_MS);
        if (!meta) throw error;
        return { url: input, width: meta.width, height: meta.height, bytes: 0, mimeType: "" };
    }
    return storeImage(blob, options);
}

async function storeImage(blob: Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    const localKey = `image:${nanoid()}`;
    const url = URL.createObjectURL(blob);
    try {
        const meta = await loadImageMeta(url, options);
        if (!meta) throw new Error(i18n.t("common.imageReadFailed"));
        throwIfAborted(options?.signal);
        if (!useBackendStore.getState().connected) throw new Error("总后台未连接，无法上传图片");
        throwIfAborted(options?.signal);
        const result = await uploadBackendMedia({ name: `${localKey}.png`, blob, mimeType: blob.type || "image/png", width: meta.width, height: meta.height, category: options?.category });
        queueImagePreview(result.storageKey, blob);
        return { url: backendMediaUrl(result.storageKey), storageKey: result.storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: result.mimeType };
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function fetchImageBlob(url: string, options?: ImageReadOptions) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, IMAGE_DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(withLocalProxy(url), { signal: controller.signal });
        if (!response.ok) throw namedError(IMAGE_RESPONSE_ERROR);
        return await response.blob();
    } catch (error) {
        if (timedOut) throw namedError(IMAGE_TIMEOUT_ERROR);
        if (options?.signal?.aborted) throw abortReason(options.signal);
        throw error;
    } finally {
        window.clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
    }
}

function loadImageMeta(url: string, options?: ImageReadOptions, timeoutMs = IMAGE_DECODE_TIMEOUT_MS) {
    return new Promise<{ width: number; height: number } | null>((resolve, reject) => {
        if (options?.signal?.aborted) return reject(abortReason(options.signal));
        const image = new Image();
        let settled = false;
        const finish = (value: { width: number; height: number } | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            options?.signal?.removeEventListener("abort", abort);
            image.onload = null;
            image.onerror = null;
            resolve(value);
        };
        const abort = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            reject(abortReason(options!.signal!));
        };
        const timer = window.setTimeout(() => finish(null), timeoutMs);
        options?.signal?.addEventListener("abort", abort, { once: true });
        image.onload = () => finish(image.naturalWidth && image.naturalHeight ? { width: image.naturalWidth, height: image.naturalHeight } : null);
        image.onerror = () => finish(null);
        image.src = url;
    });
}

function namedError(name: string) {
    const error = new Error(i18n.t("common.imageReadFailed"));
    error.name = name;
    return error;
}

function isNamedError(error: unknown, name: string) {
    return error instanceof Error && error.name === name;
}

function abortReason(signal: AbortSignal) {
    return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortReason(signal);
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (storageKey) {
        if (!useBackendStore.getState().connected) return fallback;
        return backendMediaUrl(storageKey);
    }
    return resolveComfyMediaUrl(fallback);
}

export async function getImageBlob(storageKey: string) {
    if (!useBackendStore.getState().connected) return null;
    const response = await fetch(backendMediaUrl(storageKey));
    return response.ok ? response.blob() : null;
}

// 原图由 Backend 媒体库持有；这里仅缓存可随时重建的 WebP 画布预览。
export function previewUrlFor(storageKey?: string) {
    return storageKey ? previewUrls.get(previewCacheKey(storageKey)) : undefined;
}

export function subscribeImagePreviews(listener: () => void) {
    previewListeners.add(listener);
    return () => {
        previewListeners.delete(listener);
    };
}

export function getImagePreviewRevision() {
    return previewRevision;
}

export function subscribeImagePreview(storageKey: string | undefined, listener: () => void) {
    if (!storageKey) return () => undefined;
    const key = previewCacheKey(storageKey);
    const listeners = previewListenersByKey.get(key) || new Set<() => void>();
    listeners.add(listener);
    previewListenersByKey.set(key, listeners);
    return () => {
        listeners.delete(listener);
        if (!listeners.size) previewListenersByKey.delete(key);
    };
}

export function getImagePreviewRevisionFor(storageKey?: string) {
    return storageKey ? previewRevisionsByKey.get(previewCacheKey(storageKey)) || 0 : 0;
}

export async function ensureImagePreview(storageKey?: string) {
    if (!storageKey) return undefined;
    const cacheKey = previewCacheKey(storageKey);
    const cached = previewUrls.get(cacheKey);
    if (cached) return cached;
    const stored = await previewStore.getItem<StoredImagePreview>(cacheKey).catch(() => null);
    if (stored?.version === IMAGE_PREVIEW_VERSION) return stored.blob ? cacheImagePreview(storageKey, stored.blob, cacheKey) : undefined;
    queueImagePreview(storageKey, undefined, cacheKey);
    return undefined;
}

function queueImagePreview(storageKey: string, original?: Blob, cacheKey = previewCacheKey(storageKey)) {
    if (previewJobs.has(cacheKey)) return;
    previewJobs.add(cacheKey);
    scheduleIdle(() => {
        previewQueue = previewQueue
            .then(async () => {
                const source = original || (await getImageBlob(storageKey));
                if (source) await storeImagePreview(storageKey, source, cacheKey);
            })
            .catch(() => undefined)
            .finally(() => previewJobs.delete(cacheKey));
    });
}

function scheduleIdle(callback: () => void) {
    const idle = (globalThis as typeof globalThis & { requestIdleCallback?: (task: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(callback, { timeout: 1500 });
    else window.setTimeout(callback, 0);
}

async function storeImagePreview(storageKey: string, original: Blob, cacheKey = previewCacheKey(storageKey)) {
    const preview = await createImageThumbnail(original).catch(() => undefined);
    await previewStore.setItem<StoredImagePreview>(cacheKey, { version: IMAGE_PREVIEW_VERSION, blob: preview }).catch(() => undefined);
    return preview ? cacheImagePreview(storageKey, preview, cacheKey) : undefined;
}

function cacheImagePreview(storageKey: string, preview: Blob, cacheKey = previewCacheKey(storageKey)) {
    const previous = previewUrls.get(cacheKey);
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(preview);
    previewUrls.set(cacheKey, url);
    previewRevision += 1;
    previewRevisionsByKey.set(cacheKey, (previewRevisionsByKey.get(cacheKey) || 0) + 1);
    previewListenersByKey.get(cacheKey)?.forEach((listener) => listener());
    previewListeners.forEach((listener) => listener());
    return url;
}

async function deleteImagePreview(storageKey: string) {
    const cacheKey = previewCacheKey(storageKey);
    const url = previewUrls.get(cacheKey);
    if (url) URL.revokeObjectURL(url);
    previewUrls.delete(cacheKey);
    previewJobs.delete(cacheKey);
    previewRevisionsByKey.delete(cacheKey);
    await previewStore.removeItem(cacheKey).catch(() => undefined);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    if (!useBackendStore.getState().connected) throw new Error("总后台未连接，无法写入图片");
    const result = await uploadBackendMedia({ name: `${storageKey}.png`, storageKey, blob, mimeType: blob.type || "image/png" });
    await deleteImagePreview(storageKey);
    queueImagePreview(result.storageKey, blob);
    return backendMediaUrl(result.storageKey);
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }, options?: ImageReadOptions) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await fetchImageBlob(url, options));
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            await deleteImagePreview(key);
            await deleteBackendMedia(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    const orphanPreviews: string[] = [];
    await previewStore.iterate((_value, key) => {
        if (!usedKeys.has(key)) orphanPreviews.push(key);
    });
    await Promise.all(orphanPreviews.map(deleteImagePreview));
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}
