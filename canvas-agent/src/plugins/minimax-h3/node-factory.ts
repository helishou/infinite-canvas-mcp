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
    latentUpscalePrecision: "bf16", seed: 0, noiseSeed: 0, noiseSeedMode: "random", constantTriggerWord: "",
    noDub: true, noCaption: true, audioMode: "native", audioDenoiseStrength: 1, addSourceAsReference: false,
    strictPromptTags: true, referenceVideoPolicy: "official_2_to_15s", latentUpscaleEnabled: false,
    slaEnabled: false, uniBlockSwapEnabled: false, rtxEnabled: false, teAccel: false, lockAudio: false, audioDrive: false,
    combatLoraWeight: 0, cinematicLoraWeight: 0, runtimeReserveEnabled: false, reservedVramGb: 0.6,
    loraSlots: [{ name: "", strength: 1, enabled: false }],
};

const NODE_LEVEL_KEYS = [
    "aspectRatio", "videoSteps", "denoise", "modelName", "minimaxBaseModel",
    "motionContextEnabled", "motionContextNoiseEnabled", "smartStoryboardCount", "smartStoryboardMode", "smartStoryboardSkill",
];

/** 按“节点显式值 > 保存默认值 > 基础默认值”创建完整 H3 metadata。 */
export function createH3NodeMetadata(stored: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}, panes: Record<string, number> = {}) {
    const storedParams = { ...stored };
    delete storedParams.layout;
    const nodeLevel = Object.fromEntries(NODE_LEVEL_KEYS.filter((key) => key in storedParams).map((key) => [key, storedParams[key]]));
    const existingSegments = Array.isArray(metadata.segments) ? metadata.segments as Array<Record<string, unknown>> : [];
    const existing = existingSegments[0] || {};
    const initialSegment = {
        ...BASE_H3_NODE_METADATA,
        ...storedParams,
        ...panes,
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
        ...panes,
        ...storedParams,
        ...metadata,
        segments: [initialSegment],
    };
}
