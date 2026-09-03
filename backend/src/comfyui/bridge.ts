import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { MEDIA_DIR } from "../config.js";
import type { RuntimeTask } from "../db.js";
import type { MediaStore, SettingStore, TaskPatch, TaskStore } from "../stores/types.js";
import type { BackendEventBus } from "../events.js";
import { splitVideo } from "./video-segment.js";
import { buildMotionContextClip } from "./motion-context.js";

/** ComfyUI Bridge 的总后台侧依赖：任务走 task store，URL 走 setting store。 */
export type ComfyUiDeps = {
    tasks: TaskStore;
    settings: SettingStore;
    media: MediaStore;
    events?: BackendEventBus;
};

export type ComfyPreset = { id: string; name: string; kind: "image" | "video"; inputs: string[]; params: string[] };
export type ComfyModelCatalog = { models: string[]; loras: string[]; refreshedAt: string; error?: string };

const PRESETS: ComfyPreset[] = [
    { id: "z-image", name: "Z-Image 文生图", kind: "image", inputs: ["prompt"], params: ["width", "height", "seed"] },
    { id: "flux2-klein", name: "Flux2-Klein 多图编辑", kind: "image", inputs: ["prompt", "references"], params: ["seed"] },
    { id: "flashvsr-1.1", name: "FlashVSR 1.1 视频修复", kind: "video", inputs: ["video"], params: ["scale", "longEdge"] },
    { id: "minimax-h3", name: "南风 H3 V10 视频生成", kind: "video", inputs: ["video", "references", "audios", "segments"], params: ["mode", "duration", "aspectRatio", "megapixels", "sizeMultiple", "steps", "denoise", "seed", "modelName", "textEncoder", "videoVae", "audioVae", "precision", "sageAttention", "sampler", "scheduler", "loraName", "loraStrength", "lockAudio", "audioDrive", "audioDriveFile", "constantTriggerWord"] },
];

/** 总后台侧 ComfyUI Bridge：任务持久化统一走总后台 SQLite。 */
export class ComfyUiBackend {
    private url: string;
    private readonly deps: ComfyUiDeps;
    private readonly controllers = new Map<string, AbortController>();
    private readonly comfyExecutions = new Map<string, { url: string; promptId?: string }>();

    constructor(deps: ComfyUiDeps, baseUrl?: string) {
        this.deps = deps;
        const fallback = String(deps.settings.get("comfyui.url") || "http://127.0.0.1:8188");
        this.url = normalizeUrl((baseUrl ?? process.env.COMFYUI_URL) || fallback);
    }

    getUrl() { return this.url; }
    setUrl(url: string) { this.url = normalizeUrl(url); this.deps.settings.set("comfyui.url", this.url); return this.url; }
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
        const [models, loras] = await Promise.all([
            readChoices("UNETLoader", "unet_name"),
            readChoices("LoraLoader", "lora_name"),
        ]);
        return { models: [...new Set(models)].sort((a, b) => a.localeCompare(b)), loras: [...new Set(loras)].sort((a, b) => a.localeCompare(b)), refreshedAt: new Date().toISOString(), ...(errors.length ? { error: errors.join("; ") } : {}) };
    }

    async status() {
        try {
            const response = await fetch(`${this.url}/system_stats`);
            return { connected: response.ok, url: this.url, system: response.ok ? await response.json() : null, error: response.ok ? null : `HTTP ${response.status}` };
        } catch (error) { return { connected: false, url: this.url, system: null, error: error instanceof Error ? error.message : String(error) }; }
    }

    async run(preset: string, input: Record<string, unknown>, params: Record<string, unknown>, baseUrl?: string) {
        const definition = PRESETS.find((item) => item.id === preset);
        if (!definition) throw new Error(`Unknown ComfyUI preset: ${preset}`);
        const taskUrl = baseUrl ? normalizeUrl(baseUrl) : this.url;
        const task = this.deps.tasks.create(`comfyui:${preset}`, input, params);
        void this.execute(task, definition, taskUrl).catch((error) => this.fail(task.id, error));
        return task;
    }

    cancel(id: string) {
        this.controllers.get(id)?.abort();
        void this.cancelComfyExecution(id);
        const task = this.deps.tasks.cancel(id);
        this.deps.events?.publish({ type: "task.updated", entityId: id, payload: task });
        return task;
    }

    private async execute(task: RuntimeTask, preset: ComfyPreset, comfyUrl: string) {
        if (this.deps.tasks.get(task.id)?.status === "cancelled") return;
        const controller = new AbortController(); this.controllers.set(task.id, controller);
        this.comfyExecutions.set(task.id, { url: comfyUrl });
        try {
            this.updateTask(task.id, { status: "running", progress: 0.05 });
            this.deps.tasks.addEvent(task.id, "status", { status: "running" });
            const result = preset.id === "minimax-h3" && task.params.autoSplit === true && typeof task.input.video === "string"
                ? await this.executeH3Segments(task, preset.id, task.input, task.params, comfyUrl, controller)
                : await this.executeWorkflow(task, preset.id, task.input, task.params, comfyUrl, controller);
            this.updateTask(task.id, { status: "succeeded", progress: 1, result });
            this.deps.tasks.addEvent(task.id, "result", result);
        } finally { this.controllers.delete(task.id); this.comfyExecutions.delete(task.id); }
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
            const combined = localResults.length > 1 ? await concatLocalVideos(localResults) : undefined;
            if (!combined) return { segments, media: segmentMedia };
            const stored = this.deps.media.store(await readFile(combined), { name: path.basename(combined), mimeType: "video/mp4" });
            await rm(combined, { force: true });
            return { segments, media: [{ url: this.deps.media.url(stored), storageKey: stored.storageKey, mimeType: stored.mimeType, filename: path.basename(combined) }, ...segmentMedia] };
        } finally { await split.cleanup(); }
    }

    private async executeWorkflow(task: RuntimeTask, preset: string, input: Record<string, unknown>, params: Record<string, unknown>, comfyUrl: string, controller: AbortController) {
        const prepared = await prepareH3MotionContext(input, params);
        try {
            const uploadFn = (file: string) => this.upload(file, controller.signal, comfyUrl);
            const workflow = preset === "minimax-h3"
                ? await buildNanFengV10Workflow(prepared.input, params, uploadFn, comfyUrl, controller.signal)
                : await buildWorkflow(preset, prepared.input, params, uploadFn);
            const response = await fetch(`${comfyUrl}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: task.id }), signal: controller.signal });
            if (!response.ok) { const details = (await response.text()).trim().replace(/\s+/g, " ").slice(0, 4000); throw new Error(`ComfyUI /prompt failed: HTTP ${response.status}${details ? `: ${details}` : ""}`); }
            const body = await response.json() as { prompt_id?: string; node_errors?: unknown };
            if (!body.prompt_id) throw new Error(body.node_errors ? JSON.stringify(body.node_errors) : "ComfyUI did not return prompt_id");
            const execution = this.comfyExecutions.get(task.id);
            if (execution) execution.promptId = body.prompt_id;
            this.deps.tasks.addEvent(task.id, "submitted", { promptId: body.prompt_id });
            for (;;) {
                if (controller.signal.aborted) throw new Error("任务已取消");
                const historyResponse = await fetch(`${comfyUrl}/history/${encodeURIComponent(body.prompt_id)}`, { signal: controller.signal });
                if (historyResponse.ok) {
                    const history = await historyResponse.json() as Record<string, any>;
                    const item = history[body.prompt_id];
                    if (item?.status?.completed || item?.outputs) return { promptId: body.prompt_id, outputs: item.outputs || {}, media: await collectOutputMedia(item.outputs || {}, comfyUrl, this.deps.media, controller.signal), status: item.status || {} };
                    if (item?.status?.status_str === "error" || item?.status?.status_str === "failed") throw new Error(JSON.stringify(item.status));
                }
                await new Promise((resolve) => setTimeout(resolve, 1500));
            }
        } finally { await prepared.cleanup(); }
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

    private async upload(file: string, signal: AbortSignal, comfyUrl = this.url) {
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

    private fail(id: string, error: unknown) {
        if (this.deps.tasks.get(id)?.status === "cancelled") return;
        const message = error instanceof Error ? error.message : String(error);
        this.updateTask(id, { status: "failed", error: message });
        this.deps.tasks.addEvent(id, "error", { error: message });
    }

    private updateTask(id: string, patch: TaskPatch) {
        const task = this.deps.tasks.update(id, patch);
        const type = task.status === "succeeded" ? "task.completed" : task.status === "failed" ? "task.failed" : task.status === "queued" || task.status === "running" || task.status === "cancelled" ? "task.updated" : "task.updated";
        this.deps.events?.publish({ type, entityId: id, payload: task });
        return task;
    }
}

async function prepareH3MotionContext(input: Record<string, unknown>, params: Record<string, unknown>) {
    const previous = String(input.previousVideo || "");
    // 对齐旧画布 (Infinite-Canvas) 行为：只要 Motion Context 开启就先截取前一段的
    // 尾帧（最后 ~22 帧）作为 context，而不是把整段 previousVideo 直接喂给 9108 节点。
    // 递进增噪 (motionContextNoise) 仅控制是否在尾帧上叠加噪声，不再作为「是否截尾帧」的前置条件。
    if (!previous || params.motionContext === false) return { input, cleanup: async () => undefined };
    const target = path.join(os.tmpdir(), `infinite-canvas-h3-context-${crypto.randomUUID()}.mp4`);
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
    const files: Record<string, string> = { "z-image": "Z-Image.json", "flux2-klein": "Flux2-Klein.json", "flashvsr-1.1": path.join("custom", "视频修复FlashVSR1.1.json"), "minimax-h3": "NanFeng_H3_V10.json" };
    const source = JSON.parse(await readFile(path.join(root, files[preset]), "utf8")) as Record<string, any>;
    const promptText = String(input.prompt || "");
    const promptNode = preset === "z-image" ? source["23"] : preset === "flux2-klein" ? source["168"] : null;
    if (promptNode?.inputs) promptNode.inputs.text = promptText;
    if (preset === "z-image" && source["144"]?.inputs) { source["144"].inputs.width = Number(params.width || 1024); source["144"].inputs.height = Number(params.height || 1024); }
    if (preset === "z-image" && source["22"]?.inputs && params.seed !== undefined) source["22"].inputs.seed = Number(params.seed);
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
        if (source["158"]?.inputs && params.seed !== undefined) source["158"].inputs.noise_seed = Number(params.seed);
    }
    if (preset === "flashvsr-1.1" && source["2"]?.inputs) source["2"].inputs.value = Number(params.scale || 2);
    if (preset === "flashvsr-1.1" && source["40"]?.inputs && params.longEdge !== undefined && params.longEdge !== "auto") source["40"].inputs.longer_edge = Number(params.longEdge);
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
        if (typeof params.loraName === "string" && params.loraName.trim()) {
            source["9071"] = { class_type: "LoraLoader", inputs: { model: ["127", 0], clip: ["128", 0], lora_name: params.loraName.trim(), strength_model: Number(params.loraStrength ?? 1), strength_clip: 0 }, _meta: { title: "MiniMax H3 LoRA" } };
            source["124"].inputs.model = ["9071", 0];
            source["126"].inputs.model = ["9071", 0];
            source["136"].inputs.clip = ["9071", 1];
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
        if (typeof params.loraName === "string" && params.loraName.trim() && source["9071"] && source["136"]?.inputs) source["136"].inputs.clip = ["9071", 1];
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
            if (previousVideo && params.motionContext !== false) {
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
// 南风 H3 V10 工作流构造
//
// V10 是 mega 节点：模型/文本编码器/双 VAE/采样器/8 个 LoRA 槽全部是其输入，
// 内部用 GraphBuilder 自建采样图。参考图/视频/音频是「文件名 combo」（读 ComfyUI
// input 目录），不走节点连线。输出 (IMAGE, AUDIO)，必须由 VHS_VideoCombine 收成 mp4。
// 多段续段（旧 MiniMaxH3MotionContext 节点）改为：把前一段尾帧视频作为「参考视频槽 1」
// 喂入 Ref2VA（H3 官方续段方式），用户参考视频顺延到槽 2–3。
// ─────────────────────────────────────────────────────────────────────────
const NANFENG_V10_CLASS = "NanFengH3MultiReferenceGeneratorV10";
const NANFENG_VHS_CLASS = "VHS_VideoCombine";
const NANFENG_REF2VA_MODES = new Set(["ref2va"]);

async function buildNanFengV10Workflow(
    input: Record<string, unknown>,
    params: Record<string, unknown>,
    upload: (file: string) => Promise<string>,
    comfyUrl: string,
    signal: AbortSignal,
): Promise<Record<string, any>> {
    let v10Defaults: Record<string, any> | null = null;
    let vhsDefaults: Record<string, any> | null = null;
    try {
        v10Defaults = await fetchObjectInfoDefaults(comfyUrl, NANFENG_V10_CLASS, signal);
    } catch { /* 走兜底模板 */ }
    try {
        vhsDefaults = await fetchObjectInfoDefaults(comfyUrl, NANFENG_VHS_CLASS, signal);
    } catch { /* 走兜底模板 */ }

    if (!v10Defaults) {
        const { readFile } = await import("node:fs/promises");
        const root = path.resolve(process.env.INFINITE_CANVAS_WORKFLOWS || path.join(path.dirname(fileURLToPath(import.meta.url)), "../..", "workflows"));
        const template = JSON.parse(await readFile(path.join(root, "NanFeng_H3_V10.json"), "utf8")) as Record<string, any>;
        throw new Error("南风底层图构造失败：不再使用 NanFeng_H3_V10.json 模板");
    }

    const mode = normalizeNanFengMode(params.mode ?? params.taskMode ?? (typeof input.video === "string" ? "ref2va" : "t2v"));

    setIfString(v10, "模型", params.modelName);
    setIfString(v10, "文本编码器", params.textEncoder);
    setIfString(v10, "视频VAE", params.videoVae);
    setIfString(v10, "音频VAE", params.audioVae);
    setIfString(v10, "模型权重精度", params.precision);
    setIfString(v10, "SageAttention", params.sageAttention);
    if (typeof params.aspectRatio === "string" && params.aspectRatio) v10["画面比例"] = normalizeH3AspectRatio(params.aspectRatio);
    if (Number.isFinite(Number(params.megapixels)) && Number(params.megapixels) > 0) v10["百万像素"] = Number(params.megapixels);
    if (Number.isFinite(Number(params.sizeMultiple))) v10["尺寸倍数"] = Number(params.sizeMultiple);
    v10["时长秒"] = Math.max(1, Math.min(15, Number(params.duration || 5)));
    if (typeof input.prompt === "string" && input.prompt) v10["提示词"] = input.prompt;
    if (params.seed !== undefined && params.seed !== null && String(params.seed).trim() !== "") v10["随机种子"] = Number(params.seed);
    setIfString(v10, "采样器", params.sampler);
    setIfString(v10, "调度器", params.scheduler);
    if (Number.isFinite(Number(params.steps))) v10["采样步数"] = Number(params.steps);
    if (Number.isFinite(Number(params.denoise))) v10["降噪强度"] = Number(params.denoise);
    setIfString(v10, "参考图尺寸", params.refImageSize);
    if (typeof params.constantTriggerWord === "string") v10["恒定触发词"] = params.constantTriggerWord;

    v10["文生视频"] = mode === "t2v";
    v10["图生视频"] = mode === "i2v";
    v10["首尾帧"] = mode === "fl2v";

    const refMode = NANFENG_REF2VA_MODES.has(mode);
    v10["启用锁音频"] = refMode && params.lockAudio === true;
    v10["开启音频驱动模式"] = refMode && params.audioDrive === true;
    if (refMode && typeof params.audioDriveFile === "string") v10["音频驱动文件"] = params.audioDriveFile;

    const images = (Array.isArray(input.references) ? input.references.map(String).filter(Boolean) : []).slice(0, 9);
    const uploadedImages = await Promise.all(images.map((file) => upload(file)));
    const userVideos = (Array.isArray(input.videos) ? input.videos.map(String).filter(Boolean) : []).slice(0, 3);
    if (userVideos.length === 0 && typeof input.video === "string") userVideos.push(input.video);
    const previousVideo = String(input.previousVideo || "");
    const uploadedUserVideos = await Promise.all(userVideos.map((file) => upload(file)));
    const audios = (Array.isArray(input.audios) ? input.audios.map(String).filter(Boolean) : []).slice(0, 3);
    const uploadedAudios = await Promise.all(audios.map((file) => upload(file)));

    validateNanFengMode(mode, uploadedImages.length, uploadedUserVideos.length, uploadedAudios.length, params);

    for (let i = 0; i < uploadedImages.length; i += 1) v10[`图片${i + 1}`] = uploadedImages[i];

    const videoSlots: string[] = [];
    if (previousVideo && refMode) videoSlots.push(await upload(previousVideo));
    for (const v of uploadedUserVideos) {
        if (videoSlots.length >= 3) break;
        videoSlots.push(v);
    }
    for (let i = 0; i < videoSlots.length; i += 1) v10[`视频${i + 1}`] = videoSlots[i];

    for (let i = 0; i < uploadedAudios.length; i += 1) v10[`音频${i + 1}`] = uploadedAudios[i];

    const vhs: Record<string, any> = { ...(vhsDefaults || { images: ["1", 0], audio: ["1", 1], filename_prefix: "NanFeng_H3", frame_rate: 24, format: "video/h264-mp4", save_output: true }) };
    vhs.images = ["1", 0];
    if ("audio" in vhs) vhs.audio = ["1", 1];

    return {
        "1": { class_type: NANFENG_V10_CLASS, inputs: v10, _meta: { title: "南风 H3 V10" } },
        "2": { class_type: NANFENG_VHS_CLASS, inputs: vhs, _meta: { title: "VHS Video Combine" } },
    };
}

async function fetchObjectInfoDefaults(comfyUrl: string, className: string, signal: AbortSignal): Promise<Record<string, any> | null> {
    const response = await fetch(`${comfyUrl}/object_info/${encodeURIComponent(className)}`, { signal });
    if (!response.ok) return null;
    const body = await response.json() as Record<string, any>;
    const required = body?.[className]?.input?.required;
    if (!required || typeof required !== "object") return null;
    const defaults: Record<string, any> = {};
    for (const [key, spec] of Object.entries(required) as Array<[string, any]>) {
        const meta = Array.isArray(spec) ? spec[spec.length - 1] : {};
        defaults[key] = meta && typeof meta === "object" && "default" in meta ? meta.default : (Array.isArray(spec) ? spec[0] : spec);
    }
    return defaults;
}

function setIfString(target: Record<string, any>, key: string, value: unknown) {
    if (typeof value === "string" && value.trim()) target[key] = value.trim();
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

function validateNanFengMode(mode: string, imageCount: number, videoCount: number, audioCount: number, params: Record<string, unknown>) {    const refMode = NANFENG_REF2VA_MODES.has(mode);
    if (mode === "t2v" && imageCount) throw new Error("文生视频模式不能上传图片参考，请切换模式或清空图片。");
    if (mode === "i2v" && imageCount !== 1) throw new Error("图生视频模式必须且只接受 1 张图片（首帧）。");
    if (mode === "fl2v" && imageCount !== 2) throw new Error("首尾帧模式必须且只接受 2 张图片（首帧、尾帧）。");
    if (!refMode && videoCount) throw new Error("当前模式不接受视频参考，请切换到参考生视频(ref2va)。");
    if (!refMode && (params.lockAudio === true || params.audioDrive === true)) throw new Error("锁音频/音频驱动只在参考生视频(ref2va)模式可用。");
}

// object_info 不可达时，以打包的 NanFeng_H3_V10.json 为基底注入参数。
async function applyNanFengV10Params(
    template: Record<string, any>,
    input: Record<string, unknown>,
    params: Record<string, unknown>,
    upload: (file: string) => Promise<string>,
    comfyUrl: string,
    signal: AbortSignal,
): Promise<Record<string, any>> {
    const v10Node = template["1"];
    if (!v10Node) throw new Error("NanFeng_H3_V10.json 缺少主节点 \"1\"");
    const v10 = v10Node.inputs as Record<string, any>;
    const mode = normalizeNanFengMode(params.mode ?? params.taskMode ?? (typeof input.video === "string" ? "ref2va" : "t2v"));

    setIfString(v10, "模型", params.modelName);
    setIfString(v10, "文本编码器", params.textEncoder);
    setIfString(v10, "视频VAE", params.videoVae);
    setIfString(v10, "音频VAE", params.audioVae);
    setIfString(v10, "模型权重精度", params.precision);
    setIfString(v10, "SageAttention", params.sageAttention);
    if (typeof params.aspectRatio === "string" && params.aspectRatio) v10["画面比例"] = normalizeH3AspectRatio(params.aspectRatio);
    if (Number.isFinite(Number(params.megapixels)) && Number(params.megapixels) > 0) v10["百万像素"] = Number(params.megapixels);
    v10["时长秒"] = Math.max(1, Math.min(15, Number(params.duration || 5)));
    if (typeof input.prompt === "string" && input.prompt) v10["提示词"] = input.prompt;
    if (params.seed !== undefined && params.seed !== null && String(params.seed).trim() !== "") v10["随机种子"] = Number(params.seed);
    setIfString(v10, "采样器", params.sampler);
    setIfString(v10, "调度器", params.scheduler);
    if (Number.isFinite(Number(params.steps))) v10["采样步数"] = Number(params.steps);
    if (Number.isFinite(Number(params.denoise))) v10["降噪强度"] = Number(params.denoise);
    setIfString(v10, "参考图尺寸", params.refImageSize);
    if (typeof params.constantTriggerWord === "string") v10["恒定触发词"] = params.constantTriggerWord;
    v10["文生视频"] = mode === "t2v";
    v10["图生视频"] = mode === "i2v";
    v10["首尾帧"] = mode === "fl2v";
    const refMode = NANFENG_REF2VA_MODES.has(mode);
    v10["启用锁音频"] = refMode && params.lockAudio === true;
    v10["开启音频驱动模式"] = refMode && params.audioDrive === true;
    if (refMode && typeof params.audioDriveFile === "string") v10["音频驱动文件"] = params.audioDriveFile;

    const images = (Array.isArray(input.references) ? input.references.map(String).filter(Boolean) : []).slice(0, 9);
    const uploadedImages = await Promise.all(images.map((file) => upload(file)));
    const userVideos = (Array.isArray(input.videos) ? input.videos.map(String).filter(Boolean) : []).slice(0, 3);
    if (userVideos.length === 0 && typeof input.video === "string") userVideos.push(input.video);
    const previousVideo = String(input.previousVideo || "");
    const uploadedUserVideos = await Promise.all(userVideos.map((file) => upload(file)));
    const audios = (Array.isArray(input.audios) ? input.audios.map(String).filter(Boolean) : []).slice(0, 3);
    const uploadedAudios = await Promise.all(audios.map((file) => upload(file)));
    validateNanFengMode(mode, uploadedImages.length, uploadedUserVideos.length, uploadedAudios.length, params);
    for (let i = 0; i < uploadedImages.length; i += 1) v10[`图片${i + 1}`] = uploadedImages[i];
    const videoSlots: string[] = [];
    if (previousVideo && refMode) videoSlots.push(await upload(previousVideo));
    for (const v of uploadedUserVideos) { if (videoSlots.length >= 3) break; videoSlots.push(v); }
    for (let i = 0; i < videoSlots.length; i += 1) v10[`视频${i + 1}`] = videoSlots[i];
    for (let i = 0; i < uploadedAudios.length; i += 1) v10[`音频${i + 1}`] = uploadedAudios[i];

    let vhs: Record<string, any> | null = null;
    try { vhs = await fetchObjectInfoDefaults(comfyUrl, NANFENG_VHS_CLASS, signal); } catch { vhs = null; }
    template["2"] = {
        class_type: NANFENG_VHS_CLASS,
        inputs: { ...(vhs || { images: ["1", 0], audio: ["1", 1] }), images: ["1", 0] },
        _meta: { title: "VHS Video Combine" },
    };
    if ("audio" in template["2"].inputs) template["2"].inputs.audio = ["1", 1];
    return template;
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

async function collectOutputMedia(outputs: Record<string, any>, baseUrl: string, mediaStore: MediaStore, signal: AbortSignal) {
    const items = Object.values(outputs).flatMap((output) => [ ...(output?.images || []), ...(output?.gifs || []), ...(output?.videos || []) ]);
    return (await Promise.all(items.map(async (item) => {
        if (!item?.filename) return [];
        const query = new URLSearchParams({ filename: String(item.filename), subfolder: String(item.subfolder || ""), type: String(item.type || "output") });
        const sourceUrl = `${baseUrl}/view?${query.toString()}`;
        const response = await fetch(sourceUrl, { signal });
        if (!response.ok) return [{ url: sourceUrl, mimeType: mimeForOutput(item), filename: String(item.filename) }];
        const stored = mediaStore.store(Buffer.from(await response.arrayBuffer()), { name: String(item.filename), mimeType: mimeForOutput(item) });
        return [{ url: mediaStore.url(stored), storageKey: stored.storageKey, mimeType: stored.mimeType, filename: String(item.filename), sourceUrl }];
    }))).flat();
}

function mimeForOutput(item: Record<string, any>) {
    const name = String(item.filename || "").toLowerCase();
    if (/\.(mp4|webm|mov|m4v|mkv)$/.test(name)) return "video/mp4";
    if (/\.(mp3|wav|ogg|opus|flac|aac|m4a)$/.test(name)) return "audio/mpeg";
    if (/\.gif$/.test(name)) return "image/gif";
    return "image/png";
}

export { PRESETS, buildWorkflow };
