import { nanoid } from "nanoid";

import {
    backendMediaUrl, checkpointBackendBrowserTask, claimBackendBrowserTask, completeBackendBrowserTask, failBackendBrowserTask,
    fetchBackendTask, getCanvasCollaborationClient, releaseBackendBrowserTask, type BackendRuntimeTask,
} from "@/services/backend-api";
import { uploadMediaFile } from "@/services/file-storage";
import { useConfigStore, decodeChannelModel, modelOptionName, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { requestAudioGeneration, storeGeneratedAudio } from "./audio";
import { requestEdit, requestGeneration, requestImageQuestion, type AiTextMessage } from "./image";
import { createVideoGenerationTask, videoProviderFingerprint, pollVideoGenerationTask, storeGeneratedVideo } from "./video";
import { browserRecoveryOwner, readBrowserResult, saveBrowserResult, clearBrowserResult, BrowserProviderTerminalFailure, BrowserPreflightFailure, BrowserSubmissionUnknown, type BrowserRecovery, type BrowserResultCache } from "./browser-task-recovery";

const workerId = `${getCanvasCollaborationClient().clientId}:model-script`;
const active = new Map<string, AbortController>();
const paused = new Set<string>();
const resumeOnly = new Set<string>();
const knownNonBrowserTasks = new Set<string>();

if (typeof window !== "undefined") {
    window.addEventListener("backend-event", (event) => {
        const detail = (event as CustomEvent).detail as { entityId?: string; payload?: BackendRuntimeTask } | undefined;
        const running = detail?.entityId ? active.get(detail.entityId) : undefined;
        if (running && detail?.payload && ["cancelled", "failed"].includes(detail.payload.status)) running.abort();
    });
}

/** Best-effort kick; atomic Backend claim guarantees that duplicate tabs never execute the same script. */
export function isCanvasBrowserTaskPaused(taskId: string) { return paused.has(taskId); }
export function resumeCanvasBrowserTask(taskId: string) { resumeOnly.add(taskId); paused.delete(taskId); kickCanvasBrowserTask(taskId); }
export function kickCanvasBrowserTask(taskId: string) {
    if (paused.has(taskId)) return;
    if (!taskId || active.has(taskId) || knownNonBrowserTasks.has(taskId)) return;
    const controller = new AbortController();
    active.set(taskId, controller);
    void run(taskId, controller).catch(() => { paused.add(taskId); }).finally(() => active.delete(taskId));
}

export function abortCanvasBrowserTask(taskId: string) {
    active.get(taskId)?.abort();
}

async function run(taskId: string, controller: AbortController) {
    const owner = await browserRecoveryOwner();
    const fetched = await fetchBackendTask(taskId, controller.signal).catch(() => null);
    const task = fetched?.task;
    if (!task) return;
    if (task.kind !== "canvas-browser-script") { knownNonBrowserTasks.add(taskId); return; }
    if (task.status === "succeeded") { await clearBrowserResult(owner.key, taskId); return; }
    if (!["queued", "running"].includes(task.status)) return;
    let claimToken: string | undefined;
    let recovery: BrowserRecovery | undefined;
    try {
        owner.assertCurrent();
        const claimed = await claimBackendBrowserTask(taskId, workerId);
        claimToken = claimed.claimToken;
        if (!claimToken) throw new Error("Backend does not support safe browser-task recovery; update it before generation.");
        recovery = recordOf(claimed.task.result).browserRecovery as BrowserRecovery | undefined;
        if (resumeOnly.has(taskId) && !recovery) throw new BrowserSubmissionUnknown("尚无外部提交回执；已停止在原任务检查，不会发起新的生成。");
        const checkpoint = async (next: BrowserRecovery) => {
            owner.assertCurrent();
            await checkpointBackendBrowserTask(taskId, workerId, claimToken!, next);
            recovery = next;
        };
        const result = await execute(claimed.task, controller.signal, owner, recovery, checkpoint);
        controller.signal.throwIfAborted();
        owner.assertCurrent();
        await completeBackendBrowserTask(taskId, workerId, result, claimToken);
        await clearBrowserResult(owner.key, taskId);
    } catch (error) {
        if (!claimToken) return;
        paused.add(taskId);
        const message = error instanceof Error ? error.message : String(error);
        try { owner.assertCurrent(); } catch { return; }
        if (error instanceof BrowserPreflightFailure && !recovery) {
            await failBackendBrowserTask(taskId, workerId, message, claimToken, false, true).catch(() => {});
        } else if (error instanceof BrowserProviderTerminalFailure) {
            await failBackendBrowserTask(taskId, workerId, message, claimToken, true).catch(() => {});

        } else {
            // Release ownership, never permission to submit again. The durable phase
            // distinguishes a safe resume from a brand-new paid generation.
            await releaseBackendBrowserTask(taskId, workerId, claimToken, recovery ? "原请求状态待确认；请恢复原任务查询或结果保存，不会重新生成。" : message).catch(() => {});
        }
    }
}

async function execute(task: BackendRuntimeTask, signal: AbortSignal, owner: Awaited<ReturnType<typeof browserRecoveryOwner>>, recovery: BrowserRecovery | undefined, checkpoint: (next: BrowserRecovery) => Promise<void>): Promise<Record<string, unknown>> {
    const input = recordOf(task.input);
    const mode = String(input.mode || "");
    const model = String(input.model || "");
    const script = String(input.script || "");
    const prompt = String(input.prompt || "");
    const params = recordOf(input.params);
    // Archived handles belong to the Backend task, not current model settings.
    if (recovery?.phase === "archived" && recovery.output) return recovery.output;
    let config: AiConfig;
    let references: ReferenceImage[];
    try { config = taskConfig(useConfigStore.getState().config, model, script, input, params); references = referenceImages(input.references); }
    catch (error) { throw new BrowserPreflightFailure(error instanceof Error ? error.message : String(error)); }
    const providerFingerprint = await videoProviderFingerprint(config, model);
    if (recovery?.providerFingerprint && recovery.providerFingerprint !== providerFingerprint) throw new BrowserSubmissionUnknown("原模型渠道或账号已变化，请恢复原配置后查询，不会向其他账号发送原任务。");
    {
        if (recovery?.cacheOwner && recovery.cacheOwner !== owner.key) throw new BrowserSubmissionUnknown("原任务属于另一连接身份，恢复数据已保留，请恢复原连接后继续。");
        let cached: BrowserResultCache = await readBrowserResult(owner.key, task.id) || {};
        const persist = async (next: BrowserResultCache, phase: BrowserRecovery["phase"]) => {
            owner.assertCurrent();
            await saveBrowserResult(owner.key, task.id, next).catch(error => { if (phase !== "external_task" && phase !== "archived") throw error; });
            cached = next;
            await checkpoint({version:1, phase, cacheOwner:owner.key, providerFingerprint, ...(next.externalTask ? {externalTask:next.externalTask}:{}), ...(next.output ? {output:next.output}:{})});
        };
        if (recovery?.phase === "archived" && recovery.output) return recovery.output;
        if (cached.output) { await persist(cached, "archived"); return cached.output; }
        if (mode === "image") {
            if (!cached.images) {
                if (recovery) throw new BrowserSubmissionUnknown("已提交的图像任务没有可恢复结果；请先核对服务商记录，不会再次生成。");
                await checkpoint({version:1,phase:"submitting",cacheOwner:owner.key,providerFingerprint});
                const imageInputs = [...referenceImages(input.loopInputImages), ...references];
                const images = imageInputs.length ? await requestEdit(config,prompt,imageInputs,{signal}) : await requestGeneration(config,prompt,{signal});
                await persist({images}, "result_available");
            }
            owner.assertCurrent();
            const media = await Promise.all(cached.images!.map(image=>uploadMediaFile(image.dataUrl || image.url || "", "canvas-image", "output")));
            const output = {media:media.map(mediaHandle)};
            await persist({...cached,output}, "archived");
            return output;
        }
        if (mode === "video") {
        if (!cached.video) {
            let externalTask = cached.externalTask || recovery?.externalTask;
            if (!externalTask) {
                if (recovery) throw new BrowserSubmissionUnknown("视频请求可能已提交但未取得任务编号，请先核对服务商记录；不会再次生成。");
                await checkpoint({version:1,phase:"submitting",cacheOwner:owner.key,providerFingerprint});
                const videoReferences = (Array.isArray(input.videoReferences) ? input.videoReferences : []).map((item,index)=>{const reference=recordOf(item);const storageKey=String(reference.storageKey||"");return {name:String(reference.name||`video-${index+1}.mp4`),...(storageKey?{storageKey,url:backendMediaUrl(storageKey)}:{url:String(reference.url||"")})};});
                externalTask = await createVideoGenerationTask(config,prompt,references,{signal,videoReferences});
                await persist({externalTask}, "external_task");
            }
            const attempts=externalTask.provider === "comfyui" ? 1200 : 120;
            for(let attempt=0;attempt<attempts;attempt++) {
                signal.throwIfAborted();owner.assertCurrent();
                const state=await pollVideoGenerationTask(config,externalTask,{signal});
                if(state.status === "failed") throw new BrowserProviderTerminalFailure(state.error);
                if(state.status === "completed") { await persist({externalTask,video:state.result}, "result_available");break; }
                if(attempt===attempts-1) throw new BrowserSubmissionUnknown("查询暂未取得终态，原视频任务仍保留。");
                await new Promise(resolve=>setTimeout(resolve,externalTask!.provider === "comfyui" ? 1500 : 2500));
            }
        }
        owner.assertCurrent();
        const media=await storeGeneratedVideo(cached.video!);
        if(!media.storageKey) throw new BrowserSubmissionUnknown("视频结果已取得但尚未归档，请恢复保存原结果。");
        const output={media:[mediaHandle(media)]};
        await persist({...cached,output}, "archived");
        return output;
        }
    if (mode === "audio") {
        if (!cached.audio) {
            if (recovery) throw new BrowserSubmissionUnknown("音频请求已提交但没有可恢复结果，请核对服务商记录，不会再次生成。");
            await checkpoint({version:1,phase:"submitting",cacheOwner:owner.key,providerFingerprint});
            const audio = await requestAudioGeneration(config, prompt, { signal });
            await persist({audio}, "result_available");
        }
        owner.assertCurrent();
        const media = await storeGeneratedAudio(cached.audio!, config.audioFormat);
        const output={media:[mediaHandle(media)]};
        await persist({...cached,output}, "archived");
        return output;
    }
    if (mode === "text") {
        if (cached.texts) { const output={texts:cached.texts}; await persist({...cached,output},"archived");return output; }
        if (recovery) throw new BrowserSubmissionUnknown("文本请求已提交但没有完整回执，请核对服务商记录，不会再次生成。");
        await checkpoint({version:1,phase:"submitting",cacheOwner:owner.key,providerFingerprint});
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
        const output={texts};
        await persist({texts,output}, "archived");
        return output;
    }
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
