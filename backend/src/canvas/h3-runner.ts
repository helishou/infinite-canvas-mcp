import { spawn } from "node:child_process";

import type { RuntimeTask } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import type { RunningHubBackend } from "../runtime/runninghub.js";
import type { Stores } from "../stores/types.js";
import { writeBackH3Task } from "./h3-task-writeback.js";

type H3RunInput = {
    projectId: string;
    nodeId?: string;
    nodeIds?: string[];
    segmentId?: string;
    segmentIndex?: number;
    runFromCurrent?: boolean;
    skipCompleted?: boolean;
    params?: Record<string, unknown>;
};

type H3Ref = Record<string, unknown> & { url?: string; storageKey?: string; name?: string; type?: string; role?: string; order?: number };
type H3Segment = Record<string, unknown> & { id?: string; prompt?: string; result?: string; resultStorageKey?: string; refItems?: H3Ref[]; refs?: Record<string, H3Ref | H3Ref[]>; continuationGroupId?: string; motionContextEnabled?: boolean };
type H3Plan = { nodeId: string; segmentId: string; segmentIndex: number; continuation?: { group: string; index: number } };

const H3_DEFAULTS_KEY = "plugin:minimax-h3:defaults:v1";
const H3_PARAM_KEYS = [
    "mode", "taskMode", "duration", "aspectRatio", "megapixels", "videoSteps", "steps", "denoise", "noiseSeedMode", "noiseSeed", "seed",
    "modelName", "textEncoder", "textEncoderType", "textEncoderDevice", "videoVae", "audioVae", "precision", "sageAttention", "allowCompile", "sizeMultiple", "sampler", "scheduler",
    "loraSlots", "constantTriggerWord", "lockAudio", "audioDrive", "audioDriveFile", "audioDriveMarkers", "audioDriveSegmentImages", "audioDriveSegmentStoryboards", "audioDriveCreative", "audioDriveExclude", "audioDriveStart", "audioDriveEnd",
    "solAttnEnabled", "solAttnTau", "solAttnThresholdType", "solAttnExactMode", "solAttnDenseSteps", "solAttnStepOff", "solAttnSinkTokens",
    "t8Enabled", "t8ResidualThreshold", "t8StartPercent", "t8EndPercent", "t8MaxConsecutiveHits", "t8CacheDevice", "t8MetricStride", "t8Verbose",
    "sigmaEnabled", "videoSigmaShift", "audioSigmaShift", "sigmaMode", "lowSigmaStart", "lowSigmaEnd", "sigmaRefineSteps", "sigmaCurve", "manualSigma", "dualSampling", "dualSamplingRatio", "dualSampler",
    "secondPassEnabled", "firstPassSteps", "secondPassSteps", "secondPassMegapixels", "secondPassUpscaleMethod", "secondPassDenoise", "secondPassSampler", "secondPassScheduler", "secondPassModel", "secondPassSigma",
    "dedicatedAttention", "startupMode", "faceRepairSingle", "faceRepairMulti", "globalRepair", "lowMemoryAttentionHeads", "reservedVramGb", "runtimeReserveEnabled", "uniBlockSwapEnabled", "uniBlockSwapBlocks", "keepModelCache",
    "latentUpscaleEnabled", "h3FirstSteps", "h3SecondSteps", "h3FullSigma", "v81ManualSigma", "latentUpscaleModel", "latentUpscaleMegapixels", "latentUpscaleAlign", "latentUpscalePrecision",
    "realtimePreviewEnabled", "realtimePreviewLongEdge", "realtimePreviewFrames", "realtimePreviewFps", "realtimePreviewJpegQuality",
    "rtxEnabled", "rtxResizeMode", "rtxScale", "rtxWidth", "rtxHeight", "rtxQuality",
    "slaEnabled", "slaSparsity", "slaBlockSize", "slaMinSequence", "slaDenseLastSteps", "slaProtectAudio", "slaDenseSteps", "slaBackend", "slaDisableFp16Accum", "slaStabilizeMotion",
    "emptyFiveMinuteTimeline", "taeh3Enabled", "contextLength", "audioContextLength", "continuationTask", "continuationAudioRefineEnabled", "continuationAudioDenoise", "continuationAudioSteps", "continuationAudioSampler", "continuationAudioScheduler", "trtVideoVaeEnabled", "trtDecoderEngine", "trtEncoderEngine", "dlssUpscaleMode", "dlssFrameInterpolationEnabled", "dlssVideoUpscaleMode", "dlssVideoRequireNeuralUpscaling", "dlssVideoNrPreset", "dlssVideoNrStyle", "dlssVideoNrIntensity", "dlssVideoLocalToneStrength", "dlssVideoLocalStructureStrength", "dlssVideoSkinStructureStrength", "dlssVideoAutomaticMask", "dlssVideoModelPreset", "dlssVideoEncodingQuality", "dlssVideoCodec", "dlssVideoContainer", "dlssVideoRename", "dlssVideoCustomSuffix", "dlssVideoHdrMode", "dlssVideoOutputDetailStrength", "dlssFgOutputFps", "dlssFgEngine", "dlssFgEncodingQuality", "dlssFgVideoCodec", "dlssFgContainer", "dlssFgRename", "dlssFgCustomSuffix", "dlssFgHdrMode", "erSolverType", "erMaxStage", "erEta", "erSNoise",
    "refImageSize", "referenceLongEdge", "loraName", "loraStrength", "teAccel", "noDub", "noCaption", "audioMode", "audioDenoiseStrength", "addSourceAsReference", "promptPrimaryAudioOrdinal", "strictPromptTags",
    "referenceVideoPolicy", "trimIn", "trimOut", "motionContextEnabled", "tailFrameContinuation", "previousVideoAsReference", "motionContextNoiseEnabled", "motionContextNoiseAlpha", "motionContextNoiseAlphaEnd", "motionContextNoiseRampFrames", "combatLoraWeight", "cinematicLoraWeight",
] as const;

export class CanvasH3Runner {
    private readonly currentChildren = new Map<string, string>();
    private readonly cancelled = new Set<string>();

    constructor(
        private readonly stores: Stores,
        private readonly events: BackendEventBus,
        private readonly comfy: ComfyUiBackend,
        private readonly runningHub: RunningHubBackend,
    ) {}

    start(input: H3RunInput, clientTaskId?: string) {
        const normalized = normalizeInput(input);
        if (!this.stores.projects.get(normalized.projectId)) throw new Error(`画布不存在: ${normalized.projectId}`);
        const existing = clientTaskId ? this.stores.tasks.get(clientTaskId) : null;
        if (existing) return existing;
        const duplicate = this.findActiveDuplicate(normalized);
        if (duplicate) return duplicate;
        const task = clientTaskId
            ? this.stores.tasks.create(clientTaskId, "canvas-h3-run", normalized, {})
            : this.stores.tasks.create("canvas-h3-run", normalized, {});
        this.publish(task, "task.created");
        this.bindParent(task);
        void this.execute(task).catch((error) => this.fail(task.id, error));
        return task;
    }

    /**
     * 幂等边界必须落在 H3 编排器，而不是依赖每个调用方传来的随机 key。
     * 浏览器刷新、MCP 重试、SSE 重连都可能产生不同的 key；只按 key 去重
     * 会再次创建父任务，进而再次创建 ComfyUI 子任务。
     */
    private findActiveDuplicate(input: H3RunInput) {
        const project = this.stores.projects.get(input.projectId);
        if (!project) return null;
        const requested = new Set(this.targetKeys(project, input));
        if (!requested.size) return null;
        return this.stores.tasks.list({ kind: "canvas-h3-run", projectId: input.projectId, limit: 500 })
            .filter((task) => task.status === "queued" || task.status === "running")
            .find((task) => this.targetKeys(project, normalizeInput(task.input as H3RunInput)).some((key) => requested.has(key))) || null;
    }

    private targetKeys(project: Record<string, unknown>, input: H3RunInput) {
        const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
        const wanted = input.nodeIds?.length ? new Set(input.nodeIds) : input.nodeId ? new Set([input.nodeId]) : null;
        return nodes
            .filter((node) => String(node.type || "").includes("minimax") && (!wanted || wanted.has(String(node.id || ""))))
            .flatMap((node) => this.planNode(node, input).map((plan) => `${plan.nodeId}:${plan.segmentId}`));
    }

    resume(task: RuntimeTask) {
        if (task.kind !== "canvas-h3-run" || !["queued", "running"].includes(task.status)) return task;
        void this.execute(task).catch((error) => this.fail(task.id, error));
        return task;
    }

    /**
     * 修复已落库的终态父任务：任务事件是权威结果，节点 metadata 只是投影。
     * 后端在写回窗口内重启，或旧版本静默吞掉回写失败时，节点可能长期停在 loading；
     * 启动时重放缺失的 Clip 回写，再按父任务终态收口节点状态。
     */
    async reconcileTerminal(task: RuntimeTask) {
        if (task.kind !== "canvas-h3-run" || !["succeeded", "failed", "cancelled"].includes(task.status)) return;
        const projectId = String((task.input as H3RunInput)?.projectId || "");
        if (!projectId) return;
        const completed = this.stores.tasks.events(task.id).filter((event) => event.type === "clip_completed");
        for (const event of completed) {
            const childId = String(event.payload.childTaskId || "");
            const child = childId ? this.stores.tasks.get(childId) : null;
            if (!child || !["succeeded", "failed", "cancelled"].includes(child.status)) continue;
            const nodeId = String(event.payload.nodeId || "");
            const segmentId = String(event.payload.segmentId || "");
            const project = this.stores.projects.get(projectId);
            const node = project && (project.nodes as Array<Record<string, unknown>>).find((item) => String(item.id || "") === nodeId);
            const segments = node ? recordOf(node.metadata).segments : undefined;
            const segment = Array.isArray(segments) ? segments.find((item) => String(recordOf(item).id || "") === segmentId) as Record<string, unknown> | undefined : undefined;
            const output = resultVideo(child);
            const expectedStatus = child.status === "succeeded" ? "success" : child.status === "cancelled" ? "cancelled" : "error";
            const alreadyWritten = segment && String(segment.status || "") === expectedStatus && !String(segment.runtimeTaskId || "")
                && (!output || String(segment.resultStorageKey || "") === String(output.storageKey || ""));
            if (alreadyWritten) continue;
            await writeBackH3Task(this.stores, this.events, child);
        }
        this.finishParentNode(task, task.status === "succeeded" ? "success" : task.status === "cancelled" ? "cancelled" : "error", task.error || "");
    }

    cancel(id: string) {
        this.cancelled.add(id);
        const childId = this.currentChildren.get(id);
        if (childId) {
            this.cancelChild(childId);
            const child = this.stores.tasks.get(childId);
            if (child) void writeBackH3Task(this.stores, this.events, child);
        }
        const task = this.stores.tasks.cancel(id);
        this.finishParentNode(task, "cancelled", "任务已取消");
        this.publish(task, "task.updated");
        return task;
    }

    private async execute(initial: RuntimeTask) {
        const input = normalizeInput(initial.input as H3RunInput);
        let task = this.update(initial.id, { status: "running", progress: initial.progress || 0 });
        const project = this.stores.projects.get(input.projectId)!;
        const allNodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
        const wanted = input.nodeIds?.length ? new Set(input.nodeIds) : input.nodeId ? new Set([input.nodeId]) : null;
        const nodes = allNodes.filter((node) => String(node.type || "").includes("minimax") && (!wanted || wanted.has(String(node.id || ""))));
        if (!nodes.length) throw new Error("指定画布中没有可运行的 MiniMax H3 节点");
        const plans = nodes.flatMap((node) => this.planNode(node, input));
        if (!plans.length) throw new Error("没有符合条件的 H3 Clip");
        const completedEvents = this.stores.tasks.events(task.id).filter((event) => event.type === "clip_completed");
        const completed = new Set(completedEvents.map((event) => `${event.payload.nodeId}:${event.payload.segmentId}`));
        const outputs = completedEvents.map((event) => recordOf(event.payload.output)).filter((output) => output.url);
        const children = completedEvents.map((event) => String(event.payload.childTaskId || "")).filter(Boolean);

        for (let planIndex = 0; planIndex < plans.length; planIndex++) {
            this.assertActive(task.id);
            const plan = plans[planIndex];
            const key = `${plan.nodeId}:${plan.segmentId}`;
            if (completed.has(key)) continue;
            const priorEvent = [...this.stores.tasks.events(task.id)].reverse().find((event) => event.type === "child_started" && `${event.payload.nodeId}:${event.payload.segmentId}` === key);
            let child = priorEvent ? this.stores.tasks.get(String(priorEvent.payload.childTaskId || "")) : null;
            if (!child || child.status === "failed" || child.status === "cancelled") child = await this.startChild(task, plan, input.params || {});
            this.currentChildren.set(task.id, child.id);
            if (!children.includes(child.id)) children.push(child.id);
            task = this.update(task.id, { result: { ...recordOf(task.result), currentChildTaskId: child.id, currentChildKind: child.kind, children, media: outputs } });
            child = await this.waitForTerminal(task.id, child.id);
            this.currentChildren.delete(task.id);
            const written = await writeBackH3Task(this.stores, this.events, child);
            if (!written) throw new Error(`Clip ${plan.segmentIndex + 1} 终态回写失败：片段可能已被其他任务接管，父任务未标记成功`);
            if (child.status !== "succeeded") throw new Error(child.error || `Clip ${plan.segmentIndex + 1} 生成${child.status === "cancelled" ? "已取消" : "失败"}`);
            const output = resultVideo(child);
            if (!output) throw new Error(`Clip ${plan.segmentIndex + 1} 生成成功但没有视频结果`);
            outputs.push(output);
            this.stores.tasks.addEvent(task.id, "clip_completed", { nodeId: plan.nodeId, segmentId: plan.segmentId, childTaskId: child.id, output });
            task = this.update(task.id, { progress: (planIndex + 1) / plans.length, result: { children, media: outputs, ...output } });
            this.updateNode(input.projectId, plan.nodeId, { runtimeTaskId: task.id, status: "loading", runProgress: task.progress });
        }
        task = this.update(task.id, { status: "succeeded", progress: 1, result: { children, media: outputs, ...(outputs.at(-1) || {}) } });
        this.finishParentNode(task, "success");
        this.currentChildren.delete(task.id);
        this.cancelled.delete(task.id);
    }

    private planNode(node: Record<string, unknown>, input: H3RunInput) {
        const metadata = recordOf(node.metadata);
        const segments = Array.isArray(metadata.segments) ? metadata.segments as H3Segment[] : [];
        if (!segments.length) return [];
        const selected = input.segmentId
            ? segments.findIndex((segment) => String(segment.id || "") === input.segmentId)
            : input.segmentIndex ?? Math.max(0, segments.findIndex((segment) => !segment.result));
        if (selected < 0) throw new Error(`找不到 H3 片段: ${input.segmentId}`);
        const selectedSegment = segments[selected];
        const continuationMode = selectedSegment.motionContextEnabled === true;
        if (continuationMode && !input.runFromCurrent) throw new Error("V15 潜空间续写必须使用「运行当前及后续分镜」，不能单独运行一个 Clip。");
        if (continuationMode && input.skipCompleted) throw new Error("V15 潜空间续写不能跳过已完成 Clip，请从连续组首段重新运行。");
        const indices = input.runFromCurrent ? segments.map((_, index) => index).filter((index) => index >= selected) : [selected];
        let continuationIndex = 0;
        const continuationGroup = String(selectedSegment.continuationGroupId || selectedSegment.id || `segment-${selected}`);
        return indices.filter((index) => segments[index]).filter((index) => !input.skipCompleted || !segments[index].result).map((segmentIndex) => {
            const segment = segments[segmentIndex];
            if (!segment.id) throw new Error(`H3 Clip ${segmentIndex + 1} 缺少身份标识`);
            return { nodeId: String(node.id || ""), segmentId: String(segment.id), segmentIndex, ...(continuationMode ? { continuation: { group: continuationGroup, index: ++continuationIndex } } : {}) };
        });
    }

    private async startChild(parent: RuntimeTask, plan: H3Plan, override: Record<string, unknown>) {
        const project = this.stores.projects.get(String(parent.input.projectId))!;
        const node = (project.nodes as Array<Record<string, unknown>>).find((item) => String(item.id || "") === plan.nodeId)!;
        const metadata = recordOf(node.metadata);
        const segments = metadata.segments as H3Segment[];
        const segment = segments.find((item) => String(item.id || "") === plan.segmentId)!;
        const refs = collectH3Refs(segment);
        const defaults = recordOf(this.stores.settings.get(H3_DEFAULTS_KEY));
        const params = extractParams(segment, override, metadata, defaults);
        if (params.motionContextEnabled === true && !plan.continuation) throw new Error("Motion Context（V15 潜空间续写）必须使用「运行当前及后续分镜」，不能单独运行一个 Clip。");
        if (plan.continuation) {
            params.motionContextEnabled = true;
            params.continuationTask = buildH3ContinuationTask(String(parent.input.projectId), plan.continuation.group, parent.id, plan.continuation.index);
        }
        const taskMode = normalizeTaskMode(params.taskMode || segment.taskMode);
        const isT2v = taskMode === "t2v";
        const isI2v = taskMode === "i2v";
        const isFl2v = taskMode === "fl2v";
        const imageRefs = isT2v ? [] : refs.filter((ref) => ref.type === "image");
        const audioRefs = isT2v || isI2v || isFl2v ? [] : refs.filter((ref) => ref.type === "audio");
        const videoRefs = isT2v || isI2v || isFl2v ? [] : refs.filter((ref) => ref.type === "video");
        if (isI2v && imageRefs.length !== 1) throw new Error("I2V 必须且只能使用 1 张图片作为首帧");
        if (isFl2v && imageRefs.length !== 2) throw new Error("FL2V 必须使用 2 张图片作为首尾帧");
        if (imageRefs.length > 9) throw new Error("MiniMax H3 最多支持 9 张参考图片");
        if (videoRefs.length > 3) throw new Error("MiniMax H3 最多支持 3 段参考视频");
        if (audioRefs.length > 3) throw new Error("MiniMax H3 最多支持 3 段参考音频");
        const images = await Promise.all(imageRefs.map((ref) => this.resolveRef(ref)));
        const audios = await Promise.all(audioRefs.map((ref) => this.resolveRef(ref)));
        const videos = await Promise.all(videoRefs.map((ref) => this.resolveRef(ref)));
        const previous = plan.segmentIndex > 0 ? segments[plan.segmentIndex - 1] : undefined;
        // 上一段成品视频有两种显式用途（规则见 resolveClipContinuation）：
        //   1) tailFrameContinuation（标在【上一段】上）= 抓上一段尾帧，当本段首帧参考图（写出提示词，UI 可见）；
        //   2) previousVideoAsReference（标在【本段】上）= 把上一段成品整体当「参考视频」喂进本段（默认关）。
        // Motion Context 本身走 V15 continuationTask 的 AV latent 链，不消费上一段成品视频，
        // 更不能隐式触发 2)；完整视频参考仍由 previousVideoAsReference 单独控制。
        const chained = parent.input.runFromCurrent === true && plan.segmentIndex > 0;
        const { usePreviousAsReference, useTailFrame, needsPreviousVideo } = resolveClipContinuation(segment, previous, chained, params);
        if (useTailFrame && !previous?.result) throw new Error(`Clip ${plan.segmentIndex} 已开启尾帧接续，但上一段没有可用成品视频`);
        const previousPath = needsPreviousVideo && previous?.result
            ? await this.resolveRef({ url: previous.result, storageKey: previous.resultStorageKey, name: `clip-${plan.segmentIndex}.mp4`, type: "video" })
            : "";
        let prompt = String(segment.prompt || "");
        if (previousPath && useTailFrame) {
            const tail = await this.captureTailFrame(previousPath, `h3-tail-${parent.id}-${plan.segmentIndex}.png`);
            if (!isT2v && !isI2v && !isFl2v) images.unshift(tail);
            if (images.length > 9) throw new Error("尾帧续接后参考图片超过 MiniMax H3 的 9 张上限");
            prompt = appendTailFramePrompt(prompt, `Clip ${plan.segmentIndex}`);
        }
        // 组装最终送入工作流的参考视频列表：本段自有参考视频（最多 3 段）+ 显式开启时才追加的上一段成品。
        const referenceVideos = appendPreviousReference(videos, usePreviousAsReference && !isT2v && !isI2v && !isFl2v ? previousPath : "");
        const engine = String(params.minimaxEngine || params.engine || metadata.minimaxEngine || "").toLowerCase();
        Object.assign(params, {
            taskMode,
            // V15 Motion Context 由 motionContextEnabled + continuationTask 驱动；这里关闭的
            // 是旧版预处理图标记，避免再把上一段视频走旧 motion/context 图。
            motionContext: false,
            motionContextNoise: false,
            previousVideoAsReference: usePreviousAsReference,
            runninghubMode: metadata.minimaxRunningHubMode,
            runninghubWorkflowId: metadata.minimaxRunningHubWorkflowId,
            runninghubAppId: metadata.minimaxRunningHubAppId,
            runninghubFields: metadata.minimaxRunningHubFields,
            runninghubParams: metadata.minimaxRunningHubParams,
            runninghubWorkflowJson: metadata.minimaxRunningHubWorkflowJson,
            useWallet: metadata.minimaxRunningHubUseWallet === true,
        });
        const log = this.stores.logs.create({
            projectId: String(parent.input.projectId), nodeId: plan.nodeId, segmentId: plan.segmentId,
            status: "queued", platform: engine || "comfyui", workflow: "MiniMax H3", model: String(params.modelName || ""), taskMode: String(params.taskMode || segment.taskMode || "r2v"),
            prompt, references: refs, inputCounts: { image: images.length, video: referenceVideos.length, audio: audios.length }, startedAt: new Date().toISOString(), durationMs: 0, outputs: [], params,
        });
        this.events.publish({ type: "generation-log.created", entityId: log.id, payload: log });
        const childParams = { ...params, parentTaskId: parent.id, canvasBinding: { projectId: parent.input.projectId, nodeId: plan.nodeId, segmentId: plan.segmentId, generationLogId: log.id, bindOnStart: false } };
        const childInput = {
            prompt, references: images, audios,
            // video（单数）保留给 RunningHub / 旧分拆图读取；videos（复数）给南风 V10 原生构造器，
            // 后者优先读数组——这样第 2/3 段参考视频不会被静默丢弃。
            video: referenceVideos[0],
            ...(referenceVideos.length ? { videos: referenceVideos } : {}),
            ...(previousPath && usePreviousAsReference ? { previousVideo: previousPath } : {}),
        };
        const bind = (created: RuntimeTask) => this.bindChild(parent.id, plan, created.id, log.id);
        const child = engine === "runninghub"
            ? await this.runningHub.run(childInput, childParams, undefined, bind)
            : await this.comfy.run("minimax-h3", childInput, childParams, undefined, undefined, bind);
        this.stores.tasks.addEvent(parent.id, "child_started", { nodeId: plan.nodeId, segmentId: plan.segmentId, segmentIndex: plan.segmentIndex, childTaskId: child.id, generationLogId: log.id });
        return child;
    }

    private bindParent(task: RuntimeTask) {
        const input = normalizeInput(task.input as H3RunInput);
        const project = this.stores.projects.get(input.projectId);
        if (!project) throw new Error(`画布不存在: ${input.projectId}`);
        const ids = new Set(input.nodeIds?.length ? input.nodeIds : input.nodeId ? [input.nodeId] : []);
        for (const node of project.nodes as Array<Record<string, unknown>>) {
            if (ids.size && !ids.has(String(node.id || ""))) continue;
            if (!String(node.type || "").includes("minimax")) continue;
            this.updateNode(input.projectId, String(node.id), { runtimeTaskId: task.id, status: "loading", runProgress: 0, errorDetails: "", cancelRequested: false });
        }
    }

    private bindChild(parentId: string, plan: { nodeId: string; segmentId: string }, childId: string, generationLogId: string) {
        const parent = this.stores.tasks.get(parentId)!;
        const projectId = String(parent.input.projectId);
        const project = this.stores.projects.get(projectId)!;
        const node = (project.nodes as Array<Record<string, unknown>>).find((item) => String(item.id || "") === plan.nodeId)!;
        if (!node) throw new Error(`找不到 H3 节点: ${plan.nodeId}`);
        const result = this.stores.projects.applyOperations(projectId, Number(project.revision || 0), [
            { type: "update_node", id: plan.nodeId, metadata: { runtimeTaskId: parentId, status: "loading" } },
            { type: "update_h3_segment", nodeId: plan.nodeId, segmentId: plan.segmentId, patch: { runtimeTaskId: childId, status: "loading", progress: 0 }, patchDelete: ["errorDetails"] },
        ]);
        this.events.publishCanvasDelta({ entityId: projectId, revision: result.revision, operations: result.operations, updatedAt: String(result.project.updatedAt || "") });
        const log = this.stores.logs.update(generationLogId, { status: "running", runtimeTaskId: childId });
        this.events.publish({ type: "generation-log.updated", entityId: log.id, payload: log });
    }

    private finishParentNode(task: RuntimeTask, status: string, error = "") {
        const input = normalizeInput(task.input as H3RunInput);
        const project = this.stores.projects.get(input.projectId);
        if (!project) return;
        const ids = new Set(input.nodeIds?.length ? input.nodeIds : input.nodeId ? [input.nodeId] : []);
        for (const node of project.nodes as Array<Record<string, unknown>>) {
            if (ids.size && !ids.has(String(node.id || ""))) continue;
            if (String(recordOf(node.metadata).runtimeTaskId || "") !== task.id) continue;
            this.updateNode(input.projectId, String(node.id), { runtimeTaskId: "", runtimeRunId: "", runRequestId: "", runRequestConsumedId: "", status, runProgress: task.progress, errorDetails: error, cancelRequested: false });
        }
    }

    private updateNode(projectId: string, nodeId: string, metadata: Record<string, unknown>) {
        const project = this.stores.projects.get(projectId)!;
        const result = this.stores.projects.applyOperations(projectId, Number(project.revision || 0), [{ type: "update_node", id: nodeId, metadata }]);
        this.events.publishCanvasDelta({ entityId: projectId, revision: result.revision, operations: result.operations, updatedAt: String(result.project.updatedAt || "") });
    }

    private async waitForTerminal(parentId: string, childId: string) {
        while (true) {
            this.assertActive(parentId);
            const child = this.stores.tasks.get(childId);
            if (!child) throw new Error(`H3 子任务不存在: ${childId}`);
            if (["succeeded", "failed", "cancelled"].includes(child.status)) return child;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }

    private assertActive(id: string) {
        if (this.cancelled.has(id) || this.stores.tasks.get(id)?.status === "cancelled") throw Object.assign(new Error("任务已取消"), { name: "AbortError" });
    }

    private cancelChild(id: string) {
        const child = this.stores.tasks.get(id);
        if (!child || ["succeeded", "failed", "cancelled"].includes(child.status)) return;
        if (child.kind === "runninghub:minimax-h3") this.runningHub.cancel(id);
        else this.comfy.cancel(id);
    }

    private update(id: string, patch: Parameters<Stores["tasks"]["update"]>[1]) {
        const task = this.stores.tasks.update(id, patch);
        this.publish(task, task.status === "succeeded" ? "task.completed" : task.status === "failed" ? "task.failed" : "task.updated");
        return task;
    }

    private publish(task: RuntimeTask, type: string) { this.events.publish({ type, entityId: task.id, payload: task }); }

    private fail(id: string, error: unknown) {
        if (this.stores.tasks.get(id)?.status === "cancelled") return;
        const message = error instanceof Error ? error.message : String(error);
        const task = this.update(id, { status: "failed", error: message });
        this.finishParentNode(task, "error", message);
        this.currentChildren.delete(id);
    }

    private async resolveRef(ref: H3Ref) {
        const storageKey = String(ref.storageKey || mediaStorageKey(String(ref.url || "")) || "");
        if (storageKey) {
            const media = this.stores.media.meta(storageKey);
            if (!media) throw new Error(`媒体不存在: ${storageKey}`);
            return media.filePath;
        }
        const url = String(ref.url || "");
        if (!url) throw new Error(`参考条目缺少地址: ${String(ref.name || "ref")}`);
        if (url.startsWith("data:")) return this.stores.media.storeDataUrl(url, String(ref.name || "ref")).filePath;
        if (/^https?:\/\//i.test(url)) {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`读取参考失败 HTTP ${response.status}: ${String(ref.name || url)}`);
            return this.stores.media.store(Buffer.from(await response.arrayBuffer()), { name: String(ref.name || "ref"), mimeType: response.headers.get("content-type") || undefined, category: "input" }).filePath;
        }
        return url;
    }

    private captureTailFrame(videoPath: string, name: string) {
        return new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            const errors: Buffer[] = [];
            const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-sseof", "-0.05", "-i", videoPath, "-frames:v", "1", "-vf", "scale='if(gt(iw,ih),min(768,iw),-2)':'if(gt(iw,ih),-2,min(768,ih))'", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
            child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
            child.once("error", reject);
            child.once("exit", (code) => {
                if (code !== 0 || !chunks.length) return reject(new Error(`截取上一段尾帧失败: ${Buffer.concat(errors).toString("utf8").trim()}`));
                resolve(this.stores.media.store(Buffer.concat(chunks), { name, mimeType: "image/png", category: "input" }).filePath);
            });
        });
    }
}

/**
 * 决定本段是否消费上一段成品视频。尾帧接续可用于单独生成下一段；整段参考视频仍只在链式续跑中生效。
 *  - tailFrameContinuation 标在【上一段】上：生成本段时抓该段尾帧作为首帧参考图；
 *  - previousVideoAsReference 标在【本段】上：链式续跑时把上一段成品整体作为参考视频喂进本段（默认关）。
 * motionContextEnabled 只控制 V15 AV latent 续写，不属于这里的成品视频消费逻辑；
 * 不得用它隐式触发 previousVideoAsReference。
 */
export function resolveClipContinuation(
    segment: Record<string, unknown>,
    previous: Record<string, unknown> | undefined,
    chained: boolean,
    override: Record<string, unknown>,
) {
    const usePreviousAsReference = chained && (segment.previousVideoAsReference === true || override.previousVideoAsReference === true);
    // 尾帧是上一段到下一段的首帧锚点，生成当前 Clip 时也应生效；整段参考视频仍要求链式续跑。
    const useTailFrame = previous?.tailFrameContinuation === true;
    return {
        usePreviousAsReference,
        useTailFrame,
        needsPreviousVideo: (usePreviousAsReference || useTailFrame) && Boolean(previous?.result),
    };
}

/** 把上一段成品追加到参考视频列表尾部；不注入时原样返回。超过 3 段上限直接报错，不静默丢弃。 */
export function appendPreviousReference(videos: readonly string[], previousPath: string): string[] {
    if (!previousPath) return [...videos];
    if (videos.length >= 3) throw new Error("参考视频已达 3 段上限，无法再追加上一段成品；请关闭「上一段作为参考视频」或先移除一段参考视频");
    return [...videos, previousPath];
}

/** V15 会用 ComfyUI unique_id 校验 node；原生提交图中的主节点 ID 固定为 nf_v15。 */
export function buildH3ContinuationTask(workflow: string, group: string, run: string, index: number): string {
    return JSON.stringify({ workflow, node: "nf_v15", group, run, index });
}

function normalizeInput(input: H3RunInput): H3RunInput {
    const projectId = String(input.projectId || "");
    if (!projectId) throw new Error("projectId 必填");
    if (!input.nodeId && !input.nodeIds?.length) throw new Error("nodeId 或 nodeIds 必填");
    return { ...input, projectId, nodeId: input.nodeId ? String(input.nodeId) : undefined, nodeIds: input.nodeIds?.map(String), segmentId: input.segmentId ? String(input.segmentId) : undefined, params: recordOf(input.params) };
}

function recordOf(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/**
 * refItems is the canonical order produced by the canvas ref slots.
 * Do not sort by the legacy optional `order` field: older entries may have
 * stale values or no value at all, while the array position is what the UI
 * and prompt's Image N numbering represent.
 */
export function collectH3Refs(segment: H3Segment) {
    const buckets = recordOf(segment.refs);
    const bucketRefs = ["image", "video", "audio"].flatMap((type) => {
        const value = buckets[type];
        return (Array.isArray(value) ? value : value ? [value] : []).map((item) => ({ ...recordOf(item), type: String(recordOf(item).type || type) } as H3Ref));
    });
    const refs = (segment.refItems?.length ? segment.refItems : bucketRefs).map((ref) => ({ ...ref, type: String(ref.type || ref.kind || inferRefType(String(ref.name || ref.url || ""))) }));
    return refs.filter((ref) => ref.role !== "character_identity").filter((ref, index, all) => all.findIndex((item) => ref.storageKey && item.storageKey ? item.storageKey === ref.storageKey : item.url === ref.url) === index);
}

function inferRefType(value: string) { return /\.(mp4|webm|mov)(?:$|\?)/i.test(value) ? "video" : /\.(mp3|wav|m4a|flac)(?:$|\?)/i.test(value) ? "audio" : "image"; }

function normalizeTaskMode(value: unknown) {
    const mode = String(value || "").toLowerCase();
    return ["t2v", "i2v", "fl2v", "ref2va"].includes(mode) ? mode : "ref2va";
}

function extractParams(segment: H3Segment, override: Record<string, unknown>, metadata: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
    const nodeParams = recordOf(metadata.comfyParams);
    const params: Record<string, unknown> = {};
    for (const key of H3_PARAM_KEYS) {
        const value = override[key] ?? segment[key] ?? metadata[key] ?? nodeParams[key] ?? defaults[key];
        if (value !== undefined && value !== null && value !== "") params[key] = value;
    }
    if (override.steps === undefined) params.steps = override.videoSteps ?? segment.videoSteps ?? metadata.videoSteps ?? nodeParams.videoSteps ?? defaults.videoSteps ?? params.steps;
    delete params.videoSteps;
    const result = { ...params, ...override };
    delete result.videoSteps;
    return result;
}

function resultVideo(task: RuntimeTask) {
    const media = task.result && Array.isArray(task.result.media) ? task.result.media as Record<string, unknown>[] : [];
    return media.find((item) => String(item.mimeType || "").startsWith("video/")) || media[0];
}

function mediaStorageKey(url: string) {
    try {
        const parsed = new URL(url, "http://local");
        return parsed.pathname.startsWith("/media/") ? decodeURIComponent(parsed.pathname.slice(7)).split("/")[0] : "";
    } catch { return ""; }
}

function appendTailFramePrompt(prompt: string, fromClip: string) {
    let shifted = prompt;
    let max = 0;
    for (const match of shifted.matchAll(/<Picture\s+(\d+)>/gi)) max = Math.max(max, Number(match[1]));
    for (let index = max; index >= 1; index--) shifted = shifted.replace(new RegExp(`<Picture\\s+${index}>`, "gi"), `<Picture ${index + 1}>`);
    const definition = `<Picture 1> is the opening frame of this segment, hard-cut from the ending frame of ${fromClip} to anchor character and scene continuity.`;
    const retention = `<Picture 1> ([Shot 1] first frame): partially_preserved - the ending frame of ${fromClip} is hard-cut into this segment as the opening frame; preserve the character's identity, pose, and ongoing action across the cut, but treat it as a new shot/scene (not a seamless match-cut continuation).`;
    const withDefinition = /^subject_definitions\s*[:：]/m.test(shifted) ? appendToSection(shifted, "subject_definitions", definition) : shifted;
    return appendToSection(withDefinition, "retention_analysis", retention);
}

function appendToSection(prompt: string, section: string, line: string) {
    const sections = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];
    const match = prompt.match(new RegExp(`^${section}\\s*[:：]`, "m"));
    if (!match) return `${prompt.trim()}\n\n${section}:\n${line}\n`;
    const start = (match.index || 0) + match[0].length;
    const after = prompt.slice(start);
    const next = after.match(new RegExp(`\\n(${sections.filter((item) => item !== section).join("|")})\\s*[:：]`));
    const at = next ? start + (next.index || 0) : prompt.length;
    return `${prompt.slice(0, at).trimEnd()}\n${line}\n${prompt.slice(at).trimStart()}`;
}
