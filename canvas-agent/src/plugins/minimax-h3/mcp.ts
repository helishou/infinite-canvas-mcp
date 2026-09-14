import type { AgentCanvasNode, McpToolHandler, PluginMcpContext, PluginMcpModule, PluginMcpToolWire } from "../../server/plugin-mcp.js";
import { normalizeH3GenerationSettings, normalizePlannedSegment, validateVideoPlan, type H3PlannedSegment } from "./video-plan.js";

// H3 片段(节点 metadata.segments 中的元素)
type H3Segment = Record<string, unknown>;

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
    "dedicatedAttention", "startupMode", "faceRepairSingle", "faceRepairMulti", "globalRepair", "lowMemoryAttentionHeads", "reservedVramGb", "runtimeReserveEnabled", "uniBlockSwapEnabled", "uniBlockSwapBlocks", "keepModelCache",
    "latentUpscaleEnabled", "h3FirstSteps", "h3SecondSteps", "h3FullSigma", "v81ManualSigma", "latentUpscaleModel", "latentUpscaleMegapixels", "latentUpscaleAlign", "latentUpscalePrecision",
    "realtimePreviewEnabled", "realtimePreviewLongEdge", "realtimePreviewFrames", "realtimePreviewFps", "realtimePreviewJpegQuality",
    "rtxEnabled", "rtxResizeMode", "rtxScale", "rtxWidth", "rtxHeight", "rtxQuality",
    "slaEnabled", "slaSparsity", "slaBlockSize", "slaMinSequence", "slaDenseLastSteps", "slaProtectAudio", "slaDenseSteps", "slaBackend", "slaDisableFp16Accum", "slaStabilizeMotion",
    "refImageSize", "referenceLongEdge", "loraName", "loraStrength", "teAccel", "noDub", "noCaption", "audioMode", "audioDenoiseStrength", "addSourceAsReference", "promptPrimaryAudioOrdinal", "strictPromptTags",
    "referenceVideoPolicy", "trimIn", "trimOut", "motionContextEnabled", "tailFrameContinuation", "previousVideoAsReference", "motionContextNoiseEnabled", "motionContextNoiseAlpha", "motionContextNoiseAlphaEnd", "motionContextNoiseRampFrames", "combatLoraWeight", "cinematicLoraWeight",
] as const;

// 节点根级是 H3 面板/新建片段的配置投影；运行状态、结果历史、提示词和参考图不在此列，
// 避免 MCP 更新片段时把后台回写的运行态或用户正在编辑的内容覆盖掉。
const H3_NODE_PROJECTION_KEYS = [
    "modelName", "minimaxBaseModel", "textEncoder", "textEncoderType", "textEncoderDevice", "videoVae", "audioVae", "precision",
    "megapixels", "sizeMultiple", "sampler", "scheduler", "videoSteps", "steps", "denoise", "sageAttention", "allowCompile",
    "loraSlots", "loraName", "loraStrength", "reservedVramGb", "runtimeReserveEnabled", "uniBlockSwapEnabled", "uniBlockSwapBlocks", "keepModelCache",
    "latentUpscaleEnabled", "latentUpscaleModel", "latentUpscaleMegapixels", "latentUpscaleAlign", "latentUpscalePrecision",
    "realtimePreviewEnabled", "realtimePreviewLongEdge", "realtimePreviewFrames", "realtimePreviewFps", "realtimePreviewJpegQuality",
    "rtxEnabled", "rtxResizeMode", "rtxScale", "rtxWidth", "rtxHeight", "rtxQuality",
    "slaEnabled", "slaSparsity", "slaBlockSize", "slaMinSequence", "slaDenseLastSteps", "slaProtectAudio", "slaDenseSteps", "slaBackend", "slaDisableFp16Accum", "slaStabilizeMotion",
    "refImageSize", "referenceLongEdge", "teAccel", "noDub", "noCaption", "audioMode", "audioDenoiseStrength", "strictPromptTags", "referenceVideoPolicy",
] as const;

function nodeProjection(patch: H3Segment): H3Segment {
    const projection: H3Segment = {};
    for (const key of H3_NODE_PROJECTION_KEYS) if (patch[key] !== undefined) projection[key] = patch[key];
    if (patch.modelName !== undefined && patch.minimaxBaseModel === undefined) projection.minimaxBaseModel = patch.modelName;
    return projection;
}

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
        version: "1.3.0",
        name: "H3 运行单段",
        description: "通过 Backend H3 执行器运行指定片段，复用画布任务、媒体落库和终态回写，不依赖打开画布页面。",
        inputJsonSchema: {
            type: "object",
            properties: {
                nodeId: { type: "string", description: "画布节点 id" },
                projectId: { type: "string", description: "画布项目 id" },
                segmentId: { type: "string", description: "片段稳定 id；优先使用它定位片段" },
                segmentIndex: { type: "integer", description: "兼容旧调用的片段下标；省略则运行首个未完成的片段" },
                params: { type: "object", description: "覆盖片段自带参数的生成参数" },
                idempotencyKey: { type: "string", description: "幂等提交键，重复提交复用原任务" },
            },
            required: ["projectId", "nodeId"],
        },
    },
    {
        id: "h3_get_defaults",
        version: "1.2.0",
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
                segmentId: { type: "string", description: "片段稳定 id；不要用会因重排变化的数组下标" },
                patch: { type: "object", description: "要合并进该片段的字段" },
            },
            required: ["projectId", "nodeId", "segmentId", "patch"],
        },
    },
    {
        id: "h3_run_all_clips",
        version: "1.2.0",
        name: "H3 运行全部片段",
        description: "通过 Backend H3 执行器运行所有(或指定的)节点，复用画布任务、媒体落库和终态回写，不依赖打开画布页面。",
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

/**
 * 取节点级可继承的生成参数（模型/LoRA/采样/VEA 等），供写片段计划时并入新 segment。
 *
 * 背景：h3_apply_video_plan 只描述剧情字段（prompt/timeline/refs 等），若直接整段覆盖
 * segments，节点上由节点工厂写入的生成参数会全部丢失。前端 H3Runner 大量使用
 * `segment.x || 硬编码默认`（如 h3-models.ts 的 compatibleH3Settings、H3Runner 的
 * `loraSlots: segment.loraSlots || []`），segment 缺参时会静默回退到错误模型/LoRA。
 *
 * 取值优先级：已有片段 > 节点级 metadata > nodeMetadata.comfyParams，
 * 参数优先级与 Backend 运行编排器一致。duration 属于计划，由调用方铺在后面覆盖。
 */
function inheritedH3Params(node: AgentCanvasNode): Record<string, unknown> {
    const meta = node.metadata || {};
    const nodeParams = meta.comfyParams && typeof meta.comfyParams === "object" && !Array.isArray(meta.comfyParams)
        ? meta.comfyParams as Record<string, unknown> : {};
    const inherited: Record<string, unknown> = {};
    const take = (source: Record<string, unknown>) => {
        for (const key of H3_PARAM_KEYS) {
            const value = source[key];
            if (value !== undefined && value !== null && value !== "") inherited[key] = value;
        }
    };
    take(meta);
    take(nodeParams);
    const existing = segmentsOf(node)[0];
    if (existing) take(existing);
    delete inherited.steps;
    return inherited;
}

function isH3Node(node: AgentCanvasNode): boolean {
    return String(node.type || "").includes("minimax");
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
                // 计划只描述剧情字段；节点上的生成参数（模型/LoRA/采样等）必须继承下来，
                // 否则前端 H3Runner 会按 segment 缺省值静默回退到错误模型。
                const inherited = inheritedH3Params(node);
                const next = rawSegments.map((item) => ({ ...inherited, ...normalizePlannedSegment(item) }));
                // selectedSegmentId 一致性：replace 会让旧 selectedSegmentId 指向的段消失，
                // 留在 metadata 里就会变成"无效选中"——前端 selected = segments.find(...) || segments[0]
                // 会回退到 segments[0]，看上去"换回到之前的 clip"。所以这里要按"旧选中索引 / 同标题 / 兜底首段"
                // 在新 plan 里找一个对应段并把 selectedSegmentId 一起写回。
                const previousSelectedId = String(((node.metadata || {}) as Record<string, unknown>).selectedSegmentId || "");
                const previousSelectedIndex = Math.max(0, existing.findIndex((segment) => String(segment.id || "") === previousSelectedId));
                if (input.replaceSegments === false) {
                    // append 路径：每个新段都走细粒度 add_h3_segment，避免一次写整数组触发冲突。
                    for (const segment of next) {
                        if (!segment.id) throw new Error("append 路径要求新段携带 id（add_h3_segment 必填）");
                        await context.addH3Segment(nodeId, segment as Record<string, unknown>);
                    }
                } else {
                    // replace 路径：走 replace_h3_segments 显式 op，绕过 update_node.metadata.segments 的「同 id 集合」严格校验。
                    await context.replaceH3Segments(nodeId, next as Array<Record<string, unknown>>);
                }
                // 节点级元数据（status/runProgress/errorDetails）走 update_node（不带 segments）。
                await context.updateCanvasNode(nodeId, {}, { status: "idle", errorDetails: "", runProgress: 0 });
                if (next.length) {
                    const remappedSelectedId = next[Math.min(previousSelectedIndex, next.length - 1)]?.id
                        || next[0]?.id
                        || "";
                    if (remappedSelectedId && remappedSelectedId !== previousSelectedId) {
                        await context.updateCanvasNode(nodeId, {}, { selectedSegmentId: remappedSelectedId });
                    }
                }
                return { ok: true, projectId, nodeId, count: next.length, segments: next, selectedSegmentId: next.length ? (next[Math.min(previousSelectedIndex, next.length - 1)]?.id || next[0]?.id || "") : "" };
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
                const result = await context.backend.canvasRunGeneration({
                    mode: "video",
                    operation: "h3-run",
                    projectId,
                    nodeId,
                    ...(typeof input.segmentId === "string" ? { segmentId: input.segmentId } : {}),
                    ...(typeof input.segmentIndex === "number" ? { segmentIndex: input.segmentIndex } : {}),
                    params: (input.params as Record<string, unknown>) || {},
                    ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}),
                });
                if (!result.task) throw new Error("Backend H3 运行未返回任务");
                return result.task;
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
                const segments = segmentsOf(node);
                const segmentId = String(input.segmentId || "");
                if (!segmentId) throw new Error("segmentId 必填");
                const index = segments.findIndex((segment) => String(segment.id || "") === segmentId);
                if (index < 0) throw new Error(`找不到片段:${segmentId}`);
                const target = segments[index];
                if (!target.id) throw new Error(`片段 ${index} 缺少 id，无法使用细粒度 update_h3_segment`);
                const patch = (input.patch as Record<string, unknown>) || {};
                await context.updateH3Segment(nodeId, String(target.id), patch, nodeProjection(patch));
                const refreshed = await context.getCanvasNode(nodeId);
                const refreshedSegment = refreshed && segmentsOf(refreshed).find((segment) => String(segment.id || "") === segmentId);
                if (!refreshedSegment) throw new Error(`片段更新后读取失败:${segmentId}`);
                return { ok: true, nodeId, segmentIndex: index, segmentId, segment: refreshedSegment };
            },
            h3_run_all_clips: async (input) => {
                const projectId = String(input.projectId || "");
                const override = (input.params as Record<string, unknown>) || {};
                const onlyIds = Array.isArray(input.nodeIds) ? (input.nodeIds as string[]).map(String) : null;
                const project = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                if (!project) throw new Error(`画布不存在:${projectId}`);
                const nodes = (await context.getCanvasNodes()).filter((node) => isH3Node(node) && (!onlyIds || onlyIds.includes(node.id)) && Array.isArray(project.nodes) && (project.nodes as Array<Record<string, unknown>>).some((item) => String(item.id || "") === node.id));
                const result = await context.backend.canvasRunGeneration({ mode: "video", operation: "h3-run", projectId, nodeIds: nodes.map((node) => node.id), runFromCurrent: true, skipCompleted: true, params: override });
                if (!result.task) throw new Error("Backend H3 批量运行未返回任务");
                return result.task;
            },
        };
    },
};
