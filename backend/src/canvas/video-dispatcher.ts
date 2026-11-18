import crypto from "node:crypto";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";

import type { CanvasProject, RuntimeTask, WorkflowConfig, WorkflowField } from "../db.js";
import { findComfyuiEngineTarget, findEngineChannel, type EngineChannelTarget } from "./engine-channel.js";
import { validateVideoTrimRange, type VideoConcatBackend } from "../engine-contract/video-concat.js";
import type { Stores, TaskStore } from "../stores/types.js";
import type { WorkflowCatalog } from "../engine-contract/workflow-catalog.js";
import { builtinWorkflowName, decodeChannelModel, findChannelModel, modelOptionName, resolveWorkflowBindingForModel, usesWorkflowExecutor, workflowResolutionMessage } from "./model-workflow.js";
import type { CanvasImageReference } from "./image-dispatcher.js";
import { DirectVideoBackend } from "../engine-contract/direct-video.js";
import { prepareCanvasGenerationTarget, prepareCanvasVideoTrimTarget } from "./generation-target.js";
import { generationSettingsSnapshot } from "../engine-contract/generation-settings.js";
import { bridgeLocalWorkflowValues } from "./workflow-field-bridge.js";
import { injectDurationTarget, parseWorkflowDurationTarget, readDurationSeconds, resolveDurationValue } from "../engine-contract/duration.js";
import { CanvasEngineClient, importEngineMedia } from "./engine-client.js";

export const CANVAS_VIDEO_CONCAT_MODEL = "__local_video_concat__";
export const CANVAS_VIDEO_TRIM_MODEL = "__local_video_trim__";

export type CanvasVideoReference = CanvasImageReference;
export type CanvasVideoGenerationInput = {
    projectId?: string;
    nodeId?: string;
    sourceNodeId?: string;
    model: string;
    prompt: string;
    references?: CanvasImageReference[];
    videoReferences?: CanvasVideoReference[];
    audioReferences?: CanvasVideoReference[];
    /** H3 can bind videos/audio as workflow refs; ordinary video calls route by image refs only. */
    workflowReferenceCount?: number;
    size?: string;
    seconds?: string;
    resolution?: string;
    runTarget?: "local" | "cloud" | "hybrid";
    width?: number;
    height?: number;
    params?: Record<string, unknown>;
    input?: Record<string, unknown>;
    preset?: string;
    comfyUrl?: string;
    clientTaskId?: string;
    loopOutput?: CanvasGenerationCommand["loopOutput"];
};

type Plan = { input: CanvasVideoGenerationInput; kind: "concat" | "trim" | "workflow" | "preset" | "direct" | "runninghub-workflow" | "engine"; workflow?: string; preset?: string; runninghubProfileId?: string; engine?: EngineChannelTarget };

/** Backend 权威的普通视频任务；H3 连续 Clip 仍由专用 runner 管理。 */
export class CanvasVideoDispatcher {
    private readonly children = new Map<string, Set<string>>();
    /** 本地子任务 id → 引擎任务 id（配置了执行引擎时才有值）。 */
    private readonly engineTasks = new Map<string, { taskId: string; target: EngineChannelTarget }>();
    constructor(private readonly stores: Stores, private readonly workflows: WorkflowCatalog,
        private readonly concat: VideoConcatBackend, private readonly directVideo?: DirectVideoBackend,
        /** 可选注入：配置了独立执行引擎时，本地工作流视频执行改走 `/v1/videos`。 */
    ) {}

    /** H3 父日志记录自选模型实际工作流输入，沿用执行器字段过滤和显示名映射。 */
    generationSettings(input: CanvasVideoGenerationInput) {
        const plan = this.plan(this.prepare(input));
        const params = { ...(plan.input.params || {}) };
        const workflowConfig = plan.workflow ? this.workflows.getConfig(plan.workflow) : null;
        const workflowFields = workflowConfig?.fields || [];
        if (plan.workflow) {
            const configured = recordOf(params.selectedVideoModelFieldValues);
            const selected = selectedWorkflowFieldValues(configured, plan.input.model, plan.workflow);
            Object.assign(params, selected);
        } else if (plan.kind === "direct") {
            const configured = recordOf(params.selectedVideoModelFieldValues);
            Object.assign(params, recordOf(configured[`direct:${plan.input.model}`]));
        }
        delete params.selectedVideoModelFieldValues;
        // 时长注入的实际解析结果进生成日志，便于核对「制作台秒 → 哪个节点输入 → 最终值」。
        // 只有本地自定义工作流分支会注入时长；RunningHub 走 node::input 字段桥，暂不适配。
        const durationTarget = plan.kind === "workflow" ? parseWorkflowDurationTarget(workflowConfig?.durationTarget) : null;
        const durationSeconds = durationTarget ? readDurationSeconds(params, plan.input) : null;
        const durationResolution = durationTarget && durationSeconds !== null ? {
            source: "clipDuration",
            seconds: durationSeconds,
            unit: durationTarget.unit,
            value: resolveDurationValue(durationSeconds, durationTarget.unit),
            nodeId: durationTarget.nodeId,
            input: durationTarget.input,
        } : null;
        return generationSettingsSnapshot(params, {
            ...(plan.workflow ? { workflow: plan.workflow } : {}),
            executor: plan.kind,
            ...(plan.input.runTarget ? { runTarget: plan.input.runTarget } : {}),
            ...(plan.input.workflowReferenceCount !== undefined ? { workflowReferenceCount: plan.input.workflowReferenceCount } : {}),
            ...(durationResolution ? { durationResolution } : {}),
        }, workflowFields);
    }

    start(raw: CanvasVideoGenerationInput, onCreated?: (task: RuntimeTask) => void) {
        let input = this.prepare(raw);
        let plan = this.plan(input);
        const taskId = input.clientTaskId || `canvas-video-${crypto.randomUUID()}`;
        const existing = this.stores.tasks.get(taskId);
        if (existing && plan.kind === "trim" && (existing.kind !== "canvas-video" || existing.input.model !== input.model || existing.projectId !== input.projectId
            || JSON.stringify(existing.input.params) !== JSON.stringify(input.params) || JSON.stringify(existing.input.videoReferences) !== JSON.stringify(input.videoReferences))) {
            throw new Error("视频裁剪任务 ID 已用于不同输入");
        }
        if (existing) return { taskId: existing.id, executor: plan.kind };
        if (this.stores.tasks.getTombstone?.(taskId)) throw Object.assign(new Error(`TASK_HISTORY_PRUNED: ${taskId}`), { code: "TASK_HISTORY_PRUNED", retryable: false });
        const active = this.findActive(input);
        if (active) return { taskId: active.id, executor: String(active.executor || plan.kind) };
        const prepared = (plan.kind === "trim" ? prepareCanvasVideoTrimTarget : prepareCanvasGenerationTarget)(this.stores, { ...input, mode: "video" }, taskId);
        input = prepared.command as CanvasVideoGenerationInput;
        plan = this.plan(input);
        const project = prepared.project;
        const targetNode = project && (project.nodes as Array<Record<string, any>>).find((node) => node.id === input.nodeId);
        const targetSize = targetNode || { width: 340, height: 190 };
        const task = this.stores.tasks.create(taskId, "canvas-video", input, {
            projectId: input.projectId, nodeId: input.nodeId, executor: plan.kind, model: input.model,
            ...(plan.workflow ? { workflow: plan.workflow } : {}),
            ...(input.runTarget ? { runTarget: input.runTarget } : {}),
            videoTargetSize: project ? { width: targetSize.width, height: targetSize.height } : undefined,
            ...(input.params?.parentTaskId ? { parentTaskId: input.params.parentTaskId } : {}),
            ...(input.params?.canvasBinding ? { canvasBinding: input.params.canvasBinding } : {}),
        });
        try {
            onCreated?.(task);
            if (project) this.stores.projects.applyOperations(input.projectId!, Number(project.revision || 0), [
                ...prepared.createOperations,
                { type: "update_node", id: input.nodeId!, metadata: { runtimeTaskId: task.id, status: "loading", runProgress: 0 }, metadataDelete: ["errorDetails"] },
                ...(plan.kind === "trim" ? [] : bindSource(project, input, task.id)),
            ], { operationId: `video-task-bind:${task.id}`, runtimeWrite: true, source: { clientId: `task:${task.id}`, kind: "task", label: "视频生成任务" } });
        } catch (error) {
            this.stores.tasks.update(task.id, { status: "failed", error: messageOf(error) });
            throw error;
        }
        const startedAt = Date.now();
        const references = [
            ...(input.references || []).map((reference) => ({ ...reference, type: "image" })),
            ...(input.videoReferences || []).map((reference) => ({ ...reference, type: "video" })),
            ...(input.audioReferences || []).map((reference) => ({ ...reference, type: "audio" })),
        ].map(({ id, name, mimeType, storageKey, type }) => ({ id, name, mimeType, storageKey, type }));
        const logId = input.projectId && !input.params?.parentTaskId ? this.stores.logs.create({
            projectId: input.projectId, nodeId: input.nodeId, status: "running", platform: "canvas-video", workflow: plan.workflow || "",
            model: input.model, taskMode: input.references?.length ? "i2v" : "t2v", prompt: input.prompt, references,
            inputCounts: { image: input.references?.length || 0, video: input.videoReferences?.length || 0, audio: input.audioReferences?.length || 0 },
            runtimeTaskId: task.id, startedAt: new Date(startedAt).toISOString(), durationMs: 0, outputs: [],
            params: { generationSettings: generationSettingsSnapshot(input.params, {
                size: input.size, seconds: input.seconds, resolution: input.resolution, width: input.width, height: input.height,
                executor: plan.kind, ...(input.workflowReferenceCount !== undefined ? { workflowReferenceCount: input.workflowReferenceCount } : {}),
            }, plan.workflow ? this.workflows.getConfig(plan.workflow)?.fields || [] : []) },
        }).id : null;
        // Hybrid selection must inspect the live ComfyUI queue immediately before dispatch.
        // The task already has its authoritative canvas binding at this point; executor is
        // updated to the selected provider before any child job is submitted.
        void this.execute(plan, task, logId, startedAt, true).catch((error) => this.fail(task, input, error, logId, startedAt));
        return { taskId: task.id, executor: plan.kind };
    }

    retry(task: RuntimeTask) {
        if (task.kind !== "canvas-video") throw new Error(`任务类型 ${task.kind} 不是画布视频任务`);
        const previous = task.input as CanvasVideoGenerationInput;
        const result = this.start({ ...previous, ...(previous.loopOutput || previous.model === CANVAS_VIDEO_TRIM_MODEL ? { nodeId: previous.sourceNodeId } : {}), clientTaskId: `canvas-video-retry-${crypto.randomUUID()}` });
        const retried = this.stores.tasks.get(result.taskId)!;
        this.stores.tasks.addEvent(retried.id, "retry", { parentTaskId: task.id });
        return retried;
    }

    /**
     * 失败/取消后的引擎任务回捞：按持久化的 engineTaskId 把引擎里仍在执行的同一次 prompt 接回来。
     * 不重新提交、不重新加载模型；接回后复用正常路径的媒体归档与节点回写。
     */
    async reclaim(id: string): Promise<RuntimeTask> {
        const task = this.stores.tasks.get(id);
        if (!task || task.kind !== "canvas-video") throw new Error(`画布视频任务不存在：${id}`);
        if (!["failed", "cancelled"].includes(task.status)) throw new Error(`任务状态 ${task.status} 不可回捞`);
        const submission = this.stores.tasks.events(id).find((event) => event.type === "engine_submitted")?.payload as { engineTaskId?: string; baseUrl?: string; model?: string } | undefined;
        if (!submission?.engineTaskId || !submission.baseUrl) throw new Error("原任务没有记录引擎任务 id；只有新增的执行引擎任务支持回捞，请重新生成");
        const config = this.stores.settings.get("ai.config");
        const candidates = [findEngineChannel(config, submission.model || ""), findComfyuiEngineTarget(config, submission.model || "")].filter((item): item is EngineChannelTarget => Boolean(item));
        const target = candidates.find((item) => item.baseUrl === submission.baseUrl) || candidates[0];
        if (!target) throw new Error("原引擎渠道已不在设置里，请在原配置下回捞");
        const engine = new CanvasEngineClient(target.baseUrl, target.token);
        const outcome = await engine.reclaimTask(submission.engineTaskId);
        if (outcome.error) throw new Error(`执行引擎回捞失败：${outcome.error}`);
        const log = this.stores.logs.list({ runtimeTaskId: id, limit: 1 })[0];
        const current = this.stores.tasks.update(id, { status: "running", progress: 0.05, error: null });
        this.stores.tasks.addEvent(id, "engine_reclaim", { engineTaskId: submission.engineTaskId, ...outcome });
        const input = task.input as CanvasVideoGenerationInput;
        const plan: Plan = { input, kind: "engine", engine: target };
        void this.waitReclaimed(current, submission.engineTaskId, target, plan, log?.id ?? null)
            .catch((error) => this.fail(current, input, error, log?.id ?? null, Date.now()));
        return current;
    }

    private async waitReclaimed(task: RuntimeTask, engineTaskId: string, target: EngineChannelTarget, plan: Plan, logId: string | null) {
        const engine = new CanvasEngineClient(target.baseUrl, target.token);
        const finished = await engine.waitVideo(engineTaskId);
        if (finished.status !== "succeeded") throw new Error(finished.error || `执行引擎返回 ${finished.status}`);
        this.assertActive(task.id);
        const imported = await importEngineMedia(this.stores.media, finished.media, (url) => engine.fetchMedia(url));
        const media = imported.find((item) => String(item.mimeType).startsWith("video/")) || imported[0];
        if (!media) throw new Error("视频工作流回捞完成但没有返回媒体");
        this.finish(task, plan, media, logId, Date.now());
    }

    resume(task: RuntimeTask) {
        if (task.kind !== "canvas-video" || !["queued", "running"].includes(task.status)) return;
        const input = task.input as CanvasVideoGenerationInput;
        try {
            const project = this.target(input);
            const node = project && (project.nodes as Array<Record<string, any>>).find((node) => node.id === input.nodeId);
            if (project && node?.metadata?.runtimeTaskId !== task.id) throw new Error("视频任务已失去节点绑定，不恢复旧任务");
            const plan = this.plan(input);
            // 重启后子任务集合是内存态、必然为空；RunningHub 子任务要按 parentTaskId
            // 从存储里找回来并按远端 taskId 恢复观察，否则云端任务失去跟踪。
            for (const child of this.stores.tasks.list({ kind: "runninghub:workflow", limit: 200 })) {
                if (String(child.params?.parentTaskId || "") !== task.id || !["queued", "running"].includes(child.status)) continue;
            }
            const log = this.stores.logs.list({ runtimeTaskId: task.id, limit: 1 })[0];
            const startedAt = log ? Date.parse(log.startedAt) : Date.now();
            void this.execute(plan, task, log?.id || null, startedAt).catch((error) => this.fail(task, input, error, log?.id || null, startedAt));
        } catch (error) { this.fail(task, input, error); }
    }

    cancel(id: string) {
        const task = this.stores.tasks.get(id);
        if (!task || !["queued", "running"].includes(task.status)) throw new Error(`任务状态 ${task?.status || "unknown"} 不可取消`);
        for (const child of this.children.get(id) || []) {
            const engineTask = this.engineTasks.get(child);
            if (engineTask) void new CanvasEngineClient(engineTask.target.baseUrl, engineTask.target.token).cancel(engineTask.taskId);
            try { this.concat.cancel(child); } catch {}
            try { this.directVideo?.cancel(child); } catch {}
        }
        const cancelled = this.stores.tasks.cancel(id);
        const input = task.input as CanvasVideoGenerationInput;
        const log = this.stores.logs.list({ runtimeTaskId: id, limit: 1 })[0];
        if (log) this.stores.logs.update(log.id, { status: "cancelled", finishedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - Date.parse(log.startedAt)) });
        if (input.projectId && input.nodeId) this.stores.projects.markCanvasVideoTaskFailed(cancelled, input as Required<Pick<CanvasVideoGenerationInput, "projectId" | "nodeId">>, "");
        return cancelled;
    }

    private async execute(plan: Plan, task: RuntimeTask, logId: string | null, startedAt: number, selectHybridProvider = false) {
        if (selectHybridProvider) {
            plan = await this.selectHybridProvider(plan, task.id);
            if (plan.kind !== task.executor) {
                this.stores.tasks.update(task.id, { executor: plan.kind });
                task = this.stores.tasks.get(task.id) || { ...task, executor: plan.kind };
            }
        }
        this.stores.tasks.update(task.id, { status: "running", progress: 0.02 });
        const media = await this.dispatch(plan, task.id);
        this.finish(task, plan, media, logId, startedAt);
    }

    /** 产物落盘与节点回写：正常执行与引擎回捞共用，避免两条路径写出不同状态。 */
    private finish(task: RuntimeTask, plan: Plan, media: Record<string, unknown>, logId: string | null, startedAt: number) {
        if (this.stores.tasks.get(task.id)?.status === "cancelled") return;
        if (plan.input.projectId && plan.input.nodeId) {
            const written = this.stores.projects.writeBackCanvasVideoTask({ ...task, status: "succeeded", result: { media: [media] } },
                plan.input as Required<Pick<CanvasVideoGenerationInput, "projectId" | "nodeId" | "prompt" | "model">>, media);
            if (!written) throw new Error("视频任务已失去节点绑定，放弃迟到结果");
        }
        if (this.stores.tasks.get(task.id)?.status === "cancelled") return;
        this.stores.tasks.update(task.id, { status: "succeeded", progress: 1, result: { media: [media] } });
        this.stores.tasks.addEvent(task.id, "result", { media: [media] });
        if (logId) this.stores.logs.update(logId, { status: "success", outputs: [media], finishedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - startedAt) });
    }

    /** Resolve hybrid routing against both Backend-tracked work and ComfyUI's actual queue. */
    private async selectHybridProvider(plan: Plan, currentTaskId: string): Promise<Plan> {
        if (plan.kind !== "workflow" || !plan.workflow) return plan;
        const workflowConfig = this.workflows.getConfig(plan.workflow);
        const requestedTarget = plan.input.runTarget ?? workflowConfig?.runTarget ?? "local";
        if (requestedTarget !== "hybrid") return plan;

        const trackedLocalBusy = this.stores.tasks.list({ kind: "workflow", limit: 500 })
            .some((task) => task.id !== currentTaskId && ["queued", "running"].includes(task.status))
            || this.stores.tasks.list({ kind: "canvas-video", limit: 500 })
                .some((task) => task.id !== currentTaskId && ["queued", "running"].includes(task.status) && task.executor === "workflow");
        // 本地 ComfyUI 直连已下线：混合路由不再探测本地队列，只看 Backend 自己跟踪的本地任务。
        const comfyBusy = false;
        if (!trackedLocalBusy && !comfyBusy) return plan;

        const profileId = workflowConfig?.runningHubProfileId;
        const profile = undefined; // RunningHub 档案在引擎侧，画布不再本地解析
        if (!profileId || !profile) {
            throw new Error("本地 ComfyUI 正忙，但当前工作流没有绑定有效的 RunningHub 工作流；请先绑定 RH 工作流后重试");
        }
        return { ...plan, kind: "runninghub-workflow", runninghubProfileId: profileId };
    }

    private async dispatch(plan: Plan, taskId: string): Promise<Record<string, unknown>> {
        if (plan.kind === "trim") {
            const reference = plan.input.videoReferences![0];
            const childId = `video-trim-child-${taskId}`;
            this.assertActive(taskId);
            this.track(taskId, childId);
            try {
                const child = await this.concat.trim(reference.storageKey!, Number(plan.input.params!.start), Number(plan.input.params!.end), childId, taskId);
                return firstMedia(await waitForTask(this.stores.tasks, child.id));
            } finally { this.untrack(taskId, childId); }
        }
        if (plan.kind === "concat") {
            const references = await Promise.all((plan.input.videoReferences || []).map((reference) => this.materialize(reference)));
            const childId = `video-concat-child-${taskId}`;
            this.assertActive(taskId);
            this.track(taskId, childId);
            try {
                const child = await this.concat.run(references.map((reference) => reference.storageKey), "", "auto", childId, taskId);
                return firstMedia(await waitForTask(this.stores.tasks, child.id));
            } finally { this.untrack(taskId, childId); }
        }
        if (plan.kind === "direct") {
            if (!this.directVideo) throw new Error("Backend 直连视频执行器未初始化");
            const childId = `video-direct-child-${taskId}`;
            this.assertActive(taskId);
            this.track(taskId, childId);
            try {
                const modelValues = recordOf(recordOf(plan.input.params?.selectedVideoModelFieldValues)[`direct:${plan.input.model}`]);
                const directInput = {
                    ...plan.input,
                    seconds: String(modelValues.seconds ?? plan.input.seconds ?? "6"),
                    size: String(modelValues.size ?? plan.input.size ?? "1280x720"),
                    resolution: String(modelValues.resolution ?? plan.input.resolution ?? "720p"),
                };
                await this.directVideo.run(directInput, childId, { parentTaskId: taskId, channelId: decodeChannelModel(plan.input.model)?.channelId, seconds: directInput.seconds, size: directInput.size, resolution: directInput.resolution });
                return firstMedia(await waitForTask(this.stores.tasks, childId));
            } finally { this.untrack(taskId, childId); }
        }
        if (plan.kind === "runninghub-workflow") {
            throw new Error("RunningHub 执行已迁移到执行引擎（comfyui2api），画布不再本地跑云端工作流");
        }
        if (plan.kind === "preset") {
            const childId = `video-comfy-child-${taskId}`;
            this.assertActive(taskId);
            this.track(taskId, childId);
            try {
                throw new Error("本地 ComfyUI 预设执行已下线：请改用执行引擎提供的模型");
            } finally { this.untrack(taskId, childId); }
        }
        if (plan.kind === "engine" && plan.engine) {
            return this.dispatchVideoViaEngine(plan, taskId);
        }
        const detail = await this.workflows.get(plan.workflow!);
        // 引擎已返回 API 格式图，无需再转换。
        const baseConfig = detail.config || emptyWorkflowConfig(plan.workflow!);
        let fields = baseConfig.fields || [];
        let effectiveConfig = baseConfig;
        const values: Record<string, unknown> = { ...(plan.input.params || {}) };
        if (values.seconds === undefined && plan.input.seconds !== undefined) values.seconds = plan.input.seconds;
        const configuredVideoFields = recordOf(plan.input.params?.selectedVideoModelFieldValues);
        const selectedVideoFields = selectedWorkflowFieldValues(configuredVideoFields, plan.input.model, plan.workflow!);
        Object.assign(values, selectedVideoFields);
        for (const field of fields) if (field.type === "text" && (field.isPrompt || field.id.toLowerCase() === "prompt")) values[field.id] = plan.input.prompt;
        // 时长输入节点（与 isPrompt 同构）：声明过就以制作台秒数为准，换算后直接写图，
        // 覆盖同位置的手填字段值，且不让 buildParams 的 Math.round 把小数秒抹成整数。
        const durationTarget = parseWorkflowDurationTarget(baseConfig.durationTarget);
        if (durationTarget) {
            const seconds = readDurationSeconds(values, plan.input);
            if (seconds !== null) {
                const resolved = injectDurationTarget(
                    detail.workflow,
                    durationTarget,
                    resolveDurationValue(seconds, durationTarget.unit),
                );
                if (resolved.injected) {
                    detail.workflow = resolved.workflow;
                    const kept = fields.filter((field) => !(String(field.node) === durationTarget.nodeId && field.input === durationTarget.input));
                    if (kept.length !== fields.length) {
                        fields = kept;
                        effectiveConfig = { ...baseConfig, fields };
                    }
                }
            }
        }
        const imageFields = fields.filter((field) => isImageField(field, detail.workflow));
        const videoFields = fields.filter((field) => isVideoField(field, detail.workflow));
        const audioFields = fields.filter((field) => isAudioField(field, detail.workflow));
        await this.fillMediaFields(values, imageFields, plan.input.references || []);
        await this.fillMediaFields(values, videoFields, plan.input.videoReferences || []);
        await this.fillMediaFields(values, audioFields, plan.input.audioReferences || []);
        // 视频续写守卫：resume_prev 只有真的拿到上一段视频种子才允许打开。种子缺失时
        // 若仍走续段分支，工作流首段迭代会消费空的循环携带值，导致
        // h3_context_noise: expected an IMAGE batch [B,H,W,C], got () 直接崩任务
        // （2026-11-08）。降级为普通分段运行并留痕，保证任务不中断。
        if (values.resume_prev === true && !values.prev_video) {
            values.resume_prev = false;
            console.warn(`[video-dispatcher:${taskId}] resume_prev=true 但 prev_video 种子缺失（工作流未声明/未提供上一段视频加载器），已降级为普通分段运行`);
        }
        for (const [kind, supplied, mapped] of [
            ["图片", plan.input.references || [], imageFields],
            ["视频", plan.input.videoReferences || [], videoFields],
            ["音频", plan.input.audioReferences || [], audioFields],
        ] as const) {
            if (supplied.length > mapped.length) throw new Error(`所选视频模型的工作流没有映射全部${kind}参考（收到 ${supplied.length} 个，映射 ${mapped.length} 个）`);
        }
        const childId = `video-workflow-child-${taskId}`;
        this.assertActive(taskId);
        this.track(taskId, childId);
        try {
            const existing = this.stores.tasks.get(childId);
            if (existing && ["succeeded", "failed", "cancelled"].includes(existing.status)) return firstMedia(await waitForTask(this.stores.tasks, childId));
            void childId;
            throw new Error("画布本地工作流模型已下线：请改用执行引擎（engine-local）里的同名模型");
        } finally { this.untrack(taskId, childId); }
    }

    /** 引擎路径：画布只发协议请求；字段与媒体槽位由 `/v1/models/{id}` 提供，时长由引擎注入。 */
    private async dispatchVideoViaEngine(plan: Plan, taskId: string): Promise<Record<string, unknown>> {
        const target = plan.engine!;
        const engine = new CanvasEngineClient(target.baseUrl, target.token);
        const workflowName = target.model;
        const info = await engine.modelInfo(workflowName);
        const values = workflowValues(plan.input, workflowName);
        if (values.seconds === undefined && plan.input.seconds !== undefined) values.seconds = plan.input.seconds;
        for (const field of info.fields) {
            if (field.type === "text" && (field.isPrompt || field.id.toLowerCase() === "prompt")) values[field.id] = plan.input.prompt;
        }
        const slots = info.mediaInputs;
        const fill = async (ids: string[], references: CanvasVideoReference[], label: string) => {
            if (references.length > ids.length) throw new Error(`所选视频模型的工作流没有映射全部${label}参考（收到 ${references.length} 个，映射 ${ids.length} 个）`);
            for (let index = 0; index < references.length; index++) {
                values[ids[index]] = await this.dataUrl(references[index]);
            }
        };
        await fill(slots.images, plan.input.references || [], "图片");
        await fill(slots.videos, plan.input.videoReferences || [], "视频");
        await fill(slots.audios, plan.input.audioReferences || [], "音频");

        const childId = `engine-video-child-${taskId}`;
        this.assertActive(taskId);
        this.track(taskId, childId);
        try {
            const created = await engine.createVideo({
                model: workflowName,
                prompt: plan.input.prompt,
                fields: values,
                seconds: plan.input.seconds,
                size: plan.input.size,
            });
            this.engineTasks.set(childId, { taskId: created.taskId, target });
            // 进程内的 engineTasks 会在 waitVideo 结束后清掉；失败任务的回捞需要持久化映射。
            this.stores.tasks.addEvent(taskId, "engine_submitted", { engineTaskId: created.taskId, baseUrl: target.baseUrl, model: plan.input.model });
            const finished = await engine.waitVideo(created.taskId);
            if (finished.status !== "succeeded") throw new Error(finished.error || `执行引擎返回 ${finished.status}`);
            this.assertActive(taskId);
            const imported = await importEngineMedia(this.stores.media, finished.media, (url) => engine.fetchMedia(url));
            const media = imported.find((item) => String(item.mimeType).startsWith("video/")) || imported[0];
            if (!media) throw new Error("视频工作流完成但没有返回媒体");
            return media;
        } finally {
            this.engineTasks.delete(childId);
            this.untrack(taskId, childId);
        }
    }

    private plan(input: CanvasVideoGenerationInput): Plan {
        if (input.model === CANVAS_VIDEO_TRIM_MODEL) {
            validateVideoTrimRange(input.params?.start, input.params?.end);
            if (!input.projectId || input.loopOutput || input.videoReferences?.length !== 1 || !input.videoReferences[0].storageKey) throw new Error("视频裁剪需要画布项目和一个已归档视频");
            if (!this.stores.media.meta(input.videoReferences[0].storageKey)?.mimeType.startsWith("video/")) throw new Error("视频裁剪输入不是已归档的视频");
            return { input, kind: "trim" };
        }
        if (input.model === CANVAS_VIDEO_CONCAT_MODEL) return { input, kind: "concat" };
        const config = this.stores.settings.get("ai.config");
        // 引擎渠道：模型属于 media-engine，执行走 /v1/videos 异步协议（自定义 comfyUrl 仍本地）
        const engineTarget = input.comfyUrl ? null : (findEngineChannel(config, input.model) ?? findComfyuiEngineTarget(config, input.model));
        if (engineTarget) return { input, kind: "engine", engine: engineTarget };
        if (usesWorkflowExecutor(config, input.model)) {
            const resolved = resolveWorkflowBindingForModel(config, input.model, Number.isSafeInteger(input.workflowReferenceCount) ? Number(input.workflowReferenceCount) : (input.references || []).length);
            if (!resolved.ok) throw new Error(`${workflowResolutionMessage(resolved)}（模型=${input.model}）`);
            const withParams = { ...input, params: { ...resolved.params, ...(input.params || {}) } };
            if (resolved.binding.provider === "runninghub") throw new Error("RunningHub 执行已迁移到执行引擎（comfyui2api），画布不再本地跑云端工作流");
            const workflowConfig = this.workflows.getConfig(resolved.binding.workflow);
            const profileId = workflowConfig?.runningHubProfileId;
            const requestedTarget = input.runTarget ?? workflowConfig?.runTarget ?? "local";
            const profile = undefined; // RunningHub 档案在引擎侧，画布不再本地解析
            const localBusy = requestedTarget === "hybrid" && (
                this.stores.tasks.list({ kind: "workflow", limit: 500 }).some((task) => ["queued", "running"].includes(task.status))
                || this.stores.tasks.list({ kind: "canvas-video", limit: 500 }).some((task) => ["queued", "running"].includes(task.status) && task.executor === "workflow")
            );
            if ((requestedTarget === "cloud" || localBusy) && profileId && !profile) throw new Error("绑定的 RunningHub 工作流档案不存在，请重新绑定");
            if (profileId && profile && (requestedTarget === "cloud" || localBusy)) {
                return { input: withParams, kind: "runninghub-workflow", runninghubProfileId: profileId, workflow: resolved.binding.workflow };
            }
            return { input: withParams, kind: "workflow", workflow: resolved.binding.workflow };
        }
        const workflow = builtinWorkflowName(input.model);
        if (workflow) return { input, kind: "workflow", workflow };
        if (input.preset) return { input, kind: "preset", preset: input.preset };
        const selected = findChannelModel(this.stores.settings.get("ai.config"), input.model);
        if (this.directVideo && selected && String(selected.channel.kind || "") !== "comfyui" && String((selected.model as Record<string, unknown>).capability || "") === "video") {
            if (input.videoReferences?.length || input.audioReferences?.length) throw new Error("所选直连视频模型目前只接受图片参考；请移除视频/音频参考或选择 ComfyUI 视频工作流模型");
            return { input, kind: "direct" };
        }
        throw new Error(`当前 Backend 没有视频模型执行器：${modelOptionName(input.model)}`);
    }

    private target(input: CanvasVideoGenerationInput) {
        if (!input.nodeId) return null;
        if (!input.projectId) throw new Error("画布视频任务指定 nodeId 时必须提供 projectId");
        const project = this.stores.projects.get(input.projectId);
        const node = project && (project.nodes as Array<Record<string, unknown>>).find((node) => node.id === input.nodeId);
        if (!project || (node?.type !== "video" && !(node?.type === "config" && (node.metadata as Record<string, unknown> | undefined)?.smart === true))) throw new Error("画布视频生成目标不存在，未启动模型");
        return project;
    }

    private findActive(input: CanvasVideoGenerationInput) {
        if (!input.projectId || input.model === CANVAS_VIDEO_TRIM_MODEL) return null;
        const source = input.sourceNodeId || input.nodeId;
        return this.stores.tasks.list({ kind: "canvas-video", projectId: input.projectId, limit: 500 })
            .find((task) => {
                if (!["queued", "running"].includes(task.status)) return false;
                const previous = task.input as CanvasVideoGenerationInput;
                if ((previous.sourceNodeId || task.nodeId) !== source) return false;
                if (!input.loopOutput) return !previous.loopOutput;
                return previous.loopOutput?.loopNodeId === input.loopOutput.loopNodeId
                    && previous.loopOutput?.roundIndex === input.loopOutput.roundIndex
                    && previous.loopOutput?.slotIndex === input.loopOutput.slotIndex;
            }) || null;
    }

    private prepare(input: CanvasVideoGenerationInput): CanvasVideoGenerationInput {
        const keep = (reference: CanvasVideoReference) => reference.dataUrl ? this.storeInline(reference) : reference;
        return { ...input, prompt: String(input.prompt || ""), references: input.references?.map(keep), videoReferences: input.videoReferences?.map(keep), audioReferences: input.audioReferences?.map(keep) };
    }
    private storeInline(reference: CanvasVideoReference) {
        const match = /^data:([^;,]+);base64,(.+)$/s.exec(reference.dataUrl || "");
        if (!match) throw new Error(`参考媒体不是有效 data URL：${reference.name || reference.id || "unknown"}`);
        const stored = this.stores.media.store(Buffer.from(match[2], "base64"), { name: reference.name || "reference", mimeType: reference.mimeType || match[1], category: "input" });
        const { dataUrl: _, ...rest } = reference;
        return { ...rest, storageKey: stored.storageKey, url: this.stores.media.url(stored) };
    }
    private async materialize(reference: CanvasVideoReference) {
        const existing = reference.storageKey && this.stores.media.meta(reference.storageKey);
        if (existing) return existing;
        if (!reference.url) throw new Error(`参考媒体不存在：${reference.name || reference.id || "unknown"}`);
        const response = await fetch(reference.url);
        if (!response.ok) throw new Error(`读取参考媒体失败（HTTP ${response.status}）`);
        return this.stores.media.store(Buffer.from(await response.arrayBuffer()), { name: reference.name || "reference", mimeType: reference.mimeType || response.headers.get("content-type") || "application/octet-stream", category: "input" });
    }
    private async fillMediaFields(values: Record<string, unknown>, fields: WorkflowField[], references: CanvasVideoReference[]) {
        for (let index = 0; index < fields.length; index++) {
            const field = fields[index];
            const explicit = values[field.id];
            // 没有对应位置的参考时，保留显式注入的字段值（如视频续写的 prev_video URL），
            // 不能按位置冲成 null——否则种子加载器会被 removeEmptyMediaNodes 当空媒体剪掉。
            values[field.id] = references[index]
                ? await this.dataUrl(references[index])
                : (explicit !== undefined && explicit !== null && String(explicit).trim() !== "" ? explicit : null);
        }
    }
    private async dataUrl(reference: CanvasVideoReference) { const stored = await this.materialize(reference); return `data:${stored.mimeType};base64,${(await this.stores.media.read(stored.storageKey)).toString("base64")}`; }
    private assertActive(taskId: string) { if (this.stores.tasks.get(taskId)?.status === "cancelled") throw new Error("视频任务已取消，未启动子执行器"); }
    private track(parent: string, child: string) { const set = this.children.get(parent) || new Set<string>(); set.add(child); this.children.set(parent, set); }
    private untrack(parent: string, child: string) { const set = this.children.get(parent); set?.delete(child); if (!set?.size) this.children.delete(parent); }
    private fail(task: RuntimeTask, input: CanvasVideoGenerationInput, error: unknown, logId?: string | null, startedAt?: number) {
        const current = this.stores.tasks.get(task.id);
        if (!current || current.status === "cancelled") return;
        const message = messageOf(error);
        const failed = this.stores.tasks.update(task.id, { status: "failed", error: message });
        const log = logId ? this.stores.logs.get(logId) : this.stores.logs.list({ runtimeTaskId: task.id, limit: 1 })[0];
        if (log) this.stores.logs.update(log.id, { status: "failed", error: message, finishedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - (startedAt || Date.parse(log.startedAt))) });
        if (input.projectId && input.nodeId) this.stores.projects.markCanvasVideoTaskFailed(failed, input as Required<Pick<CanvasVideoGenerationInput, "projectId" | "nodeId">>, message);
    }
}

function bindSource(project: CanvasProject, input: CanvasVideoGenerationInput, taskId: string) {
    if (input.loopOutput) return [];
    if (!input.sourceNodeId || input.sourceNodeId === input.nodeId) return [];
    const source = (project.nodes as Array<Record<string, any>>).find((node) => node.id === input.sourceNodeId);
    return source?.type === "config" ? [{ type: "update_node", id: input.sourceNodeId, metadata: { status: "loading", runtimeTaskId: taskId }, metadataDelete: ["errorDetails"] }] : [];
}
function isImageField(field: WorkflowField, workflow: Record<string, unknown>) { return field.type === "image" || field.node.split(",").some((id) => (workflow[id] as any)?.class_type === "LoadImage"); }
function isVideoField(field: WorkflowField, workflow: Record<string, unknown>) { return field.type === "video" || field.node.split(",").some((id) => /(?:^|_)LoadVideo/.test((workflow[id] as any)?.class_type || "")); }
function isAudioField(field: WorkflowField, workflow: Record<string, unknown>) { return field.type === "audio" || field.node.split(",").some((id) => /(?:^|_)LoadAudio/.test((workflow[id] as any)?.class_type || "")); }
function emptyWorkflowConfig(name: string): WorkflowConfig { return { title: name, backend: "", operation: "", description: "", fields: [] }; }
function recordOf(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/** 字段值查找：UI 持久化用 `model::workflow`（旧数据用裸 workflow）；H3 运行时的续写注入
 *  在用户从未自定义过字段时只能写裸 model 键（注入点解析不到路由后的工作流名），一并兜底。 */
function selectedWorkflowFieldValues(configured: Record<string, unknown>, model: string, workflow: string) {
    return recordOf(configured[`${model}::${workflow}`] ?? configured[workflow] ?? configured[model]);
}
function workflowValues(input: CanvasVideoGenerationInput, workflow: string) {
    const values = { ...(input.params || {}) };
    const configured = recordOf(values.selectedVideoModelFieldValues);
    Object.assign(values, selectedWorkflowFieldValues(configured, input.model, workflow));
    delete values.selectedVideoModelFieldValues;
    // Keep generic canvas video settings available to RunningHub's node::input
    // bridge. The local WorkflowExecutor applies these same fallback values before
    // injecting its fields; without this, RH keeps profile.fieldValue (often 12s).
    for (const key of ["seconds", "size", "resolution", "width", "height"] as const) {
        if (values[key] === undefined && input[key] !== undefined) values[key] = input[key];
    }
    if (values.seconds === undefined && values.duration !== undefined) values.seconds = values.duration;
    return values;
}
function messageOf(error: unknown) {
    if (error instanceof Error) return error.message;
    // 引擎回执里的 error 可能是 {code, message} 对象：直接 String() 会写成 [object Object]。
    if (error && typeof error === "object") {
        const item = error as { message?: unknown; code?: unknown; error?: unknown };
        if (typeof item.message === "string" && item.message.trim()) return item.message;
        if (typeof item.error === "string" && item.error.trim()) return item.error;
        if (typeof item.code === "string" && item.code.trim()) return item.code;
        try { return JSON.stringify(error); } catch { return "未知错误"; }
    }
    return String(error);
}
async function waitForTask(tasks: TaskStore, id: string) { for (;;) { const task = tasks.get(id); if (!task) throw new Error(`生成任务不存在：${id}`); if (task.status === "succeeded") return task; if (["failed", "cancelled"].includes(task.status)) throw new Error(task.error || `生成任务${task.status}`); await new Promise((resolve) => setTimeout(resolve, 500)); } }
function firstMedia(task: RuntimeTask) { const media = task.result?.media; const values = Array.isArray(media) ? media : media && typeof media === "object" ? [media] : []; const output = values.find((item: any) => String(item?.mimeType || "").startsWith("video/")) || values[0]; if (!output || typeof output !== "object") throw new Error("视频任务完成但没有返回媒体"); return output as Record<string, unknown>; }
