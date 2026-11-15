import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { getGenerationCount } from "@/lib/canvas/canvas-generation-helpers";
import { creativeProjectTitle, type ReferenceAsset } from "@/lib/creative-pad";
import { normalizeVideoSizeValue } from "@/lib/video-size";
import { kickCanvasBrowserTask } from "@/services/api/canvas-browser-task";
import { resolveComfyImageSize } from "@/services/api/comfyui";
import { startCanvasGeneration } from "@/services/backend-api";
import { flushCanvasProjectBeforeGeneration, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { defaultConfig, resolveModelForCapability, useConfigStore } from "@/stores/use-config-store";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export class CreativeConfigMissingError extends Error {
    constructor() {
        super(i18n.t("creativePad.configMissing"));
        this.name = "CreativeConfigMissingError";
    }
}

export type CreativeGenerationOptions = {
    capability: "image" | "video" | "text" | "audio";
    prompt: string;
    model?: string;
    /** 会话内多轮共享生成上下文（对齐影策 conversation.canvasId）：传入则把本轮节点追加到同一张画布。 */
    projectId?: string;
    references?: readonly ReferenceAsset[];
    imageSize?: string;
    imageQuality?: string;
    imageCount?: string;
    videoSize?: string;
    videoSeconds?: string;
    videoResolution?: string;
    videoGenerateAudio?: string;
    videoWatermark?: string;
    /** 本地 ComfyUI 工作流的自定义字段值，与画布节点 metadata.comfyParams 同源。 */
    comfyParams?: Record<string, unknown>;
    imageRunTarget?: "local" | "cloud" | "hybrid";
    videoRunTarget?: "local" | "cloud" | "hybrid";
};

/**
 * 首页启动台与 Agent 站点工具共用的「新建画布 → Backend 生成」链路：
 * 先落画布与智能配置节点，再提交生成；结果节点由 Backend 依据 clientTaskId 创建，
 * 进度与结果经 realtime ops 回到画布，与画布内生成是同一条任务链路。
 */
export async function startCreativeGeneration(options: CreativeGenerationOptions): Promise<{ projectId: string; nodeId: string; taskId: string }> {
    const { capability, references = [] } = options;
    const text = options.prompt.trim();
    if (!text) throw new Error(i18n.t("creativePad.ideaRequired"));
    const canvas = useCanvasStore.getState();
    if (!canvas.hydrated) throw new Error(i18n.t("creativePad.hydrating"));
    const config = useConfigStore.getState().config;
    const configuredModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "text" ? config.textModel : config.audioModel;
    const model = options.model || resolveModelForCapability(config, configuredModel, capability);
    if (!useConfigStore.getState().isAiConfigReady(config, model)) throw new CreativeConfigMissingError();

    const imageSize = options.imageSize || config.size || defaultConfig.size;
    const imageQuality = options.imageQuality || config.quality || defaultConfig.quality;
    const imageCount = options.imageCount || config.canvasImageCount || config.count || defaultConfig.count;
    const videoSize = options.videoSize || normalizeVideoSizeValue(config.size);
    const videoSeconds = options.videoSeconds || config.videoSeconds || defaultConfig.videoSeconds;
    const videoResolution = options.videoResolution || config.vquality || defaultConfig.vquality;

    // 会话内多轮：显式传入 projectId 时复用同一张画布（节点追加，不重建、不改标题）；
    // 未传时保持原行为——每次提交一张新画布。
    const existingProject = options.projectId ? canvas.projects.find(item => item.id === options.projectId) : undefined;
    if (options.projectId && !existingProject) throw new Error(i18n.t("creativePad.conversationCanvasMissing"));
    const id = existingProject ? existingProject.id : canvas.createProject(creativeProjectTitle(text));
    const imageRefs = references.filter(item => item.mediaType === "image" && (item.storageKey || item.url || item.dataUrl));
    const referenceNodes: CanvasNodeData[] = imageRefs.map((item, index) => ({
        id: nanoid(),
        type: "image",
        title: item.title,
        position: { x: 40, y: 40 + index * 300 },
        width: 320,
        height: Math.max(180, Math.min(360, 320 * ((item.height || 1) / Math.max(1, item.width || 1)))),
        metadata: {
            content: item.url || item.dataUrl || item.coverUrl,
            storageKey: item.storageKey,
            status: "success",
            naturalWidth: item.width || undefined,
            naturalHeight: item.height || undefined,
            bytes: item.bytes || undefined,
            mimeType: item.mimeType || "image/png",
        },
    }));
    const audioParams = {
        voice: config.audioVoice || defaultConfig.audioVoice,
        format: config.audioFormat || defaultConfig.audioFormat,
        speed: config.audioSpeed || defaultConfig.audioSpeed,
        instructions: config.audioInstructions || defaultConfig.audioInstructions,
    };
    const configNodeId = nanoid();
    const comfyParams = options.comfyParams;
    const generationMetadata: CanvasNodeMetadata = capability === "image"
        ? { smart: true, generationMode: "image", prompt: text, composerContent: text, model, status: "idle", generationType: imageRefs.length ? "edit" : "generation", count: getGenerationCount(imageCount), size: imageSize, quality: imageQuality, ...(comfyParams ? { comfyParams } : {}), ...(options.imageRunTarget ? { imageRunTarget: options.imageRunTarget } : {}) }
        : capability === "video"
            ? { smart: true, generationMode: "video", prompt: text, composerContent: text, model, status: "idle", generationType: "generation", size: videoSize, seconds: videoSeconds, vquality: videoResolution, ...(comfyParams ? { comfyParams } : {}), ...(options.videoRunTarget ? { videoRunTarget: options.videoRunTarget } : {}), ...(options.videoGenerateAudio ? { generateAudio: options.videoGenerateAudio } : {}), ...(options.videoWatermark ? { watermark: options.videoWatermark } : {}) }
            : capability === "text"
                ? { smart: true, generationMode: "text", prompt: text, composerContent: text, model, status: "idle", textCount: 1 }
                : { smart: true, generationMode: "audio", prompt: text, composerContent: text, model, status: "idle", audioVoice: audioParams.voice, audioFormat: audioParams.format, audioSpeed: audioParams.speed, audioInstructions: audioParams.instructions, ...(comfyParams ? { comfyParams } : {}) };
    const configNode: CanvasNodeData = {
        id: configNodeId,
        type: "config",
        title: creativeProjectTitle(text, 18),
        position: { x: 480, y: 40 },
        width: 380,
        height: 300,
        metadata: generationMetadata,
    };
    const connections: CanvasConnection[] = referenceNodes.map(node => ({ id: nanoid(), fromNodeId: node.id, toNodeId: configNodeId }));
    canvas.updateProject(id, {
        nodes: [...(existingProject?.nodes || []), ...referenceNodes, configNode],
        connections: [...(existingProject?.connections || []), ...connections],
    });
    await flushCanvasProjectBeforeGeneration(id);

    const commandReferences = imageRefs.map((item, index) => ({
        id: referenceNodes[index].id,
        name: `${item.title || item.id}.png`,
        type: item.mimeType || "image/png",
        dataUrl: item.storageKey ? "" : (item.dataUrl || item.url || ""),
        ...(item.url ? { url: item.url } : {}),
        ...(item.storageKey ? { storageKey: item.storageKey } : {}),
    }));
    const clientTaskId = crypto.randomUUID();
    const binding = { clientTaskId, idempotencyKey: clientTaskId, projectId: id, nodeId: configNodeId, sourceNodeId: configNodeId };
    const command = capability === "image"
        ? (() => {
            const size = resolveComfyImageSize(imageSize);
            return {
                mode: "image" as const, model, prompt: text, references: commandReferences,
                ...size, size: `${size.width}x${size.height}`, quality: imageQuality, count: getGenerationCount(imageCount),
                params: comfyParams, runTarget: options.imageRunTarget,
                ...binding,
            };
        })()
        : capability === "video"
            ? {
                mode: "video" as const, model, prompt: text, references: commandReferences,
                size: videoSize, seconds: videoSeconds, resolution: videoResolution,
                params: comfyParams, runTarget: options.videoRunTarget,
                ...binding,
            }
            : capability === "text"
                ? {
                    mode: "text" as const, model, prompt: text, count: 1, references: commandReferences,
                    params: {
                        ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
                        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
                    },
                    ...binding,
                }
                : {
                    mode: "audio" as const, model, prompt: text,
                    audioReferences: [],
                    params: { ...audioParams, ...comfyParams },
                    ...binding,
                };
    const started = await startCanvasGeneration(command);
    if (started.executor.startsWith("browser-") || started.task?.kind === "canvas-browser-script") kickCanvasBrowserTask(started.taskId);
    return { projectId: id, nodeId: configNodeId, taskId: started.taskId };
}