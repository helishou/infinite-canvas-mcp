export type VideoFramePosition = "first" | "last" | "current";

const MAX_VIDEO_PREVIEWS = 128;
const previewUrls = new Map<string, string>();
const previewRevisions = new Map<string, number>();
const previewListeners = new Map<string, Set<() => void>>();
const previewJobs = new Set<string>();
let previewQueue: Promise<unknown> = Promise.resolve();

export function videoPreviewUrlFor(source?: string) {
    return source ? previewUrls.get(source) : undefined;
}

export function getVideoPreviewRevision(source?: string) {
    return source ? previewRevisions.get(source) || 0 : 0;
}

export function subscribeVideoPreview(source: string | undefined, listener: () => void) {
    if (!source) return () => undefined;
    const listeners = previewListeners.get(source) || new Set<() => void>();
    listeners.add(listener);
    previewListeners.set(source, listeners);
    return () => {
        listeners.delete(listener);
        if (!listeners.size) previewListeners.delete(source);
    };
}

// 视频封面只用于浏览器概览层；串行读取避免总览时同时创建大量解码器。
export function ensureVideoPreview(source?: string) {
    if (!source || previewUrls.has(source) || previewJobs.has(source)) return;
    previewJobs.add(source);
    previewQueue = previewQueue
        .then(async () => {
            const frame = await captureVideoFrame(source, "first", 0).catch(() => undefined);
            if (!frame) return;
            const previous = previewUrls.get(source);
            if (previous) URL.revokeObjectURL(previous);
            previewUrls.set(source, URL.createObjectURL(frame));
            previewRevisions.set(source, (previewRevisions.get(source) || 0) + 1);
            previewListeners.get(source)?.forEach((listener) => listener());
            while (previewUrls.size > MAX_VIDEO_PREVIEWS) {
                // 正在被概览节点订阅的封面仍可能由 <img> 展示，不能提前 revoke。
                const oldest = Array.from(previewUrls.keys()).find((key) => !previewListeners.get(key)?.size);
                if (!oldest) break;
                const url = previewUrls.get(oldest);
                if (url) URL.revokeObjectURL(url);
                previewUrls.delete(oldest);
                previewRevisions.delete(oldest);
            }
        })
        .catch(() => undefined)
        .finally(() => previewJobs.delete(source));
}

export async function captureVideoFrame(source: string, position: VideoFramePosition, currentTime: number) {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    try {
        const metadataLoaded = waitForVideo(video, "loadedmetadata");
        video.src = source;
        video.load();

        await metadataLoaded;
        const endTime = Math.max(0, video.duration - 0.001);
        const time = position === "first" ? 0 : position === "last" ? endTime : Math.min(currentTime, endTime);
        if (time) {
            const seeked = waitForVideo(video, "seeked");
            video.currentTime = time;
            await seeked;
        } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            await waitForVideo(video, "loadeddata");
        }

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d")!.drawImage(video, 0, 0);
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("Failed to capture video frame"))), "image/png"));
    } finally {
        video.removeAttribute("src");
        video.load();
    }
}

function waitForVideo(video: HTMLVideoElement, eventName: "loadedmetadata" | "loadeddata" | "seeked") {
    return new Promise<void>((resolve, reject) => {
        const finish = () => {
            video.removeEventListener(eventName, finish);
            video.removeEventListener("error", fail);
            resolve();
        };
        const fail = () => {
            video.removeEventListener(eventName, finish);
            video.removeEventListener("error", fail);
            reject(new Error("Failed to read video frame"));
        };
        video.addEventListener(eventName, finish);
        video.addEventListener("error", fail);
    });
}
