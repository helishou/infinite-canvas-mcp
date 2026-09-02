import { useMemo, useRef } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { H3Ref, H3Segment } from "../types";
import { defaultH3Model, defaultPrompt } from "../constants";
import { compatibleH3Settings, normalizeH3Model } from "../services/h3-compatibility";
import { segmentsFor, compactSegmentStarts } from "../hooks/useH3Segments";
import { appendVideoMaterials, refsForSegment } from "../services/h3-data";
import { readH3Refs } from "../services/h3-refs";
import { createH3Log } from "../services/h3-logs";
import { useH3TaskPolling } from "../hooks/useH3TaskPolling";
import { useH3RunEvents } from "../hooks/useH3RunEvents";
import { generatedVideoMaterials, mapAutoSplitSegments, mergeH3Segments } from "../services/h3-runner-utils";

export function H3Runner({ ctx }: { ctx: CanvasNodeContext }) {
    const metadata = ctx.node.metadata || {};
    const upstream = useMemo(() => readH3Refs(ctx), [ctx.node.id, ctx.getConnections().length, ctx.getNodes().length]);
    const textModels = ctx.ai.listModels("text");
    const combatLoraWeight = String(metadata.combatLoraWeight || metadata.minimaxCombatLoraWeight || "0");
    const cinematicLoraWeight = String(metadata.cinematicLoraWeight || metadata.minimaxCinematicLoraWeight || "0");
    const teAccel = metadata.teAccel === true || metadata.minimaxTeAccel === true;
    const promptEnhance = metadata.promptEnhance === true || metadata.minimaxPromptEnhance === true;
    const promptEnhanceLanguage = String(metadata.promptEnhanceLanguage || metadata.minimaxPromptEnhanceLanguage || "zh");
    const promptEnhanceModel = String(metadata.minimaxLlmModel || metadata.llmModel || ctx.ai.defaultModel("text") || textModels[0]?.value || "");
    const motionNoise = Boolean(metadata.motionContextNoiseEnabled);
    const noiseAlpha = String(metadata.motionContextNoiseAlpha ?? "0.45");
    const noiseAlphaEnd = String(metadata.motionContextNoiseAlphaEnd ?? "0.10");
    const noiseRampFrames = String(metadata.motionContextNoiseRampFrames ?? "3");
    const autoSplit = Boolean(metadata.autoSplit);
    const segmentDuration = Number(metadata.segmentDuration ?? "6");
    const maxSegments = Number(metadata.maxSegments ?? "60");
    const runningHubFields = Array.isArray(metadata.minimaxRunningHubFields) ? metadata.minimaxRunningHubFields : [];
    const runningHubParams = metadata.minimaxRunningHubParams && typeof metadata.minimaxRunningHubParams === "object" ? metadata.minimaxRunningHubParams : {};
    metadata.minimaxRunningHubFields = runningHubFields;
    metadata.minimaxRunningHubParams = runningHubParams;
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
        const liveDenoise = Number(liveSelected?.denoise ?? liveMetadata.denoise ?? 0.65);
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
        // 读取所有 segment 的 taskMode，t2v 不需要校验素材连接
        const hasT2vSegment = liveSegments.some((seg) => String(seg.taskMode || "r2v") === "t2v");
        const needsMaterialValidation = !hasT2vSegment && !video && !images.length;
        if (needsMaterialValidation) {
            update({ status: "error", errorDetails: "请先连接源视频或角色参考图。" });
            return;
        }
        if (runInFlightRef.current) return;
        runInFlightRef.current = true;
        const logRefs = [...images, ...(video ? [video] : []), ...audios] as H3Ref[];
        const generationLog = await createH3Log(ctx, liveSelected, livePrompt, logRefs, { engine: liveMetadata.minimaxEngine || "comfyui", workflow: "MiniMax H3", modelName: liveModelName, taskMode: liveSelected?.taskMode || "r2v", duration: liveDuration, aspectRatio: liveRatio, megapixels: liveMegapixels, videoSteps: liveSteps, denoise: liveDenoise, seed: liveSeed });
        const generationLogId = generationLog?.id || "";
        update({ prompt: livePrompt, duration: liveDuration, aspectRatio: liveRatio, megapixels: liveMegapixels, videoSteps: liveSteps, denoise: liveDenoise, seed: String(liveSeed).trim() ? Number(liveSeed) : undefined, modelName: liveModelName, minimaxBaseModel: liveModelName, loraName: liveLoraName, combatLoraWeight: Number(liveSelected?.combatLoraWeight ?? liveMetadata.minimaxCombatLoraWeight ?? combatLoraWeight), cinematicLoraWeight: Number(liveSelected?.cinematicLoraWeight ?? liveMetadata.minimaxCinematicLoraWeight ?? cinematicLoraWeight), teAccel: liveMetadata.minimaxGlobalTeAccel === true || teAccel, promptEnhance, promptEnhanceLanguage, motionContextEnabled: liveMotion, motionContextNoiseEnabled: liveSelected?.motionContextNoiseEnabled === true || liveMetadata.motionContextNoiseEnabled === true || motionNoise, motionContextNoiseAlpha: Number(liveSelected?.motionContextNoiseAlpha ?? liveMetadata.motionContextNoiseAlpha ?? noiseAlpha), motionContextNoiseAlphaEnd: Number(liveSelected?.motionContextNoiseAlphaEnd ?? liveMetadata.motionContextNoiseAlphaEnd ?? noiseAlphaEnd), motionContextNoiseRampFrames: Number(liveSelected?.motionContextNoiseRampFrames ?? liveMetadata.motionContextNoiseRampFrames ?? noiseRampFrames), model: selectedModel, status: "loading", errorDetails: "", runStartedAt: Date.now() });
        const lastSubmitted = { taskMode: "", video: 0, images: 0, audios: 0, model: "" };
        try {
            let effectivePrompt = livePrompt;
            if (promptEnhance) {
                const enhanced = await ctx.ai.generateText(livePrompt, { model: String(liveMetadata.minimaxLlmModel || liveMetadata.llmModel || promptEnhanceModel), system: `你是 MiniMax H3 视频提示词整理器。用${promptEnhanceLanguage === "en" ? "英文" : "中文"}输出一条完整提示词，只补充镜头、动作、主体一致性和时序信息，不改变用户意图，不添加免责声明。` });
                if (enhanced.text.trim()) effectivePrompt = enhanced.text.trim();
            }
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
            let previousVideo: { name: string; url: string; storageKey?: string } | undefined;
            let lastResult: Awaited<ReturnType<typeof ctx.ai.runLocalH3>> | undefined;
            const nextSegments: H3Segment[] = [];
            // 用于错误日志记录最后一次提交的信息
            for (const [index, segment] of storedSegments.entries()) {
                const segmentRefs = refsForSegment(segment);
                const requestedTaskMode = String(segment.taskMode || "r2v");
                // t2v：只使用纯提示词，忽略所有素材
                // i2v/fl2v：只使用图片
                // v2v：只使用视频
                // rv2v/r2v：使用视频+图片+音频
                const isT2v = requestedTaskMode === "t2v";
                const isV2v = requestedTaskMode === "v2v";
                const isI2vFl2v = requestedTaskMode === "i2v" || requestedTaskMode === "fl2v";
                const isR2vOrRv2v = !isT2v && !isV2v && !isI2vFl2v;
                const effectiveTaskMode = isR2vOrRv2v && requestedTaskMode === "rv2v" && !segmentRefs.some((ref) => ref.type === "video") && !video ? "r2v" : requestedTaskMode;
                const segmentVideo = !isT2v && !isI2vFl2v ? (segmentRefs.find((ref) => ref.type === "video") || (index === 0 ? video : undefined)) : undefined;
                const segmentImages = isT2v || isV2v ? [] : segmentRefs.filter((ref) => ref.type === "image");
                const segmentAudios = isT2v || isV2v || isI2vFl2v ? [] : segmentRefs.filter((ref) => ref.type === "audio");
                // t2v 模式下不传递任何图片给 compatibleH3Settings，避免影响模型选择
                const upstreamForSettings = isT2v ? [] : [...images, ...(video ? [video] : [])];
                const segmentSettings = compatibleH3Settings({ ...segment, taskMode: effectiveTaskMode }, liveModelName, liveLoraName, upstreamForSettings);
                const segmentSteps = Number(segment.videoSteps || liveMetadata.minimaxGlobalVideoSteps || segmentSettings.defaultSteps);
                const h3Runner = String(liveMetadata.minimaxEngine || "").toLowerCase() === "runninghub" ? ctx.ai.runRunningHubH3 : ctx.ai.runLocalH3;
                const segmentPrompt = promptEnhance ? effectivePrompt : segment.prompt !== undefined ? String(segment.prompt) : effectivePrompt;
                const promptFlags = `${segment.noDub !== false ? "\nNo dialogue, narration, voiceover, or singing." : ""}${segment.noCaption !== false ? "\nNo subtitles, captions, on-screen text, or text overlays." : ""}`;
                // 根据任务模式决定提交哪些 refs
                // 透传 storageKey：后端媒体引用（图片/视频/音频）直接用 storageKey 复用，
                // 避免只留 url 时 extractStorageKey 反推出被 URL 编码的 key（如 image%3A<uuid>）
                // 导致后端查不到（404）或退化到 dataUrl 分支（400 畸形 data URL）。
                const finalReferences = isT2v || isV2v ? [] : (segmentImages.length ? segmentImages : isI2vFl2v ? [] : images).map((ref) => ({ name: `${ref.name}.png`, url: ref.url, storageKey: ref.storageKey }));
                const finalVideo = !isT2v && !isI2vFl2v ? (segmentVideo ? { name: `${segmentVideo.name}.mp4`, url: segmentVideo.url, storageKey: segmentVideo.storageKey } : undefined) : undefined;
                const finalAudios = isR2vOrRv2v ? (segmentAudios.length ? segmentAudios : audios).map((ref) => ({ name: `${ref.name}.mp3`, url: ref.url, storageKey: ref.storageKey })) : [];
                // 记录提交信息用于错误日志
                lastSubmitted.taskMode = effectiveTaskMode;
                lastSubmitted.video = finalVideo ? 1 : 0;
                lastSubmitted.images = finalReferences.length;
                lastSubmitted.audios = finalAudios.length;
                lastSubmitted.model = segmentSettings.modelName;
                const segmentResult = await h3Runner(`${segmentPrompt}${promptFlags}`, {
                    video: finalVideo,
                    references: finalReferences,
                    audios: finalAudios,
                    previousVideo,
                }, { duration: Number(segment.duration || duration), aspectRatio: String(segment.aspectRatio || ratio), megapixels: Number(segment.megapixels || megapixels), videoSteps: segmentSteps, denoise: Number(segment.denoise ?? denoise), ...(segment.noiseSeedMode === "fixed" && String(segment.noiseSeed ?? segment.seed ?? "").trim() ? { seed: Number(segment.noiseSeed ?? segment.seed) } : {}), modelName: segmentSettings.modelName, loraName: segmentSettings.loraName, combatLoraWeight: Number(segment.combatLoraWeight ?? 0), cinematicLoraWeight: Number(segment.cinematicLoraWeight ?? 0), teAccel: segment.teAccel ?? teAccel, taskMode: effectiveTaskMode, audioMode: String(segment.audioMode || "native"), audioDenoiseStrength: Number(segment.audioDenoiseStrength ?? 1), addSourceAsReference: segment.addSourceAsReference === true, promptPrimaryAudioOrdinal: Number(segment.promptPrimaryAudioOrdinal || 0), strictPromptTags: segment.strictPromptTags !== false, referenceVideoPolicy: String(segment.referenceVideoPolicy || "official_2_to_15s"), refImageSize: String(segment.refImageSize || "match"), motionContext: (autoSplit || index > 0) && segment.motionContextEnabled !== false && motion, motionContextNoise: (autoSplit || index > 0) && segment.motionContextNoiseEnabled !== false && motionNoise, motionContextNoiseAlpha: Number(segment.motionContextNoiseAlpha ?? noiseAlpha), motionContextNoiseAlphaEnd: Number(segment.motionContextNoiseAlphaEnd ?? noiseAlphaEnd), motionContextNoiseRampFrames: Number(segment.motionContextNoiseRampFrames ?? noiseRampFrames), runninghubMode: metadata.minimaxRunningHubMode, runninghubWorkflowId: metadata.minimaxRunningHubWorkflowId, runninghubAppId: metadata.minimaxRunningHubAppId, runninghubFields: metadata.minimaxRunningHubFields, runninghubParams: metadata.minimaxRunningHubParams, runninghubWorkflowJson: metadata.minimaxRunningHubWorkflowJson, useWallet: metadata.minimaxRunningHubUseWallet === true, ...(autoSplit && storedSegments.length === 1 ? { autoSplit: true, segmentDuration: Number(segmentDuration), maxSegments: Number(maxSegments) } : {}) }, { onTaskId: (taskId) => { update({ runtimeTaskId: taskId, runProgress: 0.1 }); markRequestedSegments({ runtimeTaskId: taskId, progress: 0.1 }); if (generationLogId) void ctx.generationLogs.update(generationLogId, { status: "running", runtimeTaskId: taskId }); } });
                lastResult = segmentResult;
                if (autoSplit && segmentResult.segments?.length) {
                    nextSegments.push(...mapAutoSplitSegments(segment, segmentResult.segments, prompt, Number(segmentDuration)));
                    break;
                }
                previousVideo = { name: `h3-segment-${index + 1}.mp4`, url: segmentResult.url, storageKey: segmentResult.storageKey };
                nextSegments.push({ ...segment, prompt: String(segment.prompt || prompt), duration: Number(segment.duration || duration), result: segmentResult.url, resultStorageKey: segmentResult.storageKey, results: [{ url: segmentResult.url, storageKey: segmentResult.storageKey, type: "video", name: `Clip ${index + 1}` }], status: "success", progress: 1 });
            }
            if (!lastResult) throw new Error("没有可运行的 H3 分段");
            const mergedSegments = compactSegmentStarts(mergeH3Segments(allSegments, nextSegments, activeId, runFromCurrent, autoSplit && storedSegments.length === 1));
            const generatedMaterials = generatedVideoMaterials(mergedSegments);
            update({ content: lastResult.url, storageKey: lastResult.storageKey, mimeType: lastResult.mimeType, naturalWidth: lastResult.width, naturalHeight: lastResult.height, durationMs: lastResult.durationMs, segments: mergedSegments, materials: appendVideoMaterials(liveMetadata.materials, [...generatedMaterials, { url: lastResult.url, storageKey: lastResult.storageKey, type: "video", name: `Clip ${liveSelectedId || "输出"}` }]), runtimeTaskId: lastResult.taskId, status: "success", errorDetails: "", runFinishedAt: Date.now() });
            if (generationLogId) void ctx.generationLogs.update(generationLogId, { status: "success", runtimeTaskId: lastResult.taskId, finishedAt: new Date().toISOString(), durationMs: Date.now() - Number(liveMetadata.runStartedAt || Date.now()), outputs: [{ url: lastResult.url, storageKey: lastResult.storageKey, type: "video", mimeType: lastResult.mimeType }] });
        } catch (error) {
            // 增强错误日志：包含实际提交信息
            const errorMessage = error instanceof Error ? error.message : String(error);
            const debugInfo = `[h3-run] taskMode=${lastSubmitted.taskMode}, video=${lastSubmitted.video}, images=${lastSubmitted.images}, audios=${lastSubmitted.audios}, model=${lastSubmitted.model}`;
            const enhancedError = errorMessage.includes(debugInfo) ? errorMessage : `${errorMessage}\n${debugInfo}`;
            const current = segmentsFor(ctx.getNode(ctx.node.id)?.metadata || liveMetadata);
            const errorStart = Math.max(0, current.findIndex((segment) => segment.id === liveSelectedId));
            const errorIds = new Set((runFromCurrent ? current.slice(errorStart) : current.filter((segment) => segment.id === liveSelectedId)).map((segment) => segment.id));
            const cancelled = Boolean((ctx.getNode(ctx.node.id)?.metadata || liveMetadata).cancelRequested);
            update({ segments: current.map((segment) => errorIds.has(segment.id) ? { ...segment, status: cancelled ? "cancelled" : "error", progress: 0 } : segment), status: cancelled ? "cancelled" : "error", errorDetails: cancelled ? "任务已取消" : enhancedError, runFinishedAt: Date.now(), runtimeTaskId: "" });
            if (generationLogId) void ctx.generationLogs.update(generationLogId, { status: "failed", finishedAt: new Date().toISOString(), durationMs: Date.now() - Number(liveMetadata.runStartedAt || Date.now()), error: enhancedError, params: { ...lastSubmitted } });
        } finally {
            runInFlightRef.current = false;
        }
    };

    useH3RunEvents(ctx, run, update);

    return null;

}
