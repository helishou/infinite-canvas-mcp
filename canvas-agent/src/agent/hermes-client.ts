import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path, { join } from "node:path";

import { logger } from "../utils/logger.js";
import { errorMessage, field, type JsonRecord } from "../utils/value.js";
import type { AgentEmit, AgentPermissionMode } from "./types.js";

/**
 * Hermes 运行时：把 canvas 导演对话接到 `hermes acp`（JSON-RPC over stdio）。
 *
 * 为什么是 ACP 而不是 HTTP：Canvas 已经有「原生引擎 + 自有事件流」的形态（Codex app-server），
 * ACP 是同一形态的开放协议 —— session 建/载、prompt 流式更新、工具调用、权限请求、取消、模型目录
 * 全都有，Hermes 侧由 `hermes acp` 实现（acp_adapter，能力：load_session / image / session list）。
 *
 * 事件映射目标就是网页已经在用的词表（agent_event / agent_done / codex_approval），
 * 所以前端与历史管线不需要为新引擎再加分支。
 */

export const HERMES_THREAD_PREFIX = "hermes-";
export const isHermesThread = (id: string) => id.startsWith(HERMES_THREAD_PREFIX);

/** Hermes 侧模型 id 形如 `provider/model`（ACP `session/set_model` 的 modelId）。 */
export type HermesModelRow = { id: string; model: string; displayName: string; isDefault?: boolean; supportedReasoningEfforts: Array<{ reasoningEffort: string }> };

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout };
type SessionUpdate = JsonRecord & { sessionUpdate?: string };

const ACP_PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 30_000;
/** session 建/载要把 Hermes 的 agent 全套构造起来（配置、memory、SessionDB、MCP），冷启动常在一分钟以上。 */
const START_TIMEOUT_MS = Number(process.env.HERMES_ACP_START_TIMEOUT_MS || 180_000);

export function hermesCommand() {
    const configured = String(process.env.HERMES_ACP_COMMAND || process.env.HERMES_BIN || "").trim();
    if (configured) return configured;
    const executable = process.platform === "win32" ? "hermes.exe" : "hermes";
    // dev:local 的 node 进程不一定带 Hermes 的 bin 目录，按安装位置兜底而不是只靠 PATH。
    const localAppData = String(process.env.LOCALAPPDATA || "");
    const candidates = [
        process.env.HERMES_HOME ? path.join(process.env.HERMES_HOME, "bin", executable) : "",
        localAppData ? path.join(localAppData, "hermes", "bin", executable) : "",
        localAppData ? path.join(localAppData, "hermes", "hermes-agent", ".hermes", "bin", executable) : "",
    ].filter(Boolean);
    for (const candidate of candidates) if (existsSync(candidate)) return candidate;
    return executable;
}

/** 画布专用 Hermes profile：与主配置隔离。画布 MCP 由 session/new 传入，不写入 profile。 */
export const HERMES_CANVAS_PROFILE = "infinite-canvas";

let profileReady: Promise<void> | undefined;

/** 首次调用时新建专用 profile（默认配置、共享凭证、不带自定义技能）；已存在则复用。 */
export function ensureCanvasProfile(): Promise<void> {
    if (!profileReady) {
        profileReady = (async () => {
            const home = process.env.HERMES_HOME || path.join(homedir(), ".hermes");
            if (existsSync(path.join(home, "profiles", HERMES_CANVAS_PROFILE))) return;
            await new Promise<void>((resolve, reject) => {
                const child = spawn(hermesCommand(), ["profile", "create", HERMES_CANVAS_PROFILE, "--no-alias"], {
                    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
                });
                let err = "";
                child.stderr?.setEncoding("utf8");
                child.stderr?.on("data", (chunk: string) => { err += chunk; });
                const timer = setTimeout(() => { child.kill(); reject(new Error("hermes profile create 超时")); }, START_TIMEOUT_MS);
                child.on("error", (error) => { clearTimeout(timer); reject(error); });
                child.on("close", (code) => {
                    clearTimeout(timer);
                    if (code === 0 || /already (exists|in use)/i.test(err)) return resolve();
                    reject(new Error(err.trim() || `hermes profile create 退出码 ${code}`));
                });
            });
        })().catch((error) => { profileReady = undefined; throw error; });
    }
    return profileReady;
}

/** 单条 ACP 连接：一行一个 JSON-RPC 消息，stdout 只跑协议，日志走 stderr。 */
class AcpConnection {
    private child?: ChildProcess;
    private buffer = "";
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private closed = false;
    private stderrTail = "";

    constructor(private readonly onRequest: (method: string, params: JsonRecord, id: number) => boolean, private readonly onNotification: (method: string, params: JsonRecord) => void, private readonly onExit: (reason: string) => void) {}

    async start() {
        if (this.child) return;
        await ensureCanvasProfile();
        const command = hermesCommand();
        logger.info("Starting Hermes ACP", { command, profile: HERMES_CANVAS_PROFILE });
        const child = spawn(command, ["--profile", HERMES_CANVAS_PROFILE, "acp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NO_PROXY: [process.env.NO_PROXY, "127.0.0.1,localhost,::1"].filter(Boolean).join(",") } });
        this.child = child;
        child.stdin?.setDefaultEncoding("utf8");
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => this.read(chunk));
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            const text = String(chunk).trim();
            if (!text) return;
            // 只保留尾部：Hermes 启动会打不少 info 行，全量转发会淹没网页诊断日志。
            this.stderrTail = `${this.stderrTail}\n${text}`.slice(-200000);
            logger.debug("Hermes ACP stderr", { text });
        });
        child.on("error", (error) => { this.failAll(error); this.onExit(errorMessage(error)); });
        child.on("exit", (code) => {
            const reason = this.stderrTail.trim().split("\n").slice(-3).join(" · ") || `exit ${code ?? 0}`;
            this.failAll(new Error(`Hermes ACP exited: ${code ?? 0}`));
            this.onExit(reason);
        });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Hermes ACP 启动超时（${command} acp）`)), START_TIMEOUT_MS);
            child.once("spawn", () => { clearTimeout(timer); resolve(); });
            child.once("error", (error) => { clearTimeout(timer); reject(error); });
        });
    }

    get alive() { return Boolean(this.child) && !this.closed; }

    /** 把子进程完整 stderr 落盘，便于排查 ACP 侧的真实异常。 */
    dumpDiagnostics(): string {
        try {
            const file = join(tmpdir(), "hermes-acp-stderr.log");
            writeFileSync(file, this.stderrTail);
            return file;
        } catch {
            return "";
        }
    }

    /** 最近几行 stderr：初始化失败时把原因带出来，否则只能看到一句 "Internal error"。 */
    get diagnostics() {
        return this.stderrTail.trim().split("\n").filter(Boolean).slice(-40).join(" | ");
    }

    async request<T = JsonRecord>(method: string, params: JsonRecord = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
        if (!this.child || this.closed) throw new Error("Hermes ACP 未连接");
        const id = this.nextId++;
        this.write({ jsonrpc: "2.0", id, method, params });
        return await new Promise<T>((resolve, reject) => {
            const entry: Pending = { resolve, reject };
            entry.timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Hermes ACP 请求超时：${method}`)); }, timeoutMs);
            entry.timer.unref?.();
            this.pending.set(id, entry);
        });
    }

    notify(method: string, params: JsonRecord = {}) {
        if (!this.child || this.closed) return;
        this.write({ jsonrpc: "2.0", method, params });
    }

    respond(id: number, result: unknown) { this.write({ jsonrpc: "2.0", id, result }); }

    respondError(id: number, code: number, message: string) { this.write({ jsonrpc: "2.0", id, error: { code, message } }); }

    close() {
        this.closed = true;
        try { this.child?.kill(); } catch { /* 已退出 */ }
        this.child = undefined;
        this.failAll(new Error("Hermes ACP 已关闭"));
    }

    private write(value: unknown) { this.child?.stdin?.write(`${JSON.stringify(value)}\n`); }

    private read(chunk: string) {
        this.buffer += chunk;
        let index: number;
        while ((index = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + 1);
            if (!line) continue;
            let message: JsonRecord;
            try { message = JSON.parse(line) as JsonRecord; } catch { logger.warn("Invalid Hermes ACP output", { line: line.slice(0, 200) }); continue; }
            this.dispatch(message);
        }
    }

    private dispatch(message: JsonRecord) {
        const id = typeof message.id === "number" ? message.id : undefined;
        const method = typeof message.method === "string" ? message.method : "";
        if (id !== undefined && !method) {
            const entry = this.pending.get(id);
            if (!entry) return;
            this.pending.delete(id);
            if (entry.timer) clearTimeout(entry.timer);
            if (message.error) entry.reject(new Error(String(field(message.error, "message") || "Hermes ACP 请求失败")));
            else entry.resolve(message.result as JsonRecord);
            return;
        }
        if (id !== undefined && method) {
            // agent → client 请求：权限/文件/终端。没有声明的能力一律拒绝，避免静默改变 Hermes 的行为。
            const params = (message.params as JsonRecord) || {};
            if (this.onRequest(method, params, id)) return;
            this.respondError(id, -32601, `Method not supported by canvas client: ${method}`);
            return;
        }
        if (method) this.onNotification(method, (message.params as JsonRecord) || {});
    }

    private failAll(error: Error) {
        for (const entry of this.pending.values()) { if (entry.timer) clearTimeout(entry.timer); entry.reject(error); }
        this.pending.clear();
    }
}

type TurnState = {
    turnId: string;
    threadId: string;
    sequence: number;
    messageItemId: string;
    messageText: string;
    reasoningItemId: string;
    reasoningText: string;
    tools: Map<string, JsonRecord>;
    resolve: (value: { status: string; text: string; usage?: JsonRecord }) => void;
    reject: (error: Error) => void;
};

export type HermesTurnResult = { turnId: string; threadId: string; status: "completed" | "failed" | "interrupted"; text: string; usage?: JsonRecord };

/**
 * 一条 ACP 连接 + 多个 session。导演主对话、子代理、技能草稿共用同一个进程，
 * 每个 canvas 线程对应一个 ACP sessionId。
 */
export class HermesAcpClient {
    private connection: AcpConnection;
    private ready?: Promise<void>;
    private readonly approvals = new Map<string, { optionId: string; sessionId: string; rpcId: number; options: unknown[] }>();
    private readonly turns = new Map<string, TurnState>();
    private readonly sessionModels = new Map<string, string>();
    private catalogCache?: { at: number; models: string[] };

    private constructor(private readonly emit: AgentEmit, private readonly permissionMode: () => AgentPermissionMode, private readonly onExit: () => void) {
        this.connection = new AcpConnection((method, params, id) => this.handleRequest(method, params, id), (method, params) => this.handleNotification(method, params), onExit);
    }

    static async start(emit: AgentEmit, permissionMode: () => AgentPermissionMode, onExit: () => void) {
        const client = new HermesAcpClient(emit, permissionMode, onExit);
        await client.ensure();
        return client;
    }

    private async ensure() {
        if (!this.ready) {
            this.ready = (async () => {
                await this.connection.start();
                const result = await this.connection.request("initialize", {
                    protocolVersion: ACP_PROTOCOL_VERSION,
                    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
                    clientInfo: { name: "infinite-canvas", version: "1.0.0" },
                }, START_TIMEOUT_MS).catch((error: unknown) => {
                    const reason = error instanceof Error ? error.message : String(error);
                    const detail = this.connection.diagnostics;
                    throw new Error(`Hermes ACP 初始化失败：${reason}${detail ? `（${detail}）` : ""}`);
                });
                const agent = field(result, "agentInfo") as JsonRecord | undefined;
                logger.info("Hermes ACP initialized", { agent: field(agent, "name"), version: field(agent, "version") });
                const authMethods = (field(result, "authMethods") as unknown[] | undefined) || [];
                if (authMethods.length && !process.env.HERMES_ACP_SKIP_AUTH) {
                    // 已登录时 authenticate 也会成功；只尝试第一个 env/terminal 之外的默认方法。
                    const methodId = String(field(authMethods[0], "id") || "");
                    if (methodId) { try { await this.connection.request("authenticate", { methodId }); } catch (error) { logger.warn("Hermes ACP authenticate failed", { error: errorMessage(error) }); } }
                }
            })().catch((error) => { this.ready = undefined; throw error; });
        }
        await this.ready;
    }

    /** 新建 ACP session，返回 canvas 线程 id（带 `hermes-` 前缀，便于运行时分流）。 */
    async newSession(cwd: string, model?: string, mcpServers: JsonRecord[] = []) {
        await this.ensure();
        const result = await this.connection.request("session/new", { cwd, mcpServers }, START_TIMEOUT_MS).catch(async (error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            const detail = this.connection.diagnostics;
            logger.warn("Hermes session/new failed", { reason, detail });
            await new Promise((resolve) => setTimeout(resolve, 600));
            const dump = this.connection.dumpDiagnostics();
            throw new Error(`Hermes 会话创建失败：${reason}${dump ? ` [stderr → ${dump}]` : ""}`);
        });
        const sessionId = String(field(result, "sessionId") || "");
        if (!sessionId) throw new Error("Hermes ACP 没有返回 sessionId");
        const models = field(result, "models") as JsonRecord | undefined;
        this.catalogCache = { at: Date.now(), models: ((field(models, "availableModels") as unknown[]) || []).map((row) => String(field(row, "modelId") || "")).filter(Boolean) };
        this.sessionModels.set(sessionId, String(field(models, "currentModelId") || ""));
        if (model) await this.setModel(sessionId, model);
        return { id: `${HERMES_THREAD_PREFIX}${sessionId}`, acpSessionId: sessionId, model: this.sessionModels.get(sessionId) || "" };
    }

    /** Hermes 可用模型目录（来自 session/new 的 availableModels，10 分钟缓存）。 */
    async catalog(cwd: string): Promise<string[]> {
        if (this.catalogCache && Date.now() - this.catalogCache.at < 10 * 60_000) return this.catalogCache.models;
        const session = await this.newSession(cwd);
        // 目录探针会话用完即弃，避免在 Hermes 里堆一堆空会话。
        void this.connection.request("session/close", { sessionId: session.acpSessionId }).catch(() => undefined);
        return this.catalogCache?.models || [];
    }

    /** 载入已有 session（canvas 线程恢复）。
     *
     * `mcpServers` 必须补传：Hermes 只把编辑器 MCP 的指纹 + schema 清单落盘，
     * 真正的传输规格（含 Bearer token）只存在网关内存里。网关重启（崩溃、升级、
     * dev:local 清理）内存副本就没了，这时传空数组等于「沿用会话原有的」，
     * 但已经没有任何东西可沿用 —— 那一轮会以 launch_credentials_unavailable 报
     * 「此聊天的 API 密钥已更改」，且 /retry 无效，只能新开会话。
     * 规格一致时 Hermes 会重新 attach；规格变了（换 token/端口）会被
     * acp_mcp_policy_conflict 拒掉，由 ensureSession 的兜底新建会话接住。
     */
    async loadSession(sessionId: string, cwd: string, mcpServers: JsonRecord[] = []) {
        await this.ensure();
        await this.connection.request("session/load", { sessionId, cwd, mcpServers }, START_TIMEOUT_MS);
        return sessionId;
    }

    async listSessions(cwd?: string) {
        await this.ensure();
        const result = await this.connection.request("session/list", cwd ? { cwd } : {});
        const rows = (field(result, "sessions") as unknown[] | undefined) || [];
        return rows.map((row) => ({ id: `${HERMES_THREAD_PREFIX}${String(field(row, "sessionId") || "")}`, cwd: String(field(row, "cwd") || ""), title: String(field(row, "title") || ""), updatedAt: Number(field(row, "updatedAt") || 0) })).filter((row) => row.id !== HERMES_THREAD_PREFIX);
    }

    async setModel(sessionId: string, model: string) {
        await this.ensure();
        await this.connection.request("session/set_model", { sessionId, modelId: model }, 120_000);
        this.sessionModels.set(sessionId, model);
    }

    currentModel(sessionId: string) { return this.sessionModels.get(sessionId) || ""; }

    /** 发一轮 prompt，流式映射到 agent_event，结束返回最终文本。 */
    async prompt(sessionId: string, prompt: string, images: string[] = [], canvasThreadId?: string, canvasTurnId?: string): Promise<HermesTurnResult> {
        await this.ensure();
        // turn_id 必须用画布侧的 turn id：持久化后的历史消息 id 是 <thread>:<turn>:<item>，
        // 事件若带另一个 turn id，同一段推理/正文会在「实时块」和「历史块」各出现一次（看起来是两条推理）。
        const turnId = canvasTurnId || `hermes-turn-${randomUUID()}`;
        // 事件里的 thread_id 必须是画布侧线程 id（hermes-<uuid>），不是 ACP session id；
        // 用错时前端按 thread 路由取不到增量，表现就是整轮不流式、结束后才一次性出来。
        const threadId = canvasThreadId || `${HERMES_THREAD_PREFIX}${sessionId}`;
        const blocks: JsonRecord[] = [{ type: "text", text: prompt }];
        for (const image of images) blocks.push(acpImageBlock(image));
        this.emit("agent_event", { agent: "hermes", type: "turn.started", thread_id: threadId, turn_id: turnId });
        const finished = new Promise<{ status: string; text: string; usage?: JsonRecord }>((resolve, reject) => {
            const state: TurnState = { turnId, threadId, sequence: 0, messageItemId: "", messageText: "", reasoningItemId: "", reasoningText: "", tools: new Map(), resolve, reject };
            this.turns.set(sessionId, state);
        });
        void this.connection.request("session/prompt", { sessionId, prompt: blocks }, 24 * 60 * 60_000).then((result) => {
            this.finishTurn(sessionId, { status: String(field(result, "stopReason") || "end_turn"), usage: field(result, "usage") as JsonRecord | undefined });
        }).catch((error) => {
            const state = this.turns.get(sessionId);
            this.turns.delete(sessionId);
            state?.reject(error instanceof Error ? error : new Error(String(error)));
        });
        const outcome = await finished;
        // ACP 回包是 camelCase（inputTokens/cachedReadTokens）；落盘和 agent_done 都要换成
        // 画布字段名，否则历史里读出来的缓存/输出永远是 0。
        const usage = promptUsage(outcome.usage);
        const status = outcome.status === "cancelled" ? "interrupted" : outcome.status === "refusal" ? "failed" : "completed";
        this.emit("agent_done", { agent: "hermes", status, thread_id: threadId, turn_id: turnId, ...(usage ? { usage } : {}) });
        if (status === "failed") throw new Error(outcome.text || "Hermes 拒绝了本次请求");
        return { turnId, threadId, status: status as "completed" | "interrupted", text: outcome.text, ...(usage ? { usage } : {}) };
    }

    /** 结构化输出：要求 Hermes 只回 JSON，失败时抛错而不是猜。 */
    async structured(sessionId: string, prompt: string, schema: JsonRecord, images: string[] = []) {
        const instruction = `\n\n严格只输出一个 JSON，必须符合以下 JSON Schema，不要代码块、不要解释：\n${JSON.stringify(schema)}`;
        const result = await this.prompt(sessionId, `${prompt}${instruction}`, images);
        const raw = extractJson(result.text);
        if (!raw) throw new Error("Hermes 没有返回可解析的 JSON 回包");
        return raw;
    }

    async cancel(sessionId: string) {
        await this.ensure();
        this.connection.notify("session/cancel", { sessionId });
        return true;
    }

    close() { this.connection.close(); }

    private finishTurn(sessionId: string, outcome: { status: string; usage?: JsonRecord }) {
        const state = this.turns.get(sessionId);
        if (!state) return;
        // 回合结束才有真实计数（PromptResponse.usage：input/output/total/cached_read/thought）。
        const finalUsage = promptUsage(outcome.usage);
        if (finalUsage) this.emit("agent_event", { agent: "hermes", type: "usage.updated", usage: finalUsage, thread_id: state.threadId, turn_id: state.turnId });
        this.turns.delete(sessionId);
        const text = state.messageText.trim();
        this.flushMessage(state, true);
        this.flushReasoning(state, true);
        const cancelled = outcome.status === "cancelled";
        this.emit("agent_event", { agent: "hermes", type: "turn.completed", status: cancelled ? "interrupted" : outcome.status === "refusal" ? "failed" : "completed", thread_id: state.threadId, turn_id: state.turnId, ...(outcome.usage ? { usage: outcome.usage } : {}) });
        state.resolve({ status: outcome.status, text, ...(outcome.usage ? { usage: outcome.usage } : {}) });
    }

    private handleRequest(method: string, params: JsonRecord, id: number) {
        if (method !== "session/request_permission") return false;
        const sessionId = String(field(params, "sessionId") || "");
        const options = (field(params, "options") as unknown[]) || [];
        const pick = (kinds: string[]) => options.find((option) => kinds.includes(String(field(option, "kind") || "")));
        const mode = this.permissionMode();
        const toolCall = (field(params, "toolCall") as JsonRecord) || {};
        const summary = String(field(toolCall, "title") || field(toolCall, "kind") || "工具调用");
        const allow = pick(["allow_once", "allow_always"]) || options[0];
        const optionId = String(field(allow, "optionId") || "");
        if (mode === "full" && optionId) {
            this.connection.respond(id, { outcome: { outcome: "selected", optionId } });
            return true;
        }
        const requestId = `hermes-approval-${randomUUID()}`;
        this.approvals.set(requestId, { optionId, sessionId, rpcId: id, options });
        this.emit("codex_approval", { agent: "hermes", requestId, method, summary, options, sessionId, threadId: `${HERMES_THREAD_PREFIX}${sessionId}` });
        return true;
    }

    /** 网页端审批回执；decision 沿用 canvas 现有词表 accept / acceptForSession / decline / cancel。 */
    resolveApproval(requestId: string, decision: string) {
        const entry = this.approvals.get(requestId);
        if (!entry) return false;
        this.approvals.delete(requestId);
        const accepted = decision === "accept" || decision === "acceptForSession";
        const rejected = entry.options.find((option) => ["reject_once", "reject_always"].includes(String(field(option, "kind") || "")));
        const optionId = accepted ? entry.optionId : String(field(rejected, "optionId") || "");
        this.connection.respond(entry.rpcId, optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
        return true;
    }

    private handleNotification(method: string, params: JsonRecord) {
        if (method !== "session/update") return;
        const sessionId = String(field(params, "sessionId") || "");
        const update = (field(params, "update") as SessionUpdate) || {};
        const state = this.turns.get(sessionId);
        if (!state) return;
        const kind = String(update.sessionUpdate || "");
        if (kind === "agent_message_chunk") {
            const text = chunkText(update);
            if (!text) return;
            // 正文一旦开始，把这段思考收尾，后续思考另起一段。
            this.flushReasoning(state, true);
            const messageId = String(field(update, "messageId") || "") || state.messageItemId || this.nextItemId(state, "msg");
            if (state.messageItemId && state.messageItemId !== messageId) this.flushMessage(state, true);
            state.messageItemId = messageId;
            state.messageText += text;
            this.emit("agent_event", { agent: "hermes", type: "item.updated", item: { id: messageId, type: "agent_message", delta: text }, thread_id: state.threadId, turn_id: state.turnId });
            return;
        }
        if (kind === "agent_thought_chunk") {
            const text = chunkText(update);
            if (!text) return;
            state.reasoningItemId ||= this.nextItemId(state, "reasoning");
            state.reasoningText += text;
            this.emit("agent_event", { agent: "hermes", type: "item.updated", item: { id: state.reasoningItemId, type: "reasoning", delta: text }, thread_id: state.threadId, turn_id: state.turnId });
            return;
        }
        if (kind === "tool_call" || kind === "tool_call_update") {
            const toolCallId = String(field(update, "toolCallId") || "");
            if (!toolCallId) return;
            const status = String(field(update, "status") || "in_progress");
            // 增量更新常常只带 status、不带 title；这时必须沿用首帧的工具名，
            // 否则界面会把「h3 get clip」覆盖回原始 call_id（看起来就是不显示工具名）。
            const previous = state.tools.get(toolCallId);
            const rawInput = field(update, "rawInput") as JsonRecord | undefined;
            const title = String(field(update, "title") || "");
            const toolName = title
                || String((previous as JsonRecord | undefined)?.tool || "")
                || String(field(rawInput || {}, "name") || field(rawInput || {}, "tool") || "")
                || `工具 ${toolCallId.slice(-6)}`;
            const item = {
                id: toolCallId,
                type: "mcp_tool_call",
                tool: toolName,
                status,
                ...(field(update, "rawInput") ? { arguments: field(update, "rawInput") } : {}),
                ...(field(update, "rawOutput") ? { result: field(update, "rawOutput") } : {}),
                ...(status === "failed" ? { error: { message: toolFailureReason(update) } } : {}),
            };
            const started = previous;
            state.tools.set(toolCallId, item);
            // 工具调用收掉当前这段思考：否则整轮所有思考都挤进同一张卡片，
            // 卡片排在前面、工具排在后面，看起来就是「工具都掉到底下去了」。
            this.flushReasoning(state, true);
            const phase = started || status === "completed" || status === "failed" ? "item.completed" : "item.started";
            this.emit("agent_event", { agent: "hermes", type: phase, item, thread_id: state.threadId, turn_id: state.turnId });
            return;
        }
        if (kind === "plan") {
            const entries = (field(update, "entries") as unknown[]) || [];
            const text = entries.map((entry) => `${field(entry, "status") === "completed" ? "✔" : "•"} ${field(entry, "content")}`).join("\n");
            this.emit("agent_event", { agent: "hermes", type: "item.completed", item: { id: this.nextItemId(state, "plan"), type: "plan", text }, thread_id: state.threadId, turn_id: state.turnId });
            return;
        }
        if (kind === "usage_update") {
            // ACP 的 usage_update 只有上下文占用（size/used），没有输出与缓存计数；
            // 之前把后两者写死 0，界面上「缓存/输出」就永远是 0。这里只更新输入侧。
            this.emit("agent_event", { agent: "hermes", type: "usage.updated", usage: { input_tokens: Number(field(update, "used") || 0) }, thread_id: state.threadId, turn_id: state.turnId });
        }
    }

    private nextItemId(state: TurnState, kind: string) { return `${state.turnId}-${kind}-${++state.sequence}`; }

    private flushMessage(state: TurnState, completed: boolean) {
        if (!state.messageItemId) return;
        const item = { id: state.messageItemId, type: "agent_message", text: state.messageText };
        this.emit("agent_event", { agent: "hermes", type: completed ? "item.completed" : "item.updated", item, thread_id: state.threadId, turn_id: state.turnId });
        if (!completed) return;
        state.messageItemId = "";
        state.messageText = "";
    }

    private flushReasoning(state: TurnState, completed: boolean) {
        if (!state.reasoningItemId) return;
        this.emit("agent_event", { agent: "hermes", type: completed ? "item.completed" : "item.updated", item: { id: state.reasoningItemId, type: "reasoning", text: state.reasoningText }, thread_id: state.threadId, turn_id: state.turnId });
        if (!completed) return;
        state.reasoningItemId = "";
        state.reasoningText = "";
    }
}

/** ACP PromptResponse.usage → 画布用量条的字段（缓存是 cached_read_tokens，不是 cached_input_tokens）。 */
function promptUsage(usage?: JsonRecord): JsonRecord | undefined {
    if (!usage) return undefined;
    const num = (value: unknown) => (value === undefined || value === null ? undefined : Number(value) || 0);
    // ACP 用 alias 序列化（camelCase），本地对象是 snake_case —— 两种都认。
    const input = num(field(usage, "inputTokens") ?? field(usage, "input_tokens"));
    const output = num(field(usage, "outputTokens") ?? field(usage, "output_tokens"));
    const cached = num(field(usage, "cachedReadTokens") ?? field(usage, "cached_read_tokens") ?? field(usage, "cache_read_tokens"));
    if (input === undefined && output === undefined && cached === undefined) return undefined;
    return {
        ...(input === undefined ? {} : { input_tokens: input }),
        ...(output === undefined ? {} : { output_tokens: output }),
        ...(cached === undefined ? {} : { cached_input_tokens: cached }),
    };
}

/** ACP 的失败文本藏在嵌套 content 块里：{type:"content", content:{type:"text", text:"..."}}。 */
function contentText(entry: unknown): string {
    if (typeof entry === "string") return entry.trim();
    if (!entry || typeof entry !== "object") return "";
    const row = entry as JsonRecord;
    const direct = field(row, "text");
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const nested = field(row, "content");
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return contentText(nested);
    return "";
}

/** 工具失败时尽量给出真实原因：rawOutput / content / _meta 里任一处带 message/error 都取出来。 */
export function toolFailureReason(update: JsonRecord): string {
    const candidates: unknown[] = [field(update, "rawOutput"), field(update, "rawInput"), field(update, "content"), field(update, "_meta")];
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 400);
        if (Array.isArray(candidate)) {
            const text = candidate.map(contentText).filter(Boolean).join("\n").trim();
            if (text) return text.slice(0, 400);
        }
        const record = candidate as JsonRecord;
        const message = record && typeof record === "object" ? field(record, "error") || field(record, "message") : undefined;
        if (typeof message === "string" && message.trim()) return message.trim().slice(0, 400);
        if (message && typeof message === "object") {
            const nested = String(field(message as JsonRecord, "message") || "");
            if (nested.trim()) return nested.trim().slice(0, 400);
        }
    }
    return "工具调用失败（Hermes 没有返回失败原因）";
}

function chunkText(update: JsonRecord) {
    const content = field(update, "content");
    if (typeof content === "string") return content;
    if (content && typeof content === "object" && !Array.isArray(content)) {
        const value = field(content, "text");
        if (typeof value === "string") return value;
    }
    return "";
}

/** 参考图路径或 data URL → ACP ImageContent。 */
function acpImageBlock(image: string): JsonRecord {
    const value = String(image || "").trim();
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
    if (match) return { type: "image", mimeType: match[1], data: match[2] };
    // 本地文件路径：交给 Hermes 侧的文件能力，不在这里读盘（调用方负责传 data URL 或绝对路径）。
    return { type: "text", text: `参考图（本地路径，请用你的文件工具读取）：${value}` };
}

export function extractJson(text: string): unknown {
    const trimmed = text.trim();
    // 模型常把 JSON 与「💭 推理」fence 块混在一起输出（JSON + 推理 fence + 重复 JSON），
    // 只取第一个 fenced 块会拿到推理文本。候选顺序：整段 → 每个 fenced 块 → 平衡括号截取。
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
