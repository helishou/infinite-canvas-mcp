export declare const H3_DEFAULTS_KEY = "plugin:minimax-h3:defaults:v1";
export type H3ParameterSource = 'request' | 'clip' | 'node' | 'nodeParams' | 'defaults' | 'builtIn';
/** The preview and executor resolve exactly the same saved settings. Never mutate the input. */
export declare function resolveH3Runtime(segment: Record<string, unknown>, override: Record<string, unknown>, metadata: Record<string, unknown>, defaults: Record<string, unknown>): {
    params: Record<string, unknown>;
    sources: Record<string, H3ParameterSource>;
    parameterIssues: string[];
    policy: "defaults" | "overrides";
};
export declare function canonicalH3AspectRatio(value: unknown): string | null;
/** Reference numbering may change; the authored dialogue/action prose must survive byte for byte. */
export declare function h3PromptContent(prompt: string): string;
export declare function h3ExpectedDialogues(source: Record<string, unknown>, shotIds: string[]): {
    blockId: string;
    speaker: string;
    text: string;
}[];
/** NanFeng V15 uses decimal MP and a 16px grid multiplied by latent alignment. */
export declare function estimateH3Dimensions(params: Record<string, unknown>, secondPass?: boolean): {
    width: number;
    height: number;
    aspectRatio: string;
    megapixels: number;
    grid: number;
    kind: "workflow-estimate";
} | null;
export declare function h3StoryboardIssues(segment: Record<string, unknown>, expected?: Array<{
    id: string;
    duration: number;
}>): string[];
export declare const H3_PARAM_KEYS: readonly ["minimaxEngine", "selectedVideoModelEnabled", "selectedVideoModel", "selectedVideoModelFieldValues", "mode", "taskMode", "styleTemplateId", "duration", "aspectRatio", "megapixels", "videoSteps", "steps", "denoise", "noiseSeedMode", "noiseSeed", "seed", "modelName", "textEncoder", "textEncoderType", "textEncoderDevice", "videoVae", "audioVae", "precision", "sageAttention", "allowCompile", "sizeMultiple", "sampler", "scheduler", "loraSlots", "constantTriggerWord", "lockAudio", "audioDrive", "audioDriveFile", "audioDriveMarkers", "audioDriveSegmentImages", "audioDriveSegmentStoryboards", "audioDriveCreative", "audioDriveExclude", "audioDriveStart", "audioDriveEnd", "solAttnEnabled", "solAttnTau", "solAttnThresholdType", "solAttnExactMode", "solAttnDenseSteps", "solAttnStepOff", "solAttnSinkTokens", "t8Enabled", "t8ResidualThreshold", "t8StartPercent", "t8EndPercent", "t8MaxConsecutiveHits", "t8CacheDevice", "t8MetricStride", "t8Verbose", "sigmaEnabled", "videoSigmaShift", "audioSigmaShift", "sigmaMode", "lowSigmaStart", "lowSigmaEnd", "sigmaRefineSteps", "sigmaCurve", "manualSigma", "dualSampling", "dualSamplingRatio", "dualSampler", "secondPassEnabled", "firstPassSteps", "secondPassSteps", "secondPassMegapixels", "secondPassUpscaleMethod", "secondPassDenoise", "secondPassSampler", "secondPassScheduler", "secondPassModel", "secondPassSigma", "dedicatedAttention", "startupMode", "faceRefineEnabled", "faceRefineDetector", "faceRefineConfidence", "faceRefineCropFactor", "faceRefineCanvasSize", "faceRefineDenoise", "faceRefineSteps", "faceRefineSampler", "faceRefineScheduler", "faceRefinePasteRegion", "faceRefineMaskDilation", "faceRefineFeather", "faceRefineColourMatch", "faceRefineBlend", "confirmationMode", "seamFaceFadeFrames", "seamColourMatch", "seamAudioCrossfadeMs", "lowMemoryAttentionHeads", "reservedVramGb", "runtimeReserveEnabled", "uniBlockSwapEnabled", "uniBlockSwapBlocks", "keepModelCache", "latentUpscaleEnabled", "latentUpscaleConfirmationMode", "h3FirstSteps", "h3SecondSteps", "h3FullSigma", "v81ManualSigma", "latentUpscaleModel", "latentUpscaleMegapixels", "latentUpscaleAlign", "latentUpscalePrecision", "realtimePreviewEnabled", "realtimePreviewLongEdge", "realtimePreviewFrames", "realtimePreviewFps", "realtimePreviewJpegQuality", "rtxEnabled", "rtxResizeMode", "rtxScale", "rtxWidth", "rtxHeight", "rtxQuality", "slaEnabled", "slaSparsity", "slaBlockSize", "slaMinSequence", "slaDenseLastSteps", "slaProtectAudio", "slaDenseSteps", "slaBackend", "slaDisableFp16Accum", "slaStabilizeMotion", "emptyFiveMinuteTimeline", "taeh3Enabled", "contextLength", "audioContextLength", "continuationTask", "continuationAudioRefineEnabled", "continuationSeamNoiseEnabled", "continuationSeamNoiseMode", "continuationSeamNoise", "continuationSeamNoiseSeed", "continuationSeamNoiseRamp", "continuationAudioDenoise", "continuationAudioSteps", "continuationAudioSampler", "continuationAudioScheduler", "trtVideoVaeEnabled", "trtDecoderEngine", "trtEncoderEngine", "dlssUpscaleMode", "dlssFrameInterpolationEnabled", "dlssVideoUpscaleMode", "dlssVideoRequireNeuralUpscaling", "dlssVideoNrPreset", "dlssVideoNrStyle", "dlssVideoNrIntensity", "dlssVideoLocalToneStrength", "dlssVideoLocalStructureStrength", "dlssVideoSkinStructureStrength", "dlssVideoAutomaticMask", "dlssVideoModelPreset", "dlssVideoEncodingQuality", "dlssVideoCodec", "dlssVideoContainer", "dlssVideoRename", "dlssVideoCustomSuffix", "dlssVideoHdrMode", "dlssVideoOutputDetailStrength", "dlssFgOutputFps", "dlssFgEngine", "dlssFgEncodingQuality", "dlssFgVideoCodec", "dlssFgContainer", "dlssFgRename", "dlssFgCustomSuffix", "dlssFgHdrMode", "erSolverType", "erMaxStage", "erEta", "erSNoise", "refImageSize", "referenceLongEdge", "loraName", "loraStrength", "teAccel", "noDub", "noCaption", "audioMode", "audioDenoiseStrength", "addSourceAsReference", "promptPrimaryAudioOrdinal", "strictPromptTags", "referenceVideoPolicy", "trimIn", "trimOut", "motionContextEnabled", "tailFrameContinuation", "motionContextNoiseEnabled", "motionContextNoiseAlpha", "motionContextNoiseAlphaEnd", "motionContextNoiseRampFrames", "combatLoraWeight", "cinematicLoraWeight"];
export type H3LoraSlot = {
    name: string;
    strength: number;
    enabled: boolean;
};
/**
 * 与本机 NanFengH3MultiReferenceGeneratorV15 的「LoRA{N}强度」声明对齐：
 * FLOAT min -4.0、max 10.0、step 0.05；ComfyUI 进程重载节点后 object_info 才会更新。
 * 超出范围时 ComfyUI 会在 /prompt 阶段整体拒绝（HTTP 400
 * prompt_outputs_failed_validation / value_bigger_than_max），任务连队列都进不去，
 * 只对超出 V15 声明范围的值在编译期夹紧，而不是等 ComfyUI 报错。
 * 注意：走 LoraLoader/LoraLoaderModelOnly 的老路径范围是 ±100，这里只约束 V15 原生节点。
 */
export declare const H3_LORA_STRENGTH_MIN = -4;
export declare const H3_LORA_STRENGTH_MAX = 10;
export declare function clampH3LoraStrength(value: unknown, fallback?: number): number;
export declare function parseH3Seed(value: unknown): number | undefined;
export declare function randomH3Seed(): number;
/**
 * Normalize the two historical LoRA representations into the slot list that
 * the V15 node actually consumes. An empty array is the legacy "not migrated"
 * value; a non-empty array (including disabled/empty slots) is authoritative.
 */
export declare function normalizeH3LoraSlots(params: Record<string, unknown>): Record<string, unknown>[];
/**
 * Make the effective seed visible in the task snapshot before the prompt is
 * built. Keep a seed already resolved in the run plan; fill zero/empty values
 * for legacy inputs. New runs reroll random seeds per Clip in CanvasH3Runner,
 * so repeated graph construction and second-pass confirmation stay stable.
 */
export declare function normalizeH3Params(params: Record<string, unknown>, generateRandomSeed?: boolean): Record<string, unknown>;
export declare function resolveH3Seed(params: Record<string, unknown>): number;
//# sourceMappingURL=runtime-params.d.ts.map