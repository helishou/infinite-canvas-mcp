import path from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { MEDIA_DIR } from "../config.js";
import type { RuntimeTask } from "../db.js";
import type { MediaStore, SettingStore, TaskPatch, TaskStore } from "../stores/types.js";
import type { BackendEventBus } from "../events.js";
import { splitVideo } from "./video-segment.js";
import { buildMotionContextClip } from "./motion-context.js";
import { assertIndependentMediaRoot, comfyInputName, copyComfyInput, resolveComfyRoot } from "./local-root.js";

/** ComfyUI Bridge 的总后台侧依赖：任务走 task store，URL 走 setting store。 */
export type ComfyUiDeps = {
    tasks: TaskStore;
    settings: SettingStore;
    media: MediaStore;
    events?: BackendEventBus;
    onTaskTerminal?: (task: RuntimeTask) => void | Promise<void>;
};

export type ComfyPreset = { id: string; name: string; kind: "image" | "video" | "audio"; inputs: string[]; params: string[] };
export type ComfyModelCatalog = { models: string[]; loras: string[]; textEncoders: string[]; videoVaes: string[]; audioVaes: string[]; latentUpscaleModels: string[]; nanfeng?: Record<string, unknown[]>; refreshedAt: string; error?: string };

const NANFENG_H3_CLASS = "NanFengH3MultiReferenceGeneratorV15";

const PRESETS: ComfyPreset[] = [
    { id: "z-image", name: "Z-Image 文生图", kind: "image", inputs: ["prompt"], params: ["width", "height", "seed"] },
    { id: "flux2-klein", name: "Flux2-Klein 图生图", kind: "image", inputs: ["prompt", "references"], params: ["width", "height", "seed"] },
    { id: "flashvsr-1.1", name: "FlashVSR 视频修复", kind: "video", inputs: ["video"], params: ["scale", "longEdge"] },
    { id: "indextts-2.5", name: "IndexTTS 2.5 配音", kind: "audio", inputs: ["prompt", "referenceAudio"], params: ["language", "speed", "seed", "filenamePrefix"] },
    { id: "minimax-h3", name: "H3导演台 视频生成", kind: "video", inputs: ["video", "references", "audios", "segments"], params: ["mode", "duration", "aspectRatio", "megapixels", "sizeMultiple", "steps", "denoise", "seed", "modelName", "textEncoder", "textEncoderType", "textEncoderDevice", "videoVae", "audioVae", "precision", "sageAttention", "allowCompile", "sampler", "scheduler", "loraSlots", "dedicatedAttention", "reservedVramGb", "runtimeReserveEnabled", "uniBlockSwapEnabled", "uniBlockSwapBlocks", "latentUpscaleEnabled", "h3FirstSteps", "h3SecondSteps", "h3FullSigma", "v81ManualSigma", "latentUpscaleModel", "latentUpscaleMegapixels", "latentUpscaleAlign", "latentUpscalePrecision", "realtimePreviewEnabled", "realtimePreviewLongEdge", "realtimePreviewFrames", "realtimePreviewFps", "realtimePreviewJpegQuality", "rtxEnabled", "rtxResizeMode", "rtxScale", "rtxWidth", "rtxHeight", "rtxQuality", "faceRefineEnabled", "faceRefineDetector", "faceRefineConfidence", "faceRefineCropFactor", "faceRefineCanvasSize", "faceRefineDenoise", "faceRefineSteps", "faceRefineSampler", "faceRefineScheduler", "faceRefinePasteRegion", "faceRefineMaskDilation", "faceRefineFeather", "faceRefineColourMatch", "faceRefineBlend", "slaEnabled", "slaSparsity", "slaBlockSize", "slaMinSequence", "slaDenseLastSteps", "slaProtectAudio", "slaDenseSteps", "slaBackend", "slaDisableFp16Accum", "slaStabilizeMotion", "lockAudio", "audioDrive", "audioDriveFile", "audioDriveMarkers", "audioDriveSegmentImages", "audioDriveSegmentStoryboards", "audioDriveCreative", "audioDriveExclude", "audioDriveStart", "audioDriveEnd", "emptyFiveMinuteTimeline", "taeh3Enabled", "motionContextEnabled", "contextLength", "audioContextLength", "continuationTask", "continuationAudioRefineEnabled", "continuationAudioDenoise", "continuationAudioSteps", "continuationAudioSampler", "continuationAudioScheduler", "trtVideoVaeEnabled", "trtDecoderEngine", "trtEncoderEngine", "dlssUpscaleMode", "dlssFrameInterpolationEnabled", "dlssVideoUpscaleMode", "dlssVideoRequireNeuralUpscaling", "dlssVideoNrPreset", "dlssVideoNrStyle", "dlssVideoNrIntensity", "dlssVideoLocalToneStrength", "dlssVideoLocalStructureStrength", "dlssVideoSkinStructureStrength", "dlssVideoAutomaticMask", "dlssVideoModelPreset", "dlssVideoEncodingQuality", "dlssVideoCodec", "dlssVideoContainer", "dlssVideoRename", "dlssVideoCustomSuffix", "dlssVideoHdrMode", "dlssVideoOutputDetailStrength", "dlssFgOutputFps", "dlssFgEngine", "dlssFgEncodingQuality", "dlssFgVideoCodec", "dlssFgContainer", "dlssFgRename", "dlssFgCustomSuffix", "dlssFgHdrMode", "erSolverType", "erMaxStage", "erEta", "erSNoise", "constantTriggerWord"] },
];

/** 从 ComfyUI 任务历史的状态对象中抽取可读的错误信息。
 * ComfyUI 节点执行失败时，status.messages 里含 ["execution_error", { node_id, node_type, exception_message, ... }]。 */
function extractComfyErrorMessage(status: any): string {
    if (!status) return "ComfyUI 执行失败（无状态信息）";
    const messages: unknown[] = Array.isArray(status.messages) ? status.messages : [];
    for (const entry of messages) {
        if (Array.isArray(entry) && entry.length >= 2 && entry[0] === "execution_error") {
            const data = entry[1] as Record<string, unknown>;
            const where = data.node_type ? `节点 ${data.node_id ?? "?"} (${data.node_type})` : `节点 ${data.node_id ?? "?"}`;
            const msg = data.exception_message || data.exception_type || "未知错误";
            return `ComfyUI ${where} 报错：${msg}`;
        }
    }
    if (typeof status.status_str === "string") return `ComfyUI 执行失败（${status.status_str}）`;
    try { return `ComfyUI 执行失败：${JSON.stringify(status).slice(0, 1500)}`; } catch { return "ComfyUI 执行失败"; }
}

export type H3ActualSubmission = {
    promptId: string;
    seed?: number;
    frames?: number;
    width?: number;
    height?: number;
    loras?: Array<{ name: string; strength: number }>;
    attention?: string;
    sigma?: string;
    /**
     * 实际进入 prompt 图的媒体槽位（图片N/视频N/音频N）。
     * 之前只记模型/LoRA/步数/尺寸，导致「上一段成品被当成视频1 塞进来」这类
     * 隐式注入在 UI 的「实际提交配置」和生成日志里完全看不出来。
     */
    mediaInputs?: { images: string[]; videos: string[]; audios: string[] };
};

export type H3LivePreview = { promptId: string; dataUrl: string; step?: number; total?: number; mime?: string };

/** 只接受目标 promptId 的历史记录；绝不按时间猜测其他任务的输出。 */
export function exactHistoryEntry(history: Record<string, any>, promptId: string): Record<string, any> | undefined {
    return history[promptId];
}

export function attachH3ActualSubmission(result: Record<string, any>, actualSubmission: H3ActualSubmission | undefined, promptId: string) {
    return actualSubmission ? { ...result, actualSubmission: { ...actualSubmission, promptId } } : result;
}

/** 从最终 API prompt 图提取审计值，避免日志只反映 UI 的原始字段。 */
export function summarizeH3Workflow(workflow: Record<string, any>, promptId: string): H3ActualSubmission {
    const nodes = Object.values(workflow) as Array<{ class_type?: string; inputs?: Record<string, any> }>;
    const native = nodes.find((node) => node.class_type === NANFENG_H3_CLASS)?.inputs;
    if (native) {
        const requestedRatio = String(native["画面比例"] || "16:9");
        const ratio = normalizeH3AspectRatio(requestedRatio);
        const megapixels = Number(native["百万像素"] || 0.4), multiple = Number(native["尺寸倍数"] || 32);
        const width = Math.max(32, Math.round(Math.sqrt(megapixels * 1024 * 1024 * ratioWidth(ratio) / ratioHeight(ratio)) / multiple) * multiple);
        const loras = Array.from({ length: 8 }, (_, index) => ({ name: String(native[`LoRA${index + 1}`] || ""), strength: Number(native[`LoRA${index + 1}强度`] ?? 1), enabled: native[`LoRA${index + 1}启用`] === true })).filter((item) => item.enabled && item.name && item.name !== "未选择").map(({ name, strength }) => ({ name, strength }));
        const manual = native["V81一采使用手动Sigma"] === true ? native["H3完整Sigma序列"] : native["西格玛模式"] === "手动序列" ? native["手动西格玛"] : "";
        const mediaInputs = { images: pickNativeSlots(native, "图片", 9), videos: pickNativeSlots(native, "视频", 3), audios: pickNativeSlots(native, "音频", 3) };
        return { promptId, seed: Number(native["随机种子"]), frames: durationToFrames(Number(native["时长秒"] || 5)), ...(requestedRatio === "原图比例" ? {} : { width, height: Math.max(32, Math.round(width * ratioHeight(ratio) / ratioWidth(ratio) / multiple) * multiple) }), ...(loras.length ? { loras } : {}), attention: native["启用H3 SLA"] === true ? "H3 SLA" : String(native.SageAttention || "disabled"), sigma: manual ? `手动：${String(manual)}` : `调度器：${String(native["调度器"] || "")} / ${Number(native["采样步数"] || 0)} 步`, mediaInputs };
    }
    const inputsOf = (type: string) => nodes.find((node) => node.class_type === type)?.inputs || {};
    const condition = nodes.find((node) => node.class_type === "MiniMaxH3ReferenceToVideo" || node.class_type === "MiniMaxH3ImageToVideo")?.inputs || {};
    const loras = nodes.filter((node) => node.class_type === "LoraLoaderModelOnly").flatMap((node) => {
        const name = String(node.inputs?.lora_name || "").trim();
        return name ? [{ name, strength: Number(node.inputs?.strength_model ?? 0.75) }] : [];
    });
    const sage = nodes.find((node) => node.class_type === "PathchSageAttentionKJ")?.inputs?.sage_attention;
    const attention = nodes.some((node) => node.class_type === "MiniMaxH3MemoryEfficientSageAttentionPatch") ? "H3专用Sage加速" : sage ? String(sage) : "disabled";
    const manual = nodes.find((node) => node.class_type === "ManualSigmas")?.inputs?.sigmas;
    const scheduler = inputsOf("BasicScheduler");
    return {
        promptId,
        seed: Number(inputsOf("RandomNoise").noise_seed),
        frames: Number(condition.length),
        width: Number(condition.width),
        height: Number(condition.height),
        ...(loras.length ? { loras } : {}),
        attention,
        sigma: manual ? `手动：${String(manual)}` : `调度器：${String(scheduler.scheduler || "")} / ${Number(scheduler.steps || 0)} 步`,
        mediaInputs: {
            images: nodes.filter((node) => node.class_type === "LoadImage").map((node) => String(node.inputs?.image || "")).filter(Boolean),
            videos: nodes.filter((node) => node.class_type === "LoadVideo").map((node) => String(node.inputs?.file || node.inputs?.video || "")).filter(Boolean),
            audios: nodes.filter((node) => node.class_type === "LoadAudio").map((node) => String(node.inputs?.audio || "")).filter(Boolean),
        },
    };
}

/** 读取南风 V10 主节点上真正落到槽位里的媒体名（图片1..9 / 视频1..3 / 音频1..3），跳过「未选择」。 */
function pickNativeSlots(native: Record<string, any>, prefix: string, count: number) {
    return Array.from({ length: count }, (_, index) => String(native[`${prefix}${index + 1}`] ?? "").trim()).filter((value) => value && value !== "未选择");
}

/** 总后台侧 ComfyUI Bridge：任务持久化统一走总后台 SQLite。 */
export class ComfyUiBackend {
    private url: string;
    private readonly deps: ComfyUiDeps;
    private readonly controllers = new Map<string, AbortController>();
    private readonly comfyExecutions = new Map<string, { url: string; promptId?: string }>();
    private readonly livePreviews = new Map<string, H3LivePreview>();
    private readonly pendingPreviews = new Map<string, Omit<H3LivePreview, "promptId">>();

    constructor(deps: ComfyUiDeps, baseUrl?: string) {
        this.deps = deps;
        const fallback = String(deps.settings.get("comfyui.url") || "http://127.0.0.1:8188");
        this.url = normalizeUrl((baseUrl ?? process.env.COMFYUI_URL) || fallback);
    }

    getUrl() { return this.url; }
    getLivePreview(taskId: string) { return this.livePreviews.get(taskId); }
    setUrl(url: string) { this.url = normalizeUrl(url); this.deps.settings.set("comfyui.url", this.url); return this.url; }
    localH3DirectConfig() {
        const rootDir = String(this.deps.settings.get("comfyui.localRootDir") || "");
        const inputDir = rootDir ? path.join(rootDir, "input") : "";
        const cacheDir = inputDir ? path.join(inputDir, "infinite-canvas-cache") : "";
        let ready = false;
        try { resolveComfyRoot(rootDir); assertIndependentMediaRoot(MEDIA_DIR, rootDir); ready = true; } catch {}
        return { rootDir, inputDir, cacheDir, mediaDir: MEDIA_DIR, ready };
    }
    setLocalH3ComfyRoot(rootDir: string) {
        const root = resolveComfyRoot(rootDir);
        assertIndependentMediaRoot(MEDIA_DIR, root);
        this.deps.settings.set("comfyui.localRootDir", root);
        return this.localH3DirectConfig();
    }
    presets() { return PRESETS; }

    /**
     * ComfyUI exposes model-folder choices through object_info. Reading these
     * choices instead of maintaining a hard-coded list preserves the exact
     * relative paths (including subfolders) that the loaders accept.
     */
    async models(signal?: AbortSignal): Promise<ComfyModelCatalog> {
        const errors: string[] = [];
        const readChoices = async (node: string, input: string) => {
            try {
                const response = await fetch(`${this.url}/object_info/${node}`, { signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const body = await response.json() as Record<string, any>;
                const choices = body[node]?.input?.required?.[input]?.[0];
                return Array.isArray(choices) ? choices.map(String).filter(Boolean) : [];
            } catch (error) {
                errors.push(`${node}: ${error instanceof Error ? error.message : String(error)}`);
                return [];
            }
        };
        const readNanFengChoices = async () => {
            try {
                const response = await fetch(`${this.url}/object_info/${NANFENG_H3_CLASS}`, { signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const body = await response.json() as Record<string, any>;
                const required = body[NANFENG_H3_CLASS]?.input?.required || {};
                return Object.fromEntries(Object.entries(required).map(([key, value]: [string, any]) => [key, Array.isArray(value?.[0]) ? value[0] : []]));
            } catch (error) {
                errors.push(`${NANFENG_H3_CLASS}: ${error instanceof Error ? error.message : String(error)}`);
                return {};
            }
        };
        const [models, loras, loraModelOnly, nanfengLoras, textEncoders, videoVaes, audioVaes, latentUpscaleModels, nanfeng] = await Promise.all([
            readChoices("UNETLoader", "unet_name"),
            readChoices("LoraLoader", "lora_name"),
            readChoices("LoraLoaderModelOnly", "lora_name"),
            readChoices(NANFENG_H3_CLASS, "LoRA1"),
            readChoices("CLIPLoader", "clip_name"),
            readChoices("VAELoader", "vae_name").then((values) => values.filter((value) => /minimax_h3_video_vae/i.test(value))),
            readChoices("VAELoader", "vae_name").then((values) => values.filter((value) => /minimax_h3_audio_vae/i.test(value))),
            readChoices("NanFengH3LowPeakLatentUpscalerV15", "model_name"),
            readNanFengChoices(),
        ]);
        const h3Models = models.filter(isH3ModelPath);
        const minimaxLoras = [...loras, ...loraModelOnly, ...nanfengLoras].filter(isMinimaxLoraPath);
        const minimaxTextEncoders = textEncoders.filter((value) => /minimax/i.test(value));
        return { models: [...new Set(h3Models)].sort((a, b) => a.localeCompare(b)), loras: [...new Set(minimaxLoras)].sort((a, b) => a.localeCompare(b)), textEncoders: [...new Set(minimaxTextEncoders)].sort((a, b) => a.localeCompare(b)), videoVaes: [...new Set(videoVaes)].sort((a, b) => a.localeCompare(b)), audioVaes: [...new Set(audioVaes)].sort((a, b) => a.localeCompare(b)), latentUpscaleModels: [...new Set(latentUpscaleModels)].sort((a, b) => a.localeCompare(b)), nanfeng, refreshedAt: new Date().toISOString(), ...(errors.length ? { error: errors.join("; ") } : {}) };
    }

    async status() {
        try {
            const response = await fetch(`${this.url}/system_stats`);
            return { connected: response.ok, url: this.url, system: response.ok ? await response.json() : null, error: response.ok ? null : `HTTP ${response.status}` };
        } catch (error) { return { connected: false, url: this.url, system: null, error: error instanceof Error ? error.message : String(error) }; }
    }

    /**
     * 读取指定 ComfyUI 节点所有 COMBO 类型输入的选项列表。
     * 返回 { input_name: [choice, ...] }，仅包含 COMBO；不可达时返回空对象。
     */
    async getNodeComboOptions(classType: string, signal?: AbortSignal): Promise<Record<string, string[]>> {
        const cleanClass = classType.split("//")[0].trim();
        if (!cleanClass) return {};
        try {
            const response = await fetch(`${this.url}/object_info/${encodeURIComponent(cleanClass)}`, { signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = (await response.json()) as Record<string, any>;
            const required = body[cleanClass]?.input?.required || {};
            const optional = body[cleanClass]?.input?.optional || {};
            const result: Record<string, string[]> = {};
            for (const [inputs] of [[required], [optional]] as const) {
                for (const [key, value] of Object.entries(inputs)) {
                    if (!Array.isArray(value) || value.length === 0) continue;
                    const first = value[0];
                    let choices: unknown[] | null = null;
                    if (Array.isArray(first)) {
                        // 旧格式：第一元素直接是选项数组，如 ["1:1", "2:3", ...]
                        choices = first;
                    } else if (typeof first === "string" && first.toUpperCase() === "COMBO") {
                        // 新格式：type 为字符串 "COMBO"，选项在第二个元素的 options 里
                        // 如 ["COMBO", { "options": [...], "default": "...", "multiselect": false }]
                        const cfg = value[1] as Record<string, unknown> | undefined;
                        const opts = cfg?.options;
                        if (Array.isArray(opts)) choices = opts;
                    }
                    if (!choices || choices.length === 0) continue;
                    result[key] = choices.map(String).filter((v) => v !== undefined && v !== null);
                }
            }
            return result;
        } catch (error) {
            console.warn(`[comfyui] getNodeComboOptions ${cleanClass} failed:`, error instanceof Error ? error.message : String(error));
            return {};
        }
    }

    async run(preset: string, input: Record<string, unknown>, params: Record<string, unknown>, baseUrl?: string, clientTaskId?: string, onCreated?: (task: RuntimeTask) => Promise<void> | void) {
        const definition = PRESETS.find((item) => item.id === preset);
        if (!definition) throw new Error(`Unknown ComfyUI preset: ${preset}`);
        const taskUrl = baseUrl ? normalizeUrl(baseUrl) : this.url;
        // 客户端预生成 taskId：让前端在「请求还没回到后端」时就能把 ID 写进节点元数据，
        // 避免用户刷新瞬间 race 造成 `runtimeTaskId` 丢失、节点被误判为「中断」。
        const existing = clientTaskId ? this.deps.tasks.get(clientTaskId) : null;
        if (existing) return existing;
        const task = clientTaskId
            ? this.deps.tasks.create(clientTaskId, `comfyui:${preset}`, input, params)
            : this.deps.tasks.create(`comfyui:${preset}`, input, params);
        await onCreated?.(task);
        void this.execute(task, definition, taskUrl).catch((error) => this.fail(task.id, error));
        return task;
    }

    cancel(id: string) {
        this.controllers.get(id)?.abort();
        void this.cancelComfyExecution(id);
        const task = this.deps.tasks.cancel(id);
        this.deps.events?.publish({ type: "task.updated", entityId: id, payload: task });
        void this.deps.onTaskTerminal?.(task);
        return task;
    }

    private readonly resuming = new Set<string>();

    /**
     * backend 重启（tsx --watch 源码变更等）会杀掉内存中的执行循环，遗留 status=running 的任务
     * 永远无人跟踪。这里懒恢复：GET 任务时发现 running/queued 且本进程没有活跃执行，
     * 就用 task_events 里 "submitted" 事件记录的 promptId 重新挂一个 /history 观察循环，
     * 任务真正跑完后照常回写结果，前端轮询方（已加重试）无需感知重启。
     */
    resume(id: string) {
        const task = this.deps.tasks.get(id);
        if (!task || !["queued", "running"].includes(task.status) || this.comfyExecutions.has(id) || this.resuming.has(id)) return;
        const promptId = this.deps.tasks.events(id).find((event) => event.type === "submitted")?.payload?.promptId;
        if (typeof promptId !== "string" || !promptId) return; // 从未提交到 ComfyUI，无法恢复
        this.resuming.add(id);
        this.comfyExecutions.set(id, { url: this.url, promptId });
        const controller = new AbortController();
        this.controllers.set(id, controller);
        void this.watchRecovered(id, this.url, promptId, controller)
            .catch((error) => this.fail(id, error))
            .finally(() => { this.controllers.delete(id); this.comfyExecutions.delete(id); this.resuming.delete(id); });
    }

    /** 重启恢复专用的观察循环：只依赖 /history（无 WS 通道），ComfyUI 自身没重启就能等到结果。 */
    private async watchRecovered(taskId: string, comfyUrl: string, promptId: string, controller: AbortController) {
        const started = Date.now();
        const submitted = this.deps.tasks.events(taskId).find((event) => event.type === "submitted")?.payload as { actualSubmission?: H3ActualSubmission } | undefined;
        for (;;) {
            if (controller.signal.aborted) return;
            await new Promise((resolve) => setTimeout(resolve, 2000));
            try {
                const response = await fetch(`${comfyUrl}/history/${encodeURIComponent(promptId)}`, { signal: controller.signal });
                if (response.ok) {
                    const history = await response.json() as Record<string, any>;
                    const item = exactHistoryEntry(history, promptId);
                    const statusStr = item?.status?.status_str;
                    if (statusStr === "error" || statusStr === "failed") throw new Error(extractComfyErrorMessage(item?.status));
                    const hasOutputs = !!(item?.outputs && typeof item.outputs === "object" && Object.keys(item.outputs).length > 0);
                    if (statusStr === "success" || item?.status?.completed || hasOutputs) {
                        if (!hasOutputs) throw new Error(`ComfyUI 执行结束但未产出任何输出，节点可能执行失败：${extractComfyErrorMessage(item?.status)}`);
                        const result = attachH3ActualSubmission({ promptId, outputs: item!.outputs, media: await collectOutputMedia(item!.outputs, comfyUrl, this.deps.media, controller.signal), status: item!.status || {} }, submitted?.actualSubmission, promptId);
                        this.updateTask(taskId, { status: "succeeded", progress: 1, result });
                        this.deps.tasks.addEvent(taskId, "result", result);
                        return;
                    }
                }
            } catch (error) {
                if (controller.signal.aborted) return;
                // 瞬时网络错误（ComfyUI 抖动）继续等；确定性失败向上抛给 fail()
                if (!(error instanceof Error) || /fetch failed|HTTP \d+|ECONN|socket/i.test(error.message)) continue;
                throw error;
            }
            if (Date.now() - started > 60 * 60 * 1000) throw new Error(`恢复观察超时（1 小时）：目标 promptId ${promptId} 的 history 与 WebSocket 输出均不可用；未写入任何媒体，可从 ComfyUI 输出目录按 promptId 手动恢复。`);
        }
    }

    private async execute(task: RuntimeTask, preset: ComfyPreset, comfyUrl: string) {
        if (this.deps.tasks.get(task.id)?.status === "cancelled") return;
        const controller = new AbortController(); this.controllers.set(task.id, controller);
        this.comfyExecutions.set(task.id, { url: comfyUrl });
        let executionCacheCleared = false;
        try {
            this.updateTask(task.id, { status: "running", progress: 0.05 });
            this.deps.tasks.addEvent(task.id, "status", { status: "running" });
            const result = preset.id === "minimax-h3" && task.params.autoSplit === true && typeof task.input.video === "string"
                ? await this.executeH3Segments(task, preset.id, task.input, task.params, comfyUrl, controller)
                : await this.executeWorkflow(task, preset.id, task.input, task.params, comfyUrl, controller);
            if (preset.id === "minimax-h3") {
                await this.clearComfyExecutionCache(comfyUrl);
                executionCacheCleared = true;
            }
            this.updateTask(task.id, { status: "succeeded", progress: 1, result });
            this.deps.tasks.addEvent(task.id, "result", result);
        } finally {
            if (preset.id === "minimax-h3" && !executionCacheCleared) {
                try { await this.clearComfyExecutionCache(comfyUrl); } catch (error) { console.warn("[comfyui] H3 执行缓存清理失败:", error instanceof Error ? error.message : String(error)); }
            }
            this.controllers.delete(task.id); this.comfyExecutions.delete(task.id);
        }
    }

    /** 清掉 ComfyUI 的执行上下文和 CUDA allocator 缓存，但保留 H3 模型，避免下一 Clip 重新加载模型。 */
    private async clearComfyExecutionCache(comfyUrl: string) {
        const response = await fetch(`${comfyUrl}/free`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ unload_models: false, free_memory: true }),
        });
        if (!response.ok) throw new Error(`ComfyUI /free failed: HTTP ${response.status}`);
    }

    private async executeH3Segments(task: RuntimeTask, preset: string, input: Record<string, unknown>, params: Record<string, unknown>, comfyUrl: string, controller: AbortController) {
        const duration = Math.max(1, Math.min(15, Number(params.segmentDuration || params.duration || 6)));
        const split = await splitVideo(String(input.video), duration, Math.max(1, Math.min(240, Number(params.maxSegments || 60))));
        const segments: Array<Record<string, unknown>> = [];
        const localResults: string[] = [];
        let previousVideo = "";
        try {
            for (const [index, file] of split.files.entries()) {
                const result = await this.executeWorkflow(task, preset, { ...input, video: file, ...(previousVideo ? { previousVideo } : {}) }, { ...params, motionContext: index > 0 && params.motionContext !== false }, comfyUrl, controller);
                const media = Array.isArray(result.media) ? result.media : [];
                segments.push({ index, ...result, media });
                const video = media.find((item) => String((item as Record<string, unknown>).mimeType || "").startsWith("video/")) as Record<string, unknown> | undefined;
                if (video?.url) previousVideo = await materializeComfyMedia(String(video.url), comfyUrl, path.join(path.dirname(file), `result-${index + 1}.mp4`));
                if (previousVideo) localResults.push(previousVideo);
                this.updateTask(task.id, { progress: Math.min(0.95, (index + 1) / split.files.length) });
                this.deps.tasks.addEvent(task.id, "segment_result", { index, promptId: result.promptId, media });
            }
            const segmentMedia = segments.flatMap((segment) => Array.isArray(segment.media) ? segment.media : []);
            const actualSubmission = segments.length ? segments[segments.length - 1].actualSubmission : undefined;
            const combined = localResults.length > 1 ? await concatLocalVideos(localResults) : undefined;
            if (!combined) return actualSubmission ? { segments, media: segmentMedia, actualSubmission } : { segments, media: segmentMedia };
            const stored = this.deps.media.store(await readFile(combined), { name: path.basename(combined), mimeType: "video/mp4", category: "output" });
            await rm(combined, { force: true });
            const result = { segments, media: [{ url: this.deps.media.url(stored), storageKey: stored.storageKey, mimeType: stored.mimeType, filename: path.basename(combined) }, ...segmentMedia] };
            return actualSubmission ? { ...result, actualSubmission } : result;
        } finally { await split.cleanup(); }
    }

    private async executeWorkflow(task: RuntimeTask, preset: string, input: Record<string, unknown>, params: Record<string, unknown>, comfyUrl: string, controller: AbortController) {
        const prepared = preset === "minimax-h3"
            ? { input, cleanup: async () => undefined }
            : await prepareH3MotionContext(input, params);
        // 提前声明 WebSocket 相关变量（置于 try 之前），避免早期异常触发 finally 时
        // closeWs 仍处于 TDZ（const 尚未初始化）而抛出 "closeWs is not defined"，掩盖真实错误。
        let capturedPromptId: string | null = null;
        let ws: any = null;
        let wsExecuted = false;
        let wsExecutedAt = 0;
        let wsError: Error | null = null;
        let wsOutputs: any = null;
        let wsExecutionSuccessOutputs: any = null;
        let wsExecutionSuccessAt = 0;
        let wsClosed = false;
        let wsCloseError: Error | null = null;
        let closeWs: () => void = () => {};
        try {
            const uploadFn = preset === "minimax-h3"
                ? (file: string) => this.localH3Input(file, controller.signal, comfyUrl)
                : (file: string) => this.upload(file, controller.signal, comfyUrl);
            const workflow = preset === "minimax-h3"
                ? await buildNativeNanFengV15Workflow(prepared.input, params, uploadFn, comfyUrl, controller.signal)
                : await buildWorkflow(preset, prepared.input, params, uploadFn);
            const actualSubmission = preset === "minimax-h3" ? summarizeH3Workflow(workflow, "") : undefined;
            const withActualSubmission = (result: Record<string, any>, promptId: string) => attachH3ActualSubmission(result, actualSubmission, promptId);

            // 在提交 /prompt 之前就建立 ComfyUI WebSocket 并监听 executed 事件。
            // 关键修复：ComfyUI 的 executed 消息本身直接携带 outputs（文件名/路径），
            // 无需再去查 /history——后者是有限队列（默认仅保留最近若干条），任务一多或
            // 间隔稍长就被清理，导致"跑完了但取不回结果/历史记录找不到"的回写失败。
            // 这里把 outputs 直接缓存下来，作为回写的主路径。
            const Ctor = (globalThis as any).WebSocket;
            if (typeof Ctor === "function") {
                try {
                    const wsBase = comfyUrl.replace(/^http/, "ws");
                    const socket = new Ctor(`${wsBase}/ws?clientId=${encodeURIComponent(task.id)}`);
                    socket.onmessage = (event: any) => {
                        try {
                            const raw = typeof event.data === "string" ? event.data : (event.data != null ? String(event.data) : "");
                            if (!raw) return;
                            const msg = JSON.parse(raw);
                            if (!msg?.type) return;
                            if (msg.type === "kj_preview_override") {
                                const data = (msg.data || msg) as Record<string, unknown>;
                                const encoded = typeof data?.image === "string" ? data.image : "";
                                // KJ 没有在自定义预览事件里重复 prompt_id；该 WS 使用本 task 专属 clientId，
                                // 且要求 /prompt 已返回当前 promptId，故事件归属仍是一对一的。
                                if (encoded) {
                                    const preview = {
                                    dataUrl: `data:${typeof data?.mime === "string" ? data.mime : "image/jpeg"};base64,${encoded}`,
                                    ...(Number.isFinite(Number(data?.step)) ? { step: Number(data?.step) } : {}),
                                    ...(Number.isFinite(Number(data?.total)) ? { total: Number(data?.total) } : {}),
                                    ...(typeof data?.mime === "string" ? { mime: data.mime } : {}),
                                    };
                                    if (capturedPromptId) this.livePreviews.set(task.id, { promptId: capturedPromptId, ...preview });
                                    else this.pendingPreviews.set(task.id, preview);
                                }
                                return;
                            }
                            // 只处理与当前 prompt_id 相关的事件，避免历史/别人的事件干扰
                            if (!capturedPromptId || msg?.data?.prompt_id !== capturedPromptId) {
                                // 仍然记录 execution_success 的 prompt_id 匹配失败，但不接管
                                return;
                            }
                            if (msg.type === "executed" || msg.type === "execution_success") {
                                wsExecuted = true; wsExecutedAt = Date.now();
                                // 多输出节点的工作流（如 Z-Image 的 PreviewImage + rgthree Image Comparer）
                                // 每个节点都会发 executed；若直接覆盖，后执行节点的 outputs 会顶掉先执行的，
                                // 若最后执行的节点用非标准键（rgthree 用 a_images/b_images）就会得到空媒体。
                                // 这里按节点合并而非覆盖（execution_success 在当前 ComfyUI 只带 prompt_id，无 output）。
                                if (msg.data?.output && typeof msg.data.output === "object") wsOutputs = { ...(wsOutputs || {}), ...(msg.data.output as Record<string, unknown>) };
                                // execution_success（v1.5+）payload 才是整个 graph 的 outputs，executed 只是单节点。
                                // 同时记录一份合并视图，优先用 execution_success 的 outputs。
                                if (msg.type === "execution_success" && msg.data?.output && typeof msg.data.output === "object") {
                                    wsExecutionSuccessOutputs = msg.data.output;
                                    wsExecutionSuccessAt = Date.now();
                                }
                            } else if (msg.type === "execution_error") {
                                const d = msg.data || {};
                                wsError = new Error(`ComfyUI 节点 ${d.node_id ?? "?"} (${d.node_type ?? "?"}) 报错：${d.exception_message || d.exception_type || "未知错误"}`);
                            }
                        } catch {}
                    };
                    // 监听 WS 异常/关闭：之前没 onerror/onclose handler，连接静默断掉时 for 循环
                    // 不知道，单纯靠 /history 兜底。但 ComfyUI 的 /history 是 LRU（默认 10000 条），
                    // 任务一多就会被挤掉，导致"WebSocket 早断了 / 之后 /history 找不到 / 3 分钟后抛错"。
                    // 这里记录错误，for 循环会看到 wsClosed 提前 fail。
                    socket.onerror = () => { wsCloseError = new Error("ComfyUI WebSocket 连接出错，可能被代理/防火墙中断"); };
                    socket.onclose = (event: any) => {
                        wsClosed = true;
                        if (!wsCloseError && event?.code && event.code !== 1000) {
                            wsCloseError = new Error(`ComfyUI WebSocket 异常关闭 (code ${event.code}${event.reason ? `: ${event.reason}` : ""})`);
                        }
                    };
                    ws = socket;
                } catch {}
            }
            closeWs = () => { try { ws?.close(); } catch {} };

            const response = await fetch(`${comfyUrl}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: task.id }), signal: controller.signal });
            if (!response.ok) { const details = (await response.text()).trim().replace(/\s+/g, " ").slice(0, 4000); throw new Error(`ComfyUI /prompt failed: HTTP ${response.status}${details ? `: ${details}` : ""}`); }
            const body = await response.json() as { prompt_id?: string; node_errors?: unknown };
            if (!body.prompt_id) throw new Error(body.node_errors ? JSON.stringify(body.node_errors) : "ComfyUI did not return prompt_id");
            const promptId: string = body.prompt_id;
            capturedPromptId = promptId;
            const pendingPreview = this.pendingPreviews.get(task.id);
            if (pendingPreview) {
                this.livePreviews.set(task.id, { promptId, ...pendingPreview });
                this.pendingPreviews.delete(task.id);
            }
            const execution = this.comfyExecutions.get(task.id);
            if (execution) execution.promptId = body.prompt_id;
            this.deps.tasks.addEvent(task.id, "submitted", actualSubmission ? { promptId: body.prompt_id, actualSubmission: { ...actualSubmission, promptId: body.prompt_id } } : { promptId: body.prompt_id });
            const startedAt = Date.now();
            const maxExecutionMs = Math.max(5 * 60 * 1000, Math.min(60 * 60 * 1000, Number(params.maxExecutionMs) || 30 * 60 * 1000));
            let missingHistoryCount = 0;
            let consecutiveMissingInQueue = 0;
            // 收到 executed 信号后，先直接用消息携带的 outputs 回写（绕过 /history 被清理的坑）；
            // 仅当 executed 没带 outputs 时才退回紧凑回查 history。
            const fetchHistoryNow = async (attempts = 10): Promise<any | undefined> => {
                for (let i = 0; i < attempts; i++) {
                    if (controller.signal.aborted) return undefined;
                    try {
                        const res = await fetch(`${comfyUrl}/history/${encodeURIComponent(promptId)}`, { signal: controller.signal });
                        if (res.ok) {
                            const history = await res.json() as Record<string, any>;
                            const item = exactHistoryEntry(history, promptId);
                            if (item && item.outputs && typeof item.outputs === "object" && Object.keys(item.outputs).length > 0) return item;
                            if (item && (item.status?.status_str === "error" || item.status?.status_str === "failed")) return item;
                        }
                    } catch {}
                    await new Promise((resolve) => setTimeout(resolve, 400));
                }
                return undefined;
            };
            for (;;) {
                if (controller.signal.aborted) { closeWs(); throw new Error("任务已取消"); }
                if (Date.now() - startedAt > maxExecutionMs) { closeWs(); throw new Error(`ComfyUI 任务执行超时（已超过 ${Math.round(maxExecutionMs / 60000)} 分钟），请检查 ComfyUI 是否仍在运行`); }
                if (wsError) { closeWs(); throw wsError; }
                // WebSocket 已确认任务完成：优先用 execution_success 事件（v1.5+ 推送的整个 graph outputs），
                // 没有就退回 executed 单节点 outputs；都没有再回 /history；
                if (wsExecuted) {
                    // 优先用 execution_success（whole-graph）outputs，回退到 executed（单节点）outputs
                    const useOutputs = (wsExecutionSuccessOutputs && typeof wsExecutionSuccessOutputs === "object" && Object.keys(wsExecutionSuccessOutputs).length > 0)
                        ? wsExecutionSuccessOutputs
                        : (wsOutputs && typeof wsOutputs === "object" && Object.keys(wsOutputs).length > 0 ? wsOutputs : null);
                    if (useOutputs) {
                        closeWs();
                        const media = await collectOutputMedia(useOutputs, comfyUrl, this.deps.media, controller.signal);
                        return withActualSubmission({ promptId: body.prompt_id, outputs: useOutputs, media, status: { status_str: "success", completed: true } }, body.prompt_id);
                    }
                    const item = await fetchHistoryNow();
                    if (item) {
                        const statusStr = item?.status?.status_str;
                        if (statusStr === "error" || statusStr === "failed") { closeWs(); throw new Error(extractComfyErrorMessage(item.status)); }
                        closeWs();
                        return withActualSubmission({ promptId: body.prompt_id, outputs: item!.outputs, media: await collectOutputMedia(item!.outputs, comfyUrl, this.deps.media, controller.signal), status: item!.status || {} }, body.prompt_id);
                    }
                    if (wsClosed) {
                        const reason = (wsCloseError as Error | null)?.message || "WebSocket 已关闭";
                        closeWs();
                        throw new Error(`ComfyUI ${reason}；目标 promptId ${body.prompt_id} 的 history 与 WebSocket 输出均不可用。未写入任何媒体，可从 ComfyUI 输出目录按 promptId 手动恢复。`);
                    }
                    // executed 没带 outputs 且 history 也取不到：再等一会，但不再走慢速 missing 计数
                    if (Date.now() - wsExecutedAt > 60000) { closeWs(); throw new Error(`ComfyUI 已在 WebSocket 中报告目标 promptId ${body.prompt_id} 完成，但 history 与 WebSocket 输出均不可用；未写入任何媒体。`); }
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    continue;
                }
                // WS 在我们拿到 executed 之前就关闭了：不再直接 fail，
                // 而是退回 /history 轮询——ComfyUI 可能已完成但 WS 因代理超时/负载高等原因提前断开，
                // 任务本身仍在执行或已完成，结果在 /history 或 /output 里。
                // 仅在 /history 也长期无果时才最终 fail，避免"ComfyUI 实际跑完了但前端收不到结果"。
                if (wsClosed && !wsExecuted) {
                    const reason = (wsCloseError as Error | null)?.message || "WebSocket 已关闭但未收到 executed 事件";
                    console.warn(`[comfyui] WS 提前断开，退回 /history 轮询：${reason}`);
                    // 不再 throw，继续走下面的 /history 轮询
                }
                const historyResponse = await fetch(`${comfyUrl}/history/${encodeURIComponent(body.prompt_id)}`, { signal: controller.signal });
                if (historyResponse.ok) {
                    const history = await historyResponse.json() as Record<string, any>;
                    const item = exactHistoryEntry(history, body.prompt_id);
                    const statusStr = item?.status?.status_str;
                    if (statusStr === "error" || statusStr === "failed") {
                        throw new Error(extractComfyErrorMessage(item?.status));
                    }
                    const hasOutputs = !!(item?.outputs && typeof item.outputs === "object" && Object.keys(item.outputs).length > 0);
                    if (statusStr === "success" || item?.status?.completed || hasOutputs) {
                        if (!hasOutputs) {
                            throw new Error(`ComfyUI 执行结束但未产出任何输出，节点可能执行失败：${extractComfyErrorMessage(item?.status)}`);
                        }
                        closeWs();
                        return withActualSubmission({ promptId: body.prompt_id, outputs: item!.outputs, media: await collectOutputMedia(item!.outputs, comfyUrl, this.deps.media, controller.signal), status: item!.status || {} }, body.prompt_id);
                    }
                    if (item === undefined || (typeof item === "object" && Object.keys(item).length === 0)) {
                        missingHistoryCount++;
                        if (missingHistoryCount > 120) {
                            try {
                                const queueResponse = await fetch(`${comfyUrl}/queue`, { signal: controller.signal });
                                if (queueResponse.ok) {
                                    const queue = await queueResponse.json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
                                    const entries = [...(queue.queue_running || []), ...(queue.queue_pending || [])];
                                    const stillQueued = entries.some((entry) => Array.isArray(entry) && entry.length > 0 && (String(entry[0] || "") === body.prompt_id || String(entry[0] || "").includes(body.prompt_id || "")));
                                    if (!stillQueued) {
                                        consecutiveMissingInQueue++;
                                        if (consecutiveMissingInQueue >= 2) throw new Error(`目标 promptId ${body.prompt_id} 的 history 与 WebSocket 输出均不可用；未写入任何媒体，可从 ComfyUI 输出目录按 promptId 手动恢复。`);
                                    } else {
                                        consecutiveMissingInQueue = 0;
                                    }
                                }
                            } catch (error) {
                                if (error instanceof Error && error.message.includes("ComfyUI 执行记录中找不到")) throw error;
                            }
                            missingHistoryCount = 90;
                        }
                    } else {
                        missingHistoryCount = 0;
                        consecutiveMissingInQueue = 0;
                    }
                } else {
                    // /history/{prompt_id} 返回非 200（如 404）：与 item===undefined 同样对待。
                    missingHistoryCount++;
                }
                await new Promise((resolve) => setTimeout(resolve, 1500));
            }
        } finally {
            closeWs();
            await prepared.cleanup();
        }
    }

    private async cancelComfyExecution(taskId: string) {
        const execution = this.comfyExecutions.get(taskId);
        if (!execution) return;
        const { url, promptId } = execution;
        try {
            if (promptId) {
                await fetch(`${url}/queue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete: [promptId] }) });
            }
            // ComfyUI uses /interrupt for the currently executing prompt;
            // queued prompts are handled by the /queue delete above.
            await fetch(`${url}/interrupt`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        } catch (error) {
            this.deps.tasks.addEvent(taskId, "cancel_error", { error: error instanceof Error ? error.message : String(error) });
        }
    }

    public async upload(file: string, signal: AbortSignal, comfyUrl = this.url) {
        const { readFile } = await import("node:fs/promises");
        const data = await readFile(file);
        const form = new FormData();
        form.set("image", new Blob([data]), path.basename(file));
        form.set("overwrite", "true");
        const response = await fetch(`${comfyUrl}/upload/image`, { method: "POST", body: form, signal });
        if (!response.ok) throw new Error(`ComfyUI upload failed: HTTP ${response.status}`);
        const body = await response.json() as { name?: string };
        if (!body.name) throw new Error("ComfyUI upload did not return a filename");
        return body.name;
    }

    /** H3 从独立媒体库复制本次输入，ComfyUI 目录只保存执行副本。 */
    private async localH3Input(file: string, signal: AbortSignal, comfyUrl: string) {
        const direct = this.localH3DirectConfig();
        if (!direct.ready) throw new Error("H3 本地输入未就绪；请检查 ComfyUI 根目录，并确保画布媒体库独立于 ComfyUI 安装目录。");
        signal.throwIfAborted();
        const name = await copyComfyInput(file, MEDIA_DIR, direct.rootDir);
        const query = new URLSearchParams({ filename: path.basename(name), subfolder: path.posix.dirname(name), type: "input" });
        const response = await fetch(`${comfyUrl}/view?${query}`, { method: "HEAD", signal });
        if (!response.ok) throw new Error(`H3 输入副本不可读：ComfyUI 未暴露 ${name}（HTTP ${response.status}）。请检查 ComfyUI input 目录。`);
        return name;
    }

    private fail(id: string, error: unknown) {
        if (this.deps.tasks.get(id)?.status === "cancelled") return;
        const message = error instanceof Error ? error.message : String(error);
        this.updateTask(id, { status: "failed", error: message });
        this.deps.tasks.addEvent(id, "error", { error: message });
    }

    private updateTask(id: string, patch: TaskPatch) {
        const task = this.deps.tasks.update(id, patch);
        if (["succeeded", "failed", "cancelled"].includes(task.status)) this.livePreviews.delete(id);
        if (["succeeded", "failed", "cancelled"].includes(task.status)) this.pendingPreviews.delete(id);
        const type = task.status === "succeeded" ? "task.completed" : task.status === "failed" ? "task.failed" : task.status === "queued" || task.status === "running" || task.status === "cancelled" ? "task.updated" : "task.updated";
        this.deps.events?.publish({ type, entityId: id, payload: task });
        if (["succeeded", "failed", "cancelled"].includes(task.status)) void this.deps.onTaskTerminal?.(task);
        return task;
    }
}

/** 只允许 backend 自有运行媒体进入 ComfyUI 本地直读目录。 */
export function localComfyInputName(file: string) {
    return comfyInputName(file, MEDIA_DIR);
}

async function prepareH3MotionContext(input: Record<string, unknown>, params: Record<string, unknown>) {
    const previous = String(input.previousVideo || "");
    // 对齐旧画布 (Infinite-Canvas) 行为：只要 Motion Context 开启就先截取前一段的
    // 尾帧（最后 ~22 帧）作为 context，而不是把整段 previousVideo 直接喂给 9108 节点。
    // 递进增噪 (motionContextNoise) 仅控制是否在尾帧上叠加噪声，不再作为「是否截尾帧」的前置条件。
    if (!previous || params.motionContext === false) return { input, cleanup: async () => undefined };
    const target = path.join(MEDIA_DIR, `h3-context-${crypto.randomUUID()}.mp4`);
    const noise = params.motionContextNoise === true;
    await buildMotionContextClip(previous, target, {
        frames: Math.round(Number(params.motionContextLength)) || 22,
        alpha: (params.motionContextNoiseAlpha as number) ?? (noise ? 0.45 : 0),
        alphaEnd: (params.motionContextNoiseAlphaEnd as number) ?? (noise ? 0.1 : 0),
        ramp: Math.round(params.motionContextNoiseRampFrames as number) ?? (noise ? 3 : 0),
    });
    return { input: { ...input, previousVideo: target }, cleanup: async () => { try { await rm(target, { force: true }); } catch {} } };
}


async function materializeComfyMedia(url: string, comfyUrl: string, target: string) {
    const source = new URL(url);
    const response = await fetch(`${comfyUrl}/view${source.search}`);
    if (!response.ok) throw new Error(`读取 H3 分段结果失败：HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await import("node:fs/promises").then(({ writeFile }) => writeFile(target, buffer));
    return target;
}

async function concatLocalVideos(files: string[]) {
    await mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
    const { writeFile } = await import("node:fs/promises");
    const output = path.join(MEDIA_DIR, `h3-combined-${crypto.randomUUID()}.mp4`);
    const concatList = path.join(path.dirname(files[0]), `concat-${crypto.randomUUID()}.txt`);
    await writeFile(concatList, files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
    try {
        try {
            await runProcess(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", output]);
        } catch {
            await runProcess(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", output]);
        }
        return output;
    } finally { await rm(concatList, { force: true }); }
}

function runProcess(command: string, args: string[]) {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", (error) => reject(new Error(`${command} 启动失败：${error.message}`)));
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} 失败（${code}）：${stderr.trim().slice(0, 1000)}`)));
    });
}

async function buildWorkflow(preset: string, input: Record<string, unknown>, params: Record<string, unknown>, upload?: (file: string) => Promise<string>) {
    const { readFile } = await import("node:fs/promises");
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const packagedRoot = path.join(packageRoot, "workflows");
    const root = path.resolve(process.env.INFINITE_CANVAS_WORKFLOWS || packagedRoot);
    const files: Record<string, string> = { "z-image": "Z-Image.json", "flux2-klein": "Flux2-Klein.json", "flashvsr-1.1": path.join("custom", "视频修复FlashVSR1.1.json"), "indextts-2.5": "IndexTTS-2.5.json" };
    const source = JSON.parse(await readFile(path.join(root, files[preset]), "utf8")) as Record<string, any>;
    const promptText = String(input.prompt || "");
    const promptNode = preset === "z-image" ? source["23"] : preset === "flux2-klein" ? source["168"] : null;
    if (promptNode?.inputs) promptNode.inputs.text = promptText;
    const requestedSeed = Number(params.seed);
    const randomSeed = () => Math.floor(Math.random() * 1125899906842624);
    const seed = Number.isFinite(requestedSeed) && requestedSeed >= 0 ? requestedSeed : randomSeed();
    if (preset === "z-image" && source["144"]?.inputs) { source["144"].inputs.width = Number(params.width || 1024); source["144"].inputs.height = Number(params.height || 1024); }
    if (preset === "z-image" && source["22"]?.inputs) source["22"].inputs.seed = seed;
    if (preset === "flux2-klein") {
        const width = Number(params.width);
        const height = Number(params.height);
        if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
            // The source workflow derives both dimensions from the first
            // reference via GetImageSize. That makes a portrait reference
            // silently force a portrait result even when the UI requested
            // landscape. Override the two actual Flux inputs with the
            // requested canvas dimensions.
            if (source["152"]?.inputs) { source["152"].inputs.width = width; source["152"].inputs.height = height; }
            if (source["156"]?.inputs) { source["156"].inputs.width = width; source["156"].inputs.height = height; }
        }
        // 未显式指定 seed 时随机化，否则画布批量多张会复用模板固定种子得到相同结果。
        if (source["158"]?.inputs) source["158"].inputs.noise_seed = seed;
    }
    if (preset === "flashvsr-1.1" && source["2"]?.inputs) source["2"].inputs.value = Number(params.scale || 2);
    if (preset === "flashvsr-1.1" && source["40"]?.inputs && params.longEdge !== undefined && params.longEdge !== "auto") source["40"].inputs.longer_edge = Number(params.longEdge);
    if (preset === "indextts-2.5") {
        const referenceAudio = String(input.referenceAudio || "");
        if (!referenceAudio) throw new Error("IndexTTS 2.5 需要 referenceAudio 参考音频");
        if (!upload) throw new Error("IndexTTS 2.5 缺少音频上传器");
        source["20"].inputs.audio = await upload(referenceAudio);
        source["30"].inputs.text = promptText;
        source["30"].inputs.language = String(params.language || "ZH");
        const speed = Number(params.speed || 1);
        source["30"].inputs.duration_factor = speed > 0 ? 1 / speed : 1;
        source["30"].inputs.seed = Number.isFinite(Number(params.seed)) ? Number(params.seed) : 0;
        source["40"].inputs.filename_prefix = String(params.filenamePrefix || "tts_audio/IndexTTS_2_5");
    }
    if (preset === "minimax-h3-deprecated") {
        if (typeof params.modelName === "string" && params.modelName.trim() && source["127"]?.inputs) source["127"].inputs.unet_name = normalizeH3WorkflowModel(params.modelName);
        const duration = Math.max(0.5, Math.min(60, Number(params.duration || 8)));
        const width = Number(params.width || 0);
        const height = Number(params.height || 0);
        if (source["132"]?.inputs) source["132"].inputs.value = duration;
        if (source["115"]?.inputs) {
            if (typeof params.aspectRatio === "string" && params.aspectRatio) source["115"].inputs.aspect_ratio = normalizeH3AspectRatio(params.aspectRatio);
            if (Number.isFinite(Number(params.megapixels)) && Number(params.megapixels) > 0) source["115"].inputs.megapixels = Number(params.megapixels);
        }
        if (width > 0 && height > 0 && source["136"]?.inputs) { source["136"].inputs.width = width; source["136"].inputs.height = height; }
        if (Number.isFinite(Number(params.videoSteps)) && source["124"]?.inputs) source["124"].inputs.steps = Number(params.videoSteps);
        if (Number.isFinite(Number(params.denoise)) && source["124"]?.inputs) source["124"].inputs.denoise = Number(params.denoise);
        if (source["129"]?.inputs && params.seed !== undefined) source["129"].inputs.noise_seed = Number(params.seed);
        // 多 LoRA 槽位链式注入：slot0 走 LoraLoader（带 clip，供 136 的 clip 输入），
        // slot1+ 走 LoraLoaderModelOnly 依次串在 model 链上。无槽位时回退旧 loraName 单 LoRA 路径，
        // 否则只注入 slot0、其余槽位被静默丢弃（表现为"启用了 4 个 LoRA 实际只有第 1 个生效"）。
        const loraSlotList = Array.isArray(params.loraSlots)
            ? (params.loraSlots as Array<Record<string, unknown>>).filter((slot) => slot && typeof slot.name === "string" && String(slot.name).trim() && slot.enabled !== false)
            : [];
        let loraClipRef: [string, number] | undefined;
        if (loraSlotList.length) {
            let modelRef: [string, number] = ["127", 0];
            loraSlotList.forEach((slot, index) => {
                const id = index === 0 ? "9071" : `9075${index - 1}`;
                if (index === 0) {
                    source[id] = { class_type: "LoraLoader", inputs: { model: modelRef, clip: ["128", 0], lora_name: String(slot.name).trim(), strength_model: Number(slot.strength ?? 1), strength_clip: 0 }, _meta: { title: `MiniMax H3 LoRA ${index + 1}` } };
                    loraClipRef = [id, 1];
                } else {
                    source[id] = { class_type: "LoraLoaderModelOnly", inputs: { model: modelRef, lora_name: String(slot.name).trim(), strength_model: Number(slot.strength ?? 1) }, _meta: { title: `MiniMax H3 LoRA ${index + 1}` } };
                }
                modelRef = [id, 0];
            });
            source["124"].inputs.model = modelRef;
            source["126"].inputs.model = modelRef;
        } else if (typeof params.loraName === "string" && params.loraName.trim()) {
            source["9071"] = { class_type: "LoraLoader", inputs: { model: ["127", 0], clip: ["128", 0], lora_name: params.loraName.trim(), strength_model: Number(params.loraStrength ?? 1), strength_clip: 0 }, _meta: { title: "MiniMax H3 LoRA" } };
            source["124"].inputs.model = ["9071", 0];
            source["126"].inputs.model = ["9071", 0];
            loraClipRef = ["9071", 1];
        }
        if (Number(params.combatLoraWeight || 0) > 0) {
            source["9073"] = { class_type: "LoraLoaderModelOnly", inputs: { model: source["124"].inputs.model, lora_name: "Minimax\\H3_Combat_V2.safetensors", strength_model: Number(params.combatLoraWeight) }, _meta: { title: "MiniMax H3 Combat LoRA" } };
            source["124"].inputs.model = ["9073", 0];
            source["126"].inputs.model = ["9073", 0];
        }
        if (Number(params.cinematicLoraWeight || 0) > 0) {
            source["9074"] = { class_type: "LoraLoaderModelOnly", inputs: { model: source["124"].inputs.model, lora_name: "MysticXXX_MMH3-V1.safetensors", strength_model: Number(params.cinematicLoraWeight) }, _meta: { title: "MiniMax H3 Cinematic LoRA" } };
            source["124"].inputs.model = ["9074", 0];
            source["126"].inputs.model = ["9074", 0];
        }
        if (params.teAccel === true) {
            source["9072"] = { class_type: "TESpeedMiniMaxH3", inputs: { model: source["124"].inputs.model, processing_control_value: 0.08, processing_percent_1: 0.1, processing_percent_2: 0.9, mcs: 2, device: "auto", mode: "standard" }, _meta: { title: "MiniMax H3 TE-Speed" } };
            source["124"].inputs.model = ["9072", 0];
            source["126"].inputs.model = ["9072", 0];
        }
        const requestedMode = String(params.taskMode || (typeof input.video === "string" ? "rv2v" : "r2v"));
        const taskMode = ["t2v", "i2v", "fl2v", "r2v", "v2v", "rv2v"].includes(requestedMode) ? requestedMode : "rv2v";
        if (source["136"]?.inputs && ["t2v", "i2v", "fl2v"].includes(taskMode)) {
            source["136"] = { class_type: "MiniMaxH3ImageToVideo", inputs: { clip: ["128", 0], vae: ["119", 0], prompt: ["138", 0], width: ["115", 0], height: ["115", 1], length: ["131", 1], first_frame: null, last_frame: null }, _meta: { title: `MiniMax H3 ${taskMode.toUpperCase()}` } };
        } else if (source["136"]?.inputs && (taskMode === "rv2v" || taskMode === "v2v")) {
            source["136"] = { class_type: "MiniMaxH3AudioConditioningT8", inputs: { clip: ["128", 0], video_vae: ["119", 0], audio_vae: ["120", 0], prompt: ["138", 0], width: ["115", 0], height: ["115", 1], length: ["131", 1], task_type: "Ref2VA", audio_mode: String(params.audioMode || "native"), audio_denoise_strength: Number(params.audioDenoiseStrength ?? 1), add_source_as_reference: params.addSourceAsReference === true, prompt_primary_audio_ordinal: Number(params.promptPrimaryAudioOrdinal || 0), strict_prompt_tags: params.strictPromptTags !== false, ref_image_size: String(params.refImageSize || "match"), reference_video_policy: String(params.referenceVideoPolicy || "official_2_to_15s") }, _meta: { title: "MiniMax H3 Video Edit (Ref2VA/T8)" } };
        } else if (source["136"]?.inputs && taskMode === "r2v") {
            source["136"] = { class_type: "JZL_MiniMaxH3ReferenceToVideo2", inputs: { clip: ["128", 0], vae: ["119", 0], audio_vae: ["120", 0], prompt: ["138", 0], width: ["115", 0], height: ["115", 1], length: ["131", 1], ref_image_size: String(params.refImageSize || "match"), ref_scale: 1 }, _meta: { title: "MiniMax H3 Reference to Video" } };
        }
        // 把用户输入的 prompt 注入 H3 文本节点（136 的 prompt 输入引用的节点，默认 138）。
        // 之前只改了 canvas-agent 的 buildWorkflow（MCP 路径），backend 这条 UI 路径漏了，导致 UI 运行取不到提示词。
        if (promptText && Array.isArray(source["136"]?.inputs?.prompt)) {
            const textNodeId = source["136"].inputs.prompt[0];
            const textNode = source[textNodeId];
            if (textNode?.inputs) {
                if ("value" in textNode.inputs) textNode.inputs.value = promptText;
                else textNode.inputs.text = promptText;
            }
        }
        if (loraClipRef && source["136"]?.inputs) source["136"].inputs.clip = loraClipRef;
    }
    if (upload) {
        if (preset === "flux2-klein") {
            const refs = Array.isArray(input.references) ? input.references.map(String).slice(0, 3) : [];
            if (!refs.length) throw new Error("Flux2-Klein 至少需要一张参考图");
            // The packaged workflow wires all three reference branches into the
            // conditioning graph. ComfyUI validates every connected LoadImage,
            // so leaving the template's sample filenames in unused branches
            // causes a 400 before the prompt is queued. Reuse the last supplied
            // reference for missing slots; this also makes one- and two-image
            // edits valid without changing the workflow topology.
            const uploaded = [] as string[];
            for (const reference of refs) uploaded.push(await upload(reference));
            for (const [index, nodeId] of ["278", "292", "270"].entries()) if (source[nodeId]?.inputs) source[nodeId].inputs.image = uploaded[Math.min(index, uploaded.length - 1)];
        }
        if (preset === "flashvsr-1.1" && source["10"]?.inputs && typeof input.video === "string") source["10"].inputs.video = await upload(input.video);
        if (preset === "minimax-h3-deprecated") {
            const refs = Array.isArray(input.references) ? input.references.map(String).filter(Boolean).slice(0, 9) : [];
            const uploadedRefs = await Promise.all(refs.map((file) => upload(file)));
            const taskMode = String(params.taskMode || (typeof input.video === "string" ? "rv2v" : "r2v"));
            const imageToVideo = ["t2v", "i2v", "fl2v"].includes(taskMode);
            if (imageToVideo && typeof input.video === "string") throw new Error(`${taskMode} 不接受视频参考，请切换到 rv2v`);
            if (taskMode === "i2v" && uploadedRefs.length !== 1) throw new Error("i2v 需要且只接受 1 张图片作为首帧");
            if (taskMode === "fl2v" && uploadedRefs.length !== 2) throw new Error("fl2v 需要且只接受 2 张图片，依次作为首帧和尾帧");
            if (taskMode === "t2v" && uploadedRefs.length) throw new Error("t2v 不接受图片参考，请清空图片 refs");
            if ((taskMode === "rv2v" || taskMode === "v2v") && typeof input.video !== "string") throw new Error(`${taskMode} 需要至少 1 段视频参考`);
            if (taskMode === "r2v" && typeof input.video === "string") throw new Error("r2v 不接受视频参考，请切换到 rv2v");
            if (taskMode === "v2v" && uploadedRefs.length) throw new Error("v2v 只接受视频参考，不接受图片 refs，请切换到 rv2v");
            if (uploadedRefs[0] && source["137"]?.inputs) source["137"].inputs.image = uploadedRefs[0];
            const refNode = source["136"]?.inputs;
            if (refNode) {
                if (uploadedRefs[0] && !imageToVideo) refNode[source["136"]?.class_type === "JZL_MiniMaxH3ReferenceToVideo2" ? "ref_image_0" : "ref_images.ref_image_0"] = ["137", 0];
                for (let index = 1; index < uploadedRefs.length; index += 1) {
                    const loadId = `913${index}`;
                    source[loadId] = { class_type: "LoadImage", inputs: { image: uploadedRefs[index] }, _meta: { title: `MiniMax H3 reference ${index + 1}` } };
                    if (imageToVideo) refNode[index === 1 ? "last_frame" : `ref_image_${index}`] = [loadId, 0];
                    else if (source["136"]?.class_type === "JZL_MiniMaxH3ReferenceToVideo2") refNode[`ref_image_${index}`] = [loadId, 0];
                    else refNode[`ref_images.ref_image_${index}`] = [loadId, 0];
                }
                if (uploadedRefs[0] && imageToVideo) refNode.first_frame = ["137", 0];
            }
            if (typeof input.video === "string" && source["136"]?.inputs) {
                const videoName = await upload(input.video);
                source["9104"] = { class_type: "LoadVideo", inputs: { file: videoName }, _meta: { title: "MiniMax H3 source video" } };
                source["9105"] = { class_type: "GetVideoComponents", inputs: { video: ["9104", 0] }, _meta: { title: "MiniMax H3 source video frames" } };
                const videoPrefix = source["136"]?.class_type === "JZL_MiniMaxH3ReferenceToVideo2" ? "ref_video_0" : "ref_videos.ref_video_0";
                source["136"].inputs[videoPrefix] = ["9105", 0];
                source["136"].inputs[source["136"]?.class_type === "JZL_MiniMaxH3ReferenceToVideo2" ? "ref_video_audio_0" : "ref_video_audios.ref_video_audio_0"] = ["9105", 1];
            }
            const audios = Array.isArray(input.audios) ? input.audios.map(String).filter(Boolean).slice(0, 3) : [];
            for (const [index, file] of audios.entries()) {
                const audioName = await upload(file);
                const loadId = `914${index}`;
                source[loadId] = { class_type: "LoadAudio", inputs: { audio: audioName }, _meta: { title: `MiniMax H3 audio ${index + 1}` } };
                if (source["136"]?.inputs) source["136"].inputs[source["136"]?.class_type === "JZL_MiniMaxH3ReferenceToVideo2" ? `ref_audio_${index}` : `ref_audios.ref_audio_${index}`] = [loadId, 0];
            }
            const previousVideo = String(input.previousVideo || "");
            // 只有显式开启「上一段作为参考视频」才注入 motion context；旧条件 params.motionContext !== false
            // 会让任何带了 previousVideo 的调用（含链式续跑）静默改图，故收紧为显式白名单。
            if (previousVideo && params.previousVideoAsReference === true) {
                const previousName = await upload(previousVideo);
                source["9106"] = { class_type: "LoadVideo", inputs: { file: previousName }, _meta: { title: "MiniMax Motion Context previous clip" } };
                source["9107"] = { class_type: "GetVideoComponents", inputs: { video: ["9106", 0] }, _meta: { title: "MiniMax Motion Context frames" } };
                source["9108"] = { class_type: "MiniMaxH3MotionContext", inputs: { conditioning: ["136", 0], vae: ["119", 0], latent: ["136", 1], context_frames: ["9107", 0], context_audio: ["9107", 1], audio_vae: ["120", 0], context_length: String(params.motionContextLength || "22"), audio_context_length: Number(params.motionContextAudioLength || 24) }, _meta: { title: "MiniMax H3 Motion Context" } };
                source["9109"] = { class_type: "MiniMaxH3MotionContextTrim", inputs: { images: ["122", 0], trim_frames: ["9108", 1], audio: ["121", 0], fps: 24, match_tail: true }, _meta: { title: "MiniMax H3 Motion Context Trim" } };
                source["126"].inputs.conditioning = ["9108", 0];
                source["130"].inputs.images = ["9109", 0];
                source["130"].inputs.audio = ["9109", 1];
            }
        }
    }
    return source;
}

// ─────────────────────────────────────────────────────────────────────────
// H3导演台 工作流构造
//
// 默认将前端参数提交给 NanFeng V15 主节点；旧的分拆 API 图保留在下方备用。
// ─────────────────────────────────────────────────────────────────────────
const NANFENG_VHS_CLASS = "VHS_VideoCombine";
const NANFENG_REF2VA_MODES = new Set(["ref2va"]);

/**
 * 防字幕/水印约束。
 *
 * 南风的 NanFengH3PromptDraft 节点靠「不要字幕水印Logo」开关往提示词尾部追加一句约束
 * （见 custom_nodes/nanfeng_prompt_nodes/nodes.py:102-103）。但本后端走的是
 * NanFengH3MultiReferenceGeneratorV15 直连，不经过 PromptDraft，因此该开关永远不会生效——
 * 实测两版提示词（平铺/结构化、都在正文写了禁字幕）输出都在画面底部烧进了中文字幕。
 * 这里按南风的原句补上，作为每段提示词的固定尾缀。
 */
const H3_NO_TEXT_CONSTRAINT = "\n画面不要额外字幕、文字、水印或Logo。";

/** 给提示词尾部追加防字幕约束（幂等：已含则不加）。 */
function withNoTextConstraint(prompt: string): string {
    const body = String(prompt || "");
    if (!body.trim()) return body;
    if (body.includes("不要额外字幕")) return body;
    return body.trimEnd() + H3_NO_TEXT_CONSTRAINT;
}

/** 正常路径：交给南风 V15 主节点内部 GraphBuilder 展开，保留其原生释放/加载依赖。 */
export async function buildNativeNanFengV15Workflow(input: Record<string, unknown>, params: Record<string, unknown>, upload: (file: string) => Promise<string>, _comfyUrl: string, signal: AbortSignal): Promise<Record<string, any>> {
    if (signal.aborted) throw new Error("任务已取消");
    if (params.postGenerationOnly === true) return buildDecodedH3SecondPassWorkflow(input, params, upload, signal);
    const mode = normalizeNanFengMode(params.mode ?? params.taskMode ?? (typeof input.video === "string" ? "ref2va" : "t2v"));
    const refs = Array.isArray(input.references) ? input.references.map(String).filter(Boolean).slice(0, 9) : [];
    const videos = (Array.isArray(input.videos) ? input.videos.map(String).filter(Boolean) : typeof input.video === "string" ? [input.video] : []).slice(0, 3);
    const audios = Array.isArray(input.audios) ? input.audios.map(String).filter(Boolean).slice(0, 3) : [];
    const audioDriveFile = String(params.audioDriveFile || "").trim();
    const referenceAudios = params.audioDrive === true && audioDriveFile ? [audioDriveFile] : audios;
    const uploadedRefs = await Promise.all(refs.map(upload));
    const uploadedVideos = await Promise.all(videos.map(upload));
    const uploadedAudios = await Promise.all(referenceAudios.map(upload));
    const previousVideo = typeof input.previousVideo === "string" && input.previousVideo ? await upload(input.previousVideo) : "";
    validateNanFengMode(mode, uploadedRefs.length, uploadedVideos.length, uploadedAudios.length, params);
    const slots = Array.isArray(params.loraSlots) ? params.loraSlots : [{ name: params.loraName, strength: params.loraStrength, enabled: Boolean(params.loraName) }];
    const value = (key: string, fallback: unknown) => params[key] ?? fallback;
    const selectedAttention = String(value("sageAttention", value("dedicatedAttention", "H3专用Sage加速")));
    const sageAttention = selectedAttention === "关闭" ? "disabled" : selectedAttention === "自动" || selectedAttention === "H3专用Sage加速" ? "auto" : selectedAttention;
    const inputs: Record<string, unknown> = {
        "模型": String(value("modelName", "h3\\DasiwaMinimaxH3_dasiwaREF2VAHybridV1.safetensors")), "文本编码器": String(value("textEncoder", "qwen3vl_32b_minimax_h3_fp8.safetensors")), "文本编码器类型": String(value("textEncoderType", "minimax")), "文本编码器设备": String(value("textEncoderDevice", "default")), "视频VAE": String(value("videoVae", "minimax_h3_video_vae_fp16.safetensors")), "音频VAE": String(value("audioVae", "minimax_h3_audio_vae_fp32.safetensors")), "模型权重精度": String(value("precision", "default")),
        "SageAttention": sageAttention, "H3专用注意力": selectedAttention, "允许编译": value("allowCompile", false), "画面比例": normalizeH3AspectRatio(String(value("aspectRatio", "16:9 (Widescreen)"))), "百万像素": Number(value("megapixels", 0.4)), "尺寸倍数": Number(value("sizeMultiple", 32)), "时长秒": Number(value("duration", 5)), "提示词": withNoTextConstraint(String(input.prompt || "")), "恒定触发词": String(value("constantTriggerWord", "")), "随机种子": Number.isFinite(Number(params.seed)) && Number(params.seed) >= 0 ? Number(params.seed) : Math.floor(Math.random() * 1125899906842624), "采样器": String(value("sampler", "res_multistep")), "调度器": String(value("scheduler", "simple")), "采样步数": Number(value("steps", 20)), "降噪强度": Number(value("denoise", 1)), "参考图尺寸": String(value("refImageSize", "match")),
        "文生视频": mode === "t2v", "图生视频": mode === "i2v", "首尾帧": mode === "fl2v", "启用LoRA": slots.some((slot: any) => slot?.enabled !== false && String(slot?.name || "").trim()), "启用锁音频": value("lockAudio", false), "开启音频驱动模式": value("audioDrive", false), "音频驱动文件": params.audioDrive === true ? uploadedAudios[0] || "" : "", "运行时预留显存GB": Number(value("reservedVramGb", 0.6)), "启用运行时预留显存": value("runtimeReserveEnabled", false), "启用UniBlockSwap": value("uniBlockSwapEnabled", false), "UniBlockSwap常驻块数": Number(value("uniBlockSwapBlocks", 1)), "启用H3潜空间放大二采": value("latentUpscaleEnabled", false), "H3潜空间放大模型": String(value("latentUpscaleModel", "minimax_h3_latent_upscaler_3d_fp16.safetensors")), "H3潜空间目标百万像素": Number(value("latentUpscaleMegapixels", 1)), "H3潜空间对齐": Number(value("latentUpscaleAlign", 2)), "H3潜空间精度": String(value("latentUpscalePrecision", "bf16")), "H3一采步数": Number(value("h3FirstSteps", 6)), "H3二采步数": Number(value("h3SecondSteps", 4)), "H3完整Sigma序列": String(value("h3FullSigma", "")), "V81一采使用手动Sigma": value("v81ManualSigma", false), "启用实时预览": value("realtimePreviewEnabled", true), "实时预览最长边": Number(value("realtimePreviewLongEdge", 512)), "实时预览帧数": Number(value("realtimePreviewFrames", 12)), "实时预览帧率": Number(value("realtimePreviewFps", 8)), "实时预览JPEG质量": Number(value("realtimePreviewJpegQuality", 75)), "参考图最长边": Number(value("referenceLongEdge", 1920)), "启用H3 SLA": value("slaEnabled", false), "SLA稀疏率": Number(value("slaSparsity", 0.9)), "SLA块大小": String(value("slaBlockSize", "64")), "SLA最短序列": Number(value("slaMinSequence", 4096)), "SLA末尾稠密步数": Number(value("slaDenseLastSteps", 1)), "SLA保护音频": value("slaProtectAudio", true), "SLA指定稠密步": String(value("slaDenseSteps", "0")), "SLA稠密后端": String(value("slaBackend", "comfy_kitchen")), "SLA关闭FP16累加": value("slaDisableFp16Accum", true), "SLA稳定运动": value("slaStabilizeMotion", true),
        // V15 继承链要求完整提交旧字段，即使对应功能未启用也必须显式提交默认值。
        "启用SolAttn": value("solEnabled", false), "SolAttn_tau": Number(value("solTau", 1.2)), "SolAttn阈值类型": String(value("solThresholdType", "diag")), "SolAttn精确模式": String(value("solExactMode", "exact_kv")), "SolAttn完整末步": Number(value("solFullFinalSteps", 1)), "SolAttn末段比例": Number(value("solTailRatio", 0)), "SolAttn前缀Token": Number(value("solPrefixTokens", 0)),
        "启用T8缓存": value("t8Enabled", false), "T8残差阈值": Number(value("t8ResidualThreshold", 0.12)), "T8开始比例": Number(value("t8StartPercent", 0.08)), "T8结束比例": Number(value("t8EndPercent", 0.95)), "T8连续命中": Number(value("t8MaxConsecutiveHits", 2)), "T8缓存设备": String(value("t8CacheDevice", "cpu")), "T8指标步幅": Number(value("t8MetricStride", 8)), "T8详细日志": value("t8Verbose", false), "固定随机种子": value("fixedSeed", false),
        "启动准备": String(value("startupPreparation", "关闭（原始输出）")), "单人小脸修复": value("singleFaceRepair", false), "多人小脸修复": value("multiFaceRepair", false), "人物1身份参考": String(value("person1Reference", "图片1")), "人物2身份参考": String(value("person2Reference", "图片2")), "人物1图中位置": String(value("person1Position", "自动（最大脸）")), "人物2图中位置": String(value("person2Position", "自动（最大脸）")),
        "全局修复": value("globalRepairEnabled", false), "全局修复倍率": Number(value("globalRepairScale", 1.5)), "Sigma策略": String(value("sigmaStrategy", "原生轨迹（不加步）")), "分块处理（节约显存）": String(value("chunkProcessing", "关闭")), "分块卸载层数": Number(value("chunkOffloadLayers", 50)), "全局修复LoRA模式": String(value("globalRepairLoraMode", "专用4步LoRA")), "全局修复LoRA": String(value("globalRepairLora", "自动选择4步LoRA")), "全局修复LoRA强度": Number(value("globalRepairLoraStrength", 0.75)), "全局修复步数": Number(value("globalRepairSteps", 4)), "全局修复降噪": Number(value("globalRepairDenoise", 0.28)), "全局修复Sigma策略": String(value("globalRepairSigmaStrategy", "最终区间增加1步")), "全局修复范围": String(value("globalRepairRange", "全画面双区")), "低显存注意力分头数": Number(value("lowVramAttentionHeads", 10)),
        "H3二采LoRA模式": String(value("h3SecondLoraMode", "继承一采LoRA")), "H3二采LoRA": String(value("h3SecondLora", "")), "H3二采LoRA强度": Number(value("h3SecondLoraStrength", 0.6)),
    };
    for (let i = 0; i < 9; i += 1) inputs[`图片${i + 1}`] = uploadedRefs[i] || "未选择";
    for (let i = 0; i < 3; i += 1) { inputs[`视频${i + 1}`] = uploadedVideos[i] || "未选择"; inputs[`音频${i + 1}`] = uploadedAudios[i] || "未选择"; }
    for (let i = 0; i < 8; i += 1) { const slot: any = slots[i] || {}; inputs[`LoRA${i + 1}`] = String(slot.name || "未选择"); inputs[`LoRA${i + 1}强度`] = Number(slot.strength ?? 1); inputs[`LoRA${i + 1}启用`] = slot.enabled !== false && Boolean(String(slot.name || "").trim()); }
    for (const [target, source, fallback] of [["启用西格玛调节", "sigmaEnabled", false], ["视频西格玛偏移", "videoSigmaShift", 12], ["音频西格玛偏移", "audioSigmaShift", 3], ["西格玛模式", "sigmaMode", "低西格玛加密"], ["低西格玛开始", "lowSigmaStart", 0.8], ["低西格玛结束", "lowSigmaEnd", 0], ["每区间细分", "sigmaRefineSteps", 2], ["加密曲线", "sigmaCurve", "cosine"], ["手动西格玛", "manualSigma", ""], ["启用双采样", "dualSampling", false], ["双采后段比例", "dualSamplingRatio", 0.5], ["双采后段采样器", "dualSampler", "res_multistep"], ["启用高清二采", "secondPassEnabled", false], ["一采步数", "firstPassSteps", 20], ["二采百万像素", "secondPassMegapixels", 1], ["二采放大方法", "secondPassUpscaleMethod", "lanczos"], ["二采步数", "secondPassSteps", 6], ["二采降噪", "secondPassDenoise", 0.2], ["二采采样器", "secondPassSampler", "res_multistep"], ["二采调度器", "secondPassScheduler", "simple"], ["二采模型", "secondPassModel", "跟随一采模型（质量优先）"], ["二采起始Sigma", "secondPassSigma", 0.2], ["H3二采Sigma", "h3SecondSigma", "0.35, 0.22, 0.12, 0.05, 0"], ["启用RTX视频超分", "rtxEnabled", false], ["RTX缩放方式", "rtxResizeMode", "倍数缩放"], ["RTX缩放倍数", "rtxScale", 2], ["RTX目标宽度", "rtxWidth", 1920], ["RTX目标高度", "rtxHeight", 1080], ["RTX质量", "rtxQuality", "ULTRA"], ["音频驱动打点", "audioDriveMarkers", "[]"], ["音频驱动分段图片", "audioDriveSegmentImages", "{}"], ["音频驱动分段分镜", "audioDriveSegmentStoryboards", "{}"], ["音频驱动创意", "audioDriveCreative", ""], ["音频驱动排除范围", "audioDriveExclude", "{}"], ["音频驱动当前起点", "audioDriveStart", 0], ["音频驱动当前终点", "audioDriveEnd", 0]] as Array<[string, string, unknown]>) inputs[target] = value(source, fallback);
    inputs["空5分钟时间轴模式"] = value("emptyFiveMinuteTimeline", false);
    inputs["启用TAEH3彩色预览"] = value("taeh3Enabled", false);
    inputs["启用潜空间续写"] = value("motionContextEnabled", false);
    inputs.context_length = String(value("contextLength", "22"));
    inputs.audio_context_length = Number(value("audioContextLength", 24));
    inputs["潜空间续写任务"] = String(value("continuationTask", ""));
    inputs["启用续写音频精修"] = value("continuationAudioRefineEnabled", false);
    inputs["续写音频降噪强度"] = Number(value("continuationAudioDenoise", 0.3));
    inputs["续写音频精修步数"] = Number(value("continuationAudioSteps", 4));
    inputs["续写音频采样器"] = String(value("continuationAudioSampler", "euler"));
    inputs["续写音频调度器"] = String(value("continuationAudioScheduler", "simple"));
    inputs["启用TRT视频VAE"] = value("trtVideoVaeEnabled", false);
    inputs["TRT视频解码引擎"] = String(value("trtDecoderEngine", "None"));
    inputs["TRT视频编码引擎"] = String(value("trtEncoderEngine", "None"));
    inputs["DLSS超分模式"] = String(value("dlssUpscaleMode", "关闭"));
    inputs["启用DLSS补帧"] = value("dlssFrameInterpolationEnabled", false);
    for (const [target, source, fallback] of [
        ["DLSS_video_upscale_mode", "dlssVideoUpscaleMode", "1.5× (Quality)"], ["DLSS_video_require_neural_upscaling", "dlssVideoRequireNeuralUpscaling", false], ["DLSS_video_nr_preset", "dlssVideoNrPreset", "Default"], ["DLSS_video_nr_style", "dlssVideoNrStyle", "Default"], ["DLSS_video_nr_intensity", "dlssVideoNrIntensity", 1], ["DLSS_video_local_tone_strength", "dlssVideoLocalToneStrength", 1], ["DLSS_video_local_structure_strength", "dlssVideoLocalStructureStrength", 1], ["DLSS_video_skin_structure_strength", "dlssVideoSkinStructureStrength", -1], ["DLSS_video_automatic_mask", "dlssVideoAutomaticMask", false], ["DLSS_video_dlss_model_preset", "dlssVideoModelPreset", "Default"], ["DLSS_video_encoding_quality", "dlssVideoEncodingQuality", "Max"], ["DLSS_video_video_codec", "dlssVideoCodec", "H.264"], ["DLSS_video_container", "dlssVideoContainer", "MP4"], ["DLSS_video_rename", "dlssVideoRename", "Auto"], ["DLSS_video_custom_suffix", "dlssVideoCustomSuffix", "_DLSS5"], ["DLSS_video_hdr_mode", "dlssVideoHdrMode", false], ["DLSS_video_output_detail_strength", "dlssVideoOutputDetailStrength", 1], ["DLSS_fg_output_fps", "dlssFgOutputFps", "60"], ["DLSS_fg_dlss_engine", "dlssFgEngine", "Auto"], ["DLSS_fg_encoding_quality", "dlssFgEncodingQuality", "Max"], ["DLSS_fg_video_codec", "dlssFgVideoCodec", "H.264"], ["DLSS_fg_container", "dlssFgContainer", "MP4"], ["DLSS_fg_rename", "dlssFgRename", "Auto"], ["DLSS_fg_custom_suffix", "dlssFgCustomSuffix", "_DLSSFG"], ["DLSS_fg_hdr_mode", "dlssFgHdrMode", false]] as Array<[string, string, unknown]>) inputs[target] = value(source, fallback);
    for (const [target, source, fallback] of [["南风ER_solver_type", "erSolverType", "ER-SDE"], ["南风ER_max_stage", "erMaxStage", 3], ["南风ER_eta", "erEta", 1], ["南风ER_s_noise", "erSNoise", 1]] as Array<[string, string, unknown]>) inputs[target] = value(source, fallback);
    const graph: Record<string, any> = { nf_v15: { class_type: NANFENG_H3_CLASS, inputs } };
    let outputImages: [string, number] = ["nf_v15", 0];
    let outputAudio: [string, number] = ["nf_v15", 1];
    if (params.faceRefineEnabled === true) {
        const modelName = String(inputs["模型"]);
        graph.face_model = { class_type: "UNETLoader", inputs: { unet_name: modelName, weight_dtype: String(inputs["模型权重精度"]) } };
        let faceModel: [string, number] = ["face_model", 0];
        slots.slice(0, 8).forEach((slot: any, index: number) => {
            if (slot?.enabled === false || !String(slot?.name || "").trim()) return;
            const id = `face_lora_${index + 1}`;
            graph[id] = { class_type: "LoraLoaderModelOnly", inputs: { model: faceModel, lora_name: String(slot.name).trim(), strength_model: Number(slot.strength ?? 1) } };
            faceModel = [id, 0];
        });
        graph.face_clip = { class_type: "CLIPLoader", inputs: { clip_name: String(inputs["文本编码器"]), type: String(inputs["文本编码器类型"]), device: String(inputs["文本编码器设备"]) } };
        graph.face_video_vae = { class_type: "VAELoader", inputs: { vae_name: String(inputs["视频VAE"]) } };
        graph.face_audio_vae = { class_type: "VAELoader", inputs: { vae_name: String(inputs["音频VAE"]) } };
        graph.face_refine = { class_type: "MiniMaxH3PostGenerationFaceRefine", inputs: {
            images: ["nf_v15", 0], audio: ["nf_v15", 1], model: faceModel, vae: ["face_video_vae", 0], audio_vae: ["face_audio_vae", 0], clip: ["face_clip", 0],
            prompt: String(inputs["提示词"]), seed: Number(inputs["随机种子"]), detector: String(value("faceRefineDetector", "face_yolov8m.pt")), confidence: Number(value("faceRefineConfidence", 0.35)), crop_factor: Number(value("faceRefineCropFactor", 2.5)), canvas_size: Number(value("faceRefineCanvasSize", 768)), denoise: Number(value("faceRefineDenoise", 0.4)), steps: Number(value("faceRefineSteps", 8)), sampler: String(value("faceRefineSampler", "euler")), scheduler: String(value("faceRefineScheduler", "simple")), paste_region: String(value("faceRefinePasteRegion", "face_only")), mask_dilation: Number(value("faceRefineMaskDilation", 16)), feather: Number(value("faceRefineFeather", 24)), colour_match: Number(value("faceRefineColourMatch", 1)), blend: Number(value("faceRefineBlend", 1)), seam_fade_frames: Number(value("seamFaceFadeFrames", 0)), seam_colour_match: Number(value("seamColourMatch", 0)), audio_crossfade_ms: Number(value("seamAudioCrossfadeMs", 0)),
        } };
        if (previousVideo && (Number(value("seamFaceFadeFrames", 0)) > 0 || Number(value("seamColourMatch", 0)) > 0 || Number(value("seamAudioCrossfadeMs", 0)) > 0)) {
            graph.seam_previous_video = { class_type: "LoadVideo", inputs: { file: previousVideo } };
            graph.seam_previous_parts = { class_type: "GetVideoComponents", inputs: { video: ["seam_previous_video", 0] } };
            graph.face_refine.inputs.previous_images = ["seam_previous_parts", 0];
            graph.face_refine.inputs.previous_audio = ["seam_previous_parts", 1];
        }
        outputImages = ["face_refine", 0];
        outputAudio = ["face_refine", 1];
    }
    graph.nf_output = { class_type: NANFENG_VHS_CLASS, inputs: { images: outputImages, audio: outputAudio, filename_prefix: "NanFeng_H3", frame_rate: 24, format: "video/h264-mp4", loop_count: 0, pingpong: false, save_output: true } };
    return graph;
}

/** Phase B: decode the durable first-pass MP4 and run a real full-frame H3 resample. */
export async function buildDecodedH3SecondPassWorkflow(input: Record<string, unknown>, params: Record<string, unknown>, upload: (file: string) => Promise<string>, signal: AbortSignal): Promise<Record<string, any>> {
    if (signal.aborted) throw new Error("任务已取消");
    const source = String(input.video || "").trim();
    if (!source) throw new Error("确认精修缺少已缓存的一采视频");
    const uploaded = await upload(source);
    const modelName = String(params.modelName || "h3\\DasiwaMinimaxH3_dasiwaREF2VAHybridV1.safetensors");
    const graph: Record<string, any> = {
        cached_first_pass: { class_type: "LoadVideo", inputs: { file: uploaded } },
        cached_parts: { class_type: "GetVideoComponents", inputs: { video: ["cached_first_pass", 0] } },
        refine_model: { class_type: "UNETLoader", inputs: { unet_name: modelName, weight_dtype: String(params.precision || "default") } },
        refine_clip: { class_type: "CLIPLoader", inputs: { clip_name: String(params.textEncoder || "qwen3vl_32b_minimax_h3_fp8.safetensors"), type: String(params.textEncoderType || "minimax"), device: String(params.textEncoderDevice || "default") } },
        refine_video_vae: { class_type: "VAELoader", inputs: { vae_name: String(params.videoVae || "minimax_h3_video_vae_fp16.safetensors") } },
        refine_audio_vae: { class_type: "VAELoader", inputs: { vae_name: String(params.audioVae || "minimax_h3_audio_vae_fp32.safetensors") } },
    };
    let model: [string, number] = ["refine_model", 0];
    const slots = Array.isArray(params.loraSlots) ? params.loraSlots as any[] : [];
    slots.slice(0, 8).forEach((slot, index) => {
        if (slot?.enabled === false || !String(slot?.name || "").trim()) return;
        const id = `refine_lora_${index + 1}`;
        graph[id] = { class_type: "LoraLoaderModelOnly", inputs: { model, lora_name: String(slot.name).trim(), strength_model: Number(slot.strength ?? 1) } };
        model = [id, 0];
    });
    graph.full_frame_refine = { class_type: "MiniMaxH3PostGenerationFullFrameRefine", inputs: {
        images: ["cached_parts", 0], audio: ["cached_parts", 1], model, vae: ["refine_video_vae", 0], audio_vae: ["refine_audio_vae", 0], clip: ["refine_clip", 0],
        prompt: withNoTextConstraint(String(input.prompt || "")), seed: Number.isFinite(Number(params.seed)) ? Number(params.seed) : 0,
        steps: Number(params.h3SecondSteps ?? params.secondPassSteps ?? 4), denoise: Number(params.secondPassDenoise ?? params.denoise ?? 0.28), sampler: String(params.secondPassSampler || params.sampler || "res_multistep"), scheduler: String(params.secondPassScheduler || params.scheduler || "simple"), target_megapixels: Number(params.latentUpscaleMegapixels ?? params.secondPassMegapixels ?? params.megapixels ?? 0.4),
    } };
    let images: [string, number] = ["full_frame_refine", 0];
    let audio: [string, number] = ["full_frame_refine", 1];
    if (params.faceRefineEnabled === true) {
        graph.face_refine = { class_type: "MiniMaxH3PostGenerationFaceRefine", inputs: {
            images, audio, model, vae: ["refine_video_vae", 0], audio_vae: ["refine_audio_vae", 0], clip: ["refine_clip", 0], prompt: String(input.prompt || ""), seed: Number(params.seed || 0), detector: String(params.faceRefineDetector || "face_yolov8m.pt"), confidence: Number(params.faceRefineConfidence ?? 0.35), crop_factor: Number(params.faceRefineCropFactor ?? 2.5), canvas_size: Number(params.faceRefineCanvasSize ?? 768), denoise: Number(params.faceRefineDenoise ?? 0.4), steps: Number(params.faceRefineSteps ?? 8), sampler: String(params.faceRefineSampler || "euler"), scheduler: String(params.faceRefineScheduler || "simple"), paste_region: String(params.faceRefinePasteRegion || "face_only"), mask_dilation: Number(params.faceRefineMaskDilation ?? 16), feather: Number(params.faceRefineFeather ?? 24), colour_match: Number(params.faceRefineColourMatch ?? 1), blend: Number(params.faceRefineBlend ?? 1), seam_fade_frames: Number(params.seamFaceFadeFrames ?? 0), seam_colour_match: Number(params.seamColourMatch ?? 0), audio_crossfade_ms: 0,
        } };
        images = ["face_refine", 0]; audio = ["face_refine", 1];
    }
    graph.nf_output = { class_type: NANFENG_VHS_CLASS, inputs: { images, audio, filename_prefix: "NanFeng_H3_Confirmed", frame_rate: 24, format: "video/h264-mp4", loop_count: 0, pingpong: false, save_output: true } };
    return graph;
}

/** 备用：此前的分拆 API 图，保留用于定位原生 V10 节点异常。 */
export async function buildExpandedNanFengV10Workflow(
    input: Record<string, unknown>,
    params: Record<string, unknown>,
    upload: (file: string) => Promise<string>,
    comfyUrl: string,
    signal: AbortSignal,
): Promise<Record<string, any>> {
    if (signal.aborted) throw new Error("任务已取消");
    const mode = normalizeNanFengMode(params.mode ?? params.taskMode ?? (typeof input.video === "string" ? "ref2va" : "t2v"));
    // V10 继承 V8.1/V7 的实际运行分支：旧 V4 Sigma、V5 高清二采、SolAttn/T8
    // 字段只保留兼容读取，不进入 V10 的 generate() 执行图。
    const v10LegacySigmaEnabled = false;
    const v10LegacySecondPassEnabled = false;
    const v10SolAttnEnabled = false;
    const v10T8Enabled = false;
    const duration = Math.max(1, Math.min(15, Number(params.duration || 5)));
    const ratio = normalizeH3AspectRatio(String(params.aspectRatio || "16:9 (Widescreen)"));
    const megapixels = Number(params.megapixels || 0.4);
    const sizeMultiple = Number(params.sizeMultiple || 32);
    const width = Math.max(32, Math.round(Math.sqrt(megapixels * 1024 * 1024 * ratioWidth(ratio) / ratioHeight(ratio)) / sizeMultiple) * sizeMultiple);
    const height = Math.max(32, Math.round(width * ratioHeight(ratio) / ratioWidth(ratio) / sizeMultiple) * sizeMultiple);
    const graph: Record<string, any> = {};
    const node = (id: string, class_type: string, inputs: Record<string, any>) => { graph[id] = { class_type, inputs }; return (output = 0) => [id, output]; };
    const modelName = String(params.modelName || "h3\\DasiwaMinimaxH3_dasiwaREF2VAHybridV1.safetensors");
    const textEncoder = String(params.textEncoder || "qwen3vl_32b_minimax_h3_fp8.safetensors");
    const videoVaeName = String(params.videoVae || "minimax_h3_video_vae_fp16.safetensors");
    const audioVaeName = String(params.audioVae || "minimax_h3_audio_vae_fp32.safetensors");
    if (!modelName || !textEncoder || !videoVaeName || !audioVaeName) throw new Error("南风 H3 需要模型、文本编码器、视频 VAE 和音频 VAE");

    const start = node("nf_start", "NanFengH3ReleaseAtStartV15", { unet_name: modelName, clip_name: textEncoder, video_vae_name: videoVaeName, audio_vae_name: audioVaeName, reserved_vram_gb: params.runtimeReserveEnabled === true ? Number(params.reservedVramGb ?? 0.6) : 0 });
    let model = node("nf_model", "UNETLoader", { unet_name: modelName, weight_dtype: String(params.precision || "default") });
    const loraSlots = Array.isArray(params.loraSlots) ? params.loraSlots : [{ name: params.loraName, strength: params.loraStrength, enabled: true }];
    loraSlots.slice(0, 8).forEach((slot: any, index: number) => {
        if (slot?.enabled === false || typeof slot?.name !== "string" || !slot.name.trim()) return;
        model = node(`nf_lora_${index + 1}`, "LoraLoaderModelOnly", { model: model(0), lora_name: slot.name.trim(), strength_model: Number(slot.strength ?? 0.75) });
    });
    if (params.slaEnabled === true) model = node("nf_sla", "H3SLAAttention", { model: model(0), enabled: true, sparsity_ratio: Number(params.slaSparsity ?? 0.9), block_size: String(params.slaBlockSize || "64"), min_seq_len: Number(params.slaMinSequence ?? 4096), dense_last_steps: Number(params.slaDenseLastSteps ?? 1), protect_audio: params.slaProtectAudio !== false, dense_steps: String(params.slaDenseSteps || "0"), dense_backend: String(params.slaBackend || "comfy_kitchen"), disable_fp16_accum: params.slaDisableFp16Accum !== false, stabilize_motion: params.slaStabilizeMotion !== false });
    else if (v10T8Enabled && params.t8Enabled === true) model = node("nf_t8", "MiniMaxH3BlockCacheT8", { model: model(0), residual_diff_threshold: Number(params.t8ResidualThreshold ?? 0.12), start_percent: Number(params.t8StartPercent ?? 0.08), end_percent: Number(params.t8EndPercent ?? 0.95), max_consecutive_hits: Number(params.t8MaxConsecutiveHits ?? 2), cache_device: String(params.t8CacheDevice || "cpu"), metric_stride: Number(params.t8MetricStride ?? 8), verbose: params.t8Verbose === true });
    else {
        // SageAttention 单字段驱动（兼容旧 dedicatedAttention 字段）
        let sage = String(params.sageAttention ?? params.dedicatedAttention ?? "H3专用Sage加速");
        if (sage === "自动") sage = "auto";
        else if (sage === "关闭") sage = "disabled";
        if (sage === "H3专用Sage加速") model = node("nf_h3_attention", "MiniMaxH3MemoryEfficientSageAttentionPatch", { model: model(0) });
        else if (sage !== "disabled") model = node("nf_sage", "PathchSageAttentionKJ", { model: model(0), sage_attention: sage, allow_compile: params.allowCompile === true });
    }
        node("nf_condition_loaders", "NanFengH3ReleaseBeforeConditionLoadersV15", {
        clip_name: textEncoder, video_vae_name: videoVaeName, audio_vae_name: audioVaeName,
    });
    const clip = node("nf_clip", "CLIPLoader", { clip_name: textEncoder, type: String(params.textEncoderType || "minimax"), device: String(params.textEncoderDevice || "default") });
    const videoVae = node("nf_video_vae", "VAELoader", { vae_name: videoVaeName });
    const audioVae = node("nf_audio_vae", "VAELoader", { vae_name: audioVaeName });
    const promptBody = withNoTextConstraint(String(input.prompt || "").trim());
    const trigger = String(params.constantTriggerWord || "").trim();
    const prompt = trigger && promptBody ? `${trigger}\n${promptBody}` : trigger || promptBody;
    const refs = Array.isArray(input.references) ? input.references.map(String).filter(Boolean).slice(0, 9) : [];
    const videos = (Array.isArray(input.videos) ? input.videos.map(String).filter(Boolean) : typeof input.video === "string" ? [input.video] : []).slice(0, 3);
    const audios = Array.isArray(input.audios) ? input.audios.map(String).filter(Boolean).slice(0, 3) : [];
    const audioDriveFile = String(params.audioDriveFile || "").trim();
    // V10 音频驱动会用专属音频替代普通参考音频，且同一文件必须进入锁音频。
    const referenceAudios = params.audioDrive === true && audioDriveFile ? [audioDriveFile] : audios;
    const uploadedRefs = await Promise.all(refs.map(upload));
    const uploadedVideos = await Promise.all(videos.map(upload));
    const uploadedAudios = await Promise.all(referenceAudios.map(upload));
    validateNanFengMode(mode, uploadedRefs.length, uploadedVideos.length, uploadedAudios.length, params);
    const imageInputs: Record<string, any> = { clip: clip(0), vae: videoVae(0), prompt, width, height, length: durationToFrames(duration) };
    if (mode === "i2v" || mode === "fl2v") {
        const first = node("nf_first", "LoadImage", { image: uploadedRefs[0] });
        imageInputs.first_frame = node("nf_first_limit", "NanFengH3LimitImageLongEdgeV15", { image: first(0), max_long_edge: Number(params.referenceLongEdge || 1920) })(0);
        if (String(params.aspectRatio || "") === "原图比例") {
            const size = node("nf_original_canvas", "NanFengH3ImageCanvasSize32V15", { image: imageInputs.first_frame, megapixels });
            imageInputs.width = size(0); imageInputs.height = size(1);
        }
        if (mode === "fl2v") { const last = node("nf_last", "LoadImage", { image: uploadedRefs[1] }); imageInputs.last_frame = node("nf_last_limit", "NanFengH3LimitImageLongEdgeV15", { image: last(0), max_long_edge: Number(params.referenceLongEdge || 1920) })(0); }
    }
    let conditioning: any;
    let latent: any;
    if (mode === "t2v" || mode === "i2v" || mode === "fl2v") {
        const release = node("nf_condition_release", "NanFengH3ReleaseBeforeConditioningV15", { clip: clip(0), vae: videoVae(0) });
        imageInputs.clip = release(0); imageInputs.vae = release(1);
        const prepared = node("nf_image_condition", "MiniMaxH3ImageToVideo", imageInputs);
        conditioning = prepared(0); latent = prepared(1);
    } else {
        const refInputs: Record<string, any> = { clip: clip(0), vae: videoVae(0), audio_vae: audioVae(0), prompt: buildNanFengPrompt(prompt, uploadedRefs.length, uploadedVideos.length, uploadedAudios.length), width, height, length: durationToFrames(duration), ref_image_size: String(params.refImageSize || "match") };
        for (let i = 0; i < uploadedRefs.length; i += 1) { const loaded = node(`nf_image_${i}`, "LoadImage", { image: uploadedRefs[i] }); refInputs[`ref_images.ref_image_${i}`] = node(`nf_image_limit_${i}`, "NanFengH3LimitImageLongEdgeV15", { image: loaded(0), max_long_edge: Number(params.referenceLongEdge || 1920) })(0); }
        for (let i = 0; i < uploadedVideos.length; i += 1) { const video = node(`nf_video_${i}`, "LoadVideo", { file: uploadedVideos[i] }); const parts = node(`nf_video_parts_${i}`, "GetVideoComponents", { video: video(0) }); refInputs[`ref_videos.ref_video_${i}`] = parts(0); refInputs[`ref_video_audios.ref_video_audio_${i}`] = parts(1); }
        for (let i = 0; i < uploadedAudios.length; i += 1) { const loaded = node(`nf_audio_${i}`, "LoadAudio", { audio: uploadedAudios[i] }); refInputs[`ref_audios.ref_audio_${i}`] = params.audioDrive === true ? node(`nf_audio_trim_${i}`, "TrimAudioDuration", { audio: loaded(0), start_index: Number(params.audioDriveStart ?? 0), duration })(0) : loaded(0); }
        const prepared = node("nf_ref_condition", "MiniMaxH3ReferenceToVideo", refInputs);
        conditioning = prepared(0); latent = prepared(1);
    }
    let samplingModel = model(0);
    let exactAudio: any;
    if (params.lockAudio === true && mode === "ref2va" && uploadedAudios[0]) {
        const audio = node("nf_lock_audio", "LoadAudio", { audio: uploadedAudios[0] });
        const trimmed = node("nf_lock_audio_trim", "TrimAudioDuration", { audio: audio(0), start_index: params.audioDrive === true ? Number(params.audioDriveStart ?? 0) : 0, duration });
        const padded = params.audioDrive === true ? node("nf_lock_audio_pad", "NanFengAudioPadToDurationV15", { audio: trimmed(0), duration }) : trimmed;
        const locked = node("nf_audio_lock", "MiniMaxH3NativeAudioLock", { model: samplingModel, av_latent: latent, audio_vae: audioVae(0), audio: padded(0) });
        samplingModel = locked(0); latent = locked(1);
        exactAudio = locked(2);
    }
    const ready = node("nf_sampling_release", "NanFengH3ReleaseBeforeSamplingV15", { model: samplingModel, conditioning, latent });
    let samplingModelRef = ready(0);
    if (v10SolAttnEnabled && params.solAttnEnabled === true && params.slaEnabled !== true && params.t8Enabled !== true) samplingModelRef = node("nf_solattn", "SolAttnMiniMaxH3Patcher", { model: samplingModelRef, enabled: true, tau: Number(params.solAttnTau ?? 1.2), thresh_type: String(params.solAttnThresholdType || "diag"), exact_mode: String(params.solAttnExactMode || "exact_kv"), dense_steps: Number(params.solAttnDenseSteps ?? 1), step_off: Number(params.solAttnStepOff ?? 0), sink_tokens: Number(params.solAttnSinkTokens ?? 0) })(0);
    if (params.uniBlockSwapEnabled === true) samplingModelRef = node("nf_uniblock", "NanFengH3ApplyUniBlockSwapV15", { model: samplingModelRef, conditioning_dependency: ready(1), num_blocks: Number(params.uniBlockSwapBlocks ?? 1) })(0);
    if (params.realtimePreviewEnabled !== false) samplingModelRef = node("nf_preview", "NanFengH3KJPreviewBridgeV15", { model: samplingModelRef, target_node_id: String(params.targetNodeId || ""), max_resolution: Number(params.realtimePreviewLongEdge ?? 512), jpeg_quality: Number(params.realtimePreviewJpegQuality ?? 75), preview_frames: Number(params.realtimePreviewFrames ?? 12), preview_fps: Number(params.realtimePreviewFps ?? 8) })(0);
    if (v10LegacySigmaEnabled && params.sigmaEnabled === true) samplingModelRef = node("nf_sigma_shift", "MiniMaxH3SigmaShift", { model: samplingModelRef, shift_video: Number(params.videoSigmaShift ?? 12), shift_audio: Number(params.audioSigmaShift ?? 3) })(0);
    const guider = node("nf_guider", "BasicGuider", { model: samplingModelRef, conditioning: ready(1) });
    const sampler = node("nf_sampler", "KSamplerSelect", { sampler_name: String(params.sampler || "res_multistep") });
    const latentUpscaleRequested = params.latentUpscaleEnabled === true;
    const h3FirstSteps = Number(params.h3FirstSteps ?? 6);
    const h3SecondSteps = Number(params.h3SecondSteps ?? 4);
    const fullSigmaText = String(params.h3FullSigma || "").trim();
    const manualSigmaEnabled = params.v81ManualSigma === true;
    if (latentUpscaleRequested && fullSigmaText) validateNanFengFullSigma(fullSigmaText, h3FirstSteps, h3SecondSteps);
    else if (manualSigmaEnabled && fullSigmaText) validateNanFengSingleSigma(fullSigmaText);
    const scheduler = node("nf_scheduler", "BasicScheduler", { model: samplingModelRef, scheduler: String(params.scheduler || "simple"), steps: latentUpscaleRequested ? h3FirstSteps + h3SecondSteps : Number(v10LegacySecondPassEnabled && params.secondPassEnabled ? params.firstPassSteps ?? params.steps ?? 20 : params.steps || 20), denoise: Number(params.denoise ?? 1) });
    const requestedSeed = Number(params.seed);
    const noise = node("nf_noise", "RandomNoise", { noise_seed: Number.isFinite(requestedSeed) && requestedSeed >= 0 ? requestedSeed : Math.floor(Math.random() * 1125899906842624) });
    let sigmas = scheduler(0);
    let latentSigmaSplit: any;
    if ((latentUpscaleRequested || manualSigmaEnabled) && fullSigmaText) sigmas = node("nf_h3_full_sigmas", "ManualSigmas", { sigmas: fullSigmaText })(0);
    if (v10LegacySigmaEnabled && params.sigmaEnabled === true && String(params.manualSigma || "").trim() && String(params.sigmaMode || "低西格玛加密") === "手动序列") sigmas = node("nf_manual_sigmas", "ManualSigmas", { sigmas: String(params.manualSigma) })(0);
    else if (v10LegacySigmaEnabled && params.sigmaEnabled === true) sigmas = node("nf_sigma_extend", "ExtendIntermediateSigmas", { sigmas, steps: Number(params.sigmaRefineSteps ?? 2), start_at_sigma: Number(params.lowSigmaStart ?? 0.8), end_at_sigma: Number(params.lowSigmaEnd ?? 0), spacing: String(params.sigmaCurve || "cosine") })(0);
    // 采样 latent 与南风 V10 一致，必须使用 ReleaseBeforeSampling 的第三路输出。
    // 如果当前 ComfyUI 仍会破坏 NestedTensor，应修复该节点的返回/执行行为，不能在桥接层绕过它。
    if (latentUpscaleRequested) latentSigmaSplit = node("nf_h3_sigma_split", "SplitSigmas", { sigmas, step: h3FirstSteps });
    let sampled: (output?: number) => any;
    if (latentUpscaleRequested) {
        sampled = node("nf_sample_first", "SamplerCustomAdvanced", { noise: noise(0), guider: guider(0), sampler: sampler(0), sigmas: latentSigmaSplit(0), latent_image: ready(2) });
    } else if (v10LegacySigmaEnabled && params.dualSampling === true) {
        const split = node("nf_sigma_split", "SplitSigmasDenoise", { sigmas, denoise: Number(params.dualSamplingRatio ?? 0.5) });
        const first = node("nf_sample_first", "SamplerCustomAdvanced", { noise: noise(0), guider: guider(0), sampler: sampler(0), sigmas: split(0), latent_image: ready(2) });
        const secondSampler = node("nf_dual_sampler", "KSamplerSelect", { sampler_name: String(params.dualSampler || params.sampler || "res_multistep") });
        const noNoise = node("nf_dual_no_noise", "DisableNoise", {});
        sampled = node("nf_sample", "SamplerCustomAdvanced", { noise: noNoise(0), guider: guider(0), sampler: secondSampler(0), sigmas: split(1), latent_image: first(0) });
    } else sampled = node("nf_sample", "SamplerCustomAdvanced", { noise: noise(0), guider: guider(0), sampler: sampler(0), sigmas, latent_image: ready(2) });
    if (v10LegacySecondPassEnabled && params.secondPassEnabled === true) {
        // 当前运行实例未注册 NanFeng 源码 V5 分支依赖的 RebuildAVLatent；使用已注册的
        // AV latent 放大器，避免把视频单路 latent 重新接回 H3 而丢失音频流。
        const enlarged = node("nf_second_upscale", "NanFengH3LowPeakLatentUpscalerV15", {
            latent: sampled(0),
            model_name: String(params.secondPassLatentUpscaleModel || params.latentUpscaleModel || ""),
            target_megapixels: Number(params.secondPassMegapixels ?? 1),
            align: Number(params.secondPassLatentAlign ?? 2),
            device: "cuda",
            precision: String(params.secondPassLatentPrecision || "bf16"),
            aspect_ratio: "latent",
        });
        const released = node("nf_second_upscale_release", "NanFengH3ReleaseLatentUpscalerBeforeSecondPassV15", { latent: enlarged(0), conditioning: ready(1) });
        const secondModelName = String(params.secondPassModel && !String(params.secondPassModel).startsWith("跟随") ? params.secondPassModel : modelName);
        const secondReady = node("nf_second_release", "NanFengH3ReleaseBeforeSecondModelV15", { unet_name: secondModelName, conditioning: released(1), latent: released(0) });
        let secondModel = node("nf_second_model", "UNETLoader", { unet_name: secondModelName, weight_dtype: String(params.precision || "default") });
        if (params.slaEnabled === true) secondModel = node("nf_second_sla", "H3SLAAttention", { model: secondModel(0), enabled: true, sparsity_ratio: Number(params.slaSparsity ?? 0.9), block_size: String(params.slaBlockSize || "64"), min_seq_len: Number(params.slaMinSequence ?? 4096), dense_last_steps: Number(params.slaDenseLastSteps ?? 1), protect_audio: params.slaProtectAudio !== false, dense_steps: String(params.slaDenseSteps || "0"), dense_backend: String(params.slaBackend || "comfy_kitchen"), disable_fp16_accum: params.slaDisableFp16Accum !== false, stabilize_motion: params.slaStabilizeMotion !== false });
        else {
            // SageAttention 单字段驱动（兼容旧 dedicatedAttention 字段）
            let sage = String(params.sageAttention ?? params.dedicatedAttention ?? "H3专用Sage加速");
            if (sage === "自动") sage = "auto";
            else if (sage === "关闭") sage = "disabled";
            if (sage === "H3专用Sage加速") secondModel = node("nf_second_h3_attention", "MiniMaxH3MemoryEfficientSageAttentionPatch", { model: secondModel(0) });
            else if (sage !== "disabled") secondModel = node("nf_second_sage", "PathchSageAttentionKJ", { model: secondModel(0), sage_attention: sage, allow_compile: params.allowCompile === true });
        }
        const secondGuider = node("nf_second_guider", "BasicGuider", { model: secondModel(0), conditioning: secondReady(1) });
        const secondSampler = node("nf_second_sampler", "KSamplerSelect", { sampler_name: String(params.secondPassSampler || params.sampler || "res_multistep") });
        const secondScheduler = node("nf_second_scheduler", "BasicScheduler", { model: secondModel(0), scheduler: String(params.secondPassScheduler || params.scheduler || "simple"), steps: Number(params.secondPassSteps || 6), denoise: 1 });
        const secondSigmas = node("nf_second_trim_sigmas", "NanFengH3TrimSigmasAtStartV15", { sigmas: secondScheduler(0), start_sigma: Number(params.secondPassSigma ?? params.secondPassDenoise ?? 0.2) });
        sampled = node("nf_second_sample", "SamplerCustomAdvanced", { noise: noise(0), guider: secondGuider(0), sampler: secondSampler(0), sigmas: secondSigmas(0), latent_image: released(0) });
    }
    if (latentUpscaleRequested) {
        const requestedModel = String(params.latentUpscaleModel || "").trim();
        let latentUpscaleModel = requestedModel;
        let upscaleMissingReason = "前端未传入放大模型";
        let nodeOptionsEmpty = false;
        let nodeChoices: string[] = [];
        // 无论前端是否传入模型，都向 ComfyUI 查询该节点实际的 model_name 选项，
        // 用于校验「所选模型是否真的存在于该 ComfyUI 实例」。之前只在未传模型时才查，
        // 导致「传了模型但节点选项为空（shim 未生效）」的情况把错误丢给 ComfyUI 报模糊的
        // value not in list。这里显式校验，直接指向 shim 未在该实例生效。
        try {
            const response = await fetch(`${comfyUrl}/object_info/NanFengH3LowPeakLatentUpscalerV15`, { signal });
            if (!response.ok) {
                upscaleMissingReason = `ComfyUI 未暴露 NanFengH3LowPeakLatentUpscalerV15 节点（HTTP ${response.status}），请确认该节点已安装`;
            } else {
                const body = await response.json() as Record<string, any>;
                const rawChoices = body.NanFengH3LowPeakLatentUpscalerV15?.input?.required?.model_name?.[0];
                // 与 listLocalH3Models 的 readChoices 保持一致：过滤空字符串。
                // 节点在缺少上游 schema（未装 h3_upscaler_compat 兼容层）时会返回 ["","",...]。
                nodeChoices = Array.isArray(rawChoices) ? rawChoices.map(String).filter((value) => value.trim()) : [];
                nodeOptionsEmpty = nodeChoices.length === 0;
                if (!latentUpscaleModel) {
                    if (nodeOptionsEmpty) {
                        upscaleMissingReason = "ComfyUI 未返回任何放大模型（该节点的 model_name 选项为空）；请确认已安装 H3 放大器节点并重启 ComfyUI";
                    } else {
                        latentUpscaleModel = nodeChoices[0];
                    }
                } else if (nodeOptionsEmpty || !nodeChoices.includes(latentUpscaleModel)) {
                    // 前端已传入模型名，但节点实际选项里没有：说明该 ComfyUI 实例未生效 shim（选项为空）或模型名不匹配。
                    // 显式抛出，避免把错误丢给 ComfyUI 报模糊的 value not in list（容易被误解为「二采没生效」）。
                    throw new Error(`已启用 H3 潜空间放大，但所选模型「${latentUpscaleModel}」不在 ComfyUI 节点 NanFengH3LowPeakLatentUpscalerV15 的 model_name 选项里（该节点当前${nodeOptionsEmpty ? "选项为空" : `仅有：${nodeChoices.join("、")}`}）。请确认南风 V15 节点已加载并重启 ComfyUI。`);
                }
            }
        } catch (error) {
            if (error instanceof Error && error.message.startsWith("已启用 H3 潜空间放大，但所选模型")) throw error;
            upscaleMissingReason = `读取 NanFengH3LowPeakLatentUpscalerV15 节点失败：${error instanceof Error ? error.message : String(error)}`;
        }
        if (!latentUpscaleModel) throw new Error(`已启用 H3 潜空间放大，但无法确定放大模型（${upscaleMissingReason}）；请在 Clip 设置中选择模型，或确认 ComfyUI 中已安装该节点并刷新模型列表。`);
        const latentUp = node("nf_latent_upscale", "NanFengH3LowPeakLatentUpscalerV15", { latent: sampled(1), model_name: latentUpscaleModel, target_megapixels: Number(params.latentUpscaleMegapixels || 1), align: Number(params.latentUpscaleAlign || 2), device: "cuda", precision: String(params.latentUpscalePrecision || "bf16"), aspect_ratio: ratio });
        const clear = node("nf_latent_upscale_clear", "NanFengH3ClearUpscalerCacheResidentV15", { latent: latentUp(0), conditioning: ready(1) });
        const latentGuider = node("nf_latent_guider", "BasicGuider", { model: samplingModelRef, conditioning: clear(1) });
        const latentSampler = node("nf_latent_sampler", "KSamplerSelect", { sampler_name: String(params.sampler || "res_multistep") });
        sampled = node("nf_latent_second_sample", "SamplerCustomAdvanced", { noise: noise(0), guider: latentGuider(0), sampler: latentSampler(0), sigmas: latentSigmaSplit(1), latent_image: clear(0) });
    }
    let decodeSamples = sampled(0);
    // V10 的 LATENT 是视频/音频 NestedTensor；使用 NanFeng 的解码桥接节点，
    // 由它分别取两路，避免普通 VAEDecode 把 AV latent 当成单路 samples。
    const image = node("nf_image_decode", "NanFengH3TimedVideoVAEDecodeV15", { samples: decodeSamples, vae: videoVae(0) });
    const audio = exactAudio ? null : node("nf_audio_decode", "NanFengH3TimedAudioVAEDecodeV15", { samples: decodeSamples, vae: audioVae(0) });
    let outputImages = image(0);
    if (params.rtxEnabled === true) outputImages = node("nf_rtx", "NanFengH3RTXVideoSuperResolutionV15", { images: outputImages, resize_mode: params.rtxResizeMode === "目标尺寸" ? "target dimensions" : "scale by multiplier", scale: Number(params.rtxScale ?? 2), width: Number(params.rtxWidth ?? 1920), height: Number(params.rtxHeight ?? 1080), quality: String(params.rtxQuality || "ULTRA") })(0);
    node("nf_output", NANFENG_VHS_CLASS, { images: outputImages, audio: exactAudio || audio?.(0), filename_prefix: "NanFeng_H3", frame_rate: 24, format: "video/h264-mp4", loop_count: 0, pingpong: false, save_output: true });
    return graph;
}

// 兼容旧前端 taskMode（6 值）与 MCP 透传：统一收敛到 V10 的四模式。
function normalizeNanFengMode(raw: unknown): string {
    const value = String(raw || "").toLowerCase();
    if (value === "t2v") return "t2v";
    if (value === "i2v") return "i2v";
    if (value === "fl2v") return "fl2v";
    // r2v / rv2v / v2v 全部归入参考生视频(ref2va)
    return "ref2va";
}

function isMinimaxLoraPath(value: string) {
    return /(?:^|[\\/])minimax(?:[\\/]|$)/i.test(value);
}

function isH3ModelPath(value: string) {
    return /(?:^|[\\/])h3(?:[\\/]|$)/i.test(value);
}

function validateNanFengMode(mode: string, imageCount: number, videoCount: number, audioCount: number, params: Record<string, unknown>) {
    const refMode = NANFENG_REF2VA_MODES.has(mode);
    if (mode === "t2v" && imageCount) throw new Error("文生视频模式不能上传图片参考，请切换模式或清空图片。");
    if (mode === "i2v" && imageCount !== 1) throw new Error("图生视频模式必须且只接受 1 张图片（首帧）。");
    if (mode === "fl2v" && imageCount !== 2) throw new Error("首尾帧模式必须且只接受 2 张图片（首帧、尾帧）。");
    if (!refMode && (videoCount || audioCount)) throw new Error("当前模式不接受视频或音频参考，请切换到参考生视频(ref2va)。");
    if (!refMode && (params.lockAudio === true || params.audioDrive === true)) throw new Error("锁音频/音频驱动只在参考生视频(ref2va)模式可用。");
    if (params.audioDrive === true && params.lockAudio !== true) throw new Error("智能音频驱动必须同时开启锁音频。");
    if (params.audioDrive === true) {
        if (!String(params.audioDriveFile || "").trim()) throw new Error("智能音频驱动必须提供驱动音频文件。");
        const start = Number(params.audioDriveStart ?? 0);
        const end = Number(params.audioDriveEnd ?? 0);
        if (!Number.isFinite(start) || start < 0) throw new Error("音频驱动起始时间必须是非负数字。");
        if (!Number.isFinite(end) || end < 0 || (end > 0 && end <= start)) throw new Error("音频驱动结束时间必须大于起始时间。");
        if (end > 0 && Math.ceil(end - start) !== Math.trunc(Number(params.duration || 5))) throw new Error("音频驱动裁切时长必须与视频时长一致。");
    }
    if (params.lockAudio === true && audioCount === 0) throw new Error("开启锁音频后必须提供音频1。");
    if (params.lockAudio === true && params.audioDrive !== true && audioCount > 1) throw new Error("普通锁音频只允许使用音频1。");
    if (refMode && imageCount + videoCount + audioCount === 0) throw new Error("参考生视频(ref2va)至少需要一张图片、一个视频或一段音频。");
}

function validateNanFengFullSigma(value: string, firstSteps: number, secondSteps: number) {
    const values = value.match(/[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/g)?.map(Number).filter(Number.isFinite) || [];
    const expected = firstSteps + secondSteps + 1;
    if (firstSteps < 1 || secondSteps < 1 || values.length !== expected) throw new Error(`H3 完整 Sigma 序列必须包含 ${expected} 个数值（${firstSteps}+${secondSteps}+1）。`);
    if (values[0] < 0 || values[0] > 1 || Math.abs(values[values.length - 1]) > 1e-6) throw new Error("H3 完整 Sigma 序列必须从 0~1 开始并以 0 结束。");
    for (let index = 1; index < values.length; index += 1) if (values[index] > values[index - 1] + 1e-6) throw new Error("H3 完整 Sigma 序列必须单调递减。");
}

function validateNanFengSingleSigma(value: string) {
    const values = value.match(/[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/g)?.map(Number).filter(Number.isFinite) || [];
    if (values.length < 2 || values[0] < 0 || values[0] > 1 || Math.abs(values[values.length - 1]) > 1e-6) throw new Error("H3 一采手动 Sigma 至少需要两个数值，且必须从 0~1 开始并以 0 结束。");
    for (let index = 1; index < values.length; index += 1) if (values[index] > values[index - 1] + 1e-6) throw new Error("H3 一采手动 Sigma 序列必须单调递减。");
}

function ratioWidth(value: string) {
    const match = value.match(/^(\d+):\d+/);
    return Number(match?.[1] || 16);
}

function ratioHeight(value: string) {
    const match = value.match(/^\d+:(\d+)/);
    return Number(match?.[1] || 9);
}

function durationToFrames(seconds: number) {
    const frames = Math.max(5, Math.round(seconds * 24));
    return frames + (5 - frames % 17) % 17;
}

function buildNanFengPrompt(prompt: string, imageCount: number, videoCount: number, audioCount: number) {
    let text = prompt.trim();
    const replacements: Record<string, string> = {};
    for (let i = 1; i <= imageCount; i += 1) replacements[`@图片${i}`] = `<Picture ${i}>`;
    for (let i = 1; i <= videoCount; i += 1) {
        replacements[`@视频${i}`] = `<Video ${i}>`;
        replacements[`@视频音频${i}`] = `<Audio ${i}>`;
    }
    for (let i = 1; i <= audioCount; i += 1) replacements[`@音频${i}`] = `<Audio ${videoCount + i}>`;
    for (const [source, target] of Object.entries(replacements).sort(([a], [b]) => b.length - a.length)) text = text.split(source).join(target);
    return text;
}

function normalizeUrl(value: string) {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error("ComfyUI 地址必须使用 HTTP 或 HTTPS");
    return url.toString().replace(/\/$/, "");
}

function normalizeH3WorkflowModel(value: string) {
    const requested = value.trim();
    if (/hybrid_beta4_int8_convrot_2\.safetensors$/i.test(requested)) return "h3\\10Eros_minimax_h3_TURBO-hybrid_beta4_int8_convrot_2.safetensors";
    if (/hybrid_beta3_int8_convrot\.safetensors$/i.test(requested)) return "h3\\10Eros_minimax_h3_TURBO-hybrid_beta3_int8_convrot.safetensors";
    const aliases: Record<string, string> = {
        "minimax_h3_ref2va_pruned_int8_convrot.safetensors": "h3\\minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        "minimax_h3_ref2va_int8_convrot.safetensors": "h3\\minimax_h3_ref2va_int8_convrot.safetensors",
        "10eros_max_h3_turbo-hybrid_beta4_int8_convrot_2.safetensors": "h3\\10Eros_minimax_h3_TURBO-hybrid_beta4_int8_convrot_2.safetensors",
        "10eros_minimax_h3_turbo-hybrid_beta4_int8_convrot_2.safetensors": "h3\\10Eros_minimax_h3_TURBO-hybrid_beta4_int8_convrot_2.safetensors",
    };
    const key = requested.toLowerCase().replace(/^.*[\\/]/, "");
    return aliases[key] || requested;
}

async function resolveH3ModelParams(comfyUrl: string, params: Record<string, unknown>, signal: AbortSignal) {
    const requested = String(params.modelName || "").trim();
    if (!requested) return params;
    const normalizedRequested = normalizeH3WorkflowModel(requested);
    try {
        const response = await fetch(`${comfyUrl}/object_info/UNETLoader`, { signal });
        if (!response.ok) return { ...params, modelName: normalizedRequested };
        const body = await response.json() as Record<string, any>;
        const available = Array.isArray(body.UNETLoader?.input?.required?.unet_name?.[0]) ? body.UNETLoader.input.required.unet_name[0].map(String) : [];
        if (!available.length) return { ...params, modelName: normalizedRequested };
        const requestedKey = normalizedRequested.toLowerCase().replace(/[\\/_\s-]/g, "");
        const exact = available.find((name) => name.toLowerCase().replace(/[\\/_\s-]/g, "") === requestedKey);
        if (exact) return { ...params, modelName: exact };
        const requestedFile = normalizedRequested.replace(/^.*[\\/]/, "").toLowerCase();
        const suffixMatches = available.filter((name) => {
            const candidateFile = name.replace(/^.*[\\/]/, "").toLowerCase();
            return requestedFile.length >= 12 && candidateFile.endsWith(requestedFile);
        });
        if (suffixMatches.length === 1) return { ...params, modelName: suffixMatches[0] };
        const tokens = normalizedRequested.toLowerCase().split(/[\\/_\s-]+/).filter((token) => token.length >= 3 && token !== "max");
        const ranked = available.map((name) => {
            const candidate = name.toLowerCase();
            const score = tokens.reduce((sum, token) => sum + (candidate.includes(token) ? 1 : 0), 0);
            return { name, score };
        }).sort((a, b) => b.score - a.score);
        if (ranked[0] && ranked[0].score >= Math.max(3, Math.ceil(tokens.length * 0.55))) return { ...params, modelName: ranked[0].name };
        throw new Error(`ComfyUI 未找到 H3 模型 “${requested}”。可用模型：${available.filter((name) => /h3|minimax/i.test(name)).slice(0, 20).join("、") || available.slice(0, 20).join("、")}`);
    } catch (error) {
        if (error instanceof Error && /未找到 H3 模型/.test(error.message)) throw error;
        /* model discovery is optional when ComfyUI cannot expose object_info */
    }
    return { ...params, modelName: normalizedRequested };
}

function normalizeH3AspectRatio(value: string) {
    const aliases: Record<string, string> = {
        "16:9": "16:9 (Widescreen)", "9:16": "9:16 (Portrait Widescreen)", "1:1": "1:1 (Square)",
        "4:3": "4:3 (Standard)", "3:4": "3:4 (Portrait Standard)", "2:3": "2:3 (Portrait Photo)", "3:2": "3:2 (Photo)",
    };
    return aliases[value] || value;
}

/** 带重试的 fetch：ComfyUI 刚执行完时输出文件可能还在落盘，瞬时 404 应重试而非放弃。 */
async function fetchWithRetry(url: string, signal: AbortSignal, attempts = 4, delayMs = 400): Promise<Response> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i += 1) {
        if (signal.aborted) throw new Error("任务已取消");
        try {
            const res = await fetch(url, { signal });
            if (res.ok) return res;
            // 404 = 文件尚未落盘：重试等待；其它状态码直接返回交给上层处理
            if (res.status === 404 && i < attempts - 1) { await new Promise((resolve) => setTimeout(resolve, delayMs)); continue; }
            return res;
        } catch (error) {
            lastError = error;
            if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    if (lastError) throw lastError;
    throw new Error(`fetch ${url} 失败`);
}

export type CollectedMedia = { url: string; storageKey?: string; mimeType: string; filename: string; sourceUrl?: string };

export async function collectOutputMedia(outputs: Record<string, any>, baseUrl: string, mediaStore: MediaStore, signal: AbortSignal): Promise<CollectedMedia[]> {
    // 对齐旧版 Python 项目的做法：递归遍历 outputs 的所有键，收集任何带 filename 的条目，
    // 不局限于 images/gifs/videos 三个固定键——自定义节点（rgthree 的 a_images/b_images、
    // 各类 Save 节点的自定义键）也能被捞起。仅按 filename+subfolder+type 去重。
    const seen = new Set<string>();
    const items: Array<Record<string, any>> = [];
    const visit = (value: any) => {
        if (!value) return;
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (typeof value !== "object") return;
        if (typeof value.filename === "string" && value.filename) {
            // LoadImage/LoadVideo 等节点会把输入素材以 type=input 写进 history outputs，
            // 但部分 H3 VHS 输出也会落在 `infinite-canvas/output` 并错误标成 input。
            // 只排除普通输入目录，保留明确位于 output 子目录的生成视频。
            const outputType = String(value.type || "").trim().toLowerCase();
            const subfolder = String(value.subfolder || "");
            const isVideoOutput = /\.(mp4|webm|mov|m4v|mkv)$/i.test(String(value.filename)) && /(^|[\\/])output([\\/]|$)/i.test(subfolder);
            if (outputType === "input" && !isVideoOutput) return;
            const key = `${value.filename}|${value.subfolder || ""}|${value.type || ""}`;
            if (!seen.has(key)) { seen.add(key); items.push(value); }
            return;
        }
        Object.values(value).forEach(visit);
    };
    visit(outputs);
    return (await Promise.all(items.map(async (item) => {
        const query = new URLSearchParams({ filename: String(item.filename), subfolder: String(item.subfolder || ""), type: String(item.type || "output") });
        const sourceUrl = `${baseUrl}/view?${query.toString()}`;
        const response = await fetchWithRetry(sourceUrl, signal);
        if (!response.ok) return [{ url: sourceUrl, mimeType: mimeForOutput(item), filename: String(item.filename) }];
        const stored = mediaStore.store(Buffer.from(await response.arrayBuffer()), { name: String(item.filename), mimeType: mimeForOutput(item), category: "output" });
        return [{ url: mediaStore.url(stored), storageKey: stored.storageKey, mimeType: stored.mimeType, filename: String(item.filename), sourceUrl }];
    }))).flat();
}

function mimeForOutput(item: Record<string, any>) {
    const name = String(item.filename || "").toLowerCase();
    if (/\.(mp4|webm|mov|m4v|mkv)$/.test(name)) return "video/mp4";
    if (/\.wav$/.test(name)) return "audio/wav";
    if (/\.flac$/.test(name)) return "audio/flac";
    if (/\.ogg$/.test(name)) return "audio/ogg";
    if (/\.opus$/.test(name)) return "audio/opus";
    if (/\.aac$/.test(name)) return "audio/aac";
    if (/\.m4a$/.test(name)) return "audio/mp4";
    if (/\.mp3$/.test(name)) return "audio/mpeg";
    if (/\.gif$/.test(name)) return "image/gif";
    return "image/png";
}

export { PRESETS, buildWorkflow };
