import crypto from "node:crypto";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";

import type { CanvasProject, RuntimeTask, WorkflowConfig, WorkflowField } from "../db.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import type { VideoConcatBackend } from "../runtime/video-concat.js";
import type { Stores, TaskStore } from "../stores/types.js";
import type { WorkflowExecutor } from "../workflows/executor.js";
import type { WorkflowStore } from "../workflows/store.js";
import { builtinWorkflowName, decodeChannelModel, findChannelModel, modelOptionName, resolveWorkflowForModel, usesWorkflowExecutor, workflowResolutionMessage } from "./model-workflow.js";
import type { CanvasImageReference } from "./image-dispatcher.js";
import { DirectVideoBackend } from "../runtime/direct-video.js";
import { prepareCanvasGenerationTarget } from "./generation-target.js";

export const CANVAS_VIDEO_CONCAT_MODEL = "__local_video_concat__";

export type CanvasVideoReference = CanvasImageReference;
export type CanvasVideoGenerationInput = {
    projectId?: string;
    nodeId?: string;
    sourceNodeId?: string;
    model: string;
    prompt: string;
    references?: CanvasImageReference[];
    videoReferences?: CanvasVideoReference[];
    size?: string;
    seconds?: string;
    resolution?: string;
    width?: number;
    height?: number;
    params?: Record<string, unknown>;
    input?: Record<string, unknown>;
    preset?: string;
    comfyUrl?: string;
    clientTaskId?: string;
    loopOutput?: CanvasGenerationCommand["loopOutput"];
};

type Plan = { input: CanvasVideoGenerationInput; kind: "concat" | "workflow" | "preset" | "direct"; workflow?: string; preset?: string };

/** Backend 权威的普通视频任务；H3 连续 Clip 仍由专用 runner 管理。 */
export class CanvasVideoDispatcher {
    private readonly children = new Map<string, Set<string>>();
    constructor(private readonly stores: Stores, private readonly comfy: ComfyUiBackend, private readonly workflows: WorkflowStore,
        private readonly workflowExecutor: WorkflowExecutor, private readonly concat: VideoConcatBackend, private readonly directVideo?: DirectVideoBackend) {}

    start(raw: CanvasVideoGenerationInput) {
        let input = this.prepare(raw);
        let plan = this.plan(input);
        const taskId = input.clientTaskId || `canvas-video-${crypto.randomUUID()}`;
        const existing = this.stores.tasks.get(taskId);
        if (existing) return { taskId: existing.id, executor: plan.kind };
        const active = this.findActive(input);
        if (active) return { taskId: active.id, executor: String(active.executor || plan.kind) };
        const prepared = prepareCanvasGenerationTarget(this.stores, { ...input, mode: "video" }, taskId);
        input = prepared.command as CanvasVideoGenerationInput;
        plan = this.plan(input);
        const project = prepared.project;
        const targetNode = project && (project.nodes as Array<Record<string, any>>).find((node) => node.id === input.nodeId);
        const targetSize = targetNode || { width: 340, height: 190 };
        const task = this.stores.tasks.create(taskId, "canvas-video", input, {
            projectId: input.projectId, nodeId: input.nodeId, executor: plan.kind, model: input.model,
            videoTargetSize: project ? { width: targetSize.width, height: targetSize.height } : undefined,
        });
        try {
            if (project) this.stores.projects.applyOperations(input.projectId!, Number(project.revision || 0), [
                ...prepared.createOperations,
                { type: "update_node", id: input.nodeId!, metadata: { runtimeTaskId: task.id, status: "loading", runProgress: 0 }, metadataDelete: ["errorDetails"] },
                ...bindSource(project, input, task.id),
            ], { operationId: `video-task-bind:${task.id}`, runtimeWrite: true, source: { clientId: `task:${task.id}`, kind: "task", label: "视频生成任务" } });
        } catch (error) {
            this.stores.tasks.update(task.id, { status: "failed", error: messageOf(error) });
            throw error;
        }
        void this.execute(plan, task).catch((error) => this.fail(task, input, error));
        return { taskId: task.id, executor: plan.kind };
    }

    retry(task: RuntimeTask) {
        if (task.kind !== "canvas-video") throw new Error(`任务类型 ${task.kind} 不是画布视频任务`);
        const previous = task.input as CanvasVideoGenerationInput;
        const result = this.start({ ...previous, ...(previous.loopOutput ? { nodeId: previous.sourceNodeId } : {}), clientTaskId: `canvas-video-retry-${crypto.randomUUID()}` });
        const retried = this.stores.tasks.get(result.taskId)!;
        this.stores.tasks.addEvent(retried.id, "retry", { parentTaskId: task.id });
        return retried;
    }

    resume(task: RuntimeTask) {
        if (task.kind !== "canvas-video" || !["queued", "running"].includes(task.status)) return;
        const input = task.input as CanvasVideoGenerationInput;
        try {
            const project = this.target(input);
            const node = project && (project.nodes as Array<Record<string, any>>).find((node) => node.id === input.nodeId);
            if (project && node?.metadata?.runtimeTaskId !== task.id) throw new Error("视频任务已失去节点绑定，不恢复旧任务");
            const plan = this.plan(input);
            void this.execute(plan, task).catch((error) => this.fail(task, input, error));
        } catch (error) { this.fail(task, input, error); }
    }

    cancel(id: string) {
        const task = this.stores.tasks.get(id);
        if (!task || !["queued", "running"].includes(task.status)) throw new Error(`任务状态 ${task?.status || "unknown"} 不可取消`);
        for (const child of this.children.get(id) || []) {
            try { this.workflowExecutor.cancel(child); } catch {}
            try { this.comfy.cancel(child); } catch {}
            try { this.concat.cancel(child); } catch {}
            try { this.directVideo?.cancel(child); } catch {}
        }
        const cancelled = this.stores.tasks.cancel(id);
        const input = task.input as CanvasVideoGenerationInput;
        if (input.projectId && input.nodeId) this.stores.projects.markCanvasVideoTaskFailed(cancelled, input as Required<Pick<CanvasVideoGenerationInput, "projectId" | "nodeId">>, "");
        return cancelled;
    }

    private async execute(plan: Plan, task: RuntimeTask) {
        this.stores.tasks.update(task.id, { status: "running", progress: 0.02 });
        const media = await this.dispatch(plan, task.id);
        if (this.stores.tasks.get(task.id)?.status === "cancelled") return;
        if (plan.input.projectId && plan.input.nodeId) {
            const written = this.stores.projects.writeBackCanvasVideoTask({ ...task, status: "succeeded", result: { media: [media] } },
                plan.input as Required<Pick<CanvasVideoGenerationInput, "projectId" | "nodeId" | "prompt" | "model">>, media);
            if (!written) throw new Error("视频任务已失去节点绑定，放弃迟到结果");
        }
        if (this.stores.tasks.get(task.id)?.status === "cancelled") return;
        this.stores.tasks.update(task.id, { status: "succeeded", progress: 1, result: { media: [media] } });
        this.stores.tasks.addEvent(task.id, "result", { media: [media] });
    }

    private async dispatch(plan: Plan, taskId: string): Promise<Record<string, unknown>> {
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
                await this.directVideo.run(plan.input, childId, { parentTaskId: taskId, channelId: decodeChannelModel(plan.input.model)?.channelId, seconds: plan.input.seconds, resolution: plan.input.resolution });
                return firstMedia(await waitForTask(this.stores.tasks, childId));
            } finally { this.untrack(taskId, childId); }
        }
        if (plan.kind === "preset") {
            const childId = `video-comfy-child-${taskId}`;
            this.assertActive(taskId);
            this.track(taskId, childId);
            try {
                const child = await this.comfy.run(plan.preset!, plan.input.input || { prompt: plan.input.prompt },
                    { ...(plan.input.params || {}), parentTaskId: taskId, projectId: plan.input.projectId, nodeId: plan.input.nodeId, model: plan.input.model }, plan.input.comfyUrl, childId);
                return firstMedia(await waitForTask(this.stores.tasks, child.id));
            } finally { this.untrack(taskId, childId); }
        }
        const detail = await this.workflows.get(plan.workflow!);
        const fields = detail.config?.fields || [];
        const values: Record<string, unknown> = { ...(plan.input.params || {}) };
        for (const field of fields) if (field.type === "text" && (field.isPrompt || field.id.toLowerCase() === "prompt")) values[field.id] = plan.input.prompt;
        await this.fillMediaFields(values, fields.filter((field) => isImageField(field, detail.workflow)), plan.input.references || []);
        await this.fillMediaFields(values, fields.filter((field) => isVideoField(field, detail.workflow)), plan.input.videoReferences || []);
        const childId = `video-workflow-child-${taskId}`;
        this.assertActive(taskId);
        this.track(taskId, childId);
        try {
            const existing = this.stores.tasks.get(childId);
            if (existing && ["succeeded", "failed", "cancelled"].includes(existing.status)) return firstMedia(await waitForTask(this.stores.tasks, childId));
            const result = await this.workflowExecutor.run(detail.workflow, detail.config || emptyWorkflowConfig(plan.workflow!), values,
                crypto.randomUUID(), plan.input.comfyUrl, plan.workflow, childId, plan.input.projectId, plan.input.nodeId, taskId);
            const media = result.media.find((item) => String(item.mimeType || "").startsWith("video/")) || result.media[0];
            if (!media) throw new Error("视频工作流完成但没有返回媒体");
            return media;
        } finally { this.untrack(taskId, childId); }
    }

    private plan(input: CanvasVideoGenerationInput): Plan {
        if (input.model === CANVAS_VIDEO_CONCAT_MODEL) return { input, kind: "concat" };
        const config = this.stores.settings.get("ai.config");
        if (usesWorkflowExecutor(config, input.model)) {
            const resolved = resolveWorkflowForModel(config, input.model, (input.references || []).length);
            if (!resolved.ok) throw new Error(`${workflowResolutionMessage(resolved)}（模型=${input.model}）`);
            return { input: { ...input, params: { ...resolved.params, ...(input.params || {}) } }, kind: "workflow", workflow: resolved.workflow };
        }
        const workflow = builtinWorkflowName(input.model);
        if (workflow) return { input, kind: "workflow", workflow };
        if (input.preset) return { input, kind: "preset", preset: input.preset };
        const selected = findChannelModel(this.stores.settings.get("ai.config"), input.model);
        if (this.directVideo && selected && String(selected.channel.kind || "") !== "comfyui" && String((selected.model as Record<string, unknown>).capability || "") === "video") return { input, kind: "direct" };
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
        if (!input.projectId) return null;
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
        return { ...input, prompt: String(input.prompt || ""), references: input.references?.map(keep), videoReferences: input.videoReferences?.map(keep) };
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
        for (let index = 0; index < fields.length; index++) values[fields[index].id] = references[index] ? await this.dataUrl(references[index]) : null;
    }
    private async dataUrl(reference: CanvasVideoReference) { const stored = await this.materialize(reference); return `data:${stored.mimeType};base64,${(await this.stores.media.read(stored.storageKey)).toString("base64")}`; }
    private assertActive(taskId: string) { if (this.stores.tasks.get(taskId)?.status === "cancelled") throw new Error("视频任务已取消，未启动子执行器"); }
    private track(parent: string, child: string) { const set = this.children.get(parent) || new Set<string>(); set.add(child); this.children.set(parent, set); }
    private untrack(parent: string, child: string) { const set = this.children.get(parent); set?.delete(child); if (!set?.size) this.children.delete(parent); }
    private fail(task: RuntimeTask, input: CanvasVideoGenerationInput, error: unknown) {
        const current = this.stores.tasks.get(task.id);
        if (!current || current.status === "cancelled") return;
        const message = messageOf(error);
        const failed = this.stores.tasks.update(task.id, { status: "failed", error: message });
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
function emptyWorkflowConfig(name: string): WorkflowConfig { return { title: name, backend: "", operation: "", description: "", fields: [] }; }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
async function waitForTask(tasks: TaskStore, id: string) { for (;;) { const task = tasks.get(id); if (!task) throw new Error(`生成任务不存在：${id}`); if (task.status === "succeeded") return task; if (["failed", "cancelled"].includes(task.status)) throw new Error(task.error || `生成任务${task.status}`); await new Promise((resolve) => setTimeout(resolve, 500)); } }
function firstMedia(task: RuntimeTask) { const media = task.result?.media; const values = Array.isArray(media) ? media : media && typeof media === "object" ? [media] : []; const output = values.find((item: any) => String(item?.mimeType || "").startsWith("video/")) || values[0]; if (!output || typeof output !== "object") throw new Error("视频任务完成但没有返回媒体"); return output as Record<string, unknown>; }
