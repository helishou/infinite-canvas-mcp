import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { segmentsFor } from "../hooks/useH3Segments";
import { resultUrl } from "./h3-data";

const RESTORABLE_PARAM_KEYS = ["prompt", "mode", "taskMode", "duration", "aspectRatio", "megapixels", "videoSteps", "steps", "denoise", "noiseSeedMode", "noiseSeed", "seed", "modelName", "textEncoder", "textEncoderType", "textEncoderDevice", "videoVae", "audioVae", "precision", "sageAttention", "allowCompile", "sizeMultiple", "sampler", "scheduler", "loraSlots", "constantTriggerWord", "lockAudio", "audioDrive", "audioDriveFile", "audioDriveMarkers", "audioDriveSegmentImages", "audioDriveSegmentStoryboards", "audioDriveCreative", "audioDriveExclude", "audioDriveStart", "audioDriveEnd", "solAttnEnabled", "solAttnTau", "solAttnThresholdType", "solAttnExactMode", "solAttnDenseSteps", "solAttnStepOff", "solAttnSinkTokens", "t8Enabled", "t8ResidualThreshold", "t8StartPercent", "t8EndPercent", "t8MaxConsecutiveHits", "t8CacheDevice", "t8MetricStride", "t8Verbose", "sigmaEnabled", "videoSigmaShift", "audioSigmaShift", "sigmaMode", "lowSigmaStart", "lowSigmaEnd", "sigmaRefineSteps", "sigmaCurve", "manualSigma", "dualSampling", "dualSamplingRatio", "dualSampler", "secondPassEnabled", "firstPassSteps", "secondPassSteps", "secondPassMegapixels", "secondPassUpscaleMethod", "secondPassDenoise", "secondPassSampler", "secondPassScheduler", "secondPassModel", "secondPassSigma", "dedicatedAttention", "startupMode", "faceRepairSingle", "faceRepairMulti", "globalRepair", "lowMemoryAttentionHeads", "reservedVramGb", "runtimeReserveEnabled", "uniBlockSwapEnabled", "uniBlockSwapBlocks", "latentUpscaleEnabled", "h3FirstSteps", "h3SecondSteps", "h3FullSigma", "v81ManualSigma", "latentUpscaleModel", "latentUpscaleMegapixels", "latentUpscaleAlign", "latentUpscalePrecision", "realtimePreviewEnabled", "realtimePreviewLongEdge", "realtimePreviewFrames", "realtimePreviewFps", "realtimePreviewJpegQuality", "rtxEnabled", "rtxResizeMode", "rtxScale", "rtxWidth", "rtxHeight", "rtxQuality", "slaEnabled", "slaSparsity", "slaBlockSize", "slaMinSequence", "slaDenseLastSteps", "slaProtectAudio", "slaDenseSteps", "slaBackend", "slaDisableFp16Accum", "slaStabilizeMotion", "refImageSize", "referenceLongEdge", "loraName", "loraStrength", "teAccel", "noDub", "noCaption", "audioMode", "audioDenoiseStrength", "addSourceAsReference", "promptPrimaryAudioOrdinal", "strictPromptTags", "referenceVideoPolicy", "trimIn", "trimOut", "motionContextEnabled", "tailFrameEnabled", "motionContextNoiseEnabled", "motionContextNoiseAlpha", "motionContextNoiseAlphaEnd", "motionContextNoiseRampFrames", "combatLoraWeight", "cinematicLoraWeight"] as const;
export const H3_SETTINGS_KEYS = RESTORABLE_PARAM_KEYS.filter((key) => key !== "prompt");

export function exportH3Settings(segment?: H3Segment) {
    return { type: "minimax-h3-settings", version: 1, settings: restorableParams(segment as unknown as Record<string, unknown> | undefined, H3_SETTINGS_KEYS) };
}

export function restorableParams<K extends string>(record?: Record<string, unknown> | null, keys: readonly K[] = RESTORABLE_PARAM_KEYS as unknown as readonly K[]): Partial<Pick<H3Segment, K & keyof H3Segment>> {
    if (!record) return {};
    return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]])) as Partial<Pick<H3Segment, K & keyof H3Segment>>;
}

export function importH3Settings(value: unknown): Partial<H3Segment> | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const settings = record.settings;
    if (record.type !== "minimax-h3-settings" || !settings || typeof settings !== "object") return null;
    const source = settings as Record<string, unknown>;
    return Object.fromEntries(H3_SETTINGS_KEYS.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])) as Partial<H3Segment>;
}

export function patchSelectedSegment(ctx: CanvasNodeContext, metadata: Record<string, unknown>, patch: Partial<H3Segment>) {
    const liveMetadata = ctx.getNode?.(ctx.node.id)?.metadata || metadata;
    const segments = segmentsFor(liveMetadata);
    const selectedId = String(liveMetadata.selectedSegmentId || segments[0]?.id || "");
    ctx.updateMetadata({ selectedSegmentId: selectedId, segments: segments.map((segment) => segment.id === selectedId ? { ...segment, ...patch } : segment) });
}

export function buildRestoreParamsPatch(segments: H3Segment[], ref: H3Ref): Partial<H3Segment> {
    // 还原优先级：URL 反查源 Clip（参数始终最新）→ segmentId 反查（URL 变形/改写时兜底）
    // → 材料自带的生成时刻参数快照（源 Clip 已被删除/重建时兜底）。
    // 注意：只恢复生成参数，不恢复 prompt —— 「设为当前 Clip」不应把源视频段的提示词
    // 灌进当前 clip（否则选中 clip4 点 Output 里某段视频，clip4 的提示词会被源段覆盖成
    // 智能分镜第一段之类的内容）。H3_SETTINGS_KEYS 已排除 prompt，这里保持一致。
    const source = segments.find((segment) => resultUrl(segment.result) === ref.url || (segment.results || []).some((item) => item.url === ref.url))
        || (ref.segmentId ? segments.find((segment) => segment.id === ref.segmentId) : undefined);
    if (source) return restorableParams(source as Record<string, unknown>, H3_SETTINGS_KEYS);
    return restorableParams(ref.params, H3_SETTINGS_KEYS);
}
