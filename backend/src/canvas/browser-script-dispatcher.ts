import crypto from "node:crypto";

import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import { modelOptionName } from "./model-workflow.js";
import type { RuntimeTask } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { CanvasOperation } from "./project-ops.js";
import type { Stores } from "../stores/types.js";
import type { CanvasTextGenerationInput } from "./text-dispatcher.js";
import { CanvasTextDispatcher } from "./text-dispatcher.js";
import { prepareCanvasGenerationTarget } from "./generation-target.js";

export const CANVAS_BROWSER_TASK_KIND = "canvas-browser-script";

export type BrowserScriptTaskInput = CanvasGenerationCommand & { script: string };
export type BrowserTaskExecutor = "browser-script" | "browser-provider";

/**
 * User-authored model scripts keep their browser sandbox, while Backend owns the
 * task, claim arbitration and canvas writeback. No script is evaluated here.
 */
export class CanvasBrowserScriptDispatcher {
    private readonly claims = new Map<string, string>();

    constructor(
        private readonly stores: Stores,
        private readonly events: BackendEventBus,
        private readonly text: CanvasTextDispatcher,
    ) {}

    start(command: CanvasGenerationCommand, script = "", executor: BrowserTaskExecutor = script.trim() ? "browser-script" : "browser-provider") {
        let input = this.prepare(command, script, executor);
        const taskId = input.idempotencyKey || input.clientTaskId || `canvas-browser-${crypto.randomUUID()}`;
        const existing = this.stores.tasks.get(taskId);
        if (existing) return { taskId: existing.id, executor };
        const active = this.findActive(input);
        if (active) return { taskId: active.id, executor };
        const prepared = prepareCanvasGenerationTarget(this.stores, input, taskId);
        input = prepared.command as BrowserScriptTaskInput;
        const project = prepared.project || (input.mode === "text" ? this.canvasTarget(input) : null);
        const target = project && input.nodeId ? arrayRecords(project.nodes).find((node) => String(node.id || "") === input.nodeId) : undefined;
        const targetSize = prepared.targetSize || (target ? { width: Number(target.width || 0), height: Number(target.height || 0) } : undefined);
        const task = this.stores.tasks.create(taskId, CANVAS_BROWSER_TASK_KIND, input as unknown as Record<string, unknown>, {
            projectId: input.projectId,
            nodeId: input.nodeId,
            executor,
            model: input.model,
            mode: input.mode,
            ...(targetSize && input.mode === "image" ? { imageTargetSize: targetSize } : {}),
            ...(targetSize && input.mode === "video" ? { videoTargetSize: targetSize } : {}),
        });
        try {
            if (project && input.nodeId) this.bind(project, input, task.id, prepared.createOperations);
        } catch (error) {
            this.update(task.id, { status: "failed", error: messageOf(error) });
            throw error;
        }
        this.publish(task, "task.created");
        return { taskId: task.id, executor };
    }

    claim(id: string, workerId: string) {
        const task = this.requireTask(id);
        if (!workerId.trim()) throw new Error("浏览器执行器缺少 workerId");
        if (!["queued", "running"].includes(task.status)) throw new Error(`任务状态 ${task.status} 不可认领`);
        const owner = this.claims.get(id);
        if (owner && owner !== workerId) throw new Error("任务已由另一个浏览器认领");
        this.claims.set(id, workerId);
        const claimed = task.status === "queued" ? this.update(id, { status: "running", progress: 0.02 }) : task;
        this.stores.tasks.addEvent(id, "browser_claimed", { workerId });
        return claimed;
    }

    complete(id: string, workerId: string, result: Record<string, unknown>) {
        const task = this.requireClaim(id, workerId);
        const input = task.input as BrowserScriptTaskInput;
        let normalized: Record<string, unknown>;
        if (input.mode === "text") {
            const texts = normalizeTexts(result.texts);
            if (!texts.length) throw new Error("浏览器文本执行器没有返回内容");
            const written = this.text.writeBackExternal(task.id, input as CanvasTextGenerationInput, texts);
            if (!written) throw new Error("文本任务已失去节点绑定，放弃迟到结果");
            normalized = { texts: texts.map((content, index) => ({ index, content })) };
        } else {
            const media = normalizeMedia(this.stores, result.media);
            if (!media.length) throw new Error("浏览器媒体执行器没有返回已入库媒体");
            this.writeBackMedia(task, input, media);
            normalized = { media };
        }
        this.claims.delete(id);
        const completed = this.update(id, { status: "succeeded", progress: 1, result: normalized, error: null });
        this.stores.tasks.addEvent(id, "result", normalized);
        return completed;
    }

    fail(id: string, workerId: string, error: string) {
        const task = this.requireClaim(id, workerId);
        this.claims.delete(id);
        const message = error.trim() || "浏览器模型执行失败";
        const failed = this.update(id, { status: "failed", error: message });
        this.markCanvasFailed(failed, message, false);
        this.stores.tasks.addEvent(id, "error", { error: message });
        return failed;
    }

    release(id: string, workerId: string) {
        const task = this.requireClaim(id, workerId);
        this.claims.delete(id);
        if (task.status !== "running") return task;
        const queued = this.update(id, { status: "queued", progress: 0 });
        this.stores.tasks.addEvent(id, "browser_released", { workerId });
        return queued;
    }

    cancel(id: string) {
        const task = this.requireTask(id);
        if (!["queued", "running"].includes(task.status)) throw new Error(`任务状态 ${task.status} 不可取消`);
        this.claims.delete(id);
        const cancelled = this.stores.tasks.cancel(id);
        this.publish(cancelled, "task.updated");
        this.markCanvasFailed(cancelled, "", true);
        return cancelled;
    }

    retry(task: RuntimeTask) {
        if (task.kind !== CANVAS_BROWSER_TASK_KIND) throw new Error(`任务类型 ${task.kind} 不是浏览器模型任务`);
        const input = task.input as BrowserScriptTaskInput;
        const executor = task.executor === "browser-provider" ? "browser-provider" : "browser-script";
        const result = this.start({ ...input, ...(input.loopOutput ? { nodeId: input.sourceNodeId, imageIds: undefined } : {}), idempotencyKey: undefined, clientTaskId: `canvas-browser-retry-${crypto.randomUUID()}` }, input.script, executor);
        const retried = this.stores.tasks.get(result.taskId);
        if (!retried) throw new Error("浏览器模型重试任务创建失败");
        this.stores.tasks.addEvent(retried.id, "retry", { parentTaskId: task.id });
        return retried;
    }

    /** Running claims cannot survive a Backend restart; fail closed instead of charging twice. */
    resume(task: RuntimeTask) {
        if (task.kind !== CANVAS_BROWSER_TASK_KIND || task.status !== "running") return;
        const message = "Backend 重启导致浏览器模型认领失效，请手动重试";
        const failed = this.update(task.id, { status: "failed", error: message });
        this.markCanvasFailed(failed, message, false);
    }

    private prepare(command: CanvasGenerationCommand, script: string, executor: BrowserTaskExecutor): BrowserScriptTaskInput {
        const model = String(command.model || "").trim();
        const prompt = String(command.prompt || "").trim();
        if (!model) throw new Error("浏览器模型任务缺少模型");
        if (!prompt) throw new Error("浏览器模型任务提示词为空");
        if (executor === "browser-script" && !script.trim()) throw new Error(`模型「${modelOptionName(model)}」没有浏览器脚本`);
        return { ...command, model, prompt, script: script.trim() };
    }

    private canvasTarget(input: BrowserScriptTaskInput) {
        if (!input.nodeId) return null;
        if (!input.projectId) throw new Error("画布脚本任务指定 nodeId 时必须提供 projectId");
        const project = this.stores.projects.get(input.projectId);
        const node = project && arrayRecords(project.nodes).find((item) => String(item.id || "") === input.nodeId);
        if (!project || !node) throw new Error("画布脚本生成目标不存在，未启动模型");
        return project;
    }

    private bind(project: NonNullable<ReturnType<Stores["projects"]["get"]>>, input: BrowserScriptTaskInput, taskId: string, createOperations: CanvasOperation[] = []) {
        const operations: CanvasOperation[] = [...createOperations, {
            type: "update_node", id: input.nodeId!,
            metadata: { runtimeTaskId: taskId, status: "loading", runProgress: 0 },
            metadataDelete: ["errorDetails"],
        }];
        if (!input.loopOutput && input.sourceNodeId && input.sourceNodeId !== input.nodeId) {
            const source = arrayRecords(project.nodes).find((node) => String(node.id || "") === input.sourceNodeId);
            if (source?.type === "config") operations.push({
                type: "update_node", id: input.sourceNodeId,
                metadata: { runtimeTaskId: taskId, status: "loading" }, metadataDelete: ["errorDetails"],
            });
        }
        this.stores.projects.applyOperations(input.projectId!, Number(project.revision || 0), operations, {
            operationId: `browser-task-bind:${taskId}`, runtimeWrite: true,
            source: { clientId: `task:${taskId}`, kind: "task", label: input.script ? "浏览器脚本任务" : "浏览器模型任务" },
        });
    }

    private writeBackMedia(task: RuntimeTask, input: BrowserScriptTaskInput, media: Array<Record<string, unknown>>) {
        if (!input.projectId || !input.nodeId) return;
        const binding = { projectId: input.projectId, nodeId: input.nodeId };
        const model = String(input.model || "");
        const prompt = String(input.prompt || "");
        const written = input.mode === "image"
            ? this.stores.projects.writeBackCanvasImageTask({ ...task, status: "succeeded", result: { media } }, {
                ...binding, prompt, model, references: input.references, resultPolicy: input.resultPolicy, imageIds: input.imageIds,
            }, media)
            : input.mode === "video"
                ? this.stores.projects.writeBackCanvasVideoTask({ ...task, status: "succeeded", result: { media } }, { ...binding, prompt, model }, media[0])
                : this.stores.projects.writeBackCanvasAudioTask({ ...task, status: "succeeded", result: { media } }, { ...binding, prompt, model }, media[0]);
        if (!written) throw new Error(`${input.mode} 任务已失去节点绑定，放弃迟到结果`);
    }

    private markCanvasFailed(task: RuntimeTask, error: string, cancelled: boolean) {
        const input = task.input as BrowserScriptTaskInput;
        if (!input.projectId || !input.nodeId) return;
        const binding = { projectId: input.projectId, nodeId: input.nodeId };
        if (input.mode === "image") this.stores.projects.markCanvasImageTaskFailed(task, binding, error);
        else if (input.mode === "video") this.stores.projects.markCanvasVideoTaskFailed(task, binding, error);
        else if (input.mode === "audio") this.stores.projects.markCanvasAudioTaskFailed(task, binding, error);
        else this.text.markExternalFailed(task.id, input as CanvasTextGenerationInput, error, cancelled);
    }

    private findActive(input: BrowserScriptTaskInput) {
        if (!input.projectId || !input.nodeId) return null;
        for (const status of ["running", "queued"] as const) {
            const active = this.stores.tasks.list({ kind: CANVAS_BROWSER_TASK_KIND, status, projectId: input.projectId, limit: 500 })
                .find((task) => {
                    const previous = task.input as BrowserScriptTaskInput;
                    if (input.loopOutput) return previous.loopOutput?.loopNodeId === input.loopOutput.loopNodeId
                        && previous.loopOutput?.roundIndex === input.loopOutput.roundIndex
                        && previous.loopOutput?.slotIndex === input.loopOutput.slotIndex
                        && (previous.sourceNodeId || previous.nodeId) === input.nodeId;
                    return String(previous.nodeId || "") === input.nodeId;
                });
            if (active) return active;
        }
        return null;
    }

    private requireTask(id: string) {
        const task = this.stores.tasks.get(id);
        if (!task || task.kind !== CANVAS_BROWSER_TASK_KIND) throw new Error("浏览器模型任务不存在");
        return task;
    }

    private requireClaim(id: string, workerId: string) {
        const task = this.requireTask(id);
        if (task.status !== "running") throw new Error(`任务状态 ${task.status} 不接受浏览器结果`);
        if (this.claims.get(id) !== workerId) throw new Error("浏览器模型任务认领已失效");
        return task;
    }

    private update(id: string, patch: Parameters<Stores["tasks"]["update"]>[1]) {
        const task = this.stores.tasks.update(id, patch);
        this.publish(task, task.status === "succeeded" ? "task.completed" : task.status === "failed" ? "task.failed" : "task.updated");
        return task;
    }

    private publish(task: RuntimeTask, type: string) {
        this.events.publish({ type, entityId: task.id, payload: task });
    }
}

function normalizeTexts(value: unknown) {
    return (Array.isArray(value) ? value : [value]).map((item) => typeof item === "string" ? item : String(recordOf(item).content || "")).map((item) => item.trim()).filter(Boolean);
}

function normalizeMedia(stores: Stores, value: unknown) {
    const keys = (Array.isArray(value) ? value : []).map((item) => String(recordOf(item).storageKey || item || "")).filter(Boolean);
    return keys.map((storageKey) => {
        const media = stores.media.meta(storageKey);
        if (!media) throw new Error(`浏览器返回的媒体不存在：${storageKey}`);
        return { storageKey, url: stores.media.url(media), mimeType: media.mimeType, bytes: media.bytes, width: media.width, height: media.height, durationMs: media.durationMs };
    });
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}
function recordOf(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
