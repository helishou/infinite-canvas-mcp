import { inspectH3Result } from "../canvas/h3-execution-contract.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import WebSocket from "ws";
import { runningHubConfigPatchSchema, runningHubWorkflowProfileSchema, type RunningHubField, type RunningHubConfig, type RunningHubWorkflowProfile } from "@basketikun/canvas-agent/generation-contract";
import type { RuntimeTask } from "../db.js";
import type { MediaStore, SettingStore, TaskStore } from "../stores/types.js";
import type { BackendEventBus } from "../events.js";
import { H3ExecutionQueue, h3CanResumeQueued } from "./h3-queue.js";

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
    private readonly wsDownloads = new Map<string, Set<Promise<void>>>();
    readonly queue: H3ExecutionQueue;

    constructor(private readonly tasks: TaskStore, private readonly settings: SettingStore, private readonly events?: BackendEventBus, private readonly media?: MediaStore, queue?: H3ExecutionQueue) {
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
    /** 重新读取平台当前节点图和字段；保留已保存的映射与配置，只刷新图快照和字段清单。 */
    async refreshProfileGraph(profileId: string) {
        const profile = this.listWorkflowProfiles().find((item) => item.id === profileId);
        if (!profile) throw new Error("RunningHub 工作流配置不存在");
        const inspected = await this.inspectWorkflow(profile.workflowId);
        const previous = new Map(profile.fields.map((field) => [`${field.nodeId}::${field.fieldName}`, field]));
        const fields = inspected.fields.map((field) => ({ ...field, ...previous.get(`${field.nodeId}::${field.fieldName}`) }));
        return this.saveWorkflowProfile({ ...profile, workflowJson: inspected.workflowJson, fields });
    }
    listWorkflowProfiles() {
        const stored = this.settings.get("runninghub.workflows");
        return (Array.isArray(stored) ? stored : []).flatMap((value) => {
            // 必须先降级再解析：契约为兼容老档案仍接受 source=param，
            // 直接 parse 会成功并把 param 原样放行，降级分支永远走不到。
            const parsed = runningHubWorkflowProfileSchema.safeParse(normalizeRunningHubFieldSources(value));
            // 解析失败会让整个档案静默消失（列表里看不到、也报不出原因），所以这里只能跳过。
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
    async runWorkflow(profileId: string, input: Record<string, unknown>, values: Record<string, unknown>, overrides: Record<string, unknown> = {}, clientTaskId?: string) {
        const profile = this.listWorkflowProfiles().find((item) => item.id === profileId);
        if (!profile) throw new Error("RunningHub 工作流配置不存在，请重新添加");
        if (!keyFor(this.getConfig())) throw new Error("请先在 ComfyUI → 运行环境配置 RunningHub API Key");
        const requestedOutputNodes = outputNodesOf(overrides);
        const outputSelection = resolveRunningHubOutputNodes(requestedOutputNodes, profile.workflowJson);
        const params = {
            runninghubMode: "workflow", runninghubWorkflowId: profile.workflowId, runninghubFields: profile.fields,
            ...overrides, runninghubParams: values, runninghubInstanceType: profile.instanceType || "default",
            runninghubProfileId: profile.id, model: `runninghub-workflow:${profile.id}`,
            // 输出节点是本轮运行的选择，不写进工作流档案；未指定时平台返回什么就收什么。
            runninghubOutputNodes: outputSelection.selected,
            ...(outputSelection.ignored.length ? { runninghubUnavailableOutputNodes: outputSelection.ignored } : {}),
        };
        return this.startTask("runninghub:workflow", input, params, clientTaskId, false, (task) => {
            if (outputSelection.ignored.length) this.tasks.addEvent(task.id, "output_nodes_unavailable", { nodeIds: outputSelection.ignored });
        });
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
                        const samplerNoiseRepairs = inferredSamplerNoiseRepairs(graph!);
                        body.workflow = JSON.stringify(patchRunningHubWorkflow(graph!, fields));
                        if (samplerNoiseRepairs.length) this.tasks.addEvent(task.id, "workflow_compatibility_patch", { kind: "shared_sampler_noise", nodeIds: samplerNoiseRepairs });
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
                    if (data.netWssUrl) closeWs = this.listen(task.id, String(data.netWssUrl), controller.signal, { config, outputNodes: outputNodesOf(task.params) });
                    else this.tasks.addEvent(task.id, "progress_channel_unavailable", { reason: "missing_netWssUrl", fallback: "poll" });
                }
                await this.poll(task, config, controller.signal);
            } catch (error) { this.fail(task.id, error); }
            finally {
                closeWs();
                await this.waitForWsDownloads(task.id);
                await this.cancellations.get(task.id);
                this.cancellations.delete(task.id);
                this.controllers.delete(task.id);
                this.runs.delete(task.id);
                this.wsDownloads.delete(task.id);
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
            // 提示词优先取本字段自己的值；只有缺失时才退回全局 input.prompt，
            // 否则正向与负面提示词共用一个槽位会互相覆盖。
            if (source === "prompt") {
                value = Object.hasOwn(configured, key) ? String(configured[key] ?? "") : String(task.input.prompt ?? "");
                hasPrompt = true;
            } else if (source === "image" || source === "video" || source === "audio") {
                const index = field.index === undefined ? cursors[source]++ : field.index - 1;
                cursors[source] = Math.max(cursors[source], index + 1);
                const file = media[source][index];
                if (!file) {
                    if (field.required) throw new Error(`RunningHub 参数「${field.label || field.fieldName}」缺少${source}素材 ${index + 1}`);
                    value = "";
                } else {
                    used[source].add(index);
                    if (!uploaded.has(file)) uploaded.set(file, this.upload(file, config, signal));
                    value = await uploaded.get(file);
                }
            } else if (source === "constant" && isUploadableMediaValue(field.fieldType, value)) {
                // RunningHub 表单的媒体选择器先写入 Backend 媒体库；即使映射来源是
                // constant，也必须先上传到 RunningHub，不能把 /media/... 路径传给节点。
                const file = String(value);
                if (!uploaded.has(file)) uploaded.set(file, this.upload(file, config, signal));
                value = await uploaded.get(file);
            } else if (source === "constant" && field.fieldType === "number" && String(value).trim() !== "" && Number.isFinite(Number(value))) {
                value = Number(value);
            } else if (source === "constant" && field.fieldType === "boolean") {
                value = value === true || String(value).toLowerCase() === "true";
            }
            if (field.required && (value === "" || value === undefined || value === null)) throw new Error(`RunningHub 参数「${field.label || field.fieldName}」不能为空`);
            values.push({ nodeId: String(field.nodeId), fieldName: field.fieldName, fieldValue: value });
        }
        if (task.input.prompt && !hasPrompt) throw new Error("RunningHub 工作流没有启用 H3 提示词映射");
        for (const kind of ["image", "video", "audio"] as const) {
            const supplied = media[kind].filter(Boolean).length;
            if (used[kind].size !== supplied) throw new Error(`RunningHub ${kind}输入映射未覆盖本轮全部 ${supplied} 个参考素材`);
        }
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
                // 用户可指定输出节点：只保留选中节点产出的媒体与文本，未指定时保持原样。
                const results = selectRunningHubResults(data.results, outputNodesOf(task.params));
                const media = await this.materialize(results, signal);
                const texts = results.flatMap((item) => typeof item.text === "string" ? [{ nodeId: String(item.nodeId || ""), content: item.text }] : []);
                // WS 中间产物与轮询成品常常是同一个文件，按 storageKey 去重后再合并。
                const all = dedupeByStorageKey([...media, ...(outputNodesOf(task.params).length ? [] : this.wsIntermediates(task.id))]);
                if (task.kind === "runninghub:workflow" && !all.length && !texts.length) throw new Error(outputNodesOf(task.params).length ? `指定的输出节点没有产物：${outputNodesOf(task.params).join("、")}` : "RunningHub 工作流完成但没有可归档的媒体或文本结果");
                if (signal.aborted || this.tasks.get(task.id)?.status === "cancelled") return;
                const result = { media: all, ...(texts.length ? { texts } : {}), taskId: config.remoteId, backend: "runninghub", mode: config.mode };
                this.tasks.addEvent(task.id, "result", result);
                const checked: Record<string, any> = this.media ? await inspectH3Result(result, task.params, this.media) : result;
                this.update(task.id, { status: checked.specification?.status === 'mismatch' ? 'failed' : 'succeeded', progress: 1, result: checked, ...(checked.specification?.status === 'mismatch' ? { error: checked.specification.issues.join('；') } : {}) });
                return;
            }
            if (["FAILED", "FAIL", "ERROR", "CANCELLED", "CANCELED"].includes(data.status)) {
                // WS 下载是异步的；终态抢救前等待已接收的文件归档完成。
                await this.waitForWsDownloads(task.id);
                // 工作流类任务：整体失败但输出节点或 WS 中间产物已有结果时，按成功算。
                if (task.kind === "runninghub:workflow") {
                    const rescued = await this.rescueFailedWorkflow(task, data.results, signal);
                    if (rescued) return;
                }
                throw new Error(redact(data.error || `RunningHub 任务${data.status}`, config));
            }
            if (!["QUEUED", "RUNNING", "PENDING"].includes(data.status)) {
                // 平台偶尔回传空状态；也允许用已归档的 WS 中间产物恢复任务。
                await this.waitForWsDownloads(task.id);
                if (task.kind === "runninghub:workflow" && (data.results.length || this.wsIntermediates(task.id).length)) {
                    const rescued = await this.rescueFailedWorkflow(task, data.results, signal);
                    if (rescued) return;
                }
                throw new Error(`RunningHub 返回未知任务状态：${data.status || "空"}`);
            }
            await delay(2500, signal);
        }
    }
    /**
     * RunningHub 整体失败或状态异常时，从指定输出节点抢救产物。
     * 归档成功即把任务标记为 succeeded 并返回 true；没有产物返回 false，由调用方照常报错。
     */
    private async rescueFailedWorkflow(task: RuntimeTask, results: Json[], signal: AbortSignal) {
        const picked = selectRunningHubResults(results, outputNodesOf(task.params));
        const media = await this.materialize(picked, signal);
        const texts = picked.flatMap((item) => typeof item.text === "string" ? [{ nodeId: String(item.nodeId || ""), content: item.text }] : []);
        // WS 抓到的中间产物也要算：整体失败时轮询 results 通常是空的（报告 §0 结论 2）。
        const fromWs = this.wsIntermediates(task.id);
        const all = [...media, ...fromWs];
        if (!all.length && !texts.length) return false;
        const result = { media: all, ...(texts.length ? { texts } : {}), taskId: this.runConfig(task.params).remoteId, backend: "runninghub", mode: "workflow", warning: fromWs.length && !media.length ? "工作流整体未成功，结果来自 WebSocket 中间产物" : "工作流整体未成功，已采用指定输出节点的产物" };
        this.tasks.addEvent(task.id, "result", result);
        this.update(task.id, { status: "succeeded", progress: 1, result });
        return true;
    }
    /** 已通过 WS 归档的中间产物；按 storageKey 去重，避免同文件存两份。 */
    private wsIntermediates(id: string) {
        const seen = new Set<string>();
        const out: Array<{ url: string; storageKey: string; mimeType: string; filename: string }> = [];
        for (const event of this.tasks.events(id)) {
            if (event.type !== "intermediate") continue;
            const media = record(record(event.payload).media);
            const storageKey = String(media.storageKey || "");
            if (!storageKey || seen.has(storageKey)) continue;
            seen.add(storageKey);
            out.push({ url: String(media.url || ""), storageKey, mimeType: String(media.mimeType || "application/octet-stream"), filename: String(record(event.payload).filename || "") });
        }
        return out;
    }
    private listen(id: string, url: string, signal: AbortSignal, run: { config: RunConfig; outputNodes: string[] }) {
        let socket: WebSocket;
        try { socket = new WebSocket(url); }
        catch (error) {
            this.tasks.addEvent(id, "progress_channel_unavailable", { reason: redact(error instanceof Error ? error.message : String(error), run.config), fallback: "poll" });
            return () => {};
        }
        const close = () => { socket.removeAllListeners(); socket.on("error", () => {}); socket.terminate(); signal.removeEventListener("abort", close); };
        signal.addEventListener("abort", close, { once: true });
        socket.on("open", () => { this.tasks.addEvent(id, "progress_channel_connected", {}); });
        socket.on("error", (error) => { this.tasks.addEvent(id, "progress_channel_unavailable", { reason: redact(error instanceof Error ? error.message : String(error), run.config), fallback: "poll" }); });
        socket.on("message", (raw) => {
            if (signal.aborted || this.tasks.get(id)?.status !== "running") return;
            try {
                const message = JSON.parse(String(raw));
                // 中间产物只走 WS 的 executed 消息，轮询结果里永远不会有（报告 §0 结论 2）。
                if (message.type === "executed") {
                    const { nodeId, files } = parseWsExecuted(message);
                    this.tasks.addEvent(id, "ws_executed_received", { nodeId, fileCount: files.length, outputFields: Object.fromEntries(WS_OUTPUT_FIELDS.map((field) => [field, Array.isArray(record(record(message.data).output)[field]) ? record(record(message.data).output)[field].length : 0])) });
                    // 指定输出节点时只收选中节点的中间产物；没指定就全收。
                    if (run.outputNodes.length && !run.outputNodes.includes(nodeId)) return;
                    const pending = this.wsDownloads.get(id) || new Set<Promise<void>>();
                    this.wsDownloads.set(id, pending);
                    const download = this.collectWsOutputs(id, run.config, url, nodeId, files);
                    pending.add(download);
                    void download.finally(() => pending.delete(download));
                    return;
                }
                if (message.type === "execution_error") {
                    this.tasks.addEvent(id, "ws_execution_error", { node: message.data?.node ?? "", exception: String(message.data?.exception_message || message.data?.exception_type || "").slice(0, 300) });
                    return;
                }
                if (message.type !== "progress") return;
                const value = Number(message.data?.value); const max = Number(message.data?.max);
                if (Number.isFinite(value) && Number.isFinite(max) && max > 0) this.update(id, { progress: Math.max(this.tasks.get(id)?.progress || 0, Math.min(0.95, value / max * 0.9 + 0.05)) });
            } catch (error) {
                this.tasks.addEvent(id, "ws_message_unparsed", { reason: redact(error instanceof Error ? error.message : String(error), run.config) });
            }
        });
        return close;
    }
    private async waitForWsDownloads(id: string) {
        const pending = this.wsDownloads.get(id);
        while (pending?.size) await Promise.all([...pending]);
    }
    /**
     * 下载并归档 WS 推来的中间产物。
     * 按报告 §4：两个通道依次尝试，200 且体积 >200B 才算成功，避免把鉴权错误页存成图片。
     */
    private async collectWsOutputs(id: string, config: RunConfig, netWssUrl: string, nodeId: string, files: Array<{ field: string; filename: string; subfolder: string; type: string }>) {
        if (!this.media) {
            this.tasks.addEvent(id, "intermediate_download_failed", { nodeId, reason: "media_archive_unavailable" });
            return;
        }
        for (const file of files) {
            let reason = "no_download_url";
            for (const url of buildWsFileUrls(config.baseUrl, netWssUrl, file)) {
                try {
                    const response = await fetch(url, { signal: this.controllers.get(id)?.signal });
                    if (!response.ok) { reason = `HTTP ${response.status}`; continue; }
                    if (!response.body) { reason = "empty_response_body"; continue; }
                    const header = response.headers.get("content-type") || "";
                    const media = await this.media.storeStream(Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream), {
                        name: file.filename,
                        category: "output",
                        resolveMimeType: (prefix, bytes) => runningHubMediaType({ prefix, bytes }, header, file.filename),
                    });
                    if (media.bytes <= WS_MIN_FILE_BYTES) {
                        this.media.delete(media.storageKey);
                        reason = `response_too_small:${media.bytes}`;
                        continue;
                    }
                    this.tasks.addEvent(id, "intermediate", { nodeId, field: file.field, filename: file.filename, media: { url: this.media.url(media), storageKey: media.storageKey, mimeType: media.mimeType, bytes: media.bytes } });
                    reason = "";
                    break;
                } catch (error) { reason = redact(error instanceof Error ? error.message : String(error), config); }
            }
            if (reason) this.tasks.addEvent(id, "intermediate_download_failed", { nodeId, field: file.field, filename: file.filename, reason });
        }
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
            if (!response.body) throw new Error("RunningHub 结果下载失败：响应没有媒体数据");
            const name = path.basename(parsed.pathname) || `runninghub-${item.nodeId || "output"}.${item.outputType || item.fileType || "mp4"}`;
            const header = response.headers.get("content-type") || "";
            const media = await this.media.storeStream(Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream), {
                name,
                category: "output",
                resolveMimeType: (prefix, bytes) => runningHubMediaType({ prefix, bytes }, header, name),
            });
            if (seen.has(media.sha256)) {
                this.media.delete(media.storageKey);
                continue;
            }
            seen.add(media.sha256);
            outputs.push({ url: this.media.url(media), storageKey: media.storageKey, mimeType: media.mimeType, filename: name, bytes: media.bytes });
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
    // 平台用不同 code 区分「填错了」和「还没保存」，必须给可操作的中文提示而不是透传英文码。
    if (Number(raw.code) === 421) throw new Error("RunningHub 平台并发/队列已满（421）；其他窗口或平台任务可能占用额度，请稍后手动重试");
    const message = String(raw.msg || raw.message || raw.errorMessage || "响应无效");
    if (Number(raw.code) === 810 || /WORKFLOW_NOT_SAVED_OR_NOT_RUNNING/i.test(message)) {
        throw new Error("该工作流在 RunningHub 上还没有保存或运行过，平台不提供 API 格式节点图。请先在 RunningHub 网页端打开这个工作流，保存一次或运行一次，再回到这里读取节点图。");
    }
    if (Number(raw.code) === 380 || /WORKFLOW_NOT_EXISTS/i.test(message)) {
        throw new Error("找不到这个 RunningHub 工作流（code 380）。请核对 workflowId 是否填错。");
    }
    throw new Error(`RunningHub 请求失败（HTTP ${response.status} / code ${String(raw.code ?? "unknown")}）：${redact(message, config)}`);
}
/** 仅供测试断言错误文案，避免为了测分支去改运行路径。 */
export const checkResponseForTest = checkResponse;
/** 仅供测试断言字段取值，不参与运行路径。 */
export const resolveFieldsForTest = (task: unknown, config: unknown = {}) => {
    const resolved = config as { fields?: unknown[]; workflowId?: string };
    const params = (task as { params?: Record<string, unknown> }).params || {};
    // 真实运行路径由 runConfig 从 params.runninghubFields 取字段，测试必须走同一条。
    const merged = {
        ...resolved,
        fields: Array.isArray(resolved.fields) && resolved.fields.length ? resolved.fields : params.runninghubFields,
        workflowId: resolved.workflowId || String(params.runninghubWorkflowId || ""),
    };
    return (new RunningHubBackend(fakeTasks(), fakeSettings()) as never as { resolveFields(t: unknown, c: unknown, signal: AbortSignal): Promise<Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>> })
        .resolveFields(task, merged, new AbortController().signal);
};
function fakeTasks(): TaskStore {
    return { list: () => [], get: () => undefined } as unknown as TaskStore;
}
function fakeSettings(): SettingStore {
    const store = new Map<string, unknown>();
    return { get: (key) => store.get(key), set: (key, value) => void store.set(key, value), delete: (key) => void store.delete(key) };
}
/** 任务参数里带的输出节点选择；缺省或非法时返回空数组，表示不过滤。 */
function outputNodesOf(params: Record<string, unknown>): string[] {
    const raw = params.runninghubOutputNodes ?? params.outputNodes;
    if (!Array.isArray(raw)) return [];
    return raw.map((id) => String(id).trim()).filter(Boolean);
}

/** Drop stale output-node IDs against the graph snapshot while retaining a no-graph fallback. */
export function resolveRunningHubOutputNodes(requested: string[], workflowGraph: unknown) {
    const graph = record(workflowGraph);
    const available = new Set(Object.keys(graph));
    if (!available.size) return { selected: [...requested], ignored: [] as string[] };
    return {
        selected: requested.filter((id) => available.has(String(id))),
        ignored: requested.filter((id) => !available.has(String(id))),
    };
}

function isUploadableMediaValue(fieldType: unknown, value: unknown) {
    if (!(["image", "audio", "video"] as unknown[]).includes(fieldType) || typeof value !== "string") return false;
    const source = value.trim();
    return /^https?:\/\//i.test(source) || source.startsWith("/media/") || path.isAbsolute(source);
}

/** 按输出节点过滤平台返回结果；未指定时原样返回。 */
export function selectRunningHubResults(results: Json[], outputNodes: string[]): Json[] {
    const list = Array.isArray(results) ? results : [];
    if (!outputNodes.length) return list;
    const wanted = new Set(outputNodes);
    return list.filter((item) => wanted.has(String(item?.nodeId ?? "")));
}

/** WS 的 `executed` 消息里，产出文件的字段名（报告 §4 实测）。 */
const WS_OUTPUT_FIELDS = ["images", "gifs", "videos", "3d", "audio"] as const;

/** 内部中间件不落盘：音频中转、temp 文件（报告 §4 实战提醒）。 */
function isWsNoiseFile(filename: string) {
    const low = filename.toLowerCase();
    return low.endsWith(".flac") || low.endsWith(".wav") || low.endsWith(".mp3") || low.endsWith(".ogg") || low.endsWith(".m4a") || low.includes("temp");
}

/**
 * 从 WS 的 `executed` 消息里提取产物文件。
 * 中间产物只会出现在这里，轮询 results 里永远没有（报告 §0 结论 2）。
 */
export function parseWsExecuted(message: Json) {
    const output = record(message?.data).output;
    const nodeId = String(message?.data?.node ?? "");
    const files: Array<{ field: string; filename: string; subfolder: string; type: string }> = [];
    for (const field of WS_OUTPUT_FIELDS) for (const item of (record(output)[field] as Json[] | undefined) || []) {
        const filename = String(item?.filename || "");
        if (!filename || isWsNoiseFile(filename)) continue;
        files.push({ field, filename, subfolder: String(item?.subfolder || ""), type: String(item?.type || "output") });
    }
    return { nodeId, files };
}

/**
 * 拼 WS 产物的下载地址（报告 §4 核心：WS 只给文件名，不给 URL）。
 * 主通道 {base}/view?…&Rh-Comfy-Auth=…，备用 CDN rh-images.xiaoyaoyou.com/{userId}/…
 * 两个通道都需要鉴权头，因为 netWssUrl 是平台下发的带凭据地址。
 */
export function buildWsFileUrls(baseUrl: string, netWssUrl: string, file: { filename: string; subfolder: string; type: string }) {
    const qs = new URL(netWssUrl).searchParams;
    const auth = qs.get("Rh-Comfy-Auth");
    const urls: string[] = [];
    const enc = (value: string, safe = "/") => encodeURIComponent(value).replace(/%2F/gi, safe === "/" ? "/" : "%2F");
    const encStrict = (value: string) => encodeURIComponent(value);
    // 从 Rh-Comfy-Auth（base64，内含 userId）解出 userId，供 CDN 兜底通道用。
    let userId = "";
    if (auth) {
        try {
            const padded = auth + "=".repeat((4 - auth.length % 4) % 4);
            const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
            userId = String(decoded?.userId || "");
        } catch {}
    }
    if (auth) urls.push(`${baseUrl}/view?filename=${enc(file.filename)}&type=${enc(file.type || "output")}&subfolder=${enc(file.subfolder)}&Rh-Comfy-Auth=${encStrict(auth)}`);
    if (userId) urls.push(["https://rh-images.xiaoyaoyou.com", userId, encStrict(file.type || "output"), ...(file.subfolder ? [encStrict(file.subfolder)] : []), enc(file.filename)].join("/"));
    return urls;
}

/** `/view` 鉴权过期会返回 200 的 HTML 错误页，体积过小的一律不认（报告 §9 坑 5）。 */
export const WS_MIN_FILE_BYTES = 200;

/** WS 中间产物与轮询成品常是同一文件，按 storageKey 去重（报告 §9 坑 7）。 */
function dedupeByStorageKey<T extends { storageKey: string }>(items: T[]) {
    const seen = new Set<string>();
    return items.filter((item) => (seen.has(item.storageKey) ? false : (seen.add(item.storageKey), true)));
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
        if (field.source && !["constant", "prompt", "image", "video", "audio"].includes(field.source)) throw new Error("RunningHub 映射来源无效");
        const target = `${field.nodeId}::${field.fieldName}`;
        if (targets.has(target)) throw new Error(`RunningHub 映射重复：${target}`);
        targets.add(target);
    }
}

/**
 * 老档案里 source=param 的映射降级成 constant。
 *
 * H3 专用 RunningHub 路径已删除（commit be2388ad），task.params 不再带 H3 参数，
 * param 映射运行必然报「没有值」。这里把它读成固定值：至少映射本身还在、输入仍可覆写，
 * 用户在浮窗里改一下来源即可，不需要重新读平台。
 * 只改 source/paramKey，其余字段（fieldValue、type、index 等）一律原样保留。
 */
export function normalizeRunningHubFieldSources(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const fields = (value as Record<string, unknown>).fields;
    if (!Array.isArray(fields)) return value;
    return {
        ...(value as Record<string, unknown>),
        fields: fields.map((field) => {
            if (!field || typeof field !== "object" || Array.isArray(field)) return field;
            const record_ = field as Record<string, unknown>;
            if (record_.source !== "param") return field;
            return { ...record_, source: "constant", paramKey: undefined };
        }),
    };
}
/** 连线型输入（["38", 0]）不属于可填写输入，必须排除，否则映射可覆盖掉节点连线。 */
function isRunningHubLinkValue(value: unknown) {
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
}
export function discoverRunningHubFields(graph: Json): RunningHubField[] {
    return Object.entries(graph).flatMap(([nodeId, raw]) => {
        const node = record(raw);
        const kind = String(node.class_type || "");
        return Object.entries(record(node.inputs))
            .filter(([, fieldValue]) => !isRunningHubLinkValue(fieldValue))
            .map(([fieldName, fieldValue]) => {
                const fieldType = /LoadImage/i.test(kind) && fieldName === "image" ? "image"
                    : /LoadVideo/i.test(kind) && /video|file/i.test(fieldName) ? "video"
                        : /LoadAudio/i.test(kind) && /audio|file/i.test(fieldName) ? "audio"
                            : typeof fieldValue === "number" ? "number" : typeof fieldValue === "boolean" ? "boolean" : "text";
                return { id: `${nodeId}::${fieldName}`, nodeId, fieldName, fieldValue, fieldType, label: `${record(node._meta).title || kind || nodeId} · ${fieldName}`, enabled: false, source: "constant" as const };
            });
    });
}
export function patchRunningHubWorkflow(graph: Json, fields: Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>) {
    const next = structuredClone(graph);
    for (const field of fields) {
        const inputs = next[field.nodeId]?.inputs;
        if (!inputs || !Object.hasOwn(inputs, field.fieldName)) throw new Error(`RunningHub 工作流输入不存在：${field.nodeId}.${field.fieldName}；请重新同步映射`);
        if (isRunningHubLinkValue(inputs[field.fieldName])) throw new Error(`RunningHub 输入 ${field.nodeId}.${field.fieldName} 是连线，不可覆写；请重新读取节点图`);
        inputs[field.fieldName] = field.fieldValue;
    }
    const noiseRepair = samplerNoiseRepair(next);
    if (noiseRepair) for (const nodeId of noiseRepair.nodeIds) record(next[nodeId].inputs).noise = structuredClone(noiseRepair.link);
    // RunningHub 复刻工作流中 SaveImageToLocal 的空路径会在生成后抛 FileNotFoundError。
    // 仅修补本次提交副本，给自定义保存节点一个相对输出目录；用户档案和原始节点图不变。
    for (const raw of Object.values(next)) {
        const node = record(raw);
        const inputs = record(node.inputs);
        if (node.class_type === "SaveImageToLocal" && !String(inputs.file_path ?? "").trim()) inputs.file_path = "output";
    }
    return next;
}
function inferredSamplerNoiseRepairs(graph: Json) {
    return samplerNoiseRepair(graph)?.nodeIds || [];
}
function samplerNoiseRepair(graph: Json) {
    const samplers = Object.entries(graph).filter(([, raw]) => record(raw).class_type === "SamplerCustomAdvanced");
    const existing = samplers.flatMap(([, raw]) => {
        const noise = record(record(raw).inputs).noise;
        return isRunningHubLinkValue(noise) ? [noise] : [];
    });
    const unique = new Map(existing.map((link) => [JSON.stringify(link), link]));
    if (unique.size !== 1) return null;
    const link = [...unique.values()][0];
    if (record(graph[String(link[0])]).class_type !== "RandomNoise") return null;
    const nodeIds = samplers
        .filter(([, raw]) => !isRunningHubLinkValue(record(record(raw).inputs).noise))
        .map(([nodeId]) => nodeId);
    return nodeIds.length ? { link, nodeIds } : null;
}
export function normalizeRunningHubQuery(response: Json) {
    const data = record(response.data || response);
    return { status: String(data.status || data.taskStatus || "").toUpperCase(), results: Array.isArray(data.results) ? data.results as Json[] : [], error: typeof data.failedReason === "string" ? data.failedReason : String(data.errorMessage || data.msg || data.message || record(data.failedReason).exception_message || "") };
}
export function runningHubMediaType(data: Buffer | { prefix: Buffer; bytes: number }, header: string, name: string) {
    const bytes = Buffer.isBuffer(data) ? data : data.prefix;
    const size = Buffer.isBuffer(data) ? data.length : data.bytes;
    const prefix = bytes.subarray(0, 64).toString().trimStart();
    if (!size || /^(?:<!doctype|<html)/i.test(prefix) || /text\/html/i.test(header) || /application\/json/i.test(header) && !/\.json$/i.test(name)) throw new Error("RunningHub 返回了空文件或错误页面，未作为媒体归档");
    if (size > 12 && ["ftyp", "moov", "mdat", "wide"].includes(bytes.subarray(4, 8).toString())) return "video/mp4";
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
