import type { AgentCanvasNode, McpToolHandler, PluginMcpContext, PluginMcpModule, PluginMcpToolWire } from "../../server/plugin-mcp.js";
import { H3_PLUGIN_VERSION } from "./version.js";
import { normalizeH3GenerationSettings, normalizePlannedSegment, validateVideoPlan, type H3PlannedSegment } from "./video-plan.js";
import { compileReferenceSubmission, inferReferenceMediaType, inferReferenceRole, referenceBindingsOf, referenceCatalogOf, assertReferenceCompilation } from "../../canvas/reference-contract.js";
import { validateH3CharacterGroups } from "../../canvas/character-reference-contract.js";
import { buildCharacterGroupFromExistingNode } from "./character-groups.js";
import { writeStoryboardPrompt } from "./storyboard-write.js";
import { isReferenceNameEcho } from "./prompt-rules.js";

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
    "dedicatedAttention", "startupMode", "faceRefineEnabled", "faceRefineDetector", "faceRefineConfidence", "faceRefineCropFactor", "faceRefineCanvasSize", "faceRefineDenoise", "faceRefineSteps", "faceRefineSampler", "faceRefineScheduler", "faceRefinePasteRegion", "faceRefineMaskDilation", "faceRefineFeather", "faceRefineColourMatch", "faceRefineBlend", "lowMemoryAttentionHeads", "reservedVramGb", "runtimeReserveEnabled", "uniBlockSwapEnabled", "uniBlockSwapBlocks", "keepModelCache",
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
        version: "1.3.0",
        name: "H3 读取画布节点",
        description: "按节点 id 读取 MiniMax H3 节点摘要与当前时间线的稳定 Clip ID、顺序和状态；单段提示词、参考与运行参数请用 h3_get_clip 的定向工具读取。",
        inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string", description: "画布节点 id" } }, required: ["projectId", "nodeId"] },
    },
    {
        id: "h3_get_clip",
        version: "1.2.0",
        name: "H3 读取片段总览",
        description: "按当前稳定 segmentId 读取 H3 Clip 的轻量状态；ID 不确定时先用 h3_get_node 查看当前时间线。可通过 include 附带提示词、参考或运行参数。",
        inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" }, segmentId: { type: "string" }, include: { type: "array", items: { type: "string", enum: ["prompt", "references", "runtime"] }, uniqueItems: true } }, required: ["projectId", "nodeId", "segmentId"] },
    },
    {
        id: "h3_get_clip_prompt",
        version: "1.0.0",
        name: "H3 读取片段提示词",
        description: "按需读取指定 H3 Clip 的语义提示词和最终编译提示词。",
        inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" }, segmentId: { type: "string" } }, required: ["projectId", "nodeId", "segmentId"] },
    },
    {
        id: "h3_get_clip_references",
        version: "1.0.0",
        name: "H3 读取片段参考",
        description: "按需读取指定 H3 Clip 编译后的参考素材、角色组和引用预检问题。",
        inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" }, segmentId: { type: "string" } }, required: ["projectId", "nodeId", "segmentId"] },
    },
    {
        id: "h3_get_clip_runtime",
        version: "1.0.0",
        name: "H3 读取片段运行参数",
        description: "按需读取指定 H3 Clip 的模型、采样、尺寸、LoRA 和其他运行参数。",
        inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" }, segmentId: { type: "string" } }, required: ["projectId", "nodeId", "segmentId"] },
    },
    {
        id: "h3_run_clip",
        version: "1.4.0",
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
        version: "1.4.0",
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
        version: "1.5.0",
        name: "H3 应用结构化视频计划",
        description: "把按镜号拆分的结构化中文视频计划写入 H3 节点，并按角色化参考清单生成最终提示词。追加模式可指定锚点 Clip 前后原子插入，多段保持输入顺序。",
        inputJsonSchema: {
            type: "object",
            properties: {
                projectId: { type: "string" },
                nodeId: { type: "string" },
                replaceSegments: { type: "boolean", description: "true 替换整组；false 追加新 Clip（可指定插入锚点）" },
                beforeSegmentId: { type: "string", description: "仅追加模式：把新 Clip 插入此稳定 Clip ID 之前" },
                afterSegmentId: { type: "string", description: "仅追加模式：把新 Clip 插入此稳定 Clip ID 之后" },
                language: { type: "string", enum: ["zh-CN"] },
                segments: { type: "array", items: { type: "object" } },
            },
            required: ["projectId", "nodeId", "segments"],
        },
    },
    {
        id: "h3_write_storyboard_prompt",
        version: "1.2.0",
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
                            description: { type: "string", description: "分镜描述，可包含 <Subject N> 与 <Picture N> 等 H3 引用标签" },
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
        version: "1.3.0",
        name: "H3 查询任务",
        description: "按任务 id 查询 MiniMax H3 生成任务的状态、进度与结果。",
        inputJsonSchema: { type: "object", properties: { taskId: { type: "string", description: "任务 id" } }, required: ["taskId"] },
    },
    {
        id: "h3_cancel_task",
        version: "1.3.0",
        name: "H3 取消任务",
        description: "取消正在运行的 MiniMax H3 生成任务。",
        inputJsonSchema: { type: "object", properties: { taskId: { type: "string", description: "任务 id" } }, required: ["taskId"] },
    },
    {
        id: "h3_update_clip",
        version: "1.3.0",
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
        id: "h3_move_clip",
        version: "1.0.0",
        name: "H3 移动片段",
        description: "按稳定 Clip ID 调整指定 H3 节点内的片段顺序；可移动到另一片段前/后，省略目标时移动到末尾。",
        inputJsonSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", description: "画布项目 id" },
                nodeId: { type: "string", description: "H3 节点 id" },
                segmentId: { type: "string", description: "要移动的 Clip 稳定 id" },
                beforeSegmentId: { type: "string", description: "移动到此 Clip 前面；与 afterSegmentId 二选一" },
                afterSegmentId: { type: "string", description: "移动到此 Clip 后面；与 beforeSegmentId 二选一" },
            },
            required: ["projectId", "nodeId", "segmentId"],
        },
    },
    {
        id: "h3_delete_clip",
        version: "1.0.0",
        name: "H3 删除片段",
        description: "从 H3 节点当前时间线移除一个 Clip 配置；不会删除已归档的视频、生成任务或日志。",
        inputJsonSchema: {
            type: "object",
            properties: {
                projectId: { type: "string", description: "画布项目 id" },
                nodeId: { type: "string", description: "H3 节点 id" },
                segmentId: { type: "string", description: "要从当前时间线移除的稳定 Clip id" },
            },
            required: ["projectId", "nodeId", "segmentId"],
        },
    },
    {
        id: "h3_run_all_clips",
        version: "1.3.0",
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
    { id: "canvas_list_reference_assets", version: "1.0.0", name: "列出项目参考资产", description: "列出项目级参考资产库及其主要职责、标签和媒体句柄。", inputJsonSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] } },
    { id: "canvas_update_reference_asset", version: "1.0.0", name: "更新项目参考资产", description: "新增或更新项目参考资产；职责只保存一个 primary role，补充语义放 tags。", inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, asset: { type: "object" } }, required: ["projectId", "asset"] } },
    { id: "canvas_analyze_reference_asset", version: "1.0.0", name: "记录参考资产分析", description: "把模型对参考素材的职责、标签和摘要写入项目资产；调用方应先实际查看素材再提交分析。", inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, assetId: { type: "string" }, role: { type: "string" }, tags: { type: "array", items: { type: "string" } }, summary: { type: "string" }, model: { type: "string" } }, required: ["projectId", "assetId", "role", "tags", "summary"] } },
    { id: "h3_set_reference_bindings", version: "1.3.0", name: "设置 Clip 参考绑定", description: "整组替换指定 Clip 的手工参考绑定（场景、分镜、关键帧、音频、色卡、道具等），不修改节点位置或运行状态。角色组人物与其服装图片的参考绑定是 h3CharacterGroups 的派生视图，由编译器自动生成：增删改角色、服装或启用状态请调用 h3_bind_existing_character_groups，本工具只需管好非角色组参考。单张分镜图替换请用 h3_replace_storyboard_binding。", inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" }, segmentId: { type: "string" }, bindings: { type: "array", items: { type: "object" } }, expectedBindings: { type: "array", items: { type: "object" } } }, required: ["projectId", "nodeId", "segmentId", "bindings"] } },
    { id: "h3_replace_storyboard_binding", version: "1.0.0", name: "替换单个 Clip 分镜绑定", description: "按 bindingId 和旧 storageKey 只替换一个 storyboard 参考；服务端读取原始绑定做 CAS，保留角色组、其他参考与任务历史。", inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" }, segmentId: { type: "string" }, bindingId: { type: "string" }, expectedStorageKey: { type: "string" }, assetId: { type: "string", description: "已登记且指向新分镜图的项目参考资产 ID" } }, required: ["projectId", "nodeId", "segmentId", "bindingId", "expectedStorageKey", "assetId"] } },
    { id: "canvas_replace_storyboard_slots", version: "1.0.0", name: "替换分镜组指定槽位", description: "一次画布事务替换有序分镜组的指定槽位、来源槽位及关联参考资产；旧节点和媒体保留。新图尺寸需符合 expectedAspectRatio。", inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, groupId: { type: "string" }, expectedAspectRatio: { type: "string", description: "目标画幅，例如 9:16" }, slots: { type: "array", items: { type: "object", properties: { slot: { type: "integer", description: "从 1 开始的槽位序号" }, expectedNodeId: { type: "string" }, nodeId: { type: "string", description: "已生成新图的节点 ID" }, assetIds: { type: "array", items: { type: "string" } }, label: { type: "string" } }, required: ["slot", "expectedNodeId", "nodeId", "assetIds"] } } }, required: ["projectId", "groupId", "expectedAspectRatio", "slots"] } },
    { id: "h3_bind_existing_character_groups", version: "1.2.0", name: "绑定或移除 Clip 角色组", description: "从已有 character 节点构建当前 Clip 的角色组；也可按稳定 groupId 移除角色组及其角色参考绑定。characters 与 removeGroupIds 至少提供一项；不删除角色节点或画布连线。", inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" }, segmentId: { type: "string" }, characters: { type: "array", items: { type: "object", properties: { characterNodeId: { type: "string" }, subjectId: { type: "string", description: "提示词使用的稳定 subjectId；将同步写入角色组和全部角色参考绑定" }, selectedOutfitStorageKeys: { type: "array", items: { type: "string" } }, voiceEnabled: { type: "boolean" } }, required: ["characterNodeId", "selectedOutfitStorageKeys"] } }, removeGroupIds: { type: "array", items: { type: "string" }, description: "要从当前 Clip 移除的稳定角色组 ID；对应角色组参考绑定也会一起移除" } }, required: ["projectId", "nodeId", "segmentId"] } },
    { id: "canvas_validate_generation", version: "1.0.0", name: "生成预检", description: "使用与 Backend 实际提交相同的编译器预检语义提示词、参考顺序、模式上限和缺失媒体。", inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" }, segmentId: { type: "string" } }, required: ["projectId", "nodeId", "segmentId"] } },
];

function segmentsOf(node: AgentCanvasNode): H3Segment[] {
    const meta = node.metadata || {};
    const raw = meta.segments;
    if (Array.isArray(raw)) return raw as H3Segment[];
    return [];
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function activeImageOf(node: AgentCanvasNode) {
    const metadata = recordOf(node.metadata);
    const storageKey = String(metadata.storageKey || "");
    const images = Array.isArray(metadata.images) ? metadata.images.map(recordOf) : [];
    const image = images.find((item) => String(item.storageKey || "") === storageKey) || {};
    return { storageKey, width: Number(image.naturalWidth || metadata.naturalWidth || 0), height: Number(image.naturalHeight || metadata.naturalHeight || 0) };
}

function h3NodeSummary(node: AgentCanvasNode) {
    const segments = segmentsOf(node);
    return {
        id: node.id, type: node.type, title: node.title,
        segmentCount: segments.length,
        segments: segments.map((segment, index) => ({
            id: String(segment.id || ""), index, title: String(segment.title || ""),
            sourceShotId: String(segment.sourceShotId || ""),
            status: String(segment.status || "idle"),
            hasResult: Boolean(segment.result || segment.resultStorageKey),
        })),
    };
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

async function readH3Clip(context: PluginMcpContext, input: Record<string, unknown>) {
    const projectId = String(input.projectId || "");
    const nodeId = String(input.nodeId || "");
    const segmentId = String(input.segmentId || "");
    const readStarted = Date.now();
    const { project, node } = await getProjectNode(context, projectId, nodeId);
    const projectReadMs = Date.now() - readStarted;
    const segment = segmentsOf(node).find((item) => String(item.id || "") === segmentId);
    if (!segment) {
        const ids = segmentsOf(node).map((item) => String(item.id || "")).filter(Boolean);
        throw new Error(`找不到片段:${segmentId}；当前 Clip ID：${ids.slice(0, 50).join("、")}${ids.length > 50 ? `（另有 ${ids.length - 50} 个）` : ""}；请先调用 h3_get_node 核对当前时间线`);
    }
    const compileStarted = Date.now();
    const compilation = compileReferenceSubmission(project, segment);
    return { projectId, nodeId, segmentId, segment, timings: { projectReadMs, compileMs: Date.now() - compileStarted }, snapshot: buildH3ClipSnapshot(segment, compilation) };
}

function summarizeRuntimeTask(task: import("../../runtime/types.js").RuntimeTask) {
    return {
        id: task.id,
        kind: task.kind,
        status: task.status,
        progress: task.progress,
        projectId: task.projectId,
        nodeId: task.nodeId,
        segmentId: task.segmentId,
        parentTaskId: task.parentTaskId,
        executor: task.executor,
        model: task.model,
        outputs: task.outputs,
        result: task.result,
        error: task.error,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
    };
}

function buildCharacterCandidate(projectNodes: Array<Record<string, unknown>>, segment: H3Segment, rawCharacters: Array<Record<string, unknown>>, rawRemoveGroupIds: string[] = []) {
    if (!rawCharacters.length && !rawRemoveGroupIds.length) throw new Error("characters 或 removeGroupIds 至少提供一项");
    const existingGroups = segment.h3CharacterGroups && typeof segment.h3CharacterGroups === "object" && !Array.isArray(segment.h3CharacterGroups) ? segment.h3CharacterGroups as Record<string, unknown> : {};
    const removeGroupIds = rawRemoveGroupIds.map((id) => String(id || "").trim());
    if (removeGroupIds.some((id) => !id) || new Set(removeGroupIds).size !== removeGroupIds.length) throw new Error("removeGroupIds 不能包含空 ID 或重复 ID");
    const explicitRemovalIds = new Set<string>();
    for (const [key, value] of Object.entries(existingGroups)) {
        const group = value as Record<string, unknown>;
        const groupId = String(group.id || key);
        if (removeGroupIds.includes(key) || removeGroupIds.includes(groupId)) explicitRemovalIds.add(groupId);
    }
    const missingGroupIds = removeGroupIds.filter((id) => !Object.entries(existingGroups).some(([key, value]) => key === id || String((value as Record<string, unknown>)?.id || "") === id));
    if (missingGroupIds.length) throw new Error(`找不到要移除的角色组:${missingGroupIds.join(", ")}`);
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
    const removedGroupIds = new Set([...explicitRemovalIds, ...Object.entries(existingGroups).filter(([, value]) => requestedNodeIds.has(String((value as Record<string, unknown>)?.characterNodeId || ""))).map(([key, value]) => String((value as Record<string, unknown>)?.id || key))]);
    const nextGroups: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(existingGroups)) {
        const group = value as Record<string, unknown>;
        if (!requestedNodeIds.has(String(group.characterNodeId || "")) && !removedGroupIds.has(String(group.id || key))) nextGroups[key] = value;
    }
    for (const item of built) nextGroups[item.built.group.id] = item.built.group;
    const previousBindings = referenceBindingsOf(segment).bindings;
    const preservedBindings = previousBindings.filter((binding) => !binding.groupId || (!removedGroupIds.has(String(binding.groupId)) && Boolean(nextGroups[String(binding.groupId)])));
    return { built, requestedNodeIds, nextGroups, nextBindings: [...preservedBindings, ...built.flatMap((item) => item.built.refs)], removedGroupIds };
}

function isH3Node(node: AgentCanvasNode): boolean {
    return String(node.type || "").includes("minimax");
}

async function getProjectNode(context: PluginMcpContext, projectId: string, nodeId: string) {
    if (!projectId) throw new Error("projectId 必填，MCP 不再自动选择画布");
    const project = await context.getCanvasProject(projectId);
    if (String(project.id || "") !== projectId) throw new Error(`画布不匹配:${projectId}`);
    const node = (Array.isArray(project.nodes) ? project.nodes : []).find((item) => String((item as Record<string, unknown>).id || "") === nodeId) as AgentCanvasNode | undefined;
    if (!node) throw new Error(`找不到画布节点:${nodeId}`);
    return { project, node };
}

export const pluginMcp: PluginMcpModule = {
    id: "minimax-h3",
    version: H3_PLUGIN_VERSION,
    tools: TOOLS,
    createHandler(context: PluginMcpContext): Record<string, McpToolHandler> {
        return {
            h3_get_defaults: async () => context.backend.getH3Defaults(),
            h3_set_defaults: async (input) => {
                const settings = input.settings && typeof input.settings === "object" && !Array.isArray(input.settings) ? input.settings as Record<string, unknown> : {};
                const defaults = await context.backend.setH3Defaults(normalizeH3GenerationSettings(settings));
                return { ok: true, settingCount: Object.keys(defaults).length };
            },
            h3_reset_defaults: async () => { await context.backend.resetH3Defaults(); return { ok: true, defaults: null }; },
            canvas_list_reference_assets: async (input) => {
                const projectId = String(input.projectId || "");
                const project = await context.getCanvasProject(projectId);
                return { ok: true, projectId, assets: referenceCatalogOf(project) };
            },
            canvas_update_reference_asset: async (input) => {
                const projectId = String(input.projectId || "");
                const patch = input.asset && typeof input.asset === "object" && !Array.isArray(input.asset) ? { ...(input.asset as Record<string, unknown>) } : {};
                if (!projectId || !patch.id) throw new Error("projectId 和 asset.id 必填");
                const project = await context.getCanvasProject(projectId);
                const existing = referenceCatalogOf(project).find((item) => item.id === String(patch.id || ""));
                const asset = { ...existing, ...patch } as Record<string, unknown>;
                asset.label = String(asset.label || asset.name || asset.id);
                asset.mediaType = inferReferenceMediaType(asset);
                asset.role = inferReferenceRole(asset);
                asset.tags = Array.isArray(asset.tags) ? asset.tags.map(String) : [];
                asset.createdAt = existing?.createdAt || new Date().toISOString();
                asset.updatedAt = new Date().toISOString();
                const result = await context.backend.applyCanvasOperations(projectId, [{ type: "upsert_reference_asset", asset }], Number(project.revision || 0));
                return { ok: true, projectId, asset, revision: result.revision };
            },
            canvas_analyze_reference_asset: async (input) => {
                const projectId = String(input.projectId || "");
                const assetId = String(input.assetId || "");
                const project = await context.getCanvasProject(projectId);
                const asset = referenceCatalogOf(project).find((item) => item.id === assetId);
                if (!asset) throw new Error(`参考资产不存在:${assetId}`);
                const role = inferReferenceRole({ ...asset, role: input.role });
                const tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
                const summary = String(input.summary || "");
                // 摘要写成素材名回显时会直接污染自动生成提示词（分镜图描述里出现文件名），这里直接拒绝写入。
                if (summary && isReferenceNameEcho(summary, [asset.label, asset.id])) throw new Error(`summary 不能是素材名回显（${asset.label}），请写视觉内容摘要`);
                const next = { ...asset, role, tags, analysis: { summary, suggestedRole: role, suggestedTags: tags, model: String(input.model || "MCP caller"), updatedAt: new Date().toISOString() }, updatedAt: new Date().toISOString() };
                const result = await context.backend.applyCanvasOperations(projectId, [{ type: "upsert_reference_asset", asset: next }], Number(project.revision || 0));
                return { ok: true, projectId, asset: next, revision: result.revision };
            },
            h3_set_reference_bindings: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                const segmentId = String(input.segmentId || "");
                const { project, node } = await getProjectNode(context, projectId, nodeId);
                const segment = segmentsOf(node).find((item) => String(item.id || "") === segmentId);
                if (!segment) throw new Error(`找不到片段:${segmentId}`);
                const rawBindings = Array.isArray(input.bindings) ? input.bindings as Array<Record<string, unknown>> : [];
                const bindings = referenceBindingsOf({ referenceBindings: rawBindings }).bindings;
                if (bindings.length !== rawBindings.length) throw new Error("每个参考绑定都必须包含稳定的 id 和 assetId");
                const expectedBindings = Array.isArray(input.expectedBindings) ? input.expectedBindings : segment.referenceBindings;
                assertReferenceCompilation(compileReferenceSubmission(project, { ...segment, referenceBindings: bindings }));
                const operation: Record<string, unknown> = { type: "update_h3_segment", nodeId, segmentId, patch: { referenceBindings: bindings } };
                if (expectedBindings !== undefined) operation.expectedFields = { referenceBindings: expectedBindings };
                const result = await context.backend.applyCanvasOperations(projectId, [operation], Number(project.revision || 0));
                return { ok: true, projectId, nodeId, segmentId, bindingCount: bindings.length, revision: result.revision };
            },
            h3_replace_storyboard_binding: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                const segmentId = String(input.segmentId || "");
                const bindingId = String(input.bindingId || "");
                const assetId = String(input.assetId || "");
                const expectedStorageKey = String(input.expectedStorageKey || "");
                const { project, node } = await getProjectNode(context, projectId, nodeId);
                if (!isH3Node(node)) throw new Error(`节点 ${nodeId} 不是 MiniMax H3 节点`);
                const segment = segmentsOf(node).find((item) => String(item.id || "") === segmentId);
                if (!segment || !Array.isArray(segment.referenceBindings)) throw new Error(`找不到原始 Clip 参考绑定:${segmentId}`);
                if (["queued", "running"].includes(String(segment.status || ""))) throw new Error(`Clip 正在运行，暂不能替换参考:${segmentId}`);
                const bindings = referenceBindingsOf(segment).bindings;
                const index = bindings.findIndex((binding) => binding.id === bindingId);
                if (index < 0 || bindings[index].role !== "storyboard") throw new Error(`找不到 storyboard binding:${bindingId}`);
                const asset = referenceCatalogOf(project).find((item) => item.id === assetId);
                if (!asset || inferReferenceRole(asset) !== "storyboard") throw new Error(`找不到分镜参考资产:${assetId}`);
                const storageKey = String(asset.storageKey || "");
                if (!storageKey.startsWith("image:")) throw new Error(`分镜资产缺少图片 storageKey:${assetId}`);
                const sourceNodeId = String(asset.sourceNodeId || "");
                if (sourceNodeId) {
                    const source = (Array.isArray(project.nodes) ? project.nodes : []).find((item) => String((item as Record<string, unknown>).id || "") === sourceNodeId) as AgentCanvasNode | undefined;
                    if (!source || activeImageOf(source).storageKey !== storageKey) throw new Error(`分镜资产与源节点活动图不一致:${assetId}`);
                }
                const previous = bindings[index];
                if (previous.storageKey === storageKey && previous.assetId === assetId) return { ok: true, unchanged: true, projectId, nodeId, segmentId, bindingId, storageKey };
                if (previous.storageKey !== expectedStorageKey) throw new Error(`binding ${bindingId} 已变化；当前 storageKey:${previous.storageKey || ""}`);
                bindings[index] = { ...previous, assetId, label: asset.label, storageKey, url: `/media/${encodeURIComponent(storageKey)}`, mimeType: asset.mimeType || "image/png", sourceNodeId };
                assertReferenceCompilation(compileReferenceSubmission(project, { ...segment, referenceBindings: bindings }));
                const result = await context.backend.applyCanvasOperations(projectId, [{ type: "update_h3_segment", nodeId, segmentId, patch: { referenceBindings: bindings }, expectedFields: { referenceBindings: segment.referenceBindings } }], Number(project.revision || 0));
                return { ok: true, projectId, nodeId, segmentId, bindingId, oldStorageKey: previous.storageKey, storageKey, revision: result.revision };
            },
            canvas_replace_storyboard_slots: async (input) => {
                const projectId = String(input.projectId || "");
                const groupId = String(input.groupId || "");
                const ratio = /^([1-9]\d*):([1-9]\d*)$/.exec(String(input.expectedAspectRatio || ""));
                if (!ratio) throw new Error("expectedAspectRatio 必须为宽:高，例如 9:16");
                const targetRatio = Number(ratio[1]) / Number(ratio[2]);
                const project = await context.getCanvasProject(projectId);
                const nodes = Array.isArray(project.nodes) ? project.nodes as AgentCanvasNode[] : [];
                const group = nodes.find((item) => item.id === groupId);
                const metadata = recordOf(group?.metadata);
                if (!group || group.type !== "group" || metadata.orderedGroup !== true || !Array.isArray(metadata.groupSlots)) throw new Error(`找不到有序分镜组:${groupId}`);
                const slots = [...metadata.groupSlots].map(String);
                const sources = Array.isArray(metadata.sourceGroupSlots) ? [...metadata.sourceGroupSlots].map(String) : [...slots];
                const catalog = referenceCatalogOf(project);
                const raw = Array.isArray(input.slots) ? input.slots.map(recordOf) : [];
                if (!raw.length) throw new Error("slots 至少指定一项");
                const used = new Set<number>();
                const usedAssets = new Set<string>();
                const operations: Array<Record<string, unknown>> = [];
                const changed: Array<Record<string, unknown>> = [];
                for (const entry of raw) {
                    const index = Number(entry.slot) - 1;
                    const oldNodeId = String(entry.expectedNodeId || "");
                    const nodeId = String(entry.nodeId || "");
                    if (!Number.isInteger(index) || index < 0 || index >= slots.length || used.has(index)) throw new Error(`槽位无效或重复:${entry.slot}`);
                    used.add(index);
                    const unchanged = slots[index] === nodeId;
                    if (!unchanged && slots[index] !== oldNodeId) throw new Error(`第 ${index + 1} 槽已变化；当前节点:${slots[index]}`);
                    if (unchanged && sources[index] !== nodeId) throw new Error(`第 ${index + 1} 槽来源与成员不一致`);
                    const node = nodes.find((item) => item.id === nodeId);
                    if (!node || String(recordOf(node.metadata).status || "") !== "success") throw new Error(`新分镜节点尚无成功结果:${nodeId}`);
                    const image = activeImageOf(node);
                    if (!image.storageKey.startsWith("image:") || !(image.width > 0 && image.height > 0)) throw new Error(`新分镜缺少活动图片尺寸:${nodeId}`);
                    if (Math.abs(image.width - image.height * targetRatio) > 1) throw new Error(`第 ${index + 1} 槽图片比例不符:${image.width}×${image.height}`);
                    const assetIds = Array.isArray(entry.assetIds) ? [...new Set(entry.assetIds.map(String))] : [];
                    if (!assetIds.length) throw new Error(`第 ${index + 1} 槽未指定参考资产 ID`);
                    for (const assetId of assetIds) {
                        if (usedAssets.has(assetId)) throw new Error(`参考资产在多个槽位重复:${assetId}`);
                        usedAssets.add(assetId);
                        const asset = catalog.find((item) => item.id === assetId);
                        if (!asset || inferReferenceRole(asset) !== "storyboard") throw new Error(`找不到分镜参考资产:${assetId}`);
                        if (unchanged && (asset.storageKey !== image.storageKey || asset.sourceNodeId !== nodeId)) throw new Error(`第 ${index + 1} 槽成员已更新，但资产 ${assetId} 未同步`);
                        if (!unchanged) operations.push({ type: "upsert_reference_asset", asset: { ...asset, ...(entry.label ? { label: String(entry.label) } : {}), storageKey: image.storageKey, url: `/media/${encodeURIComponent(image.storageKey)}`, sourceNodeId: nodeId, updatedAt: new Date().toISOString() } });
                    }
                    slots[index] = nodeId;
                    sources[index] = nodeId;
                    changed.push({ slot: index + 1, oldNodeId, nodeId, storageKey: image.storageKey, width: image.width, height: image.height, assetIds, unchanged });
                }
                if (new Set(slots).size !== slots.length) throw new Error("分镜组成员不能重复");
                if (!operations.length) return { ok: true, unchanged: true, projectId, groupId, revision: project.revision, slots: changed };
                operations.unshift({ type: "update_node", id: groupId, metadata: { groupSlots: slots, sourceGroupSlots: sources } });
                const result = await context.backend.applyCanvasOperations(projectId, operations, Number(project.revision || 0));
                return { ok: true, projectId, groupId, revision: result.revision, slots: changed };
            },
            h3_bind_existing_character_groups: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                const segmentId = String(input.segmentId || "");
                const { project, node } = await getProjectNode(context, projectId, nodeId);
                const projectNodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
                if (!isH3Node(node)) throw new Error(`节点 ${nodeId} 不是 MiniMax H3 节点`);
                const segment = segmentsOf(node).find((item) => String(item.id || "") === segmentId);
                if (!segment) throw new Error(`找不到片段:${segmentId}`);
                const rawCharacters = Array.isArray(input.characters) ? input.characters as Array<Record<string, unknown>> : [];
                const removeGroupIds = Array.isArray(input.removeGroupIds) ? input.removeGroupIds.map(String) : [];
                const characterCandidate = buildCharacterCandidate(projectNodes, segment, rawCharacters, removeGroupIds);
                const { built, requestedNodeIds, nextGroups, nextBindings, removedGroupIds } = characterCandidate;
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
                const refreshedProject = result.project;
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
                    removedGroupIds: [...removedGroupIds],
                    bindingCount: refreshedCompilation.references.filter((reference) => reference.groupId).length,
                    connectionCount: refreshedConnections.filter((connection) => requestedNodeIds.has(String(connection.fromNodeId || "")) && String(connection.toNodeId || "") === nodeId).length,
                };
            },
            h3_prepare_clip: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                const segmentId = String(input.segmentId || "");
                const { project, node } = await getProjectNode(context, projectId, nodeId);
                const projectNodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
                if (!isH3Node(node)) throw new Error(`节点 ${nodeId} 不是 MiniMax H3 节点`);
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
                const refreshedProject = result.project;
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
                const { project, node } = await getProjectNode(context, projectId, nodeId);
                const segment = segmentsOf(node).find((item) => String(item.id || "") === segmentId);
                if (!segment) throw new Error(`找不到片段:${segmentId}`);
                const validation = compileReferenceSubmission(project, segment);
                return { ok: validation.issues.every((issue) => issue.severity !== "error"), projectId, nodeId, segmentId, validation, snapshot: buildH3ClipSnapshot(segment, validation) };
            },
            h3_apply_video_plan: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                if (input.language !== undefined && String(input.language) !== "zh-CN") throw new Error("H3 视频计划当前只接受 language=zh-CN");
                const beforeSegmentId = String(input.beforeSegmentId || "").trim();
                const afterSegmentId = String(input.afterSegmentId || "").trim();
                if (beforeSegmentId && afterSegmentId) throw new Error("beforeSegmentId 与 afterSegmentId 只能指定一个");
                if (input.replaceSegments !== false && (beforeSegmentId || afterSegmentId)) throw new Error("beforeSegmentId / afterSegmentId 只支持 replaceSegments=false 追加模式");
                const { project, node } = await getProjectNode(context, projectId, nodeId);
                const rawSegments = Array.isArray(input.segments) ? input.segments as H3PlannedSegment[] : [];
                if (rawSegments.some((item) => Object.prototype.hasOwnProperty.call(item, "h3CharacterGroups") || Object.prototype.hasOwnProperty.call(item, "characterGroups"))) throw new Error("角色组必须通过 h3_bind_existing_character_groups 写入");
                validateVideoPlan(rawSegments);
                const existing = segmentsOf(node);
                // 计划只描述剧情字段；节点上的生成参数（模型/LoRA/采样等）必须继承下来，
                // 否则前端 H3Runner 会按 segment 缺省值静默回退到错误模型。
                const inherited = inheritedH3Params(node);
                const next = rawSegments.map((item) => {
                    const normalized = normalizePlannedSegment(item) as Record<string, unknown>;
                    const carriesReferences = Object.prototype.hasOwnProperty.call(item, "references");
                    if (!carriesReferences) {
                        delete normalized.refs;
                        delete normalized.refItems;
                        delete normalized.referenceBindings;
                    }
                    const previous = existing.find((segment) => String(segment.id || "") === String(normalized.id || ""));
                    const preservedReferences = previous ? Object.fromEntries(["refs", "refItems", "referenceBindings"].filter((key) => normalized[key] === undefined && previous[key] !== undefined).map((key) => [key, previous[key]])) : {};
                    return { ...inherited, ...preservedReferences, ...normalized };
                });
                const operations: Record<string, unknown>[] = input.replaceSegments === false
                    ? next.map((segment, index) => {
                        if (!segment.id) throw new Error("append 路径要求新段携带 id（add_h3_segment 必填）");
                        const insertAfterPrevious = index > 0 && (beforeSegmentId || afterSegmentId);
                        return {
                            type: "add_h3_segment",
                            nodeId,
                            segment,
                            ...(index === 0 && beforeSegmentId ? { beforeSegmentId } : {}),
                            ...(index === 0 && afterSegmentId ? { afterSegmentId } : {}),
                            ...(insertAfterPrevious ? { afterSegmentId: String(next[index - 1].id) } : {}),
                        };
                    })
                    : [{ type: "replace_h3_segments", nodeId, segments: next }];
                const result = await context.backend.applyCanvasOperations(projectId, operations, Number(project.revision || 0));
                const updatedNode = (result.project.nodes as Array<Record<string, unknown>>).find((item) => String(item.id || "") === nodeId) as AgentCanvasNode | undefined;
                const updatedSegments = updatedNode ? segmentsOf(updatedNode) : [];
                const segmentIds = next.map((segment) => String(segment.id || ""));
                const positions = segmentIds.map((segmentId) => ({ segmentId, index: updatedSegments.findIndex((segment) => String(segment.id || "") === segmentId) }));
                if (positions.some((item) => item.index < 0)) throw new Error("视频计划写入后读取片段顺序失败");
                return { ok: true, projectId, nodeId, count: next.length, segmentIds, positions };
            },
            h3_write_storyboard_prompt: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                const segmentId = String(input.segmentId || "");
                const { project, node } = await getProjectNode(context, projectId, nodeId);
                if (!isH3Node(node)) throw new Error(`节点 ${nodeId} 不是 MiniMax H3 节点`);
                const segment = segmentsOf(node).find((item) => String(item.id || "") === segmentId);
                if (!segment) throw new Error(`找不到片段:${segmentId}`);
                const promptStarted = Date.now();
                const generated = writeStoryboardPrompt(project, segment, input);
                const promptBuildMs = Date.now() - promptStarted;
                if (generated.unchanged) return { ok: true, unchanged: true, projectId, nodeId, segmentId, fingerprint: generated.fingerprint, subjectCount: generated.subjectCount, shotCount: generated.shotCount, promptLength: String(segment.prompt || "").length, timings: { promptBuildMs, applyMs: 0 } };
                const applyStarted = Date.now();
                const result = await context.backend.applyCanvasOperations(projectId, [{ type: "update_h3_segment", nodeId, segmentId, patch: {
                    prompt: generated.prompt,
                    ...(generated.referenceBindings ? { referenceBindings: generated.referenceBindings } : {}),
                    ...(generated.storyboardShots ? { storyboardShots: generated.storyboardShots } : {}),
                    ...(generated.cache ? { storyboardPromptCache: generated.cache } : {}),
                    ...(Object.keys(generated.storyboardDurations).length ? { storyboardDurations: generated.storyboardDurations } : {}),
                }}], Number(project.revision || 0));
                const refreshed = (result.project.nodes as Array<Record<string, unknown>>).find((item) => String(item.id || "") === nodeId) as AgentCanvasNode | undefined;
                const updated = refreshed && segmentsOf(refreshed).find((item) => String(item.id || "") === segmentId);
                if (!updated) throw new Error(`分镜提示词写入后读取失败:${segmentId}`);
                return { ok: true, unchanged: false, projectId, nodeId, segmentId, fingerprint: generated.fingerprint, subjectCount: generated.subjectCount, shotCount: generated.shotCount, promptLength: generated.prompt.length, timings: { promptBuildMs, applyMs: Date.now() - applyStarted } };
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
                const { projectId, nodeId, segmentId, segment, timings, snapshot } = await readH3Clip(context, input);
                const include = new Set(Array.isArray(input.include) ? input.include.map(String) : []);
                const issueCounts = snapshot.issues.reduce<Record<string, number>>((counts, issue) => {
                    const severity = String(issue.severity || "unknown");
                    counts[severity] = (counts[severity] || 0) + 1;
                    return counts;
                }, {});
                return {
                    ok: true,
                    projectId,
                    nodeId,
                    segmentId,
                    segment: {
                        ...snapshot.segment,
                        status: String(segment.status || "idle"),
                        progress: Number(segment.progress || 0),
                        runtimeTaskId: segment.runtimeTaskId,
                        resultStorageKey: segment.resultStorageKey,
                        hasResult: Boolean(segment.result || segment.resultStorageKey),
                    },
                    prompt: { semanticLength: snapshot.prompt.semantic.length, compiledLength: snapshot.prompt.compiled.length },
                    runtimeFieldCount: Object.keys(snapshot.runtime).length,
                    referenceCount: snapshot.references.length,
                    characterGroupCount: snapshot.characterGroups.length,
                    issueCounts,
                    timings,
                    ...(include.has("prompt") ? { prompt: snapshot.prompt } : {}),
                    ...(include.has("references") ? { references: snapshot.references, characterGroups: snapshot.characterGroups } : {}),
                    ...(include.has("runtime") ? { runtime: snapshot.runtime } : {}),
                };
            },
            h3_get_clip_prompt: async (input) => {
                const { projectId, nodeId, segmentId, timings, snapshot } = await readH3Clip(context, input);
                return { ok: true, projectId, nodeId, segmentId, prompt: snapshot.prompt, timings };
            },
            h3_get_clip_references: async (input) => {
                const { projectId, nodeId, segmentId, timings, snapshot } = await readH3Clip(context, input);
                return { ok: true, projectId, nodeId, segmentId, references: snapshot.references, characterGroups: snapshot.characterGroups, issues: snapshot.issues, timings };
            },
            h3_get_clip_runtime: async (input) => {
                const { projectId, nodeId, segmentId, timings, snapshot } = await readH3Clip(context, input);
                return { ok: true, projectId, nodeId, segmentId, runtime: snapshot.runtime, timings };
            },
            h3_get_node: async (input) => {
                const nodeId = String(input.nodeId || "");
                const { node } = await getProjectNode(context, String(input.projectId || ""), nodeId);
                if (!node) throw new Error(`找不到画布节点:${String(input.nodeId || "")}`);
                if (!isH3Node(node)) throw new Error(`节点 ${nodeId} 不是 MiniMax H3 节点`);
                return h3NodeSummary(node);
            },
            h3_run_clip: async (input) => {
                const nodeId = String(input.nodeId || "");
                const projectId = String(input.projectId || "");
                const { node } = await getProjectNode(context, projectId, nodeId);
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
                return summarizeRuntimeTask(result.task);
            },
            h3_get_task: async (input) => {
                const taskId = String(input.taskId || "");
                const { task } = await context.backend.getTask(taskId);
                return summarizeRuntimeTask(task);
            },
            h3_cancel_task: async (input) => {
                const taskId = String(input.taskId || "");
                return summarizeRuntimeTask(await context.backend.cancelTask(taskId));
            },
            h3_update_clip: async (input) => {
                const nodeId = String(input.nodeId || "");
                const projectId = String(input.projectId || "");
                const { project, node } = await getProjectNode(context, projectId, nodeId);
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
                if (Object.prototype.hasOwnProperty.call(patch, "referenceBindings")) assertReferenceCompilation(compileReferenceSubmission(project, { ...target, ...patch }));
                const operations: Record<string, unknown>[] = [{ type: "update_h3_segment", nodeId, segmentId: String(target.id), patch }];
                const projection = nodeProjection(patch);
                if (Object.keys(projection).length) operations.push({ type: "update_node", id: nodeId, metadata: projection });
                const result = await context.backend.applyCanvasOperations(projectId, operations, Number(project.revision || 0));
                const refreshed = (result.project.nodes as Array<Record<string, unknown>>).find((item) => String(item.id || "") === nodeId) as AgentCanvasNode | undefined;
                const refreshedSegment = refreshed && segmentsOf(refreshed).find((segment) => String(segment.id || "") === segmentId);
                if (!refreshedSegment) throw new Error(`片段更新后读取失败:${segmentId}`);
                return { ok: true, projectId: String(input.projectId || ""), nodeId, segmentIndex: index, segmentId, updatedFields: Object.keys(patch) };
            },
            h3_move_clip: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                const segmentId = String(input.segmentId || "");
                const beforeSegmentId = typeof input.beforeSegmentId === "string" ? input.beforeSegmentId : "";
                const afterSegmentId = typeof input.afterSegmentId === "string" ? input.afterSegmentId : "";
                if (!segmentId) throw new Error("segmentId 必填");
                if (beforeSegmentId && afterSegmentId) throw new Error("beforeSegmentId 和 afterSegmentId 只能提供一个");
                const { project, node } = await getProjectNode(context, projectId, nodeId);
                if (!isH3Node(node as AgentCanvasNode)) throw new Error(`节点 ${nodeId} 不是 MiniMax H3 节点`);
                const segments = segmentsOf(node as AgentCanvasNode);
                const fromIndex = segments.findIndex((segment) => String(segment.id || "") === segmentId);
                if (fromIndex < 0) throw new Error(`找不到片段:${segmentId}`);
                const result = await context.backend.applyCanvasOperations(projectId, [{
                    type: "move_h3_segment", nodeId, segmentId,
                    ...(beforeSegmentId ? { beforeSegmentId } : {}),
                    ...(afterSegmentId ? { afterSegmentId } : {}),
                }], Number(project.revision || 0));
                const refreshed = (result.project.nodes as Array<Record<string, unknown>> | undefined)?.find((item) => String(item.id || "") === nodeId);
                const refreshedSegments = refreshed ? segmentsOf(refreshed as AgentCanvasNode) : [];
                const toIndex = refreshedSegments.findIndex((segment) => String(segment.id || "") === segmentId);
                if (toIndex < 0) throw new Error(`片段移动后读取失败:${segmentId}`);
                return { ok: true, projectId, nodeId, segmentId, fromIndex, toIndex, skipped: fromIndex === toIndex, revision: result.revision };
            },
            h3_delete_clip: async (input) => {
                const projectId = String(input.projectId || "");
                const nodeId = String(input.nodeId || "");
                const segmentId = String(input.segmentId || "");
                const { project, node } = await getProjectNode(context, projectId, nodeId);
                if (!isH3Node(node as AgentCanvasNode)) throw new Error(`节点 ${nodeId} 不是 MiniMax H3 节点`);
                if (!segmentsOf(node as AgentCanvasNode).some((segment) => String(segment.id || "") === segmentId)) {
                    return { ok: true, projectId, nodeId, segmentId, skipped: true, reason: "Clip 已不存在" };
                }
                const result = await context.backend.applyCanvasOperations(projectId, [{ type: "delete_h3_segment", nodeId, segmentId }], Number(project.revision || 0));
                return { ok: true, projectId, nodeId, segmentId, revision: result.revision };
            },
            h3_run_all_clips: async (input) => {
                const projectId = String(input.projectId || "");
                const override = (input.params as Record<string, unknown>) || {};
                const onlyIds = Array.isArray(input.nodeIds) ? (input.nodeIds as string[]).map(String) : null;
                const project = await context.getCanvasProject(projectId);
                if (!project) throw new Error(`画布不存在:${projectId}`);
                const nodes = (Array.isArray(project.nodes) ? project.nodes as AgentCanvasNode[] : []).filter((node) => isH3Node(node) && (!onlyIds || onlyIds.includes(node.id)));
                const result = await context.backend.canvasRunGeneration({ mode: "video", operation: "h3-run", projectId, nodeIds: nodes.map((node) => node.id), runFromCurrent: true, skipCompleted: true, params: override });
                if (!result.task) throw new Error("Backend H3 批量运行未返回任务");
                return summarizeRuntimeTask(result.task);
            },
        };
    },
};
