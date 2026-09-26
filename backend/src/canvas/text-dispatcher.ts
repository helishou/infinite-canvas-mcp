import crypto from "node:crypto";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";

import type { ResolvedConfig } from "../config.js";
import type { RuntimeTask } from "../db.js";
import type { Stores } from "../stores/types.js";
import { decodeChannelModel, modelOptionName } from "./model-workflow.js";
import { resolveCanvasExecutor } from "./executor-registry.js";
import { prepareCanvasGenerationTarget } from "./generation-target.js";
import type { CanvasOperation } from "./project-ops.js";

export type CanvasTextReference = {
    id?: string;
    name?: string;
    dataUrl?: string;
    url?: string;
    storageKey?: string;
    mimeType?: string;
};

export type CanvasTextGenerationInput = {
    projectId?: string;
    nodeId?: string;
    sourceNodeId?: string;
    model: string;
    prompt: string;
    references?: CanvasTextReference[];
    count?: number;
    params?: Record<string, unknown>;
    loopOutput?: CanvasGenerationCommand["loopOutput"];
    clientTaskId?: string;
    resultPolicy?: "replace-active" | "append";
};

type TextProvider = {
    model: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: "openai" | "openai-chat";
    systemPrompt: string;
    reasoningEffort: string;
};

type TextRequest = (provider: TextProvider, prompt: string, imageDataUrls: string[], signal?: AbortSignal) => Promise<string>;

/** Backend 原生文本执行器：无浏览器时也能运行画布识图/文本生成并回写结果节点。 */
export class CanvasTextDispatcher {
    private readonly controllers = new Map<string, AbortController>();

    constructor(
        private readonly config: ResolvedConfig,
        private readonly stores: Stores,
        private readonly requestText: TextRequest = requestOpenAiText,
    ) {}

    start(rawInput: CanvasTextGenerationInput) {
        let input = this.prepareInput(rawInput);
        const provider = this.resolveProvider(input);
        const executor = resolveCanvasExecutor({ mode: "text", model: provider.model });
        const taskId = input.clientTaskId || `canvas-text-${crypto.randomUUID()}`;
        const existing = this.stores.tasks.get(taskId);
        if (existing) return { taskId: existing.id, executor };
        const active = this.findActiveTask(input);
        if (active) return { taskId: active.id, executor: active.executor || executor };
        let project = this.canvasTarget(input);
        let createOperations: CanvasOperation[] = [];
        const source = project && input.nodeId ? arrayRecords(project.nodes).find((node) => node.id === input.nodeId) : undefined;
        if (source?.type === "config" && recordOf(source.metadata).smart === true) {
            const prepared = prepareCanvasGenerationTarget(this.stores, {
                ...input,
                mode: "text",
                params: { ...(input.params || {}), targetTextNodeId: input.nodeId },
            }, taskId);
            input = prepared.command as CanvasTextGenerationInput;
            project = prepared.project;
            createOperations = prepared.createOperations;
        }

        const task = this.stores.tasks.create(taskId, "canvas-text", input, {
            projectId: input.projectId,
            nodeId: input.nodeId,
            executor,
            model: provider.model,
            count: input.count,
            resultPolicy: input.resultPolicy || "replace-active",
        });
        try {
            if (project) this.stores.projects.applyOperations(input.projectId!, Number(project.revision || 0), [
                ...createOperations,
                {
                    type: "update_node", id: input.nodeId!,
                    metadata: { runtimeTaskId: task.id, status: "loading", runProgress: 0 },
                    metadataDelete: ["errorDetails"],
                },
            ], { operationId: `text-task-bind:${task.id}`, runtimeWrite: true, source: { clientId: `task:${task.id}`, kind: "task", label: "文本生成任务" } });
        } catch (error) {
            this.stores.tasks.update(task.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
            throw error; // 绑定未落库不得调用模型，也不能让恢复流程盲目接管节点。
        }
        const controller = new AbortController();
        this.controllers.set(task.id, controller);
        void this.execute(input, provider, task, controller).catch((error) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            const current = this.stores.tasks.get(task.id);
            if (current && current.status !== "cancelled" && current.status !== "failed") {
                this.stores.tasks.update(task.id, { status: "failed", error: failure.message });
                this.markCanvasFailed(task.id, input, failure.message, false);
            }
        }).finally(() => this.controllers.delete(task.id));
        return { taskId: task.id, executor };
    }

    retry(task: RuntimeTask) {
        if (task.kind !== "canvas-text") throw new Error(`任务类型 ${task.kind} 不是画布文本任务`);
        const result = this.start({ ...(task.input as CanvasTextGenerationInput), clientTaskId: `canvas-text-retry-${crypto.randomUUID()}` });
        const retried = this.stores.tasks.get(result.taskId);
        if (!retried) throw new Error("文本重试任务创建失败");
        this.stores.tasks.addEvent(retried.id, "retry", { parentTaskId: task.id });
        return retried;
    }

    resume(task: RuntimeTask) {
        if (task.kind !== "canvas-text" || !["queued", "running"].includes(task.status)) return;
        const input = task.input as CanvasTextGenerationInput;
        let provider: TextProvider;
        try {
            const project = this.canvasTarget(input);
            const node = project && arrayRecords(project.nodes).find((node) => node.id === input.nodeId);
            if (project && recordOf(node?.metadata).runtimeTaskId !== task.id) throw new Error("文本任务已失去节点绑定，保留当前画布，不恢复旧任务");
            provider = this.resolveProvider(input);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.stores.tasks.update(task.id, { status: "failed", error: message });
            this.markCanvasFailed(task.id, input, message, false);
            return;
        }
        const controller = new AbortController();
        this.controllers.set(task.id, controller);
        void this.execute(input, provider, task, controller).catch((error) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            const current = this.stores.tasks.get(task.id);
            if (current && current.status !== "cancelled" && current.status !== "failed") {
                this.stores.tasks.update(task.id, { status: "failed", error: failure.message });
                this.markCanvasFailed(task.id, input, failure.message, false);
            }
        }).finally(() => this.controllers.delete(task.id));
    }

    cancel(id: string) {
        const task = this.stores.tasks.get(id);
        if (!task || !["queued", "running"].includes(task.status)) throw new Error(`任务状态 ${task?.status || "unknown"} 不可取消`);
        this.controllers.get(id)?.abort();
        const cancelled = this.stores.tasks.cancel(id);
        this.markCanvasFailed(id, task.input as CanvasTextGenerationInput, "", true);
        return cancelled;
    }

    private async execute(input: CanvasTextGenerationInput, provider: TextProvider, task: RuntimeTask, controller: AbortController) {
        this.stores.tasks.update(task.id, { status: "running", progress: 0.05 });
        const imageDataUrls = await Promise.all((input.references || []).map((reference) => this.referenceDataUrl(reference)));
        const count = Math.max(1, Math.min(4, Math.floor(Number(input.count || 1))));
        const contents: string[] = [];
        for (let index = 0; index < count; index++) {
            if (controller.signal.aborted) return;
            const content = (await this.requestText(provider, input.prompt, imageDataUrls, controller.signal)).trim();
            if (controller.signal.aborted) return; // 提供方可能忽略 AbortSignal；迟到结果不能把 cancelled 改回 succeeded。
            if (!content) throw new Error("文本模型返回了空内容");
            contents.push(content);
            this.stores.tasks.update(task.id, { progress: 0.1 + ((index + 1) / count) * 0.75 });
        }
        this.writeBackCanvasText(task.id, input, contents, provider.model, provider.reasoningEffort);
        const result = { texts: contents.map((content, index) => ({ index, content })) };
        this.stores.tasks.update(task.id, { status: "succeeded", progress: 1, result });
        this.stores.tasks.addEvent(task.id, "result", result);
    }

    private canvasTarget(input: CanvasTextGenerationInput) {
        if (!input.nodeId) return null;
        if (!input.projectId) throw new Error("画布文本任务指定 nodeId 时必须提供 projectId");
        const project = this.stores.projects.get(input.projectId);
        if (!project || !arrayRecords(project.nodes).some((node) => node.id === input.nodeId)) throw new Error("画布文本生成目标不存在，未启动模型");
        const targetTextNodeId = String(input.params?.targetTextNodeId || "");
        if (targetTextNodeId) {
            const target = arrayRecords(project.nodes).find((node) => node.id === targetTextNodeId);
            if (!target || (target.type !== "text" && !(target.type === "config" && recordOf(target.metadata).smart === true))) throw new Error("文本重试结果节点不存在，未启动模型");
        }
        return project;
    }

    private prepareInput(input: CanvasTextGenerationInput): CanvasTextGenerationInput {
        const prompt = String(input.prompt || "").trim();
        if (!prompt) throw new Error("画布文本提示词为空");
        const selectedModel = String(input.model || "").trim();
        if (!selectedModel) throw new Error("画布文本生成缺少模型");
        const references = (input.references || []).map((reference) => {
            if (reference.storageKey && this.stores.media.meta(reference.storageKey)) return stripReferencePayload(reference);
            const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(reference.dataUrl || ""));
            if (!match) return stripReferencePayload(reference);
            const stored = this.stores.media.store(Buffer.from(match[2], "base64"), {
                name: reference.name || "reference.png",
                mimeType: reference.mimeType || match[1] || "image/png",
                category: "input",
            });
            return stripReferencePayload({ ...reference, storageKey: stored.storageKey, url: this.stores.media.url(stored), mimeType: stored.mimeType });
        });
        return {
            ...input,
            model: selectedModel,
            prompt,
            references,
            count: Math.max(1, Math.min(4, Math.floor(Number(input.count || 1)))),
        };
    }

    private resolveProvider(input: CanvasTextGenerationInput): TextProvider {
        const config = recordOf(this.stores.settings.get("ai.config"));
        const decoded = decodeChannelModel(input.model);
        const model = modelOptionName(input.model).trim();
        const channels = arrayRecords(config.channels);
        const channel = decoded
            ? channels.find((item) => String(item.id || "") === decoded.channelId)
            : channels.find((item) => arrayRecords(item.models).some((entry) => String(entry.name || "") === model)) || channels[0];
        if (!channel) throw new Error(`文本模型「${model}」没有可用渠道配置`);
        const declaration = arrayRecords(channel.models).find((entry) => String(entry.name || "") === model);
        if (String(declaration?.script || "").trim()) throw new Error(`文本模型「${model}」使用浏览器自定义脚本，Backend 无头执行暂不支持该脚本`);
        const apiFormat = String(channel.apiFormat || config.apiFormat || "openai");
        if (apiFormat !== "openai" && apiFormat !== "openai-chat") throw new Error(`Backend 文本执行器暂不支持渠道协议：${apiFormat}`);
        const baseUrl = String(channel.baseUrl || config.baseUrl || "").trim();
        const apiKey = String(channel.apiKey || config.apiKey || "").trim();
        if (!baseUrl) throw new Error(`文本模型「${model}」缺少 Base URL`);
        if (!apiKey) throw new Error(`文本模型「${model}」缺少 API Key`);
        return {
            model,
            baseUrl,
            apiKey,
            apiFormat,
            systemPrompt: String(input.params?.systemPrompt ?? config.systemPrompt ?? "").trim(),
            reasoningEffort: String(input.params?.reasoningEffort || config.reasoningEffort || "auto"),
        };
    }

    private findActiveTask(input: CanvasTextGenerationInput) {
        if (!input.projectId || !input.nodeId) return null;
        for (const status of ["running", "queued"] as const) {
            const active = this.stores.tasks.list({ kind: "canvas-text", status, projectId: input.projectId, limit: 500 })
                .find((task) => String((task.input as CanvasTextGenerationInput).nodeId || "") === input.nodeId);
            if (active) return active;
        }
        return null;
    }

    private async referenceDataUrl(reference: CanvasTextReference) {
        if (reference.dataUrl) return reference.dataUrl;
        let data: Buffer;
        if (reference.storageKey && this.stores.media.meta(reference.storageKey)) {
            data = await this.stores.media.read(reference.storageKey);
        } else {
            const rawUrl = String(reference.url || "");
            if (!rawUrl) throw new Error(`参考图缺少可读取地址：${reference.name || reference.id || "unknown"}`);
            const url = rawUrl.startsWith("/") ? `${this.config.url.replace(/\/$/, "")}${rawUrl}` : rawUrl;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`读取参考图失败（HTTP ${response.status}）：${reference.name || reference.id || "unknown"}`);
            data = Buffer.from(await response.arrayBuffer());
        }
        return `data:${reference.mimeType || "image/png"};base64,${data.toString("base64")}`;
    }

    /** Browser-script executors still delegate the authoritative canvas writeback here. */
    writeBackExternal(taskId: string, input: CanvasTextGenerationInput, contents: string[]) {
        return this.writeBackCanvasText(taskId, input, contents, modelOptionName(input.model), String(input.params?.reasoningEffort || "auto"));
    }

    markExternalFailed(taskId: string, input: CanvasTextGenerationInput, error: string, cancelled = false) {
        this.markCanvasFailed(taskId, input, error, cancelled);
    }

    private writeBackCanvasText(taskId: string, input: CanvasTextGenerationInput, contents: string[], model: string, reasoningEffort: string) {
        if (!input.projectId || !input.nodeId) return true;
        const project = this.stores.projects.get(input.projectId);
        if (!project) return false;
        const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
        const source = nodes.find((item) => String(item.id || "") === input.nodeId);
        if (!source || String(recordOf(source.metadata).runtimeTaskId || "") !== taskId) return false;
        const sourceMetadata = recordOf(source.metadata);
        const previousIds = Array.isArray(sourceMetadata.generatedTextResultIds) ? sourceMetadata.generatedTextResultIds.map(String) : [];
        const operations: Array<Record<string, unknown>> = [];
        const sourceNodeId = String(input.sourceNodeId || input.nodeId);
        const targetTextNodeId = String(input.params?.targetTextNodeId || (
            source.type === "text" && sourceMetadata.generationEngine === "backend" ? input.nodeId : ""
        ));
        if (!input.loopOutput && (input.resultPolicy || "replace-active") === "replace-active") {
            for (const id of previousIds) if (id !== targetTextNodeId && nodes.some((node) => String(node.id || "") === id)) operations.push({ type: "delete_node", id });
        }
        const textItems = contents.map((content) => ({ id: `text-value-${crypto.randomUUID()}`, status: "success", content }));
        if (targetTextNodeId) {
            const resultMetadata = {
                content: contents[0], prompt: input.prompt, status: "success", fontSize: 14, model, reasoningEffort,
                textCount: contents.length, texts: textItems, primaryTextId: textItems[0].id, source: "Backend canvas text dispatcher",
            };
            operations.push({ type: "update_node", id: targetTextNodeId, metadata: targetTextNodeId === sourceNodeId
                ? { ...resultMetadata, primaryTextNodeId: targetTextNodeId,
                    generatedTextResultIds: input.loopOutput ? [...new Set([...previousIds, targetTextNodeId])] : [targetTextNodeId], generationTaskId: taskId }
                : resultMetadata, metadataDelete: ["runtimeTaskId", "errorDetails"] });
            if (targetTextNodeId !== sourceNodeId) operations.push({ type: "update_node", id: sourceNodeId,
                metadata: { status: "success", primaryTextNodeId: targetTextNodeId, generatedTextResultIds: [targetTextNodeId], generationTaskId: taskId },
                metadataDelete: ["runtimeTaskId", "errorDetails"] });
            this.stores.projects.applyOperations(input.projectId, Number(project.revision || 0), operations as never,
                { runtimeWrite: true, source: { clientId: `task:${taskId}`, kind: "task", label: "文本生成任务" } });
            return true;
        }
        const id = `text-${crypto.randomUUID()}`;
        const position = recordOf(source.position);
        const resultNode = {
            id,
            nodeType: "text",
            type: "add_node",
            title: `${String(source.title || "文本生成")}｜结果`,
            position: { x: Number(position.x || 0) + Number(source.width || 324) + 96, y: Number(position.y || 0) },
            width: 340,
            height: 240,
            metadata: {
                content: contents[0],
                prompt: input.prompt,
                status: "success",
                fontSize: 14,
                model,
                reasoningEffort,
                textCount: contents.length,
                texts: textItems,
                primaryTextId: textItems[0].id,
                source: "Backend canvas text dispatcher",
            },
        };
        operations.push(resultNode);
        operations.push({ type: "connect_nodes", id: `connection-${crypto.randomUUID()}`, fromNodeId: input.nodeId, toNodeId: id });
        const generatedTextResultIds = (input.resultPolicy || "replace-active") === "append" ? [...previousIds, id] : [id];
        operations.push({
            type: "update_node",
            id: sourceNodeId,
            metadata: { status: "success", primaryTextNodeId: id, generatedTextResultIds, generationTaskId: taskId },
            metadataDelete: ["runtimeTaskId", "errorDetails"],
        });
        this.stores.projects.applyOperations(input.projectId, Number(project.revision || 0), operations as never, { runtimeWrite: true, source: { clientId: `task:${taskId}`, kind: "task", label: "文本生成任务" } });
        return true;
    }

    private markCanvasFailed(taskId: string, input: CanvasTextGenerationInput, error: string, cancelled: boolean) {
        if (!input.projectId || !input.nodeId) return;
        const project = this.stores.projects.get(input.projectId);
        if (!project) return;
        const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
        const nodeIds = [...new Set([input.nodeId, input.sourceNodeId].filter((id): id is string => Boolean(id)))];
        const boundIds = nodeIds.filter((id) => nodes.some((node) => String(node.id || "") === id && String(recordOf(node.metadata).runtimeTaskId || "") === taskId));
        if (!boundIds.length) return;
        this.stores.projects.applyOperations(input.projectId, Number(project.revision || 0), boundIds.map((id) => ({
            type: "update_node",
            id,
            metadata: { status: cancelled ? "cancelled" : "error", ...(cancelled ? {} : { errorDetails: error }) },
            metadataDelete: cancelled ? ["runtimeTaskId", "errorDetails"] : ["runtimeTaskId"],
        })) as never, { runtimeWrite: true, source: { clientId: `task:${taskId}`, kind: "task", label: "文本生成任务" } });
    }
}

export async function requestOpenAiText(provider: TextProvider, prompt: string, imageDataUrls: string[], signal?: AbortSignal): Promise<string> {
    const userContent: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = imageDataUrls.length
        ? [{ type: "text", text: prompt }, ...imageDataUrls.map((url) => ({ type: "image_url" as const, image_url: { url } }))]
        : prompt;
    const messages = [
        ...(provider.systemPrompt ? [{ role: "system", content: provider.systemPrompt }] : []),
        { role: "user", content: userContent },
    ];
    if (provider.apiFormat === "openai-chat") return requestChatCompletions(provider, messages, signal);

    const responseInput = messages.map((message) => ({
        role: message.role,
        content: typeof message.content === "string"
            ? [{ type: "input_text", text: message.content }]
            : message.content.map((part) => part.type === "text"
                ? { type: "input_text", text: part.text }
                : { type: "input_image", image_url: part.image_url.url }),
    }));
    try {
        const payload = await postJson(provider, "/responses", {
            model: provider.model,
            input: responseInput,
            ...(provider.reasoningEffort === "auto" ? {} : { reasoning: { effort: provider.reasoningEffort } }),
        }, signal);
        return readTextPayload(payload);
    } catch (error) {
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) throw error;
        if (signal?.aborted) throw error;
        return requestChatCompletions(provider, messages, signal);
    }
}

async function requestChatCompletions(provider: TextProvider, messages: Array<Record<string, unknown>>, signal?: AbortSignal) {
    const payload = await postJson(provider, "/chat/completions", { model: provider.model, messages, stream: false }, signal);
    return readTextPayload(payload);
}

async function postJson(provider: TextProvider, path: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const response = await fetch(apiUrl(provider.baseUrl, path), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify(body),
        signal,
    });
    const raw = await response.text();
    let payload: unknown;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { error: { message: raw.slice(0, 500) } }; }
    if (!response.ok) throw new HttpError(response.status, responseError(payload) || `HTTP ${response.status}`);
    return payload;
}

function readTextPayload(value: unknown) {
    const payload = recordOf(value);
    const direct = String(payload.output_text || "").trim();
    if (direct) return direct;
    const output = Array.isArray(payload.output) ? payload.output : [];
    const responseText = output.flatMap((item) => {
        const content = Array.isArray(recordOf(item).content) ? recordOf(item).content as unknown[] : [];
        return content.flatMap((part) => {
            const entry = recordOf(part);
            const text = String(entry.text || entry.output_text || "").trim();
            return text ? [text] : [];
        });
    }).join("");
    if (responseText) return responseText;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const content = choices.length ? recordOf(recordOf(choices[0]).message).content : "";
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
        const text = content.map((part) => String(recordOf(part).text || "")).join("").trim();
        if (text) return text;
    }
    throw new Error("文本模型响应中没有可读取的文本内容");
}

function responseError(value: unknown) {
    const payload = recordOf(value);
    return String(recordOf(payload.error).message || payload.message || "");
}

function apiUrl(baseUrl: string, path: string) {
    const base = baseUrl.trim().replace(/\/+$/, "");
    return `${base.toLowerCase().endsWith("/v1") ? base : `${base}/v1`}${path}`;
}

class HttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

function stripReferencePayload(reference: CanvasTextReference): CanvasTextReference {
    const { dataUrl: _dataUrl, ...handle } = reference;
    return handle;
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function recordOf(value: unknown): Record<string, any> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
