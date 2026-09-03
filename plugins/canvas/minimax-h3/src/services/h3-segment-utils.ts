import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { segmentsFor } from "../hooks/useH3Segments";
import { resultUrl } from "./h3-data";

const RESTORABLE_PARAM_KEYS = ["prompt", "mode", "taskMode", "duration", "aspectRatio", "megapixels", "videoSteps", "steps", "denoise", "noiseSeedMode", "noiseSeed", "seed", "modelName", "textEncoder", "textEncoderType", "textEncoderDevice", "videoVae", "audioVae", "precision", "sageAttention", "allowCompile", "sizeMultiple", "sampler", "scheduler", "loraSlots", "constantTriggerWord", "lockAudio", "audioDrive", "audioDriveFile", "audioDriveMarkers", "audioDriveSegmentImages", "audioDriveSegmentStoryboards", "audioDriveCreative", "audioDriveExclude", "audioDriveStart", "audioDriveEnd", "solAttnEnabled", "solAttnTau", "solAttnThresholdType", "solAttnExactMode", "solAttnDenseSteps", "solAttnStepOff", "solAttnSinkTokens", "t8Enabled", "t8ResidualThreshold", "t8StartPercent", "t8EndPercent", "t8MaxConsecutiveHits", "t8CacheDevice", "t8MetricStride", "t8Verbose", "sigmaEnabled", "videoSigmaShift", "audioSigmaShift", "sigmaMode", "lowSigmaStart", "lowSigmaEnd", "sigmaRefineSteps", "sigmaCurve", "manualSigma", "dualSampling", "dualSamplingRatio", "dualSampler", "secondPassEnabled", "firstPassSteps", "secondPassSteps", "secondPassMegapixels", "secondPassUpscaleMethod", "secondPassDenoise", "secondPassSampler", "secondPassScheduler", "secondPassModel", "secondPassSigma", "dedicatedAttention", "startupMode", "faceRepairSingle", "faceRepairMulti", "globalRepair", "lowMemoryAttentionHeads", "reservedVramGb", "runtimeReserveEnabled", "uniBlockSwapEnabled", "uniBlockSwapBlocks", "latentUpscaleEnabled", "h3FirstSteps", "h3SecondSteps", "h3FullSigma", "v81ManualSigma", "latentUpscaleModel", "latentUpscaleMegapixels", "latentUpscaleAlign", "latentUpscalePrecision", "realtimePreviewEnabled", "realtimePreviewLongEdge", "realtimePreviewFrames", "realtimePreviewFps", "realtimePreviewJpegQuality", "rtxEnabled", "rtxResizeMode", "rtxScale", "rtxWidth", "rtxHeight", "rtxQuality", "slaEnabled", "slaSparsity", "slaBlockSize", "slaMinSequence", "slaDenseLastSteps", "slaProtectAudio", "slaDenseSteps", "slaBackend", "slaDisableFp16Accum", "slaStabilizeMotion", "refImageSize", "referenceLongEdge"] as const;
export const H3_SETTINGS_KEYS = RESTORABLE_PARAM_KEYS.filter((key) => key !== "prompt");

export function exportH3Settings(segment?: H3Segment) {
    const record = (segment || {}) as Record<string, unknown>;
    return { type: "minimax-h3-settings", version: 1, settings: Object.fromEntries(H3_SETTINGS_KEYS.filter((key) => record[key] !== undefined).map((key) => [key, record[key]])) };
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
    const segments = segmentsFor(metadata);
    const selectedId = String(metadata.selectedSegmentId || segments[0]?.id || "");
    ctx.updateMetadata({ selectedSegmentId: selectedId, segments: segments.map((segment) => segment.id === selectedId ? { ...segment, ...patch } : segment) });
}

export function buildRestoreParamsPatch(segments: H3Segment[], ref: H3Ref): Partial<H3Segment> {
    const source = segments.find((segment) => resultUrl(segment.result) === ref.url || (segment.results || []).some((item) => item.url === ref.url));
    if (!source) return {};
    const record = source as Record<string, unknown>;
    return Object.fromEntries(RESTORABLE_PARAM_KEYS.filter((key) => record[key] !== undefined).map((key) => [key, record[key]])) as Partial<H3Segment>;
}
