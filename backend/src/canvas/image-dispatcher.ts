import crypto from "node:crypto";

import type { ResolvedConfig } from "../config.js";
import type { RuntimeTask, WorkflowConfig, WorkflowField } from "../db.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import { DirectImageBackend, type ChatGptImageReference } from "../runtime/chatgpt-image.js";
import type { GenerationLogStore, Stores, TaskStore } from "../stores/types.js";
import type { WorkflowExecutor } from "../workflows/executor.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { BackendEventBus } from "../events.js";
import { resolveCanvasExecutor } from "./executor-registry.js";

export type CanvasImageReference = {
    id?: string;
    name?: string;
    dataUrl?: string;
    url?: string;
    storageKey?: string;
    mimeType?: string;
};

export type CanvasImageGenerationInput = {
    projectId?: string;
    nodeId?: string;
    segmentId?: string;
    model: string;
    prompt: string;
    references?: CanvasImageReference[];
    size?: string;
    width?: number;
    height?: number;
    quality?: string;
    count?: number;
    params?: Record<string, unknown>;
    provider?: { baseUrl?: string; apiKey?: string };
    clientTaskId?: string;
    /** 渠道模型按输入场景（文生 / 单图 / 多图）解析出的工作流名；缺省时按模型名推断。 */
    workflow?: string;
    writeBackCanvas?: boolean;
    resultPolicy?: "replace-active" | "append";
};

export type CanvasImageGenerationResult = {
    taskId: string;
    media: Array<{
        url: string;
        storageKey?: string;
        mimeType: string;
        filename?: string;
        bytes?: number;
        width?: number | null;
        height?: number | null;
    }>;
};

type DispatcherHooks = {
    onCompleted?: (result: CanvasImageGenerationResult, task: RuntimeTask) => Promise<void> | void;
    onFailed?: (error: Error, task: RuntimeTask) => Promise<void> | void;
};

/**
 * 画布唯一的图片生成入口。
 * 前端按钮和 MCP 都只负责提交这个标准请求，模型差异留在这里处理。
 */
export class CanvasImageDispatcher {
    private readonly childTasks = new Map<string, string>();
    constructor(
        private readonly config: ResolvedConfig,
        private readonly stores: Stores,
        private readonly comfy: ComfyUiBackend,
        private readonly directImage: DirectImageBackend,
        private readonly workflows: WorkflowStore,
        private readonly workflowExecutor: WorkflowExecutor,
        private readonly events?: BackendEventBus,
    ) {}

    private get logs(): GenerationLogStore { return this.stores.logs; }

    start(input: CanvasImageGenerationInput, hooks?: DispatcherHooks) {
        const model = normalizeModel(input.model);
        if (!model) throw new Error("画布图片生成缺少模型");
        if (!input.prompt.trim()) throw new Error("画布图片生成缺少提示词");

        const taskId = input.clientTaskId || `canvas-${crypto.randomUUID()}`;
        const existing = this.stores.tasks.get(taskId);
        if (existing) return { taskId: existing.id, logId: undefined };
        const persistedReferences = input.references?.map((reference) => ({
            id: reference.id, name: reference.name, dataUrl: reference.dataUrl, storageKey: reference.storageKey,
            url: reference.url, mimeType: reference.mimeType,
        })) || [];
        const task = this.stores.tasks.create(taskId, "canvas-image", {
            ...input, model, clientTaskId: undefined, provider: undefined, references: persistedReferences,
        }, {
            projectId: input.projectId,
            nodeId: input.nodeId,
            model,
            size: input.size || `${input.width || 1024}x${input.height || 1024}`,
            quality: input.quality || "auto",
            count: Math.max(1, Math.min(4, Math.floor(input.count || 1))),
            resultPolicy: input.resultPolicy || "replace-active",
        });
        // 画布生成日志：开始（running）+ 成功/失败。仅当调用方传入 projectId 时才记录。
        const logId = input.projectId
            ? this.logs.create({
                projectId: input.projectId,
                nodeId: input.nodeId,
                status: "running",
                platform: "canvas-image",
                workflow: "",
                model,
                taskMode: "i2v", // 占位：图生图/文生图统一记为 i2v；分类由 platform + model 表达
                prompt: input.prompt,
                references: input.references?.map((reference) => ({ name: reference.name, mimeType: reference.mimeType, storageKey: reference.storageKey })) || [],
                inputCounts: { references: input.references?.length || 0, count: Math.max(1, Math.min(4, Math.floor(input.count || 1))) },
                runtimeTaskId: task.id,
                startedAt: new Date().toISOString(),
                durationMs: 0,
                outputs: [],
                params: { size: input.size || `${input.width || 1024}x${input.height || 1024}`, quality: input.quality || "auto" },
            }).id
            : null;
        const startedAt = Date.now();
        const effectiveHooks = hooks || (input.projectId && input.nodeId ? this.canvasHooks(input) : undefined);
        void this.execute({ ...input, model, clientTaskId: taskId }, task, effectiveHooks, logId, startedAt).catch(async (error) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            const current = this.stores.tasks.get(task.id);
            if (current && current.status !== "failed" && current.status !== "cancelled") {
                this.stores.tasks.update(task.id, { status: "failed", error: failure.message });
            }
            if (logId) {
                this.logs.update(logId, {
                    status: "failed",
                    error: failure.message,
                    finishedAt: new Date().toISOString(),
                    durationMs: Date.now() - startedAt,
                });
            }
            await effectiveHooks?.onFailed?.(failure, this.stores.tasks.get(task.id) || task);
        });
        return { taskId: task.id, logId };
    }

    async retry(task: RuntimeTask) {
        if (task.kind !== "canvas-image") throw new Error(`任务类型 ${task.kind} 不是画布图片任务`);
        const input = { ...(task.input as CanvasImageGenerationInput), clientTaskId: `canvas-retry-${crypto.randomUUID()}` };
        const result = this.start(input);
        const retried = this.stores.tasks.get(result.taskId);
        if (!retried) throw new Error("重试任务创建失败");
        this.stores.tasks.addEvent(retried.id, "retry", { parentTaskId: task.id });
        return retried;
    }

    /** Backend 重启后恢复外层画布图片任务；子执行器按固定 childTaskId 复用已有任务。 */
    resume(task: RuntimeTask) {
        if (task.kind !== "canvas-image" || !["queued", "running"].includes(task.status)) return;
        const input = task.input as CanvasImageGenerationInput;
        const log = this.logs.list({ runtimeTaskId: task.id, limit: 1 })[0];
        const hooks = input.projectId && input.nodeId ? this.canvasHooks(input) : undefined;
        void this.execute(input, task, hooks, log?.id || null, Date.parse(task.createdAt) || Date.now()).catch(async (error) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            const current = this.stores.tasks.get(task.id);
            if (current && current.status !== "failed" && current.status !== "cancelled") this.stores.tasks.update(task.id, { status: "failed", error: failure.message });
            await hooks?.onFailed?.(failure, this.stores.tasks.get(task.id) || task);
        });
    }

    private async execute(input: CanvasImageGenerationInput, task: RuntimeTask, hooks?: DispatcherHooks, logId: string | null = null, startedAt = Date.now()) {
        this.stores.tasks.update(task.id, { status: "running", progress: 0.02 });
        const result = await this.dispatch(input, task.id);
        const completed = this.stores.tasks.update(task.id, { status: "succeeded", progress: 1, result: { media: result.media } });
        this.stores.tasks.addEvent(task.id, "result", { media: result.media });
        if (logId) {
            this.logs.update(logId, {
                status: "success",
                outputs: result.media.map((media) => ({ url: media.url, storageKey: media.storageKey, mimeType: media.mimeType })),
                finishedAt: new Date().toISOString(),
                durationMs: Date.now() - startedAt,
            });
        }
        await hooks?.onCompleted?.(result, completed);
    }

    private async dispatch(input: CanvasImageGenerationInput, taskId: string): Promise<CanvasImageGenerationResult> {
        const executor = resolveCanvasExecutor({ mode: "image", model: input.model, workflow: input.workflow }, this.directImage.supports(input.model));
        if (executor === "direct-image") return this.dispatchDirect(input, taskId);

        const preset = builtinPreset(input.model);
        if (executor === "builtin-comfy" && preset) return this.dispatchBuiltin(input, taskId, preset);

        const workflowName = String(input.workflow || "").trim() || workflowNameFromModel(input.model);
        if (executor === "comfy-workflow" && workflowName) return this.dispatchWorkflow(input, taskId, workflowName);

        throw new Error(`没有可用的画布图片执行器：${input.model}`);
    }

    private async dispatchDirect(input: CanvasImageGenerationInput, taskId: string) {
        const references = await Promise.all((input.references || []).map((reference) => this.readReference(reference)));
        const childTaskId = `image-child-${taskId}`;
        this.childTasks.set(taskId, childTaskId);
        const provider = input.provider || configuredProvider(this.stores.settings.get("ai.config"), input.params?.channelId);
        const task = this.directImage.run({
            model: input.model,
            prompt: input.prompt,
            size: input.size || sizeFromDimensions(input.width, input.height),
            quality: input.quality,
            count: input.count,
            references,
            apiUrl: provider?.baseUrl,
            authKey: provider?.apiKey,
        }, undefined, childTaskId, { parentTaskId: taskId, projectId: input.projectId, nodeId: input.nodeId });
        try {
            const completed = await waitForTask(this.stores.tasks, task.id);
            return { taskId, media: mediaFromTask(completed) };
        } finally { this.childTasks.delete(taskId); }
    }

    cancel(id: string) {
        const childId = this.childTasks.get(id);
        if (childId) {
            try { this.directImage.cancel(childId); } catch { /* 外层任务仍以取消为准 */ }
            try { this.workflowExecutor.cancel(childId); } catch { /* 子任务可能尚未创建 */ }
            try { this.comfy.cancel(childId); } catch { /* 子任务可能已经结束 */ }
        }
        const task = this.stores.tasks.get(id);
        if (!task || !["queued", "running"].includes(task.status)) throw new Error(`任务状态 ${task?.status || "unknown"} 不可取消`);
        const updated = this.stores.tasks.cancel(id);
        this.stores.tasks.addEvent(id, "cancelled", { taskId: id, childTaskId: childId });
        return updated;
    }

    private async dispatchBuiltin(input: CanvasImageGenerationInput, taskId: string, preset: string) {
        const references = await Promise.all((input.references || []).map((reference) => this.materializeReference(reference)));
        const childTaskId = `comfy-child-${taskId}`;
        this.childTasks.set(taskId, childTaskId);
        const task = await this.comfy.run(preset, {
            prompt: input.prompt,
            references: references.map((reference) => reference.filePath),
        }, {
            width: input.width,
            height: input.height,
            size: input.size,
            ...(input.params || {}),
            parentTaskId: taskId,
            projectId: input.projectId,
            nodeId: input.nodeId,
            model: input.model,
        }, undefined, childTaskId);
        try {
            const completed = await waitForTask(this.stores.tasks, task.id);
            return { taskId, media: mediaFromTask(completed) };
        } finally { this.childTasks.delete(taskId); }
    }

    private async dispatchWorkflow(input: CanvasImageGenerationInput, taskId: string, workflowName: string) {
        const detail = await this.workflows.get(workflowName);
        const fields = detail.config?.fields || [];
        const fieldValues: Record<string, unknown> = { ...(input.params || {}) };
        for (const field of fields) {
            if (field.type === "text" && (field.isPrompt || field.id.toLowerCase() === "prompt")) fieldValues[field.id] = input.prompt;
            if ((field.id === "width" || field.id === "height") && fieldValues[field.id] === undefined) {
                const value = field.id === "width" ? input.width : input.height;
                if (value) fieldValues[field.id] = value;
            }
        }

        const imageFields = fields.filter((field) => isImageField(field, detail.workflow));
        const references = input.references || [];
        for (let index = 0; index < imageFields.length; index++) {
            const field = imageFields[index];
            const reference = references[index];
            fieldValues[field.id] = reference ? await this.referenceDataUrl(reference) : null;
        }

        const childTaskId = `workflow-child-${taskId}`;
        this.childTasks.set(taskId, childTaskId);
        try {
        const result = await this.workflowExecutor.run(
            detail.workflow,
            detail.config || emptyWorkflowConfig(workflowName),
            fieldValues,
            crypto.randomUUID(),
            undefined,
            workflowName,
            childTaskId,
            input.projectId,
            input.nodeId,
            taskId,
        );
        return { taskId, media: result.media };
        } finally { this.childTasks.delete(taskId); }
    }

    private async referenceDataUrl(reference: CanvasImageReference) {
        if (reference.dataUrl) return reference.dataUrl;
        const { data, mimeType } = await this.readReference(reference);
        return `data:${mimeType};base64,${data.toString("base64")}`;
    }

    private async readReference(reference: CanvasImageReference): Promise<ChatGptImageReference> {
        const data = await this.readReferenceBuffer(reference);
        return { data, mimeType: reference.mimeType || mimeFromName(reference.name) || "image/png", name: reference.name || "reference.png" };
    }

    private async materializeReference(reference: CanvasImageReference) {
        if (reference.storageKey) {
            const media = this.stores.media.meta(reference.storageKey);
            if (media) return media;
        }
        const data = await this.readReferenceBuffer(reference);
        return this.stores.media.store(data, {
            name: reference.name || "reference.png",
            mimeType: reference.mimeType || mimeFromName(reference.name) || "image/png",
            category: "input",
        });
    }

    private async readReferenceBuffer(reference: CanvasImageReference) {
        if (reference.storageKey && this.stores.media.meta(reference.storageKey)) return this.stores.media.read(reference.storageKey);
        const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(String(reference.dataUrl || ""));
        if (dataUrl) return Buffer.from(dataUrl[2], "base64");
        const rawUrl = String(reference.url || "");
        if (!rawUrl) throw new Error(`参考图缺少可读取地址：${reference.name || reference.id || "unknown"}`);
        const url = rawUrl.startsWith("/") ? `${this.config.url.replace(/\/$/, "")}${rawUrl}` : rawUrl;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`读取参考图失败（HTTP ${response.status}）：${reference.name || reference.id || "unknown"}`);
        return Buffer.from(await response.arrayBuffer());
    }

    private canvasHooks(input: CanvasImageGenerationInput): DispatcherHooks {
        return {
            onCompleted: async (result, task) => {
                const saved = this.stores.projects.writeBackCanvasImageTask(task, {
                    projectId: input.projectId!, nodeId: input.nodeId!, prompt: input.prompt, model: input.model,
                    references: input.references?.map((reference) => ({ storageKey: reference.storageKey, url: reference.url, name: reference.name })), resultPolicy: input.resultPolicy,
                }, result.media.map((media) => ({ ...media })));
                if (saved) this.events?.publish({ type: "canvas.updated", entityId: saved.id, revision: Number(saved.revision || 0), payload: saved });
            },
            onFailed: async (error, task) => {
                const saved = this.stores.projects.markCanvasImageTaskFailed(task, { projectId: input.projectId!, nodeId: input.nodeId! }, error.message);
                if (saved) this.events?.publish({ type: "canvas.updated", entityId: saved.id, revision: Number(saved.revision || 0), payload: saved });
            },
        };
    }
}

function normalizeModel(model: string) {
    return String(model || "").split("::").pop()?.trim() || "";
}

function configuredProvider(value: unknown, channelId: unknown): { baseUrl?: string; apiKey?: string } | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const config = value as Record<string, unknown>;
    const channels = Array.isArray(config.channels) ? config.channels.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
    const wanted = String(channelId || "").trim();
    const channel = channels.find((item) => String(item.id || "") === wanted) || (channels.length === 1 ? channels[0] : undefined);
    const baseUrl = String(channel?.baseUrl || config.baseUrl || "").trim();
    const apiKey = String(channel?.apiKey || config.apiKey || "").trim();
    return baseUrl || apiKey ? { baseUrl, apiKey } : undefined;
}

export function workflowNameFromModel(model: string) {
    const value = normalizeModel(model);
    if (/^z-image$/i.test(value)) return "Z-Image.json";
    if (/^flux2-klein$/i.test(value)) return "Flux2-Klein.json";
    if (/\.json$/i.test(value) || /^custom\//i.test(value)) return value;
    return "";
}

function builtinPreset(model: string) {
    const value = normalizeModel(model).toLowerCase().replace(/\.json$/, "");
    if (value === "z-image") return "z-image";
    if (value === "flux2-klein") return "flux2-klein";
    return "";
}

function isImageField(field: WorkflowField, workflow: Record<string, unknown>) {
    if (field.type === "image") return true;
    return field.node.split(",").some((id) => (workflow[id] as { class_type?: string } | undefined)?.class_type === "LoadImage");
}

function sizeFromDimensions(width?: number, height?: number) {
    return width && height ? `${width}x${height}` : "1024x1024";
}

function mimeFromName(name?: string) {
    const value = String(name || "").toLowerCase();
    if (value.endsWith(".jpg") || value.endsWith(".jpeg")) return "image/jpeg";
    if (value.endsWith(".webp")) return "image/webp";
    return "image/png";
}

function emptyWorkflowConfig(name: string): WorkflowConfig {
    return { title: name, backend: "", operation: "", description: "", fields: [] };
}

async function waitForTask(tasks: TaskStore, taskId: string): Promise<RuntimeTask> {
    for (;;) {
        const task = tasks.get(taskId);
        if (!task) throw new Error(`生成任务不存在：${taskId}`);
        if (task.status === "succeeded") return task;
        if (task.status === "failed" || task.status === "cancelled") throw new Error(task.error || `生成任务${task.status}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}

function mediaFromTask(task: RuntimeTask) {
    const result = task.result || {};
    const values = Array.isArray(result.media) ? result.media : Array.isArray(result.images) ? result.images : [];
    return values.filter((item): item is CanvasImageGenerationResult["media"][number] => !!item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string");
}
