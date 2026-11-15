import { fetchAgentJson, AgentApiError } from "./canvas-agent";
import { resolveBackendAgentEndpoint } from "./comfyui";
import type { ClipTranscript } from "@/lib/subtitle-calibration";

export type SubtitleTranscribeTask = {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    progress: number;
    error?: string | null;
    result?: { transcripts?: ClipTranscript[]; model?: string; language?: string; pythonPath?: string; modelDir?: string } | null;
};

export type SubtitleTranscribeResult = {
    transcripts: ClipTranscript[];
    model: string;
    language: string;
    pythonPath: string;
    modelDir?: string;
    taskId: string;
};

export type SubtitleTranscribeInput = {
    storageKeys: string[];
    clientTaskId: string;
    model?: string;
    language?: string;
    pythonPath?: string;
    modelDir?: string;
    fp16?: boolean;
};

export function subtitleTranscribeCapability() {
    const { endpoint, token } = resolveBackendAgentEndpoint();
    return fetchAgentJson<{ ok: boolean; available: boolean; pythonPath: string; model: string; language: string; modelDir?: string; ffmpeg: string }>(
        endpoint, token, "/subtitle-transcribe/status",
    );
}

/** Fire a real backend transcription task and poll it to a terminal state. */
export async function runSubtitleTranscribe(
    input: SubtitleTranscribeInput,
    signal?: AbortSignal,
    onProgress?: (progress: number) => void,
): Promise<SubtitleTranscribeResult> {
    const { endpoint, token } = resolveBackendAgentEndpoint();
    const created = await fetchAgentJson<{ task: SubtitleTranscribeTask }>(endpoint, token, "/subtitle-transcribe/tasks", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    const taskId = created.task.id;
    const cancel = () => { void fetchAgentJson(endpoint, token, `/subtitle-transcribe/tasks/${taskId}/cancel`, { method: "POST" }).catch(() => undefined); };
    signal?.addEventListener("abort", cancel, { once: true });
    let failures = 0;
    for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        let response: { task: SubtitleTranscribeTask };
        try {
            response = await fetchAgentJson<{ task: SubtitleTranscribeTask }>(endpoint, token, `/runtime/tasks/${taskId}`);
            failures = 0;
        } catch (error) {
            if (error instanceof AgentApiError && error.status >= 400 && error.status < 500) throw error;
            failures += 1;
            if (failures > 10) throw error;
            await new Promise(resolve => setTimeout(resolve, 1500));
            continue;
        }
        const task = response.task;
        onProgress?.(Math.max(0, Math.min(1, Number(task.progress) || 0)));
        if (["succeeded", "failed", "cancelled"].includes(task.status)) {
            if (task.status !== "succeeded") throw new Error(task.error || "字幕音频识别失败");
            const transcripts = Array.isArray(task.result?.transcripts) ? task.result!.transcripts! : [];
            return {
                transcripts,
                model: String(task.result?.model || input.model || "base"),
                language: String(task.result?.language || input.language || "Chinese"),
                pythonPath: String(task.result?.pythonPath || ""),
                ...(task.result?.modelDir ? { modelDir: task.result.modelDir } : {}),
                taskId,
            };
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
    }
}
