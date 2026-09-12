export type H3ReferenceRole = "character_turnaround" | "storyboard" | "scene" | "motion_reference" | "audio_reference" | "character_voice";

export type H3CharacterOutfit = {
    id: string;
    url: string;
    name: string;
    storageKey?: string;
    mimeType?: string;
    enabled: boolean;
};

export type H3CharacterVoice = {
    url: string;
    name: string;
    storageKey?: string;
    assetId?: string;
};

export type H3CharacterGroup = {
    id: string;
    characterName: string;
    characterAssetId?: string;
    characterNodeId?: string;
    voice?: H3CharacterVoice;
    outfits: H3CharacterOutfit[];
    voiceEnabled: boolean;
};

export type H3Ref = { url: string; type: "image" | "video" | "audio"; name: string; storageKey?: string; mimeType?: string; slot?: number; segmentId?: string; params?: Record<string, unknown>; nodeId?: string; role?: H3ReferenceRole; subjectId?: string; order?: number; groupId?: string; outfitId?: string };

export type H3TaskStatus = "idle" | "queued" | "loading" | "success" | "error" | "cancelled";
export type H3TaskState = { id?: string; status: H3TaskStatus; progress: number; error?: string; output?: H3Ref };
export type H3Pane = "library" | "preview" | "video" | "refs";

export type H3Segment = {
    id: string;
    start?: number;
    prompt?: string;
    duration?: number;
    result?: string;
    resultStorageKey?: string;
    results?: H3Ref[];
    status?: string;
    progress?: number;
    runtimeTaskId?: string;
    // H3Runner catch 块写 segment.status: "error" 时把 errorDetails 也写到 segment 上，
    // H3ClipCard 用它显示 hover 提示，避免前端"卡片不更新"的视觉假象。
    errorDetails?: string;
    taskMode?: string;
    seed?: number | string;
    noiseSeedMode?: "random" | "fixed";
    noiseSeed?: number | string;
    modelName?: string;
    loraName?: string;
    loraStrength?: number;
    loraSlots?: Array<{ name: string; strength: number; enabled: boolean }>;
    solAttnEnabled?: boolean;
    solAttnTau?: number;
    solAttnThresholdType?: string;
    solAttnExactMode?: string;
    solAttnDenseSteps?: number;
    solAttnStepOff?: number;
    solAttnSinkTokens?: number;
    t8Enabled?: boolean;
    t8ResidualThreshold?: number;
    t8StartPercent?: number;
    t8EndPercent?: number;
    t8MaxConsecutiveHits?: number;
    t8CacheDevice?: string;
    t8MetricStride?: number;
    t8Verbose?: boolean;
    sigmaEnabled?: boolean;
    videoSigmaShift?: number;
    audioSigmaShift?: number;
    sigmaMode?: string;
    lowSigmaStart?: number;
    lowSigmaEnd?: number;
    sigmaRefineSteps?: number;
    sigmaCurve?: string;
    manualSigma?: string;
    dualSampling?: boolean;
    dualSamplingRatio?: number;
    dualSampler?: string;
    secondPassEnabled?: boolean;
    firstPassSteps?: number;
    secondPassSteps?: number;
    secondPassMegapixels?: number;
    secondPassUpscaleMethod?: string;
    secondPassDenoise?: number;
    secondPassSampler?: string;
    secondPassScheduler?: string;
    secondPassModel?: string;
    secondPassSigma?: number;
    dedicatedAttention?: string;
    startupMode?: string;
    faceRepairSingle?: boolean;
    faceRepairMulti?: boolean;
    globalRepair?: boolean;
    lowMemoryAttentionHeads?: number;
    reservedVramGb?: number;
    runtimeReserveEnabled?: boolean;
    uniBlockSwapEnabled?: boolean;
    uniBlockSwapBlocks?: number;
    latentUpscaleEnabled?: boolean;
    h3FirstSteps?: number;
    h3SecondSteps?: number;
    h3FullSigma?: string;
    v81ManualSigma?: boolean;
    latentUpscaleModel?: string;
    latentUpscaleMegapixels?: number;
    latentUpscaleAlign?: number;
    latentUpscalePrecision?: string;
    realtimePreviewEnabled?: boolean;
    realtimePreviewLongEdge?: number;
    realtimePreviewFrames?: number;
    realtimePreviewFps?: number;
    realtimePreviewJpegQuality?: number;
    rtxEnabled?: boolean;
    rtxResizeMode?: string;
    rtxScale?: number;
    rtxWidth?: number;
    rtxHeight?: number;
    rtxQuality?: string;
    slaEnabled?: boolean;
    slaSparsity?: number;
    slaBlockSize?: string;
    slaMinSequence?: number;
    slaDenseLastSteps?: number;
    slaProtectAudio?: boolean;
    slaDenseSteps?: string;
    slaBackend?: string;
    slaDisableFp16Accum?: boolean;
    slaStabilizeMotion?: boolean;
    audioDriveMarkers?: string;
    audioDriveSegmentImages?: string;
    audioDriveSegmentStoryboards?: string;
    audioDriveCreative?: string;
    audioDriveExclude?: string;
    audioDriveStart?: number;
    audioDriveEnd?: number;
    teAccel?: boolean;
    noDub?: boolean;
    noCaption?: boolean;
    audioMode?: string;
    audioDenoiseStrength?: number;
    addSourceAsReference?: boolean;
    promptPrimaryAudioOrdinal?: number;
    strictPromptTags?: boolean;
    referenceVideoPolicy?: string;
    refImageSize?: string;
    referenceLongEdge?: number;
    refs?: { image?: H3Ref[]; video?: H3Ref[]; audio?: H3Ref[] };
    refItems?: H3Ref[];
    h3CharacterGroups?: Record<string, H3CharacterGroup>;
    aspectRatio?: string;
    megapixels?: number;
    videoSteps?: number;
    denoise?: number;
    trimIn?: number;
    trimOut?: number;
    // 已失效的遗留字段：南风 V10 主节点没有任何 motion/context 输入，且活跃预设会跳过
    // prepareH3MotionContext，因此该开关现在不产生任何效果（保留仅为兼容历史数据）。
    motionContextEnabled?: boolean;
    // 上一段成品视频作为「参考视频」喂进本段：必须显式开启，默认关闭。
    // 只有链式续跑（runFromCurrent）时生效；标在本段上（index > 0 才有意义）。
    // 注意：唯一有效键名是 previousVideoAsReference，不要再引入别名。
    previousVideoAsReference?: boolean;
    // 尾帧接续：本段运行结束后，下一段运行自动抓取本段尾帧作为首帧参考并拼接到提示词
    // （仅运行时拼接，不写回 prompt 编辑区）。该开关标在本段上，表示「把我的尾帧传给下一段」。
    // 注意：唯一有效键名是 tailFrameContinuation；不要再引入 tailFrameEnabled 之类的别名。
    tailFrameContinuation?: boolean;
    motionContextNoiseEnabled?: boolean;
    motionContextNoiseAlpha?: number;
    motionContextNoiseAlphaEnd?: number;
    motionContextNoiseRampFrames?: number;
    combatLoraWeight?: number;
    cinematicLoraWeight?: number;
    mode?: "t2v" | "i2v" | "fl2v" | "ref2va";
    textEncoder?: string;
    textEncoderType?: string;
    textEncoderDevice?: string;
    videoVae?: string;
    audioVae?: string;
    precision?: string;
    sageAttention?: string;
    allowCompile?: boolean;
    sizeMultiple?: number;
    sampler?: string;
    scheduler?: string;
    steps?: number;
    lockAudio?: boolean;
    audioDrive?: boolean;
    audioDriveFile?: string;
    constantTriggerWord?: string;
    nanfengExpandedSections?: Record<string, boolean>;
};

/** H3 领域设置的共享语义：界面与计划只使用 videoSteps，ComfyUI 适配层再映射为 steps。 */
export type H3GenerationSettings = Partial<Omit<H3Segment, "id" | "start" | "prompt" | "result" | "results" | "status" | "progress" | "runtimeTaskId" | "errorDetails" | "refs" | "refItems">>;
