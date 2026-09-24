import crypto from "node:crypto";

import type { ResolvedConfig } from "../config.js";
import type { RuntimeTask } from "../db.js";
import type { MediaStore, SettingStore, TaskStore } from "../stores/types.js";
import { decodeChannelModel, modelOptionName } from "../canvas/model-workflow.js";

export type DirectAudioInput = {
    model: string;
    prompt: string;
    channelId?: string;
    voice?: string;
    format?: string;
    speed?: string;
    instructions?: string;
};

type Provider = { model: string; baseUrl: string; apiKey: string };

/** Backend 直连标准 OpenAI-compatible TTS；浏览器只观察任务，不持有音频 Blob。 */
export class DirectAudioBackend {
    private readonly controllers = new Map<string, AbortController>();

    constructor(private readonly config: ResolvedConfig, private readonly settings: SettingStore, private readonly tasks: TaskStore, private readonly media: MediaStore) {}

    run(input: DirectAudioInput, clientTaskId?: string, taskParams: Record<string, unknown> = {}) {
        const existing = clientTaskId ? this.tasks.get(clientTaskId) : null;
        if (existing) {
            if (["queued", "running"].includes(existing.status) && !this.controllers.has(existing.id)) this.start(existing);
            return existing;
        }
        const task = this.tasks.create(clientTaskId || `audio:${modelOptionName(input.model)}`, "direct-audio", stripInput(input), {
            model: modelOptionName(input.model),
            channelId: input.channelId || decodeChannelModel(input.model)?.channelId,
            ...taskParams,
        });
        this.start(task);
        return task;
    }

    resume(id: string) {
        const task = this.tasks.get(id);
        if (!task || task.kind !== "direct-audio" || !["queued", "running"].includes(task.status) || this.controllers.has(id)) return;
        this.start(task);
    }

    retry(task: RuntimeTask) {
        if (task.kind !== "direct-audio") throw new Error(`任务类型 ${task.kind} 不是直连音频任务`);
        return this.run(task.input as DirectAudioInput, `direct-audio-retry-${crypto.randomUUID()}`, task.params);
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
        void this.execute(task, controller.signal).catch((error) => this.fail(task.id, error)).finally(() => this.controllers.delete(task.id));
    }

    private async execute(task: RuntimeTask, signal: AbortSignal) {
        const input = task.input as DirectAudioInput;
        const provider = this.provider(input, task.params);
        this.update(task.id, { status: "running", progress: 0.1 });
        const payload = {
            model: provider.model,
            input: input.prompt,
            voice: String(input.voice || task.params.voice || "alloy"),
            response_format: String(input.format || task.params.format || "mp3"),
            speed: Number(input.speed || task.params.speed || "1"),
            ...(String(input.instructions || task.params.instructions || "").trim() ? { instructions: String(input.instructions || task.params.instructions).trim() } : {}),
        };
        const response = await fetch(`${apiBase(provider.baseUrl)}/audio/speech`, {
            method: "POST",
            headers: { Authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal,
        });
        if (!response.ok) throw new Error(`音频生成失败（HTTP ${response.status}）：${await response.text()}`);
        const mimeType = response.headers.get("content-type")?.split(";", 1)[0] || mimeForFormat(payload.response_format);
        const stored = this.media.store(Buffer.from(await response.arrayBuffer()), { name: `audio-${task.id}${extensionForFormat(payload.response_format)}`, mimeType, category: "output" });
        const result = { media: [{ url: this.media.url(stored), storageKey: stored.storageKey, mimeType: stored.mimeType, bytes: stored.bytes }], format: payload.response_format };
        this.update(task.id, { status: "succeeded", progress: 1, result });
        this.tasks.addEvent(task.id, "result", result);
    }

    private provider(input: DirectAudioInput, params: Record<string, unknown>): Provider {
        const config = recordOf(this.settings.get("ai.config"));
        const channels = arrayRecords(config.channels);
        const decoded = decodeChannelModel(input.model);
        const name = modelOptionName(input.model);
        const channel = (params.channelId || decoded?.channelId)
            ? channels.find((item) => String(item.id || "") === String(params.channelId || decoded?.channelId))
            : channels.find((item) => arrayRecords(item.models).some((model) => String(model.name || "") === name)) || channels[0];
        const declaration = arrayRecords(channel?.models).find((model) => String(model.name || "") === name);
        if (String(channel?.kind || "") === "comfyui") throw new Error("ComfyUI 音频应由本地工作流执行器处理");
        if (String(declaration?.script || "").trim()) throw new Error("带浏览器自定义脚本的音频模型暂不支持 Backend 无头执行，请改用标准 API 渠道");
        const baseUrl = String(channel?.baseUrl || config.baseUrl || "").trim();
        const apiKey = String(channel?.apiKey || config.apiKey || "").trim();
        const apiFormat = String(channel?.apiFormat || config.apiFormat || "openai");
        if (!baseUrl || !apiKey) throw new Error(`音频模型「${name}」缺少 Base URL 或 API Key`);
        if (apiFormat !== "openai") throw new Error(`Backend 直连音频暂不支持渠道协议：${apiFormat}`);
        return { model: name, baseUrl, apiKey };
    }

    private update(id: string, patch: Parameters<TaskStore["update"]>[1]) { return this.tasks.update(id, patch); }
    private fail(id: string, error: unknown) { if (this.tasks.get(id)?.status === "cancelled") return; const message = error instanceof Error ? error.message : String(error); this.update(id, { status: "failed", error: message }); this.tasks.addEvent(id, "error", { error: message }); }
}

function stripInput(input: DirectAudioInput): DirectAudioInput { return { ...input }; }
function apiBase(value: string) { return value.replace(/\/+$/, "").replace(/\/v1$/i, "") + "/v1"; }
function mimeForFormat(format: string) { return ({ mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", aac: "audio/aac", flac: "audio/flac" } as Record<string, string>)[format] || "audio/mpeg"; }
function extensionForFormat(format: string) { return ({ mp3: ".mp3", wav: ".wav", ogg: ".ogg", opus: ".opus", aac: ".aac", flac: ".flac" } as Record<string, string>)[format] || ".mp3"; }
function recordOf(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function arrayRecords(value: unknown): Array<Record<string, any>> { return Array.isArray(value) ? value.filter((item): item is Record<string, any> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
