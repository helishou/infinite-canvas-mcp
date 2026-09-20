import type { AgentCanvasNode, McpToolHandler, PluginMcpContext, PluginMcpModule, PluginMcpToolWire } from "../../server/plugin-mcp.js";
import { normalizeH3GenerationSettings, normalizePlannedSegment, validateVideoPlan, type H3PlannedSegment } from "./video-plan.js";
import { compileReferenceSubmission, inferReferenceMediaType, inferReferenceRole, referenceBindingsOf, referenceCatalogOf, assertReferenceCompilation } from "../../canvas/reference-contract.js";
import { validateH3CharacterGroups } from "../../canvas/character-reference-contract.js";
import { buildCharacterGroupFromExistingNode } from "./character-groups.js";
import { writeStoryboardPrompt } from "./storyboard-write.js";

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
    "dedicatedAttention", "startupMode", "faceRepairSingle", "faceRepairMulti", "globalRepair", "faceRefineEnabled", "faceRefineDetector", "faceRefineConfidence", "faceRefineCropFactor", "faceRefineCanvasSize", "faceRefineDenoise", "faceRefineSteps", "faceRefineSampler", "faceRefineScheduler", "faceRefinePasteRegion", "faceRefineMaskDilation", "faceRefineFeather", "faceRefineColourMatch", "faceRefineBlend", "lowMemoryAttentionHeads", "reservedVramGb", "runtimeReserveEnabled", "uniBlockSwapEnabled", "uniBlockSwapBlocks", "keepModelCache",
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
    "faceRefineEnabled", "faceRefineDetector", "faceRefineConfidence", "faceRefineCropFactor", "faceRefineCanvasSize", "faceRefineDenoise", "faceRefineSteps", "faceRefineSampler", "faceRefineScheduler", "faceRefinePasteRegion", "faceRefineMaskDilation", "faceRefineFeather", "faceRefineColourMatch", "faceRefineBlend", "confirmationMode", "seamFaceFadeFrames", "seamColourMatch", "seamAudioCrossfadeMs",
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
        id: "h3_get_clip",
        version: "1.0.0",
        name: "H3 定向读取片段",
        description: "只读取指定 H3 Clip、最终参考编译和运行参数快照，不扫描整张画布。",
        inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" }, segmentId: { type: "string" } }, required: ["projectId", "nodeId", "segmentId"] },
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
        id: "h3_write_storyboard_prompt",
        version: "1.1.0",
        name: "H3 写入结构化分镜提示词",
        description: "按分镜编辑器的新结构写入单个 Clip：开场总体描述、逐镜描述/切换时间/切换方式/已绑定分镜图、声景和配乐；Ref2VA 模式另写 summary，并由当前人物引用按规则生成 subject_definitions 与 retention_analysis，使用共享 SHA-256 缓存。",
        inputJsonSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", description: "画布项目 id" },
                nodeId: { type: "string", description: "H3 节点 id" },
                segmentId: { type: "string", description: "目标 Clip 的稳定 id" },
                summary: { type: "string", description: "Ref2VA 模式的摘要；其他模式忽略" },
                openingDescription: { type: "string", description: "detailed_description 开头的非分镜总体描述" },
                shots: {
                    type: "array",
                    minItems: 1,
                    items: {
                        type: "object",
                        properties: {
                            description: { type: "string", description: "分镜描述，可包含 {{subject:人物节点id}} 引用" },
                            switchTime: { type: "string", description: "本镜头相对 Clip 开始的切换时间；第一镜忽略" },
                            transitionType: { type: "string", enum: ["continuous", "cut", "dissolve", "fade_black"], description: "从上一镜到本镜的方式：连续镜头不切镜、硬切、叠化、淡出至黑场再淡入；第一镜忽略" },
                            pictureBindingId: { type: "string", description: "当前 Clip 中已绑定的 storyboard 图片 binding id" },
                        },
                        required: ["description"],
                    },
                },
                overallSoundscape: { type: "string" },
                nonDiegeticMusic: { type: "string" },
            },
            required: ["projectId", "nodeId", "segmentId", "openingDescription", "shots", "overallSoundscape", "nonDiegeticMusic"],
        },
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
    {
        id: "h3_prepare_clip",
        version: "1.0.0",
        name: "H3 原子准备片段",
        description: "一次性继承已完成片段参数、更新剧情/分镜/参考和已有角色组，编译并返回最终提交快照；预检失败不写入。",
        inputJsonSchema: {
            type: "object",
            properties: {
                projectId: { type: "string" },
                nodeId: { type: "string" },
                segmentId: { type: "string" },
                inheritFromSegmentId: { type: "string", description: "已验证来源片段；省略则取目标之前最近完成片段" },
                patch: { type: "object", description: "剧情字段和明确要覆盖的 H3 参数；不得包含 h3CharacterGroups/referenceBindings" },
                referenceBindings: { type: "array", items: { type: "object" }, description: "完整替换后的参考绑定列表" },
                characters: { type: "array", items: { type: "object", properties: { characterNodeId: { type: "string" }, subjectId: { type: "string", description: "提示词使用的稳定 subjectId；将同步写入角色组和全部角色参考绑定" }, selectedOutfitStorageKeys: { type: "array", items: { type: "string" } }, voiceEnabled: { type: "boolean" } }, required: ["characterNodeId", "selectedOutfitStorageKeys"] } },
            },
            required: ["projectId", "nodeId", "segmentId", "patch"],
        },
    },
    { id: "canvas_list_reference_assets", version: "1.0.0", name: "列出项目参考资产", description: "列出项目级参考资产库及其主要职责、标签和媒体句柄。", inputJsonSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] } },
    { id: "canvas_update_reference_asset", version: "1.0.0", name: "更新项目参考资产", description: "新增或更新项目参考资产；职责只保存一个 primary role，补充语义放 tags。", inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, asset: { type: "object" } }, required: ["projectId", "asset"] } },
    { id: "canvas_analyze_reference_asset", version: "1.0.0", name: "记录参考资产分析", description: "把模型对参考素材的职责、标签和摘要写入项目资产；调用方应先实际查看素材再提交分析。", inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, assetId: { type: "string" }, role: { type: "string" }, tags: { type: "array", items: { type: "string" } }, summary: { type: "string" }, model: { type: "string" } }, required: ["projectId", "assetId", "role", "tags", "summary"] } },
    { id: "h3_set_reference_bindings", version: "1.0.0", name: "设置 Clip 参考绑定", description: "按稳定 binding id 原子替换指定 Clip 的参考绑定，不修改节点位置或运行状态。", inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" }, segmentId: { type: "string" }, bindings: { type: "array", items: { type: "object" } }, expectedBindings: { type: "array", items: { type: "object" } } }, required: ["projectId", "nodeId", "segmentId", "bindings"] } },
    { id: "h3_bind_existing_character_groups", version: "1.0.0", name: "绑定现有角色节点组", description: "从指定的已有 character 画布节点读取完整服装目录，只按 selectedOutfitStorageKeys 选择当前 Clip；绝不创建角色节点。", inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" }, segmentId: { type: "string" }, characters: { type: "array", items: { type: "object", properties: { characterNodeId: { type: "string" }, subjectId: { type: "string", description: "提示词使用的稳定 subjectId；将同步写入角色组和全部角色参考绑定" }, selectedOutfitStorageKeys: { type: "array", items: { type: "string" } }, voiceEnabled: { type: "boolean" } }, required: ["characterNodeId", "selectedOutfitStorageKeys"] } } }, required: ["projectId", "nodeId", "segmentId", "characters"] } },
    { id: "canvas_validate_generation", version: "1.0.0", name: "生成预检", description: "使用与 Backend 实际提交相同的编译器预检语义提示词、参考顺序、模式上限和缺失媒体。", inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" }, segmentId: { type: "string" } }, required: ["projectId", "nodeId", "segmentId"] } },
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
 * 取值优先级：显式或目标之前最近已完成片段 > 节点级 metadata > nodeMetadata.comfyParams，
 * 未找到已完成片段时才回退到节点级配置；duration 属于计划，由调用方铺在后面覆盖。
 */
export function selectH3InheritanceSource(segments: H3Segment[], targetSegmentId?: string, explicitSourceId?: string): H3Segment | undefined {
    if (explicitSourceId) {
        const explicit = segments.find((segment) => String(segment.id || "") === explicitSourceId);
        return explicit && (Boolean(explicit.result) || String(explicit.status || "") === "success") ? explicit : undefined;
    }
    const targetIndex = targetSegmentId ? segments.findIndex((segment) => String(segment.id || "") === targetSegmentId) : segments.length;
    const before = (targetIndex >= 0 ? segments.slice(0, targetIndex) : segments).reverse();
    return before.find((segment) => Boolean(segment.result) || String(segment.status || "") === "success");
}

export function inheritedH3Params(node: AgentCanvasNode | Record<string, unknown>, sourceSegmentId?: string, suppliedSegments?: H3Segment[]): Record<string, unknown> {
    const meta = (node.metadata && typeof node.metadata === "object" ? node.metadata : node) as Record<string, unknown>;
    const nodeParams = meta.comfyParams && typeof meta.comfyParams === "object" && !Array.isArray(meta.comfyParams)
        ? meta.comfyParams as Record<string, unknown> : {};
    const segments = suppliedSegments || segmentsOf(node as AgentCanvasNode);
    const source = selectH3InheritanceSource(segments, undefined, sourceSegmentId);
    const inherited: Record<string, unknown> = {};
    const take = (value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const sourceRecord = value as Record<string, unknown>;
        for (const key of H3_PARAM_KEYS) {
            const item = sourceRecord[key];
            if (item !== undefined && item !== null && item !== "") inherited[key] = item;
        }
    };
    take(meta);
    take(nodeParams);
    take(source);
    delete inherited.steps;
    return inherited;
}

export function diffH3Settings(before: Record<string, unknown>, after: Record<string, unknown>) {
    return H3_PARAM_KEYS.filter((key) => !Object.is(before[key], after[key]) && (before[key] !== undefined || after[key] !== undefined))
        .map((key) => ({ key, before: before[key], after: after[key] }));
}

function buildH3ClipSnapshot(segment: H3Segment, compilation: ReturnType<typeof compileReferenceSubmission>, inheritance?: { sourceSegmentId?: string; changedSettings?: unknown[] }) {
    const runtime = Object.fromEntries(H3_PARAM_KEYS.filter((key) => segment[key] !== undefined).map((key) => [key, segment[key]]));
    const groups = Object.values(segment.h3CharacterGroups && typeof segment.h3CharacterGroups === "object" && !Array.isArray(segment.h3CharacterGroups) ? segment.h3CharacterGroups as Record<string, unknown> : {})
        .map((value) => value as Record<string, unknown>)
        .map((group) => ({
            id: String(group.id || ""),
            characterName: String(group.characterName || ""),
            characterNodeId: String(group.characterNodeId || ""),
            subjectId: String(group.subjectId || group.characterNodeId || ""),
            catalogCount: Array.isArray(group.outfits) ? group.outfits.length : 0,
            enabledCount: Array.isArray(group.outfits) ? group.outfits.filter((outfit) => (outfit as Record<string, unknown>)?.enabled === true).length : 0,
            voiceEnabled: group.voiceEnabled === true,
        }));
    return {
        ...(inheritance || {}),
        segment: { id: String(segment.id || ""), sourceShotId: String(segment.sourceShotId || ""), title: String(segment.title || ""), duration: segment.duration, taskMode: String(segment.taskMode || "") },
        runtime,
        prompt: { semantic: compilation.semanticPrompt, compiled: compilation.compiledPrompt },
        references: compilation.references.map((reference) => ({ id: reference.id, assetId: reference.assetId, label: reference.label, role: reference.role, mediaType: reference.mediaType, ordinal: reference.ordinal, token: reference.token, subjectId: reference.subjectId, groupId: reference.groupId, outfitId: reference.outfitId, storageKey: reference.storageKey, url: reference.url })),
        characterGroups: groups,
        issues: compilation.issues,
    };
}

function buildCharacterCandidate(projectNodes: Array<Record<string, unknown>>, segment: H3Segment, rawCharacters: Array<Record<string, unknown>>) {
    if (!rawCharacters.length) throw new Error("characters 至少需要一个已有 character 节点");
    const existingGroups = segment.h3CharacterGroups && typeof segment.h3CharacterGroups === "object" && !Array.isArray(segment.h3CharacterGroups) ? segment.h3CharacterGroups as Record<string, unknown> : {};
    const requestedNodeIds = new Set<string>();
    const built = rawCharacters.map((request) => {
        const characterNodeId = String(request.characterNodeId || "");
        if (!characterNodeId || requestedNodeIds.has(characterNodeId)) throw new Error(`characterNodeId 缺失或重复:${characterNodeId}`);
        requestedNodeIds.add(characterNodeId);
        const sourceNode = projectNodes.find((item) => String(item.id || "") === characterNodeId);
        if (!sourceNode) throw new Error(`找不到已有 character 节点:${characterNodeId}`);
        if (String(sourceNode.type || "") !== "character") throw new Error(`只能绑定已有 character 节点:${characterNodeId}`);
        const selected = Array.isArray(request.selectedOutfitStorageKeys) ? request.selectedOutfitStorageKeys.map(String) : [];
        const existingGroup = Object.values(existingGroups).map((value) => value as Record<string, unknown>).find((group) => String(group.characterNodeId || "") === characterNodeId);
        return { characterNodeId, built: buildCharacterGroupFromExistingNode(sourceNode, { selectedOutfitStorageKeys: selected, ...(typeof request.subjectId === "string" ? { subjectId: request.subjectId } : {}), ...(typeof request.voiceEnabled === "boolean" ? { voiceEnabled: request.voiceEnabled } : {}), existingGroup }) };
    });
    const removedGroupIds = new Set(Object.entries(existingGroups).filter(([, value]) => requestedNodeIds.has(String((value as Record<string, unknown>)?.characterNodeId || ""))).map(([key, value]) => String((value as Record<string, unknown>)?.id || key)));
    const nextGroups: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(existingGroups)) {
        const group = value as Record<string, unknown>;
        if (!requestedNodeIds.has(String(group.characterNodeId || ""))) nextGroups[key] = value;
    }
    for (const item of built) nextGroups[item.built.group.id] = item.built.group;
    const previousBindings = referenceBindingsOf(segment).bindings;
    const preservedBindings = previousBindings.filter((binding) => !binding.groupId || (!removedGroupIds.has(String(binding.groupId)) && Boolean(nextGroups[String(binding.groupId)])));
    return { built, requestedNodeIds, nextGroups, nextBindings: [...preservedBindings, ...built.flatMap((item) => item.built.refs)] };
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
    version: "1.5.0",
    tools: TOOLS,
    createHandler(context: PluginMcpContext): Record<string, McpToolHandler> {
        return {
            h3_get_defaults: async () => context.backend.getH3Defaults(),
            h3_set_defaults: async (input) => {
                const settings = input.settings && typeof input.settings === "object" && !Array.isArray(input.settings) ? input.settings as Record<string, unknown> : {};
                return { defaults: await context.backend.setH3Defaults(normalizeH3GenerationSettings(settings)) };
            },
            h3_reset_defaults: async () => { await context.backend.resetH3Defaults(); return { ok: true, defaults: null }; },
            canvas_list_reference_assets: async (input) => {
                const projectId = String(input.projectId || "");
                const project = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                if (!project) throw new Error(`画布不存在:${projectId}`);
                return { ok: true, projectId, assets: referenceCatalogOf(project) };
            },
            canvas_update_reference_asset: async (input) => {
                const projectId = String(input.projectId || "");
                const patch = input.asset && typeof input.asset === "object" && !Array.isArray(input.asset) ? { ...(input.asset as Record<string, unknown>) } : {};
                if (!projectId || !patch.id) throw new Error("projectId 和 asset.id 必填");
                const project = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                if (!project) throw new Error(`画布不存在:${projectId}`);
                const existing = referenceCatalogOf(project).find((item) => item.id === String(patch.id || ""));
                const asset = { ...existing, ...patch } as Record<string, unknown>;
                asset.label = String(asset.label || asset.name || asset.id);
                asset.mediaType = inferReferenceMediaType(asset);
                asset.role = inferReferenceRole(asset);
                asset.tags = Array.isArray(asset.tags) ? asset.tags.map(String) : [];
                asset.createdAt = existing?.createdAt || new Date().toISOString();
                asset.updatedAt = new Date().toISOString();
                const result = await context.backend.applyCanvasOperations(projectId, [{ type: "upsert_reference_asset", asset }]);
                return { ok: true, projectId, asset, revision: result.revision };
            },
            canvas_analyze_reference_asset: async (input) => {
                const projectId = String(input.projectId || "");
                const assetId = String(input.assetId || "");
                const project = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                if (!project) throw new Error(`画布不存在:${projectId}`);
                const asset = referenceCatalogOf(project).find((item) => item.id === assetId);
                if (!asset) throw new Error(`参考资产不存在:${assetId}`);
                const role = inferReferenceRole({ ...asset, role: input.role });
                const tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
                const next = { ...asset, role, tags, analysis: { summary: String(input.summary || ""), suggestedRole: role, suggestedTags: tags, model: String(input.model || "MCP caller"), updatedAt: new Date().toISOString() }, updatedAt: new Date().toISOString() };
                const result = await context.backend.applyCanvasOperations(projectId, [{ type: "upsert_reference_asset", asset: next }]);
                return { ok: true, projectId, asset: next, revision: result.revision };
            },
            h3_set_reference_bindings: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                const segmentId = String(input.segmentId || "");
                const project = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                if (!project) throw new Error(`画布不存在:${projectId}`);
                const node = (Array.isArray(project.nodes) ? project.nodes : []).find((item) => String((item as Record<string, unknown>).id || "") === nodeId) as AgentCanvasNode | undefined;
                if (!node) throw new Error(`找不到画布节点:${nodeId}`);
                const segment = segmentsOf(node).find((item) => String(item.id || "") === segmentId);
                if (!segment) throw new Error(`找不到片段:${segmentId}`);
                const rawBindings = Array.isArray(input.bindings) ? input.bindings as Array<Record<string, unknown>> : [];
                const bindings = referenceBindingsOf({ referenceBindings: rawBindings }).bindings;
                if (bindings.length !== rawBindings.length) throw new Error("每个参考绑定都必须包含稳定的 id 和 assetId");
                const expectedBindings = Array.isArray(input.expectedBindings) ? input.expectedBindings : segment.referenceBindings;
                assertReferenceCompilation(compileReferenceSubmission(project, { ...segment, referenceBindings: bindings }));
                const operation: Record<string, unknown> = { type: "update_h3_segment", nodeId, segmentId, patch: { referenceBindings: bindings } };
                if (expectedBindings !== undefined) operation.expectedFields = { referenceBindings: expectedBindings };
                const result = await context.backend.applyCanvasOperations(projectId, [operation]);
                return { ok: true, projectId, nodeId, segmentId, bindings, revision: result.revision };
            },
            h3_bind_existing_character_groups: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                const segmentId = String(input.segmentId || "");
                const project = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                if (!project) throw new Error(`画布不存在:${projectId}`);
                const projectNodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
                const node = projectNodes.find((item) => String(item.id || "") === nodeId) as AgentCanvasNode | undefined;
                if (!node) throw new Error(`找不到画布节点:${nodeId}`);
                if (!isH3Node(node)) throw new Error(`节点 ${nodeId} 不是 MiniMax H3 节点`);
                const segment = segmentsOf(node).find((item) => String(item.id || "") === segmentId);
                if (!segment) throw new Error(`找不到片段:${segmentId}`);
                const rawCharacters = Array.isArray(input.characters) ? input.characters as Array<Record<string, unknown>> : [];
                const characterCandidate = buildCharacterCandidate(projectNodes, segment, rawCharacters);
                const { built, requestedNodeIds, nextGroups, nextBindings } = characterCandidate;
                const candidate = { ...segment, h3CharacterGroups: nextGroups, referenceBindings: nextBindings };
                const compilation = compileReferenceSubmission(project, candidate);
                assertReferenceCompilation(compilation);
                const expectedFields = { h3CharacterGroups: segment.h3CharacterGroups, referenceBindings: segment.referenceBindings };
                const operations: Record<string, unknown>[] = [{ type: "update_h3_segment", nodeId, segmentId, patch: { h3CharacterGroups: nextGroups, referenceBindings: nextBindings }, expectedFields }];
                const connections = Array.isArray(project.connections) ? project.connections as Array<Record<string, unknown>> : [];
                let nextOrder = connections.filter((connection) => String(connection.toNodeId || "") === nodeId).length;
                for (const item of built) {
                    const alreadyConnected = connections.some((connection) => String(connection.fromNodeId || "") === item.characterNodeId && String(connection.toNodeId || "") === nodeId);
                    if (!alreadyConnected) operations.push({ type: "connect_nodes", fromNodeId: item.characterNodeId, toNodeId: nodeId, role: "reference", order: nextOrder++ });
                }
                const result = await context.backend.applyCanvasOperations(projectId, operations, Number(project.revision || 0));
                const refreshedProject = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                const refreshedNode = refreshedProject && (Array.isArray(refreshedProject.nodes) ? refreshedProject.nodes : []).find((item) => String((item as Record<string, unknown>).id || "") === nodeId) as AgentCanvasNode | undefined;
                const refreshedSegment = refreshedNode && segmentsOf(refreshedNode).find((item) => String(item.id || "") === segmentId);
                if (!refreshedProject || !refreshedSegment) throw new Error(`角色组写入后读取失败:${segmentId}`);
                const refreshedCompilation = compileReferenceSubmission(refreshedProject, refreshedSegment);
                assertReferenceCompilation(refreshedCompilation);
                const refreshedConnections = Array.isArray(refreshedProject.connections) ? refreshedProject.connections as Array<Record<string, unknown>> : [];
                return {
                    ok: true,
                    projectId,
                    nodeId,
                    segmentId,
                    revision: result.revision,
                    groups: built.map((item) => ({ characterNodeId: item.characterNodeId, groupId: item.built.group.id, catalogCount: item.built.group.outfits.length, enabledCount: item.built.group.outfits.filter((outfit) => outfit.enabled).length })),
                    bindings: refreshedCompilation.references.filter((reference) => reference.groupId),
                    connections: refreshedConnections.filter((connection) => requestedNodeIds.has(String(connection.fromNodeId || "")) && String(connection.toNodeId || "") === nodeId),
                };
            },
            h3_prepare_clip: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                const segmentId = String(input.segmentId || "");
                await assertProjectNode(context, projectId, nodeId);
                const project = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                if (!project) throw new Error(`画布不存在:${projectId}`);
                const projectNodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
                const node = projectNodes.find((item) => String(item.id || "") === nodeId) as AgentCanvasNode | undefined;
                if (!node || !isH3Node(node)) throw new Error(`节点 ${nodeId} 不是 MiniMax H3 节点`);
                const segments = segmentsOf(node);
                const segment = segments.find((item) => String(item.id || "") === segmentId);
                if (!segment) throw new Error(`找不到片段:${segmentId}`);
                const rawPatch = input.patch && typeof input.patch === "object" && !Array.isArray(input.patch) ? input.patch as Record<string, unknown> : {};
                for (const key of ["h3CharacterGroups", "characterGroups", "referenceBindings", "status", "result", "resultStorageKey", "runtimeTaskId", "progress", "errorDetails", "cacheFingerprint"]) {
                    if (Object.prototype.hasOwnProperty.call(rawPatch, key)) throw new Error(`h3_prepare_clip 不允许直接修改 ${key}`);
                }
                const explicitSourceId = input.inheritFromSegmentId ? String(input.inheritFromSegmentId) : undefined;
                if (explicitSourceId && !segments.some((item) => String(item.id || "") === explicitSourceId)) throw new Error(`找不到继承来源片段:${explicitSourceId}`);
                const source = selectH3InheritanceSource(segments, segmentId, explicitSourceId);
                if (explicitSourceId && !source) throw new Error(`继承来源片段未完成，不能作为已验证基线:${explicitSourceId}`);
                const inherited = inheritedH3Params(node, source?.id ? String(source.id) : undefined, segments);
                const preparedPatch: Record<string, unknown> = { ...inherited, ...rawPatch };
                if (Array.isArray(input.referenceBindings)) {
                    const rawBindings = input.referenceBindings as Array<Record<string, unknown>>;
                    const bindings = referenceBindingsOf({ referenceBindings: rawBindings }).bindings;
                    if (bindings.length !== rawBindings.length) throw new Error("每个参考绑定都必须包含稳定的 id 和 assetId");
                    preparedPatch.referenceBindings = bindings;
                }
                let candidate: H3Segment = { ...segment, ...preparedPatch };
                let characterCandidate: ReturnType<typeof buildCharacterCandidate> | undefined;
                if (Array.isArray(input.characters)) {
                    characterCandidate = buildCharacterCandidate(projectNodes, candidate, input.characters as Array<Record<string, unknown>>);
                    preparedPatch.h3CharacterGroups = characterCandidate.nextGroups;
                    preparedPatch.referenceBindings = characterCandidate.nextBindings;
                    candidate = { ...segment, ...preparedPatch };
                }
                const compilation = compileReferenceSubmission(project, candidate);
                assertReferenceCompilation(compilation);
                const operations: Record<string, unknown>[] = [{
                    type: "update_h3_segment",
                    nodeId,
                    segmentId,
                    patch: preparedPatch,
                    expectedFields: {
                        ...(segment.h3CharacterGroups !== undefined || preparedPatch.h3CharacterGroups !== undefined ? { h3CharacterGroups: segment.h3CharacterGroups } : {}),
                        ...(segment.referenceBindings !== undefined || preparedPatch.referenceBindings !== undefined ? { referenceBindings: segment.referenceBindings } : {}),
                    },
                }];
                if (characterCandidate) {
                    const connections = Array.isArray(project.connections) ? project.connections as Array<Record<string, unknown>> : [];
                    let nextOrder = connections.filter((connection) => String(connection.toNodeId || "") === nodeId).length;
                    for (const item of characterCandidate.built) {
                        const alreadyConnected = connections.some((connection) => String(connection.fromNodeId || "") === item.characterNodeId && String(connection.toNodeId || "") === nodeId);
                        if (!alreadyConnected) operations.push({ type: "connect_nodes", fromNodeId: item.characterNodeId, toNodeId: nodeId, role: "reference", order: nextOrder++ });
                    }
                }
                const result = await context.backend.applyCanvasOperations(projectId, operations, Number(project.revision || 0));
                const refreshedProject = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                const refreshedNode = refreshedProject && (Array.isArray(refreshedProject.nodes) ? refreshedProject.nodes : []).find((item) => String((item as Record<string, unknown>).id || "") === nodeId) as AgentCanvasNode | undefined;
                const refreshedSegment = refreshedNode && segmentsOf(refreshedNode).find((item) => String(item.id || "") === segmentId);
                if (!refreshedProject || !refreshedSegment) throw new Error(`H3 片段准备后读取失败:${segmentId}`);
                const refreshedCompilation = compileReferenceSubmission(refreshedProject, refreshedSegment);
                assertReferenceCompilation(refreshedCompilation);
                return {
                    ok: true,
                    projectId,
                    nodeId,
                    segmentId,
                    revision: result.revision,
                    snapshot: buildH3ClipSnapshot(refreshedSegment, refreshedCompilation, {
                        ...(source?.id ? { sourceSegmentId: String(source.id) } : {}),
                        changedSettings: diffH3Settings(inherited, refreshedSegment),
                    }),
                };
            },
            canvas_validate_generation: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                const segmentId = String(input.segmentId || "");
                const project = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                if (!project) throw new Error(`画布不存在:${projectId}`);
                const node = (Array.isArray(project.nodes) ? project.nodes : []).find((item) => String((item as Record<string, unknown>).id || "") === nodeId) as AgentCanvasNode | undefined;
                if (!node) throw new Error(`找不到画布节点:${nodeId}`);
                const segment = segmentsOf(node).find((item) => String(item.id || "") === segmentId);
                if (!segment) throw new Error(`找不到片段:${segmentId}`);
                const validation = compileReferenceSubmission(project, segment);
                return { ok: validation.issues.every((issue) => issue.severity !== "error"), projectId, nodeId, segmentId, validation, snapshot: buildH3ClipSnapshot(segment, validation) };
            },
            h3_apply_video_plan: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                if (input.language !== undefined && String(input.language) !== "zh-CN") throw new Error("H3 视频计划当前只接受 language=zh-CN");
                const node = await context.getCanvasNode(nodeId);
                if (!node) throw new Error(`找不到画布节点:${nodeId}`);
                const project = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                if (!project || !Array.isArray(project.nodes) || !(project.nodes as Array<Record<string, unknown>>).some((item) => String(item.id || "") === nodeId)) throw new Error(`节点不属于指定画布:${projectId}`);
                const rawSegments = Array.isArray(input.segments) ? input.segments as H3PlannedSegment[] : [];
                if (rawSegments.some((item) => Object.prototype.hasOwnProperty.call(item, "h3CharacterGroups") || Object.prototype.hasOwnProperty.call(item, "characterGroups"))) throw new Error("角色组必须通过 h3_bind_existing_character_groups 写入");
                validateVideoPlan(rawSegments);
                const existing = segmentsOf(node);
                // 计划只描述剧情字段；节点上的生成参数（模型/LoRA/采样等）必须继承下来，
                // 否则前端 H3Runner 会按 segment 缺省值静默回退到错误模型。
                const inherited = inheritedH3Params(node);
                const next = rawSegments.map((item) => ({ ...inherited, ...normalizePlannedSegment(item) }));
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
                return { ok: true, projectId, nodeId, count: next.length, segments: next };
            },
            h3_write_storyboard_prompt: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                const segmentId = String(input.segmentId || "");
                await assertProjectNode(context, projectId, nodeId);
                const project = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                const node = await context.getCanvasNode(nodeId);
                if (!project || !node) throw new Error(`找不到画布或节点：${projectId}/${nodeId}`);
                if (!isH3Node(node)) throw new Error(`节点 ${nodeId} 不是 MiniMax H3 节点`);
                const segment = segmentsOf(node).find((item) => String(item.id || "") === segmentId);
                if (!segment) throw new Error(`找不到片段:${segmentId}`);
                const generated = writeStoryboardPrompt(project, segment, input);
                if (generated.unchanged) return { ok: true, unchanged: true, projectId, nodeId, segmentId, fingerprint: generated.fingerprint, subjectCount: generated.subjectCount, shotCount: generated.shotCount, prompt: segment.prompt || "" };
                await context.updateH3Segment(nodeId, segmentId, { prompt: generated.prompt, ...(generated.cache ? { storyboardPromptCache: generated.cache } : {}) });
                const refreshed = await context.getCanvasNode(nodeId);
                const updated = refreshed && segmentsOf(refreshed).find((item) => String(item.id || "") === segmentId);
                if (!updated) throw new Error(`分镜提示词写入后读取失败:${segmentId}`);
                return { ok: true, unchanged: false, projectId, nodeId, segmentId, fingerprint: generated.fingerprint, subjectCount: generated.subjectCount, shotCount: generated.shotCount, segment: updated };
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
            h3_get_clip: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                const segmentId = String(input.segmentId || "");
                await assertProjectNode(context, projectId, nodeId);
                const project = (await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === projectId);
                const node = project && (Array.isArray(project.nodes) ? project.nodes : []).find((item) => String((item as Record<string, unknown>).id || "") === nodeId) as AgentCanvasNode | undefined;
                if (!project || !node) throw new Error(`找不到画布或节点：${projectId}/${nodeId}`);
                const segment = segmentsOf(node).find((item) => String(item.id || "") === segmentId);
                if (!segment) throw new Error(`找不到片段:${segmentId}`);
                const compilation = compileReferenceSubmission(project, segment);
                return { ok: true, projectId, nodeId, segmentId, snapshot: buildH3ClipSnapshot(segment, compilation) };
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
                if (Object.prototype.hasOwnProperty.call(patch, "h3CharacterGroups")) throw new Error("角色组必须通过 h3_bind_existing_character_groups 写入");
                if (Object.prototype.hasOwnProperty.call(patch, "referenceBindings")) assertReferenceCompilation(compileReferenceSubmission((await context.backend.listCanvasProjects()).find((item) => String(item.id || "") === String(input.projectId || "")) || {}, { ...target, ...patch }));
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
