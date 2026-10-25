import { inspectH3Result } from "../canvas/h3-execution-contract.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import WebSocket from "ws";
import { runningHubConfigPatchSchema, runningHubWorkflowProfileSchema, type RunningHubField, type RunningHubConfig, type RunningHubSite, type RunningHubWorkflowProfile } from "@basketikun/canvas-agent/generation-contract";
import type { RuntimeTask } from "../db.js";
import type { MediaStore, SettingStore, TaskStore } from "../stores/types.js";
import type { BackendEventBus } from "../events.js";
import { randomUUID } from "node:crypto";
import { H3ExecutionQueue, h3CanResumeQueued } from "./h3-queue.js";
import { collectBrowserSessions, jwtExpiry, probeSession, readSession, clearSession, sessionStatus, writeSession, type RunningHubBrowserSession, type RunningHubSession, type RunningHubSessionStatus } from "./runninghub-session.js";
import { appendRunningHubApiTail, appendRunningHubOutputTail, type ApiTailResult, type TailResult } from "./runninghub-workflow-tail.js";
import { convertComfyWorkflowToApi } from "../workflows/comfyui-workflow-conversion.js";
import { applyLocalFieldsToDiscovered, type LocalWorkflowField } from "./runninghub-field-sync.js";
import { resolveLocalFieldTargets } from "./runninghub-field-resolve.js";
import { stripModelFolder, stripModelFoldersFromApiGraph, stripModelFoldersFromUiWorkflow } from "./runninghub-model-paths.js";
import { alignFieldsToGraph, remapRunningHubFields } from "./runninghub-id-remap.js";

export type { RunningHubField, RunningHubConfig } from "@basketikun/canvas-agent/generation-contract";
export type { RunningHubWorkflowProfile } from "@basketikun/canvas-agent/generation-contract";
type Json = Record<string, any>;
type RunConfig = RunningHubConfig & { remoteId?: string };
const DEFAULT_URL = "https://www.runninghub.ai";
/** 两个站点是两套独立账号：令牌、API Key、工作流列表都不互通，上传必须按站点分别走。 */
const SITE_URLS = { ai: "https://www.runninghub.ai", cn: "https://www.runninghub.cn" } as const;
const SITE_LABEL = { ai: "runninghub.ai（国际站）", cn: "runninghub.cn（国内站）" } as const;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const WS_FILE_RETRY_DELAYS_MS = [0, 350, 800, 1600, 3200, 6400];

/** 收尾节点（Play Sound KJ → Save Image To Local）的注入结果，给前端决定提示文案。 */
export type TailStatus = "added" | "added-video" | "added-api" | "already" | "no-sink" | "not-ui";
function tailStatusOf(tail: TailResult | undefined): TailStatus {
    if (!tail) return "not-ui";
    if (!tail.added) return (tail.reason as TailStatus) || "not-ui";
    return tail.kind === "video" ? "added-video" : "added";
}
/** API 格式注入：接的是输出节点的数据来源，不是它的输出槽，提示文案单独一档。 */
function apiTailStatusOf(tail: ApiTailResult | undefined): TailStatus {
    if (!tail) return "no-sink";
    if (!tail.added) return (tail.reason as TailStatus) || "no-sink";
    return "added-api";
}

/**
 * 需要用户动手才能解决的错误（去登录、去粘贴令牌）用 400，而不是 500。
 * Express 5 会把 async 路由的抛错交给统一错误中间件，中间件按 error.status 决定状态码；不挂就是 500。
 */
function userActionError(message: string): Error & { status: number } {
    const error = new Error(message) as Error & { status: number };
    error.status = 400;
    return error;
}

/** 站点取值归一：只认三档，其它一律按「跟随运行环境」处理。 */
export function normalizeSite(value: unknown): RunningHubSite {
    return value === "ai" || value === "cn" ? value : "default";
}
/** 上传/同步/运行实际请求的地址：`default` 用运行环境那条链路，其余用固定站点。 */
export function siteBaseUrl(baseUrl: string, site: RunningHubSite): string {
    return site === "default" ? baseUrl : SITE_URLS[site];
}
/** 非默认站点没有自己的 Key 时返回空：跨站点的 API Key 不通，宁愿报错也不拿错 Key 去试。 */
export function siteApiKey(config: Pick<RunningHubConfig, "apiKey" | "siteApiKeys">, site: RunningHubSite): string {
    return site === "default" ? String(config.apiKey || "") : String(config.siteApiKeys?.[site] || "");
}

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
        const siteApiKeys = record(stored.siteApiKeys);
        return { ...stored, baseUrl: normalizeUrl(String(stored.baseUrl || DEFAULT_URL)), apiKey: String(stored.apiKey || ""), walletApiKey: String(stored.walletApiKey || ""), mode: stored.mode === "app" ? "app" : "workflow", workflowId: String(stored.workflowId || ""), appId: String(stored.appId || ""), fields: Array.isArray(stored.fields) ? stored.fields : [], useWallet: stored.useWallet === true, instanceType, concurrency: validConcurrency(stored.concurrency ?? 1), uploadSite: normalizeSite(stored.uploadSite), siteApiKeys: { ai: String(siteApiKeys.ai || ""), cn: String(siteApiKeys.cn || "") } };
    }
    setConfig(patch: Partial<RunningHubConfig>) {
        patch = runningHubConfigPatchSchema.parse(patch);
        const current = this.getConfig();
        if (patch.apiKey === "********") patch = { ...patch, apiKey: current.apiKey };
        if (patch.walletApiKey === "********") patch = { ...patch, walletApiKey: current.walletApiKey };
        // 站点 Key 同样是掩码回传的；原样保存会用掩码覆盖真值，这里换回已存的那个。
        if (patch.siteApiKeys) patch = { ...patch, siteApiKeys: { ...current.siteApiKeys, ...Object.fromEntries(Object.entries(patch.siteApiKeys).map(([site, value]) => [site, value === "********" ? String(current.siteApiKeys?.[site as "ai" | "cn"] || "") : String(value || "")])) } };
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
        const stored = this.getConfig();
        return { configured: this.ready(params), url: config.baseUrl, mode: config.mode, hasApiKey: Boolean(keyFor(config)), hasApiKeyBySite: { ai: Boolean(siteApiKey(stored, "ai")), cn: Boolean(siteApiKey(stored, "cn")) }, workflowId: config.workflowId || "", appId: config.appId || "", concurrency: config.concurrency, queue: this.queue.status() };
    }
    ready(params: Record<string, unknown> = {}) {
        const config = this.runConfig(params);
        return Boolean(keyFor(config) && (config.mode === "app" ? config.appId : config.workflowId) && config.fields?.some((field) => field.enabled !== false));
    }
    /** 按站点取一套可直接发请求的配置：地址、Key 都换成该站点的。 */
    private siteConfig(site: RunningHubSite = "default"): RunningHubConfig {
        const config = this.getConfig();
        if (site === "default") return config;
        return { ...config, baseUrl: siteBaseUrl(config.baseUrl, site), apiKey: siteApiKey(config, site), walletApiKey: "" };
    }
    /** 非默认站点必须自带 API Key：跨站点不通用，缺省时给出可操作的提示。 */
    private requireSiteKey(site: RunningHubSite) {
        if (site === "default" || siteApiKey(this.getConfig(), site)) return;
        throw userActionError(`${SITE_LABEL[site]} 还没有配置 API Key。请在 RunningHub 设置里填写该站点的 API Key（站点之间不通用，要在对应站点网页端单独生成）。`);
    }
    async inspectWorkflow(workflowId?: string, site?: RunningHubSite) {
        const target = normalizeSite(site);
        this.requireSiteKey(target);
        const config = this.siteConfig(target);
        const id = String(workflowId || config.workflowId || "").trim();
        if (!keyFor(config) || !id) throw new Error("请先设置 RunningHub API Key 和工作流 ID");
        const graph = await this.fetchWorkflow({ ...config, workflowId: id }, new AbortController().signal);
        return { workflowId: id, workflowJson: graph, fields: discoverRunningHubFields(graph) };
    }
    /** 重新读取平台当前节点图和字段；保留已保存的映射与配置，只刷新图快照和字段清单。 */
    async refreshProfileGraph(profileId: string) {
        const profile = this.listWorkflowProfiles().find((item) => item.id === profileId);
        if (!profile) throw new Error("RunningHub 工作流配置不存在");
        const inspected = await this.inspectWorkflow(profile.workflowId, normalizeSite(profile.site));
        // 平台可能重新分配编号（网页端增删过节点），先把旧映射迁到新图上，再按 key 合并配置。
        const moved = remapRunningHubFields(record(profile.workflowJson), inspected.workflowJson, profile.fields);
        const previous = new Map(moved.map((field) => [`${field.nodeId}::${field.fieldName}`, field]));
        const fields = inspected.fields.map((field) => ({ ...field, ...previous.get(`${field.nodeId}::${field.fieldName}`) }));
        return this.saveWorkflowProfile({ ...profile, workflowJson: inspected.workflowJson, fields });
    }
    /**
     * 把本地工作流的字段配置套用到已有云端档案。
     * 上传时会自动套用；这个入口用于历史上传的档案，或本地改完字段后再推一次。
     */
    /**
     * 把本地字段推进已有云端档案。历史上传的档案字段全是未勾选状态，靠这里补齐。
     * `uiWorkflow` 可选但强烈建议传：连线输入（`265::prompt` 走 GetNode/SetNode）只有靠 UI 里的变量名才能顺链下钻。
     */
    applyLocalFieldsToProfile(profileId: string, localFields: LocalWorkflowField[], uiWorkflow?: unknown): RunningHubWorkflowProfile {
        const profile = this.listWorkflowProfiles().find((item) => item.id === profileId);
        if (!profile) throw new Error("RunningHub 工作流配置不存在");
        const uiSource = uiWorkflow && typeof uiWorkflow === "object" && !Array.isArray(uiWorkflow) ? record(uiWorkflow) : undefined;
        const graph = profile.workflowJson ? record(profile.workflowJson) : {};
        const resolution = resolveLocalFieldTargets(graph, uiSource, localFields || []);
        const remapped = resolution.targets.map((target) => ({ ...target.local, node: target.nodeId, input: target.fieldName }));
        const fields = applyLocalFieldsToDiscovered(profile.fields || [], remapped);
        return this.saveWorkflowProfile({ ...profile, fields });
    }
    /**
     * 提交前把字段编号对齐到平台当前图：拿档案里保存的旧图当参照，按节点类型迁移。
     * 编号没变时原样返回，不产生额外开销。
     */
    private alignFieldsWithGraph(workflowId: string, graph: Json, fields: RunningHubField[]): RunningHubField[] {
        if (!fields?.length) return fields;
        if (fields.every((field) => Object.hasOwn(graph, field.nodeId))) return fields;
        const profile = this.listWorkflowProfiles().find((item) => item.workflowId === workflowId && item.workflowJson);
        if (!profile?.workflowJson) return fields;
        return alignFieldsToGraph(record(profile.workflowJson), graph, fields);
    }
    /** 网页会话状态（不含令牌本体）。上传本地工作流必须要有这个会话，按站点分别保存。 */
    sessionStatus(site?: RunningHubSite): RunningHubSessionStatus { return sessionStatus(this.sessionFor(normalizeSite(site))); }
    /**
     * 取站点会话：站点与运行环境同一个域时，允许共用运行环境那份（同域令牌本来就通用），
     * 免得选中「国际站」却发现要重新连一次。
     */
    private sessionFor(site: RunningHubSite): RunningHubSession {
        const own = readSession(this.settings, site);
        if (own.accessToken || site === "default") return own;
        const config = this.getConfig();
        return siteBaseUrl(config.baseUrl, site) === config.baseUrl ? readSession(this.settings, "default") : own;
    }
    /**
     * 从本机浏览器里读取已登录的 RunningHub 会话。
     * localStorage 里的令牌带站点标记（见 readTokens），先按站点过滤再 probe——
     * 否则拿 .ai 令牌去撞 .cn 只会得到「站点不通用」，既误导又白跑请求。
     */
    async importBrowserSession(site?: RunningHubSite): Promise<RunningHubSessionStatus> {
        const target = normalizeSite(site);
        const baseUrl = siteBaseUrl(this.getConfig().baseUrl, target);
        // `default` 跟随运行环境的 baseUrl：它实际指向哪个站，就按哪个站过滤。
        const effectiveSite: "ai" | "cn" | undefined = target !== "default" ? target
            : /runninghub\.cn/i.test(baseUrl) ? "cn"
                : /runninghub\.ai/i.test(baseUrl) ? "ai"
                    : undefined;
        const all = await collectBrowserSessions();
        const now = Date.now();
        const sameSite = effectiveSite ? all.filter((candidate) => candidate.site === effectiveSite) : all;
        // .cn 的令牌存 Cookie、不在 localStorage：只可能是别的站的令牌，别去 probe。
        // .ai 的令牌本来就在 localStorage；站点标记缺失（老数据）时退回全量，避免误判「没找到」。
        const pool = !effectiveSite ? all
            : sameSite.length ? sameSite
                : effectiveSite === "ai" ? all
                    : [];
        for (const candidate of pool) {
            // 过期的令牌不用发请求：省一次往返，也能把「已过期」和「站点不对」分开说清楚。
            if (candidate.expiresAt && candidate.expiresAt * 1000 <= now) continue;
            if (!(await probeSession(baseUrl, candidate.accessToken))) continue;
            writeSession(this.settings, { accessToken: candidate.accessToken, refreshToken: candidate.refreshToken, expiresAt: candidate.expiresAt, source: "browser" }, target);
            return this.sessionStatus(target);
        }
        const where = target === "default" ? "RunningHub" : SITE_LABEL[target];
        if (effectiveSite === "cn" && !sameSite.length) {
            // 国内站令牌在 Cookie 里、被浏览器加密，localStorage 扫不到；令牌本身不是 HttpOnly，用页内脚本取最稳。
            throw userActionError("国内站令牌存在 Cookie 里、不在本地存储，无法用『从本机浏览器读取』；请点下方『复制取令牌脚本』，在 runninghub.cn 页面按 F12 打开控制台粘贴运行，取出 Rh-Accesstoken 再粘到令牌输入框。");
        }
        const expired = pool.find((candidate) => candidate.expiresAt && candidate.expiresAt * 1000 <= now);
        if (expired?.expiresAt) {
            throw userActionError(`本机浏览器里 ${where} 的登录令牌已于 ${new Date(expired.expiresAt * 1000).toLocaleString("zh-CN")} 过期，请用浏览器打开 ${where} 重新登录后重试`);
        }
        throw userActionError(pool.length
            ? `在本机浏览器里找到了会话，但${where}不接受这个令牌（站点之间不通用）；请用浏览器打开 ${where} 登录后重试`
            : `没有在本机浏览器里找到登录会话；请先用 Edge/Chrome 打开 ${where} 登录`);
    }
    /** 手填网页令牌：同样先验证再落盘，避免保存一个看起来连上但一用就错的令牌。 */
    async setSessionToken(token: string, site?: RunningHubSite): Promise<RunningHubSessionStatus> {
        const trimmed = String(token || "").trim();
        const target = normalizeSite(site);
        if (!trimmed) return this.disconnectSession(target);
        const baseUrl = siteBaseUrl(this.getConfig().baseUrl, target);
        if (!(await probeSession(baseUrl, trimmed))) throw userActionError(`RunningHub 网页令牌无效或已过期${target === "default" ? "" : `（${SITE_LABEL[target]} 要用该站点自己的令牌）`}，请重新复制`);
        writeSession(this.settings, { accessToken: trimmed, expiresAt: jwtExpiry(trimmed), source: "manual" }, target);
        return this.sessionStatus(target);
    }
    disconnectSession(site?: RunningHubSite): RunningHubSessionStatus { const target = normalizeSite(site); clearSession(this.settings, target); return this.sessionStatus(target); }
    /** 内部接口只认网页令牌，缺 Session 时给出唯一修法。 */
    private requireSession(site: RunningHubSite): RunningHubSession {
        const session = this.sessionFor(site);
        const where = site === "default" ? "RunningHub" : SITE_LABEL[site];
        if (!session.accessToken) throw new Error(`请先连接${where}的网页账号（读取本机浏览器会话或粘贴网页令牌）；OpenAPI Key 没有上传工作流的权限`);
        if (session.expiresAt && session.expiresAt * 1000 <= Date.now()) throw new Error(`${where}的网页会话已过期，请在浏览器里重新登录后重新读取`);
        return session;
    }
    /**
     * 把本地节点图上传到 RunningHub 工作台，返回云端工作流 ID。
     * 优先用**原始 UI 格式**（nodes/links）：RunningHub 编辑器只认它；API 格式（class_type）虽能上传，
     * 但编辑器解析不出节点，工作流等于不能用。没有 UI 原件时才退回 API 格式并标记 format=api。
     */
    async pushWorkflowGraph(input: { name?: string; graph?: unknown; uiWorkflow?: unknown; site?: RunningHubSite }): Promise<{ workflowId: string; name: string; site: RunningHubSite; format: "ui" | "api"; tail: TailStatus; fallbackGraph: Json }> {
        const graph = record(input.graph);
        const ui = input.uiWorkflow && typeof input.uiWorkflow === "object" && !Array.isArray(input.uiWorkflow) ? record(input.uiWorkflow) : undefined;
        const usingUi = Boolean(ui && Array.isArray((ui as { nodes?: unknown }).nodes) && ((ui as { nodes: unknown[] }).nodes).length > 0);
        if (!usingUi && !Object.values(graph).some((node) => record(node).class_type)) throw new Error("要上传的节点图既不是 RunningHub 编辑器格式（缺 nodes），也不是 ComfyUI API 格式（缺 class_type）");
        const name = String(input.name || "").trim().slice(0, 120) || "未命名工作流";
        const site = normalizeSite(input.site);
        const session = this.requireSession(site);
        const config = this.siteConfig(site);
        // 云端收尾：输出节点后面补 Play Sound KJ → Save Image To Local（幂等，已有就跳过）。
        // UI 格式接输出槽；API 格式没有输出槽信息，改接输出节点的数据来源（见 appendRunningHubApiTail）。
        const tailed = usingUi ? appendRunningHubOutputTail(ui!) : undefined;
        const apiTailed = usingUi ? undefined : appendRunningHubApiTail(graph);
        // 本地档案在云端图尚不可读时会作为 RH 执行底图。它必须与上传的图同源，
        // 否则上传里追加的两个收尾节点会在 fallback 快照和 RH 任务里消失。
        const fallbackGraph = usingUi
            ? stripModelFoldersFromApiGraph(convertComfyWorkflowToApi(record(tailed ? tailed.workflow : ui!)))
            : stripModelFoldersFromApiGraph(record(apiTailed ? apiTailed.graph : graph));
        // 模型文件名去掉本地目录前缀：云端的模型是平铺的，带 `Minimax\` 之类的前缀在平台上选不中。
        const payload = usingUi
            ? stripModelFoldersFromUiWorkflow(record(tailed ? tailed.workflow : ui!))
            : stripModelFoldersFromApiGraph(record(apiTailed ? apiTailed.graph : graph));
        const form = new FormData();
        form.set("workflowFile", new Blob([JSON.stringify(payload)], { type: "application/json" }), `${safeFileName(name)}.json`);
        form.set("workflowName", name);
        const response = await fetch(`${config.baseUrl}/api/workflow/upload`, { method: "POST", body: form, headers: { Authorization: `Bearer ${session.accessToken}` } });
        const raw = await response.json().catch(() => ({})) as Json;
        if (Number(raw.code) === 403 || Number(raw.code) === 412) throw new Error(`${site === "default" ? "RunningHub" : SITE_LABEL[site]}的网页会话已失效，请重新读取浏览器会话或粘贴新的令牌`);
        checkResponse(response, raw, config);
        const workflowId = String(record(raw.data).id || "");
        if (!workflowId) throw new Error("RunningHub 已接收工作流但没有返回工作流 ID");
        return { workflowId, name, site, format: usingUi ? "ui" : "api", tail: usingUi ? tailStatusOf(tailed) : apiTailStatusOf(apiTailed), fallbackGraph };
    }
    /**
     * 上传本地工作流并在本地建档：上传 → 拿 workflowId → 自动导入。
     * 平台侧新建的工作流是草稿，对 OpenAPI 暂不可读，所以读不到平台图时直接用刚上传的这份图建档。
     */
    async publishLocalWorkflow(input: { name?: string; graph?: unknown; uiWorkflow?: unknown; site?: RunningHubSite; localFields?: LocalWorkflowField[] }): Promise<{ workflowId: string; profile: RunningHubWorkflowProfile; cloudRead: boolean; site: RunningHubSite; format: "ui" | "api"; tail: TailStatus; fieldMisses: number; fieldMissNames: string[] }> {
        const uploaded = await this.pushWorkflowGraph(input);
        let cloudRead = true;
        // 归档的节点图也用清洗后的模型名：运行提交会把它作为底图，带本地目录前缀在云端会找不到模型。
        let workflowJson: Json = uploaded.fallbackGraph;
        let fields = discoverRunningHubFields(workflowJson);
        try {
            const inspected = await this.inspectWorkflow(uploaded.workflowId, uploaded.site);
            workflowJson = inspected.workflowJson;
            fields = inspected.fields;
        } catch { cloudRead = false; }
        // 本地字段可能指向连线输入（如 `265::prompt` 走 GetNode/SetNode），先顺链解析到真正可覆写的位置。
        // GetNode/SetNode 的变量名只存在于 UI 原件里，所以这里按上传时那份 UI 重新算一份（纯函数，代价很小）。
        const uiSource = input.uiWorkflow && typeof input.uiWorkflow === "object" && !Array.isArray(input.uiWorkflow) ? record(input.uiWorkflow) : undefined;
        const usingUi = Boolean(uiSource && Array.isArray(uiSource.nodes) && (uiSource.nodes as unknown[]).length);
        const uiPayload = usingUi ? stripModelFoldersFromUiWorkflow(record(appendRunningHubOutputTail(uiSource!).workflow)) : undefined;
        const resolution = resolveLocalFieldTargets(workflowJson, uiPayload, input.localFields || []);
        const remappedLocal = resolution.targets.map((target) => ({ ...target.local, node: target.nodeId, input: target.fieldName }));
        // 平台自动发现的字段默认全禁用；把本地已配置的那批启用起来，云端档案页与运行表单才和本地一致。
        fields = applyLocalFieldsToDiscovered(fields, remappedLocal);
        const profile = this.saveWorkflowProfile({ id: randomUUID(), name: uploaded.name, workflowId: uploaded.workflowId, fields, workflowJson, site: uploaded.site === "default" ? undefined : uploaded.site });
        return { workflowId: uploaded.workflowId, profile, cloudRead, site: uploaded.site, format: uploaded.format, tail: uploaded.tail, fieldMisses: resolution.unresolved.length, fieldMissNames: resolution.unresolved.map((item) => item.name || `${item.node}::${item.input}`) };
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
        // 档案是运行提交的底图：模型名带本地目录前缀在云端找不到模型，这里统一清成平铺的文件名。
        const saved: RunningHubWorkflowProfile = {
            ...profile,
            fields: profile.fields.map((field) => ({ ...field, fieldValue: stripModelFolder(field.fieldValue) })),
            ...(profile.workflowJson ? { workflowJson: stripModelFoldersFromApiGraph(record(profile.workflowJson)) } : {}),
            createdAt: previous?.createdAt || profile.createdAt || now,
            updatedAt: now,
        };
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
        const config = this.getConfig() as RunConfig;
        return this.tasks.list({ kind: "runninghub:workflow", model: `runninghub-workflow:${profile.id}`, limit: 50 }).map((task) => {
            if (!task.error) return task;
            const error = this.describeFailure(task.id, task.error, config);
            return error === task.error ? task : { ...task, error };
        });
    }
    async runWorkflow(profileId: string, input: Record<string, unknown>, values: Record<string, unknown>, overrides: Record<string, unknown> = {}, clientTaskId?: string) {
        const profile = this.listWorkflowProfiles().find((item) => item.id === profileId);
        if (!profile) throw new Error("RunningHub 工作流配置不存在，请重新添加");
        const site = normalizeSite(profile.site);
        this.requireSiteKey(site);
        if (!keyFor(this.siteConfig(site))) throw new Error("请先在 ComfyUI → 运行环境配置 RunningHub API Key");
        const requestedOutputNodes = outputNodesOf(overrides);
        const outputSelection = resolveRunningHubOutputNodes(requestedOutputNodes, profile.workflowJson);
        const params = {
            runninghubMode: "workflow", runninghubWorkflowId: profile.workflowId, runninghubFields: profile.fields,
            ...overrides, runninghubParams: values, runninghubInstanceType: profile.instanceType || "default",
            runninghubProfileId: profile.id, model: `runninghub-workflow:${profile.id}`,
            // 档案属于哪个站点就打到哪个站点；跨站点的工作流 ID 与 API Key 都不通用。
            runninghubSite: site,
            // 输出节点是本轮运行的选择，不写进工作流档案；未指定时平台返回什么就收什么。
            runninghubOutputNodes: outputSelection.selected,
            // 平台侧草稿工作流对 OpenAPI 不可读；带上本地图，读不到平台图时直接跑这份。
            ...(profile.workflowJson && Object.keys(profile.workflowJson).length ? { runninghubGraph: profile.workflowJson } : {}),
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
                    const graph = config.mode === "workflow" ? await this.fetchWorkflowWithFallback(task, config, controller.signal) : undefined;
                    const resolved = await this.resolveFields(task, config, controller.signal);
                    const fields = resolved.values;
                    const body: Json = { apiKey: keyFor(config), instanceType: config.instanceType || "default", addMetadata: true };
                    if (config.mode === "workflow") {
                        body.workflowId = config.workflowId;
                        // 平台可能重新分配过编号（网页端增删过节点）：提交前把字段对齐到这次读回的平台图。
                        const alignedFields = this.alignFieldsWithGraph(String(config.workflowId), graph!, fields);
                        if (alignedFields !== fields) this.tasks.addEvent(task.id, "workflow_field_id_remap", { workflowId: config.workflowId, fields: alignedFields.length });
                        const samplerNoiseRepairs = inferredSamplerNoiseRepairs(graph!);
                        body.workflow = JSON.stringify(patchRunningHubWorkflow(graph!, alignedFields as Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>, resolved.omittedInputs));
                        if (samplerNoiseRepairs.length) this.tasks.addEvent(task.id, "workflow_compatibility_patch", { kind: "shared_sampler_noise", nodeIds: samplerNoiseRepairs });
                    } else { body.webappId = config.appId; body.nodeInfoList = fields; }
                    this.tasks.addEvent(task.id, "actual_submission", { workflowId: config.workflowId, mode: config.mode, fields: fields.map((field) => ({ ...field, fieldValue: typeof field.fieldValue === "string" && /^https?:/.test(field.fieldValue) ? "[uploaded media]" : field.fieldValue })), omittedOptionalInputs: resolved.omittedInputs });
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
                    let netWssUrl = String(data.netWssUrl || "");
                    if (!netWssUrl) {
                        this.tasks.addEvent(task.id, "progress_channel_unavailable", { reason: "missing_netWssUrl", fallback: "query_outputs" });
                        netWssUrl = await this.waitForRunningHubWsUrl(task.id, config, controller.signal);
                    }
                    if (netWssUrl) closeWs = this.listen(task.id, netWssUrl, controller.signal, { config, outputNodes: outputNodesOf(task.params) });
                    else this.tasks.addEvent(task.id, "progress_channel_unavailable", { reason: "netWssUrl_not_available", fallback: "poll" });
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
    /**
     * 平台图优先；读不到时用任务参数里随上传带来的本地图。
     * 云端刚导入的工作流是草稿（OpenAPI 返回 380 WORKFLOW_NOT_EXISTS），
     * 此时本地那份图就是唯一可提交的节点图，不降级会直接跑不起来。
     */
    private async fetchWorkflowWithFallback(task: RuntimeTask, config: RunConfig, signal: AbortSignal): Promise<Json> {
        try {
            return await this.fetchWorkflow(config, signal);
        } catch (error) {
            const local = localGraphOf(task.params);
            if (!local) throw error;
            this.tasks.addEvent(task.id, "workflow_graph_fallback_local", { reason: redact(error instanceof Error ? error.message : String(error), config) });
            return local;
        }
    }
    private async fetchWorkflow(config: RunConfig, signal: AbortSignal): Promise<Json> {
        const response = await this.request(config, "/api/openapi/getJsonApiFormat", { apiKey: keyFor(config), workflowId: config.workflowId }, signal);
        const prompt = record(response.data).prompt;
        const graph = typeof prompt === "string" ? JSON.parse(prompt) : prompt;
        if (!graph || typeof graph !== "object" || Array.isArray(graph) || !Object.values(graph).some((node) => record(node).class_type)) throw new Error("RunningHub 返回的工作流不是 API 格式");
        return graph;
    }
    /** Submission may return QUEUED with netWssUrl=null; poll outputs until the task is RUNNING. */
    private async waitForRunningHubWsUrl(id: string, config: RunConfig, signal: AbortSignal) {
        const maxPolls = 120;
        for (let attempt = 1; attempt <= maxPolls; attempt++) {
            if (signal.aborted || this.tasks.get(id)?.status === "cancelled") return "";
            try {
                const response = await fetch(`${config.baseUrl}/task/openapi/outputs`, {
                    method: "POST",
                    headers: { "content-type": "application/json", Accept: "application/json", Authorization: `Bearer ${keyFor(config)}` },
                    body: JSON.stringify({ apiKey: keyFor(config), taskId: config.remoteId }),
                    signal,
                });
                const raw = await response.json().catch(() => ({})) as Json;
                const data = record(raw.data);
                const netWssUrl = String(data.netWssUrl || raw.netWssUrl || "");
                const status = String(data.status || raw.status || "").toUpperCase();
                const code = Number(raw.code);
                this.tasks.addEvent(id, "progress_channel_lookup", {
                    attempt,
                    httpStatus: response.status,
                    code: Number.isFinite(code) ? code : null,
                    status,
                    hasNetWssUrl: Boolean(netWssUrl),
                    ...(netWssUrl ? { url: netWssUrl } : {}),
                    ...(!response.ok ? { error: redact(String(raw.msg || raw.message || `HTTP ${response.status}`), config) } : {}),
                });
                if (netWssUrl) return netWssUrl;
                if (code === 805 || ["FAILED", "FAIL", "ERROR", "CANCELLED", "CANCELED", "SUCCESS", "SUCCEEDED", "COMPLETED"].includes(status) || Array.isArray(raw.data)) return "";
            } catch (error) {
                if (signal.aborted) return "";
                this.tasks.addEvent(id, "progress_channel_lookup_error", { attempt, error: redact(error instanceof Error ? error.message : String(error), config) });
            }
            if (attempt < maxPolls) {
                try { await delay(2_000, signal); }
                catch { return ""; }
            }
        }
        this.tasks.addEvent(id, "progress_channel_lookup_timeout", { attempts: maxPolls });
        return "";
    }
    private async resolveFields(task: RuntimeTask, config: RunConfig, signal: AbortSignal) {
        const configured = record(task.params.runninghubParams);
        const media = { image: Array.isArray(task.input.references) ? task.input.references.map(String) : [], video: Array.isArray(task.input.videos) ? task.input.videos.map(String) : task.input.video ? [String(task.input.video)] : [], audio: Array.isArray(task.input.audios) ? task.input.audios.map(String) : [] };
        const used = { image: new Set<number>(), video: new Set<number>(), audio: new Set<number>() };
        const cursors = { image: 0, video: 0, audio: 0 };
        const uploaded = new Map<string, Promise<string>>();
        const values: Array<{ nodeId: string; fieldName: string; fieldValue: unknown }> = [];
        const omittedInputs: Array<{ nodeId: string; fieldName: string; kind: "image" | "video" | "audio" }> = [];
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
                    if (field.required) {
                        throw new Error(`RunningHub ${source}输入「${field.label || field.fieldName}」（节点 ${field.nodeId}.${field.fieldName}）缺少本次素材 ${index + 1}；请在运行表单添加对应素材`);
                    }
                    // 可选媒体没有本次素材时从本次图中移除输入；保留默认值可能是无效的 "None" 文件名。
                    omittedInputs.push({ nodeId: String(field.nodeId), fieldName: field.fieldName, kind: source });
                    continue;
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
        return { values, omittedInputs };
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
                const materializeErrors: Array<{ nodeId: string; url: string; reason: string }> = [];
                let media = await this.materialize(results, signal, (nodeId, reason, url) => materializeErrors.push({ nodeId, url, reason }), config);
                const texts = results.flatMap((item) => typeof item.text === "string" ? [{ nodeId: String(item.nodeId || ""), content: item.text }] : []);
                // WebSocket 监听器已按选中输出节点过滤；即使查询结果 URL 过期/404，也保留已归档中间产物。
                const intermediates = this.wsIntermediates(task.id);
                let outputEndpointResultCount = 0;
                let outputEndpointError = "";
                if (task.kind === "runninghub:workflow" && !media.length && !intermediates.length && !texts.length) {
                    // Some sites return no file URLs from /openapi/v2/query even after SUCCESS.
                    try {
                        const fallbackResponse = await this.request(config, "/task/openapi/outputs", { apiKey: keyFor(config), taskId: config.remoteId }, signal);
                        const fallbackResults = selectRunningHubResults(normalizeRunningHubOutputs(fallbackResponse), outputNodesOf(task.params));
                        outputEndpointResultCount = fallbackResults.length;
                        media = await this.materialize(fallbackResults, signal, (nodeId, reason, url) => materializeErrors.push({ nodeId, url, reason }), config);
                        texts.push(...fallbackResults.flatMap((item) => typeof item.text === "string" ? [{ nodeId: String(item.nodeId || ""), content: item.text }] : []));
                    } catch (error) {
                        outputEndpointError = redact(error instanceof Error ? error.message : String(error), config).slice(0, 500);
                    }
                }
                const all = dedupeByStorageKey([...media, ...intermediates]);
                if (materializeErrors.length || outputEndpointResultCount || outputEndpointError) this.tasks.addEvent(task.id, "output_materialization", {
                    selectedNodeIds: outputNodesOf(task.params),
                    queryResultCount: data.results.length,
                    selectedQueryResultCount: results.length,
                    outputEndpointResultCount,
                    archivedWebSocketResultCount: intermediates.length,
                    downloadFailures: materializeErrors.slice(0, 20),
                    ...(outputEndpointError ? { outputEndpointError } : {}),
                });
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
                    const rescued = await this.rescueFailedWorkflow(task, data.results, signal, config, data.error);
                    if (rescued) return;
                }
                throw new Error(redact(data.error || `RunningHub 任务${data.status}`, config));
            }
            if (!["QUEUED", "RUNNING", "PENDING"].includes(data.status)) {
                // 平台偶尔回传空状态；也允许用已归档的 WS 中间产物恢复任务。
                await this.waitForWsDownloads(task.id);
                if (task.kind === "runninghub:workflow") {
                    const rescued = await this.rescueFailedWorkflow(task, data.results, signal, config, data.error);
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
    private async rescueFailedWorkflow(task: RuntimeTask, results: Json[], signal: AbortSignal, config: RunConfig, remoteError = "") {
        const selectedNodes = outputNodesOf(task.params);
        const queryResults = selectRunningHubResults(results, selectedNodes);
        const remoteTaskId = config.remoteId;
        let outputEndpointResults: Json[] = [];
        let outputEndpointError = "";
        // /openapi/v2/query can mark the workflow FAILED while an earlier output node
        // has already produced a file. Ask RunningHub's task-output endpoint as a
        // second source; the endpoint is deprecated on some sites, so failure is
        // diagnostic only and must not replace the original task error.
        try {
            const response = await this.request(config, "/task/openapi/outputs", { apiKey: keyFor(config), taskId: remoteTaskId }, signal);
            outputEndpointResults = normalizeRunningHubOutputs(response);
        } catch (error) {
            outputEndpointError = redact(error instanceof Error ? error.message : String(error), config).slice(0, 500);
        }
        const outputResults = selectRunningHubResults(outputEndpointResults, selectedNodes);
        const picked = [...queryResults, ...outputResults];
        const materializeErrors: Array<{ nodeId: string; url: string; reason: string }> = [];
        const media = await this.materialize(picked, signal, (nodeId, reason, url) => materializeErrors.push({ nodeId, url, reason }), config);
        const texts = picked.flatMap((item) => typeof item.text === "string" ? [{ nodeId: String(item.nodeId || ""), content: item.text }] : []);
        // WS 抓到的中间产物也要算：整体失败时轮询 results 通常是空的（报告 §0 结论 2）。
        const fromWs = this.wsIntermediates(task.id);
        const all = dedupeByStorageKey([...media, ...fromWs]);
        this.tasks.addEvent(task.id, "output_rescue_diagnostics", {
            selectedNodeIds: selectedNodes,
            queryResultCount: results.length,
            selectedQueryResultCount: queryResults.length,
            outputEndpointResultCount: outputEndpointResults.length,
            selectedOutputEndpointResultCount: outputResults.length,
            archivedWebSocketResultCount: fromWs.length,
            downloadFailures: materializeErrors.slice(0, 20),
            ...(outputEndpointError ? { outputEndpointError } : {}),
            ...(remoteError ? { remoteError: redact(remoteError, config).slice(0, 500) } : {}),
        });
        if (!all.length && !texts.length) return false;
        const result = { media: all, ...(texts.length ? { texts } : {}), taskId: remoteTaskId, backend: "runninghub", mode: "workflow", warning: fromWs.length && !media.length ? "工作流整体未成功，结果来自 WebSocket 中间产物" : "工作流整体未成功，已采用指定输出节点的产物" };
        this.tasks.addEvent(task.id, "result", result);
        this.update(task.id, { status: "succeeded", progress: 1, result });
        return true;
    }
    /** 已通过 WS 归档的中间产物；按 storageKey 去重，避免同文件存两份。 */
    private wsIntermediates(id: string) {
        const seen = new Set<string>();
        const out: Array<{ url: string; storageKey: string; mimeType: string; filename: string; nodeId: string }> = [];
        for (const event of this.tasks.events(id)) {
            if (event.type !== "intermediate") continue;
            const media = record(record(event.payload).media);
            const storageKey = String(media.storageKey || "");
            if (!storageKey || seen.has(storageKey)) continue;
            seen.add(storageKey);
            out.push({ url: String(media.url || ""), storageKey, mimeType: String(media.mimeType || "application/octet-stream"), filename: String(record(event.payload).filename || ""), nodeId: String(record(event.payload).nodeId || "") });
        }
        return out;
    }
    private listen(id: string, url: string, signal: AbortSignal, run: { config: RunConfig; outputNodes: string[] }) {
        let socket: WebSocket | undefined;
        let openTimer: ReturnType<typeof setTimeout> | undefined;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let closed = false;
        let attempt = 0;
        let lastProgressLogAt = 0;
        let lastProgressNode = "";
        const maxAttempts = 12;
        const active = () => !closed && !signal.aborted && this.tasks.get(id)?.status === "running";
        const clearOpenTimer = () => { if (openTimer) clearTimeout(openTimer); openTimer = undefined; };
        const scheduleRetry = () => {
            if (!active() || retryTimer || attempt >= maxAttempts) return;
            const waitMs = Math.min(4_000, 500 * 2 ** Math.min(attempt - 1, 3));
            retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, waitMs);
        };
        const close = () => {
            closed = true;
            clearOpenTimer();
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = undefined;
            if (socket) { socket.removeAllListeners(); socket.on("error", () => {}); socket.terminate(); }
            signal.removeEventListener("abort", close);
        };
        const receive = (raw: unknown, connectionAttempt: number) => {
            if (!active()) return;
            try {
                const message = JSON.parse(String(raw));
                const type = String(message.type || "unknown");
                if (type !== "progress") {
                    const serialized = JSON.stringify(message);
                    this.tasks.addEvent(id, "ws_message_received", {
                        attempt: connectionAttempt,
                        type,
                        ...(serialized.length <= 64_000 ? { message } : { messagePrefix: serialized.slice(0, 64_000), truncated: true, originalLength: serialized.length }),
                    });
                } else {
                    const node = String(message.data?.node || "");
                    const value = Number(message.data?.value), max = Number(message.data?.max);
                    const complete = Number.isFinite(value) && Number.isFinite(max) && max > 0 && value >= max;
                    const now = Date.now();
                    if (now - lastProgressLogAt >= 1_000 || node !== lastProgressNode || complete) {
                        const serialized = JSON.stringify(message);
                        this.tasks.addEvent(id, "ws_message_received", {
                            attempt: connectionAttempt,
                            type,
                            ...(serialized.length <= 64_000 ? { message } : { messagePrefix: serialized.slice(0, 64_000), truncated: true, originalLength: serialized.length }),
                        });
                        lastProgressLogAt = now;
                        lastProgressNode = node;
                    }
                }
                // 中间产物只走 WS 的 executed 消息，轮询结果里永远没有。
                if (message.type === "executed") {
                    const { nodeId, files } = parseWsExecuted(message);
                    this.tasks.addEvent(id, "ws_executed_received", {
                        nodeId,
                        fileCount: files.length,
                        files: files.map(({ field, filename, subfolder, type }) => ({ field, filename, subfolder, type })),
                        outputFields: Object.fromEntries(WS_OUTPUT_FIELDS.map((field) => [field, Array.isArray(record(record(message.data).output)[field]) ? record(record(message.data).output)[field].length : 0])),
                    });
                    // 指定输出节点时只收选中节点的中间产物；没指定就全收。
                    if (run.outputNodes.length && !run.outputNodes.includes(nodeId)) return;
                    const pending = this.wsDownloads.get(id) || new Set<Promise<void>>();
                    this.wsDownloads.set(id, pending);
                    const download = this.collectWsOutputs(id, run.config, url, nodeId, files, signal);
                    pending.add(download);
                    void download.finally(() => pending.delete(download));
                    return;
                }
                if (message.type === "execution_error") {
                    const data = record(message.data);
                    const exceptionMessage = String(data.exception_message || "").slice(0, 500);
                    const exceptionType = String(data.exception_type || "").slice(0, 200);
                    const traceback = (Array.isArray(data.traceback) ? data.traceback : typeof data.traceback === "string" ? [data.traceback] : [])
                        .map(String).slice(0, 5).join("\n").slice(0, 1_500);
                    this.tasks.addEvent(id, "ws_execution_error", {
                        node: String(data.node_id || data.node || "").slice(0, 100),
                        nodeName: String(data.node_name || "").slice(0, 160),
                        nodeType: String(data.node_type || "").slice(0, 160),
                        exceptionMessage,
                        exceptionType,
                        exception: (exceptionMessage || exceptionType).slice(0, 500),
                        ...(traceback ? { traceback: redact(traceback, run.config) } : {}),
                    });
                    return;
                }
                if (message.type !== "progress") return;
                const value = Number(message.data?.value); const max = Number(message.data?.max);
                if (Number.isFinite(value) && Number.isFinite(max) && max > 0) this.update(id, { progress: Math.max(this.tasks.get(id)?.progress || 0, Math.min(0.95, value / max * 0.9 + 0.05)) });
            } catch (error) {
                const rawText = String(raw);
                this.tasks.addEvent(id, "ws_message_unparsed", {
                    attempt: connectionAttempt,
                    reason: redact(error instanceof Error ? error.message : String(error), run.config),
                    rawPrefix: rawText.slice(0, 8_000),
                    truncated: rawText.length > 8_000,
                });
            }
        };
        const connect = () => {
            if (!active() || attempt >= maxAttempts) return;
            attempt += 1;
            const connectionAttempt = attempt;
            let opened = false;
            this.tasks.addEvent(id, "progress_channel_connecting", { attempt: connectionAttempt, url });
            let current: WebSocket;
            try { current = new WebSocket(url); socket = current; }
            catch (error) {
                this.tasks.addEvent(id, "progress_channel_unavailable", { attempt: connectionAttempt, reason: redact(error instanceof Error ? error.message : String(error), run.config), fallback: "poll" });
                scheduleRetry();
                return;
            }
            openTimer = setTimeout(() => {
                if (opened || !active() || socket !== current) return;
                this.tasks.addEvent(id, "progress_channel_unavailable", { attempt: connectionAttempt, reason: "connection_timeout", fallback: "poll" });
                clearOpenTimer();
                current.removeAllListeners();
                current.on("error", () => {});
                current.terminate();
                scheduleRetry();
            }, 10_000);
            current.on("open", () => {
                opened = true;
                clearOpenTimer();
                this.tasks.addEvent(id, "progress_channel_connected", { attempt: connectionAttempt });
            });
            current.on("error", (error) => {
                clearOpenTimer();
                this.tasks.addEvent(id, "progress_channel_unavailable", { attempt: connectionAttempt, reason: redact(error instanceof Error ? error.message : String(error), run.config), fallback: "poll" });
                scheduleRetry();
            });
            current.on("close", (code) => {
                clearOpenTimer();
                if (active()) {
                    this.tasks.addEvent(id, "progress_channel_closed", { attempt: connectionAttempt, code });
                    scheduleRetry();
                }
            });
            current.on("message", (raw) => receive(raw, connectionAttempt));
        };
        signal.addEventListener("abort", close, { once: true });
        connect();
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
    private async collectWsOutputs(id: string, config: RunConfig, netWssUrl: string, nodeId: string, files: Array<{ field: string; filename: string; subfolder: string; type: string; downloadUrl?: string }>, signal: AbortSignal) {
        if (!this.media) {
            this.tasks.addEvent(id, "intermediate_download_failed", { nodeId, reason: "media_archive_unavailable" });
            return;
        }
        for (const file of files) {
            let reason = "no_download_url";
            const attempts: Array<{ round: number; host: string; url: string; status: string }> = [];
            const urls = [...new Set([file.downloadUrl, ...buildWsFileUrls(config.baseUrl, netWssUrl, file)].filter((value): value is string => Boolean(value)))];
            let archived = false;
            for (const [round, waitMs] of WS_FILE_RETRY_DELAYS_MS.entries()) {
                if (waitMs) {
                    try { await delay(waitMs, signal); }
                    catch { return; }
                }
                let retryable = false;
                for (const url of urls) {
                    const host = new URL(url).host;
                    try {
                        const response = await fetch(url, { signal });
                        if (!response.ok) {
                            reason = `HTTP ${response.status}`;
                            attempts.push({ round: round + 1, host, url, status: String(response.status) });
                            if (response.status === 404 || response.status >= 500) retryable = true;
                            continue;
                        }
                        if (!response.body) {
                            reason = "empty_response_body";
                            attempts.push({ round: round + 1, host, url, status: reason });
                            retryable = true;
                            continue;
                        }
                        const header = response.headers.get("content-type") || "";
                        const media = await this.media.storeStream(Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream), {
                            name: file.filename,
                            category: "output",
                            resolveMimeType: (prefix, bytes) => runningHubMediaType({ prefix, bytes }, header, file.filename),
                        });
                        if (media.bytes <= WS_MIN_FILE_BYTES) {
                            this.media.delete(media.storageKey);
                            reason = `response_too_small:${media.bytes}`;
                            attempts.push({ round: round + 1, host, url, status: reason });
                            retryable = true;
                            continue;
                        }
                        this.tasks.addEvent(id, "intermediate", { nodeId, field: file.field, filename: file.filename, media: { url: this.media.url(media), storageKey: media.storageKey, mimeType: media.mimeType, bytes: media.bytes } });
                        reason = "";
                        archived = true;
                        break;
                    } catch (error) {
                        if (signal.aborted) return;
                        reason = redact(error instanceof Error ? error.message : String(error), config).slice(0, 300);
                        attempts.push({ round: round + 1, host, url, status: "network_or_decode_error" });
                        retryable = true;
                    }
                }
                if (archived || !retryable) break;
            }
            if (reason) this.tasks.addEvent(id, "intermediate_download_failed", { nodeId, field: file.field, filename: file.filename, reason, attempts });
            else if (attempts.length) this.tasks.addEvent(id, "intermediate_download_retried", { nodeId, field: file.field, filename: file.filename, recovered: true, attempts });
        }
    }
    private async materialize(items: Json[], signal: AbortSignal, onFailure?: (nodeId: string, reason: string, url: string) => void, config?: RunningHubConfig) {
        if (!this.media) throw new Error("RunningHub 媒体归档服务不可用");
        const outputs: Array<{ url: string; storageKey: string; mimeType: string; filename: string; bytes: number; nodeId?: string }> = [];
        const seen = new Set<string>();
        for (const item of items) {
            const nodeId = String(item.nodeId || "");
            let source = "";
            try {
                source = String(item.url || item.fileUrl || item.downloadUrl || "");
                if (!source) {
                    if (!item.text) onFailure?.(nodeId, "missing_result_url", source);
                    continue;
                }
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
                outputs.push({ url: this.media.url(media), storageKey: media.storageKey, mimeType: media.mimeType, filename: name, bytes: media.bytes, ...(nodeId ? { nodeId } : {}) });
            } catch (error) {
                if (signal.aborted) throw error;
                if (!onFailure) throw error;
                const reason = redact(error instanceof Error ? error.message : String(error), config || this.getConfig()).slice(0, 500);
                onFailure?.(nodeId, reason, source);
            }
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
        const site = normalizeSite(params.runninghubSite);
        const config = this.siteConfig(site);
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
        const config = this.runs.get(id) || this.getConfig();
        const rawMessage = redact(error instanceof Error ? error.message : String(error), config);
        const message = this.describeFailure(id, rawMessage, config);
        this.tasks.addEvent(id, "error", { error: message });
        this.update(id, { status: "failed", error: message });
    }
    private describeFailure(id: string, message: string, config: RunConfig) {
        const genericFailure = /^(?:工作流运行失败|Workflow run failed|RunningHub workflow failed|RunningHub 任务(?:FAILED|FAIL|ERROR))$/i.test(message.trim());
        if (!genericFailure) return message;
        const events = this.tasks.events(id);
        const executionError = [...events].reverse().find((event) => event.type === "ws_execution_error");
        const detail = record(executionError?.payload);
        const rawErrorEvent = [...events].reverse().find((event) => event.type === "ws_message_received" && record(event.payload).type === "execution_error");
        const rawData = record(record(record(rawErrorEvent?.payload).message).data);
        const nodeId = String(detail.node || rawData.node_id || rawData.node || "").trim();
        const nodeName = String(detail.nodeName || rawData.node_name || "").trim();
        const nodeType = String(detail.nodeType || rawData.node_type || "").trim();
        const exceptionMessage = String(detail.exceptionMessage || detail.exception || rawData.exception_message || "").trim();
        const exceptionType = String(detail.exceptionType || rawData.exception_type || "").trim();
        const tracebackValue = detail.traceback || rawData.traceback;
        const traceback = (Array.isArray(tracebackValue) ? tracebackValue.map(String).slice(0, 5).join("\n") : String(tracebackValue || "")).trim();
        const submitted = [...events].reverse().find((event) => event.type === "submitted");
        const remoteTaskId = String(config.remoteId || submitted?.payload.taskId || "").trim();
        if (!executionError && !rawErrorEvent) return remoteTaskId ? `${message}\nRunningHub 任务 ID：${remoteTaskId}` : message;
        const nodeLabel = [nodeName, nodeType && nodeType !== nodeName ? nodeType : ""].filter(Boolean).join(" · ");
        const lines = ["RunningHub 工作流执行失败"];
        lines.push(`失败节点：${nodeLabel || "平台未返回节点名称"}${nodeId ? `（节点 ${nodeId}）` : ""}`);
        if (exceptionMessage) lines.push(`原因：${exceptionMessage}`);
        if (exceptionType && exceptionType !== exceptionMessage) lines.push(`错误类型：${exceptionType}`);
        if (traceback) lines.push(`节点诊断：\n${redact(traceback, config)}`);
        if (remoteTaskId) lines.push(`RunningHub 任务 ID：${remoteTaskId}`);
        return lines.join("\n");
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
    return (new RunningHubBackend(fakeTasks(), fakeSettings()) as never as { resolveFields(t: unknown, c: unknown, signal: AbortSignal): Promise<{ values: Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>; omittedInputs: Array<{ nodeId: string; fieldName: string; kind: "image" | "video" | "audio" }> }> })
        .resolveFields(task, merged, new AbortController().signal).then((resolved) => resolved.values);
};
function fakeTasks(): TaskStore {
    return { list: () => [], get: () => undefined } as unknown as TaskStore;
}
function fakeSettings(): SettingStore {
    const store = new Map<string, unknown>();
    return { get: (key) => store.get(key), set: (key, value) => void store.set(key, value), delete: (key) => void store.delete(key) };
}
/** 任务参数里随上传带到云端的本地图；不是 ComfyUI API 格式时当作没带。 */
export function localGraphOf(params: Record<string, unknown>): Json | null {
    const graph = record(params.runninghubGraph);
    return Object.values(graph).some((node) => record(node).class_type) ? graph : null;
}

function safeFileName(value: string) {
    const safe = value.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    return safe || "runninghub-workflow";
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
    const files: Array<{ field: string; filename: string; subfolder: string; type: string; downloadUrl?: string }> = [];
    for (const field of WS_OUTPUT_FIELDS) for (const item of (record(output)[field] as Json[] | undefined) || []) {
        const filename = String(item?.filename || "");
        if (!filename || isWsNoiseFile(filename)) continue;
        const downloadUrl = String(item?.cos_url || item?.fileUrl || item?.url || "");
        files.push({ field, filename, subfolder: String(item?.subfolder || ""), type: String(item?.type || "output"), ...(downloadUrl ? { downloadUrl } : {}) });
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
    const query = `filename=${enc(file.filename)}&type=${enc(file.type || "output")}&subfolder=${enc(file.subfolder)}&Rh-Comfy-Auth=${encStrict(auth || "")}${userId ? `&Rh-Identify=${encStrict(userId)}` : ""}&rand=${Date.now()}`;
    if (auth) urls.push(`${baseUrl}/view?${query}`);
    // RunningHub exposes the task's ComfyUI worker in the WSS URL's target field.
    // Try its local view route too: a failed workflow can have a generated file on
    // the worker before the public view/CDN has copied it to persistent storage.
    const target = qs.get("target");
    if (auth && target) {
        try {
            const targetUrl = new URL(target);
            const hostname = targetUrl.hostname.toLowerCase();
            const trustedHost = hostname.endsWith(".runninghub.cn") || hostname === "runninghub.cn" || hostname.endsWith(".runninghub.ai") || hostname === "runninghub.ai";
            if (targetUrl.protocol === "https:" && trustedHost && !targetUrl.username && !targetUrl.password) {
                const targetBase = `${targetUrl.origin}${targetUrl.pathname.replace(/\/$/, "")}`;
                const publicBase = new URL(baseUrl).origin;
                if (targetBase !== publicBase) urls.push(`${targetBase}/view?${query}`);
            }
        } catch {}
    }
    if (userId) urls.push(["https://rh-images.xiaoyaoyou.com", userId, encStrict(file.type || "output"), ...(file.subfolder ? [encStrict(file.subfolder)] : []), enc(file.filename)].join("/"));
    return urls;
}

/** `/view` 鉴权过期会返回 200 的 HTML 错误页，体积过小的一律不认（报告 §9 坑 5）。 */
export const WS_MIN_FILE_BYTES = 200;

/** WS 中间产物与轮询成品可能各归档一次；按 RH 节点和文件名识别同一远端文件。 */
function dedupeByStorageKey<T extends { storageKey: string; filename?: string; nodeId?: string }>(items: T[]) {
    const seen = new Set<string>();
    return items.filter((item) => {
        const identity = item.filename ? `remote:${item.nodeId || ""}:${item.filename}` : `storage:${item.storageKey}`;
        if (seen.has(identity) || seen.has(`storage:${item.storageKey}`)) return false;
        seen.add(identity);
        seen.add(`storage:${item.storageKey}`);
        return true;
    });
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
export function patchRunningHubWorkflow(graph: Json, fields: Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>, omittedInputs: Array<{ nodeId: string; fieldName: string; kind: "image" | "video" | "audio" }> = []) {
    const next = structuredClone(graph);
    for (const field of fields) {
        const inputs = next[field.nodeId]?.inputs;
        if (!inputs || !Object.hasOwn(inputs, field.fieldName)) throw new Error(`RunningHub 工作流输入不存在：${field.nodeId}.${field.fieldName}；请重新同步映射`);
        if (isRunningHubLinkValue(inputs[field.fieldName])) throw new Error(`RunningHub 输入 ${field.nodeId}.${field.fieldName} 是连线，不可覆写；请重新读取节点图`);
        inputs[field.fieldName] = field.fieldValue;
    }
    const removedNodeIds = new Set<string>();
    for (const omitted of omittedInputs) {
        const node = next[omitted.nodeId];
        if (!node) continue;
        const classType = String(node.class_type || "");
        const isMediaLoader = omitted.kind === "image" ? /LoadImage/i.test(classType) && omitted.fieldName === "image"
            : omitted.kind === "audio" ? /LoadAudio/i.test(classType) && omitted.fieldName === "audio"
                : /LoadVideo/i.test(classType) && /video|file/i.test(omitted.fieldName);
        if (isMediaLoader) removedNodeIds.add(omitted.nodeId);
        else delete record(node.inputs)[omitted.fieldName];
    }
    if (removedNodeIds.size) {
        for (const [nodeId, raw] of Object.entries(next)) {
            if (removedNodeIds.has(nodeId)) continue;
            const inputs = record(record(raw).inputs);
            for (const [name, value] of Object.entries(inputs)) {
                if (isRunningHubLinkValue(value) && removedNodeIds.has(String(value[0]))) delete inputs[name];
            }
        }
        for (const nodeId of removedNodeIds) delete next[nodeId];
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
/** The task-output endpoint returns `data` as an array rather than `data.results`. */
export function normalizeRunningHubOutputs(response: Json): Json[] {
    if (Array.isArray(response.data)) return response.data as Json[];
    const data = record(response.data || response);
    if (Array.isArray(data.results)) return data.results as Json[];
    if (Array.isArray(data.outputs)) return data.outputs as Json[];
    return [];
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
