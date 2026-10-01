import { getBackendUrl, uploadBackendMedia } from "@/services/backend-api";
import { runCanvasVideoTask } from "./canvas-video";

/** Preserve archived media handles; import other playable sources before submitting. */
export async function trimCanvasVideo(input: { projectId: string; url: string; name: string; start: number; end: number; taskId: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.start < 0 || input.end <= input.start) throw new Error("Invalid video trim range");
    const parsed = new URL(input.url, window.location.origin);
    const local = parsed.origin === window.location.origin || parsed.origin === new URL(getBackendUrl(), window.location.origin).origin;
    const match = local ? /^\/media\/([^/]+)$/.exec(parsed.pathname) : null;
    let storageKey = match ? decodeURIComponent(match[1]) : "";
    if (!storageKey) {
        const response = await fetch(input.url, { signal });
        if (!response.ok) throw new Error(`Video fetch failed (${response.status})`);
        const blob = await response.blob();
        signal.throwIfAborted();
        const media = await uploadBackendMedia({ name: input.name, blob, mimeType: blob.type.startsWith("video/") ? blob.type : "video/mp4", category: "input" });
        storageKey = media.storageKey;
    }
    signal.throwIfAborted();
    return runCanvasVideoTask({ mode: "video", model: "__local_video_trim__", projectId: input.projectId,
        prompt: `${input.name} · ${input.start.toFixed(3)}–${input.end.toFixed(3)}s`,
        videoReferences: [{ storageKey }], params: { start: input.start, end: input.end }, idempotencyKey: input.taskId }, signal);
}
