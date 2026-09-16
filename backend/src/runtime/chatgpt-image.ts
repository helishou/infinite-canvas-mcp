import sharp from "sharp";

import type { RuntimeTask } from "../db.js";
import type { MediaStore, TaskStore } from "../stores/types.js";

export type ChatGptImageReference = {
    data: Buffer;
    mimeType: string;
    name: string;
};

export type ChatGptImageRequest = {
    prompt: string;
    model: string;
    size?: string;
    quality?: string;
    count?: number;
    references?: ChatGptImageReference[];
    apiUrl?: string;
    authKey?: string;
};

export type ChatGptImageOutput = {
    url: string;
    storageKey: string;
    mimeType: string;
    bytes: number;
    width: number | null;
    height: number | null;
};

/** 通用直连图片生成入口；具体模型由 provider 按模型名接管。 */
export class DirectImageBackend {
    private readonly controllers = new Map<string, AbortController>();
    constructor(
        private readonly tasks: TaskStore,
        private readonly media: MediaStore,
        private readonly apiUrl = process.env.CHATGPT_IMAGE_API_URL || "http://127.0.0.1:8000",
        private readonly authKey = process.env.CHATGPT_IMAGE_AUTH_KEY || "chatgpt2api",
    ) {}

    supports(model: string) {
        return /(^|::)gpt-image(?:-[\w.-]+)?$/i.test(model.trim());
    }

    run(request: ChatGptImageRequest, hooks?: {
        onCompleted?: (outputs: ChatGptImageOutput[], task: RuntimeTask) => Promise<void> | void;
        onFailed?: (error: Error, task: RuntimeTask) => Promise<void> | void;
    }, clientTaskId?: string, taskParams: Record<string, unknown> = {}) {
        if (!this.supports(request.model)) throw new Error(`当前 MCP 没有图片模型 provider：${request.model}`);
        const existing = clientTaskId ? this.tasks.get(clientTaskId) : null;
        if (existing) {
            // Backend 重启后内存中的 controller 消失；同一个持久 task 重新绑定本次请求即可恢复执行。
            if (["queued", "running"].includes(existing.status) && !this.controllers.has(existing.id)) this.startTask(existing, request, hooks);
            return existing;
        }
        const task = clientTaskId
            ? this.tasks.create(clientTaskId, `image:${request.model}`, { prompt: request.prompt }, {
                model: request.model,
                size: request.size || "1024x1024",
                quality: request.quality || "auto",
                count: Math.max(1, Math.min(4, Math.floor(request.count || 1))),
                referenceCount: request.references?.length || 0,
                ...taskParams,
            })
            : this.tasks.create(`image:${request.model}`, { prompt: request.prompt }, {
            model: request.model,
            size: request.size || "1024x1024",
            quality: request.quality || "auto",
            count: Math.max(1, Math.min(4, Math.floor(request.count || 1))),
            referenceCount: request.references?.length || 0,
            ...taskParams,
            });
        this.startTask(task, request, hooks);
        return task;
    }

    private startTask(task: RuntimeTask, request: ChatGptImageRequest, hooks?: Parameters<DirectImageBackend["run"]>[1]) {
        const controller = new AbortController();
        this.controllers.set(task.id, controller);
        void this.execute(task, request, hooks, controller.signal).catch((error) => this.fail(task.id, error)).finally(() => this.controllers.delete(task.id));
    }

    cancel(id: string) {
        this.controllers.get(id)?.abort();
        this.controllers.delete(id);
        const task = this.tasks.get(id);
        if (!task || !["queued", "running"].includes(task.status)) throw new Error(`任务状态 ${task?.status || "unknown"} 不可取消`);
        const updated = this.tasks.cancel(id);
        this.tasks.addEvent(id, "cancelled", { taskId: id });
        return updated;
    }

    private async execute(task: RuntimeTask, request: ChatGptImageRequest, hooks?: {
        onCompleted?: (outputs: ChatGptImageOutput[], task: RuntimeTask) => Promise<void> | void;
        onFailed?: (error: Error, task: RuntimeTask) => Promise<void> | void;
    }, signal?: AbortSignal) {
        this.update(task.id, { status: "running", progress: 0.05 });
        try {
            const images = await requestImages(request.apiUrl || this.apiUrl, request.authKey || this.authKey, request, signal);
            const outputs: ChatGptImageOutput[] = [];
            for (let index = 0; index < images.length; index++) {
                const image = images[index];
                const dimensions = await sharp(image.data).metadata().catch(() => ({ width: undefined, height: undefined }));
                const stored = this.media.store(image.data, {
                    name: `gpt-image-2-${task.id}-${index + 1}.png`,
                    mimeType: image.mimeType,
                    category: "output",
                    width: dimensions.width || null,
                    height: dimensions.height || null,
                });
                outputs.push({
                    url: this.media.url(stored),
                    storageKey: stored.storageKey,
                    mimeType: stored.mimeType,
                    bytes: stored.bytes,
                    width: stored.width,
                    height: stored.height,
                });
            }
            const result = { images: outputs };
            const completed = this.update(task.id, { status: "succeeded", progress: 1, result });
            this.tasks.addEvent(task.id, "result", result);
            await hooks?.onCompleted?.(outputs, completed);
        } catch (error) {
            this.fail(task.id, error);
            await hooks?.onFailed?.(error instanceof Error ? error : new Error(String(error)), this.tasks.get(task.id) || task);
        }
    }

    private update(id: string, patch: Parameters<TaskStore["update"]>[1]) {
        return this.tasks.update(id, patch);
    }

    private fail(id: string, error: unknown) {
        if (this.tasks.get(id)?.status === "cancelled") return;
        const message = error instanceof Error ? error.message : String(error);
        this.update(id, { status: "failed", error: message });
        this.tasks.addEvent(id, "error", { error: message });
    }
}

type ImageResponseItem = { b64_json?: string; url?: string };

async function requestImages(apiUrl: string, authKey: string, request: ChatGptImageRequest, signal?: AbortSignal) {
    const count = Math.max(1, Math.min(4, Math.floor(request.count || 1)));
    // 渠道 baseUrl 既可能是 `http://host:port` 也可能是 `http://host:port/v1`（本机 ai.config 就是后者）。
    // 这里统一剥掉结尾的 /v1，避免拼出 `/v1/v1/images/edits` → HTTP 405 Method Not Allowed。
    const baseUrl = apiUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
    const headers = { Authorization: `Bearer ${authKey}` };
    let response: Response;

    if (request.references?.length) {
        const form = new FormData();
        form.set("model", request.model);
        form.set("prompt", request.prompt);
        form.set("n", String(count));
        form.set("quality", request.quality || "auto");
        form.set("size", request.size || "1024x1024");
        form.set("output_format", "png");
        const field = request.references.length > 1 ? "image[]" : "image";
        for (const reference of request.references) {
            form.append(field, new Blob([reference.data as unknown as BlobPart], { type: reference.mimeType }), reference.name);
        }
        response = await fetch(`${baseUrl}/v1/images/edits`, { method: "POST", headers, body: form, signal });
    } else {
        response = await fetch(`${baseUrl}/v1/images/generations`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ model: request.model, prompt: request.prompt, n: count, size: request.size || "1024x1024", quality: request.quality || "auto", output_format: "png" }),
            signal,
        });
    }

    const payload = await response.json().catch(() => ({})) as { data?: ImageResponseItem[]; error?: { message?: string } | string };
    if (!response.ok) throw new Error(`GPT Image 请求失败（HTTP ${response.status}）：${readApiError(payload.error)}`);
    if (!Array.isArray(payload.data) || payload.data.length === 0) throw new Error("GPT Image 没有返回图片");
    return Promise.all(payload.data.map(readImageResponse));
}

async function readImageResponse(item: ImageResponseItem) {
    if (item.b64_json) return { data: Buffer.from(item.b64_json, "base64"), mimeType: "image/png" };
    const value = String(item.url || "");
    const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(value);
    if (dataUrl) return { data: Buffer.from(dataUrl[2], "base64"), mimeType: dataUrl[1] };
    if (!/^https?:\/\//i.test(value)) throw new Error("GPT Image 返回了无法读取的图片地址");
    const response = await fetch(value, { signal: undefined });
    if (!response.ok) throw new Error(`读取 GPT Image 结果失败（HTTP ${response.status}）`);
    return { data: Buffer.from(await response.arrayBuffer()), mimeType: response.headers.get("content-type")?.split(";", 1)[0] || "image/png" };
}

function readApiError(error: { message?: string } | string | undefined) {
    if (typeof error === "string") return error;
    return error?.message || "未知错误";
}
