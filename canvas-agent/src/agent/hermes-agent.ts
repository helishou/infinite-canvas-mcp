import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Ajv } from "ajv";
import matter from "gray-matter";

import { AGENT_PROMPT } from "../config.js";
import { logger } from "../utils/logger.js";
import { ensureCanvasProfile, HERMES_CANVAS_PROFILE, hermesCommand } from "./hermes-client.js";
import { errorMessage, field, type JsonRecord } from "../utils/value.js";
import { configuredAgentChannels, type AgentChannelModel } from "./agent-channels.js";
import { HERMES_THREAD_PREFIX, HermesAcpClient, isHermesThread } from "./hermes-client.js";
import type { AgentAttachment, AgentEmit, AgentPermissionMode } from "./types.js";

export { isHermesThread, HERMES_THREAD_PREFIX };

export type HermesSettings = { get(key: string): unknown; set(key: string, value: unknown): void };
type ChatMessage = { id: string; itemId: string; threadId: string; turnId: string; role: "user" | "assistant" | "tool" | "error"; title?: string; text: string; detail?: unknown };
type HermesTurn = { id: string; status: "running" | "completed" | "failed" | "interrupted"; prompt: string; display: ChatMessage[]; error?: string; usage?: JsonRecord };
type HermesThread = { version: 1; id: string; sessionId: string; cwd: string; model: string; preview: string; createdAt: number; updatedAt: number; archived?: boolean; silent?: boolean; turns: HermesTurn[] };

const threadKey = (id: string) => `agent.hermes.thread:${id}`;
// 画布用专用 profile：技能列表与开关写入同一套配置，不与主配置的自定义技能混用。
// profile 的技能目录在 $HERMES_HOME/profiles/<name>/skills；~/.codex/skills 是 Codex 的，别拿错。
const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
const userSkills = path.join(hermesHome, "profiles", HERMES_CANVAS_PROFILE, "skills");
const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * 导演对话的 Hermes 运行时。
 *
 * 与已删除的「自定义任意模型」那套的区别：这里不再自建工具循环、不再拼 OpenAI/Gemini 请求，
 * 而是把一轮对话交给 `hermes acp`——Hermes 自己加载 MCP（本轮会把画布 MCP 作为 session 级
 * server 传进去）、skills、memory，canvas 只负责会话映射与事件转发。
 */
export class HermesAgent {
    private client?: Promise<HermesAcpClient>;
    private permissionMode: () => AgentPermissionMode = () => "request";
    private spare: { sessionId: string; cwd: string } | null = null;
    private disabledCache: { names: Set<string>; at: number } | null = null;
    private spareTask: Promise<void> | null = null;
    private readonly sessions = new Map<string, { sessionId: string; model: string }>();
    private active?: { thread: HermesThread; turn: HermesTurn; emit: AgentEmit; messageText: string; itemId: string };

    constructor(private settings: HermesSettings, private backendUrl: string, private backendToken: string) {}

    providers(): AgentChannelModel[] { return configuredAgentChannels(this.settings.get("ai.config")); }

    provider(id?: string) {
        const providers = this.providers();
        const selected = String(id || "").trim() || this.defaultModel();
        return providers.find((provider) => provider.id === selected || provider.model === selected);
    }

    defaultModel() {
        const config = isRecord(this.settings.get("ai.config")) ? this.settings.get("ai.config") as JsonRecord : {};
        const saved = isRecord(this.settings.get("frontend.settings")) ? this.settings.get("frontend.settings") as JsonRecord : {};
        const providers = this.providers();
        return String(providers.find((provider) => provider.id === saved.agentModel)?.id || providers.find((provider) => provider.id === config.textModel)?.id || providers[0]?.id || "");
    }

    /** 模型下拉：渠道行（codex-cli / hermes）+ 各自原生能力描述。 */
    models(nativeModels: JsonRecord[] = []) {
        const defaultModel = this.defaultModel();
        return {
            data: this.providers().map((provider) => {
                const native = provider.kind === "codex-cli" ? nativeModels.find((model) => String(model.model || "") === provider.model) : undefined;
                return {
                    id: provider.id,
                    model: provider.id,
                    displayName: provider.name,
                    defaultReasoningEffort: String(native?.defaultReasoningEffort || ""),
                    supportedReasoningEfforts: (native?.supportedReasoningEfforts as unknown[]) || [],
                    isDefault: provider.id === defaultModel,
                    runtime: provider.kind === "codex-cli" ? "codex" : "hermes",
                };
            }),
        };
    }

    codexThreadModel(id: string) {
        const model = this.settings.get(`agent.codex.channel-model:${id}`);
        return typeof model === "string" && this.providers().some((provider) => provider.id === model && provider.kind === "codex-cli") ? model : undefined;
    }

    rememberCodexThread(id: string, model: string) { this.settings.set(`agent.codex.channel-model:${id}`, model); }

    delegationModel(parentThreadId: string, requested?: string) {
        const parentModel = isHermesThread(parentThreadId) ? this.load(parentThreadId).model : this.codexThreadModel(parentThreadId);
        return parentModel || requested || this.defaultModel();
    }

    nativeWorkerModel(model?: string, threadId?: string) {
        if (threadId && !isHermesThread(threadId) && !model) return undefined;
        if (model && !model.includes("::")) return model;
        if (threadId && isHermesThread(threadId)) return model;
        const provider = this.provider(model || this.defaultModel());
        if (!provider) return undefined;
        return provider.kind === "codex-cli" ? provider.model : provider.id;
    }

    private index(): string[] {
        const value = this.settings.get("agent.hermes.index");
        if (value == null) return [];
        if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !isHermesThread(id))) throw new Error("Hermes 会话索引格式不支持，保留原数据");
        return value as string[];
    }

    private load(id: string, cwd?: string): HermesThread {
        const value = this.settings.get(threadKey(id)) as HermesThread | null;
        if (!value || value.version !== 1 || value.id !== id || !Array.isArray(value.turns)) throw new Error("Hermes 会话不存在或格式不支持");
        if (cwd && path.resolve(value.cwd).toLowerCase() !== path.resolve(cwd).toLowerCase()) throw new Error("对话不属于当前工作空间");
        return structuredClone(value);
    }

    private save(thread: HermesThread) { thread.updatedAt = Date.now() / 1000; this.settings.set(threadKey(thread.id), thread); }

    private summary(thread: HermesThread) {
        return { id: thread.id, cwd: thread.cwd, model: thread.model, preview: thread.preview, createdAt: thread.createdAt, updatedAt: thread.updatedAt, status: thread.turns.at(-1)?.status || "idle", source: "hermes" };
    }

    private async connection(): Promise<HermesAcpClient> {
        if (!this.client) {
            // 失败必须清掉缓存的 Promise：否则首次初始化失败会被永久重放，之后每次调用都只拿到同一条旧错误。
            this.client = HermesAcpClient.start((type, payload) => this.dispatch(type, payload), () => this.permissionMode(), () => { this.client = undefined; this.sessions.clear(); })
                .catch((error) => { this.client = undefined; this.sessions.clear(); throw error; });
        }
        return await this.client;
    }

    /** 单一事件出口：转发给当前回合的网页，同时把「展示用消息」累积进线程历史。 */
    private dispatch(type: string, payload: unknown) {
        const active = this.active;
        if (!active) return;
        const value = isRecord(payload) ? payload : {};
        if (type === "agent_event") {
            const item = (isRecord(value.item) ? (isRecord((value.item as JsonRecord).item) ? (value.item as JsonRecord).item : value.item) : {}) as JsonRecord;
            const kind = String(item.type || "");
            if (kind === "agent_message") {
                const delta = String(item.delta ?? "");
                const text = String(item.text ?? "");
                if (delta) active.messageText += delta;
                if (value.type === "item.completed" && text.trim()) {
                    active.turn.display.push(this.display(active.thread.id, active.turn.id, String(item.id || active.itemId), "assistant", text.trim()));
                }
            } else if (kind === "mcp_tool_call") {
                const toolId = String(item.id || crypto.randomUUID());
                if (value.type === "item.started") {
                    active.turn.display.push(this.display(active.thread.id, active.turn.id, toolId, "tool", String(item.tool || ""), String(item.tool || ""), item));
                } else if (value.type === "item.completed") {
                    const existing = active.turn.display.find((message) => message.itemId === toolId);
                    if (existing) existing.detail = item;
                    else active.turn.display.push(this.display(active.thread.id, active.turn.id, toolId, "tool", String(item.tool || ""), String(item.tool || ""), item));
                }
            }
            // 推理不再写进历史：实时流已经渲染成活动卡片，存成 tool 消息会在历史里再出现一份，
            // 渲染器还把标题「推理」画成等宽工具块，看着就是「两个推理」。
        }
        active.emit(type, payload);
    }

    startThread(cwd: string, model?: string, silent = false) {
        const provider = this.provider(model || this.defaultModel());
        if (provider && provider.kind !== "hermes") throw new Error("Codex CLI 渠道请新建原生 Codex 对话");
        const id = `${HERMES_THREAD_PREFIX}${crypto.randomUUID()}`;
        const thread: HermesThread = { version: 1, id, sessionId: "", cwd, model: provider?.id || String(model || ""), preview: "", createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000, turns: [], silent };
        this.save(thread);
        this.settings.set("agent.hermes.index", [...this.index(), id]);
        return this.summary(thread);
    }

    list(cwd: string, searchTerm = "") {
        const threads: ReturnType<HermesAgent["summary"]>[] = [];
        for (const id of this.index()) {
            try {
                const thread = this.load(id);
                if (thread.silent || thread.archived) continue;
                if (path.resolve(thread.cwd).toLowerCase() !== path.resolve(cwd).toLowerCase()) continue;
                if (searchTerm && !thread.preview.toLowerCase().includes(searchTerm.toLowerCase())) continue;
                threads.push(this.summary(thread));
            } catch { /* 索引里残留的无效行不阻塞列表 */ }
        }
        return { data: threads.sort((a, b) => b.updatedAt - a.updatedAt), nextCursor: null };
    }

    read(id: string, cwd?: string) {
        const thread = this.load(id, cwd);
        let changed = false;
        for (const turn of thread.turns) if (turn.status === "running") {
            turn.status = "interrupted";
            turn.error = "Agent 进程在中途被中断，本轮未完成；工具可能已执行，请核对回执和任务后再继续，未自动重跑";
            turn.display.push(this.display(thread.id, turn.id, "interruption", "tool", turn.error, "进程中断"));
            changed = true;
        }
        if (changed) this.save(thread);
        return { thread: this.summary(thread), messages: thread.turns.flatMap((turn) => turn.display), settledTurnIds: thread.turns.filter((turn) => turn.status !== "running").map((turn) => turn.id), historyReady: true };
    }

    archive(id: string, cwd: string) { const thread = this.load(id, cwd); thread.archived = true; this.save(thread); }

    async prepare(id: string, cwd: string, emit: AgentEmit) {
        this.read(id, cwd);
        const client = await this.connection();
        const thread = this.load(id, cwd);
        await this.ensureSession(client, thread);
        emit("agent_bootstrap", { type: "mcp.complete", phase: "preheat", threadId: id, services: [{ name: "infinite-canvas", authStatus: "session" }] });
        return this.read(id, cwd);
    }

    /** 预热 ACP 进程，并预建一个备用会话：Hermes 侧建会话约 3.8 秒，放在后台先做掉。 */
    async warm(cwd?: string) {
        await this.connection();
        if (cwd) this.replenishSpare(cwd);
        return true;
    }

    /** 后台补一个备用 ACP 会话（带画布 MCP），新建对话时直接认领，省掉一次 session/new。 */
    private replenishSpare(cwd: string) {
        if (this.spare || this.spareTask) return;
        this.spareTask = (async () => {
            try {
                const client = await this.connection();
                const created = await client.newSession(cwd, undefined, this.canvasMcpServers());
                if (!this.spare) this.spare = { sessionId: created.acpSessionId, cwd };
                else logger.debug("Hermes 备用会话已建但未被认领，留在 Hermes 侧由它自行回收", { sessionId: created.acpSessionId });
            } catch (error) {
                logger.warn("Hermes 备用会话创建失败", { error: errorMessage(error) });
            } finally {
                this.spareTask = null;
            }
        })();
    }

    /** Hermes 可用模型目录（供渠道编辑器挑模型）。 */
    async catalog(cwd: string) {
        const client = await this.connection();
        return await client.catalog(cwd);
    }

    interrupt(id?: string) {
        const targets = id ? [id] : [...this.sessions.keys()];
        let cancelled = false;
        for (const threadId of targets) {
            const session = this.sessions.get(threadId);
            if (!session) continue;
            void this.client?.then((client) => client.cancel(session.sessionId)).catch((error) => logger.warn("Failed to cancel Hermes turn", { threadId, error: errorMessage(error) }));
            cancelled = true;
        }
        return cancelled;
    }

    resolveApproval(requestId: string, decision: string) {
        void this.client?.then((client) => client.resolveApproval(requestId, decision)).catch(() => undefined);
        return true;
    }

    private canvasMcpServers() {
        return [{ type: "http", name: "infinite-canvas", url: new URL("/mcp", this.backendUrl).toString(), headers: [{ name: "authorization", value: `Bearer ${this.backendToken}` }] }];
    }

    /** 载入（resume）把旧会话接回来失败时，给用户看的原因——不能静默换会话，否则历史像凭空消失。 */
    private resetReason(error: unknown) {
        const text = errorMessage(error);
        if (text.includes("acp_mcp_policy_conflict")) return "画布 MCP 规格变了（backend token 或地址与建立对话时不同）";
        if (text.includes("launch_credentials_unavailable")) return "Hermes 网关重启后丢掉了建立对话时的编辑器 MCP 规格";
        if (/not[_ ]?found/i.test(text)) return "Hermes 侧的会话记录已经不在了（被删除或归档）";
        return `载入会话失败：${text}`;
    }

    private async ensureSession(client: HermesAcpClient, thread: HermesThread, onReset?: (reason: string) => void) {
        const existing = this.sessions.get(thread.id);
        if (existing) return existing;
        const mcpServers = this.canvasMcpServers();
        // 备用会话命中：cwd 一致就直接认领，跳过 3.8 秒的 session/new，然后后台再补一个。
        if (this.spare && this.spare.cwd === thread.cwd) {
            const spare = this.spare;
            this.spare = null;
            thread.sessionId = spare.sessionId;
            this.save(thread);
            // model 记空：备用会话是按 Hermes 默认模型建的，第一轮由 run() 显式 setModel 到用户选的模型。
            const session = { sessionId: spare.sessionId, model: "" };
            this.sessions.set(thread.id, session);
            this.replenishSpare(thread.cwd);
            return session;
        }
        if (thread.sessionId) {
            try {
                // 带上编辑器 MCP 规格：网关重启后只有指纹落盘，规格必须由客户端补交，
                // 否则那一轮会报「此聊天的 API 密钥已更改」(launch_credentials_unavailable)。
                await client.loadSession(thread.sessionId, thread.cwd, mcpServers);
                const session = { sessionId: thread.sessionId, model: thread.model };
                this.sessions.set(thread.id, session);
                return session;
            } catch (error) {
                logger.warn("Hermes session load failed, starting a new one", { threadId: thread.id, error: errorMessage(error) });
                onReset?.(this.resetReason(error));
            }
        }
        const created = await client.newSession(thread.cwd, this.acpModel(thread.model) || undefined, mcpServers);
        thread.sessionId = created.acpSessionId;
        this.save(thread);
        const session = { sessionId: created.acpSessionId, model: thread.model };
        this.sessions.set(thread.id, session);
        return session;
    }

    /** 渠道 id `channel::model` → ACP modelId（Hermes 用冒号：`provider:model`）。 */
    private acpModel(channelModelId: string) {
        const provider = this.provider(channelModelId);
        if (!provider) return "";
        return provider.kind === "hermes" ? provider.model.replace(/::/g, ":") : "";
    }

    async run(prompt: string, lifecycleEmit: AgentEmit, attachments: AgentAttachment[], options: { threadId?: string; cwd?: string; model?: string; effort?: string; skill?: { name: string; path: string }; messageText?: string; appEmit?: AgentEmit; onStart?: () => void; onThread?: (id: string) => void; onTurn?: (id: string) => void; onFinish?: () => void; permissionMode?: AgentPermissionMode } = {}, projectId?: string) {
        const emit = options.appEmit || lifecycleEmit;
        const threadId = options.threadId || "";
        const thread = this.load(threadId, options.cwd);
        if (thread.turns.at(-1)?.status === "running") throw new Error("当前 Agent 对话已有运行中的任务");
        this.permissionMode = () => options.permissionMode || "request";
        const provider = this.provider(options.model || thread.model);
        if (!provider || provider.kind !== "hermes") throw new Error("该对话不是 Hermes 渠道，请新建对话");
        if (provider.id !== thread.model) thread.model = provider.id;
        const turn: HermesTurn = { id: crypto.randomUUID(), status: "running", prompt: options.messageText || prompt, display: [this.display(thread.id, "", "synthetic:user", "user", options.messageText || prompt)] };
        thread.turns.push(turn);
        thread.preview ||= options.messageText || prompt;
        this.save(thread);
        options.onStart?.();
        options.onThread?.(thread.id);
        options.onTurn?.(turn.id);
        const itemId = crypto.randomUUID();
        this.active = { thread, turn, emit: (type, payload) => lifecycleEmit(type, payload), messageText: "", itemId };
        try {
            const client = await this.connection();
            const session = await this.ensureSession(client, thread, (reason) => {
                // 旧会话接不回来、已经换成新会话继续：必须留下可见痕迹，
                // 否则用户只会看到模型「失忆」，却不知道为什么。
                const notice = this.display(thread.id, turn.id, "synthetic:context-reset", "tool",
                    `这条对话的 Hermes 侧上下文已重置：${reason}。画布里的消息与产物都还在，只是模型看不到重置前的对话内容；需要的话把要点重发一次。`,
                    "上下文已重置");
                turn.display.push(notice);
                emit("chat_message", { threadId: thread.id, turnId: turn.id, message: notice });
            });
            const wanted = this.acpModel(thread.model);
            if (wanted && session.model !== thread.model) {
                await client.setModel(session.sessionId, wanted);
                session.model = thread.model;
            }
            const instructions = [`${AGENT_PROMPT}`, `导演委派上下文：parentThreadId=${thread.id}，parentTurnId=${turn.id}，projectId=${projectId || "未绑定"}。调用 director_subagent 时使用这些身份；子代理只返回建议，结果由你核对后保存。`, "画布工具通过本次会话的 infinite-canvas MCP 提供；写操作前先用 production_get_* / h3_get_* 读当前状态，不要凭记忆。"].join("\n\n");
            const skillText = options.skill ? `\n\n本轮用户调用的 Skill：\n${await fs.readFile(options.skill.path, "utf8")}` : "";
            const result = await client.prompt(session.sessionId, `${instructions}\n\n${prompt}${skillText}`, attachmentDataUrls(attachments), thread.id, turn.id);
            turn.status = result.status === "interrupted" ? "interrupted" : "completed";
            if (result.usage) turn.usage = result.usage;
            if (!turn.display.some((message) => message.role === "assistant")) {
                const text = result.text || this.active.messageText;
                if (text.trim()) turn.display.push(this.display(thread.id, turn.id, itemId, "assistant", text.trim()));
            }
            return result;
        } catch (error) {
            turn.status = "failed";
            turn.error = errorMessage(error);
            turn.display.push(this.display(thread.id, turn.id, "synthetic:error", "error", turn.error));
            emit("agent_error", { message: turn.error, threadId: thread.id, turnId: turn.id });
            throw error;
        } finally {
            this.active = undefined;
            this.save(thread);
            emit("agent_done", { agent: "hermes", threadId: thread.id, turnId: turn.id, status: turn.status, ...(turn.usage ? { usage: turn.usage } : {}) });
            options.onFinish?.();
        }
    }

    /** 结构化产出（子代理 / 技能草稿）：同一个 ACP 会话里要求严格 JSON 并校验。 */
    async structured(request: { cwd: string; prompt: string; schema: JsonRecord; model?: string; effort?: string; threadId?: string; turnId?: string; recoverOutput?: boolean; historyVisible?: boolean; historyTitle?: string; images?: string[]; readRoots?: string[]; onThread: (id: string) => void; onTurn?: (id: string) => void; permissionMode?: AgentPermissionMode }) {
        const validate = new Ajv({ strict: false, allErrors: true }).compile(request.schema);
        const threadId = request.threadId || this.startThread(request.cwd, request.model, !request.historyVisible).id;
        const thread = this.load(threadId, request.cwd);
        if (request.historyVisible) {
            let changed = false;
            if (thread.silent) { thread.silent = false; changed = true; }
            if (request.historyTitle && !thread.preview) { thread.preview = request.historyTitle; changed = true; }
            if (changed) this.save(thread);
        }
        if (!request.threadId) request.onThread(threadId);
        if (request.recoverOutput) {
            const turn = thread.turns.at(-1);
            const last = turn?.display.filter((message) => message.role === "assistant").at(-1)?.text;
            if (!turn || turn.id !== request.turnId || turn.status !== "completed" || !last) throw new Error("AGENT_RECOVERY_REQUIRED: 原 Hermes 回合没有可恢复的完整结果，未自动重跑");
            return { threadId, output: parseValidated(last, validate) };
        }
        this.permissionMode = () => request.permissionMode || "request";
        const turn: HermesTurn = { id: crypto.randomUUID(), status: "running", prompt: request.prompt, display: [] };
        thread.turns.push(turn);
        this.save(thread);
        request.onTurn?.(turn.id);
        const itemId = crypto.randomUUID();
        this.active = { thread, turn, emit: () => undefined, messageText: "", itemId };
        try {
            const client = await this.connection();
            const instruction = `严格只输出一个 JSON（不要代码块、不要解释），必须符合 JSON Schema：\n${JSON.stringify(request.schema)}`;
            const images = await Promise.all((request.images || []).map((file) => fileDataUrl(file)));
            // ACP 会话在网关/backend 重载后会失效（备用会话认领了坏 sessionId），
            // prompt 抛 Internal error / not found / launch_credentials_unavailable 时，
            // 丢弃坏会话重建一次再试——否则重编/拆镜会一直撞同一坏会话，表现为「重编没用」。
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const session = await this.ensureSession(client, thread);
                    const wanted = this.acpModel(thread.model);
                    if (wanted && session.model !== thread.model) { await client.setModel(session.sessionId, wanted); session.model = thread.model; }
                    const result = await client.prompt(session.sessionId, `${request.prompt}\n\n${instruction}`, images);
                    const output = parseValidated(result.text, validate);
                    turn.display.push(this.display(thread.id, turn.id, itemId, "assistant", result.text));
                    turn.status = "completed";
                    return { threadId, output };
                } catch (error) {
                    const msg = errorMessage(error);
                    const sessionBroken = /internal error|not[_ ]?found|launch_credentials_unavailable|acp_mcp_policy_conflict|未连接/i.test(msg);
                    if (!sessionBroken || attempt >= 1) throw error;
                    // 丢弃坏会话：清线程缓存 + 失效备用会话，下一轮 ensureSession 自然走 newSession。
                    logger.warn("Hermes ACP 会话失效，丢弃坏会话重建重试一次", { threadId, error: msg });
                    this.sessions.delete(thread.id);
                    thread.sessionId = "";
                    this.spare = null;
                }
            }
            throw new Error("HERMES_SESSION_RETRY_EXHAUSTED");
        } catch (error) {
            turn.status = "failed";
            turn.error = errorMessage(error);
            this.save(thread);
            throw error;
        } finally {
            this.active = undefined;
            this.save(thread);
        }
    }

    async skills(cwd: string): Promise<{ skills: Array<{ name: string; description: string; path: string; scope: string; enabled: boolean }>; errors: Array<{ message: string; path?: string }> }> {
        const disabledNames = await this.disabledSkills();
        const roots = [path.join(cwd, ".agents", "skills"), userSkills];
        const skills: Array<{ name: string; description: string; path: string; scope: string; enabled: boolean }> = [], errors: Array<{ message: string; path?: string }> = [];
        for (const root of roots) {
            let entries;
            try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push({ message: "无法读取 Skill 目录", path: root });
                continue;
            }
            for (const entry of entries.filter((item) => item.isDirectory())) {
                const file = path.join(root, entry.name, "SKILL.md");
                try {
                    const parsed = matter(await fs.readFile(file, "utf8"));
                    const disabled = disabledNames.has(String(parsed.data.name || entry.name));
                    skills.push({ name: String(parsed.data.name || entry.name), description: String(parsed.data.description || ""), path: file, scope: root === roots[0] ? "repo" : "user", enabled: !disabled });
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push({ message: "Skill 文件不可读", path: file });
                }
            }
        }
        return { skills, errors };
    }

    async resolveSkill(cwd: string, selector: { name: string; path: string }, requireEnabled = false): Promise<{ name: string; path: string; enabled: boolean; [key: string]: unknown }> {
        const skill = (await this.skills(cwd)).skills.find((item) => item.name === selector.name && path.resolve(String(item.path)).toLowerCase() === path.resolve(selector.path).toLowerCase());
        if (!skill || (requireEnabled && !skill.enabled)) throw new Error("指定 Skill 不存在或已停用，请刷新列表");
        return skill as { name: string; path: string; enabled: boolean; [key: string]: unknown };
    }

    async configureSkill(cwd: string, selector: { name: string; path: string }, enabled: boolean) {
        const skill = await this.resolveSkill(cwd, selector);
        const name = String(skill.name || selector.name || "").trim();
        // 画布侧的开关只有在写进 Hermes 自己的 skills.disabled 后才真生效，否则只是本地标记。
        if (name) await this.setHermesSkillDisabled(name, !enabled);
        this.settings.set(`agent.hermes.skill-disabled:${skill.path}`, !enabled);
        return { effectiveEnabled: enabled, skill: { ...skill, enabled } };
    }

    /** 跑一次 hermes CLI（配置读写），失败不抛给界面但会记日志，避免开关看起来生效其实没写进去。 */
    private async hermesCli(args: string[], timeoutMs = 30_000): Promise<string> {
        await ensureCanvasProfile();
        const { spawn } = await import("node:child_process");
        return await new Promise<string>((resolve, reject) => {
            const child = spawn(hermesCommand(), ["--profile", HERMES_CANVAS_PROFILE, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
            let out = "", err = "";
            const timer = setTimeout(() => { child.kill(); reject(new Error(`hermes ${args[0]} 超时`)); }, timeoutMs);
            child.stdout?.on("data", (chunk) => { out += String(chunk); });
            child.stderr?.on("data", (chunk) => { err += String(chunk); });
            child.on("error", (error) => { clearTimeout(timer); reject(error); });
            child.on("close", (code) => {
                clearTimeout(timer);
                if (code === 0) resolve(out);
                else reject(new Error(err.trim() || `hermes ${args[0]} 退出码 ${code}`));
            });
        });
    }

    /** Hermes 侧被禁用的技能名（skills.disabled）；缓存 60 秒，避免每次刷列表都起 python。 */
    private async disabledSkills(): Promise<Set<string>> {
        if (this.disabledCache && Date.now() - this.disabledCache.at < 60_000) return this.disabledCache.names;
        try {
            const raw = await this.hermesCli(["config", "get", "skills.disabled"]).catch(() => "");
            const names = new Set(raw.split("\n").map((line) => line.replace(/^\s*-\s*/, "").trim()).filter((line) => line && !line.startsWith("⚠")));
            this.disabledCache = { names, at: Date.now() };
            return names;
        } catch { return new Set(); }
    }

    /** 读/写 Hermes 的 skills.disabled（YAML 列表，用 CLI 读写以免破坏 config.yaml 的注释与结构）。 */
    private async setHermesSkillDisabled(name: string, disabled: boolean) {
        try {
            const raw = await this.hermesCli(["config", "get", "skills.disabled"]).catch(() => "");
            const current = new Set(raw.split("\n").map((line) => line.replace(/^\s*-\s*/, "").trim()).filter((line) => line && !line.startsWith("⚠")));
            if (disabled) current.add(name); else current.delete(name);
            await this.hermesCli(["config", "set", "skills.disabled", JSON.stringify([...current])]);
            this.disabledCache = { names: current, at: Date.now() };
        } catch (error) {
            logger.warn("Hermes skill 开关写入失败", { name, disabled, error: errorMessage(error) });
            throw new Error(`写入 Hermes 技能开关失败：${errorMessage(error)}`);
        }
    }

    retainHistory(id: string, title: string) {
        if (!isHermesThread(id)) return;
        let thread: HermesThread;
        try { thread = this.load(id); } catch { return; }
        let changed = false;
        if (thread.silent) { thread.silent = false; changed = true; }
        if (!thread.preview && title) { thread.preview = title; changed = true; }
        if (changed) this.save(thread);
    }

    private display(threadId: string, turnId: string, itemId: string, role: ChatMessage["role"], text: string, title?: string, detail?: unknown): ChatMessage {
        return { id: `${threadId}:${turnId}:${itemId}`, itemId, threadId, turnId, role, text, title, detail };
    }
}

function parseValidated(text: string, validate: (value: unknown) => boolean & { errors?: unknown }) {
    const raw = extractJsonText(text);
    if (raw === undefined) throw new Error("Hermes 没有返回可解析的 JSON 回包");
    if (!validate(raw)) throw new Error(`Agent 结构化结果不符合合同：${JSON.stringify((validate as unknown as { errors?: unknown }).errors)}`);
    return raw;
}

function extractJsonText(text: string): unknown {
    const trimmed = String(text || "").trim();
    // 模型常把 JSON 与「💭 推理」fence 块混在一起输出（JSON + 推理 fence + 重复 JSON），
    // 只取第一个 fenced 块会拿到推理文本。候选顺序：整段 → 每个 fenced 块 → 平衡括号截取，
    // 逐个尝试解析，命中即返回。
    const candidates: string[] = [trimmed];
    for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(match[1].trim());
    for (const candidate of candidates) {
        try { return JSON.parse(candidate); } catch { /* 尝试下一个候选 */ }
    }
    const start = trimmed.search(/[[{]/);
    if (start < 0) return undefined;
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let index = start; index < trimmed.length; index++) {
        if (trimmed[index] === open) depth++;
        else if (trimmed[index] === close) { depth--; if (!depth) { try { return JSON.parse(trimmed.slice(start, index + 1)); } catch { return undefined; } } }
    }
    return undefined;
}

function attachmentDataUrls(attachments: AgentAttachment[]) {
    return attachments.map((item) => String(item.dataUrl || "")).filter((value) => value.startsWith("data:"));
}

async function fileDataUrl(file: string) {
    const mimeType = /\.jpe?g$/i.test(file) ? "image/jpeg" : /\.webp$/i.test(file) ? "image/webp" : "image/png";
    return `data:${mimeType};base64,${(await fs.readFile(file)).toString("base64")}`;
}
