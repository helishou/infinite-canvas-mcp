import crypto from "node:crypto";
import { styleTemplateFromPrompt, styleTemplateText } from "@basketikun/canvas-agent/plugins/minimax-h3/style-templates";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonical(value: unknown): Json {
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value) as unknown as Json;
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined && typeof item !== "function")
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]));
    }
    return String(value);
}

export function stableH3Fingerprint(value: unknown): string {
    return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function h3ClipDependsOnPrevious(segment: Record<string, unknown>, params: Record<string, unknown> = {}) {
    return segment.motionContextEnabled === true || params.motionContextEnabled === true
        || segment.previousVideoAsReference === true || params.previousVideoAsReference === true
        || segment.tailFrameContinuation === true || params.tailFrameContinuation === true
        || segment.previousTailFrameContinuation === true;
}

export function h3ClipCacheFingerprint(input: {
    segment: Record<string, unknown>;
    params: Record<string, unknown>;
    references: unknown[];
    compiledPrompt: string;
    previousFingerprint?: string;
}) {
    const { segment, params, references, compiledPrompt, previousFingerprint } = input;
    const dependency = h3ClipDependsOnPrevious(segment, params) ? String(previousFingerprint || "missing") : "independent";
    const segmentInputs = Object.fromEntries([
        "confirmationMode", "latentUpscaleConfirmationMode", "motionContextEnabled", "previousVideoAsReference", "tailFrameContinuation",
        "previousTailFrameContinuation", "storyboardCompositeEnabled", "storyboardDurations", "storyboardShots", "styleTemplateId",
    ].filter((key) => segment[key] !== undefined).map((key) => [key, segment[key]]));
    const fingerprintParams = Object.fromEntries(Object.entries(params).filter(([key]) => !["confirmSecondPass", "postGenerationOnly"].includes(key)));
    // 同一模板 ID 的正文修订也会改变生成输入，不能复用旧风格的成片。
    const styleTemplateId = segment.styleTemplateId === undefined
        ? styleTemplateFromPrompt(compiledPrompt, String(params.mode || params.taskMode || "ref2va"))
        : segment.styleTemplateId;
    const styleTemplate = styleTemplateText(styleTemplateId as string | null) || undefined;
    // Older tail-frame runs replaced opening keyframes/storyboards. The appended
    // reference semantics and authoritative opening state require a new fingerprint.
    return stableH3Fingerprint({ version: segment.previousTailFrameContinuation === true ? 5 : 2, segment: segmentInputs, params: fingerprintParams, references, compiledPrompt, dependency, styleTemplate });
}

/** 仅用于恢复升级前已暂停的一采任务；新任务一律使用 v2 实际输入指纹。 */
export function h3ClipCacheFingerprintV1(input: {
    segment: Record<string, unknown>; params: Record<string, unknown>; references: unknown[]; compiledPrompt: string; previousFingerprint?: string;
}) {
    const { segment, params, references, compiledPrompt, previousFingerprint } = input;
    const dependency = h3ClipDependsOnPrevious(segment, params) ? String(previousFingerprint || "missing") : "independent";
    const segmentInputs = Object.fromEntries(Object.entries(segment).filter(([key]) => ![
        "result", "resultStorageKey", "results", "status", "progress", "runtimeTaskId", "errorDetails",
        "cacheFingerprint", "firstPassFingerprint", "firstPassReady", "firstPassResult", "firstPassStorageKey",
    ].includes(key)));
    const fingerprintParams = Object.fromEntries(Object.entries(params).filter(([key]) => !["confirmSecondPass", "postGenerationOnly"].includes(key)));
    return stableH3Fingerprint({ version: 1, segment: segmentInputs, params: fingerprintParams, references, compiledPrompt, dependency });
}

export function h3ConfirmationKind(segment: Record<string, unknown>, params: Record<string, unknown>): "latent" | "face" | null {
    if (params.latentUpscaleEnabled === true) return (params.latentUpscaleConfirmationMode ?? segment.latentUpscaleConfirmationMode) === true ? "latent" : null;
    return params.faceRefineEnabled === true && (params.confirmationMode ?? segment.confirmationMode) === true ? "face" : null;
}

export function h3ConfirmationPhaseParams(segment: Record<string, unknown>, params: Record<string, unknown>, confirming = false): Record<string, unknown> {
    const kind = h3ConfirmationKind(segment, params);
    if (!kind) {
        if (confirming) throw new Error("确认模式与当前生成功能不匹配，请保留一采或重新生成");
        const ordinary = { ...params };
        for (const key of ["confirmSecondPass", "postGenerationOnly", "latentConfirmationPhase", "latentCheckpointId"]) delete ordinary[key];
        return ordinary;
    }
    if (kind === "latent") {
        return {
            ...params, confirmSecondPass: confirming, postGenerationOnly: false,
            latentConfirmationPhase: confirming ? "second" : "first",
            ...(!confirming ? { rtxEnabled: false, faceRefineEnabled: false, dlssUpscaleMode: "关闭", dlssFrameInterpolationEnabled: false } : {}),
        };
    }
    if (confirming) return { ...params, postGenerationOnly: true, confirmSecondPass: true, motionContextEnabled: false };
    return {
        ...params,
        latentUpscaleEnabled: false,
        rtxEnabled: false,
        faceRefineEnabled: false,
        dlssUpscaleMode: "关闭",
        dlssFrameInterpolationEnabled: false,
    };
}

// Postpass-only settings do not invalidate the phase-A cache. Native latent
// continuation additionally freezes both step counts and the split schedule.
const CONFIRMATION_POSTPASS_KEYS = [
    "faceRefineEnabled", "latentUpscaleEnabled", "rtxEnabled", "dlssUpscaleMode", "dlssFrameInterpolationEnabled",
    "faceRefineDetector", "faceRefineConfidence", "faceRefineCropFactor", "faceRefineCanvasSize", "faceRefineDenoise",
    "faceRefineSteps", "faceRefineSampler", "faceRefineScheduler", "faceRefinePasteRegion", "faceRefineMaskDilation",
    "faceRefineFeather", "faceRefineColourMatch", "faceRefineBlend", "seamFaceFadeFrames", "seamColourMatch", "seamAudioCrossfadeMs",
    "h3FirstSteps", "h3SecondSteps", "latentUpscaleModel", "latentUpscaleMegapixels", "latentUpscaleAlign", "latentUpscalePrecision",
    "rtxResizeMode", "rtxScale", "rtxWidth", "rtxHeight", "rtxQuality",
    "dlssVideoUpscaleMode", "dlssVideoRequireNeuralUpscaling", "dlssVideoNrPreset", "dlssVideoNrStyle", "dlssVideoNrIntensity",
    "dlssVideoLocalToneStrength", "dlssVideoLocalStructureStrength", "dlssVideoSkinStructureStrength", "dlssVideoAutomaticMask",
    "dlssVideoModelPreset", "dlssVideoEncodingQuality", "dlssVideoCodec", "dlssVideoContainer", "dlssVideoRename",
    "dlssVideoCustomSuffix", "dlssVideoHdrMode", "dlssVideoOutputDetailStrength", "dlssFgOutputFps", "dlssFgEngine",
    "dlssFgEncodingQuality", "dlssFgVideoCodec", "dlssFgContainer", "dlssFgRename", "dlssFgCustomSuffix", "dlssFgHdrMode",
] as const;

export function pickH3PostpassParams(value: Record<string, unknown>, latentConfirmation = false) {
    return Object.fromEntries(CONFIRMATION_POSTPASS_KEYS.filter((key) => value[key] !== undefined && key !== "latentUpscaleEnabled"
        && !(latentConfirmation && ["h3FirstSteps", "h3SecondSteps"].includes(key))).map((key) => [key, value[key]]));
}

export function h3ConfirmationFingerprintParams(segment: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
    const normalized = h3ConfirmationPhaseParams(segment, params, false);
    delete normalized.confirmSecondPass;
    delete normalized.postGenerationOnly;
    delete normalized.latentConfirmationPhase;
    delete normalized.latentCheckpointId;
    if (!h3ConfirmationKind(segment, params)) return normalized;
    for (const key of CONFIRMATION_POSTPASS_KEYS) {
        if (params.latentUpscaleEnabled === true && ["latentUpscaleEnabled", "h3FirstSteps", "h3SecondSteps"].includes(key)) continue;
        delete normalized[key];
    }
    return normalized;
}

export function planH3CacheReuse(rows: Array<{
    segment: Record<string, unknown>;
    fingerprint: string;
}>) {
    return rows.map(({ segment, fingerprint }) => ({
        fingerprint,
        reusable: Boolean(segment.result) && segment.cacheFingerprint === fingerprint,
    }));
}
