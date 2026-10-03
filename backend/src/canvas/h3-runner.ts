import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertReferenceCompilation, compileReferenceSubmission } from "@basketikun/canvas-agent/reference-contract";
import { applyH3StyleTemplate, isH3StyleTemplateId, styleTemplateFromPrompt } from "@basketikun/canvas-agent/plugins/minimax-h3/style-templates";

import type { CanvasProject, RuntimeTask } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import type { RunningHubBackend } from "../runtime/runninghub.js";
import type { CanvasVideoDispatcher } from "./video-dispatcher.js";
import { h3ExecutionMode, h3CanResumeQueued, h3LocalOnlyReason } from "../runtime/h3-queue.js";
import type { Stores } from "../stores/types.js";
import { writeBackH3Task } from "./h3-task-writeback.js";
import { createLogger } from "../logger.js";
import { h3ClipCacheFingerprint, h3ClipCacheFingerprintV1, h3ConfirmationKind, h3ConfirmationFingerprintParams, h3ConfirmationPhaseParams, pickH3PostpassParams, stableH3Fingerprint } from "./h3-cache.js";
import { appendScenePalettePrompt, sceneNodesByIds } from "./scene-generation-context.js";
import { cleanupStoryboardCompositeDirectory, createStoryboardComposite, remapCompositePrompt, storyboardCompositeDirective, storyboardCompositePlan } from "./storyboard-composite.js";
import { H3_PARAM_KEYS, resolveH3Runtime, normalizeH3Params, randomH3Seed, estimateH3Dimensions, canonicalH3AspectRatio, h3StoryboardIssues, h3PromptContent } from "./h3-params.js";
import type { CanvasOperation } from "./project-ops.js";

type H3RunInput = {
    projectId: string;
    nodeId?: string;
    nodeIds?: string[];
    segmentId?: string;
    endSegmentId?: string;
    segmentIndex?: number;
    runFromCurrent?: boolean;
    skipCompleted?: boolean;
    forceRegenerate?: boolean;
    expectedPlanHash?: string;
    params?: Record<string, unknown>;
    runPlan?: H3RunPlan;
};

type H3Ref = Record<string, unknown> & { url?: string; storageKey?: string; name?: string; label?: string; type?: string; mediaType?: string; role?: string; order?: number };
type H3Segment = Record<string, unknown> & { id?: string; prompt?: string; result?: string; resultStorageKey?: string; refItems?: H3Ref[]; refs?: Record<string, H3Ref | H3Ref[]>; referenceBindings?: Record<string, unknown>[]; continuationGroupId?: string; motionContextEnabled?: boolean; storyboardCompositeEnabled?: boolean };
type H3Plan = { nodeId: string; segmentId: string; segmentIndex: number; continuation?: { group: string; index: number } };
type H3ResumeSeed = { nodeId: string; sourceNodeId: string; group: string; previousIndex: number; sourceParentTaskId: string; sourceChildTaskId: string; sourceSegmentId: string; sourceStorageKey: string; contextParams: Record<string, unknown> };
type H3RunPlan = { version: 1; plans: H3Plan[]; project: { nodes: Array<Record<string, unknown>>; referenceCatalog: Array<Record<string, unknown>> }; defaults: Record<string, unknown>; requirements?: import('../stores/types.js').H3ProductionRequirements | null; resumeSeed?: H3ResumeSeed };
type PendingH3 = { nodeId: string; segmentId: string; firstPassFingerprint: string; firstPassResult: string; firstPassStorageKey?: string; firstPassChildTaskId: string; previousOutput: { result?: string; resultStorageKey?: string; cacheFingerprint?: string } };
type H3Confirmation = { cursor: number; pending: PendingH3[]; inFlight?: { nodeId: string; segmentId: string; action: "confirm"; attempt: number; childTaskId: string; postpassParams: Record<string, unknown> }; revision: number; prepared?: PendingH3["previousOutput"] };
export type H3ConfirmationAction = { action: "confirm" | "keep_first_pass" | "discard"; segmentId: string; expectedRevision: number; postpassParams?: Record<string, unknown> };

const H3_DEFAULTS_KEY = "plugin:minimax-h3:defaults:v1";
const logger = createLogger("h3-runner");

/** 只重放仍被画布节点或 Clip 绑定的父任务；已收口的历史任务不会再改变画布。 */
export function boundH3ParentTaskIds(projects: CanvasProject[]): Set<string> {
    const ids = new Set<string>();
    for (const project of projects) {
        const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
        for (const node of nodes) {
            const metadata = recordOf(node.metadata);
            const nodeTaskId = String(metadata.runtimeTaskId || "");
            if (nodeTaskId) ids.add(nodeTaskId);
            const segments = Array.isArray(metadata.segments) ? metadata.segments : [];
            for (const segment of segments) {
                const clip = recordOf(segment);
                const parentTaskId = String(clip.parentTaskId || "");
                const status = String(clip.status || "");
                if (parentTaskId && (clip.runtimeTaskId || ["queued", "loading", "awaiting_confirmation"].includes(status))) ids.add(parentTaskId);
            }
        }
    }
    return ids;
}


const H3_OUTGOING_CONTEXT_KEYS = ["contextLength", "audioContextLength", "continuationSeamNoiseEnabled", "continuationSeamNoiseMode", "continuationSeamNoise", "continuationSeamNoiseSeed", "continuationSeamNoiseRamp", "continuationAudioRefineEnabled", "continuationAudioDenoise", "continuationAudioSteps", "continuationAudioSampler", "continuationAudioScheduler"] as const;

function compileH3Submission(project: Record<string, unknown>, segment: H3Segment, taskMode: string) {
    const original = compileReferenceSubmission(project, { ...segment, taskMode });
    const composite = storyboardCompositePlan({ ...segment, taskMode });
    if (!composite) return { compilation: original, composite: null, editableReferences: original.references };
    const effectiveSegment = { ...segment, taskMode, referenceBindings: composite.bindings };
    const collapsed = compileReferenceSubmission(project, effectiveSegment);
    const mappedPrompt = remapCompositePrompt(String(segment.prompt || ""), composite, original.references, collapsed.references);
    const prompt = mappedPrompt.includes("A single submitted image is a composite storyboard sheet")
        ? mappedPrompt
        : appendToSection(mappedPrompt, "detailed_description", storyboardCompositeDirective(composite));
    return { compilation: compileReferenceSubmission(project, { ...effectiveSegment, prompt }), composite, editableReferences: original.references };
}

export class H3IdempotencyConflictError extends Error {
    readonly code = "IDEMPOTENCY_CONFLICT";

    constructor(readonly taskId: string) {
        super(`H3 幂等键 ${taskId} 已用于其他任务或不同运行请求`);
        this.name = "H3IdempotencyConflictError";
    }
}

export class CanvasH3Runner {
    private readonly currentChildren = new Map<string, string>();
    private readonly cancelled = new Set<string>();
    private readonly executing = new Set<string>();

    constructor(
        private readonly stores: Stores,
        private readonly events: BackendEventBus,
        private readonly comfy: ComfyUiBackend,
        private readonly runningHub: RunningHubBackend,
        private readonly videoDispatcher?: CanvasVideoDispatcher,
    ) {}

    /** Pure preview: no canonical ops, seed generation, task creation or media writes. */
    preview(input: H3RunInput) {
        const normalized = normalizeInput(input);
        const project = this.stores.projects.get(normalized.projectId);
        if (!project) throw new Error(`画布不存在: ${normalized.projectId}`);
        const defaults = recordOf(this.stores.settings.get(H3_DEFAULTS_KEY));
        const requirements = this.stores.projects.getH3ProductionRequirements?.(normalized.projectId) || null;
        const { expectedPlanHash: _expected, runPlan: _plan, ...intent } = normalized;
        const diagnostics: Array<{ code: string; nodeId: string; segmentId: string; message: string }> = [];
        const clips = this.plansFor(normalized).map(plan => {
            const node = (project.nodes as Array<Record<string, unknown>>).find(item => item.id === plan.nodeId)!;
            const metadata = recordOf(node.metadata);
            const segment = (metadata.segments as H3Segment[]).find(item => item.id === plan.segmentId)!;
            const effective = resolveH3Runtime(segment, normalized.params || {}, metadata, defaults);
            const required = requirements?.clips.find(item => item.nodeId === plan.nodeId && item.segmentId === plan.segmentId);
            const expectedRatio = canonicalH3AspectRatio(requirements?.videoAspectRatio);
            const actualRatio = canonicalH3AspectRatio(effective.params.aspectRatio);
            const issue = (code: string, message: string) => diagnostics.push({ code, nodeId: plan.nodeId, segmentId: plan.segmentId, message });
            if (effective.params.selectedVideoModelEnabled === true && !String(effective.params.selectedVideoModel || "").trim()) issue("SELECTED_VIDEO_MODEL_REQUIRED", "已启用自选视频模型，请先选择一个已配置的视频模型");
            if (effective.params.selectedVideoModelEnabled === true && h3LocalOnlyReason(effective.params)) issue("SELECTED_VIDEO_MODEL_UNSUPPORTED_MODE", "当前 H3 专用的潜空间连续或分阶段确认功能不能与自选视频模型一起使用");
            if (segment.directorEngine && required?.promptContentHash && createHash('sha256').update(h3PromptContent(String(segment.prompt || ''))).digest('hex') !== required.promptContentHash) issue('DIRECTOR_PROMPT_CHANGED', 'Clip 正文与正式导演稿不一致；请保留完整对白、动作与镜头描述并重新编译发布');
            if (segment.directorEngine && required?.sourceHash && segment.directorSourceHash !== required.sourceHash) issue('DIRECTOR_SOURCE_STALE', 'Clip 所属导演源哈希已过期');
            if (expectedRatio && actualRatio !== expectedRatio) issue('PRODUCTION_ASPECT_RATIO_MISMATCH', `制作要求 ${expectedRatio}，Clip 实际配置 ${effective.params.aspectRatio}`);
            if (requirements?.videoAspectRatio && !expectedRatio) issue('INVALID_PRODUCTION_ASPECT_RATIO', '制作画幅无效');
            for (const message of h3StoryboardIssues(segment, required && (required.storyboardRequired || Array.isArray(segment.storyboardShots) && segment.storyboardShots.length > 0) ? required.shots : undefined)) issue('STORYBOARD_MISMATCH', message);
            let compilation: ReturnType<typeof compileReferenceSubmission> | undefined;
            try { compilation = compileH3Submission(project, segment, String(effective.params.taskMode)).compilation; assertReferenceCompilation(compilation); }
            catch (error) { issue('REFERENCE_INVALID', (error as Error).message); }
            for (const dialogue of required?.literalDialogues || []) if (dialogue.text && !(compilation?.compiledPrompt || String(segment.prompt || '')).includes(dialogue.text)) issue('SCRIPT_DIALOGUE_MISSING', `正式剧本对白 ${dialogue.blockId} 未完整进入本段提示词：${dialogue.text}`);
            if (plan.continuation && effective.params.latentUpscaleEnabled === true) issue('INCOMPATIBLE_PARAMETERS', '潜空间续写不能与潜空间放大二采混用');
            const { params, sources, policy } = effective;
            return { nodeId: plan.nodeId, segmentId: plan.segmentId, savedRuntime: Object.fromEntries(H3_PARAM_KEYS.filter(key => segment[key] !== undefined).map(key => [key, segment[key]])), effectiveRuntime: params, parameterSources: sources, policy,
                expectedDimensions: { firstPass: estimateH3Dimensions(params), final: estimateH3Dimensions(params, params.latentUpscaleEnabled === true) },
                promptHash: stableH3Fingerprint(compilation?.compiledPrompt || segment.prompt || ''), referenceMap: compilation?.references.map(ref => ({ id: ref.id, token: ref.token, role: ref.role, subjectId: ref.subjectId, sourceNodeId: ref.sourceNodeId, storageKey: ref.storageKey })) || [] };
        });
        const planHash = stableH3Fingerprint({ intent, revision: project.revision, defaults, requirements, nodes: project.nodes, catalog: project.referenceCatalog });
        return { ready: clips.length > 0 && diagnostics.length === 0, revision: Number(project.revision || 0), planHash, requirements, clips, diagnostics };
    }

    start(input: H3RunInput, clientTaskId?: string) {
        const normalized = normalizeInput(input);
        // Replay immutable caller intent before consulting today's draft/defaults.
        // The persisted runPlan is execution history, not part of that intent.
        const existing = clientTaskId ? this.stores.tasks.get(clientTaskId) : null;
        if (existing) {
            if (existing.kind !== "canvas-h3-run" || h3RunIntentFingerprint(normalized) !== h3RunIntentFingerprint(existing.input as H3RunInput)) {
                throw new H3IdempotencyConflictError(existing.id);
            }
            return existing;
        }
        if (normalized.params?.confirmSecondPass === true) throw new Error("请通过 H3 确认接口继续原任务，不能另建二采任务");
        const project = this.stores.projects.get(normalized.projectId);
        if (!project) throw new Error(`画布不存在: ${normalized.projectId}`);
        const preview = this.preview(normalized);
        if (normalized.expectedPlanHash && normalized.expectedPlanHash !== preview.planHash) throw Object.assign(new Error('生成预检已过期，请重新读取参数与预检'), { code: 'STALE_H3_PREVIEW', preview });
        const blocking = preview.diagnostics.filter(issue => issue.code !== 'REFERENCE_INVALID');
        if (blocking.length) throw Object.assign(new Error(blocking.map(issue => `${issue.segmentId}: ${issue.message}`).join('；')), { code: 'H3_EXECUTION_CONTRACT_MISMATCH', diagnostics: blocking });
        // 单个 Clip 的参考素材不完整只跳过它自己；其余 Clip 必须照常入队，不能整批卡死。
        const blockedPlans = this.validatePlannedReferences(project, normalized);
        const duplicate = this.findActiveDuplicate(normalized);
        if (duplicate) {
            // 旧投影可能因同节点另一 Clip 占据顶层 taskId 而丢失；即使拒绝新提交，
            // 也恢复原任务的确认入口，不能让用户只看见重新生成按钮。
            if (duplicate.status === "awaiting_confirmation") this.projectAwaiting(duplicate);
            const pending = confirmationOf(duplicate).pending[0];
            const { runPlan: _frozen, ...originalInput } = duplicate.input as H3RunInput;
            const sameInput = stableH3Fingerprint(normalized) === stableH3Fingerprint(originalInput);
            const plan = pending && this.plansForTask(duplicate).find((item) => item.nodeId === pending.nodeId && item.segmentId === pending.segmentId);
            const sameClip = plan && this.clipCacheState(normalized, plan, normalized.params || {}, new Map()).fingerprint === pending.firstPassFingerprint;
            if (!sameInput || (duplicate.status === "awaiting_confirmation" && !sameClip)) throw new Error(`H3 Clip 正被任务 ${duplicate.id} 占用；请先完成或放弃该任务`);
            return duplicate;
        }
        const runPlan = this.buildRunPlan(normalized, blockedPlans);
        if (blockedPlans.length) logger.warn("H3 批量运行跳过参考素材不完整的 Clip", { projectId: normalized.projectId, blocked: blockedPlans.map((item) => `${item.segmentId}: ${item.reason}`) });
        const frozenInput = { ...normalized, runPlan };
        const created = clientTaskId
            ? this.stores.tasks.create(clientTaskId, "canvas-h3-run", frozenInput, {})
            : this.stores.tasks.create("canvas-h3-run", frozenInput, {});
        const task = this.stores.tasks.update(created.id, { result: { plans: runPlan.plans } });
        this.publish(task, "task.created");
        this.bindParent(task);
        void this.execute(task).catch((error) => this.fail(task.id, error));
        return task;
    }

    private validatePlannedReferences(project: Record<string, unknown>, input: H3RunInput) {
        const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
        const wanted = input.nodeIds?.length ? new Set(input.nodeIds) : input.nodeId ? new Set([input.nodeId]) : null;
        // 逐 Clip 收集：坏 Clip 只影响自己，不能因为一个 Clip 而否掉整批计划。
        const blocked: Array<{ nodeId: string; segmentId: string; clipNumber: number; reason: string }> = [];
        for (const node of nodes.filter((item) => String(item.type || "").includes("minimax") && (!wanted || wanted.has(String(item.id || ""))))) {
            const segments = Array.isArray(recordOf(node.metadata).segments) ? recordOf(node.metadata).segments as H3Segment[] : [];
            for (const plan of this.planNode(node, input)) {
                const segment = segments.find((item) => String(item.id || "") === plan.segmentId);
                if (!segment) continue;
                const taskMode = normalizeTaskMode(input.params?.mode || input.params?.taskMode || segment.mode || segment.taskMode);
                try {
                    assertReferenceCompilation(compileH3Submission(project, segment, taskMode).compilation);
                } catch (error) {
                    blocked.push({ nodeId: String(node.id || ""), segmentId: String(plan.segmentId || ""), clipNumber: plan.segmentIndex + 1, reason: (error as Error).message });
                }
            }
        }
        return blocked;
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
        if (!requested.size) for (const key of this.targetKeys(project, { ...input, skipCompleted: false })) requested.add(key);
        if (!requested.size) return null;
        const active: RuntimeTask[] = [];
        for (const status of ["queued", "running", "awaiting_confirmation"] as const) {
            for (let offset = 0; ; offset += 500) {
                const page = this.stores.tasks.list({ kind: "canvas-h3-run", projectId: input.projectId, status, limit: 500, offset });
                active.push(...page);
                if (page.length < 500) break;
            }
        }
        return active.find((task) => {
                const targets = task.result?.plans;
                const original = normalizeInput(task.input as H3RunInput);
                const keys = Array.isArray(targets) ? targets.map((plan) => `${String(recordOf(plan).nodeId || "")}:${String(recordOf(plan).segmentId || "")}`) : this.targetKeys(project, { ...original, skipCompleted: false });
                return keys.some((key) => requested.has(key));
            }) || null;
    }

    private targetKeys(project: Record<string, unknown>, input: H3RunInput) {
        const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
        const wanted = input.nodeIds?.length ? new Set(input.nodeIds) : input.nodeId ? new Set([input.nodeId]) : null;
        return nodes
            .filter((node) => String(node.type || "").includes("minimax") && (!wanted || wanted.has(String(node.id || ""))))
            .flatMap((node) => this.planNode(node, input).map((plan) => `${plan.nodeId}:${plan.segmentId}`));
    }

    resume(task: RuntimeTask) {
        if (task.kind === "canvas-h3-run" && task.status === "awaiting_confirmation") {
            this.projectAwaiting(task);
            return task;
        }
        if (task.kind !== "canvas-h3-run" || !["queued", "running"].includes(task.status)) return task;
        void this.execute(task).catch((error) => this.fail(task.id, error));
        return task;
    }

    /** 用户决议只允许当前待确认的单段；持久 CAS 成功后才唤醒驱动器。 */
    resolveConfirmation(id: string, request: H3ConfirmationAction): RuntimeTask {
        const current = this.stores.tasks.get(id);
        if (!current || current.kind !== "canvas-h3-run") throw new Error("找不到 H3 父任务");
        const confirmation = confirmationOf(current);
        const pending = confirmation.pending[0];
        const previousDecision = [...this.stores.tasks.events(id)].reverse().find((item) => item.type === "h3_decision" && String(item.payload.segmentId) === request.segmentId && Number(item.payload.expectedRevision) === request.expectedRevision);
        if (previousDecision) {
            if (previousDecision.payload.action === request.action) return current;
            throw new Error("H3 决议冲突，请刷新任务");
        }
        if (current.status !== "awaiting_confirmation" || !pending) {
            throw new Error("H3 任务不是待确认状态或决议冲突");
        }
        if (request.segmentId !== pending.segmentId || request.expectedRevision !== confirmation.revision) throw new Error("H3 确认快照已变化，请刷新后重试");
        const input = normalizeInput(current.input as H3RunInput);
        const project = this.stores.projects.get(input.projectId);
        const node = project && (project.nodes as Array<Record<string, unknown>>).find((item) => String(item.id || "") === pending.nodeId);
        const segment = Array.isArray(recordOf(node?.metadata).segments) ? (recordOf(node?.metadata).segments as H3Segment[]).find((item) => item.id === pending.segmentId) : undefined;
        if (!segment || segment.firstPassReady !== true || String(segment.firstPassFingerprint || "") !== pending.firstPassFingerprint || String(segment.firstPassResult || "") !== pending.firstPassResult || String(segment.runtimeTaskId || "") !== id || (segment.parentTaskId && segment.parentTaskId !== id)) throw new Error("H3 一采或节点绑定已变化，请刷新后重试");
        const plans = this.plansForTask(current);
        const plan = plans.find((item) => item.nodeId === pending.nodeId && item.segmentId === pending.segmentId);
        if (!plan) throw new Error("H3 目标 Clip 已从执行计划中移除");
        const frozenProject = this.projectFor(input);
        const frozenNodes = Array.isArray(frozenProject.nodes) ? frozenProject.nodes as Array<Record<string, unknown>> : [];
        const frozenNode = frozenNodes.find((item) => String(item.id) === pending.nodeId);
        const frozenMetadata = recordOf(frozenNode?.metadata);
        const frozenSegment = (Array.isArray(frozenMetadata.segments) ? frozenMetadata.segments as H3Segment[] : []).find((item) => item.id === pending.segmentId);
        if (!frozenSegment) throw new Error("H3 运行快照缺少目标 Clip");
        let inFlight: H3Confirmation["inFlight"];
        if (request.action === "confirm") {
            const defaults = input.runPlan?.defaults || recordOf(this.stores.settings.get(H3_DEFAULTS_KEY));
            const frozenOverride = this.withPlannedSeed(input, plan, input.params || {});
            const frozenParams = extractParams(frozenSegment, frozenOverride, frozenMetadata, defaults);
            const kind = h3ConfirmationKind(frozenSegment, frozenParams);
            const firstChild = this.stores.tasks.get(pending.firstPassChildTaskId);
            if (!kind || (kind === "latent") !== (firstChild?.params.latentConfirmationPhase === "first")) throw new Error("待确认一采与生成模式不匹配，不能转为另一种二采；请保留一采或放弃后重新生成");
            const completedFingerprints = new Map(this.stores.tasks.events(id)
                .filter((event) => (event.type === "clip_completed" || event.type === "clip_reused") && event.payload.fingerprint)
                .map((event) => [`${event.payload.nodeId}:${event.payload.segmentId}`, String(event.payload.fingerprint)]));
            const cache = this.clipCacheState(input, plan, { ...input.params, confirmSecondPass: true }, completedFingerprints);
            if (![cache.fingerprint, cache.legacyFingerprint, cache.loggedLegacyFingerprint].includes(pending.firstPassFingerprint)) throw new Error("H3 参数或上游已变化，请重新生成一采");
            const attempt = this.stores.tasks.events(id).filter((item) => item.type === "h3_decision" && item.payload.action === "confirm" && item.payload.segmentId === pending.segmentId).length + 1;
            inFlight = { nodeId: pending.nodeId, segmentId: pending.segmentId, action: "confirm", attempt, childTaskId: h3ChildId(id, pending.nodeId, pending.segmentId, "second_pass", attempt), postpassParams: extractParams(frozenSegment, { ...frozenOverride, ...pickH3PostpassParams(recordOf(request.postpassParams), frozenParams.latentUpscaleEnabled === true), confirmSecondPass: true }, frozenMetadata, defaults) };
        }
        const nextConfirmation: H3Confirmation = { ...confirmation, revision: confirmation.revision + 1, ...(inFlight ? { inFlight } : {}) };
        if (!inFlight) delete nextConfirmation.inFlight;
        const status = request.action === "discard" ? "cancelled" : "running";
        const result = { ...recordOf(current.result), phase: request.action === "discard" ? "complete" : inFlight ? "second_pass" : "remaining", confirmation: nextConfirmation };
        const updated = this.stores.tasks.transitionH3(id, "awaiting_confirmation", confirmation.revision, { status, result, error: null }, { type: "h3_decision", payload: { action: request.action, nodeId: pending.nodeId, segmentId: pending.segmentId, firstPassFingerprint: pending.firstPassFingerprint, expectedRevision: request.expectedRevision, ...(inFlight ? { childTaskId: inFlight.childTaskId } : {}) } });
        if (!updated) throw new Error("H3 决议已被其他请求处理，请刷新任务");
        this.publish(updated, "task.updated");
        if (request.action === "discard") {
            this.restorePrevious(input.projectId, pending, true);
            this.finishParentNode(updated, "cancelled");
        } else void this.execute(updated).catch((error) => this.fail(id, error));
        return this.stores.tasks.get(id)!;
    }

    private plansForTask(task: RuntimeTask): H3Plan[] {
        const frozen = (task.input as H3RunInput).runPlan;
        if (frozen?.version === 1) return frozen.plans;
        const plans = task.result?.plans;
        if (Array.isArray(plans)) return plans as H3Plan[];
        return this.plansFor(normalizeInput(task.input as H3RunInput));
    }

    private plansFor(input: H3RunInput) {
        const project = this.stores.projects.get(input.projectId);
        if (!project) throw new Error("H3 画布不存在");
        const nodes = project.nodes as Array<Record<string, unknown>>;
        const wanted = input.nodeIds?.length ? new Set(input.nodeIds) : input.nodeId ? new Set([input.nodeId]) : null;
        return nodes.filter((node) => String(node.type || "").includes("minimax") && (!wanted || wanted.has(String(node.id || "")))).flatMap((node) => this.planNode(node, input));
    }

    /** Resolve only the task that produced the predecessor currently bound to this canvas Clip. */
    private resolveResumeSeed(input: H3RunInput, plan: H3Plan, project: Record<string, unknown>, defaults: Record<string, unknown>): H3ResumeSeed {
        const continuation = plan.continuation;
        if (!continuation || continuation.index < 2 || plan.segmentIndex < 1) throw new Error("H3 续跑缺少上一段身份");
        const node = (project.nodes as Array<Record<string, unknown>>).find((item) => String(item.id || "") === plan.nodeId);
        const metadata = recordOf(node?.metadata);
        const segments = Array.isArray(metadata.segments) ? metadata.segments as H3Segment[] : [];
        const previous = segments[plan.segmentIndex - 1];
        const selected = segments[plan.segmentIndex];
        const storageKey = String(previous?.resultStorageKey || "");
        if (!previous?.id || !selected || !storageKey) throw new Error(`Clip ${plan.segmentIndex + 1} 缺少上一段已绑定的生成结果，需从组首运行`);
        const selectedParams = extractParams(selected, input.params || {}, metadata, defaults);
        for (const status of ["succeeded", "cancelled"] as const) {
            for (let offset = 0; ; offset += 500) {
                const parents = this.stores.tasks.list({ kind: "canvas-h3-run", projectId: input.projectId, status, limit: 500, offset });
                for (const parent of parents) {
                    const completed = [...this.stores.tasks.events(parent.id)].reverse().find((event) => event.type === "clip_completed"
                        && event.payload.segmentId === previous.id
                        && String(recordOf(event.payload.output).storageKey || "") === storageKey);
                    if (!completed) continue;
                    const sourceNodeId = String(completed.payload.nodeId || "");
                    const sourcePlan = (parent.input as H3RunInput).runPlan?.plans.find((item) => item.nodeId === sourceNodeId && item.segmentId === previous.id);
                    if (sourcePlan?.continuation?.group !== continuation.group || sourcePlan?.continuation?.index !== continuation.index - 1) continue;
                    const child = this.stores.tasks.get(String(completed.payload.childTaskId || ""));
                    const binding = recordOf(child?.params.canvasBinding);
                    if (child?.status !== "succeeded" || child.parentTaskId !== parent.id || binding.projectId !== input.projectId
                        || binding.nodeId !== sourceNodeId || binding.segmentId !== previous.id) continue;
                    let descriptor: Record<string, unknown>;
                    try { descriptor = JSON.parse(String(child.params.continuationTask || "")) as Record<string, unknown>; } catch { continue; }
                    if (descriptor.workflow !== input.projectId || descriptor.node !== "nf_v15" || descriptor.group !== continuation.group
                        || descriptor.run !== parent.id || descriptor.index !== continuation.index - 1) continue;
                    for (const key of ["aspectRatio", "megapixels", "sizeMultiple", "latentUpscaleAlign", "modelName", "videoVae", "audioVae"] as const) {
                        if (JSON.stringify(child.params[key]) !== JSON.stringify(selectedParams[key])) {
                            throw new Error(`Clip ${plan.segmentIndex + 1} 的 ${key} 与上一段潜变量不匹配，请恢复参数或从组首运行`);
                        }
                    }
                    return {
                        nodeId: plan.nodeId, sourceNodeId, group: continuation.group, previousIndex: continuation.index - 1,
                        sourceParentTaskId: parent.id, sourceChildTaskId: child.id, sourceSegmentId: String(previous.id), sourceStorageKey: storageKey,
                        contextParams: Object.fromEntries(H3_OUTGOING_CONTEXT_KEYS.filter((key) => child.params[key] !== undefined).map((key) => [key, child.params[key]])),
                    };
                }
                if (parents.length < 500) break;
            }
        }
        throw new Error(`Clip ${plan.segmentIndex + 1} 找不到与上一段当前成片匹配的潜空间续写任务，请从组首运行`);
    }

    private buildRunPlan(input: H3RunInput, blockedPlans: Array<{ nodeId: string; segmentId: string; clipNumber: number; reason: string }> = []): H3RunPlan {
        const blockedKeys = new Set(blockedPlans.map((item) => `${item.nodeId}:${item.segmentId}`));
        const allPlans = this.plansFor(input);
        if (allPlans.some((plan) => plan.continuation && blockedKeys.has(`${plan.nodeId}:${plan.segmentId}`))) {
            throw new Error("潜空间续写不能跳过连续组中的 Clip；请修复参考素材后从组首重新运行");
        }
        const plans = allPlans.filter((plan) => !blockedKeys.has(`${plan.nodeId}:${plan.segmentId}`));
        if (!plans.length) throw new Error(blockedPlans.length
            ? `没有可运行的 H3 Clip：${blockedPlans.slice(0, 3).map((item) => `Clip ${item.clipNumber}：${item.reason}`).join("；")}`
            : "没有符合条件的 H3 Clip");
        const before = this.stores.projects.get(input.projectId)!;
        const defaults = recordOf(this.stores.settings.get(H3_DEFAULTS_KEY));
        if (plans[0].continuation?.index && plans[0].continuation.index > 1 && new Set(plans.map((plan) => plan.nodeId)).size !== 1) {
            throw new Error("从组中间接入潜变量时只能选择一个 H3 节点");
        }
        const resumeSeed = plans[0].continuation && plans[0].continuation.index > 1
            ? this.resolveResumeSeed(input, plans[0], before, defaults)
            : undefined;
        const sizeOps = (before.nodes as Array<Record<string, unknown>>).flatMap((node) => {
            const groups = new Map<string, H3Plan[]>();
            for (const plan of plans.filter((item) => item.nodeId === node.id && item.continuation)) {
                const group = plan.continuation!.group;
                groups.set(group, [...(groups.get(group) || []), plan]);
            }
            if (!groups.size) return [];
            // A latent chain cannot skip its head or any middle clip, even if that clip's references are invalid.
            const metadata = recordOf(node.metadata);
            const segments = Array.isArray(metadata.segments) ? metadata.segments as H3Segment[] : [];
            return [...groups.values()].flatMap((nodePlans) => {
                const firstIndex = resumeSeed && nodePlans[0].nodeId === resumeSeed.nodeId && nodePlans[0].continuation?.group === resumeSeed.group ? resumeSeed.previousIndex + 1 : 1;
                if (nodePlans[0].continuation?.index !== firstIndex || nodePlans.some((plan, index) => plan.continuation?.index !== firstIndex + index)) {
                    throw new Error("潜空间续写不能跳过连续组中的 Clip；请修复参考素材后从组首重新运行");
                }
                const head = segments.find((segment) => segment.id === nodePlans[0].segmentId);
                if (!head) throw new Error("潜空间续写组首 Clip 已不存在");
                const headParams = extractParams(head, input.params || {}, metadata, defaults);
                const aspectRatio = String(headParams.aspectRatio || "");
                const megapixels = Number(headParams.megapixels);
                const sizeMultiple = Number(headParams.sizeMultiple || 32);
                const latentUpscaleAlign = Number(headParams.latentUpscaleAlign || 2);
                if (!aspectRatio || aspectRatio === "原图比例" || !Number.isFinite(megapixels) || megapixels <= 0 || !Number.isFinite(sizeMultiple) || sizeMultiple <= 0 || !Number.isFinite(latentUpscaleAlign) || latentUpscaleAlign <= 0) {
                    throw new Error("潜空间续写需要组首 Clip 使用固定画幅和有效分辨率，才能让后续 Clip 继承同一潜变量尺寸");
                }
                if (nodePlans.some((plan) => {
                    const segment = segments.find((item) => item.id === plan.segmentId);
                    return segment && extractParams(segment, input.params || {}, metadata, defaults).latentUpscaleEnabled === true;
                })) throw new Error("潜空间续写当前不能与 H3 潜空间放大二采混用；二采会改变保存的潜变量尺寸");
                const inherited = { aspectRatio, megapixels, sizeMultiple, latentUpscaleAlign };
                return nodePlans.slice(1).flatMap((plan) => {
                    const segment = segments.find((item) => item.id === plan.segmentId);
                    if (!segment) throw new Error(`潜空间续写 Clip ${plan.segmentId} 已不存在`);
                    const patch = Object.fromEntries(Object.entries(inherited).filter(([key, value]) => segment[key] !== value));
                    return Object.keys(patch).length ? [{ type: "update_h3_segment", nodeId: plan.nodeId, segmentId: plan.segmentId, patch }] : [];
                });
            });
        });
        const canonicalOps = plans.flatMap((plan) => {
            const patch = this.canonicalSegmentPatch(before, plan, input.params || {}, true);
            return Object.keys(patch).length ? [{ type: "update_h3_segment", nodeId: plan.nodeId, segmentId: plan.segmentId, patch }] : [];
        });
        if (canonicalOps.length || sizeOps.length) this.stores.projects.applyOperations(input.projectId, Number(before.revision || 0), [...canonicalOps, ...sizeOps], { runtimeWrite: true, source: { clientId: "task:h3", kind: "task", label: "H3 参数规范化" } });
        const project = this.stores.projects.get(input.projectId)!;
        const nodes = project.nodes as Array<Record<string, unknown>>;
        const selectedNodeIds = new Set(plans.map((plan) => plan.nodeId));
        const sourceNodeIds = new Set<string>();
        const assetIds = new Set<string>();
        for (const node of nodes.filter((item) => selectedNodeIds.has(String(item.id)))) {
            const segments = recordOf(node.metadata).segments as H3Segment[];
            for (const plan of plans.filter((item) => item.nodeId === node.id)) {
                const segment = segments.find((item) => item.id === plan.segmentId);
                for (const binding of segment?.referenceBindings || []) {
                    if (binding.sourceNodeId) sourceNodeIds.add(String(binding.sourceNodeId));
                    if (binding.assetId) assetIds.add(String(binding.assetId));
                }
                for (const group of Object.values(recordOf(segment?.h3CharacterGroups))) {
                    const characterNodeId = recordOf(group).characterNodeId;
                    if (characterNodeId) sourceNodeIds.add(String(characterNodeId));
                }
            }
        }
        const catalog = Array.isArray(project.referenceCatalog) ? project.referenceCatalog as Array<Record<string, unknown>> : [];
        for (const asset of catalog) if (assetIds.has(String(asset.id)) && asset.sourceNodeId) sourceNodeIds.add(String(asset.sourceNodeId));
        return structuredClone({
            version: 1, plans,
            project: {
                nodes: nodes.filter((node) => selectedNodeIds.has(String(node.id)) || sourceNodeIds.has(String(node.id))),
                referenceCatalog: catalog.filter((asset) => assetIds.has(String(asset.id))),
            },
            defaults,
            requirements: this.stores.projects.getH3ProductionRequirements?.(input.projectId) || null,
            ...(resumeSeed ? { resumeSeed } : {}),
        });
    }

    private projectFor(input: H3RunInput) {
        return input.runPlan?.version === 1 ? input.runPlan.project : this.stores.projects.get(input.projectId)!;
    }

    private restorePrevious(projectId: string, pending: PendingH3, discard: boolean) {
        const previous = pending.previousOutput;
        this.patchSegment(projectId, pending.nodeId, pending.segmentId, {
            result: previous.result || "", resultStorageKey: previous.resultStorageKey || "", cacheFingerprint: previous.cacheFingerprint || "",
            firstPassReady: false, firstPassResult: "", firstPassStorageKey: "", firstPassFingerprint: "", runtimeTaskId: "", parentTaskId: "", status: discard ? "cancelled" : "awaiting_confirmation",
        });
    }

    /**
     * 修复已落库的终态父任务：任务事件是权威结果，节点 metadata 只是投影。
     * 后端在写回窗口内重启，或旧版本静默吞掉回写失败时，节点可能长期停在 loading；
     * 启动时重放缺失的 Clip 回写，再按父任务终态收口节点状态。
     */
    async reconcileTerminal(task: RuntimeTask) {
        if (task.kind !== "canvas-h3-run" || !["succeeded", "failed", "cancelled", "awaiting_confirmation"].includes(task.status)) return;
        if (task.status === "awaiting_confirmation") { this.projectAwaiting(task); return; }
        const projectId = String((task.input as H3RunInput)?.projectId || "");
        if (!projectId) return;
        const abandoned = task.status === "cancelled" && this.stores.tasks.events(task.id).some((event) => event.type === "h3_decision" && event.payload.action === "discard") ? confirmationOf(task).pending[0] : null;
        if (abandoned) this.restorePrevious(projectId, abandoned, true);
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
        const current = this.stores.tasks.get(id);
        if (!current || !["queued", "running"].includes(current.status)) throw new Error(`任务状态 ${current?.status || "missing"} 不可取消`);
        const task = this.stores.tasks.cancel(id);
        this.cancelled.add(id);
        const childId = this.currentChildren.get(id);
        if (childId) {
            this.cancelChild(childId);
            const child = this.stores.tasks.get(childId);
            if (child) void writeBackH3Task(this.stores, this.events, child);
        }
        this.finishParentNode(task, "cancelled", "任务已取消");
        this.publish(task, "task.updated");
        return task;
    }

    private async execute(initial: RuntimeTask) {
        if (this.executing.has(initial.id)) return;
        this.executing.add(initial.id);
        try {
            const input = normalizeInput(initial.input as H3RunInput);
            let task = this.stores.tasks.get(initial.id)!;
            if (!task || !["queued", "running"].includes(task.status)) return;
            if (task.status === "queued") task = this.update(task.id, { status: "running" });
            const plans = this.plansForTask(task);
            if (!plans.length) throw new Error("没有符合条件的 H3 Clip");
            const effectiveFingerprints = new Map<string, string>();
            const completedByKey = new Map(this.stores.tasks.events(task.id)
                .filter((event) => event.type === "clip_completed" || event.type === "clip_reused")
                .map((event) => [`${event.payload.nodeId}:${event.payload.segmentId}`, event.payload]));
            const completedOutput = () => plans.flatMap((item) => {
                const output = recordOf(completedByKey.get(`${item.nodeId}:${item.segmentId}`)?.output);
                return output.url ? [output] : [];
            });
            const resumeSeed = input.runPlan?.resumeSeed;
            if (resumeSeed) {
                const first = plans[0];
                if (first.nodeId !== resumeSeed.nodeId || first.continuation?.group !== resumeSeed.group
                    || first.continuation.index !== resumeSeed.previousIndex + 1) throw new Error("H3 续跑计划与潜变量种子不匹配");
                const live = this.stores.projects.get(input.projectId);
                const liveNode = (live?.nodes as Array<Record<string, unknown>> | undefined)?.find((node) => String(node.id || "") === first.nodeId);
                const liveSegments = recordOf(liveNode?.metadata).segments as H3Segment[] | undefined;
                const predecessor = liveSegments?.[first.segmentIndex - 1];
                if (predecessor?.id !== resumeSeed.sourceSegmentId || predecessor.resultStorageKey !== resumeSeed.sourceStorageKey) {
                    throw new Error("Clip 续跑前上一段活动成片已改变，请重新提交本次任务");
                }
                await this.comfy.prepareH3ContinuationSeed(
                    { workflow: input.projectId, group: resumeSeed.group, run: resumeSeed.sourceParentTaskId },
                    { workflow: input.projectId, group: resumeSeed.group, run: task.id }, resumeSeed.previousIndex,
                );
                this.stores.tasks.addEvent(task.id, "continuation_seed_ready", {
                    sourceTaskId: resumeSeed.sourceParentTaskId, sourceChildTaskId: resumeSeed.sourceChildTaskId, sourceNodeId: resumeSeed.sourceNodeId,
                    sourceSegmentId: resumeSeed.sourceSegmentId, targetSegmentId: first.segmentId,
                });
            }
            for (let planIndex = 0; planIndex < plans.length; planIndex++) {
                this.assertActive(task.id);
                const plan = plans[planIndex];
                const key = `${plan.nodeId}:${plan.segmentId}`;
                const completed = completedByKey.get(key);
                if (completed) {
                    const segment = this.segmentFor(input.projectId, plan);
                    const fingerprint = String(completed.fingerprint || segment.cacheFingerprint || "");
                    if (fingerprint) effectiveFingerprints.set(key, fingerprint);
                    continue;
                }
                let confirmation = confirmationOf(task);
                const pending = confirmation.pending.find((item) => item.nodeId === plan.nodeId && item.segmentId === plan.segmentId);
                const inFlight = confirmation.inFlight;
                const secondPass = Boolean(pending && inFlight?.nodeId === plan.nodeId && inFlight?.segmentId === plan.segmentId);
                if (pending && !secondPass) {
                    // keep_first_pass 决议已持久化，节点投影与 completed 事件可安全重放。
                    this.patchSegment(input.projectId, plan.nodeId, plan.segmentId, { result: pending.firstPassResult, resultStorageKey: pending.firstPassStorageKey || "", cacheFingerprint: pending.firstPassFingerprint, firstPassReady: false, status: "success", runtimeTaskId: "", parentTaskId: "" });
                    const output = { url: pending.firstPassResult, storageKey: pending.firstPassStorageKey, mimeType: "video/mp4" };
                    task = this.stores.tasks.transitionH3(task.id, "running", confirmation.revision, { status: "running", progress: Math.min(0.99, (planIndex + 1) / plans.length), result: { ...recordOf(task.result), phase: "remaining", confirmation: { ...confirmation, cursor: planIndex + 1, pending: [], revision: confirmation.revision + 1 }, media: [...completedOutput(), output] } }, { type: "clip_completed", payload: { nodeId: plan.nodeId, segmentId: plan.segmentId, childTaskId: pending.firstPassChildTaskId, output, fingerprint: pending.firstPassFingerprint } })!;
                    if (!task) throw new Error("H3 保留一采决议冲突");
                    completedByKey.set(key, { output, fingerprint: pending.firstPassFingerprint });
                    this.publish(task, "task.updated");
                    continue;
                }
                const override = secondPass ? inFlight!.postpassParams : this.withPlannedSeed(input, plan, this.continuationOverride(input, plan, input.params || {}));
                if (!secondPass && !input.runPlan) this.ensureCanonicalSegmentSubmission(input.projectId, plan, override);
                const cache = this.clipCacheState(input, plan, override, effectiveFingerprints);
                effectiveFingerprints.set(key, cache.fingerprint);
                // Cached MP4 files do not carry the latent context saved under this new run id.
                if (!plan.continuation && !input.forceRegenerate && !secondPass && !confirmation.prepared && !confirmation.pending.length && cache.output) {
                    const output = cache.output;
                    task = this.stores.tasks.transitionH3(task.id, "running", confirmation.revision, { status: "running", progress: Math.min(0.99, (planIndex + 1) / plans.length), result: { ...recordOf(task.result), confirmation: { ...confirmation, cursor: planIndex + 1, revision: confirmation.revision + 1 }, media: [...completedOutput(), output] } }, { type: "clip_reused", payload: { nodeId: plan.nodeId, segmentId: plan.segmentId, output, fingerprint: cache.fingerprint } })!;
                    if (!task) throw new Error("H3 缓存复用冲突");
                    completedByKey.set(key, { output, fingerprint: cache.fingerprint });
                    continue;
                }
                if (!secondPass && h3ConfirmationKind(cache.segment, cache.params) && !confirmation.prepared) {
                    const previousOutput = { result: cache.segment.result, resultStorageKey: cache.segment.resultStorageKey, cacheFingerprint: String(cache.segment.cacheFingerprint || "") };
                    task = this.stores.tasks.transitionH3(task.id, "running", confirmation.revision, { status: "running", result: { ...recordOf(task.result), phase: "first_pass", confirmation: { ...confirmation, cursor: planIndex, prepared: previousOutput, revision: confirmation.revision + 1 } } }, { type: "h3_first_pass_prepared", payload: { nodeId: plan.nodeId, segmentId: plan.segmentId } })!;
                    if (!task) throw new Error("H3 一采快照持久化冲突");
                    confirmation = confirmationOf(task);
                }
                const childId = secondPass ? inFlight!.childTaskId : h3ChildId(task.id, plan.nodeId, plan.segmentId, "first_pass", 1);
                let child = this.stores.tasks.get(childId);
                if (!child) {
                    this.stores.tasks.addEvent(task.id, "child_intent", { nodeId: plan.nodeId, segmentId: plan.segmentId, childTaskId: childId, phase: secondPass ? "second_pass" : "first_pass" });
                    child = await this.startChild(task, plan, override, childId, completedByKey);
                } else if (["queued", "running"].includes(child.status)) {
                    const submitted = this.stores.tasks.events(child.id).some((event) => event.type === "submitted");
                    if (!submitted && !h3CanResumeQueued(this.stores.tasks, child.id)) child = this.stores.tasks.update(child.id, { status: "failed", error: "子任务创建后未记录远端提交，拒绝重复提交" });
                    else if (child.kind === "runninghub:minimax-h3") this.runningHub.resume(child.id);
                    else this.comfy.resume(child.id);
                }
                this.currentChildren.set(task.id, child.id);
                task = this.update(task.id, { result: { ...recordOf(task.result), currentChildTaskId: child.id, currentChildKind: child.kind } });
                // Equal Clip weights; only confirmation workflows split a Clip
                // into two orchestration phases (generation / confirmed postpass).
                // A native automatic two-pass workflow remains one child: its own
                // reported progress already covers both passes.
                const phaseWeight = h3ConfirmationKind(cache.segment, cache.params) ? 0.5 : 1;
                child = await this.waitForTerminal(task.id, child.id,
                    (planIndex + (secondPass ? 0.5 : 0)) / plans.length,
                    phaseWeight / plans.length);
                // Polling persists progress; never overwrite it with the pre-wait
                // snapshot on pause, failure, retry or Clip completion.
                task = this.stores.tasks.get(task.id)!;
                this.currentChildren.delete(task.id);
                await cleanupStoryboardCompositeDirectory(recordOf(child.params).storyboardCompositeTempDir);
                if (secondPass && child.status !== "succeeded") {
                    const restored = this.stores.tasks.transitionH3(task.id, "running", confirmation.revision, { status: "awaiting_confirmation", error: child.error || "二采失败，可以重试或保留一采", result: { ...recordOf(task.result), phase: "awaiting_confirmation", confirmation: { ...confirmation, inFlight: undefined, revision: confirmation.revision + 1 } } }, { type: "h3_second_pass_failed", payload: { nodeId: plan.nodeId, segmentId: plan.segmentId, childTaskId: child.id, error: child.error || "" } });
                    if (!restored) throw new Error("H3 二采失败状态冲突");
                    this.projectAwaiting(restored);
                    this.publish(restored, "task.updated");
                    return;
                }
                const output = resultVideo(child);
                if (recordOf(child.result?.specification).status === 'mismatch') {
                    this.stores.tasks.addEvent(task.id, 'specification_mismatch', { nodeId: plan.nodeId, segmentId: plan.segmentId, childTaskId: child.id, specification: child.result?.specification });
                    this.update(task.id, { result: { ...recordOf(task.result), phase: 'specification_mismatch', failedChildTaskId: child.id, media: [...completedOutput(), ...(output ? [output] : [])], specification: child.result?.specification } });
                    throw new Error(`Clip ${plan.segmentIndex + 1} 媒体规格不符，剩余提交已停止：${child.error || ''}`);
                }
                if (child.status !== "succeeded" || !output) throw new Error(child.error || `Clip ${plan.segmentIndex + 1} 生成失败或缺少视频`);
                const segment = this.segmentFor(input.projectId, plan);
                const alreadyWritten = String(segment.resultStorageKey || "") === String(output.storageKey || "") && segment.status === "success";
                if (!alreadyWritten && !await writeBackH3Task(this.stores, this.events, child)) throw new Error(`Clip ${plan.segmentIndex + 1} 终态回写失败`);
                const media = [...completedOutput(), output];
                if (h3ConfirmationKind(cache.segment, cache.params) && !secondPass) {
                    const snapshot = confirmation.prepared || {};
                    const waiting: PendingH3 = { nodeId: plan.nodeId, segmentId: plan.segmentId, firstPassFingerprint: cache.fingerprint, firstPassResult: String(output.url || ""), firstPassStorageKey: String(output.storageKey || ""), firstPassChildTaskId: child.id, previousOutput: snapshot };
                    task = this.stores.tasks.transitionH3(task.id, "running", confirmation.revision, { status: "awaiting_confirmation", progress: Math.min(0.99, (planIndex + 0.5) / plans.length), result: { ...recordOf(task.result), phase: "awaiting_confirmation", confirmation: { ...confirmation, pending: [waiting], cursor: planIndex, prepared: undefined, revision: confirmation.revision + 1 }, media: completedOutput() } }, { type: "first_pass_ready", payload: { nodeId: plan.nodeId, segmentId: plan.segmentId, childTaskId: child.id, fingerprint: cache.fingerprint, output } })!;
                    if (!task) throw new Error("H3 一采暂停状态冲突");
                    this.projectAwaiting(task);
                    this.publish(task, "task.updated");
                    return;
                }
                this.patchSegment(input.projectId, plan.nodeId, plan.segmentId, { cacheFingerprint: cache.fingerprint, firstPassReady: false, status: "success", runtimeTaskId: "", parentTaskId: "" });
                task = this.stores.tasks.transitionH3(task.id, "running", confirmation.revision, { status: "running", progress: Math.min(0.99, (planIndex + 1) / plans.length), result: { ...recordOf(task.result), phase: "remaining", confirmation: { ...confirmation, pending: [], inFlight: undefined, cursor: planIndex + 1, revision: confirmation.revision + 1 }, media, ...output } }, { type: "clip_completed", payload: { nodeId: plan.nodeId, segmentId: plan.segmentId, childTaskId: child.id, output, fingerprint: cache.fingerprint } })!;
                if (!task) throw new Error("H3 Clip 收口状态冲突");
                completedByKey.set(key, { output, fingerprint: cache.fingerprint });
            }
            const finished = this.stores.tasks.get(initial.id)!;
            if (finished.status !== "running" || confirmationOf(finished).pending.length) return;
            const result = recordOf(finished.result);
            task = this.stores.tasks.transitionH3(finished.id, "running", confirmationOf(finished).revision, { status: "succeeded", progress: 1, result: { ...result, phase: "complete" } }, { type: "h3_completed", payload: { taskId: finished.id } })!;
            if (!task) throw new Error("H3 终态决议冲突");
            this.publish(task, "task.completed");
            this.finishParentNode(task, "success");
            this.cancelled.delete(task.id);
        } finally {
            this.currentChildren.delete(initial.id);
            this.executing.delete(initial.id);
            const latest = this.stores.tasks.get(initial.id);
            if (latest?.status === "running" && ["second_pass", "remaining"].includes(String(latest.result?.phase || "")) && latest.updatedAt !== initial.updatedAt && confirmationOf(latest).pending.length) {
                // 决议与上一轮执行退出竞态：上一轮释放互斥后再次唤醒。
                queueMicrotask(() => void this.execute(latest).catch((error) => this.fail(latest.id, error)));
            }
        }
    }

    private clipCacheState(input: H3RunInput, plan: H3Plan, override: Record<string, unknown>, fingerprints: Map<string, string>) {
        override = this.withPlannedSeed(input, plan, override);
        const projectId = input.projectId;
        const project = this.projectFor(input);
        const node = (project.nodes as Array<Record<string, unknown>>).find((item) => String(item.id || "") === plan.nodeId)!;
        const metadata = recordOf(node.metadata);
        const segments = metadata.segments as H3Segment[];
        const segment = segments.find((item) => String(item.id || "") === plan.segmentId)!;
        const defaults = input.runPlan?.defaults || recordOf(this.stores.settings.get(H3_DEFAULTS_KEY));
        const params = extractParams(segment, override, metadata, defaults);
        const taskMode = normalizeTaskMode(params.mode || params.taskMode || segment.mode || segment.taskMode);
        const { compilation } = compileH3Submission(project, segment, taskMode);
        const scenePrompt = segment.directorEngine ? compilation.compiledPrompt : appendScenePalettePrompt(compilation.compiledPrompt, sceneNodesByIds(project as { nodes?: unknown }, compilation.references.map((reference) => String(reference.sourceNodeId || ""))));
        const previous = plan.segmentIndex > 0 ? segments[plan.segmentIndex - 1] : undefined;
        const previousFingerprint = previous ? fingerprints.get(`${plan.nodeId}:${String(previous.id || "")}`) || String(previous.cacheFingerprint || "") : "";
        const confirming = override.confirmSecondPass === true;
        const firstPassReferences = confirming
            ? firstPassReferencesFromLog(this.stores.logs.list({ projectId, nodeId: plan.nodeId, segmentId: plan.segmentId, limit: 500 }), segment)
            : null;
        const useFirstPassReferences = firstPassReferences
            && stableH3Fingerprint(stableReferenceInputs(firstPassReferences)) === stableH3Fingerprint(stableReferenceInputs(compilation.references));
        const segmentFingerprintInput = { ...segment, previousTailFrameContinuation: previous?.tailFrameContinuation === true };
        const fingerprintInput = { segment: segmentFingerprintInput, params: h3ConfirmationFingerprintParams(segment, params), compiledPrompt: scenePrompt, previousFingerprint };
        const fingerprint = h3ClipCacheFingerprint({ ...fingerprintInput, references: referenceFingerprintInputs(compilation.references) });
        // v1 first-pass caches were fingerprinted from the raw params and complete
        // CompiledReference objects. Keep both exact historical inputs and the
        // log-backed reference snapshot so settings/timestamp normalization updates
        // do not invalidate an otherwise unchanged first pass.
        const legacyFingerprint = confirming ? h3ClipCacheFingerprintV1({ segment: segmentFingerprintInput, params, references: compilation.references, compiledPrompt: scenePrompt, previousFingerprint }) : undefined;
        const loggedLegacyFingerprint = confirming && useFirstPassReferences ? h3ClipCacheFingerprintV1({ segment: segmentFingerprintInput, params, references: firstPassReferences, compiledPrompt: scenePrompt, previousFingerprint }) : undefined;
        const output = !confirming && segment.result && segment.cacheFingerprint === fingerprint ? {
            url: String(segment.result),
            ...(segment.resultStorageKey ? { storageKey: String(segment.resultStorageKey) } : {}),
            mimeType: "video/mp4",
            cacheFingerprint: fingerprint,
        } : null;
        return { fingerprint, legacyFingerprint, loggedLegacyFingerprint, output, segment, params };
    }

    /** The switch and its context controls live on the source clip; the next clip consumes them. */
    private continuationOverride(input: H3RunInput, plan: H3Plan, override: Record<string, unknown>): Record<string, unknown> {
        if (!plan.continuation || plan.continuation.index === 1) return override;
        const resumeSeed = input.runPlan?.resumeSeed;
        if (resumeSeed && plan.nodeId === resumeSeed.nodeId && plan.continuation.group === resumeSeed.group
            && plan.continuation.index === resumeSeed.previousIndex + 1) return { ...override, ...resumeSeed.contextParams };
        const project = this.projectFor(input);
        const node = (project.nodes as Array<Record<string, unknown>>).find((item) => String(item.id || "") === plan.nodeId);
        const metadata = recordOf(node?.metadata);
        const segments = Array.isArray(metadata.segments) ? metadata.segments as H3Segment[] : [];
        const source = segments[plan.segmentIndex - 1];
        if (!source || source.motionContextEnabled !== true) throw new Error(`Clip ${plan.segmentIndex + 1} 缺少上一段的潜空间续写开关`);
        const defaults = input.runPlan?.defaults || recordOf(this.stores.settings.get(H3_DEFAULTS_KEY));
        const sourceParams = extractParams(source, override, metadata, defaults);
        return { ...override, ...Object.fromEntries(H3_OUTGOING_CONTEXT_KEYS.filter((key) => sourceParams[key] !== undefined).map((key) => [key, sourceParams[key]])) };
    }

    private withPlannedSeed(input: H3RunInput, plan: H3Plan, override: Record<string, unknown>) {
        if (!input.runPlan) return override;
        // New runs resolve seeds per Clip. Preserve those exact values through
        // shared request overrides, second-pass confirmation and recovery.
        const node = input.runPlan.project.nodes.find((item) => item.id === plan.nodeId);
        const segments = recordOf(node?.metadata).segments as H3Segment[] | undefined;
        const segment = segments?.find((item) => item.id === plan.segmentId);
        if (!segment) throw new Error("H3 运行快照缺少目标 Clip");
        return { ...override, seed: segment.seed, noiseSeed: segment.noiseSeed, noiseSeedMode: segment.noiseSeedMode };
    }

    private patchSegment(projectId: string, nodeId: string, segmentId: string, patch: Record<string, unknown>) {
        const project = this.stores.projects.get(projectId)!;
        this.stores.projects.applyOperations(projectId, Number(project.revision || 0), [
            { type: "update_h3_segment", nodeId, segmentId, patch },
        ], { runtimeWrite: true, source: { clientId: "task:h3-cache", kind: "task", label: "H3 Clip 缓存" } });
    }

    private planNode(node: Record<string, unknown>, input: H3RunInput) {
        const metadata = recordOf(node.metadata);
        const segments = Array.isArray(metadata.segments) ? metadata.segments as H3Segment[] : [];
        if (!segments.length) return [];
        const selected = input.segmentId
            ? segments.findIndex((segment) => String(segment.id || "") === input.segmentId)
            : input.segmentIndex ?? Math.max(0, segments.findIndex((segment) => !segment.result));
        if (selected < 0) throw new Error("找不到所选 Clip，请刷新画布后重试");
        const end = input.endSegmentId ? segments.findIndex(segment => segment.id === input.endSegmentId) : segments.length - 1;
        if (end < selected) throw new Error("连续组结束 Clip 不存在或早于起点");
        const resumesGroup = selected > 0 && segments[selected - 1].motionContextEnabled === true;
        const indices = input.runFromCurrent ? segments.map((_, index) => index).filter((index) => index >= selected && index <= end) : [selected];
        if (input.runFromCurrent && input.skipCompleted && indices.some((index) => index + 1 < segments.length && segments[index].motionContextEnabled === true)) {
            throw new Error("V15 潜空间续写不能跳过已完成 Clip，请从连续组首段重新运行。");
        }
        let groupHead = -1;
        let continuationIndex = 0;
        if (resumesGroup) {
            groupHead = selected;
            while (groupHead > 0 && segments[groupHead - 1].motionContextEnabled === true) groupHead--;
            continuationIndex = selected - groupHead;
        }
        return indices.filter((index) => segments[index]).filter((index) => !input.skipCompleted || !segments[index].result).map((segmentIndex) => {
            const segment = segments[segmentIndex];
            if (!segment.id) throw new Error(`H3 Clip ${segmentIndex + 1} 缺少身份标识`);
            const incoming = (segmentIndex === selected && resumesGroup) || (input.runFromCurrent === true && segmentIndex > selected && segments[segmentIndex - 1].motionContextEnabled === true);
            const outgoing = input.runFromCurrent === true && segmentIndex < end && segment.motionContextEnabled === true;
            if (!incoming && !outgoing) {
                groupHead = -1;
                continuationIndex = 0;
                return { nodeId: String(node.id || ""), segmentId: String(segment.id), segmentIndex };
            }
            if (!incoming) {
                groupHead = segmentIndex;
                continuationIndex = 0;
            }
            if (groupHead < 0) throw new Error("潜空间续写缺少连续组首段，请从组首重新运行");
            const head = segments[groupHead];
            const group = `${String(head.continuationGroupId || "h3-chain")}:${String(head.id)}`;
            return { nodeId: String(node.id || ""), segmentId: String(segment.id), segmentIndex, continuation: { group, index: ++continuationIndex } };
        });
    }

    /**
     * Persist the values that the UI actually means before fingerprinting or
     * submitting a clip. This migrates legacy seed/LoRA aliases in-place so
     * the canvas, task snapshot and Comfy prompt cannot disagree.
     */
    private ensureCanonicalSegmentSubmission(projectId: string, plan: H3Plan, override: Record<string, unknown>) {
        const project = this.stores.projects.get(projectId);
        if (!project) return;
        const patch = this.canonicalSegmentPatch(project, plan, override);
        if (Object.keys(patch).length) this.patchSegment(projectId, plan.nodeId, plan.segmentId, patch);
    }

    private canonicalSegmentPatch(project: Record<string, unknown>, plan: H3Plan, override: Record<string, unknown>, newRun = false) {
        const node = project && (project.nodes as Array<Record<string, unknown>>).find((item) => String(item.id || "") === plan.nodeId);
        const metadata = node ? recordOf(node.metadata) : {};
        const segments = Array.isArray(metadata.segments) ? metadata.segments as H3Segment[] : [];
        const segment = segments.find((item) => String(item.id || "") === plan.segmentId);
        if (!segment) return {};
        const defaults = recordOf(this.stores.settings.get(H3_DEFAULTS_KEY));
        const normalized = normalizeH3Params(extractParams(segment, override, metadata, defaults), true);
        if (newRun && normalized.noiseSeedMode === "random") {
            normalized.seed = randomH3Seed();
            normalized.noiseSeed = normalized.seed;
        }
        const patch: Record<string, unknown> = {};
        for (const key of ["mode", "taskMode", "noiseSeedMode", "seed", "noiseSeed", "loraSlots"] as const) {
            if (JSON.stringify(segment[key]) !== JSON.stringify(normalized[key])) patch[key] = normalized[key];
        }
        return patch;
    }

    private async startChild(parent: RuntimeTask, plan: H3Plan, override: Record<string, unknown>, childId: string, completedByKey: Map<string, Record<string, unknown>>) {
        let compositeTempDir: string | undefined;
        try {
        const input = parent.input as H3RunInput;
        const project = this.projectFor(input);
        const node = (project.nodes as Array<Record<string, unknown>>).find((item) => String(item.id || "") === plan.nodeId)!;
        const metadata = recordOf(node.metadata);
        const segments = metadata.segments as H3Segment[];
        const segment = segments.find((item) => String(item.id || "") === plan.segmentId)!;
        const defaults = input.runPlan?.defaults || recordOf(this.stores.settings.get(H3_DEFAULTS_KEY));
        let params = extractParams(segment, override, metadata, defaults);
        const confirmingSecondPass = override.confirmSecondPass === true;
        let cachedFirstPassPath = "";
        if (confirmingSecondPass) {
            const pending = confirmationOf(parent).pending.find((item) => item.nodeId === plan.nodeId && item.segmentId === plan.segmentId);
            if (!h3ConfirmationKind(segment, params) || !pending?.firstPassResult) throw new Error("当前 Clip 没有匹配生成模式的待确认一采缓存");
            cachedFirstPassPath = await this.resolveRef({ url: pending.firstPassResult, storageKey: pending.firstPassStorageKey, name: `first-pass-${plan.segmentId}.mp4`, type: "video" });
        }
        params = h3ConfirmationPhaseParams(segment, params, confirmingSecondPass);
        if (params.latentConfirmationPhase) {
            params.latentCheckpointId = createHash("sha256").update(JSON.stringify([parent.id, plan.nodeId, plan.segmentId])).digest("hex");
        }
        const taskMode = normalizeTaskMode(params.mode || params.taskMode || segment.mode || segment.taskMode);
        const { compilation, composite, editableReferences } = compileH3Submission(project, segment, taskMode);
        assertReferenceCompilation(compilation);
        const scenePrompt = segment.directorEngine ? compilation.compiledPrompt : appendScenePalettePrompt(compilation.compiledPrompt, sceneNodesByIds(project as { nodes?: unknown }, compilation.references.map((reference) => String(reference.sourceNodeId || ""))));
        const styleTemplateId = segment.styleTemplateId === undefined ? styleTemplateFromPrompt(scenePrompt, taskMode) : segment.styleTemplateId;
        if (styleTemplateId && !isH3StyleTemplateId(styleTemplateId)) throw new Error(`无效的 H3 视觉风格模板：${styleTemplateId}`);
        params.styleTemplateId = styleTemplateId || null;
        // 实时预览节点靠 target_node_id 把帧推回画布上的 H3 节点；不传就是空串，
        // 帧无处可去，预览功能等于没开。节点 id 在这里才确定，必须在提交前注入。
        params.targetNodeId = plan.nodeId;
        const refs = compilation.references.map((reference) => ({ ...reference, type: reference.mediaType, name: reference.label } as H3Ref));
        // The segment switch controls its outgoing edge. A group head saves latent at index 1;
        // only index > 1 consumes the previous clip's latent. Standalone runs have no cross-task context.
        params.motionContextEnabled = Boolean(plan.continuation);
        if (plan.continuation?.index === 1) params.continuationAudioRefineEnabled = false;
        if (plan.continuation) {
            params.motionContextEnabled = true;
            params.continuationTask = buildH3ContinuationTask(String(parent.input.projectId), plan.continuation.group, parent.id, plan.continuation.index);
        }
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
        let compositeImagePath = "";
        if (composite) {
            const originalCompilation = compileReferenceSubmission(project, { ...segment, taskMode });
            const sourcePaths = await Promise.all(composite.panels.map(async (panel) => {
                const reference = originalCompilation.references.find((item) => item.id === panel.bindingId);
                if (!reference) throw new Error(`合成分镜图缺少绑定图片: ${panel.bindingId}`);
                return this.resolveRef({ ...reference, type: reference.mediaType, name: reference.label } as H3Ref);
            }));
            const created = await createStoryboardComposite(composite, sourcePaths);
            compositeTempDir = created.directory;
            compositeImagePath = created.filePath;
        }
        const compositeMedia = compositeImagePath
            ? this.stores.media.store(await readFile(compositeImagePath), { name: "storyboard-composite.png", mimeType: "image/png", category: "input" })
            : null;
        const isCompositeRef = (ref: H3Ref) => composite && String(ref.id || ref.bindingId || "") === composite.representativeBindingId;
        const images = await Promise.all(imageRefs.map((ref) => isCompositeRef(ref) && compositeMedia
            ? compositeMedia.filePath
            : this.resolveRef(ref)));
        const audios = await Promise.all(audioRefs.map((ref) => this.resolveRef(ref)));
        const videos = await Promise.all(videoRefs.map((ref) => this.resolveRef(ref)));
        const previousSnapshot = plan.segmentIndex > 0 ? segments[plan.segmentIndex - 1] : undefined;
        const previousOutput = previousSnapshot && recordOf(completedByKey.get(`${plan.nodeId}:${String(previousSnapshot.id || "")}`)?.output);
        const previous = previousSnapshot && previousOutput?.url
            ? { ...previousSnapshot, result: String(previousOutput.url), resultStorageKey: String(previousOutput.storageKey || "") }
            : previousSnapshot;
        // Previous output is read only for tail extraction or post-processing; AV latent carries Motion Context.
        const chained = parent.input.runFromCurrent === true && plan.segmentIndex > 0;
        const { usePreviousAsReference, useTailFrame, needsPreviousVideo } = resolveClipContinuation(segment, previous, chained, params);
        const seamNeedsPrevious = params.faceRefineEnabled === true && (Number(params.seamFaceFadeFrames || 0) > 0 || Number(params.seamColourMatch || 0) > 0 || Number(params.seamAudioCrossfadeMs || 0) > 0);
        if (useTailFrame && !previous?.result) throw new Error(`Clip ${plan.segmentIndex} 已开启尾帧参考，但上一段没有可用成品视频`);
        const previousPath = (needsPreviousVideo || seamNeedsPrevious) && previous?.result
            ? await this.resolveRef({ url: previous.result, storageKey: previous.resultStorageKey, name: `clip-${plan.segmentIndex}.mp4`, type: "video" })
            : "";
        let prompt = scenePrompt;
        const submittedImageReferences = imageRefs.map((ref) => isCompositeRef(ref) && compositeMedia
            ? { ...ref, url: this.stores.media.url(compositeMedia), storageKey: compositeMedia.storageKey }
            : ref);
        let actualReferences: Array<Record<string, unknown>> = [
            ...submittedImageReferences,
            ...videoRefs,
            ...audioRefs,
        ];
        let runtimeTaskMode = taskMode;
        if (previousPath && useTailFrame) {
            const tail = await this.captureTailFrame(previousPath, `h3-tail-${parent.id}-${plan.segmentIndex}.png`);
            const routed = routeTailFrameInput(taskMode, images, actualReferences, {
                id: `runtime-tail-${plan.segmentId}`, name: `Clip ${plan.segmentIndex} 尾帧参考`, type: "image", role: "motion_reference", usage: "continuity_reference",
                runtime: true, sourceSegmentId: previous?.id, resolved: tail.filePath, url: this.stores.media.url(tail), storageKey: tail.storageKey,
            });
            images.splice(0, images.length, ...routed.images);
            actualReferences = routed.actualReferences;
            runtimeTaskMode = routed.taskMode;
            prompt = appendTailFramePrompt(prompt, `Clip ${plan.segmentIndex}`, routed.tailImageOrdinal);
        }
        prompt = applyH3StyleTemplate(prompt, taskMode, styleTemplateId as string | null);
        // Only explicitly bound video references enter model conditioning.
        const referenceVideos = [...videos];
        const useSelectedVideoModel = params.selectedVideoModelEnabled === true;
        const selectedVideoModel = String(params.selectedVideoModel || "").trim();
        if (useSelectedVideoModel) {
            if (!selectedVideoModel) throw new Error("已启用自选视频模型，请先在参数设置标题旁选择一个模型");
            if (!this.videoDispatcher) throw new Error("自选视频模型执行器未初始化");
            if (h3LocalOnlyReason(params)) throw new Error("当前 H3 专用的潜空间连续或分阶段确认功能不能与自选视频模型一起使用");
        }
        const requestedEngine = h3ExecutionMode(params.minimaxEngine || params.engine || metadata.minimaxEngine);
        Object.assign(params, {
            taskMode: runtimeTaskMode,
            mode: runtimeTaskMode,
            // V15 Motion Context 由 motionContextEnabled + continuationTask 驱动；
            // 不再通过旧字段携带前段成片作为参考。
            motionContext: false,
            motionContextNoise: false,
            runninghubMode: metadata.minimaxRunningHubMode,
            runninghubWorkflowId: metadata.minimaxRunningHubWorkflowId,
            runninghubAppId: metadata.minimaxRunningHubAppId,
            runninghubFields: metadata.minimaxRunningHubFields,
            runninghubParams: metadata.minimaxRunningHubParams,
            runninghubWorkflowJson: metadata.minimaxRunningHubWorkflowJson,
            useWallet: metadata.minimaxRunningHubUseWallet,
        });
        const localOnlyReason = h3LocalOnlyReason(params);
        const runningHubReady = !useSelectedVideoModel && this.runningHub.ready(params);
        const localReady = useSelectedVideoModel || requestedEngine !== "auto" || localOnlyReason || !runningHubReady
            ? true
            : (await this.comfy.status()).connected;
        const engine = useSelectedVideoModel ? "selected-video-model" : requestedEngine === "local" ? "local" : this.runningHub.queue.select(requestedEngine, runningHubReady, localOnlyReason, childId, localReady);
        params.requestedEngine = requestedEngine;
        params.resolvedEngine = engine;
        if (localOnlyReason && requestedEngine === "auto") params.routingReason = localOnlyReason;
        const submission = {
            authoredPrompt: String(segment.prompt || ""),
            editableReferences,
            semanticPrompt: compilation.semanticPrompt,
            compiledPrompt: prompt,
            bindingMap: compilation.references.map((reference) => ({ id: reference.id, assetId: reference.assetId, label: reference.label, role: reference.role, mediaType: reference.mediaType, ordinal: reference.ordinal, token: reference.token, usage: reference.usage })),
            actualReferences,
            ...(composite ? { storyboardComposite: { rows: composite.rows, columns: composite.columns, sourceBindingIds: composite.sourceBindingIds, panels: composite.panels } } : {}),
            sourceHash: String(segment.directorSourceHash || ""), authoredPromptHash: stableH3Fingerprint(segment.prompt || ""), compiledPromptHash: stableH3Fingerprint(prompt),
            warnings: compilation.issues.filter((issue) => issue.severity === "warning"),
            continuation: { tailFrame: useTailFrame, previousVideo: usePreviousAsReference, motionContext: Boolean(plan.continuation), requestedMode: taskMode, runtimeMode: runtimeTaskMode },
        };
        const log = this.stores.logs.create({
            projectId: String(parent.input.projectId), nodeId: plan.nodeId, segmentId: plan.segmentId,
            status: "queued", platform: engine || "comfyui", workflow: useSelectedVideoModel ? selectedVideoModel : "MiniMax H3", model: useSelectedVideoModel ? selectedVideoModel : String(params.modelName || ""), taskMode: String(params.taskMode || segment.taskMode || "r2v"),
            prompt, references: actualReferences, inputCounts: { image: images.length, video: referenceVideos.length, audio: audios.length }, startedAt: new Date().toISOString(), durationMs: 0, outputs: [], params: { ...params, submission },
        });
        this.events.publish({ type: "generation-log.created", entityId: log.id, payload: log });
        const childParams = { ...params, h3ExecutionContract: { version: 1, expectedRuntime: { ...params }, production: input.runPlan?.requirements || null }, ...(compositeTempDir ? { storyboardCompositeTempDir: compositeTempDir } : {}), parentTaskId: parent.id, canvasBinding: { projectId: parent.input.projectId, nodeId: plan.nodeId, segmentId: plan.segmentId, generationLogId: log.id, bindOnStart: false } };
        const childInput = confirmingSecondPass && !params.latentConfirmationPhase ? {
            prompt,
            video: cachedFirstPassPath,
            ...(images.length ? { references: images } : {}),
        } : {
            prompt, references: images, audios,
            // video（单数）保留给 RunningHub / 旧分拆图读取；videos（复数）给南风 V10 原生构造器，
            // 后者优先读数组——这样第 2/3 段参考视频不会被静默丢弃。
            video: referenceVideos[0],
            ...(referenceVideos.length ? { videos: referenceVideos } : {}),
            ...(previousPath && (usePreviousAsReference || seamNeedsPrevious) ? { previousVideo: previousPath } : {}),
        };
        const bind = (created: RuntimeTask) => this.bindChild(parent.id, plan, created.id, log.id);
        let child: RuntimeTask;
        try {
            if (useSelectedVideoModel) {
                const started = this.videoDispatcher!.start({
                    model: selectedVideoModel,
                    prompt,
                    references: actualReferences.filter((reference) => String(reference.mediaType || reference.type || "image").startsWith("image")).map(videoModelReference),
                    videoReferences: actualReferences.filter((reference) => String(reference.mediaType || reference.type || "").startsWith("video")).map(videoModelReference),
                    audioReferences: actualReferences.filter((reference) => String(reference.mediaType || reference.type || "").startsWith("audio")).map(videoModelReference),
                    workflowReferenceCount: actualReferences.length,
                    seconds: String(params.duration || segment.duration || 5),
                    params: { ...selectedVideoModelParams(params), parentTaskId: parent.id, canvasBinding: { projectId: parent.input.projectId, nodeId: plan.nodeId, segmentId: plan.segmentId, generationLogId: log.id } },
                    clientTaskId: childId,
                }, bind);
                const created = this.stores.tasks.get(started.taskId);
                if (!created) throw new Error("自选视频模型执行器创建任务后未返回任务记录");
                child = created;
            } else {
                child = engine === "runninghub"
                    ? await this.runningHub.run(childInput, childParams, childId, bind)
                    : await this.comfy.run("minimax-h3", childInput, childParams, undefined, childId, bind);
            }
        } finally { this.runningHub.queue?.unreserve(childId); }
        if (compositeTempDir) {
            void this.cleanupStoryboardCompositeWhenTerminal(child.id, compositeTempDir);
            compositeTempDir = undefined;
        }
        this.stores.tasks.addEvent(parent.id, "child_started", { nodeId: plan.nodeId, segmentId: plan.segmentId, segmentIndex: plan.segmentIndex, childTaskId: child.id, generationLogId: log.id });
        return child;
        } finally {
            if (compositeTempDir) await cleanupStoryboardCompositeDirectory(compositeTempDir);
        }
    }

    private async cleanupStoryboardCompositeWhenTerminal(taskId: string, directory: string) {
        while (true) {
            const task = this.stores.tasks.get(taskId);
            if (!task || ["succeeded", "failed", "cancelled"].includes(task.status)) {
                await cleanupStoryboardCompositeDirectory(directory);
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
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
        this.stores.projects.applyOperations(projectId, Number(project.revision || 0), [
            { type: "update_node", id: plan.nodeId, metadata: { runtimeTaskId: parentId, status: "loading" } },
            { type: "update_h3_segment", nodeId: plan.nodeId, segmentId: plan.segmentId, patch: { parentTaskId: parentId, runtimeTaskId: childId, status: "loading", progress: 0 }, patchDelete: ["errorDetails"] },
        ], { runtimeWrite: true, source: { clientId: `task:${childId}`, kind: "task", label: "H3 任务" } });
        const log = this.stores.logs.update(generationLogId, { status: "running", runtimeTaskId: childId });
        this.events.publish({ type: "generation-log.updated", entityId: log.id, payload: log });
    }

    private segmentFor(projectId: string, plan: H3Plan): H3Segment {
        const project = this.stores.projects.get(projectId);
        const node = project && (project.nodes as Array<Record<string, unknown>>).find((item) => String(item.id || "") === plan.nodeId);
        const segment = Array.isArray(recordOf(node?.metadata).segments)
            ? (recordOf(node?.metadata).segments as H3Segment[]).find((item) => item.id === plan.segmentId) : undefined;
        if (!segment) throw new Error(`Clip ${plan.segmentIndex + 1} 已不存在，请刷新画布后重试`);
        return segment;
    }

    private projectAwaiting(task: RuntimeTask) {
        const input = normalizeInput(task.input as H3RunInput);
        const pending = confirmationOf(task).pending[0];
        if (!pending) return;
        const node = (this.stores.projects.get(input.projectId)?.nodes as Array<Record<string, unknown>> | undefined)?.find((item) => item.id === pending.nodeId);
        const segment = this.segmentFor(input.projectId, { ...pending, segmentIndex: 0 });
        if (segment.parentTaskId && segment.parentTaskId !== task.id) return;
        const boundTaskId = String(segment.runtimeTaskId || "");
        const boundTask = boundTaskId ? this.stores.tasks.get(boundTaskId) : null;
        const binding = recordOf(boundTask?.params?.canvasBinding);
        const ownedChild = String(boundTask?.params?.parentTaskId || "") === task.id
            && String(binding.projectId || "") === input.projectId
            && String(binding.nodeId || "") === pending.nodeId
            && String(binding.segmentId || "") === pending.segmentId;
        if (boundTaskId && ![task.id, pending.firstPassChildTaskId, confirmationOf(task).inFlight?.childTaskId].includes(boundTaskId) && !ownedChild) return;
        this.patchSegment(input.projectId, pending.nodeId, pending.segmentId, {
            status: "awaiting_confirmation", parentTaskId: task.id, runtimeTaskId: task.id, firstPassReady: true,
            firstPassResult: pending.firstPassResult, firstPassStorageKey: pending.firstPassStorageKey || "", firstPassFingerprint: pending.firstPassFingerprint,
            result: pending.firstPassResult, resultStorageKey: pending.firstPassStorageKey || "",
        });
        // 顶层由 Clip 状态聚合，不能作为单段确认归属；另一任务占据顶层时，
        // 只恢复本段投影，不额外写入该任务的进度与错误。
        const nodeTaskId = String(recordOf(node?.metadata).runtimeTaskId || "");
        if (!nodeTaskId || nodeTaskId === task.id) this.updateNode(input.projectId, pending.nodeId, { runtimeTaskId: task.id, status: "awaiting_confirmation", runProgress: Math.min(0.99, task.progress), errorDetails: task.error || "" });
    }

    private finishParentNode(task: RuntimeTask, status: string, error = "") {
        const input = normalizeInput(task.input as H3RunInput);
        const project = this.stores.projects.get(input.projectId);
        if (!project) return;
        const ids = new Set(input.nodeIds?.length ? input.nodeIds : input.nodeId ? [input.nodeId] : []);
        for (const node of project.nodes as Array<Record<string, unknown>>) {
            if (ids.size && !ids.has(String(node.id || ""))) continue;
            const metadata = recordOf(node.metadata);
            const segments = Array.isArray(metadata.segments) ? metadata.segments as H3Segment[] : [];
            const owned = status === "error" || status === "cancelled"
                ? segments.filter((segment) => segment.id && String(segment.parentTaskId || "") === task.id && ["queued", "loading"].includes(String(segment.status || "")))
                : [];
            const otherActive = segments.find((segment) => String(segment.parentTaskId || "") !== task.id
                && ["queued", "loading", "awaiting_confirmation"].includes(String(segment.status || ""))
                && (segment.parentTaskId || segment.status === "awaiting_confirmation" && segment.runtimeTaskId));
            const operations: CanvasOperation[] = owned.map((segment) => ({
                type: "update_h3_segment", nodeId: String(node.id), segmentId: String(segment.id),
                patch: { status, progress: task.progress, runtimeTaskId: "", parentTaskId: "", ...(status === "error" ? { errorDetails: error } : {}) },
                ...(status === "cancelled" ? { patchDelete: ["errorDetails"] } : {}),
                expectedFields: { parentTaskId: task.id },
            }));
            if (String(metadata.runtimeTaskId || "") === task.id) operations.push({
                type: "update_node", id: String(node.id), metadata: {
                    runtimeTaskId: String(otherActive?.parentTaskId || (otherActive?.status === "awaiting_confirmation" ? otherActive.runtimeTaskId : "") || ""),
                    runtimeRunId: "", runRequestId: "", runRequestConsumedId: "",
                    status: String(otherActive?.status || status), runProgress: Number(otherActive?.progress ?? task.progress),
                    errorDetails: otherActive ? "" : error, cancelRequested: false,
                },
            });
            if (!operations.length) continue;
            const current = this.stores.projects.get(input.projectId)!;
            this.stores.projects.applyOperations(input.projectId, Number(current.revision || 0), operations, { runtimeWrite: true, source: { clientId: `task:${task.id}`, kind: "task", label: "H3 任务收口" } });
        }
    }

    private updateNode(projectId: string, nodeId: string, metadata: Record<string, unknown>) {
        const project = this.stores.projects.get(projectId)!;
        this.stores.projects.applyOperations(projectId, Number(project.revision || 0), [{ type: "update_node", id: nodeId, metadata }], { runtimeWrite: true, source: { clientId: "task:h3", kind: "task", label: "H3 任务" } });
    }

    private async waitForTerminal(parentId: string, childId: string, base: number, weight: number) {
        while (true) {
            this.assertActive(parentId);
            const child = this.stores.tasks.get(childId);
            if (!child) throw new Error(`H3 子任务不存在: ${childId}`);
            const parent = this.stores.tasks.get(parentId);
            // Read only this execution's selected child, never sum historical
            // children/retry attempts. Failure/cancellation is not completion.
            if (parent?.status === "running" && parent.result?.currentChildTaskId === childId) {
                const raw = Number(child.progress);
                const fraction = child.status === "succeeded" ? 1 : Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
                const progress = Math.max(parent.progress, Math.min(0.99, base + weight * fraction));
                if (progress > parent.progress) this.update(parentId, { progress });
            }
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
        else if (child.kind === "canvas-video") this.videoDispatcher?.cancel(id);
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
        return new Promise<ReturnType<Stores["media"]["store"]>>((resolve, reject) => {
            const chunks: Buffer[] = [];
            const errors: Buffer[] = [];
            const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-sseof", "-0.05", "-i", videoPath, "-frames:v", "1", "-vf", "scale='if(gt(iw,ih),min(768,iw),-2)':'if(gt(iw,ih),-2,min(768,ih))'", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
            child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
            child.once("error", reject);
            child.once("exit", (code) => {
                if (code !== 0 || !chunks.length) return reject(new Error(`截取上一段尾帧失败: ${Buffer.concat(errors).toString("utf8").trim()}`));
                resolve(this.stores.media.store(Buffer.concat(chunks), { name, mimeType: "image/png", category: "input" }));
            });
        });
    }
}

/** Append a soft continuity reference without replacing saved keyframes or renumbering images. */
export function routeTailFrameInput(
    taskMode: string,
    images: readonly string[],
    actualReferences: readonly Record<string, unknown>[],
    tailReference: Record<string, unknown>,
) {
    const tailPath = String(tailReference.resolved || "");
    if (!tailPath) throw new Error("尾帧参考缺少截取后的图片路径");
    const routedImages = [...images, tailPath];
    if (routedImages.length > 9) throw new Error("追加尾帧参考后图片超过 MiniMax H3 的 9 张上限，请减少下一段的其他图片参考");
    const routedTail: Record<string, unknown> = {
        ...tailReference,
        role: "motion_reference", usage: "continuity_reference",
    };
    return {
        images: routedImages,
        actualReferences: [...actualReferences.slice(0, images.length), routedTail, ...actualReferences.slice(images.length)],
        // A reference image is not a forced first/last keyframe. Persisted mode
        // remains unchanged; the effective runtime mode is logged by the caller.
        taskMode: "ref2va",
        tailImageOrdinal: routedImages.length,
    };
}

/** Tail-frame extraction is independent of latent continuation; legacy video flags are inert. */
export function resolveClipContinuation(
    segment: Record<string, unknown>,
    previous: Record<string, unknown> | undefined,
    chained: boolean,
    override: Record<string, unknown>,
) {
    const usePreviousAsReference = false; // Legacy flags are preserved in history but never consumed.
    // 尾帧是上一段到下一段的首状态锚点，单独运行当前 Clip 时仍可生效。
    const useTailFrame = previous?.tailFrameContinuation === true;
    return {
        usePreviousAsReference,
        useTailFrame,
        needsPreviousVideo: (usePreviousAsReference || useTailFrame) && Boolean(previous?.result),
    };
}

/** 把上一段成品追加到参考视频列表尾部；不注入时原样返回。超过 3 段上限直接报错，不静默丢弃。 */
/** Historical helper retained for callers; automatic previous-video input is disabled. */
export function appendPreviousReference(videos: readonly string[], _previousPath: string): string[] {
    return [...videos];
}

/** V15 会用 ComfyUI unique_id 校验 node；原生提交图中的主节点 ID 固定为 nf_v15。 */
export function buildH3ContinuationTask(workflow: string, group: string, run: string, index: number): string {
    return JSON.stringify({ workflow, node: "nf_v15", group, run, index });
}

function h3RunIntentFingerprint(input: H3RunInput): string {
    const { runPlan: _frozen, ...intent } = normalizeInput(input);
    return stableH3Fingerprint(intent);
}

function normalizeInput(input: H3RunInput): H3RunInput {
    const projectId = String(input.projectId || "");
    if (!projectId) throw new Error("projectId 必填");
    if (!input.nodeId && !input.nodeIds?.length) throw new Error("nodeId 或 nodeIds 必填");
    const rawParams = recordOf(input.params);
    // Normalize after merging each Clip's settings. Resolving defaults here
    // would give the whole batch one seed and override unrelated fixed seeds.
    return { projectId, nodeId: input.nodeId ? String(input.nodeId) : undefined, nodeIds: input.nodeIds?.map(String), segmentId: input.segmentId ? String(input.segmentId) : undefined,
        endSegmentId: input.endSegmentId, segmentIndex: input.segmentIndex, runFromCurrent: input.runFromCurrent === true, skipCompleted: input.skipCompleted === true, forceRegenerate: input.forceRegenerate === true,
        ...(input.expectedPlanHash ? { expectedPlanHash: input.expectedPlanHash } : {}), ...(input.runPlan ? { runPlan: input.runPlan } : {}), params: rawParams };
}

function recordOf(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function videoModelReference(reference: Record<string, unknown>) {
    const stringValue = (key: string) => typeof reference[key] === "string" && reference[key] ? String(reference[key]) : undefined;
    return {
        ...(stringValue("id") ? { id: stringValue("id") } : {}),
        name: String(reference.name || reference.label || reference.id || "H3 reference"),
        ...(stringValue("url") ? { url: stringValue("url") } : {}),
        ...(stringValue("storageKey") ? { storageKey: stringValue("storageKey") } : {}),
        ...(stringValue("mimeType") ? { mimeType: stringValue("mimeType") } : {}),
    };
}

function selectedVideoModelParams(params: Record<string, unknown>) {
    const values = { ...params };
    for (const [target, source] of [["model", "modelName"], ["text_encoder", "textEncoder"], ["aspect_ratio", "aspectRatio"], ["video_vae", "videoVae"], ["audio_vae", "audioVae"], ["noise_seed", "seed"]] as const) {
        if (values[target] === undefined && values[source] !== undefined) values[target] = values[source];
    }
    return values;
}

function confirmationOf(task: RuntimeTask): H3Confirmation {
    const value = recordOf(task.result?.confirmation);
    return { cursor: Number(value.cursor || 0), revision: Number(value.revision || 0), pending: Array.isArray(value.pending) ? value.pending as PendingH3[] : [], ...(value.inFlight ? { inFlight: value.inFlight as H3Confirmation["inFlight"] } : {}), ...(value.prepared ? { prepared: value.prepared as H3Confirmation["prepared"] } : {}) };
}

function h3ChildId(parentId: string, nodeId: string, segmentId: string, phase: string, attempt: number): string {
    return `h3-${createHash("sha256").update(JSON.stringify([parentId, nodeId, segmentId, phase, attempt])).digest("hex").slice(0, 32)}`;
}

/**
 * refItems is the canonical order produced by the canvas ref slots.
 * Do not sort by the legacy optional `order` field: older entries may have
 * stale values or no value at all, while the array position is what the UI
 * and prompt's Image N numbering represent.
 */
export function collectH3Refs(segment: H3Segment, project: Record<string, unknown> = {}) {
    return compileReferenceSubmission(project, segment).references.map((reference) => ({ ...reference, type: reference.mediaType, name: reference.label } as H3Ref));
}

function normalizeTaskMode(value: unknown) {
    const mode = String(value || "").toLowerCase();
    if (["t2v", "i2v", "fl2v", "ref2va"].includes(mode)) return mode;
    // Legacy canvas values all mean the native H3 reference-to-video/audio path.
    return "ref2va";
}

function extractParams(segment: H3Segment, override: Record<string, unknown>, metadata: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
    return resolveH3Runtime(segment, override, metadata, defaults).params;
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

function stableReferenceInputs(references: unknown[]) {
    return references.map((value) => Object.fromEntries(Object.entries(recordOf(value)).filter(([key]) => !["createdAt", "updatedAt", "analysis", "type", "name", "resolved"].includes(key))));
}

function referenceFingerprintInputs(references: unknown[]) {
    return references.map((value) => Object.fromEntries(Object.entries(recordOf(value)).filter(([key]) => !["createdAt", "updatedAt", "analysis"].includes(key))));
}

function firstPassReferencesFromLog(logs: ReturnType<Stores["logs"]["list"]>, segment: H3Segment) {
    const storageKey = String(segment.firstPassStorageKey || mediaStorageKey(String(segment.firstPassResult || "")));
    if (!storageKey) return null;
    const log = logs.find((item) => item.outputs.some((output) => String(output.storageKey || "") === storageKey));
    if (!log) return null;
    const submission = recordOf(recordOf(log.params).submission);
    const bindingMap = Array.isArray(submission.bindingMap) ? submission.bindingMap as Array<Record<string, unknown>> : [];
    const actualReferences = Array.isArray(submission.actualReferences) ? submission.actualReferences as Array<Record<string, unknown>> : [];
    if (!bindingMap.length || !actualReferences.length) return null;
    const byId = new Map(actualReferences.map((reference) => [String(reference.id || ""), reference]));
    const references = bindingMap.map((binding) => {
        const reference = byId.get(String(binding.id || ""));
        if (!reference) return null;
        const compiledReference = { ...reference };
        for (const key of ["type", "name", "resolved", "runtime", "sourceSegmentId"]) delete compiledReference[key];
        return compiledReference;
    });
    return references.every(Boolean) ? references as Array<Record<string, unknown>> : null;
}

export function appendTailFramePrompt(prompt: string, fromClip: string, tailImageOrdinal = 1) {
    if (!Number.isInteger(tailImageOrdinal) || tailImageOrdinal < 1 || tailImageOrdinal > 9) throw new Error("无效的尾帧参考图片编号");
    const picture = `<Picture ${tailImageOrdinal}>`;
    const definition = `${picture} is the ending frame from ${fromClip} and defines the required opening state of this segment.`;
    const retention = `${picture}: partially_preserved - the first frame must inherit the character pose, movement direction, scene layout, lighting and ongoing action state, including who holds each prop and the stage of any ongoing interaction. The next shot may change camera position or framing while preserving this physical state.`;
    const cue = `Start this segment from the physical state shown in ${picture} from ${fromClip}, then continue the planned action. If the current storyboard shows a conflicting opening pose, prop ownership or action phase, the tail frame takes priority for the first-frame state; adapt the planned camera and composition to that state. Do not reset or repeat an action already completed in the preceding segment.`;
    const withDefinition = appendToSection(prompt, "subject_definitions", definition);
    const withRetention = appendToSection(withDefinition, "retention_analysis", retention);
    return appendToSection(withRetention, "detailed_description", cue);
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
