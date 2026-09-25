export type H3ReferenceRole = "character_identity" | "character_turnaround" | "storyboard" | "scene" | "blocking" | "keyframe" | "motion_reference" | "audio_reference" | "character_voice" | "style" | "palette" | "prop" | "other";
export type H3ReferenceUsage = "reference" | "first_frame" | "last_frame";
export type H3ReferenceRetention = "fully_preserved" | "partially_preserved" | "attribute_transfer" | "weak_reference";
export type H3ReferenceBinding = { id: string; assetId: string; label: string; role: H3ReferenceRole; tags: string[]; description?: string; enabled: boolean; usage: H3ReferenceUsage; retentionLevel?: H3ReferenceRetention; subjectId?: string; storyboardSubjectIds?: string[]; mediaType?: "image" | "video" | "audio"; url?: string; storageKey?: string; mimeType?: string; sourceNodeId?: string; groupId?: string; outfitId?: string };

export type H3CharacterOutfit = {
    id: string;
    url: string;
    name: string;
    storageKey?: string;
    mimeType?: string;
    role?: H3ReferenceRole;
    enabled: boolean;
};

export type H3CharacterVoice = {
    url: string;
    name: string;
    description?: string;
    storageKey?: string;
    assetId?: string;
};

export type H3CharacterGroup = {
    id: string;
    characterName: string;
    characterAssetId?: string;
    characterNodeId?: string;
    /** 角色在当前 Clip 的稳定主体 ID；没有独立主体表时使用 characterNodeId。 */
    subjectId?: string;
    voice?: H3CharacterVoice;
    outfits: H3CharacterOutfit[];
    /** 是否启用当前 Clip 的服装参考；缺省兼容旧数据时按是否已有 enabled 服装推导。 */
    outfitEnabled?: boolean;
    voiceEnabled: boolean;
};

export type H3CharacterGroupEditPatch = {
    /** undefined 表示不改；true/false 统一控制整个角色组的服装参考。 */
    outfitEnabled?: boolean;
    /** 兼容旧的逐套 enabled 编辑入口。 */
    outfitEnabledById?: Record<string, boolean>;
    voiceEnabled?: boolean;
};

export type H3Ref = { url: string; type: "image" | "video" | "audio"; name: string; storageKey?: string; mimeType?: string; slot?: number; segmentId?: string; generationLogId?: string; params?: Record<string, unknown>; nodeId?: string; role?: H3ReferenceRole; subjectId?: string; storyboardSubjectIds?: string[]; order?: number; groupId?: string; outfitId?: string; bindingId?: string; assetId?: string; tags?: string[]; description?: string; enabled?: boolean; usage?: H3ReferenceUsage; retentionLevel?: H3ReferenceRetention; analysis?: Record<string, unknown> };
export type H3StoryboardShot = { id: string; duration?: number; referenceBindingId?: string };

/**
 * Clip 级「实体定义」：subject_definitions 的权威来源。
 * 打开分镜编辑表单时按当前 Clip 引用规则生成一份默认值，用户可手动增删改。
 * 未自定义（缺省）时按下述规则即时生成，保证旧数据行为不变。
 */
export type H3SubjectDefinition = {
    /** 稳定主体 ID（对应 subjects manifest 的 id / groupId / subjectId）。 */
    id: string;
    /** 展示名，写入 `<Subject N> is <name>.`。 */
    name: string;
    englishName?: string;
    /** 视觉来源的参考标签，如 `<Picture 2>`。 */
    pictures?: string[];
    /** 补充描述（profile / 服装 / 视觉特征）。 */
    profile?: string;
    outfits?: string[];
    /** 主体类别，仅用于 UI 分组与配色。 */
    role?: string;
};

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
    /** H3 父运行任务 ID；runtimeTaskId 在生成阶段是当前 Clip 的子任务 ID。 */
    parentTaskId?: string;
    // H3Runner catch 块写 segment.status: "error" 时把 errorDetails 也写到 segment 上，
    // H3ClipCard 用它显示 hover 提示，避免前端"卡片不更新"的视觉假象。
    errorDetails?: string;
    taskMode?: string;
    storyboardCompositeEnabled?: boolean;
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
    /** Director track -> crop -> H3 r2v resample -> stitch post-pass. */
    faceRefineEnabled?: boolean;
    faceRefineDetector?: string;
    faceRefineConfidence?: number;
    faceRefineCropFactor?: number;
    faceRefineCanvasSize?: number;
    faceRefineDenoise?: number;
    faceRefineSteps?: number;
    faceRefineSampler?: string;
    faceRefineScheduler?: string;
    faceRefinePasteRegion?: string;
    faceRefineMaskDilation?: number;
    faceRefineFeather?: number;
    faceRefineColourMatch?: number;
    faceRefineBlend?: number;
    /** Two-phase mode uses a durable decoded first-pass video; it does not reuse V15 latent. */
    confirmationMode?: boolean;
    firstPassResult?: string;
    firstPassStorageKey?: string;
    firstPassFingerprint?: string;
    firstPassReady?: boolean;
    storyboardPromptCache?: { version: 13; fingerprint: string; subjectDefinitions: string; retentionAnalysis: string };
    seamFaceFadeFrames?: number;
    seamColourMatch?: number;
    seamAudioCrossfadeMs?: number;
    lowMemoryAttentionHeads?: number;
    reservedVramGb?: number;
    runtimeReserveEnabled?: boolean;
    uniBlockSwapEnabled?: boolean;
    uniBlockSwapBlocks?: number;
    /** 连续生成模式：保留跨 Clip 的 H3 模型缓存，减少下一段冷启动。默认关闭。 */
    keepModelCache?: boolean;
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
    /** 南风 V15 追加字段；当前默认关闭，供后端/MCP 显式透传。 */
    emptyFiveMinuteTimeline?: boolean;
    taeh3Enabled?: boolean;
    contextLength?: string;
    audioContextLength?: number;
    continuationTask?: string;
    continuationGroupId?: string;
    continuationAudioRefineEnabled?: boolean;
    continuationAudioDenoise?: number;
    continuationAudioSteps?: number;
    continuationAudioSampler?: string;
    continuationAudioScheduler?: string;
    trtVideoVaeEnabled?: boolean;
    trtDecoderEngine?: string;
    trtEncoderEngine?: string;
    dlssUpscaleMode?: string;
    dlssFrameInterpolationEnabled?: boolean;
    dlssVideoUpscaleMode?: string;
    dlssVideoRequireNeuralUpscaling?: boolean;
    dlssVideoNrPreset?: string;
    dlssVideoNrStyle?: string;
    dlssVideoNrIntensity?: number;
    dlssVideoLocalToneStrength?: number;
    dlssVideoLocalStructureStrength?: number;
    dlssVideoSkinStructureStrength?: number;
    dlssVideoAutomaticMask?: boolean;
    dlssVideoModelPreset?: string;
    dlssVideoEncodingQuality?: string;
    dlssVideoCodec?: string;
    dlssVideoContainer?: string;
    dlssVideoRename?: string;
    dlssVideoCustomSuffix?: string;
    dlssVideoHdrMode?: boolean;
    dlssVideoOutputDetailStrength?: number;
    dlssFgOutputFps?: string;
    dlssFgEngine?: string;
    dlssFgEncodingQuality?: string;
    dlssFgVideoCodec?: string;
    dlssFgContainer?: string;
    dlssFgRename?: string;
    dlssFgCustomSuffix?: string;
    dlssFgHdrMode?: boolean;
    erSolverType?: string;
    erMaxStage?: number;
    erEta?: number;
    erSNoise?: number;
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
    referenceBindings?: H3ReferenceBinding[];
    /** 当前 Clip 是否显示分镜时间轨；每段独立保存。 */
    storyboardModeEnabled?: boolean;
    /** 以稳定 reference binding ID 为键的 Clip 本地分镜时长（秒）。 */
    storyboardDurations?: Record<string, number>;
    /** 独立于参考图片的分镜项目；referenceBindingId 仅用于兼容旧的图片分镜。 */
    storyboardShots?: H3StoryboardShot[];
    /**
     * Clip 级实体定义（subject_definitions 的权威来源）。缺省时由当前 Clip 引用规则生成，
     * 用户一旦在分镜编辑里编辑过就以此为准。
     */
    subjectDefinitions?: H3SubjectDefinition[];
    h3CharacterGroups?: Record<string, H3CharacterGroup>;
    aspectRatio?: string;
    megapixels?: number;
    videoSteps?: number;
    denoise?: number;
    trimIn?: number;
    trimOut?: number;
    // Motion Context 是南风 V15 的 AV latent 潜空间续写开关；后端负责生成连续组任务描述符。
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
