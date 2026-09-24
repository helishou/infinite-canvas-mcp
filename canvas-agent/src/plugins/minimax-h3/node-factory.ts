const defaultPrompt = "保持原视频的动作、镜头和环境，替换主体角色，动作连贯，人物外观稳定。";
const defaultH3Model = "h3\\DasiwaMinimaxH3_dasiwaREF2VAHybridV1.safetensors";

/** H3 节点的单一基础默认值来源；前端节点定义与 MCP 创建节点共用。 */
export const BASE_H3_NODE_METADATA: Record<string, unknown> = {
    content: "", prompt: defaultPrompt, status: "idle", duration: "8", aspectRatio: "16:9",
    videoSteps: 8, denoise: 1, modelName: defaultH3Model, minimaxBaseModel: defaultH3Model,
    motionContextEnabled: true, motionContextNoiseEnabled: false,
    // 上一段成品作为参考视频注入下一段：默认关闭，必须由用户在 Clip 卡上显式开启。
    previousVideoAsReference: false,
    smartStoryboardCount: 3, smartStoryboardMode: "ref2va", smartStoryboardSkill: "regular_storyboard",
    textEncoder: "qwen3vl_32b_minimax_h3_fp8.safetensors",
    videoVae: "minimax_h3_video_vae_fp16.safetensors",
    audioVae: "minimax_h3_audio_vae_fp32.safetensors",
    textEncoderType: "minimax", textEncoderDevice: "default", precision: "default",
    sageAttention: "H3专用Sage加速", megapixels: 0.4, sizeMultiple: 32, refImageSize: "match", referenceLongEdge: 1920,
    sampler: "res_multistep", scheduler: "simple", allowCompile: false,
    slaBlockSize: "64", slaBackend: "comfy_kitchen", slaSparsity: 0.9, slaMinSequence: 4096, slaDenseLastSteps: 1,
    slaProtectAudio: true, slaDisableFp16Accum: true, slaStabilizeMotion: true,
    rtxResizeMode: "倍数缩放", rtxQuality: "ULTRA", realtimePreviewEnabled: true,
    realtimePreviewLongEdge: 512, realtimePreviewFrames: 12, realtimePreviewFps: 8, realtimePreviewJpegQuality: 75,
    uniBlockSwapBlocks: 1, h3FirstSteps: 6, h3SecondSteps: 4, latentUpscaleMegapixels: 1, latentUpscaleAlign: 2,
    // Random mode owns the effective seed at submit time; zero is only a
    // legacy placeholder and must not be shown as the value being submitted.
    latentUpscalePrecision: "bf16", seed: undefined, noiseSeed: undefined, noiseSeedMode: "random", constantTriggerWord: "",
    noDub: true, noCaption: true, audioMode: "native", audioDenoiseStrength: 1, addSourceAsReference: false,
    strictPromptTags: true, referenceVideoPolicy: "official_2_to_15s", latentUpscaleEnabled: false,
    slaEnabled: false, uniBlockSwapEnabled: false, rtxEnabled: false, teAccel: false, lockAudio: false, audioDrive: false,
    combatLoraWeight: 0, cinematicLoraWeight: 0, runtimeReserveEnabled: false, reservedVramGb: 0.6, faceRefineEnabled: false,
    loraSlots: [{ name: "", strength: 1, enabled: false }], keepModelCache: true,
};

const NODE_LEVEL_KEYS = [
    "aspectRatio", "videoSteps", "denoise", "modelName", "minimaxBaseModel",
    "motionContextEnabled", "motionContextNoiseEnabled", "smartStoryboardCount", "smartStoryboardMode", "smartStoryboardSkill",
];

/** H3 工作台各模块区域的布局键：与画布手柄拖拽写入的 metadata minimax* 键一一对应。 */
export const H3_LAYOUT_PANE_KEYS = ["minimaxPreviewH", "minimaxPreviewW", "minimaxPromptW", "minimaxTimelineH", "minimaxRefLaneH"] as const;

/** H3 节点类型（含历史别名和插件名形式）。 */
export function isH3NodeType(type: unknown): boolean {
    return /^(?:minimax|smart-minimax)/i.test(String(type || ""));
}

export type H3LayoutSnapshot = { width?: number; height?: number; panes: Record<string, number> };

const positiveInt = (value: unknown) => {
    const parsed = Math.round(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

/** 解析「设为默认参数」保存的布局快照；非有限正数一律丢弃，避免脏值污染新建节点。 */
export function readH3Layout(source: unknown): H3LayoutSnapshot {
    const record = source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, unknown> : {};
    const rawPanes = record.panes && typeof record.panes === "object" && !Array.isArray(record.panes) ? record.panes as Record<string, unknown> : {};
    const panes: Record<string, number> = {};
    for (const key of H3_LAYOUT_PANE_KEYS) {
        const value = positiveInt(rawPanes[key]);
        if (value !== undefined) panes[key] = value;
    }
    const width = positiveInt(record.width);
    const height = positiveInt(record.height);
    return { ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }), panes };
}

/** 按“节点显式值 > 保存默认值 > 基础默认值”创建完整 H3 metadata。 */
export function createH3NodeMetadata(stored: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}, panes: Record<string, number> = {}) {
    const storedParams = { ...stored };
    // layout 是随默认参数一起保存的布局快照：只有各模块区域宽高进节点 metadata，
    // 节点自身宽高由创建入口消费（前端 defaultLayoutSize / MCP width/height），不留在 metadata 里。
    const layout = readH3Layout(storedParams.layout);
    delete storedParams.layout;
    const nodePanes = { ...layout.panes, ...panes };
    const nodeLevel = Object.fromEntries(NODE_LEVEL_KEYS.filter((key) => key in storedParams).map((key) => [key, storedParams[key]]));
    const existingSegments = Array.isArray(metadata.segments) ? metadata.segments as Array<Record<string, unknown>> : [];
    const existing = existingSegments[0] || {};
    const initialSegment = {
        ...BASE_H3_NODE_METADATA,
        ...storedParams,
        ...nodePanes,
        ...existing,
        id: String(existing.id || "segment-1"),
        prompt: existing.prompt ?? metadata.prompt ?? defaultPrompt,
        duration: existing.duration ?? BASE_H3_NODE_METADATA.duration,
        taskMode: existing.taskMode ?? "ref2va",
        status: existing.status ?? "idle",
    };
    return {
        ...BASE_H3_NODE_METADATA,
        ...nodeLevel,
        ...nodePanes,
        ...storedParams,
        ...metadata,
        segments: [initialSegment],
    };
}
