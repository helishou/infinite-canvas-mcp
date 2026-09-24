import type { ResolvedConfig } from "../config.js";
import type { RuntimeTask } from "../db.js";
import type { MediaStore, SettingStore, TaskStore } from "../stores/types.js";
import type { CanvasImageReference } from "../canvas/image-dispatcher.js";
import { decodeChannelModel, modelOptionName } from "../canvas/model-workflow.js";

type DirectVideoInput = {
    model: string;
    prompt: string;
    references?: CanvasImageReference[];
    size?: string;
    seconds?: string;
    resolution?: string;
    channelId?: string;
};

type Provider = { model: string; baseUrl: string; apiKey: string; apiFormat: string };
type VideoResponse = { id?: string; status?: string; url?: string; video_url?: string; result_url?: string; content?: { url?: string; video_url?: string } | null; error?: { message?: string } | string };

/** Backend 直连的视频 provider；任务、远端 taskId、媒体归档和恢复均不依赖浏览器。 */
export class DirectVideoBackend {
    private readonly controllers = new Map<string, AbortController>();
    private readonly resuming = new Set<string>();

    constructor(private readonly config: ResolvedConfig, private readonly settings: SettingStore, private readonly tasks: TaskStore, private readonly media: MediaStore) {}

    run(input: DirectVideoInput, clientTaskId?: string, taskParams: Record<string, unknown> = {}) {
        const existing = clientTaskId ? this.tasks.get(clientTaskId) : null;
        if (existing) {
            if (["queued", "running"].includes(existing.status) && !this.controllers.has(existing.id)) this.start(existing);
            return existing;
        }
        const task = this.tasks.create(clientTaskId || `video:${modelOptionName(input.model)}`, "direct-video", stripInput(input), {
            model: modelOptionName(input.model),
            channelId: input.channelId || decodeChannelModel(input.model)?.channelId,
            size: input.size || "1280x720",
            seconds: input.seconds || "6",
            resolution: input.resolution || "720p",
            ...taskParams,
        });
        this.start(task);
        return task;
    }

    resume(id: string) {
        const task = this.tasks.get(id);
        if (!task || task.kind !== "direct-video" || !["queued", "running"].includes(task.status) || this.controllers.has(id) || this.resuming.has(id)) return;
        this.resuming.add(id);
        this.start(task);
    }

    retry(task: RuntimeTask) {
        if (task.kind !== "direct-video") throw new Error(`任务类型 ${task.kind} 不是直连视频任务`);
        return this.run(task.input as DirectVideoInput, `direct-video-retry-${crypto.randomUUID()}`, task.params);
    }

    cancel(id: string) {
        this.controllers.get(id)?.abort();
        this.controllers.delete(id);
        const task = this.tasks.get(id);
        if (!task || !["queued", "running"].includes(task.status)) throw new Error(`任务状态 ${task?.status || "unknown"} 不可取消`);
        return this.tasks.cancel(id);
    }

    private start(task: RuntimeTask) {
        const controller = new AbortController();
        this.controllers.set(task.id, controller);
        void this.execute(task, controller.signal).catch((error) => this.fail(task.id, error)).finally(() => {
            this.controllers.delete(task.id);
            this.resuming.delete(task.id);
        });
    }

    private async execute(task: RuntimeTask, signal: AbortSignal) {
        const input = task.input as DirectVideoInput;
        const provider = this.provider(input, task.params);
        this.update(task.id, { status: "running", progress: 0.05 });
        const submitted = [...this.tasks.events(task.id)].reverse().find((event) => event.type === "submitted");
        let remoteId = String(submitted?.payload?.taskId || "").trim();
        if (!remoteId) {
            const form = new FormData();
            form.set("model", provider.model);
            form.set("prompt", String(input.prompt || ""));
            form.set("seconds", String(task.params.seconds || "6"));
            form.set("size", String(task.params.size || "1280x720"));
            form.set("resolution_name", String(task.params.resolution || "720p"));
            form.set("preset", "normal");
            for (const reference of input.references || []) {
                const data = await this.referenceData(reference, signal);
                form.append("input_reference[]", new Blob([data.buffer as unknown as BlobPart], { type: data.mimeType }), reference.name || "reference.png");
            }
            const response = await fetch(`${apiBase(provider.baseUrl)}/videos`, { method: "POST", headers: { Authorization: `Bearer ${provider.apiKey}` }, body: form, signal });
            const payload = await json<VideoResponse>(response);
            if (!response.ok) throw new Error(`视频任务创建失败（HTTP ${response.status}）：${apiError(payload)}`);
            remoteId = String(payload.id || "").trim();
            if (!remoteId) throw new Error("视频 provider 没有返回任务 ID");
            this.tasks.addEvent(task.id, "submitted", { taskId: remoteId, provider: "openai" });
        }
        await this.poll(task, provider, remoteId, signal);
    }

    private async poll(task: RuntimeTask, provider: Provider, remoteId: string, signal: AbortSignal) {
        for (;;) {
            await delay(2500, signal);
            const response = await fetch(`${apiBase(provider.baseUrl)}/videos/${encodeURIComponent(remoteId)}`, { headers: { Authorization: `Bearer ${provider.apiKey}` }, signal });
            const payload = await json<VideoResponse>(response);
            if (!response.ok) throw new Error(`视频任务查询失败（HTTP ${response.status}）：${apiError(payload)}`);
            const status = String(payload.status || "").toLowerCase();
            const url = [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find((value) => typeof value === "string" && value) as string | undefined;
            if (url || ["completed", "succeeded", "success"].includes(status)) {
                const stored = await this.downloadResult(url || `${apiBase(provider.baseUrl)}/videos/${encodeURIComponent(remoteId)}/content`, provider.apiKey, signal, task.id);
                const result = { media: [stored], remoteTaskId: remoteId };
                this.update(task.id, { status: "succeeded", progress: 1, result });
                this.tasks.addEvent(task.id, "result", result);
                return;
            }
            if (["failed", "cancelled", "canceled", "error"].includes(status)) throw new Error(`视频生成失败：${apiError(payload) || status}`);
            this.update(task.id, { progress: Math.min(0.95, Number(this.tasks.get(task.id)?.progress || 0.05) + 0.02) });
        }
    }

    private provider(input: DirectVideoInput, params: Record<string, unknown>): Provider {
        const config = recordOf(this.settings.get("ai.config"));
        const channels = arrayRecords(config.channels);
        const decoded = decodeChannelModel(input.model);
        const name = modelOptionName(input.model);
        const channel = (params.channelId || decoded?.channelId)
            ? channels.find((item) => String(item.id || "") === String(params.channelId || decoded?.channelId))
            : channels.find((item) => arrayRecords(item.models).some((model) => String(model.name || "") === name)) || channels[0];
        const declaration = arrayRecords(channel?.models).find((model) => String(model.name || "") === name);
        if (String(channel?.kind || "") === "comfyui") throw new Error("ComfyUI 视频应由本地工作流执行器处理");
        if (String(declaration?.script || "").trim()) throw new Error("带浏览器自定义脚本的视频模型暂不支持 Backend 无头执行，请改用标准 API 渠道");
        const baseUrl = String(channel?.baseUrl || config.baseUrl || "").trim();
        const apiKey = String(channel?.apiKey || config.apiKey || "").trim();
        const apiFormat = String(channel?.apiFormat || config.apiFormat || "openai");
        if (!baseUrl || !apiKey) throw new Error(`视频模型「${name}」缺少 Base URL 或 API Key`);
        if (apiFormat !== "openai") throw new Error(`Backend 直连视频暂不支持渠道协议：${apiFormat}`);
        return { model: name, baseUrl, apiKey, apiFormat };
    }

    private async referenceData(reference: CanvasImageReference, signal: AbortSignal) {
        if (reference.storageKey && this.media.meta(reference.storageKey)) return { buffer: await this.media.read(reference.storageKey), mimeType: reference.mimeType || "image/png" };
        const rawUrl = String(reference.url || "");
        if (!rawUrl) throw new Error(`视频参考图不存在：${reference.name || reference.id || "unknown"}`);
        const response = await fetch(rawUrl.startsWith("/") ? `${this.config.url}${rawUrl}` : rawUrl, { signal });
        if (!response.ok) throw new Error(`读取视频参考图失败（HTTP ${response.status}）`);
        return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: reference.mimeType || response.headers.get("content-type") || "image/png" };
    }

    private async downloadResult(url: string, authKey: string, signal: AbortSignal, taskId: string) {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${authKey}` }, signal });
        if (!response.ok) throw new Error(`读取视频成品失败（HTTP ${response.status}）`);
        const mimeType = response.headers.get("content-type")?.split(";", 1)[0] || "video/mp4";
        const stored = this.media.store(Buffer.from(await response.arrayBuffer()), { name: `video-${taskId}.mp4`, mimeType, category: "output" });
        return { url: this.media.url(stored), storageKey: stored.storageKey, mimeType: stored.mimeType, bytes: stored.bytes };
    }

    private update(id: string, patch: Parameters<TaskStore["update"]>[1]) { return this.tasks.update(id, patch); }
    private fail(id: string, error: unknown) { if (this.tasks.get(id)?.status === "cancelled") return; const message = error instanceof Error ? error.message : String(error); this.update(id, { status: "failed", error: message }); this.tasks.addEvent(id, "error", { error: message }); }
}

function stripInput(input: DirectVideoInput): DirectVideoInput { return { ...input, references: input.references?.map(({ dataUrl: _dataUrl, ...reference }) => reference) }; }
function apiBase(value: string) { return value.replace(/\/+$/, "").replace(/\/v1$/i, "") + "/v1"; }
async function json<T>(response: Response) { return await response.json().catch(() => ({})) as T; }
function apiError(payload: VideoResponse) { return typeof payload.error === "string" ? payload.error : payload.error?.message || "未知错误"; }
function recordOf(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function arrayRecords(value: unknown): Array<Record<string, any>> { return Array.isArray(value) ? value.filter((item): item is Record<string, any> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function delay(ms: number, signal: AbortSignal) { return new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("任务已取消")); }, { once: true }); }); }
