import { nanoid } from "nanoid";

import {
    backendMediaUrl, claimBackendBrowserTask, completeBackendBrowserTask, failBackendBrowserTask,
    fetchBackendTask, getCanvasCollaborationClient, releaseBackendBrowserTask, type BackendRuntimeTask,
} from "@/services/backend-api";
import { uploadMediaFile } from "@/services/file-storage";
import { useConfigStore, decodeChannelModel, modelOptionName, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { requestAudioGeneration, storeGeneratedAudio } from "./audio";
import { requestEdit, requestGeneration, requestImageQuestion, type AiTextMessage } from "./image";
import { requestVideoGeneration, storeGeneratedVideo } from "./video";

const workerId = `${getCanvasCollaborationClient().clientId}:model-script`;
const active = new Map<string, AbortController>();
const knownNonBrowserTasks = new Set<string>();

if (typeof window !== "undefined") {
    window.addEventListener("backend-event", (event) => {
        const detail = (event as CustomEvent).detail as { entityId?: string; payload?: BackendRuntimeTask } | undefined;
        const running = detail?.entityId ? active.get(detail.entityId) : undefined;
        if (running && detail?.payload && ["cancelled", "failed"].includes(detail.payload.status)) running.abort();
    });
}

/** Best-effort kick; atomic Backend claim guarantees that duplicate tabs never execute the same script. */
export function kickCanvasBrowserTask(taskId: string) {
    if (!taskId || active.has(taskId) || knownNonBrowserTasks.has(taskId)) return;
    const controller = new AbortController();
    active.set(taskId, controller);
    void run(taskId, controller).finally(() => active.delete(taskId));
}

export function abortCanvasBrowserTask(taskId: string) {
    active.get(taskId)?.abort();
}

async function run(taskId: string, controller: AbortController) {
    const fetched = await fetchBackendTask(taskId, controller.signal).catch(() => null);
    const task = fetched?.task;
    if (!task) return;
    if (task.kind !== "canvas-browser-script") { knownNonBrowserTasks.add(taskId); return; }
    if (!["queued", "running"].includes(task.status)) return;
    const input = recordOf(task.input);
    try {
        const claimed = await claimBackendBrowserTask(taskId, workerId);
        const result = await execute(claimed.task, controller.signal);
        controller.signal.throwIfAborted();
        await completeBackendBrowserTask(taskId, workerId, result);
    } catch (error) {
        if (controller.signal.aborted) {
            await releaseBackendBrowserTask(taskId, workerId).catch(() => { /* 已取消或被接管时无需释放。 */ });
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        // 认领冲突表示另一个标签页正在执行，不应把对方任务标记失败。
        if (/已由另一个浏览器认领|认领已失效|状态 .* 不可认领/.test(message)) return;
        await failBackendBrowserTask(taskId, workerId, message).catch(() => { /* Backend 终态优先。 */ });
    }
}

async function execute(task: BackendRuntimeTask, signal: AbortSignal): Promise<Record<string, unknown>> {
    const input = recordOf(task.input);
    const mode = String(input.mode || "");
    const model = String(input.model || "");
    const script = String(input.script || "");
    const prompt = String(input.prompt || "");
    const params = recordOf(input.params);
    const config = taskConfig(useConfigStore.getState().config, model, script, input, params);
    const references = referenceImages(input.references);
    if (mode === "image") {
        const imageInputs = [...referenceImages(input.loopInputImages), ...references];
        const images = imageInputs.length
            ? await requestEdit(config, prompt, imageInputs, { signal })
            : await requestGeneration(config, prompt, { signal });
        const media = await Promise.all(images.map((image) => uploadMediaFile(image.dataUrl, "canvas-image", "output")));
        return { media: media.map(mediaHandle) };
    }
    if (mode === "video") {
        const videoReferences = (Array.isArray(input.videoReferences) ? input.videoReferences : []).map((item, index) => {
            const reference = recordOf(item);
            const storageKey = String(reference.storageKey || "");
            return { name: String(reference.name || `video-${index + 1}.mp4`),
                ...(storageKey ? { storageKey, url: backendMediaUrl(storageKey) } : { url: String(reference.url || "") }) };
        });
        const media = await storeGeneratedVideo(await requestVideoGeneration(config, prompt, references, { signal, videoReferences }));
        return { media: [mediaHandle(media)] };
    }
    if (mode === "audio") {
        const media = await storeGeneratedAudio(await requestAudioGeneration(config, prompt, { signal }), config.audioFormat);
        return { media: [mediaHandle(media)] };
    }
    if (mode === "text") {
        const content: AiTextMessage["content"] = references.length
            ? [{ type: "text", text: prompt }, ...references.map((reference) => ({ type: "image_url" as const, image_url: { url: reference.dataUrl } }))]
            : prompt;
        const texts: string[] = [];
        const count = Math.max(1, Math.min(4, Math.floor(Number(input.count || 1))));
        for (let index = 0; index < count; index++) {
            let streamed = "";
            const text = await requestImageQuestion(config, [{ role: "user", content }], (value) => { streamed = value; }, { signal });
            const value = String(text || streamed).trim();
            if (!value) throw new Error("浏览器文本模型返回了空内容");
            texts.push(value);
        }
        return { texts };
    }
    throw new Error(`未知的浏览器模型模式：${mode}`);
}

function taskConfig(base: AiConfig, selectedModel: string, script: string, input: Record<string, unknown>, params: Record<string, unknown>): AiConfig {
    const decoded = decodeChannelModel(selectedModel);
    const name = modelOptionName(selectedModel);
    let found = false;
    const channels = base.channels.map((channel) => {
        if (decoded && channel.id !== decoded.channelId) return channel;
        if (!decoded && !channel.models.some((model) => model.name === name)) return channel;
        return {
            ...channel,
            models: channel.models.map((model) => {
                if (model.name !== name) return model;
                found = true;
                return { ...model, script };
            }),
        };
    });
    if (!found) throw new Error(`当前浏览器找不到模型配置：${name}`);
    const reasoning = String(params.reasoningEffort || base.reasoningEffort) as AiConfig["reasoningEffort"];
    return {
        ...base, channels, model: selectedModel, imageModel: selectedModel, videoModel: selectedModel,
        textModel: selectedModel, audioModel: selectedModel,
        count: String(input.count || 1), size: String(input.size || base.size), quality: String(input.quality || base.quality),
        background: String(params.background || base.background),
        videoSeconds: String(input.seconds || base.videoSeconds), vquality: String(input.resolution || base.vquality),
        videoGenerateAudio: String(params.generateAudio ?? base.videoGenerateAudio), videoWatermark: String(params.watermark ?? base.videoWatermark),
        audioVoice: String(params.voice || base.audioVoice), audioFormat: String(params.format || base.audioFormat),
        audioSpeed: String(params.speed || base.audioSpeed), audioInstructions: String(params.instructions || base.audioInstructions),
        systemPrompt: String(params.systemPrompt ?? base.systemPrompt), reasoningEffort: reasoning,
    };
}

function referenceImages(value: unknown): ReferenceImage[] {
    return (Array.isArray(value) ? value : []).map((item, index) => {
        const reference = recordOf(item);
        const storageKey = String(reference.storageKey || "");
        const dataUrl = String(reference.dataUrl || (storageKey ? backendMediaUrl(storageKey) : reference.url) || "");
        if (!dataUrl) throw new Error(`参考图 ${index + 1} 缺少可读取地址`);
        return {
            id: String(reference.id || `browser-reference-${nanoid()}`),
            name: String(reference.name || `reference-${index + 1}.png`),
            type: String(reference.mimeType || reference.type || "image/png"),
            dataUrl,
            ...(storageKey ? { storageKey } : {}),
            ...(reference.url ? { url: String(reference.url) } : {}),
        };
    });
}

function mediaHandle(media: { storageKey: string }) { return { storageKey: media.storageKey }; }
function recordOf(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
