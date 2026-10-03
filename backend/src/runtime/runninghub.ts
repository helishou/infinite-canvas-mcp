import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import WebSocket from "ws";
import { runningHubConfigPatchSchema, runningHubWorkflowProfileSchema, type RunningHubField, type RunningHubConfig, type RunningHubWorkflowProfile } from "@basketikun/canvas-agent/generation-contract";
import type { RuntimeTask } from "../db.js";
import type { MediaStore, SettingStore, TaskStore } from "../stores/types.js";
import type { BackendEventBus } from "../events.js";
import { H3ExecutionQueue, h3CanResumeQueued, h3LocalOnlyReason } from "./h3-queue.js";

export type { RunningHubField, RunningHubConfig } from "@basketikun/canvas-agent/generation-contract";
export type { RunningHubWorkflowProfile } from "@basketikun/canvas-agent/generation-contract";
type Json = Record<string, any>;
type RunConfig = RunningHubConfig & { remoteId?: string };
const DEFAULT_URL = "https://www.runninghub.ai";
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export class RunningHubBackend {
    private readonly controllers = new Map<string, AbortController>();
    private readonly runs = new Map<string, RunConfig>();
    private readonly cancellations = new Map<string, Promise<void>>();
    readonly queue: H3ExecutionQueue;

    constructor(private readonly tasks: TaskStore, private readonly settings: SettingStore, private readonly events?: BackendEventBus, private readonly media?: MediaStore, private readonly onTaskTerminal?: (task: RuntimeTask) => void | Promise<void>, queue?: H3ExecutionQueue) {
        this.queue = queue || new H3ExecutionQueue(tasks, settings);
    }
    getConfig(): RunningHubConfig {
        const stored = record(this.settings.get("runninghub.config"));
        const instanceType = stored.instanceType === "plus" || stored.instanceType === "ultra" ? stored.instanceType : "default";
        return { ...stored, baseUrl: normalizeUrl(String(stored.baseUrl || DEFAULT_URL)), apiKey: String(stored.apiKey || ""), walletApiKey: String(stored.walletApiKey || ""), mode: stored.mode === "app" ? "app" : "workflow", workflowId: String(stored.workflowId || ""), appId: String(stored.appId || ""), fields: Array.isArray(stored.fields) ? stored.fields : [], useWallet: stored.useWallet === true, instanceType, concurrency: validConcurrency(stored.concurrency ?? 1) };
    }
    setConfig(patch: Partial<RunningHubConfig>) {
        patch = runningHubConfigPatchSchema.parse(patch);
        const current = this.getConfig();
        if (patch.apiKey === "********") patch = { ...patch, apiKey: current.apiKey };
        if (patch.walletApiKey === "********") patch = { ...patch, walletApiKey: current.walletApiKey };
        const next = { ...current, ...patch, baseUrl: normalizeUrl(String(patch.baseUrl ?? current.baseUrl)), concurrency: validConcurrency(patch.concurrency ?? current.concurrency) };
        if (!["workflow", "app"].includes(next.mode)) throw new Error("RunningHub 调用类型无效");
        if (!["default", "plus", "ultra"].includes(next.instanceType || "default")) throw new Error("RunningHub 运行实例类型无效");
        if (!Array.isArray(next.fields)) throw new Error("RunningHub 输入映射必须为数组");
        validateFields(next.fields);
        this.settings.set("runninghub.config", next);
        this.queue.refresh();
        return next;
    }
    status(params: Record<string, unknown> = {}) {
        const config = this.runConfig(params);
        return { configured: this.ready(params), url: config.baseUrl, mode: config.mode, hasApiKey: Boolean(keyFor(config)), workflowId: config.workflowId || "", appId: config.appId || "", concurrency: config.concurrency, queue: this.queue.status() };
    }
    ready(params: Record<string, unknown> = {}) {
        const config = this.runConfig(params);
        return Boolean(keyFor(config) && (config.mode === "app" ? config.appId : config.workflowId) && config.fields?.some((field) => field.enabled !== false));
    }
    async inspectWorkflow(workflowId?: string) {
        const config = this.getConfig();
        const id = String(workflowId || config.workflowId || "").trim();
        if (!keyFor(config) || !id) throw new Error("请先设置 RunningHub API Key 和工作流 ID");
        const graph = await this.fetchWorkflow({ ...config, workflowId: id }, new AbortController().signal);
        return { workflowId: id, workflowJson: graph, fields: discoverRunningHubFields(graph) };
    }
    listWorkflowProfiles() {
        const stored = this.settings.get("runninghub.workflows");
        return (Array.isArray(stored) ? stored : []).flatMap((value) => {
            const parsed = runningHubWorkflowProfileSchema.safeParse(value);
            return parsed.success ? [parsed.data] : [];
        });
    }
    saveWorkflowProfile(value: unknown) {
        const profile = runningHubWorkflowProfileSchema.parse(value);
        validateFields(profile.fields);
        const current = this.listWorkflowProfiles();
        const previous = current.find((item) => item.id === profile.id);
        const now = new Date().toISOString();
        const saved: RunningHubWorkflowProfile = { ...profile, createdAt: previous?.createdAt || profile.createdAt || now, updatedAt: now };
        this.settings.set("runninghub.workflows", [saved, ...current.filter((item) => item.id !== saved.id)]);
        return saved;
    }
    removeWorkflowProfile(id: string) {
        const current = this.listWorkflowProfiles();
        this.settings.set("runninghub.workflows", current.filter((item) => item.id !== id));
        return current.length - this.listWorkflowProfiles().length;
    }
    listWorkflowTasks(profileId: string) {
        const profile = this.listWorkflowProfiles().find((item) => item.id === profileId);
        if (!profile) throw new Error("RunningHub 工作流配置不存在");
        return this.tasks.list({ kind: "runninghub:workflow", model: `runninghub-workflow:${profile.id}`, limit: 50 });
    }
    async run(input: Record<string, unknown>, params: Record<string, unknown>, clientTaskId?: string, onCreated?: (task: RuntimeTask) => void | Promise<void>) {
        const existing = clientTaskId ? this.tasks.get(clientTaskId) : null;
        if (existing) return existing;
        const reason = h3LocalOnlyReason(params);
        if (reason) throw new Error(reason);
        if (!this.ready(params)) throw new Error("RunningHub 未配置 API Key、工作流 ID 或输入映射");
        return this.startTask("runninghub:minimax-h3", input, params, clientTaskId, true, onCreated);
    }
    async runWorkflow(profileId: string, input: Record<string, unknown>, values: Record<string, unknown>, overrides: Record<string, unknown> = {}, clientTaskId?: string) {
        const profile = this.listWorkflowProfiles().find((item) => item.id === profileId);
        if (!profile) throw new Error("RunningHub 工作流配置不存在，请重新添加");
        if (!keyFor(this.getConfig())) throw new Error("请先在 ComfyUI → 运行环境配置 RunningHub API Key");
        const params = {
            runninghubMode: "workflow", runninghubWorkflowId: profile.workflowId, runninghubFields: profile.fields,
            ...overrides, runninghubParams: values, runninghubInstanceType: profile.instanceType || "default",
            runninghubProfileId: profile.id, model: `runninghub-workflow:${profile.id}`,
        };
        return this.startTask("runninghub:workflow", input, params, clientTaskId, false);
    }
    private async startTask(kind: string, input: Record<string, unknown>, params: Record<string, unknown>, clientTaskId?: string, requireMappedFields = true, onCreated?: (task: RuntimeTask) => void | Promise<void>) {
        const existing = clientTaskId ? this.tasks.get(clientTaskId) : null;
        if (existing) return existing;
        const config = this.runConfig(params);
        if (!keyFor(config) || !config.workflowId || requireMappedFields && !config.fields?.some((field) => field.enabled !== false)) throw new Error("RunningHub 未配置 API Key、工作流 ID 或有效输入");
        const task = clientTaskId ? this.tasks.create(clientTaskId, kind, input, params) : this.tasks.create(kind, input, params);
        await onCreated?.(task);
        this.enqueue(task, config);
        return task;
    }
    resume(id: string) {
        const task = this.tasks.get(id);
        if (!task || !task.kind.startsWith("runninghub:") || !["queued", "running"].includes(task.status) || this.controllers.has(id)) return;
        const submitted = [...this.tasks.events(id)].reverse().find((event) => event.type === "submitted");
        if (!submitted?.payload.taskId) {
            if (task.status === "queued" && h3CanResumeQueued(this.tasks, id)) {
                const queued = this.tasks.events(id).find((event) => event.type === "h3_queued");
                this.enqueue(task, { ...this.runConfig(task.params), ...record(queued?.payload.config) });
            } else this.fail(id, new Error("RunningHub 提交状态不明，拒绝重复提交；请核对平台任务后手动重试"));
            return;
        }
        const config = { ...this.runConfig(task.params), ...record(submitted.payload.config), remoteId: String(submitted.payload.taskId) };
        if (!keyFor(config) || submitted.payload.credentialFingerprint && fingerprint(keyFor(config)) !== submitted.payload.credentialFingerprint) {
            this.fail(id, new Error("RunningHub API Key 已变更，无法恢复原账号任务；未重复提交"));
            return;
        }
        this.observe(task, config, true);
    }
    cancel(id: string) {
        const current = this.tasks.get(id);
        if (!current) throw new Error("RunningHub 任务不存在");
        if (TERMINAL.has(current.status)) return current;
        const submitted = [...this.tasks.events(id)].reverse().find((event) => event.type === "submitted");
        const config = this.runs.get(id) || { ...this.runConfig(current.params), ...record(submitted?.payload.config), remoteId: String(submitted?.payload.taskId || "") };
        if (config.remoteId) this.cancellations.set(id, this.cancelRemote(id, config));
        this.controllers.get(id)?.abort();
        const task = this.tasks.cancel(id);
        this.queue.cancel(id);
        this.events?.publish({ type: "task.updated", entityId: id, payload: task });
        if (task.kind === "runninghub:minimax-h3") void this.onTaskTerminal?.(task);
        return task;
    }
    private enqueue(task: RuntimeTask, config: RunConfig) {
        const queued = this.tasks.events(task.id).find((event) => event.type === "h3_queued");
        if (queued?.payload.credentialFingerprint && queued.payload.credentialFingerprint !== fingerprint(keyFor(config))) {
            this.fail(task.id, new Error("RunningHub 排队期间 API Key 已变更，任务未提交"));
            return;
        }
        this.queue.enqueue(task, "runninghub", () => this.observe(task, config, false), { config: publicRunConfig(config), credentialFingerprint: fingerprint(keyFor(config)) });
    }
    private observe(task: RuntimeTask, config: RunConfig, recovered: boolean): Promise<void> {
        const controller = new AbortController();
        this.controllers.set(task.id, controller);
        this.runs.set(task.id, config);
        const work = async () => {
            let closeWs = () => {};
            try {
                if (this.tasks.get(task.id)?.status === "cancelled") return;
                if (!recovered) {
                    this.update(task.id, { status: "running", progress: 0.02 });
                    const graph = config.mode === "workflow" ? await this.fetchWorkflow(config, controller.signal) : undefined;
                    const fields = await this.resolveFields(task, config, controller.signal);
                    const body: Json = { apiKey: keyFor(config), instanceType: config.instanceType || "default", addMetadata: true };
                    if (config.mode === "workflow") {
                        body.workflowId = config.workflowId;
                        body.workflow = JSON.stringify(patchRunningHubWorkflow(graph!, fields));
                    } else { body.webappId = config.appId; body.nodeInfoList = fields; }
                    this.tasks.addEvent(task.id, "actual_submission", { workflowId: config.workflowId, mode: config.mode, fields: fields.map((field) => ({ ...field, fieldValue: typeof field.fieldValue === "string" && /^https?:/.test(field.fieldValue) ? "[uploaded media]" : field.fieldValue })) });
                    // 提交请求发出后等待响应以保存远端身份；用户取消后仍会按 taskId 撤销。
                    const response = await this.request(config, config.mode === "workflow" ? "/task/openapi/create" : "/task/openapi/ai-app/run", body, new AbortController().signal);
                    const data = record(response.data || response);
                    config.remoteId = String(data.taskId || "");
                    if (!config.remoteId) throw new Error("RunningHub 未返回 taskId，提交状态不明；请核对平台任务");
                    this.tasks.addEvent(task.id, "submitted", { taskId: config.remoteId, backend: "runninghub", mode: config.mode, config: publicRunConfig(config), credentialFingerprint: fingerprint(keyFor(config)) });
                    if (controller.signal.aborted || this.tasks.get(task.id)?.status === "cancelled") {
                        this.cancellations.set(task.id, this.cancelRemote(task.id, config));
                        return;
                    }
                    if (data.netWssUrl) closeWs = this.listen(task.id, String(data.netWssUrl), controller.signal);
                }
                await this.poll(task, config, controller.signal);
            } catch (error) { this.fail(task.id, error); }
            finally {
                closeWs();
                await this.cancellations.get(task.id);
                this.cancellations.delete(task.id);
                this.controllers.delete(task.id);
                this.runs.delete(task.id);
            }
        };
        if (recovered) { this.queue.recover(task, "runninghub", work); return Promise.resolve(); }
        return work();
    }
    private async fetchWorkflow(config: RunConfig, signal: AbortSignal): Promise<Json> {
        const response = await this.request(config, "/api/openapi/getJsonApiFormat", { apiKey: keyFor(config), workflowId: config.workflowId }, signal);
        const prompt = record(response.data).prompt;
        const graph = typeof prompt === "string" ? JSON.parse(prompt) : prompt;
        if (!graph || typeof graph !== "object" || Array.isArray(graph) || !Object.values(graph).some((node) => record(node).class_type)) throw new Error("RunningHub 返回的工作流不是 API 格式");
        return graph;
    }
    private async resolveFields(task: RuntimeTask, config: RunConfig, signal: AbortSignal) {
        const configured = record(task.params.runninghubParams);
        const media = { image: Array.isArray(task.input.references) ? task.input.references.map(String) : [], video: Array.isArray(task.input.videos) ? task.input.videos.map(String) : task.input.video ? [String(task.input.video)] : [], audio: Array.isArray(task.input.audios) ? task.input.audios.map(String) : [] };
        const used = { image: new Set<number>(), video: new Set<number>(), audio: new Set<number>() };
        const cursors = { image: 0, video: 0, audio: 0 };
        const uploaded = new Map<string, Promise<string>>();
        const values: Array<{ nodeId: string; fieldName: string; fieldValue: unknown }> = [];
        let hasPrompt = false;
        const fields = config.fields || [];
        validateFields(fields);
        for (const field of fields.filter((item) => item.enabled !== false)) {
            const source = fieldSource(field);
            const key = field.id || `${field.nodeId}::${field.fieldName}`;
            let value = Object.hasOwn(configured, key) ? configured[key] : task.params[key] ?? field.fieldValue ?? "";
            if (source === "prompt") { value = String(task.input.prompt ?? ""); hasPrompt = true; }
            else if (source === "param") {
                value = task.params[field.paramKey || ""];
                if (value === undefined) throw new Error(`H3 参数 ${field.paramKey || "(未指定)"} 没有值，请调整 RunningHub 映射`);
            } else if (source === "image" || source === "video" || source === "audio") {
                const index = field.index === undefined ? cursors[source]++ : field.index - 1;
                const file = media[source][index];
                if (!file) {
                    if (field.required) throw new Error(`RunningHub 参数「${field.label || field.fieldName}」缺少${source}素材 ${index + 1}`);
                    value = "";
                } else {
                    used[source].add(index);
                    if (!uploaded.has(file)) uploaded.set(file, this.upload(file, config, signal));
                    value = await uploaded.get(file);
                }
            } else if (source === "constant" && field.fieldType === "number" && String(value).trim() !== "" && Number.isFinite(Number(value))) {
                value = Number(value);
            } else if (source === "constant" && field.fieldType === "boolean") {
                value = value === true || String(value).toLowerCase() === "true";
            }
            if (field.required && (value === "" || value === undefined || value === null)) throw new Error(`RunningHub 参数「${field.label || field.fieldName}」不能为空`);
            values.push({ nodeId: String(field.nodeId), fieldName: field.fieldName, fieldValue: value });
        }
        if (task.input.prompt && !hasPrompt) throw new Error("RunningHub 工作流没有启用 H3 提示词映射");
        for (const kind of ["image", "video", "audio"] as const) if (used[kind].size !== media[kind].length) throw new Error(`RunningHub ${kind}输入映射未覆盖本轮全部 ${media[kind].length} 个参考素材`);
        return values;
    }
    private async upload(file: string, config: RunConfig, signal: AbortSignal) {
        let bytes: Buffer;
        let name = path.basename(file);
        if (/^https?:\/\//.test(file)) {
            const response = await fetch(file, { signal });
            if (!response.ok) throw new Error(`读取参考素材失败：HTTP ${response.status}`);
            bytes = Buffer.from(await response.arrayBuffer()); name = path.basename(new URL(file).pathname);
        } else if (/^\/media\//.test(file) && this.media) {
            const key = decodeURIComponent(file.split("/")[2]); bytes = await this.media.read(key); name = path.basename(this.media.meta(key)?.filePath || name);
        } else bytes = await readFile(file);
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(bytes)]), name || "reference.bin");
        const response = await fetch(`${config.baseUrl}/openapi/v2/media/upload/binary`, { method: "POST", body: form, signal, headers: { Authorization: `Bearer ${keyFor(config)}` } });
        const body = await response.json().catch(() => ({})) as Json;
        checkResponse(response, body, config);
        const result = String(record(body.data).fileName || "");
        if (!result) throw new Error("RunningHub 上传成功但没有返回 fileName");
        return result;
    }
    private async poll(task: RuntimeTask, config: RunConfig, signal: AbortSignal) {
        let lastStatus = "";
        for (;;) {
            if (signal.aborted || this.tasks.get(task.id)?.status === "cancelled") return;
            const response = await this.request(config, "/openapi/v2/query", { apiKey: keyFor(config), taskId: config.remoteId }, signal);
            const data = normalizeRunningHubQuery(response);
            if (data.status !== lastStatus) { this.tasks.addEvent(task.id, "remote_status", { taskId: config.remoteId, status: data.status }); lastStatus = data.status; }
            if (["SUCCESS", "SUCCEEDED", "SUCCEED", "COMPLETED", "FINISHED"].includes(data.status)) {
                const media = await this.materialize(data.results, signal);
                const texts = data.results.flatMap((item) => typeof item.text === "string" ? [{ nodeId: String(item.nodeId || ""), content: item.text }] : []);
                if (task.kind === "runninghub:minimax-h3" && !media.some((item) => item.mimeType.startsWith("video/"))) throw new Error("RunningHub H3 任务完成但没有可归档的视频");
                if (task.kind === "runninghub:workflow" && !media.length && !texts.length) throw new Error("RunningHub 工作流完成但没有可归档的媒体或文本结果");
                if (signal.aborted || this.tasks.get(task.id)?.status === "cancelled") return;
                const result = { media, ...(texts.length ? { texts } : {}), taskId: config.remoteId, backend: "runninghub", mode: config.mode };
                this.tasks.addEvent(task.id, "result", result);
                this.update(task.id, { status: "succeeded", progress: 1, result });
                return;
            }
            if (["FAILED", "FAIL", "ERROR", "CANCELLED", "CANCELED"].includes(data.status)) throw new Error(redact(data.error || `RunningHub 任务${data.status}`, config));
            if (!["QUEUED", "RUNNING", "PENDING"].includes(data.status)) throw new Error(`RunningHub 返回未知任务状态：${data.status || "空"}`);
            await delay(2500, signal);
        }
    }
    private listen(id: string, url: string, signal: AbortSignal) {
        let socket: WebSocket;
        try { socket = new WebSocket(url); } catch { return () => {}; }
        const close = () => { socket.removeAllListeners(); socket.on("error", () => {}); socket.terminate(); signal.removeEventListener("abort", close); };
        signal.addEventListener("abort", close, { once: true });
        socket.on("error", () => { this.tasks.addEvent(id, "progress_channel_unavailable", { fallback: "poll" }); });
        socket.on("message", (raw) => {
            if (signal.aborted || this.tasks.get(id)?.status !== "running") return;
            try {
                const message = JSON.parse(String(raw));
                if (message.type !== "progress") return;
                const value = Number(message.data?.value); const max = Number(message.data?.max);
                if (Number.isFinite(value) && Number.isFinite(max) && max > 0) this.update(id, { progress: Math.max(this.tasks.get(id)?.progress || 0, Math.min(0.95, value / max * 0.9 + 0.05)) });
            } catch {}
        });
        return close;
    }
    private async materialize(items: Json[], signal: AbortSignal) {
        if (!this.media) throw new Error("RunningHub 媒体归档服务不可用");
        const outputs: Array<{ url: string; storageKey: string; mimeType: string; filename: string; bytes: number }> = [];
        const seen = new Set<string>();
        for (const item of items) {
            const source = String(item.url || item.fileUrl || item.downloadUrl || "");
            if (!source) continue;
            const parsed = new URL(source);
            if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("RunningHub 结果地址协议无效");
            const response = await fetch(source, { signal });
            if (!response.ok) throw new Error(`RunningHub 结果下载失败：HTTP ${response.status}`);
            const bytes = Buffer.from(await response.arrayBuffer());
            const name = path.basename(parsed.pathname) || `runninghub-${item.nodeId || "output"}.${item.outputType || item.fileType || "mp4"}`;
            const mimeType = runningHubMediaType(bytes, response.headers.get("content-type") || "", name);
            const hash = fingerprint(bytes);
            if (seen.has(hash)) continue;
            seen.add(hash);
            const media = this.media.store(bytes, { name, mimeType, category: "output" });
            outputs.push({ url: this.media.url(media), storageKey: media.storageKey, mimeType: media.mimeType, filename: name, bytes: bytes.length });
        }
        return outputs;
    }
    private async cancelRemote(id: string, config: RunConfig) {
        try {
            await this.request(config, "/task/openapi/cancel", { apiKey: keyFor(config), taskId: config.remoteId }, new AbortController().signal);
            this.tasks.addEvent(id, "remote_cancelled", { taskId: config.remoteId });
        } catch (error) {
            this.tasks.addEvent(id, "remote_cancel_failed", { taskId: config.remoteId, error: redact(error instanceof Error ? error.message : String(error), config) });
        }
    }
    private runConfig(params: Record<string, unknown>): RunConfig {
        const config = this.getConfig();
        return { ...config, mode: params.runninghubMode === "app" ? "app" : params.runninghubMode === "workflow" ? "workflow" : config.mode, workflowId: String(params.runninghubWorkflowId || config.workflowId || ""), appId: String(params.runninghubAppId || config.appId || ""), fields: Array.isArray(params.runninghubFields) ? params.runninghubFields as RunningHubField[] : config.fields, instanceType: params.runninghubInstanceType === "plus" || params.runninghubInstanceType === "ultra" ? params.runninghubInstanceType : params.runninghubInstanceType === "default" ? "default" : config.instanceType, useWallet: params.useWallet === undefined ? config.useWallet : params.useWallet === true };
    }
    private async request(config: RunConfig, endpoint: string, body: Json, signal: AbortSignal) {
        const response = await fetch(`${config.baseUrl}${endpoint}`, { method: "POST", headers: { "content-type": "application/json", Accept: "application/json", Authorization: `Bearer ${keyFor(config)}` }, body: JSON.stringify(body), signal });
        const raw = await response.json().catch(() => ({})) as Json;
        checkResponse(response, raw, config);
        return raw;
    }
    private update(id: string, patch: Parameters<TaskStore["update"]>[1]) {
        const task = this.tasks.update(id, patch);
        this.events?.publish({ type: task.status === "succeeded" ? "task.completed" : task.status === "failed" ? "task.failed" : "task.updated", entityId: id, payload: task });
        if (TERMINAL.has(task.status) && task.kind === "runninghub:minimax-h3") void this.onTaskTerminal?.(task);
        return task;
    }
    private fail(id: string, error: unknown) {
        if (this.tasks.get(id)?.status === "cancelled") return;
        const message = redact(error instanceof Error ? error.message : String(error), this.runs.get(id) || this.getConfig());
        this.tasks.addEvent(id, "error", { error: message });
        this.update(id, { status: "failed", error: message });
    }
}

function record(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function keyFor(config: RunningHubConfig) { return String(config.useWallet ? config.walletApiKey || "" : config.apiKey || ""); }
function fingerprint(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function publicRunConfig(config: RunConfig) { return { baseUrl: config.baseUrl, mode: config.mode, workflowId: config.workflowId, appId: config.appId, fields: config.fields, useWallet: config.useWallet, instanceType: config.instanceType }; }
function validConcurrency(value: unknown) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("RunningHub 并发数必须为正整数"); return parsed; }
function normalizeUrl(value: string) { const url = new URL(value.trim() || DEFAULT_URL); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("RunningHub 地址必须是无凭据的 HTTP/HTTPS 地址"); return url.toString().replace(/\/$/, ""); }
function redact(value: string, config: RunningHubConfig) {
    let result = value;
    for (const key of [config.apiKey, config.walletApiKey]) if (key) result = result.split(key).join("[redacted]");
    return result.replace(/(?:wss?:\/\/)[^\s"<>]+/gi, "[RunningHub WebSocket]").replace(/(Rh-Comfy-Auth=)[^\s&"<>]+/gi, "$1[redacted]");
}
function checkResponse(response: Response, raw: Json, config: RunningHubConfig) {
    if (response.ok && (raw.code === undefined || raw.code === 0 || raw.code === "0" || raw.code === 200 || raw.code === "200") && Object.keys(raw).length) return;
    if (Number(raw.code) === 421) throw new Error("RunningHub 平台并发/队列已满（421）；其他窗口或平台任务可能占用额度，请稍后手动重试");
    throw new Error(`RunningHub 请求失败（HTTP ${response.status} / code ${String(raw.code ?? "unknown")}）：${redact(String(raw.msg || raw.message || raw.errorMessage || "响应无效"), config)}`);
}
function fieldSource(field: RunningHubField): NonNullable<RunningHubField["source"]> {
    if (field.source) return field.source;
    const type = String(field.fieldType || "").toLowerCase();
    if (["image", "video", "audio", "prompt"].includes(type)) return type as "image" | "video" | "audio" | "prompt";
    return "constant";
}
function validateFields(fields: RunningHubField[]) {
    const targets = new Set<string>();
    for (const field of fields) {
        if (field.enabled === false) continue;
        if (!field.nodeId || !field.fieldName) throw new Error("RunningHub 启用的映射必须指定节点 ID 和输入字段");
        if (field.source && !["constant", "prompt", "image", "video", "audio", "param"].includes(field.source)) throw new Error("RunningHub 映射来源无效");
        if (field.source === "param" && !field.paramKey?.trim()) throw new Error("RunningHub H3 参数映射缺少参数名");
        if (field.index !== undefined && (!Number.isSafeInteger(field.index) || field.index < 1)) throw new Error("参考素材序号必须为正整数");
        const target = `${field.nodeId}::${field.fieldName}`;
        if (targets.has(target)) throw new Error(`RunningHub 映射重复：${target}`);
        targets.add(target);
    }
}
export function discoverRunningHubFields(graph: Json): RunningHubField[] {
    return Object.entries(graph).flatMap(([nodeId, raw]) => Object.entries(record(raw).inputs || {}).map(([fieldName, fieldValue]) => {
        const node = record(raw);
        const kind = String(node.class_type || "");
        const fieldType = /LoadImage/i.test(kind) && fieldName === "image" ? "image"
            : /LoadVideo/i.test(kind) && /video|file/i.test(fieldName) ? "video"
                : /LoadAudio/i.test(kind) && /audio|file/i.test(fieldName) ? "audio"
                    : typeof fieldValue === "number" ? "number" : typeof fieldValue === "boolean" ? "boolean" : "text";
        return { id: `${nodeId}::${fieldName}`, nodeId, fieldName, fieldValue, fieldType, label: `${record(node._meta).title || kind || nodeId} · ${fieldName}`, enabled: false, source: "constant" as const };
    }));
}
export function patchRunningHubWorkflow(graph: Json, fields: Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>) {
    const next = structuredClone(graph);
    for (const field of fields) {
        const inputs = next[field.nodeId]?.inputs;
        if (!inputs || !Object.hasOwn(inputs, field.fieldName)) throw new Error(`RunningHub 工作流输入不存在：${field.nodeId}.${field.fieldName}；请重新同步映射`);
        inputs[field.fieldName] = field.fieldValue;
    }
    return next;
}
export function normalizeRunningHubQuery(response: Json) {
    const data = record(response.data || response);
    return { status: String(data.status || data.taskStatus || "").toUpperCase(), results: Array.isArray(data.results) ? data.results as Json[] : [], error: typeof data.failedReason === "string" ? data.failedReason : String(data.errorMessage || data.msg || data.message || record(data.failedReason).exception_message || "") };
}
export function runningHubMediaType(bytes: Buffer, header: string, name: string) {
    const prefix = bytes.subarray(0, 64).toString().trimStart();
    if (!bytes.length || /^(?:<!doctype|<html)/i.test(prefix) || /text\/html/i.test(header) || /application\/json/i.test(header) && !/\.json$/i.test(name)) throw new Error("RunningHub 返回了空文件或错误页面，未作为媒体归档");
    if (bytes.length > 12 && ["ftyp", "moov", "mdat", "wide"].includes(bytes.subarray(4, 8).toString())) return "video/mp4";
    if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
    if (bytes.subarray(0, 3).toString() === "GIF") return "image/gif";
    if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE") return "audio/wav";
    if (bytes.subarray(0, 3).toString() === "ID3" || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
    if (/^audio\//.test(header)) return header.split(";")[0];
    return header.split(";", 1)[0] || "application/octet-stream";
}
function delay(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("任务已取消")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
}
