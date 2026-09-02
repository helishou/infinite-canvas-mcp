import { fetchAgentJson, syncRuntimeMedia } from "./canvas-agent";
import { backendMediaUrl, getBackendToken, getBackendUrl } from "@/services/backend-api";

type LocalReference = { name: string; dataUrl?: string; url?: string; storageKey?: string };
type ComfyMedia = { url: string; mimeType: string; storageKey?: string };
type ComfyTask = { id: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; progress: number; result?: { media?: ComfyMedia[]; segments?: Array<{ media?: ComfyMedia[] }> } | null; error?: string | null };

export function resolveComfyImageSize(value: string) {
    const size = value.trim();
    // `auto` means preserve the source workflow's natural dimensions. The
    // Flux workflow uses the first reference image for this case; returning
    // zeroes keeps the request shape stable while preventing the backend from
    // treating auto as an explicit 1024x1024 override.
    if (!size || size.toLowerCase() === "auto") return { width: 0, height: 0 };
    const dimensions = size.match(/^(\d+)x(\d+)$/i);
    if (dimensions) return { width: Number(dimensions[1]), height: Number(dimensions[2]) };
    const ratio = size.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!ratio) return { width: 1024, height: 1024 };
    const ratioWidth = Number(ratio[1]);
    const ratioHeight = Number(ratio[2]);
    const shortSide = 1024;
    const landscape = ratioWidth >= ratioHeight;
    const longSide = Math.round((shortSide * Math.max(ratioWidth, ratioHeight) / Math.min(ratioWidth, ratioHeight)) / 16) * 16;
    return landscape ? { width: longSide, height: shortSide } : { width: shortSide, height: longSide };
}

/**
 * 把 ComfyUI 返回的裸媒体地址改写成前端可播放的地址。
 * 后端在本地模式下可能返回相对路径（/media/...）或 Windows 风格路径，
 * 直接 `new URL(item.url)` 会抛 “Failed to construct 'URL'”。这里容错处理：
 * - /media/:storageKey 走总后台 /media 路由（backendMediaUrl，开发模式走 Vite 代理）
 * - runtime-file: 走总后台 /runtime/media-file
 * - 合法绝对地址（ComfyUI /view 直链）走 /agent/comfy/media 代理
 * - 其他相对/异常地址用总后台兜底，绝不抛错
 */
function proxyComfyMedia(item: ComfyMedia, endpoint: string, token: string): ComfyMedia {
    const raw = item.url;
    if (raw.startsWith("/media/")) {
        const storageKey = decodeURIComponent(raw.slice("/media/".length).split("?")[0]);
        return { ...item, url: backendMediaUrl(storageKey) };
    }
    if (raw.startsWith("runtime-file:")) {
        const backendUrl = getBackendUrl().replace(/\/$/, "");
        const file = encodeURIComponent(raw.slice("runtime-file:".length));
        return { ...item, url: `${backendUrl}/runtime/media-file?file=${file}&token=${encodeURIComponent(getBackendToken())}` };
    }
    try {
        const parsed = new URL(raw);
        return { ...item, url: `${endpoint}/comfy/media${parsed.search}${parsed.search ? "&" : "?"}token=${encodeURIComponent(token)}` };
    } catch {
        // 兜底：Windows 风格路径或其他相对路径，用总后台地址拼接
        const backendUrl = getBackendUrl().replace(/\/$/, "");
        const needsSlash = !raw.startsWith("/");
        const sep = raw.includes("?") ? "&" : "?";
        return { ...item, url: `${backendUrl}${needsSlash ? "/" : ""}${raw}${sep}token=${encodeURIComponent(getBackendToken())}` };
    }
}

export async function runComfyTask(endpoint: string, token: string, comfyUrl: string, preset: string, prompt: string, references: LocalReference[], params: Record<string, unknown>, signal?: AbortSignal) {
    const synced = await Promise.all(references.map((reference) => syncReference(endpoint, token, reference, signal)));
    const input: Record<string, unknown> = { prompt };
    if (preset === "flux2-klein") input.references = synced.filter(Boolean);
    if (preset === "flashvsr-1.1" && synced[0]) input.video = synced[0];
    const created = await fetchAgentJson<{ task: ComfyTask }>(endpoint, token, "/comfy/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset, input, params, comfyUrl }) });
    for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const response = await fetchAgentJson<{ task: ComfyTask }>(endpoint, token, `/comfy/tasks/${created.task.id}`);
        if (["succeeded", "failed", "cancelled"].includes(response.task.status)) {
            if (response.task.status !== "succeeded") throw new Error(response.task.error || "ComfyUI 任务失败");
            const media = response.task.result?.media?.[0];
            if (!media) throw new Error("ComfyUI 任务完成但没有返回媒体");
            return proxyComfyMedia(media, endpoint, token);
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
    }
}

export type LocalH3Input = {
    video?: LocalReference;
    references?: LocalReference[];
    audios?: LocalReference[];
    previousVideo?: LocalReference;
};

/** Run the packaged MiniMax H3 workflow through the Agent runtime. The plugin never talks to ComfyUI directly. */
export async function runLocalH3Task(endpoint: string, token: string, comfyUrl: string, prompt: string, input: LocalH3Input, params: Record<string, unknown>, signal?: AbortSignal, onTaskId?: (taskId: string) => void) {
    const refs = [...(input.references || []), ...(input.audios || []), ...(input.video ? [input.video] : []), ...(input.previousVideo ? [input.previousVideo] : [])];
    const synced = await Promise.all(refs.map(async (reference) => ({ reference, path: await syncReference(endpoint, token, reference, signal) })));
    const pathFor = (reference?: LocalReference) => synced.find((item) => item.reference === reference)?.path;
    const created = await fetchAgentJson<{ task: ComfyTask }>(endpoint, token, "/comfy/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: "minimax-h3", input: { prompt, references: (input.references || []).map(pathFor).filter(Boolean), audios: (input.audios || []).map(pathFor).filter(Boolean), video: pathFor(input.video), previousVideo: pathFor(input.previousVideo) }, params, comfyUrl }) });
    onTaskId?.(created.task.id);
    for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const response = await fetchAgentJson<{ task: ComfyTask }>(endpoint, token, `/comfy/tasks/${created.task.id}`);
        if (["succeeded", "failed", "cancelled"].includes(response.task.status)) {
            if (response.task.status !== "succeeded") throw new Error(response.task.error || "MiniMax H3 任务失败");
            const media = response.task.result?.media?.find((item) => String(item.mimeType || "video/mp4").startsWith("video/")) || response.task.result?.media?.[0];
            if (!media) throw new Error("MiniMax H3 完成但没有返回视频");
            const proxy = (item: ComfyMedia) => proxyComfyMedia(item, endpoint, token);
            return { ...proxy(media), segments: (response.task.result?.segments || []).map((segment) => ({ media: (segment.media || []).map(proxy) })), taskId: created.task.id };
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
    }
}

export async function getLocalH3Task(endpoint: string, token: string, taskId: string) {
    const response = await fetchAgentJson<{ task: ComfyTask }>(endpoint, token, `/comfy/tasks/${encodeURIComponent(taskId)}`);
    const proxy = (item: ComfyMedia) => proxyComfyMedia(item, endpoint, token);
    if (!response.task.result) return { ...response.task, result: null };
    const media = (response.task.result.media || []).map(proxy);
    return { ...response.task, result: { url: media.find((item) => item.mimeType.startsWith("video/"))?.url || media[0]?.url || "", mimeType: media.find((item) => item.mimeType.startsWith("video/"))?.mimeType || media[0]?.mimeType || "video/mp4", taskId: response.task.id, segments: (response.task.result.segments || []).map((segment) => ({ media: (segment.media || []).map(proxy) })) } };
}

export async function cancelLocalH3Task(endpoint: string, token: string, taskId: string) {
    return (await fetchAgentJson<{ task: ComfyTask }>(endpoint, token, `/comfy/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" })).task;
}

/** Legacy H3 execution path for nodes migrated from the old RunningHub-backed canvas. */
export async function runRunningHubH3Task(endpoint: string, token: string, prompt: string, input: LocalH3Input, params: Record<string, unknown>, signal?: AbortSignal, onTaskId?: (taskId: string) => void) {
    const refs = [...(input.references || []), ...(input.audios || []), ...(input.video ? [input.video] : []), ...(input.previousVideo ? [input.previousVideo] : [])];
    const synced = await Promise.all(refs.map(async (reference) => ({ reference, path: await syncReference(endpoint, token, reference, signal) })));
    const pathFor = (reference?: LocalReference) => synced.find((item) => item.reference === reference)?.path;
    const created = await fetchAgentJson<{ task: ComfyTask }>(endpoint, token, "/runninghub/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { prompt, references: (input.references || []).map(pathFor).filter(Boolean), audios: (input.audios || []).map(pathFor).filter(Boolean), video: pathFor(input.video), previousVideo: pathFor(input.previousVideo) }, params }) });
    onTaskId?.(created.task.id);
    for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const response = await fetchAgentJson<{ task: ComfyTask }>(endpoint, token, `/runninghub/tasks/${created.task.id}`);
        if (["succeeded", "failed", "cancelled"].includes(response.task.status)) {
            if (response.task.status !== "succeeded") throw new Error(response.task.error || "RunningHub H3 任务失败");
            const media = response.task.result?.media?.find((item) => item.mimeType.startsWith("video/")) || response.task.result?.media?.[0];
            if (!media) throw new Error("RunningHub H3 完成但没有返回媒体");
            return { ...media, mimeType: media.mimeType || "video/mp4", taskId: created.task.id };
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
    }
}

export async function getRunningHubH3Task(endpoint: string, token: string, taskId: string) {
    const task = (await fetchAgentJson<{ task: ComfyTask }>(endpoint, token, `/runninghub/tasks/${encodeURIComponent(taskId)}`)).task;
    if (!task.result) return { ...task, result: null };
    const media = task.result.media || [];
    const output = media.find((item) => String(item.mimeType || "video/mp4").startsWith("video/")) || media[0];
    return { ...task, result: output ? { url: output.url, mimeType: output.mimeType || "video/mp4", taskId: task.id } : null };
}

export async function cancelRunningHubH3Task(endpoint: string, token: string, taskId: string) {
    return (await fetchAgentJson<{ task: ComfyTask }>(endpoint, token, `/runninghub/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" })).task;
}

async function fetchAsDataUrl(url: string, signal?: AbortSignal) {
    if (!url) throw new Error("本地媒体缺少可读取地址");
    let response: Response;
    try {
        response = await fetch(url, { signal });
    } catch (error) {
        throw new Error(`读取本地媒体失败（${url}）：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`读取本地媒体失败：HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html")) throw new Error(`媒体地址返回了 HTML 而不是文件：${url}`);
    const blob = await response.blob();
    if (blob.type && !/^(image|video|audio)\//.test(blob.type)) {
        throw new Error(`媒体类型无效：${blob.type}（${url}）`);
    }
    return await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error || new Error("读取媒体失败")); reader.readAsDataURL(blob); });
}

function sourceUrl(reference: LocalReference) {
    if (reference.storageKey) return backendMediaUrl(reference.storageKey);
    const source = reference.dataUrl || reference.url || "";
    if (!source || source.startsWith("data:")) return source;
    try {
        const parsed = new URL(source, window.location.origin);
        if (parsed.pathname.startsWith("/media/")) {
            return backendMediaUrl(decodeURIComponent(parsed.pathname.slice("/media/".length)));
        }
        if (source.startsWith("/")) return `${getBackendUrl().replace(/\/$/, "")}${source}`;
    } catch {
        // Keep the original value so the fetch error includes the source address.
    }
    return source;
}

/**
 * 从后端媒体 URL 中提取 storageKey。
 * 仅匹配后端自有媒体 `/media/:storageKey` 形式（由 backendMediaUrl 生成），
 * 排除 `/runtime/media*` 与 `/media-file`（它们是不同端点，并非 storageKey 媒体）。
 */
function extractStorageKey(url: string): string | null {
    const idx = url.indexOf("/media/");
    if (idx === -1) return null;
    const prefix = url.slice(0, idx);
    if (prefix.endsWith("/runtime")) return null;   // /runtime/media/* 不是 storageKey 媒体
    if (url.includes("/media-file")) return null;   // /runtime/media-file?file=... 是另一种读取端点
    const key = url.slice(idx + "/media/".length).split(/[?#]/)[0];
    return key && !key.includes("/") ? key : null;
}

/**
 * 把一个参考媒体落地到后端 runtime media，返回其本地路径。
 * 若媒体本就在后端（已有 storageKey，或 URL 指向后端 /media/:storageKey），
 * 直接复用而不再 base64 下载→重传，避免 H3 串 clip 时 previousVideo 撑爆请求体（413）。
 */
async function syncReference(endpoint: string, token: string, reference: LocalReference, signal?: AbortSignal): Promise<string | undefined> {
    const source = sourceUrl(reference);
    const storageKey = reference.storageKey || extractStorageKey(source);
    if (storageKey) {
        const res = await fetchAgentJson<{ ok?: boolean; media?: { path?: string } }>(
            endpoint, token, "/runtime/media",
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: reference.name, storageKey }) },
        );
        return res.media?.path;
    }
    if (source.startsWith("data:") && !/^data:([^;,]+);base64,(.+)$/s.test(source)) {
        throw new Error(`参考「${reference.name}」携带的 data URL 非法（缺少 ;base64, 负载或格式错误），无法上传。请重新添加该素材。`);
    }
    const dataUrl = source.startsWith("data:") ? source : await fetchAsDataUrl(source, signal);
    return (await syncRuntimeMedia(endpoint, token, reference.name, dataUrl)).media?.path;
}
