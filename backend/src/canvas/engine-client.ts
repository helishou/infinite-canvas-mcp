import { Readable } from "node:stream";
import type { WorkflowConfig, WorkflowField } from "../db.js";
import type { MediaStore, SettingStore } from "../stores/types.js";

/** 引擎 error 可能是 {code,message} 对象；直接进 task.error 会变成 [object Object]。
 *  与 h3-runner 的 describeFailure 同一口径：取 message 字段，否则 JSON 序列化。 */
function engineErrorText(error: unknown): string | undefined {
    if (error === null || error === undefined) return undefined;
    if (typeof error === "string") {
        const s = error.trim();
        // 引擎侧已把 error 对象 String 化时只剩这串，本地无法还原；至少留下可行动的排查提示。
        if (s === "[object Object]") return "引擎返回的错误对象无法解析（[object Object]）；请查引擎侧 :8300 任务日志或 ComfyUI :8188 日志确认真实失败原因";
        return s || undefined;
    }
    if (error instanceof Error) return error.message || error.name;
    if (typeof error === "object") {
        const e = error as { message?: unknown; error?: unknown; code?: unknown };
        for (const v of [e.message, e.error]) {
            if (typeof v === "string" && v.trim()) return v;
            if (v && typeof v === "object") {
                const nested = engineErrorText(v);
                if (nested) return nested;
            }
        }
        if (typeof e.code === "string" && e.code.trim()) return e.code;
        try { const json = JSON.stringify(error); if (json && json !== "{}") return json; } catch { /* ignore */ }
    }
    return String(error) || undefined;
}

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

/** 引擎任务详情里附带的生成态预览帧（KJ 逐帧桥 / 自定义工作流预览桥共用形状）。 */
export type EngineTaskLivePreview = {
    dataUrl: string;
    mime?: string;
    step?: number;
    total?: number;
    nodeId?: string;
    source?: "step" | "node";
    promptId?: string;
    updatedAt?: number;
};

export type EngineImageRequest = {
    model: string;
    prompt?: string;
    fields: Record<string, unknown>;
    /** data URL 或 http(s) 地址，按工作流图片槽位顺序。 */
    images?: string[];
    /** OpenAI 标准参数：画布的尺寸/质量/张数也走这条，否则引擎只能用工作流默认值。 */
    size?: string;
    quality?: string;
    count?: number;
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

// H3 自定义工作流出片常需 20-40 分钟（多步扩散 + llm 预解析），15 分钟会把
// 仍在引擎里正常生成的任务误判超时，导致同一 Clip 被反复重提、comfyui2api 重复出片却无人取回。
// 超时不取消任务（见 waitVideo），调大后给足出片时间。
export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

export class EngineRequestError extends Error {
    constructor(message: string, readonly status: number, readonly taskId?: string) {
        super(message);
        this.name = "EngineRequestError";
    }
}

export class CanvasEngineClient {
    constructor(
        private readonly baseUrl: string,
        readonly token?: string,
        private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    ) {}

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
                    const parsed = JSON.parse(text) as { error?: unknown; code?: string; message?: string };
                    // 引擎 error 可能是对象 {code,message,...}；只取 .message 会在 message 本身是
                    // 对象/「[object Object]」时丢掉真实原因。优先整体解析，字符串兜底再取 message。
                    const parsedText = engineErrorText(parsed.error) || engineErrorText(parsed);
                    if (parsedText && parsedText !== "[object Object]") message = parsedText;
                    else if (parsed && typeof parsed === "object") {
                        const p = parsed as { error?: { message?: unknown; task_id?: string }; message?: unknown; task_id?: string };
                        const inner = p.error?.message ?? p.message;
                        const innerText = engineErrorText(inner);
                        if (innerText && innerText !== "[object Object]") message = innerText;
                        taskId = p.error?.task_id ?? p.task_id;
                    }
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

    /**
     * 按本次的参考图张数 + 提示词，取引擎真正会执行的那条工作流的能力。
     *
     * `/v1/models/<模型名>` 固定按 0 张图解析模型（详情里明说"与参考图张数无关"），
     * 全能模型于是返回用户设定的「0 图 → 文生图流」；直接拿它预检带参考图的请求，
     * 会把本来能跑的单图/多图任务误判成「只有 0 个图片输入槽」。
     * dry_run 让引擎用和真正生成完全相同的路由逻辑选出工作流（不提交 GPU、不落任务），
     * 再读那条流的真实槽位；路由失败则退回默认详情，由调用方给出原有可读错误。
     */
    async modelInfoForRequest(name: string, options: { prompt?: string; referenceCount: number }): Promise<EngineModelInfo> {
        const placeholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==";
        let resolved = "";
        try {
            const preview = await this.request<{ model?: string }>("/v1/images/generations", {
                method: "POST",
                body: JSON.stringify({
                    model: name,
                    prompt: options.prompt ?? "",
                    images: Array.from({ length: Math.max(0, options.referenceCount) }, () => placeholder),
                    dry_run: true,
                }),
            });
            resolved = String(preview.model ?? "").trim();
        } catch {
            // 0 图请求撞到纯图生图流等场景会在这里被拒；退回默认详情保留原错误文案。
        }
        return this.modelInfo(resolved || name);
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

    /** 轮询中可重试的瞬时错误：网络断线(status=0)、请求超时/冲突/过早/限流、5xx、任务暂不可见(404)。 */
    private static isTransientPollError(error: unknown): boolean {
        if (!(error instanceof EngineRequestError)) return false;
        const s = error.status;
        if (s === 0) return true;                       // 网络断线 / fetch failed
        if (s === 404) return true;                     // 任务刚提交、查询侧还没可见
        if ([408, 409, 425, 429].includes(s)) return true;
        return s >= 500;
    }

    /** 轮询视频任务到终态；瞬时断线沿原 taskId 继续查询，不重新提交（对齐影策断线重连）。 */
    async waitVideo(taskId: string, options: { timeoutMs?: number; pollMs?: number; maxTransient?: number } = {}): Promise<{ status: string; media: EngineMedia[]; error?: string }> {
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        const pollMs = options.pollMs ?? 500;
        const maxTransient = options.maxTransient ?? 12;   // 连续瞬时错误上限，防死循环
        const deadline = Date.now() + timeoutMs;
        let transientFailures = 0;
        while (Date.now() < deadline) {
            let body: { status?: string; media?: EngineMedia[]; error?: string | null };
            try {
                body = await this.request(`/v1/videos/${encodeURIComponent(taskId)}`);
            } catch (error) {
                // 断线/限流等瞬时错误：重试查询原任务，绝不抛出让上层重新提交（否则同一段重复出片）。
                if (!CanvasEngineClient.isTransientPollError(error)) throw error;
                transientFailures++;
                if (transientFailures > maxTransient) throw error;
                // 退避：pollMs → 最多 8×pollMs，和影策指数退避同思路。
                const backoff = Math.min(pollMs * Math.pow(2, transientFailures - 1), 8 * pollMs);
                await new Promise((resolve) => setTimeout(resolve, backoff));
                continue;
            }
            transientFailures = 0;   // 查询成功即清零，允许后续再次断线重连
            const status = String(body.status ?? "");
            // 引擎按 OpenAI 词表返回 queued/in_progress/completed/failed；
            // 老代码只认内部词 succeeded，会一直等到超时（节点永远停在 loading）。
            if (["succeeded", "completed", "failed", "cancelled", "canceled"].includes(status)) {
                const normalized = status === "completed" ? "succeeded" : status === "canceled" ? "cancelled" : status;
                return { status: normalized, media: body.media ?? [], error: engineErrorText(body.error) };
            }
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        throw new EngineRequestError("等待视频任务超时；任务仍在运行，可用 task_id 轮询", 504, taskId);
    }

    async generateImages(request: EngineImageRequest): Promise<{ taskId: string; media: EngineMedia[]; seed?: number }> {
        const body = await this.request<{ data?: Array<{ url?: string }>; task_id?: string; seed?: number }>("/v1/images/generations", {
            method: "POST",
            body: JSON.stringify({
                model: request.model,
                prompt: request.prompt,
                fields: request.fields,
                ...(request.images?.length ? { images: request.images } : {}),
                ...(request.size ? { size: request.size } : {}),
                ...(request.quality ? { quality: request.quality } : {}),
                ...(request.count && request.count > 1 ? { n: request.count } : {}),
            }),
        });
        return {
            taskId: String(body.task_id ?? ""),
            media: (body.data ?? []).map((item) => ({ url: String(item.url ?? "") })),
            ...(typeof body.seed === "number" && Number.isFinite(body.seed) ? { seed: body.seed } : {}),
        };
    }

    async cancel(taskId: string): Promise<void> {
        await this.request(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" }).catch(() => undefined);
    }

    /** 失败/取消后按 clientId 接回引擎里仍在执行的同一次 prompt（不重新提交）。 */
    async reclaimTask(taskId: string): Promise<{ status?: string; promptId?: string; error?: string }> {
        return await this.request<{ status?: string; promptId?: string; error?: string }>(`/api/tasks/${encodeURIComponent(taskId)}/reclaim`, { method: "POST" });
    }

    /**
     * 任务详情（含生成态预览帧）。预览帧只在引擎内存里、随轮询现取，
     * 仅供画布节点生成态显示，绝不参与产物回写或归档。
     */
    async taskDetail(taskId: string): Promise<{ status?: string; preview?: EngineTaskLivePreview | null }> {
        return await this.request<{ status?: string; preview?: EngineTaskLivePreview | null }>(`/api/tasks/${encodeURIComponent(taskId)}`);
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

/**
 * 通用 OpenAI 图片调用（不依赖引擎包里的 provider）。
 *
 * 画布对「任意 OpenAI 兼容服务」的图片能力就走这一条：有参考图打 `/v1/images/edits`，
 * 没有打 `/v1/images/generations`；`data[].url` 与 `data[].b64_json` 都支持。
 * 这样画布不再需要 import 引擎的 chatgpt-image，渠道填个 baseUrl 就能接。
 */
export type OpenAIImageInput = {
    baseUrl: string;
    token?: string;
    model: string;
    prompt?: string;
    size?: string;
    quality?: string;
    count?: number;
    references?: Array<{ mimeType: string; data: Buffer }>;
    /** 渠道级额外参数：原样并进请求体（引擎认 params / overrides / 任意字段名；普通 OpenAI 服务会忽略未知键）。 */
    extra?: Record<string, unknown>;
};

export async function generateImagesOpenAI(input: OpenAIImageInput): Promise<{ urls: string[]; blobs: Array<{ mimeType: string; data: Buffer }> }> {
    const base = input.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
    const headers: Record<string, string> = input.token ? { authorization: `Bearer ${input.token}` } : {};
    const count = Math.max(1, Math.min(4, Math.floor(input.count || 1)));
    const references = input.references ?? [];

    let response: Response;
    if (references.length) {
        const form = new FormData();
        form.append("model", input.model);
        if (input.prompt) form.append("prompt", input.prompt);
        if (input.size) form.append("size", input.size);
        if (input.quality) form.append("quality", input.quality);
        form.append("n", String(count));
        if (input.extra && Object.keys(input.extra).length) form.append("params", JSON.stringify(input.extra));
        references.forEach((reference, index) => {
            const ext = reference.mimeType.includes("jpeg") ? "jpg" : reference.mimeType.split("/").pop() || "png";
            form.append("image", new Blob([new Uint8Array(reference.data)], { type: reference.mimeType || "image/png" }), `ref-${index}.${ext}`);
        });
        response = await fetch(`${base}/v1/images/edits`, { method: "POST", headers, body: form, signal: AbortSignal.timeout(600_000) });
    } else {
        response = await fetch(`${base}/v1/images/generations`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
                model: input.model,
                prompt: input.prompt ?? "",
                ...(input.size ? { size: input.size } : {}),
                ...(input.quality ? { quality: input.quality } : {}),
                n: count,
                response_format: "url",
                ...(input.extra && Object.keys(input.extra).length ? input.extra : {}),
            }),
            signal: AbortSignal.timeout(600_000),
        });
    }

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`图片接口返回 ${response.status}：${text.slice(0, 300)}`);
    }
    const payload = await response.json() as { data?: Array<{ url?: string; b64_json?: string }> };
    const urls: string[] = [];
    const blobs: Array<{ mimeType: string; data: Buffer }> = [];
    for (const item of payload.data ?? []) {
        if (item.url) urls.push(item.url);
        else if (item.b64_json) blobs.push({ mimeType: "image/png", data: Buffer.from(item.b64_json, "base64") });
    }
    if (!urls.length && !blobs.length) throw new Error("图片接口没有返回任何产物");
    return { urls, blobs };
}
