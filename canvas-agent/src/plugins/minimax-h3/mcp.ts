import { readFile } from "node:fs/promises";

import type { AgentCanvasNode, McpToolHandler, PluginMcpContext, PluginMcpModule, PluginMcpToolWire } from "../../server/plugin-mcp.js";
import { normalizeH3GenerationSettings, normalizePlannedSegment, validateVideoPlan, type H3PlannedSegment } from "./video-plan.js";

// 一个 H3 参考图/视频/音频条目(与浏览器插件 H3Ref 对齐,此处防御式解析)
type H3Ref = { url?: string; name?: string; type?: string; storageKey?: string; mimeType?: string; role?: string; subjectId?: string; order?: number; nodeId?: string };

// H3 片段(节点 metadata.segments 中的元素)
type H3Segment = Record<string, unknown> & {
    id?: string;
    prompt?: string;
    status?: string;
    result?: unknown;
    resultStorageKey?: string;
    refs?: { image?: H3Ref | H3Ref[]; video?: H3Ref | H3Ref[]; audio?: H3Ref | H3Ref[] };
    refItems?: H3Ref[];
};

// 与 H3 前端 Settings 面板的可持久化字段保持同一份有序协议；领域字段使用 videoSteps，
// 仅在提交 ComfyUI 时映射为它要求的 steps。
const H3_PARAM_KEYS = [
    "mode", "taskMode", "duration", "aspectRatio", "megapixels", "videoSteps", "steps", "denoise", "noiseSeedMode", "noiseSeed", "seed",
    "modelName", "textEncoder", "textEncoderType", "textEncoderDevice", "videoVae", "audioVae", "precision", "sageAttention", "allowCompile", "sizeMultiple", "sampler", "scheduler",
    "loraSlots", "constantTriggerWord", "lockAudio", "audioDrive", "audioDriveFile", "audioDriveMarkers", "audioDriveSegmentImages", "audioDriveSegmentStoryboards", "audioDriveCreative", "audioDriveExclude", "audioDriveStart", "audioDriveEnd",
    "solAttnEnabled", "solAttnTau", "solAttnThresholdType", "solAttnExactMode", "solAttnDenseSteps", "solAttnStepOff", "solAttnSinkTokens",
    "t8Enabled", "t8ResidualThreshold", "t8StartPercent", "t8EndPercent", "t8MaxConsecutiveHits", "t8CacheDevice", "t8MetricStride", "t8Verbose",
    "sigmaEnabled", "videoSigmaShift", "audioSigmaShift", "sigmaMode", "lowSigmaStart", "lowSigmaEnd", "sigmaRefineSteps", "sigmaCurve", "manualSigma", "dualSampling", "dualSamplingRatio", "dualSampler",
    "secondPassEnabled", "firstPassSteps", "secondPassSteps", "secondPassMegapixels", "secondPassUpscaleMethod", "secondPassDenoise", "secondPassSampler", "secondPassScheduler", "secondPassModel", "secondPassSigma",
    "dedicatedAttention", "startupMode", "faceRepairSingle", "faceRepairMulti", "globalRepair", "lowMemoryAttentionHeads", "reservedVramGb", "runtimeReserveEnabled", "uniBlockSwapEnabled", "uniBlockSwapBlocks",
    "latentUpscaleEnabled", "h3FirstSteps", "h3SecondSteps", "h3FullSigma", "v81ManualSigma", "latentUpscaleModel", "latentUpscaleMegapixels", "latentUpscaleAlign", "latentUpscalePrecision",
    "realtimePreviewEnabled", "realtimePreviewLongEdge", "realtimePreviewFrames", "realtimePreviewFps", "realtimePreviewJpegQuality",
    "rtxEnabled", "rtxResizeMode", "rtxScale", "rtxWidth", "rtxHeight", "rtxQuality",
    "slaEnabled", "slaSparsity", "slaBlockSize", "slaMinSequence", "slaDenseLastSteps", "slaProtectAudio", "slaDenseSteps", "slaBackend", "slaDisableFp16Accum", "slaStabilizeMotion",
    "refImageSize", "referenceLongEdge", "loraName", "loraStrength", "teAccel", "noDub", "noCaption", "audioMode", "audioDenoiseStrength", "addSourceAsReference", "promptPrimaryAudioOrdinal", "strictPromptTags",
    "referenceVideoPolicy", "trimIn", "trimOut", "motionContextEnabled", "tailFrameEnabled", "motionContextNoiseEnabled", "motionContextNoiseAlpha", "motionContextNoiseAlphaEnd", "motionContextNoiseRampFrames", "combatLoraWeight", "cinematicLoraWeight",
] as const;

// 工具元信息(声明,供 Agent 动态注册)
const TOOLS: PluginMcpToolWire[] = [
    {
        id: "h3_list_models",
        version: "1.2.0",
        name: "H3 列出模型",
        description: "列出 MiniMax H3 可用的模型(unet)与 LoRA 清单。",
        inputJsonSchema: { type: "object", properties: {} },
    },
    {
        id: "h3_get_node",
        version: "1.2.0",
        name: "H3 读取画布节点",
        description: "按节点 id 读取画布上的 MiniMax H3 节点及其片段/参考图配置。",
        inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string", description: "画布节点 id" } }, required: ["projectId", "nodeId"] },
    },
    {
        id: "h3_run_clip",
        version: "1.2.0",
        name: "H3 运行单段",
        description: "读取指定画布 H3 节点的某个片段(或全部片段),解析参考图/视频/音频后提交 ComfyUI 生成任务。",
        inputJsonSchema: {
            type: "object",
            properties: {
                nodeId: { type: "string", description: "画布节点 id" },
                projectId: { type: "string", description: "画布项目 id" },
                segmentIndex: { type: "integer", description: "片段下标;省略则运行首个未完成的片段" },
                params: { type: "object", description: "覆盖片段自带参数的生成参数" },
                idempotencyKey: { type: "string", description: "幂等提交键，重复提交复用原任务" },
            },
            required: ["projectId", "nodeId"],
        },
    },
    {
        id: "h3_get_defaults",
        version: "1.3.0",
        name: "H3 读取默认参数",
        description: "读取 Backend 中保存的 MiniMax H3 默认参数。",
        inputJsonSchema: { type: "object", properties: {} },
    },
    {
        id: "h3_set_defaults",
        version: "1.3.0",
        name: "H3 保存默认参数",
        description: "把 H3 生成参数保存为全局默认参数，新建节点和 MCP 运行共享该配置。",
        inputJsonSchema: { type: "object", properties: { settings: { type: "object" } }, required: ["settings"] },
    },
    {
        id: "h3_reset_defaults",
        version: "1.3.0",
        name: "H3 重置默认参数",
        description: "删除 Backend 中保存的 H3 默认参数。",
        inputJsonSchema: { type: "object", properties: {} },
    },
    {
        id: "h3_apply_video_plan",
        version: "1.3.0",
        name: "H3 应用结构化视频计划",
        description: "把按镜号拆分的结构化中文视频计划写入 H3 节点，并按角色化参考清单生成最终提示词。",
        inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" }, replaceSegments: { type: "boolean" }, language: { type: "string", enum: ["zh-CN"] }, segments: { type: "array", items: { type: "object" } } }, required: ["projectId", "nodeId", "segments"] },
    },
    {
        id: "h3_get_task",
        version: "1.2.0",
        name: "H3 查询任务",
        description: "按任务 id 查询 MiniMax H3 生成任务的状态、进度与结果。",
        inputJsonSchema: { type: "object", properties: { taskId: { type: "string", description: "任务 id" } }, required: ["taskId"] },
    },
    {
        id: "h3_cancel_task",
        version: "1.2.0",
        name: "H3 取消任务",
        description: "取消正在运行的 MiniMax H3 生成任务。",
        inputJsonSchema: { type: "object", properties: { taskId: { type: "string", description: "任务 id" } }, required: ["taskId"] },
    },
    {
        id: "h3_update_clip",
        version: "1.2.0",
        name: "H3 更新片段",
        description: "更新画布 H3 节点某个片段的部分字段(如 prompt、参数或状态),写回节点 metadata。",
        inputJsonSchema: {
            type: "object",
            properties: {
                nodeId: { type: "string", description: "画布节点 id" },
                projectId: { type: "string", description: "画布项目 id" },
                segmentIndex: { type: "integer", description: "片段下标" },
                patch: { type: "object", description: "要合并进该片段的字段" },
            },
            required: ["projectId", "nodeId", "segmentIndex", "patch"],
        },
    },
    {
        id: "h3_run_all_clips",
        version: "1.2.0",
        name: "H3 运行全部片段",
        description: "对画布上所有(或指定的)MiniMax H3 节点,提交其未完成片段的生成任务。",
        inputJsonSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", description: "画布项目 id" },
                nodeIds: { type: "array", items: { type: "string" }, description: "限定运行的节点 id;省略则运行全部 H3 节点" },
                params: { type: "object", description: "覆盖片段自带参数的生成参数" },
            },
            required: ["projectId"],
        },
    },
];

function segmentsOf(node: AgentCanvasNode): H3Segment[] {
    const meta = node.metadata || {};
    const raw = meta.segments;
    if (Array.isArray(raw)) return raw as H3Segment[];
    return [];
}

function isH3Node(node: AgentCanvasNode): boolean {
    return String(node.type || "").includes("minimax");
}

function collectRefs(segment: H3Segment): { images: H3Ref[]; videos: H3Ref[]; audios: H3Ref[] } {
    const refs = segment.refs || {};
    const asArray = (value: H3Ref | H3Ref[] | undefined): H3Ref[] => {
        if (!value) return [];
        return Array.isArray(value) ? value : [value];
    };
    const bucketRefs = [...asArray(refs.image), ...asArray(refs.video), ...asArray(refs.audio)];
    const orderedRefs = (segment.refItems?.length ? segment.refItems : bucketRefs)
        .filter((ref) => ref.role !== "character_identity")
        .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
    const sameRef = (left: H3Ref, right: H3Ref) => left.storageKey && right.storageKey
        ? left.storageKey === right.storageKey
        : left.url === right.url;
    const unique = (items: H3Ref[]) => items.filter((item, index, all) => all.findIndex((candidate) => sameRef(candidate, item)) === index);
    const images = unique(orderedRefs.filter((r) => r.type === "image" || (!r.type && /\.(png|jpe?g|webp|gif)$/i.test(r.name || ""))));
    const videos = unique(orderedRefs.filter((r) => r.type === "video" || (!r.type && /\.(mp4|webm|mov)$/i.test(r.name || ""))));
    const audios = unique(orderedRefs.filter((r) => r.type === "audio" || (!r.type && /\.(mp3|wav|m4a|flac)$/i.test(r.name || ""))));
    return { images, videos, audios };
}

/** 将参考条目(url/dataURL/本地路径)落地为 Agent 运行时媒体路径,供 ComfyUIBridge 上传。 */
async function resolveRefToPath(context: PluginMcpContext, ref: H3Ref): Promise<string> {
    const url = ref.url || "";
    const name = ref.name || "ref";
    const storageKey = ref.storageKey || extractMediaStorageKey(url);
    if (storageKey) return (await context.backend.runtimeMediaStore(name, "", storageKey)).path;
    if (!url) throw new Error(`参考条目缺少可读取地址:${name}`);
    if (url.startsWith("data:")) return (await context.backend.runtimeMediaStore(name, url)).path;
    if (/^https?:\/\//i.test(url)) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`读取参考失败 HTTP ${response.status}:${name}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const mime = response.headers.get("content-type") || "application/octet-stream";
        return (await context.backend.runtimeMediaStore(name, `data:${mime};base64,${buffer.toString("base64")}`)).path;
    }
    // 本地文件
    const buffer = await readFile(url);
    const mime = /\.png$/i.test(name) ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.webp$/i.test(name) ? "image/webp" : /\.mp4$/i.test(name) ? "video/mp4" : /\.mp3$/i.test(name) ? "audio/mpeg" : "application/octet-stream";
    return (await context.backend.runtimeMediaStore(name, `data:${mime};base64,${buffer.toString("base64")}`)).path;
}

function extractMediaStorageKey(url: string) {
    try {
        const parsed = new URL(url, "http://infinite-canvas.local");
        if (!parsed.pathname.startsWith("/media/")) return "";
        const key = decodeURIComponent(parsed.pathname.slice("/media/".length));
        return key && !key.includes("/") ? key : "";
    } catch {
        return "";
    }
}

function extractParams(segment: H3Segment, override: Record<string, unknown> = {}, nodeMetadata: Record<string, unknown> = {}, defaults: Record<string, unknown> = {}): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    const nodeParams = nodeMetadata.comfyParams && typeof nodeMetadata.comfyParams === "object" && !Array.isArray(nodeMetadata.comfyParams)
        ? nodeMetadata.comfyParams as Record<string, unknown> : {};
    for (const key of H3_PARAM_KEYS) {
        const value = override[key] ?? segment[key] ?? nodeMetadata[key] ?? nodeParams[key] ?? defaults[key];
        if (value !== undefined && value !== null && value !== "") params[key] = value;
    }
    if (override.steps === undefined) {
        const videoSteps = override.videoSteps ?? segment.videoSteps ?? nodeMetadata.videoSteps ?? nodeParams.videoSteps ?? defaults.videoSteps;
        if (videoSteps !== undefined && videoSteps !== null && videoSteps !== "") params.steps = videoSteps;
    }
    delete params.videoSteps;
    const normalizedOverride = { ...override };
    if (normalizedOverride.videoSteps !== undefined && normalizedOverride.steps === undefined) normalizedOverride.steps = normalizedOverride.videoSteps;
    delete normalizedOverride.videoSteps;
    delete normalizedOverride.idempotencyKey;
    delete normalizedOverride.clientTaskId;
    return { ...params, ...normalizedOverride };
}

async function projectIdForNode(context: PluginMcpContext, nodeId: string) {
    const projects = await context.backend.listCanvasProjects();
    const project = projects.find((item) => Array.isArray(item.nodes) && (item.nodes as Array<Record<string, unknown>>).some((node) => String(node.id || "") === nodeId));
    return project && typeof project.id === "string" ? project.id : "";
}

async function assertProjectNode(context: PluginMcpContext, projectId: string, nodeId: string) {
    if (!projectId) throw new Error("projectId 必填，MCP 不再自动选择画布");
    const actual = await projectIdForNode(context, nodeId);
    if (!actual) throw new Error(`找不到节点所属画布:${nodeId}`);
    if (actual !== projectId) throw new Error(`节点不属于指定画布:${projectId}`);
}

function logRef(ref: H3Ref) {
    return {
        ...(ref.name ? { name: ref.name } : {}),
        ...(ref.type ? { type: ref.type } : {}),
        ...(ref.url ? { url: ref.url } : {}),
        ...(ref.storageKey ? { storageKey: ref.storageKey } : {}),
        ...(ref.mimeType ? { mimeType: ref.mimeType } : {}),
        ...(ref.role ? { role: ref.role } : {}),
        ...(ref.subjectId ? { subjectId: ref.subjectId } : {}),
        ...(ref.order !== undefined ? { order: ref.order } : {}),
    };
}

async function createMcpGenerationLog(context: PluginMcpContext, nodeId: string, segment: H3Segment, refs: H3Ref[], params: Record<string, unknown>) {
    const projectId = await projectIdForNode(context, nodeId);
    if (!projectId) throw new Error(`找不到 H3 节点所属画布:${nodeId}`);
    const log = await context.backend.createGenerationLog({
        projectId,
        nodeId,
        segmentId: String(segment.id || ""),
        status: "queued",
        platform: String(params.engine || "comfyui"),
        workflow: "MiniMax H3",
        model: String(params.modelName || ""),
        taskMode: String(segment.taskMode || "r2v"),
        prompt: String(segment.prompt || ""),
        references: refs.map(logRef),
        inputCounts: {
            image: refs.filter((ref) => ref.type === "image").length,
            video: refs.filter((ref) => ref.type === "video").length,
            audio: refs.filter((ref) => ref.type === "audio").length,
        },
        startedAt: new Date().toISOString(),
        durationMs: 0,
        outputs: [],
        params,
    });
    return log && typeof log === "object" && typeof (log as Record<string, unknown>).id === "string" ? String((log as Record<string, unknown>).id) : "";
}

async function updateMcpGenerationLog(context: PluginMcpContext, logId: string, task: Record<string, unknown>, status: "running" | "success" | "failed" | "cancelled", error?: string, extra?: { params?: Record<string, unknown>; lastSubmitted?: Record<string, unknown> }) {
    if (!logId) return;
    const result = task.result && typeof task.result === "object" ? task.result as Record<string, unknown> : {};
    const media = Array.isArray(result.media) ? result.media.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>> : [];
    const actualSubmission = result.actualSubmission && typeof result.actualSubmission === "object" ? result.actualSubmission : undefined;
    // 与前端直连路径对齐：把「实际提交的输入/参数」与「ComfyUI 实际落地的运行参数」(actualSubmission:
    // promptId/seed/帧数/宽高/lora 等)一并写入 params，保证生成日志完整记录运行参数。
    const logParams: Record<string, unknown> = {
        ...(extra?.params && typeof extra.params === "object" ? extra.params : {}),
        ...(extra?.lastSubmitted && typeof extra.lastSubmitted === "object" ? { lastSubmitted: extra.lastSubmitted } : {}),
        ...(actualSubmission ? { actualSubmission } : {}),
    };
    await context.backend.updateGenerationLog(logId, {
        status,
        ...(task.id ? { runtimeTaskId: String(task.id) } : {}),
        ...(actualSubmission && typeof (actualSubmission as Record<string, unknown>).promptId === "string" ? { promptId: String((actualSubmission as Record<string, unknown>).promptId) } : {}),
        ...(status === "success" ? { outputs: media.map((item) => ({ url: item.url, storageKey: item.storageKey, type: "video", mimeType: item.mimeType })) } : {}),
        ...(error ? { error } : {}),
        ...(status === "success" || status === "failed" || status === "cancelled" ? { finishedAt: new Date().toISOString() } : {}),
        ...(Object.keys(logParams).length ? { params: logParams } : {}),
    });
}

function selectSegment(segments: H3Segment[], index?: number): { segment: H3Segment; index: number } {
    if (segments.length === 0) throw new Error("该节点没有可运行的 H3 片段");
    if (typeof index === "number") {
        const segment = segments[index];
        if (!segment) throw new Error(`片段下标越界:${index}`);
        return { segment, index };
    }
    const pending = segments.findIndex((s) => !s.result && s.status !== "succeeded");
    const chosen = pending >= 0 ? pending : 0;
    return { segment: segments[chosen], index: chosen };
}

async function runSegment(context: PluginMcpContext, node: AgentCanvasNode, index: number | undefined, override: Record<string, unknown>, previousVideo = "", defaults: Record<string, unknown> = {}, binding?: Record<string, unknown>) {
    const segments = segmentsOf(node);
    const selected = selectSegment(segments, index);
    const { segment } = selected;
    const previous = selected.index > 0 && segments[selected.index - 1]?.result
        ? { name: `h3-segment-${selected.index}.mp4`, url: String(segments[selected.index - 1].result), storageKey: String(segments[selected.index - 1].resultStorageKey || "") || undefined }
        : undefined;
    const { images, videos, audios } = collectRefs(segment);
    const sourceVideos = videos.length ? videos : (previous ? [previous] : []);
    const [imagePaths, videoPaths, audioPaths] = await Promise.all([
        Promise.all(images.map((ref) => resolveRefToPath(context, ref))),
        Promise.all(sourceVideos.map((ref) => resolveRefToPath(context, ref))),
        Promise.all(audios.map((ref) => resolveRefToPath(context, ref))),
    ]);
    const input = {
        prompt: String(segment.prompt || ""),
        references: imagePaths,
        audios: audioPaths,
        video: videoPaths[0],
        ...(previousVideo ? { previousVideo } : {}),
    };
    const params = { ...extractParams(segment, override, node.metadata || {}, defaults), ...(binding ? { canvasBinding: binding } : {}) };
    const idempotencyKey = typeof override.idempotencyKey === "string" ? String(override.idempotencyKey) : undefined;
    const started = await context.backend.canvasRunGeneration({
        mode: "video",
        model: "minimax-h3:video",
        preset: "minimax-h3",
        projectId: binding?.projectId,
        nodeId: binding?.nodeId,
        segmentId: binding?.segmentId,
        input,
        params,
        ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    const task = started.task || (await context.backend.comfyGetTask(started.taskId)).task;
    return { task, input, params };
}

function taskVideo(task: Record<string, unknown>) {
    const result = task.result && typeof task.result === "object" ? task.result as Record<string, unknown> : {};
    const media = Array.isArray(result.media) ? result.media : [];
    return media.find((item) => item && typeof item === "object" && String((item as Record<string, unknown>).mimeType || "").startsWith("video/")) as Record<string, unknown> | undefined;
}

/**
 * 把 ComfyUI 任务返回的原始媒体地址改写成前端可直接播放的地址。
 * 与前端直连路径(comfyui.ts proxyComfyMedia / use-plugin-host persistH3Result)对齐：
 * 优先用 storageKey 生成 /media/<storageKey>(GET /media 免 token,见 backend server.ts)，
 * 否则回退到 runtime-file / 绝对直链代理。clip 卡片直接用 segment.result 作 <video src>，
 * 不二次代理，因此必须在此写入可播放地址，否则视频显示为空白/不可播放。
 */
function proxyH3ResultUrl(video: { url?: string; storageKey?: string }, backendUrl: string): { url: string; storageKey?: string } {
    const storageKey = video.storageKey ? String(video.storageKey) : undefined;
    if (storageKey) return { url: `/media/${encodeURIComponent(storageKey)}`, storageKey };
    const raw = String(video.url || "");
    if (raw.startsWith("/media/")) {
        const key = decodeURIComponent(raw.slice("/media/".length).split("?")[0]);
        if (key && !key.includes("/")) return { url: `/media/${key}`, storageKey: key };
    }
    if (raw.startsWith("runtime-file:")) {
        const file = encodeURIComponent(raw.slice("runtime-file:".length));
        return { url: `${backendUrl.replace(/\/$/, "")}/runtime/media-file?file=${file}` };
    }
    // 绝对 ComfyUI 直链等无法本地化的情况，原样透传(前端 /comfy/media 代理兜底)
    return { url: raw };
}

async function updateClipTask(context: PluginMcpContext, nodeId: string, clipId: string, task: Record<string, unknown>, error?: string, bindTask = false) {
    const node = await context.getCanvasNode(nodeId);
    if (!node) return;
    const segments = segmentsOf(node);
    const index = segments.findIndex((item) => String(item.id || "") === clipId);
    const segment = segments[index];
    if (!segment) return;
    const taskId = String(task.id || "");
    // 后台轮询是异步的：Clip 被重跑、重排或删除后，旧任务的回调必须失效。
    // 首次提交仅用于建立 Clip ID -> task ID 绑定；之后每次更新都双重校验。
    if (!bindTask && (!taskId || String(segment.runtimeTaskId || "") !== taskId)) return;
    if (bindTask && String(segment.runtimeTaskId || "") === taskId && ["success", "error", "cancelled"].includes(String(segment.status || ""))) return;
    const status = error ? "error" : String(task.status || "running");
    const video = !error && status === "succeeded" ? taskVideo(task) : undefined;
    // 与前端直连路径对齐：把 ComfyUI 原始媒体地址改写成前端可播放的 /media/<storageKey> 形式。
    // 否则 clip 卡片用 segment.result 作 <video src> 会拿到不可播放的裸地址。
    const proxied = video ? proxyH3ResultUrl(video, context.backendUrl) : undefined;
    const resultUrl = proxied?.url;
    const resultStorageKey = proxied?.storageKey;
    const segmentPatch: Record<string, unknown> = {
        status: status === "succeeded" ? "success" : status === "failed" || status === "cancelled" ? "error" : "running",
        runtimeTaskId: taskId || String(segment.runtimeTaskId || ""),
        progress: Number(task.progress || 0),
        ...(resultUrl ? { result: resultUrl } : {}),
        ...(resultStorageKey ? { resultStorageKey } : {}),
        ...(error ? { errorDetails: error } : {}),
    };
    const nextSegments = segments.map((item, i) => i === index ? { ...item, ...segmentPatch } : item);
    const nodePatch: Record<string, unknown> = {
        segments: nextSegments,
        status: segmentPatch.status === "running" ? "loading" : segmentPatch.status,
        runtimeTaskId: segmentPatch.runtimeTaskId,
        runProgress: segmentPatch.progress,
        ...(segmentPatch.status === "running" ? { runStartedAt: Date.now(), errorDetails: undefined } : {}),
        ...(error ? { errorDetails: error, runFinishedAt: Date.now() } : {}),
        ...(resultUrl ? { content: resultUrl, ...(resultStorageKey ? { storageKey: resultStorageKey } : {}) } : {}),
    };
    await context.updateCanvasNode(nodeId, {}, nodePatch);
}

export const pluginMcp: PluginMcpModule = {
    id: "minimax-h3",
    version: "1.3.0",
    tools: TOOLS,
    createHandler(context: PluginMcpContext): Record<string, McpToolHandler> {
        return {
            h3_get_defaults: async () => context.backend.getH3Defaults(),
            h3_set_defaults: async (input) => {
                const settings = input.settings && typeof input.settings === "object" && !Array.isArray(input.settings) ? input.settings as Record<string, unknown> : {};
                return { defaults: await context.backend.setH3Defaults(normalizeH3GenerationSettings(settings)) };
            },
            h3_reset_defaults: async () => { await context.backend.resetH3Defaults(); return { ok: true, defaults: null }; },
            h3_apply_video_plan: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                if (input.language !== undefined && String(input.language) !== "zh-CN") throw new Error("H3 视频计划当前只接受 language=zh-CN");
                const node = await context.getCanvasNode(nodeId);
                if (!node) throw new Error(`找不到画布节点:${nodeId}`);
                const project = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                if (!project || !Array.isArray(project.nodes) || !(project.nodes as Array<Record<string, unknown>>).some((item) => String(item.id || "") === nodeId)) throw new Error(`节点不属于指定画布:${projectId}`);
                const rawSegments = Array.isArray(input.segments) ? input.segments as H3PlannedSegment[] : [];
                validateVideoPlan(rawSegments);
                const existing = segmentsOf(node);
                const next = rawSegments.map(normalizePlannedSegment);
                const segments = input.replaceSegments === false ? [...existing, ...next] : next;
                await context.updateCanvasNode(nodeId, {}, { segments, status: "idle", errorDetails: "", runProgress: 0 });
                return { ok: true, projectId, nodeId, count: next.length, segments };
            },
            h3_list_models: async () => {
                const catalog = await context.comfyUi.models();
                return {
                    models: catalog.models || [],
                    loras: catalog.loras || [],
                    textEncoders: catalog.textEncoders || [],
                    videoVaes: catalog.videoVaes || [],
                    audioVaes: catalog.audioVaes || [],
                    nanfeng: catalog.nanfeng || {},
                };
            },
            h3_get_node: async (input) => {
                const nodeId = String(input.nodeId || "");
                await assertProjectNode(context, String(input.projectId || ""), nodeId);
                const node = await context.getCanvasNode(nodeId);
                if (!node) throw new Error(`找不到画布节点:${String(input.nodeId || "")}`);
                return node;
            },
            h3_run_clip: async (input) => {
                const nodeId = String(input.nodeId || "");
                const projectId = String(input.projectId || "");
                await assertProjectNode(context, projectId, nodeId);
                const node = await context.getCanvasNode(nodeId);
                if (!node) throw new Error(`找不到画布节点:${nodeId}`);
                if (!isH3Node(node)) throw new Error(`节点 ${nodeId} 不是 MiniMax H3 节点`);
                const index = typeof input.segmentIndex === "number" ? input.segmentIndex : undefined;
                const selected = selectSegment(segmentsOf(node), index);
                const selectedIndex = selected.index;
                const segment = selected.segment;
                const defaults = await context.backend.getH3Defaults();
                const requestedParams = { ...((input.params as Record<string, unknown>) || {}), ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}) };
                if (typeof input.idempotencyKey === "string" && input.idempotencyKey.trim()) {
                    try {
                        const existing = await context.backend.getTask(input.idempotencyKey.trim());
                        if (existing.task.id === input.idempotencyKey.trim()) return existing.task;
                    } catch { /* 首次提交时任务尚不存在 */ }
                }
                const params = extractParams(segment, requestedParams, node.metadata || {}, defaults);
                const { images, videos, audios } = collectRefs(segment);
                const logId = await createMcpGenerationLog(context, nodeId, segment, [...images, ...videos, ...audios], params);
                const started = await runSegment(context, node, selectedIndex, requestedParams, "", defaults, { projectId, nodeId, segmentId: String(segment.id || ""), generationLogId: logId });
                const clipId = String(segmentsOf(node)[selectedIndex]?.id || "");
                if (!clipId) throw new Error("H3 Clip 缺少身份标识");
                const lastSubmitted = { input: started.input, params: started.params };
                await updateClipTask(context, nodeId, clipId, started.task as unknown as Record<string, unknown>, undefined, true);
                await updateMcpGenerationLog(context, logId, started.task as unknown as Record<string, unknown>, "running", undefined, { params, lastSubmitted });
                return { ...started.task, generationLogId: logId };
            },
            h3_get_task: async (input) => {
                const taskId = String(input.taskId || "");
                const { task } = await context.backend.getTask(taskId);
                return task;
            },
            h3_cancel_task: async (input) => {
                const taskId = String(input.taskId || "");
                return context.backend.cancelTask(taskId);
            },
            h3_update_clip: async (input) => {
                const nodeId = String(input.nodeId || "");
                await assertProjectNode(context, String(input.projectId || ""), nodeId);
                const node = await context.getCanvasNode(nodeId);
                if (!node) throw new Error(`找不到画布节点:${nodeId}`);
                const index = Number(input.segmentIndex);
                const segments = segmentsOf(node);
                if (!segments[index]) throw new Error(`片段下标越界:${index}`);
                const nextSegments = segments.map((segment, i) => (i === index ? { ...segment, ...(input.patch as Record<string, unknown>) } : segment));
                await context.updateCanvasNode(nodeId, {}, { segments: nextSegments });
                return { ok: true, nodeId, segmentIndex: index, segment: nextSegments[index] };
            },
            h3_run_all_clips: async (input) => {
                const projectId = String(input.projectId || "");
                const override = (input.params as Record<string, unknown>) || {};
                const onlyIds = Array.isArray(input.nodeIds) ? (input.nodeIds as string[]).map(String) : null;
                const project = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                if (!project) throw new Error(`画布不存在:${projectId}`);
                const nodes = (await context.getCanvasNodes()).filter((node) => isH3Node(node) && (!onlyIds || onlyIds.includes(node.id)) && Array.isArray(project.nodes) && (project.nodes as Array<Record<string, unknown>>).some((item) => String(item.id || "") === node.id));
                const defaults = await context.backend.getH3Defaults();
                const tasks: unknown[] = [];
                for (const node of nodes) {
                    const segments = segmentsOf(node);
                    if (!segments.length) continue;
                    let previousVideo = "";
                    for (let i = 0; i < segments.length; i++) {
                        if (segments[i].result || segments[i].status === "succeeded") {
                            const previous = String(segments[i].result || "");
                            if (previous && context.backend.runtimeMediaPath) previousVideo = await context.backend.runtimeMediaPath(previous);
                            continue;
                    }
                    const clipId = String(segments[i].id || "");
                    let startedTaskId = "";
                    let logId = "";
                    let params: Record<string, unknown> = {};
                    let lastSubmitted: Record<string, unknown> = {};
                    try {
                        if (!clipId) throw new Error(`H3 Clip ${i + 1} 缺少身份标识`);
                        const { images, videos, audios } = collectRefs(segments[i]);
                        params = extractParams(segments[i], override, node.metadata || {}, defaults);
                        logId = await createMcpGenerationLog(context, node.id, segments[i], [...images, ...videos, ...audios], params);
                        const started = await runSegment(context, node, i, override, previousVideo, defaults, { projectId, nodeId: node.id, segmentId: clipId, generationLogId: logId });
                        startedTaskId = String(started.task.id || "");
                        lastSubmitted = { input: started.input, params: started.params };
                        await updateClipTask(context, node.id, clipId, started.task as unknown as Record<string, unknown>, undefined, true);
                        await updateMcpGenerationLog(context, logId, started.task as unknown as Record<string, unknown>, "running", undefined, { params, lastSubmitted });
                        tasks.push({ nodeId: node.id, segmentIndex: i, task: started.task, generationLogId: logId, status: "queued" });
                    } catch (error) {
                        await updateClipTask(context, node.id, clipId, { id: startedTaskId, status: "failed" }, error instanceof Error ? error.message : String(error), !startedTaskId);
                        await updateMcpGenerationLog(context, logId, { id: startedTaskId, status: "failed" }, "failed", error instanceof Error ? error.message : String(error), { params, lastSubmitted });
                        tasks.push({ nodeId: node.id, segmentIndex: i, generationLogId: logId, error: error instanceof Error ? error.message : String(error) });
                        break;
                    }
                }
                }
                return { count: tasks.length, tasks };
            },
        };
    },
};
