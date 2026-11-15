import { Readable } from "node:stream";
import type { WorkflowConfig, WorkflowField } from "../db.js";
import type { MediaStore, SettingStore } from "../stores/types.js";

/**
 * 画布 → 执行引擎的 HTTP 客户端。
 *
 * 这一层是「只走 OpenAI 协议」的落点：画布不再 import 引擎的任何模块，
 * 也不自己做工作流图转换 / 图片槽位推断，全部由引擎在 /v1/models 里报能力。
 */
export type EngineModelInfo = {
    id: string;
    title?: string;
    fields: WorkflowField[];
    outputNodes: string[];
    runTarget: WorkflowConfig["runTarget"] | string;
    imageInput: { counts: number[]; fieldIds: string[] };
    mediaInputs: { images: string[]; videos: string[]; audios: string[] };
};

export type EngineMedia = {
    url: string;
    storage_key?: string;
    mime_type?: string;
    filename?: string;
};

export type EngineImageRequest = {
    model: string;
    prompt?: string;
    fields: Record<string, unknown>;
    /** data URL 或 http(s) 地址，按工作流图片槽位顺序。 */
    images?: string[];
    size?: string;
};

export type EngineVideoRequest = {
    model: string;
    prompt?: string;
    fields: Record<string, unknown>;
    images?: string[];
    videos?: string[];
    audios?: string[];
    /** 时长（秒）；由引擎按工作流的 durationTarget 换算注入。 */
    seconds?: string | number;
    size?: string;
};

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export class EngineRequestError extends Error {
    constructor(message: string, readonly status: number, readonly taskId?: string) {
        super(message);
        this.name = "EngineRequestError";
    }
}

export class CanvasEngineClient {
    constructor(
        private readonly baseUrl: string,
        private readonly token?: string,
        private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    ) {}

    /** 设置里配了 `engine.url`（或缺省时环境变量 `CANVAS_ENGINE_URL`）才启用；都没配时画布维持本地执行器。 */
    static fromSettings(settings: SettingStore): CanvasEngineClient | null {
        const url = String(settings.get("engine.url") ?? "").trim() || String(process.env.CANVAS_ENGINE_URL ?? "").trim();
        if (!url) return null;
        const token = String(settings.get("engine.token") ?? "").trim() || String(process.env.CANVAS_ENGINE_TOKEN ?? "").trim();
        return new CanvasEngineClient(url.replace(/\/+$/, ""), token || undefined);
    }

    get url() { return this.baseUrl; }

    private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        timer.unref?.();
        try {
            const response = await fetch(`${this.baseUrl}${path}`, {
                ...init,
                signal: controller.signal,
                headers: {
                    ...(init.body ? { "content-type": "application/json" } : {}),
                    ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
                    ...(init.headers ?? {}),
                },
            });
            const text = await response.text();
            if (!response.ok) {
                let message = text || `HTTP ${response.status}`;
                let taskId: string | undefined;
                try {
                    const parsed = JSON.parse(text) as { error?: { message?: string; task_id?: string } };
                    message = parsed.error?.message || message;
                    taskId = parsed.error?.task_id;
                } catch { /* 非 JSON 错误体 */ }
                throw new EngineRequestError(message, response.status, taskId);
            }
            return (text ? JSON.parse(text) : {}) as T;
        } catch (error) {
            if (error instanceof EngineRequestError) throw error;
            const reason = error instanceof Error ? error.message : String(error);
            throw new EngineRequestError(`执行引擎不可用：${reason}`, 0);
        } finally {
            clearTimeout(timer);
        }
    }

    async modelInfo(name: string): Promise<EngineModelInfo> {
        const body = await this.request<{
            id: string; title?: string; fields?: WorkflowField[]; output_nodes?: string[];
            run_target?: string; image_input?: { counts?: number[]; field_ids?: string[] };
            media_inputs?: { images?: string[]; videos?: string[]; audios?: string[] };
        }>(`/v1/models/${encodeURIComponent(name)}`);
        return {
            id: body.id,
            title: body.title,
            fields: body.fields ?? [],
            outputNodes: body.output_nodes ?? [],
            runTarget: body.run_target ?? "local",
            imageInput: { counts: body.image_input?.counts ?? [], fieldIds: body.image_input?.field_ids ?? [] },
            mediaInputs: {
                images: body.media_inputs?.images ?? body.image_input?.field_ids ?? [],
                videos: body.media_inputs?.videos ?? [],
                audios: body.media_inputs?.audios ?? [],
            },
        };
    }

    /** 异步视频：提交即返回任务 id，进度用 `waitVideo` 轮询。 */
    async createVideo(request: EngineVideoRequest): Promise<{ taskId: string }> {
        const body = await this.request<{ id?: string }>("/v1/videos", {
            method: "POST",
            body: JSON.stringify({
                model: request.model,
                prompt: request.prompt,
                fields: request.fields,
                ...(request.images?.length ? { images: request.images } : {}),
                ...(request.videos?.length ? { videos: request.videos } : {}),
                ...(request.audios?.length ? { audios: request.audios } : {}),
                ...(request.seconds ? { seconds: request.seconds } : {}),
                ...(request.size ? { size: request.size } : {}),
            }),
        });
        if (!body.id) throw new EngineRequestError("执行引擎没有返回视频任务 id", 500);
        return { taskId: body.id };
    }

    /** 轮询视频任务到终态；超时不取消任务，抛出带 taskId 的错误便于上层提示。 */
    async waitVideo(taskId: string, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<{ status: string; media: EngineMedia[]; error?: string }> {
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        const pollMs = options.pollMs ?? 500;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const body = await this.request<{ status?: string; media?: EngineMedia[]; error?: string | null }>(`/v1/videos/${encodeURIComponent(taskId)}`);
            const status = String(body.status ?? "");
            if (["succeeded", "failed", "cancelled"].includes(status)) {
                return { status, media: body.media ?? [], error: body.error ?? undefined };
            }
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        throw new EngineRequestError("等待视频任务超时；任务仍在运行，可用 task_id 轮询", 504, taskId);
    }

    async generateImages(request: EngineImageRequest): Promise<{ taskId: string; media: EngineMedia[] }> {
        const body = await this.request<{ data?: Array<{ url?: string }>; task_id?: string }>("/v1/images/generations", {
            method: "POST",
            body: JSON.stringify({
                model: request.model,
                prompt: request.prompt,
                fields: request.fields,
                ...(request.images?.length ? { images: request.images } : {}),
                ...(request.size ? { size: request.size } : {}),
            }),
        });
        return { taskId: String(body.task_id ?? ""), media: (body.data ?? []).map((item) => ({ url: String(item.url ?? "") })) };
    }

    async cancel(taskId: string): Promise<void> {
        await this.request(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" }).catch(() => undefined);
    }

    /** 服务端到服务端转发（画布 `/api/engine/*` 代理用），令牌只在这条链路里出现。 */
    async proxyFetch(url: string, init: { method: string; body?: string; contentType?: string }): Promise<{ status: number; contentType: string; body: Buffer }> {
        const response = await fetch(url, {
            method: init.method,
            ...(init.body ? { body: init.body } : {}),
            headers: {
                ...(init.body ? { "content-type": init.contentType ?? "application/json" } : {}),
                ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            },
        });
        return {
            status: response.status,
            contentType: response.headers.get("content-type") ?? "application/json",
            body: Buffer.from(await response.arrayBuffer()),
        };
    }

    /** 带鉴权地下载引擎产物（`/media/` 同样受 Bearer 保护）。 */
    async fetchMedia(url: string): Promise<Response> {
        const response = await fetch(url, { headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
        if (!response.ok || !response.body) throw new EngineRequestError(`产物下载失败：${url}`, response.status);
        return response;
    }
}

/**
 * 引擎产物落到画布媒体库：画布侧下游（回写、生成日志、前端 URL）都按本地 storageKey 工作，
 * 所以先下载再入库。两份库同时存在是当前阶段已确认的代价；换成纯引用要连带改回写链路。
 */
export async function importEngineMedia(
    media: MediaStore,
    items: EngineMedia[],
    fetchMedia: (url: string) => Promise<Response> = async (url) => {
        const response = await fetch(url);
        if (!response.ok || !response.body) throw new EngineRequestError(`产物下载失败：${url}`, response.status);
        return response;
    },
): Promise<Array<{ url: string; storageKey: string; mimeType: string; filename?: string; bytes?: number }>> {
    const imported = [];
    for (const item of items) {
        if (!item.url) continue;
        const response = await fetchMedia(item.url);
        if (!response.body) throw new EngineRequestError(`产物响应没有内容：${item.url}`, response.status);
        const stored = await media.storeStream(Readable.fromWeb(response.body as never), {
            name: item.filename,
            mimeType: item.mime_type || response.headers.get("content-type") || "",
            category: "output",
        });
        imported.push({
            url: media.url(stored),
            storageKey: stored.storageKey,
            mimeType: stored.mimeType,
            filename: item.filename,
            bytes: stored.bytes,
        });
    }
    return imported;
}
