import { withH3ParameterEdits } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { segmentsFor } from "../hooks/useH3Segments";
import { resultUrl, refsForSegment, segmentRefsPatch, inferH3ReferenceMediaType } from "./h3-data";

const RESTORABLE_PARAM_KEYS = ["prompt", "mode", "taskMode", "duration", "aspectRatio", "megapixels", "videoSteps", "steps", "denoise", "noiseSeedMode", "noiseSeed", "seed", "modelName", "selectedVideoModelEnabled", "selectedVideoModel", "selectedVideoModelFieldValues", "textEncoder", "textEncoderType", "textEncoderDevice", "videoVae", "audioVae", "precision", "sageAttention", "allowCompile", "sizeMultiple", "sampler", "scheduler", "loraSlots", "constantTriggerWord", "lockAudio", "audioDrive", "audioDriveFile", "audioDriveMarkers", "audioDriveSegmentImages", "audioDriveSegmentStoryboards", "audioDriveCreative", "audioDriveExclude", "audioDriveStart", "audioDriveEnd", "solAttnEnabled", "solAttnTau", "solAttnThresholdType", "solAttnExactMode", "solAttnDenseSteps", "solAttnStepOff", "solAttnSinkTokens", "t8Enabled", "t8ResidualThreshold", "t8StartPercent", "t8EndPercent", "t8MaxConsecutiveHits", "t8CacheDevice", "t8MetricStride", "t8Verbose", "sigmaEnabled", "videoSigmaShift", "audioSigmaShift", "sigmaMode", "lowSigmaStart", "lowSigmaEnd", "sigmaRefineSteps", "sigmaCurve", "manualSigma", "dualSampling", "dualSamplingRatio", "dualSampler", "secondPassEnabled", "firstPassSteps", "secondPassSteps", "secondPassMegapixels", "secondPassUpscaleMethod", "secondPassDenoise", "secondPassSampler", "secondPassScheduler", "secondPassModel", "secondPassSigma", "dedicatedAttention", "startupMode", "faceRefineEnabled", "faceRefineDetector", "faceRefineConfidence", "faceRefineCropFactor", "faceRefineCanvasSize", "faceRefineDenoise", "faceRefineSteps", "faceRefineSampler", "faceRefineScheduler", "faceRefinePasteRegion", "faceRefineMaskDilation", "faceRefineFeather", "faceRefineColourMatch", "faceRefineBlend", "confirmationMode", "seamFaceFadeFrames", "seamColourMatch", "seamAudioCrossfadeMs", "lowMemoryAttentionHeads", "reservedVramGb", "runtimeReserveEnabled", "uniBlockSwapEnabled", "uniBlockSwapBlocks", "keepModelCache", "latentUpscaleEnabled", "latentUpscaleConfirmationMode", "h3FirstSteps", "h3SecondSteps", "h3FullSigma", "v81ManualSigma", "latentUpscaleModel", "latentUpscaleMegapixels", "latentUpscaleAlign", "latentUpscalePrecision", "realtimePreviewEnabled", "realtimePreviewLongEdge", "realtimePreviewFrames", "realtimePreviewFps", "realtimePreviewJpegQuality", "rtxEnabled", "rtxResizeMode", "rtxScale", "rtxWidth", "rtxHeight", "rtxQuality", "slaEnabled", "slaSparsity", "slaBlockSize", "slaMinSequence", "slaDenseLastSteps", "slaProtectAudio", "slaDenseSteps", "slaBackend", "slaDisableFp16Accum", "slaStabilizeMotion", "refImageSize", "referenceLongEdge", "loraName", "loraStrength", "teAccel", "noDub", "noCaption", "audioMode", "audioDenoiseStrength", "addSourceAsReference", "promptPrimaryAudioOrdinal", "strictPromptTags", "referenceVideoPolicy", "trimIn", "trimOut", "motionContextEnabled", "tailFrameContinuation", "motionContextNoiseEnabled", "motionContextNoiseAlpha", "motionContextNoiseAlphaEnd", "motionContextNoiseRampFrames", "combatLoraWeight", "cinematicLoraWeight"] as const;
const ALL_RESTORABLE_PARAM_KEYS = [...RESTORABLE_PARAM_KEYS, "styleTemplateId", "minimaxEngine"] as const;
export const H3_SETTINGS_KEYS = ALL_RESTORABLE_PARAM_KEYS.filter((key) => key !== "prompt" && key !== "duration");

export function exportH3Settings(segment?: H3Segment) {
    return { type: "minimax-h3-settings", version: 1, settings: restorableParams(segment as unknown as Record<string, unknown> | undefined, H3_SETTINGS_KEYS) };
}

export function restorableParams<K extends string>(record?: Record<string, unknown> | null, keys: readonly K[] = ALL_RESTORABLE_PARAM_KEYS as unknown as readonly K[]): Partial<Pick<H3Segment, K & keyof H3Segment>> {
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
    ctx.updateMetadata({ selectedSegmentId: selectedId, segments: segments.map((segment) => segment.id === selectedId ? { ...segment, ...withH3ParameterEdits(segment as unknown as Record<string, unknown>, patch) } : segment) });
}

function editableHistoricalReferences(snapshot: Record<string, unknown> | undefined, segments: H3Segment[], targetSegment?: H3Segment): H3Ref[] | undefined {
    const submission = snapshot?.submission && typeof snapshot.submission === "object" ? snapshot.submission as Record<string, unknown> : {};
    const normalize = (value: unknown): H3Ref => {
        const row = value as Record<string, unknown>;
        return { ...row, url: String(row.url || ""), name: String(row.name || row.label || ""), type: inferH3ReferenceMediaType(row),
            bindingId: String(row.bindingId || row.id || "") || undefined, nodeId: String(row.nodeId || row.sourceNodeId || "") || undefined } as H3Ref;
    };
    const isRuntime = (ref: H3Ref) => ref.runtime === true || /^runtime-(?:tail|previous-video)-/.test(ref.bindingId || "");
    if (Array.isArray(submission.editableReferences)) return submission.editableReferences.map(normalize).filter((ref) => !isRuntime(ref));
    const raw = Array.isArray(snapshot?.refs) ? snapshot.refs : Array.isArray(snapshot?.refItems) ? snapshot.refItems : undefined;
    if (!raw) return undefined;
    const references = raw.map(normalize);
    if (!references.some(isRuntime)) return references;
    // Older logs contain actual inputs, including inserted/replaced runtime images.
    // Restore only the declared binding manifest; never turn temporary inputs into edits.
    if (!Array.isArray(submission.bindingMap) || !(typeof submission.authoredPrompt === "string" || typeof submission.semanticPrompt === "string")) throw new Error("历史记录缺少可编辑输入快照，不能安全还原包含运行时参考的参数");
    const originals = references.filter((ref) => !isRuntime(ref));
    const known = [...(targetSegment ? refsForSegment(targetSegment) : []), ...segments.flatMap(refsForSegment)];
    return (submission.bindingMap as Array<Record<string, unknown>>).map((binding) => {
        const id = String(binding.id || "");
        const original = originals.find((ref) => ref.bindingId === id)
            || (binding.assetId ? known.find((ref) => ref.assetId === binding.assetId && !isRuntime(ref)) : undefined);
        if (!original) throw new Error("历史运行时参考替换的原始素材不可用，无法安全还原参考；当前配置已保留");
        return { ...original, bindingId: id, name: String(binding.label || original.name), role: binding.role || original.role, usage: binding.usage || original.usage } as H3Ref;
    });
}

export function buildRestoreParamsPatch(segments: H3Segment[], ref: H3Ref, targetSegment?: H3Segment): Partial<H3Segment> {
    // 还原优先级：URL 反查源 Clip（参数始终最新）→ segmentId 反查（URL 变形/改写时兜底）
    // → 材料自带的生成时刻参数快照（源 Clip 已被删除/重建时兜底）。
    // 「设为当前 Clip」会一并还原 prompt（源段提示词带入当前 clip），
    // 因为提示词区已支持按 clip 隔离的撤销/重做，误覆盖可用 Ctrl+Z 回退。
    // 注意：H3_SETTINGS_KEYS（复制/粘贴设置）仍排除 prompt，仅本函数使用含 prompt 的完整列表。
    const snapshot = ref.params && typeof ref.params === "object" ? ref.params : undefined;
    // 带 generationLogId 的素材来自独立历史日志，必须使用生成时刻快照；不能拿源 Clip 的当前参数覆盖历史。
    const source = ref.generationLogId ? undefined : segments.find((segment) => resultUrl(segment.result) === ref.url || (segment.results || []).some((item) => resultUrl(item.url) === ref.url || (ref.storageKey && item.storageKey === ref.storageKey)))
        || (ref.segmentId ? segments.find((segment) => segment.id === ref.segmentId) : undefined);
    const submission = snapshot?.submission && typeof snapshot.submission === "object" ? snapshot.submission as Record<string, unknown> : {};
    const snapshotRefs = source ? undefined : editableHistoricalReferences(snapshot, segments, targetSegment);
    const base = source ? restorableParams(source as Record<string, unknown>, ALL_RESTORABLE_PARAM_KEYS) : restorableParams(snapshot, ALL_RESTORABLE_PARAM_KEYS);
    const requestedMode = (submission.continuation as Record<string, unknown> | undefined)?.requestedMode;
    if (!source && ["t2v", "i2v", "fl2v", "ref2va"].includes(String(requestedMode))) {
        base.mode = requestedMode as H3Segment["mode"];
        base.taskMode = requestedMode as H3Segment["taskMode"];
    }
    const rawRefsPatch = source ? segmentRefsPatch(refsForSegment(source), source) : snapshotRefs ? segmentRefsPatch(snapshotRefs) : {};
    const refsPatch = { ...rawRefsPatch, ...(source ? { h3CharacterGroups: source.h3CharacterGroups } : {}) };
    const storyboardPatch = refsPatch.referenceBindings?.length
        ? { storyboardShots: refsPatch.referenceBindings.filter((binding) => binding.role === "storyboard").map((binding) => ({ id: binding.id, referenceBindingId: binding.id })), storyboardDurations: {} }
        : {};
    // 仅当源段确实带非空提示词时才还原 prompt：避免把当前 clip 的好提示词覆盖成空字符串
    // （源段 prompt 在实时 segments 里可能已丢失，但生成时刻快照 ref.params 里仍保留，故优先用快照兜底）。
    const basePrompt = String((base as Record<string, unknown>).prompt || "").trim();
    const snapshotPrompt = ref.params && typeof ref.params.prompt === "string" ? ref.params.prompt.trim() : "";
    const authoredPrompt = typeof submission.authoredPrompt === "string" ? submission.authoredPrompt.trim()
        : typeof submission.semanticPrompt === "string" ? submission.semanticPrompt.trim() : "";
    const hasAuthoredPrompt = !source && (typeof submission.authoredPrompt === "string" || typeof submission.semanticPrompt === "string");
    const finalPrompt = hasAuthoredPrompt ? authoredPrompt : basePrompt || snapshotPrompt;
    if (finalPrompt) return { ...base, ...refsPatch, ...storyboardPatch, prompt: finalPrompt } as Partial<H3Segment>;
    const { prompt: _drop, ...rest } = base as Record<string, unknown>;
    return { ...rest, ...refsPatch, ...storyboardPatch } as Partial<H3Segment>;
}
