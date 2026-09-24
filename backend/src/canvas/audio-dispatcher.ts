import crypto from "node:crypto";

import type { CanvasProject, RuntimeTask } from "../db.js";
import type { DirectAudioBackend, DirectAudioInput } from "../runtime/direct-audio.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import type { Stores } from "../stores/types.js";
import { prepareCanvasGenerationTarget } from "./generation-target.js";
import type { CanvasOperation } from "./project-ops.js";

export type CanvasAudioGenerationInput = DirectAudioInput & {
    projectId?: string;
    nodeId?: string;
    sourceNodeId?: string;
    clientTaskId?: string;
    executor?: "direct-audio" | "comfyui";
    referenceAudio?: string;
    params?: Record<string, unknown>;
};

/** Backend 权威的普通音频任务；配置节点触发时自动创建稳定的音频结果节点。 */
export class CanvasAudioDispatcher {
    private readonly children = new Map<string, string>();

    constructor(private readonly stores: Stores, private readonly directAudio?: DirectAudioBackend, private readonly comfy?: ComfyUiBackend) {}

    start(raw: CanvasAudioGenerationInput) {
        let input = normalize(raw);
        const executor = input.executor || "direct-audio";
        if (executor === "comfyui" ? !this.comfy : !this.directAudio) throw new Error(executor === "comfyui" ? "Backend ComfyUI 执行器未初始化" : "Backend 直连音频执行器未初始化");
        const taskId = input.clientTaskId || `canvas-audio-${crypto.randomUUID()}`;
        const existing = this.stores.tasks.get(taskId);
        if (existing) return { taskId: existing.id, executor };
        const active = this.findActive(input);
        if (active) return { taskId: active.id, executor: String(active.executor || "direct-audio") };
        const prepared = prepareCanvasGenerationTarget(this.stores, { ...input, mode: "audio" }, taskId);
        input = prepared.command as CanvasAudioGenerationInput;
        const task = this.stores.tasks.create(taskId, "canvas-audio", input, {
            projectId: input.projectId,
            nodeId: input.nodeId,
            executor,
            model: input.model,
            ...(prepared.targetSize ? { audioTargetSize: prepared.targetSize } : {}),
        });
        if (prepared.project) {
            try {
                this.stores.projects.applyOperations(input.projectId!, Number(prepared.project.revision || 0), [
                    ...prepared.createOperations,
                    { type: "update_node", id: input.nodeId!, metadata: { runtimeTaskId: task.id, status: "loading", runProgress: 0 }, metadataDelete: ["errorDetails"] },
                    ...bindSource(prepared.project, input, task.id),
                ], { operationId: `audio-task-bind:${task.id}`, runtimeWrite: true, source: { clientId: `task:${task.id}`, kind: "task", label: "音频生成任务" } });
            } catch (error) {
                this.stores.tasks.update(task.id, { status: "failed", error: messageOf(error) });
                throw error;
            }
        }
        void this.execute(task, input).catch((error) => this.fail(task, input, error));
        return { taskId: task.id, executor };
    }

    retry(task: RuntimeTask) {
        if (task.kind !== "canvas-audio") throw new Error(`任务类型 ${task.kind} 不是画布音频任务`);
        const result = this.start({ ...(task.input as CanvasAudioGenerationInput), clientTaskId: `canvas-audio-retry-${crypto.randomUUID()}` });
        const retried = this.stores.tasks.get(result.taskId)!;
        this.stores.tasks.addEvent(retried.id, "retry", { parentTaskId: task.id });
        return retried;
    }

    resume(task: RuntimeTask) {
        if (task.kind !== "canvas-audio" || !["queued", "running"].includes(task.status)) return;
        const input = task.input as CanvasAudioGenerationInput;
        try {
            const project = this.target(input);
            const node = project && (project.nodes as Array<Record<string, any>>).find((item) => item.id === input.nodeId);
            if (project && node?.metadata?.runtimeTaskId !== task.id) throw new Error("音频任务已失去节点绑定，不恢复旧任务");
            void this.execute(task, input).catch((error) => this.fail(task, input, error));
        } catch (error) { this.fail(task, input, error); }
    }

    cancel(id: string) {
        const task = this.stores.tasks.get(id);
        if (!task || !["queued", "running"].includes(task.status)) throw new Error(`任务状态 ${task?.status || "unknown"} 不可取消`);
        const child = this.children.get(id);
        if (child) try { task.executor === "comfyui" ? this.comfy?.cancel(child) : this.directAudio?.cancel(child); } catch {}
        const cancelled = this.stores.tasks.cancel(id);
        const input = task.input as CanvasAudioGenerationInput;
        if (input.projectId && input.nodeId) this.stores.projects.markCanvasAudioTaskFailed(cancelled, { projectId: input.projectId, nodeId: input.nodeId }, "");
        return cancelled;
    }

    private async execute(task: RuntimeTask, input: CanvasAudioGenerationInput) {
        this.stores.tasks.update(task.id, { status: "running", progress: 0.05 });
        const childId = `audio-child-${task.id}`;
        this.children.set(task.id, childId);
        try {
            const child = input.executor === "comfyui"
                ? await this.comfy!.run("indextts-2.5", { prompt: input.prompt, referenceAudio: input.referenceAudio }, { ...(input.params || {}), speed: input.speed }, undefined, childId)
                : this.directAudio!.run(input, childId, { parentTaskId: task.id, channelId: input.channelId });
            for (;;) {
                const current = this.stores.tasks.get(child.id);
                if (!current) throw new Error("音频子任务不存在");
                if (current.status === "succeeded") {
                    if (this.stores.tasks.get(task.id)?.status === "cancelled") return;
                    const media = firstMedia(current);
                    if (input.projectId && input.nodeId) {
                        const written = this.stores.projects.writeBackCanvasAudioTask({ ...task, status: "succeeded", result: { media: [media] } }, { projectId: input.projectId, nodeId: input.nodeId, prompt: input.prompt, model: input.model }, media);
                        if (!written) throw new Error("音频任务已失去节点绑定，放弃迟到结果");
                    }
                    if (this.stores.tasks.get(task.id)?.status === "cancelled") return;
                    this.stores.tasks.update(task.id, { status: "succeeded", progress: 1, result: { media: [media] } });
                    this.stores.tasks.addEvent(task.id, "result", { media: [media] });
                    return;
                }
                if (["failed", "cancelled"].includes(current.status)) throw new Error(current.error || `音频任务${current.status}`);
                this.stores.tasks.update(task.id, { progress: Math.min(0.95, Number(current.progress || 0) * 0.9) });
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        } finally { this.children.delete(task.id); }
    }

    private target(input: CanvasAudioGenerationInput) {
        if (!input.nodeId) return null;
        if (!input.projectId) throw new Error("画布音频任务指定 nodeId 时必须提供 projectId");
        const project = this.stores.projects.get(input.projectId);
        const node = project && (project.nodes as Array<Record<string, unknown>>).find((item) => item.id === input.nodeId);
        if (!project || (node?.type !== "audio" && !(node?.type === "config" && (node.metadata as Record<string, unknown> | undefined)?.smart === true))) throw new Error("画布音频生成目标不存在，未恢复模型");
        return project;
    }

    private findActive(input: CanvasAudioGenerationInput) {
        if (!input.projectId) return null;
        const source = input.sourceNodeId || input.nodeId;
        return this.stores.tasks.list({ kind: "canvas-audio", projectId: input.projectId, limit: 500 }).find((task) => ["queued", "running"].includes(task.status) && ((task.input as CanvasAudioGenerationInput).sourceNodeId || task.nodeId) === source) || null;
    }

    private fail(task: RuntimeTask, input: CanvasAudioGenerationInput, error: unknown) {
        const current = this.stores.tasks.get(task.id);
        if (!current || current.status === "cancelled") return;
        const message = messageOf(error);
        const failed = this.stores.tasks.update(task.id, { status: "failed", error: message });
        if (input.projectId && input.nodeId) this.stores.projects.markCanvasAudioTaskFailed(failed, { projectId: input.projectId, nodeId: input.nodeId }, message);
    }
}

function normalize(input: CanvasAudioGenerationInput): CanvasAudioGenerationInput { return { ...input, prompt: String(input.prompt || "").trim() }; }
function bindSource(project: CanvasProject, input: CanvasAudioGenerationInput, taskId: string): CanvasOperation[] {
    if (!input.sourceNodeId || input.sourceNodeId === input.nodeId) return [];
    const source = (project.nodes as Array<Record<string, any>>).find((node) => node.id === input.sourceNodeId);
    return source?.type === "config" ? [{ type: "update_node", id: input.sourceNodeId, metadata: { status: "loading", runtimeTaskId: taskId }, metadataDelete: ["errorDetails"] }] : [];
}
function firstMedia(task: RuntimeTask) { const values = Array.isArray(task.result?.media) ? task.result!.media : []; const media = values[0]; if (!media || typeof media !== "object") throw new Error("音频任务完成但没有返回媒体"); return media as Record<string, unknown>; }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
