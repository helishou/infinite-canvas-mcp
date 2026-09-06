import { useMemo, useRef } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext, LocalH3Options } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { defaultH3Model, defaultPrompt } from "../constants";
import { compatibleH3Settings, normalizeH3Model } from "../services/h3-compatibility";
import { segmentsFor, compactSegmentStarts } from "../hooks/useH3Segments";
import { appendVideoMaterials, refsForSegment, resultUrl, nextPictureNumber, buildTailFrameContinuation, captureVideoTailFrameDataUrl } from "../services/h3-data";
import { restorableParams } from "../services/h3-segment-utils";
import { readH3Refs } from "../services/h3-refs";
import { createH3Log } from "../services/h3-logs";
import { useH3TaskPolling } from "../hooks/useH3TaskPolling";
import { useH3RunEvents } from "../hooks/useH3RunEvents";
import { generatedVideoMaterials, mapAutoSplitSegments, mergeH3Segments } from "../services/h3-runner-utils";

function normalizeH3TaskMode(value: unknown) {
    const mode = String(value || "").trim().toLowerCase();
    if (mode === "t2v" || mode === "i2v" || mode === "fl2v" || mode === "ref2va") return mode;
    // 旧画布中的 r2v/rv2v/v2v 都对应 NanFeng V10 的 Ref2VA 分支。
    return "ref2va";
}

export function H3Runner({ ctx }: { ctx: CanvasNodeContext }) {
    const metadata = ctx.node.metadata || {};
    const upstream = useMemo(() => readH3Refs(ctx), [ctx.node.id, ctx.getConnections().length, ctx.getNodes().length]);
    const combatLoraWeight = String(metadata.combatLoraWeight || metadata.minimaxCombatLoraWeight || "0");
    const cinematicLoraWeight = String(metadata.cinematicLoraWeight || metadata.minimaxCinematicLoraWeight || "0");
    const teAccel = metadata.teAccel === true || metadata.minimaxTeAccel === true;
    const motionNoise = Boolean(metadata.motionContextNoiseEnabled);
    const noiseAlpha = String(metadata.motionContextNoiseAlpha ?? "0.45");
    const noiseAlphaEnd = String(metadata.motionContextNoiseAlphaEnd ?? "0.10");
    const noiseRampFrames = String(metadata.motionContextNoiseRampFrames ?? "3");
    const autoSplit = Boolean(metadata.autoSplit);
    const segmentDuration = Number(metadata.segmentDuration ?? "6");
    const maxSegments = Number(metadata.maxSegments ?? "60");
    const runningHubFields = Array.isArray(metadata.minimaxRunningHubFields) ? metadata.minimaxRunningHubFields : [];
    const runningHubParams = metadata.minimaxRunningHubParams && typeof metadata.minimaxRunningHubParams === "object" ? metadata.minimaxRunningHubParams : {};
    // 注意：不得在此处直接 mutation metadata（ctx.node.metadata 是 SDK 外部 store 的渲染快照，
    // 渲染期写回会导致「getSnapshot 引用被篡改」进而触发 SDK 内部 setState 的同步重渲染循环。
    // 下方提交 ComfyUI 时直接用本地推导值 runningHubFields / runningHubParams 即可。
    const runInFlightRef = useRef(false);
    const models = ctx.ai.listModels("video");
    const selectedModel = String(metadata.model || ctx.ai.defaultModel("video") || models[0]?.value || "");

    const update = useMemo(() => (patch: Record<string, unknown>) => ctx.updateMetadata(patch), [ctx]);
    useH3TaskPolling(ctx, metadata, update);
    const run = async (runFromCurrent = false) => {
        // The visible workbench is the source of truth. This event runner
        // only consumes run events and must not submit stale local form state.
        // It can remain mounted while the visible workbench adds or
        // selects Clips. ctx.node is the render-time snapshot, so always read
        // the latest node before preparing a run; otherwise a Clip2 run could
        // write back an old one-Clip snapshot and erase the other Clips.
        const liveMetadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
        const liveSegments = segmentsFor(liveMetadata);
        const liveSelected = liveSegments.find((segment) => segment.id === String(liveMetadata.selectedSegmentId || "")) || liveSegments[0];
        const liveSelectedId = String(liveMetadata.selectedSegmentId || liveSelected?.id || "");
        const livePrompt = String(liveSelected?.prompt || liveMetadata.prompt || defaultPrompt);
        const liveDuration = String(liveSelected?.duration || liveMetadata.duration || "8");
        const liveRatio = String(liveSelected?.aspectRatio || liveMetadata.aspectRatio || "16:9");
        const liveMegapixels = Number(liveSelected?.megapixels || liveMetadata.megapixels || liveMetadata.minimaxGlobalMegapixels || 0.4);
        const liveSettings = liveSelected ? compatibleH3Settings(liveSelected, String(liveMetadata.minimaxBaseModel || liveMetadata.modelName || defaultH3Model), String(liveMetadata.minimaxLoraName || liveMetadata.loraName || ""), upstream) : { modelName: defaultH3Model, loraName: "", defaultSteps: 20 };
        const liveSteps = Number(liveSelected?.videoSteps || liveMetadata.videoSteps || liveMetadata.minimaxGlobalVideoSteps || liveSettings.defaultSteps);
        const liveDenoise = Number(liveSelected?.denoise ?? liveMetadata.denoise ?? 1);
        const liveSeed = liveSelected?.seed ?? liveMetadata.seed ?? liveMetadata.noiseSeed ?? "";
        const liveModelName = liveSettings.modelName;
        const liveLoraName = liveSettings.loraName;
        const liveMotion = liveSelected?.motionContextEnabled !== false && liveMetadata.motionContextEnabled !== false;
        const prompt = livePrompt;
        const duration = liveDuration;
        const ratio = liveRatio;
        const megapixels = String(liveMegapixels);
        const steps = String(liveSteps);
        const denoise = String(liveDenoise);
        const seed = String(liveSeed || "");
        const modelName = liveModelName;
        const loraName = liveLoraName;
        const motion = liveMotion;
        const combatLoraWeight = String(liveSelected?.combatLoraWeight ?? liveMetadata.minimaxCombatLoraWeight ?? "0");
        const cinematicLoraWeight = String(liveSelected?.cinematicLoraWeight ?? liveMetadata.minimaxCinematicLoraWeight ?? "0");
        const video = upstream.find((ref) => ref.type === "video");
        const images = upstream.filter((ref) => ref.type === "image");
        const audios = upstream.filter((ref) => ref.type === "audio");
        // 只校验实际要运行的片段：t2v 不需要素材，其他模式需要对应 clip 的 refs 里有视频或图片
        const activeIdx = Math.max(0, liveSegments.findIndex((segment) => String(segment.id) === liveSelectedId));
        const relevantSegments = runFromCurrent ? liveSegments.slice(activeIdx) : liveSegments.filter((segment) => String(segment.id) === liveSelectedId);
        const missingMaterial = relevantSegments.find((seg) => {
            const mode = normalizeH3TaskMode(seg.mode || seg.taskMode);
            if (mode === "t2v") return false;
            const refs = refsForSegment(seg);
            return !refs.some((r) => r.type === "video" || r.type === "image");
        });
        if (missingMaterial) {
            const clipNo = liveSegments.findIndex((seg) => seg.id === missingMaterial.id) + 1;
            update({ status: "error", errorDetails: `Clip ${clipNo} 请先连接源视频或角色参考图。` });
            return;
        }
        if (runInFlightRef.current) return;
        runInFlightRef.current = true;
        // 日志的 refs 必须与真正提交给 ComfyUI 的 finalReferences 保持一致：
        // 优先用 liveSelected 自身的 segmentRefs，segmentRefs 为空时才回退到 upstream。
        // 否则当用户只往 clip3 拖了一张图、但画布里给 H3 节点连了 2 张图时，
        // createH3Log 会先记 2 张，line 286 的 update 才是 1 张；update 失败或延迟时
        // 日志就一直显示成 2 张参考，与 segment 实际使用的 1 张不符。
        const logSegmentRefs = liveSelected ? refsForSegment(liveSelected) : [];
        const logSegImages = logSegmentRefs.filter((ref) => ref.type === "image");
        const logSegVideos = logSegmentRefs.filter((ref) => ref.type === "video");
        const logSegAudios = logSegmentRefs.filter((ref) => ref.type === "audio");
        const logRefs = [
            ...(logSegImages.length ? logSegImages : images),
            ...(logSegVideos.length ? logSegVideos : (video ? [video] : [])),
            ...(logSegAudios.length ? logSegAudios : audios),
        ] as H3Ref[];
        let generationLogId = "";
        const lastSubmitted = { taskMode: "", video: 0, images: 0, audios: 0, model: "" };
        update({ prompt: livePrompt, duration: liveDuration, aspectRatio: liveRatio, megapixels: liveMegapixels, videoSteps: liveSteps, denoise: liveDenoise, seed: String(liveSeed).trim() ? Number(liveSeed) : undefined, modelName: liveModelName, minimaxBaseModel: liveModelName, loraName: liveLoraName, combatLoraWeight: Number(liveSelected?.combatLoraWeight ?? liveMetadata.minimaxCombatLoraWeight ?? combatLoraWeight), cinematicLoraWeight: Number(liveSelected?.cinematicLoraWeight ?? liveMetadata.minimaxCinematicLoraWeight ?? cinematicLoraWeight), teAccel: liveMetadata.minimaxGlobalTeAccel === true || teAccel, motionContextEnabled: liveMotion, motionContextNoiseEnabled: liveSelected?.motionContextNoiseEnabled === true || liveMetadata.motionContextNoiseEnabled === true || motionNoise, motionContextNoiseAlpha: Number(liveSelected?.motionContextNoiseAlpha ?? liveMetadata.motionContextNoiseAlpha ?? noiseAlpha), motionContextNoiseAlphaEnd: Number(liveSelected?.motionContextNoiseAlphaEnd ?? liveMetadata.motionContextNoiseAlphaEnd ?? noiseAlphaEnd), motionContextNoiseRampFrames: Number(liveSelected?.motionContextNoiseRampFrames ?? liveMetadata.motionContextNoiseRampFrames ?? noiseRampFrames), model: selectedModel, status: "loading", errorDetails: "", runStartedAt: Date.now(), cancelRequested: false, runtimeTargetSegmentId: liveSelectedId });
        try {
            // 日志写入也属于运行链路的一部分；后台断开时必须进入统一 catch，
            // 不能让异常浮出后把节点永远留在“生成中”。
            const generationLog = await createH3Log(ctx, liveSelected, livePrompt, logRefs, { engine: liveMetadata.minimaxEngine || "comfyui", workflow: "MiniMax H3", modelName: liveModelName, taskMode: liveSelected?.taskMode || "r2v", duration: liveDuration, aspectRatio: liveRatio, megapixels: liveMegapixels, videoSteps: liveSteps, denoise: liveDenoise, seed: liveSeed });
            console.log("MiniMax H3 生成日志已创建", generationLog);
            generationLogId = generationLog?.id || "";
            const effectivePrompt = livePrompt;
            const allSegments: H3Segment[] = liveSegments.length ? liveSegments : [{ id: "segment-1", prompt: livePrompt, duration: Number(liveDuration) }];
            // The visible workbench writes the selected id into metadata. The
            // local panel state can lag behind when the user clicks another
            // Clip, so metadata is the source of truth for execution.
            const activeId = liveSelectedId || allSegments[0]?.id || "";
            const activeIndex = Math.max(0, allSegments.findIndex((segment) => String(segment.id) === activeId));
            const storedSegments = runFromCurrent ? allSegments.slice(activeIndex) : allSegments.filter((segment) => String(segment.id) === activeId);
            const requestedIds = new Set(storedSegments.map((segment) => segment.id));
            const markRequestedSegments = (patch: Partial<H3Segment>) => {
                const current = segmentsFor(ctx.getNode(ctx.node.id)?.metadata || liveMetadata);
                update({ segments: current.map((segment) => requestedIds.has(segment.id) ? { ...segment, ...patch } : segment) });
            };
            markRequestedSegments({ status: "loading", progress: 0 });
            // 单独运行 Clip2/Clip3 时，storedSegments 从选中段开始，局部 index
            // 会重新从 0 计数。此时仍要带上画布中上一段已有结果，否则后端
            // 无法进入 Motion Context 链路。
            const precedingSegment = allSegments[activeIndex - 1];
            let previousVideo: { name: string; url: string; storageKey?: string } | undefined = precedingSegment?.result
                ? { name: `h3-segment-${activeIndex}.mp4`, url: String(precedingSegment.result), ...(precedingSegment.resultStorageKey ? { storageKey: precedingSegment.resultStorageKey } : {}) }
                : undefined;
            let lastResult: Awaited<ReturnType<typeof ctx.ai.runLocalH3>> | undefined;
            const nextSegments: H3Segment[] = [];
            const submittedSegments: Array<Record<string, unknown>> = [];
            // 用于错误日志记录最后一次提交的信息
            const createRunSeed = () => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
            for (const [index, segment] of storedSegments.entries()) {
                const configuredSeed = Number(segment.noiseSeed ?? segment.seed);
                // random 模式现在会在 UI 上生成并展示一个真实随机种子；运行时统一
                // 使用 segment 上已有的有效种子（random 的🎲种子、fixed 的手填值、
                // 运行后回写的本次种子都算），只有完全为空时才兜底新生成随机种子，
                // 保证“UI 上看到的种子 = 实际运行的种子”。
                const runSeed = Number.isFinite(configuredSeed) && configuredSeed >= 0 ? configuredSeed : createRunSeed();
                const segmentForRun = { ...segment, seed: runSeed, noiseSeed: runSeed };
                const seedCurrent = segmentsFor(ctx.getNode(ctx.node.id)?.metadata || liveMetadata);
                update({ segments: seedCurrent.map((item) => item.id === segment.id ? { ...item, seed: runSeed, noiseSeed: runSeed } : item) });
                const segmentRefs = refsForSegment(segment);
                const requestedTaskMode = normalizeH3TaskMode(segment.mode || segment.taskMode);
                // t2v：只使用纯提示词，忽略所有素材
                // i2v/fl2v：只使用图片
                // v2v：只使用视频
                // rv2v/r2v：使用视频+图片+音频
                const isT2v = requestedTaskMode === "t2v";
                const isV2v = false;
                const isI2vFl2v = requestedTaskMode === "i2v" || requestedTaskMode === "fl2v";
                const isR2vOrRv2v = requestedTaskMode === "ref2va";
                const effectiveTaskMode = requestedTaskMode;
                // 仅多段续链（runFromCurrent=true）的中间段、且该段 Motion Context 开关为开，
                // 才把上一段已生成的视频作为 Motion Context / Ref2VA 视频参考。
                // 单段生成（runFromCurrent=false）或该段关闭 Motion Context 时，都不注入上一段结果，
                // 避免“上次生成的视频被塞入当前 Clip”（即便关掉 Motion Context 仍被当视频参考喂模型）。
                const usePreviousContext = runFromCurrent && index > 0 && segment.motionContextEnabled !== false;
                const segmentVideo = !isT2v && !isI2vFl2v
                    ? (segmentRefs.find((ref) => ref.type === "video") || (usePreviousContext ? previousVideo : video))
                    : undefined;
                const segmentImages = isT2v || isV2v ? [] : segmentRefs.filter((ref) => ref.type === "image");
                const segmentAudios = isT2v || isV2v || isI2vFl2v ? [] : segmentRefs.filter((ref) => ref.type === "audio");
                // 尾帧接续（运行时自动）：上一段开启 tailFrameContinuation 且有生成视频时，
                // 抓取上一段尾帧，作为本段首帧参考图（接受多图参考的模式）并拼到提示词
                // retention_analysis；不修改 segment.prompt 编辑区。
                // 上一段结果从「实时节点 metadata」取（而非本次运行起始快照），这样连续单次
                // 运行（手动点某 Clip）也能拿到前一段已生成的尾帧，无需手动去切。
                // prevLiveSeg 是整条时间轴上本段的前一段（本段全局下标 = activeIndex + index）。
                // 注意：不能用「循环内 index > 0」作守卫——单独运行某段时 storedSegments 仅 1 项、
                // index 恒为 0，续链运行的第一段也是 index=0，两种场景都会被错误排除，导致永远抓不到尾帧。
                // 正确守卫是「时间轴上确有前一段（prevLiveSeg 存在）」：JS 对负下标返回 undefined，
                // 故首段（activeIndex=0 且 index=0 → -1）自然为 undefined，无需额外判断。
                const prevLiveSeg = segmentsFor(ctx.getNode(ctx.node.id)?.metadata || liveMetadata)[activeIndex + index - 1];
                const prevContinuation = Boolean(prevLiveSeg?.tailFrameContinuation) && Boolean(prevLiveSeg?.result);
                let tailFrameDataUrl: string | null = null;
                if (prevContinuation) {
                    const prevUrl = resultUrl(prevLiveSeg!.result);
                    tailFrameDataUrl = prevUrl ? await captureVideoTailFrameDataUrl(prevUrl) : null;
                    if (!tailFrameDataUrl) console.warn("[minimax-h3] 尾帧接续：截取上一段尾帧失败，本次跳过尾帧注入");
                }
                // 仅对接受额外图片参考的模式注入尾帧图（ref2va/r2v/rv2v 最多 9 张）；
                // i2v/fl2v 图片数被模式固定（1/2 张），注入会违反约束，降级为仅提示词文本。
                // 尾帧来自「上一段」(prevLiveSeg，全局下标 = activeIndex + index - 1)，ref 名称与提示词标签都应指向该段，
                // 不能用 activeIndex + index（那是本段全局下标，会被误标成本段的上一个视频）。
                const prevClipLabel = `Clip ${activeIndex + index - 1}`;
                const tailFrameRef: H3Ref | null = (tailFrameDataUrl && isR2vOrRv2v) ? { url: tailFrameDataUrl, type: "image", name: `尾帧·${prevClipLabel}` } : null;
                if (tailFrameDataUrl && !tailFrameRef) console.warn(`[minimax-h3] 尾帧接续：下一段为 ${effectiveTaskMode} 模式（图片数被固定），仅注入提示词文本，不附加尾帧参考图`);
                // 尾帧接续开启时：尾帧作为 Picture 1（首位），原有参考图顺延（Picture 1 -> 2, 2 -> 3, ...）
                const effectiveSegmentImages = tailFrameRef ? [tailFrameRef, ...segmentImages] : segmentImages;
                if (effectiveSegmentImages.length > 9 || images.length > 9) throw new Error("MiniMax H3 最多支持 9 张参考图片");
                if (segmentRefs.filter((ref) => ref.type === "video").length > 3 || upstream.filter((ref) => ref.type === "video").length > 3) throw new Error("MiniMax H3 最多支持 3 段参考视频");
                if (segmentAudios.length > 3 || audios.length > 3) throw new Error("MiniMax H3 最多支持 3 段参考音频");
                if (requestedTaskMode === "i2v" && segmentImages.length !== 1) throw new Error("I2V 必须且只能使用 1 张图片作为首帧");
                if (requestedTaskMode === "fl2v" && segmentImages.length !== 2) throw new Error("FL2V 必须使用 2 张图片作为首尾帧");
                // t2v 模式下不传递任何图片给 compatibleH3Settings，避免影响模型选择
                const upstreamForSettings = isT2v ? [] : [...images, ...(video ? [video] : [])];
                const segmentSettings = compatibleH3Settings({ ...segmentForRun, taskMode: effectiveTaskMode }, liveModelName, liveLoraName, upstreamForSettings);
                const segmentSteps = Number(segment.videoSteps || liveMetadata.minimaxGlobalVideoSteps || segmentSettings.defaultSteps);
                const h3RunnerImpl = String(liveMetadata.minimaxEngine || "").toLowerCase() === "runninghub" ? ctx.ai.runRunningHubH3 : ctx.ai.runLocalH3;
                const h3Runner = (promptText: string, inputData: any, paramsData: any, optionsData: LocalH3Options) => {
                    if (generationLogId) void ctx.generationLogs.update(generationLogId, {
                        params: { runFromCurrent, selectedSegmentId: liveSelectedId, segments: [...submittedSegments], lastSubmitted: { prompt: promptText, input: inputData, params: paramsData } },
                    }).catch((error) => console.warn("[minimax-h3] failed to record actual generation parameters", error));
                    const { taskMode: _taskMode, teAccel: _teAccel, combatLoraWeight: _combat, cinematicLoraWeight: _cinematic, motionContext: _motion, motionContextEnabled: _motionEnabled, motionContextNoise: _motionNoise, motionContextNoiseAlpha: _motionAlpha, motionContextNoiseAlphaEnd: _motionAlphaEnd, motionContextNoiseRampFrames: _motionRamp, audioMode: _audioMode, audioDenoiseStrength: _audioDenoise, addSourceAsReference: _addSource, promptPrimaryAudioOrdinal: _audioOrdinal, strictPromptTags: _strictTags, referenceVideoPolicy: _refPolicy, refImageSize: _refSize, solAttnEnabled: _sol, solAttnTau: _solTau, solAttnThresholdType: _solThreshold, solAttnExactMode: _solExact, solAttnDenseSteps: _solDense, solAttnStepOff: _solOff, solAttnSinkTokens: _solSink, t8Enabled: _t8, t8ResidualThreshold: _t8Residual, t8StartPercent: _t8Start, t8EndPercent: _t8End, t8MaxConsecutiveHits: _t8Hits, t8CacheDevice: _t8Device, t8MetricStride: _t8Stride, t8Verbose: _t8Verbose, sigmaEnabled: _sigma, videoSigmaShift: _videoShift, audioSigmaShift: _audioShift, sigmaMode: _sigmaMode, lowSigmaStart: _lowSigmaStart, lowSigmaEnd: _lowSigmaEnd, sigmaRefineSteps: _sigmaRefine, sigmaCurve: _sigmaCurve, manualSigma: _manualSigma, dualSampling: _dual, dualSamplingRatio: _dualRatio, dualSampler: _dualSampler, secondPassEnabled: _secondPass, firstPassSteps: _firstPass, secondPassSteps: _secondSteps, secondPassMegapixels: _secondMp, secondPassUpscaleMethod: _secondMethod, secondPassDenoise: _secondDenoise, secondPassSigma: _secondSigma, secondPassSampler: _secondSampler, secondPassScheduler: _secondScheduler, secondPassModel: _secondModel, ...baseParams } = paramsData;
                    console.log("H3Runner submit", {
                        ...baseParams,
                        mode: segment.mode || effectiveTaskMode,
                        steps: Number(segment.steps || segmentSteps),
                        textEncoder: segment.textEncoder,
                        textEncoderType: segment.textEncoderType || "minimax",
                        textEncoderDevice: segment.textEncoderDevice || "default",
                        videoVae: segment.videoVae,
                        audioVae: segment.audioVae,
                        precision: segment.precision || "default",
                        sageAttention: segment.sageAttention || "H3专用Sage加速",
                        allowCompile: segment.allowCompile === true,
                        sizeMultiple: Number(segment.sizeMultiple || 32),
                        sampler: segment.sampler || "res_multistep",
                        scheduler: segment.scheduler || "simple",
                        refImageSize: segment.refImageSize || "match",
                        referenceLongEdge: segment.referenceLongEdge || 1920,
                        constantTriggerWord: segment.constantTriggerWord || "",
                        loraSlots: segment.loraSlots || [],
                        dedicatedAttention: segment.dedicatedAttention,
                        reservedVramGb: segment.reservedVramGb,
                        runtimeReserveEnabled: segment.runtimeReserveEnabled === true,
                        uniBlockSwapEnabled: segment.uniBlockSwapEnabled === true,
                        uniBlockSwapBlocks: segment.uniBlockSwapBlocks,
                        latentUpscaleEnabled: segment.latentUpscaleEnabled === true,
                        h3FirstSteps: segment.h3FirstSteps,
                        h3SecondSteps: segment.h3SecondSteps,
                        h3FullSigma: segment.h3FullSigma,
                        v81ManualSigma: segment.v81ManualSigma === true,
                        latentUpscaleModel: segment.latentUpscaleModel,
                        latentUpscaleMegapixels: segment.latentUpscaleMegapixels,
                        latentUpscaleAlign: segment.latentUpscaleAlign,
                        latentUpscalePrecision: segment.latentUpscalePrecision,
                        realtimePreviewEnabled: segment.realtimePreviewEnabled !== false,
                        realtimePreviewLongEdge: segment.realtimePreviewLongEdge,
                        realtimePreviewFrames: segment.realtimePreviewFrames,
                        realtimePreviewFps: segment.realtimePreviewFps,
                        realtimePreviewJpegQuality: segment.realtimePreviewJpegQuality,
                        rtxEnabled: segment.rtxEnabled === true,
                        rtxResizeMode: segment.rtxResizeMode,
                        rtxScale: segment.rtxScale,
                        rtxWidth: segment.rtxWidth,
                        rtxHeight: segment.rtxHeight,
                        rtxQuality: segment.rtxQuality,
                        slaEnabled: segment.slaEnabled === true,
                        slaSparsity: segment.slaSparsity,
                        slaBlockSize: segment.slaBlockSize,
                        slaMinSequence: segment.slaMinSequence,
                        slaDenseLastSteps: segment.slaDenseLastSteps,
                        slaProtectAudio: segment.slaProtectAudio,
                        slaDenseSteps: segment.slaDenseSteps,
                        slaBackend: segment.slaBackend,
                        slaDisableFp16Accum: segment.slaDisableFp16Accum,
                        slaStabilizeMotion: segment.slaStabilizeMotion,
                        lockAudio: segment.lockAudio === true,
                        audioDrive: segment.audioDrive === true,
                        audioDriveFile: segment.audioDriveFile,
                        audioDriveMarkers: segment.audioDriveMarkers,
                        audioDriveSegmentImages: segment.audioDriveSegmentImages,
                        audioDriveSegmentStoryboards: segment.audioDriveSegmentStoryboards,
                        audioDriveCreative: segment.audioDriveCreative,
                        audioDriveExclude: segment.audioDriveExclude,
                        audioDriveStart: segment.audioDriveStart,
                        audioDriveEnd: segment.audioDriveEnd,
                    });
                    return h3RunnerImpl(promptText, inputData, {
                        ...baseParams,
                        mode: segment.mode || effectiveTaskMode,
                        steps: Number(segment.steps || segmentSteps),
                        textEncoder: segment.textEncoder,
                        textEncoderType: segment.textEncoderType || "minimax",
                        textEncoderDevice: segment.textEncoderDevice || "default",
                        videoVae: segment.videoVae,
                        audioVae: segment.audioVae,
                        precision: segment.precision || "default",
                        sageAttention: segment.sageAttention || "H3专用Sage加速",
                        allowCompile: segment.allowCompile === true,
                        sizeMultiple: Number(segment.sizeMultiple || 32),
                        sampler: segment.sampler || "res_multistep",
                        scheduler: segment.scheduler || "simple",
                        refImageSize: segment.refImageSize || "match",
                        referenceLongEdge: segment.referenceLongEdge || 1920,
                        constantTriggerWord: segment.constantTriggerWord || "",
                        loraSlots: segment.loraSlots || [],
                        dedicatedAttention: segment.dedicatedAttention,
                        reservedVramGb: segment.reservedVramGb,
                        runtimeReserveEnabled: segment.runtimeReserveEnabled === true,
                        uniBlockSwapEnabled: segment.uniBlockSwapEnabled === true,
                        uniBlockSwapBlocks: segment.uniBlockSwapBlocks,
                        latentUpscaleEnabled: segment.latentUpscaleEnabled === true,
                        h3FirstSteps: segment.h3FirstSteps,
                        h3SecondSteps: segment.h3SecondSteps,
                        h3FullSigma: segment.h3FullSigma,
                        v81ManualSigma: segment.v81ManualSigma === true,
                        latentUpscaleModel: segment.latentUpscaleModel,
                        latentUpscaleMegapixels: segment.latentUpscaleMegapixels,
                        latentUpscaleAlign: segment.latentUpscaleAlign,
                        latentUpscalePrecision: segment.latentUpscalePrecision,
                        realtimePreviewEnabled: segment.realtimePreviewEnabled !== false,
                        realtimePreviewLongEdge: segment.realtimePreviewLongEdge,
                        realtimePreviewFrames: segment.realtimePreviewFrames,
                        realtimePreviewFps: segment.realtimePreviewFps,
                        realtimePreviewJpegQuality: segment.realtimePreviewJpegQuality,
                        rtxEnabled: segment.rtxEnabled === true,
                        rtxResizeMode: segment.rtxResizeMode,
                        rtxScale: segment.rtxScale,
                        rtxWidth: segment.rtxWidth,
                        rtxHeight: segment.rtxHeight,
                        rtxQuality: segment.rtxQuality,
                        slaEnabled: segment.slaEnabled === true,
                        slaSparsity: segment.slaSparsity,
                        slaBlockSize: segment.slaBlockSize,
                        slaMinSequence: segment.slaMinSequence,
                        slaDenseLastSteps: segment.slaDenseLastSteps,
                        slaProtectAudio: segment.slaProtectAudio,
                        slaDenseSteps: segment.slaDenseSteps,
                        slaBackend: segment.slaBackend,
                        slaDisableFp16Accum: segment.slaDisableFp16Accum,
                        slaStabilizeMotion: segment.slaStabilizeMotion,
                        lockAudio: segment.lockAudio === true,
                        audioDrive: segment.audioDrive === true,
                        audioDriveFile: segment.audioDriveFile,
                        audioDriveMarkers: segment.audioDriveMarkers,
                        audioDriveSegmentImages: segment.audioDriveSegmentImages,
                        audioDriveSegmentStoryboards: segment.audioDriveSegmentStoryboards,
                        audioDriveCreative: segment.audioDriveCreative,
                        audioDriveExclude: segment.audioDriveExclude,
                        audioDriveStart: segment.audioDriveStart,
                        audioDriveEnd: segment.audioDriveEnd,
                    }, optionsData);
                };
                const segmentPrompt = segment.prompt !== undefined ? String(segment.prompt) : effectivePrompt;
                // 尾帧接续：把上一段尾帧作为本段「切镜」首帧参考，但保持人物/动作连续性。
                // 用 partially_preserved 描述（新镜头，不是无缝 match-cut 续接）。
                // 仅注入到本次提交的提示词与日志；不回写 segment.prompt（编辑区保持用户原文）。
                // 尾帧接续：只要有截到的尾帧（无论模式是否允许注入参考图），都把「切镜保持人物/动作连续」的
                // 描述拼进本次提交的提示词与日志；不回写 segment.prompt（编辑区保持用户原文）。
                // 参考图本身只在接受多图参考的模式（ref2va/r2v/rv2v）注入，i2v/fl2v 图片数被模式固定则只拼提示词。
                // 尾帧接续开启时：尾帧始终作为 Picture 1（首位），提示词 Picture 编号顺延一位
                const submittedSegmentPrompt = tailFrameDataUrl ? buildTailFrameContinuation(segmentPrompt, 1, prevClipLabel) : segmentPrompt;
                const promptFlags = `${segment.noDub !== false ? "\nNo dialogue, narration, voiceover, or singing." : ""}${segment.noCaption !== false ? "\nNo subtitles, captions, on-screen text, or text overlays." : ""}`;
                // 根据任务模式决定提交哪些 refs
                // 透传 storageKey：后端媒体引用（图片/视频/音频）直接用 storageKey 复用，
                // 避免只留 url 时 extractStorageKey 反推出被 URL 编码的 key（如 image%3A<uuid>）
                // 导致后端查不到（404）或退化到 dataUrl 分支（400 畸形 data URL）。
                const finalReferences = isT2v || isV2v ? [] : (isI2vFl2v ? segmentImages : (effectiveSegmentImages.length ? effectiveSegmentImages : images)).map((ref) => ({ name: `${ref.name}.png`, url: ref.url, type: ref.type, ...(ref.storageKey ? { storageKey: ref.storageKey } : {}) }));
                const finalVideo = !isT2v && !isI2vFl2v ? (segmentVideo ? { name: `${segmentVideo.name}.mp4`, url: segmentVideo.url, type: "video", ...(segmentVideo.storageKey ? { storageKey: segmentVideo.storageKey } : {}) } : undefined) : undefined;
                const finalAudios = isR2vOrRv2v ? (segmentAudios.length ? segmentAudios : audios).map((ref) => ({ name: `${ref.name}.mp3`, url: ref.url, type: ref.type, ...(ref.storageKey ? { storageKey: ref.storageKey } : {}) })) : [];
                // 记录提交信息用于错误日志
                lastSubmitted.taskMode = effectiveTaskMode;
                lastSubmitted.video = finalVideo ? 1 : 0;
                lastSubmitted.images = finalReferences.length;
                lastSubmitted.audios = finalAudios.length;
                lastSubmitted.model = segmentSettings.modelName;
                const submittedPrompt = `${submittedSegmentPrompt}${promptFlags}`;
                const submittedInput = {
                    video: finalVideo,
                    references: finalReferences,
                    audios: finalAudios,
                    // 单段生成（runFromCurrent=false）不把上一段结果作为 previousVideo 传给后端，
                    // 否则即使关了 Motion Context，这段仍可能带着上次视频跑（被当成 video ref 喂模型）。
                    previousVideo: usePreviousContext ? previousVideo : undefined,
                };
                const submittedParams = {
                    duration: Number(segment.duration || duration),
                    aspectRatio: String(segment.aspectRatio || ratio),
                    megapixels: Number(segment.megapixels || megapixels),
                    videoSteps: segmentSteps,
                    denoise: Number(segment.denoise ?? denoise),
                    modelName: segmentSettings.modelName,
                    loraName: segment.loraName || liveLoraName,
                    taskMode: effectiveTaskMode,
                    // segmentForRun 内已包含 seed/noiseSeed（line 153 的 {...segment, seed: runSeed, noiseSeed: runSeed}），
                    // 显式写在前面会触发 TS2783 "specified more than once"，放最后让 spread 决定最终值。
                    ...segmentForRun,
                };
                submittedSegments.push({
                    segmentId: segment.id,
                    prompt: submittedPrompt,
                    params: submittedParams,
                    input: submittedInput,
                });
                if (generationLogId) {
                    await ctx.generationLogs.update(generationLogId, {
                        prompt: submittedPrompt,
                        references: [...finalReferences, ...(finalVideo ? [finalVideo] : []), ...finalAudios].map((ref) => ({ url: ref.url, name: ref.name, type: ref.type, ...(ref.storageKey ? { storageKey: ref.storageKey } : {}) })),
                        inputCounts: { image: finalReferences.length, video: finalVideo ? 1 : 0, audio: finalAudios.length },
                        params: { runFromCurrent, selectedSegmentId: liveSelectedId, segments: [...submittedSegments], lastSubmitted: { prompt: submittedPrompt, input: submittedInput, params: submittedParams } },
                    }).catch((error) => console.warn("[minimax-h3] failed to record submitted parameters", error));
                }
                const segmentResult = await h3Runner(submittedPrompt, submittedInput, { ...submittedParams, combatLoraWeight: Number(segment.combatLoraWeight ?? 0), cinematicLoraWeight: Number(segment.cinematicLoraWeight ?? 0), teAccel: segment.teAccel ?? teAccel, audioMode: String(segment.audioMode || "native"), audioDenoiseStrength: Number(segment.audioDenoiseStrength ?? 1), addSourceAsReference: segment.addSourceAsReference === true, promptPrimaryAudioOrdinal: Number(segment.promptPrimaryAudioOrdinal || 0), strictPromptTags: segment.strictPromptTags !== false, referenceVideoPolicy: String(segment.referenceVideoPolicy || "official_2_to_15s"), refImageSize: String(segment.refImageSize || "match"), motionContext: usePreviousContext && segment.motionContextEnabled !== false && motion, motionContextNoise: usePreviousContext && segment.motionContextNoiseEnabled !== false && motionNoise, motionContextNoiseAlpha: Number(segment.motionContextNoiseAlpha ?? noiseAlpha), motionContextNoiseAlphaEnd: Number(segment.motionContextNoiseAlphaEnd ?? noiseAlphaEnd), motionContextNoiseRampFrames: Number(segment.motionContextNoiseRampFrames ?? noiseRampFrames), runninghubMode: metadata.minimaxRunningHubMode, runninghubWorkflowId: metadata.minimaxRunningHubWorkflowId, runninghubAppId: metadata.minimaxRunningHubAppId, runninghubFields: runningHubFields, runninghubParams: runningHubParams, runninghubWorkflowJson: metadata.minimaxRunningHubWorkflowJson, useWallet: metadata.minimaxRunningHubUseWallet === true, ...(autoSplit && storedSegments.length === 1 ? { autoSplit: true, segmentDuration: Number(segmentDuration), maxSegments: Number(maxSegments) } : {}) }, { onTaskId: (taskId) => {
                    console.log("[minimax-h3] onTaskId received", { nodeId: ctx.node.id, segmentId: segment.id, taskId, generationLogId });
                    update({ runtimeTaskId: taskId, runtimeTargetSegmentId: segment.id, runProgress: 0.1 });
                    markRequestedSegments({ runtimeTaskId: taskId, progress: 0.1 });
                    // 把 taskId 同步写进 generation log，让 useH3TaskPolling 的 recoverTask
                    // 在 metadata.runtimeTaskId 丢失时仍能通过 log 找回 taskId，
                    // 否则节点会卡在 "生成中" 永远出不来。
                    if (generationLogId) {
                        ctx.generationLogs.update(generationLogId, { status: "running", runtimeTaskId: taskId })
                            .catch((error) => console.warn("[minimax-h3] failed to record running taskId to log", error));
                    }
                } });
                lastResult = segmentResult;
                if (autoSplit && segmentResult.segments?.length) {
                    nextSegments.push(...mapAutoSplitSegments(segment, segmentResult.segments, prompt, Number(segmentDuration)));
                    const current = segmentsFor(ctx.getNode(ctx.node.id)?.metadata || liveMetadata);
                    update({ segments: compactSegmentStarts(current.map((item) => nextSegments.find((generated) => generated.id === item.id) || item)) });
                    break;
                }
                previousVideo = { name: `h3-segment-${index + 1}.mp4`, url: segmentResult.url, ...(segmentResult.storageKey ? { storageKey: segmentResult.storageKey } : {}) };
                nextSegments.push({ ...segmentForRun, prompt: String(segment.prompt || prompt), duration: Number(segment.duration || duration), result: segmentResult.url, resultStorageKey: segmentResult.storageKey, results: [{ url: segmentResult.url, storageKey: segmentResult.storageKey, type: "video", name: `Clip ${index + 1}` }], status: "success", progress: 1 });
                // 每个 Clip 成功后立即写回，避免后续 Clip 失败时丢失前面已完成的产物。
                const current = segmentsFor(ctx.getNode(ctx.node.id)?.metadata || liveMetadata);
                update({ segments: compactSegmentStarts(current.map((item) => nextSegments.find((generated) => generated.id === item.id) || item)) });
            }
            if (!lastResult) throw new Error("没有可运行的 H3 分段");
            const mergedSegments = compactSegmentStarts(mergeH3Segments(allSegments, nextSegments, activeId, runFromCurrent, autoSplit && storedSegments.length === 1));
            // 优先用当前选中段；若已切换/删除则按 URL 反查源 Clip
            const lastSource = mergedSegments.find((item) => item.id === liveSelectedId)
                || mergedSegments.find((item) => {
                    const directMatch = resultUrl(item.result) === lastResult.url;
                    const resultsMatch = (item.results || []).some((entry) => entry.url === lastResult.url);
                    return directMatch || resultsMatch;
                });
            const generatedMaterials = generatedVideoMaterials(mergedSegments);
            update({ content: lastResult.url, storageKey: lastResult.storageKey, mimeType: lastResult.mimeType, naturalWidth: lastResult.width, naturalHeight: lastResult.height, durationMs: lastResult.durationMs, segments: mergedSegments, materials: appendVideoMaterials(liveMetadata.materials, [...generatedMaterials, { url: lastResult.url, storageKey: lastResult.storageKey, type: "video", name: `Clip ${liveSelectedId || "输出"}`, segmentId: liveSelectedId, params: restorableParams(lastSource as unknown as Record<string, unknown> | undefined) }]), runtimeTaskId: "", status: "success", errorDetails: "", runtimeTargetSegmentId: undefined, runFinishedAt: Date.now() });
            if (generationLogId) void ctx.generationLogs.update(generationLogId, { status: "success", runtimeTaskId: lastResult.taskId, finishedAt: new Date().toISOString(), durationMs: Date.now() - Number(liveMetadata.runStartedAt || Date.now()), outputs: [{ url: lastResult.url, storageKey: lastResult.storageKey, type: "video", mimeType: lastResult.mimeType }] });
        } catch (error) {
            // 增强错误日志：包含实际提交信息
            const errorMessage = error instanceof Error ? error.message : String(error);
            const debugInfo = `[h3-run] taskMode=${lastSubmitted.taskMode}, video=${lastSubmitted.video}, images=${lastSubmitted.images}, audios=${lastSubmitted.audios}, model=${lastSubmitted.model}, latentUpscale=${lastSubmitted.latentUpscaleEnabled}, latentUpscaleModel=${lastSubmitted.latentUpscaleModel}`;
            const enhancedError = errorMessage.includes(debugInfo) ? errorMessage : `${errorMessage}\n${debugInfo}`;
            const current = segmentsFor(ctx.getNode(ctx.node.id)?.metadata || liveMetadata);
            const errorStart = Math.max(0, current.findIndex((segment) => segment.id === liveSelectedId));
            const errorIds = new Set((runFromCurrent ? current.slice(errorStart) : current.filter((segment) => segment.id === liveSelectedId)).map((segment) => segment.id));
            // 优先级：comfyui 抛出 H3RunCancelled > 节点 cancelRequested 标志 > 真正失败
            const cancelled = error instanceof Error && error.name === "H3RunCancelled" || Boolean((ctx.getNode(ctx.node.id)?.metadata || liveMetadata).cancelRequested);
            // catch 块同时清掉 segments 里的 runtimeTaskId / runProgress，避免出错后 segments
            // 还残留上一个 onTaskId 写入的 taskId，触发 useH3TaskPolling 继续轮询一个不再存在的 task。
            update({
                segments: current.map((segment) => errorIds.has(segment.id)
                    ? { ...segment, status: cancelled ? "cancelled" : "error", progress: 0, runtimeTaskId: "", errorDetails: cancelled ? "任务已取消" : enhancedError }
                    : segment),
                status: cancelled ? "cancelled" : "error",
                errorDetails: cancelled ? "任务已取消" : enhancedError,
                runFinishedAt: Date.now(),
                runtimeTaskId: "",
                runtimeTargetSegmentId: undefined,
            });
            if (generationLogId) void ctx.generationLogs.update(generationLogId, { status: cancelled ? "cancelled" : "failed", finishedAt: new Date().toISOString(), durationMs: Date.now() - Number(liveMetadata.runStartedAt || Date.now()), error: enhancedError, params: { ...lastSubmitted } });
        } finally {
            runInFlightRef.current = false;
        }
    };

    useH3RunEvents(ctx, run, update);

    return null;

}
