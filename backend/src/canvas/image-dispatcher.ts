import crypto from "node:crypto";

import type { ResolvedConfig } from "../config.js";
import type { RuntimeTask, WorkflowConfig, WorkflowField } from "../db.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import { DirectImageBackend, type ChatGptImageReference } from "../runtime/chatgpt-image.js";
import type { GenerationLogStore, Stores, TaskStore } from "../stores/types.js";
import type { WorkflowExecutor } from "../workflows/executor.js";
import type { WorkflowStore } from "../workflows/store.js";

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
    constructor(
        private readonly config: ResolvedConfig,
        private readonly stores: Stores,
        private readonly comfy: ComfyUiBackend,
        private readonly directImage: DirectImageBackend,
        private readonly workflows: WorkflowStore,
        private readonly workflowExecutor: WorkflowExecutor,
    ) {}

    private get logs(): GenerationLogStore { return this.stores.logs; }

    start(input: CanvasImageGenerationInput, hooks?: DispatcherHooks) {
        const model = normalizeModel(input.model);
        if (!model) throw new Error("画布图片生成缺少模型");
        if (!input.prompt.trim()) throw new Error("画布图片生成缺少提示词");

        const taskId = input.clientTaskId || `canvas-${crypto.randomUUID()}`;
        const task = this.stores.tasks.create(taskId, "canvas-image", {
            model,
            prompt: input.prompt,
            references: input.references?.length || 0,
        }, {
            model,
            size: input.size || `${input.width || 1024}x${input.height || 1024}`,
            quality: input.quality || "auto",
            count: Math.max(1, Math.min(4, Math.floor(input.count || 1))),
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
        void this.execute({ ...input, model, clientTaskId: taskId }, task, hooks, logId, startedAt).catch(async (error) => {
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
            await hooks?.onFailed?.(failure, this.stores.tasks.get(task.id) || task);
        });
        return { taskId: task.id, logId };
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
        if (this.directImage.supports(input.model)) return this.dispatchDirect(input, taskId);

        const preset = builtinPreset(input.model);
        if (preset) return this.dispatchBuiltin(input, taskId, preset);

        const workflowName = workflowNameFromModel(input.model);
        if (workflowName) return this.dispatchWorkflow(input, taskId, workflowName);

        throw new Error(`没有可用的画布图片执行器：${input.model}`);
    }

    private async dispatchDirect(input: CanvasImageGenerationInput, taskId: string) {
        const references = await Promise.all((input.references || []).map((reference) => this.readReference(reference)));
        const task = this.directImage.run({
            model: input.model,
            prompt: input.prompt,
            size: input.size || sizeFromDimensions(input.width, input.height),
            quality: input.quality,
            count: input.count,
            references,
            apiUrl: input.provider?.baseUrl,
            authKey: input.provider?.apiKey,
        }, undefined, taskId);
        const completed = await waitForTask(this.stores.tasks, task.id);
        return {
            taskId,
            media: mediaFromTask(completed),
        };
    }

    private async dispatchBuiltin(input: CanvasImageGenerationInput, taskId: string, preset: string) {
        const references = await Promise.all((input.references || []).map((reference) => this.materializeReference(reference)));
        const task = await this.comfy.run(preset, {
            prompt: input.prompt,
            references: references.map((reference) => reference.filePath),
        }, {
            width: input.width,
            height: input.height,
            size: input.size,
            ...(input.params || {}),
        }, undefined, taskId);
        const completed = await waitForTask(this.stores.tasks, task.id);
        return { taskId, media: mediaFromTask(completed) };
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

        const result = await this.workflowExecutor.run(
            detail.workflow,
            detail.config || emptyWorkflowConfig(workflowName),
            fieldValues,
            crypto.randomUUID(),
            undefined,
            workflowName,
            taskId,
            input.projectId,
            input.nodeId,
        );
        return { taskId, media: result.media };
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
}

function normalizeModel(model: string) {
    return String(model || "").split("::").pop()?.trim() || "";
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
