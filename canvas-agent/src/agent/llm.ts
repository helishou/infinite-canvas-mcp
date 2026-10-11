import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import matter from "gray-matter";
import { Ajv } from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AGENT_PROMPT } from "../config.js";
import type { AgentAttachment, AgentEmit } from "./types.js";
import { configuredLlmProviders, resolveLlmProvider, requestLlm, textOf, llmHistoryForProvider, type Json, type LlmMessage, type LlmTool } from "./llm-provider.js";

export type LlmSettings = { get(key: string): unknown; set(key: string, value: unknown): void };
type ChatMessage = { id: string; itemId: string; threadId: string; turnId: string; role: "user" | "assistant" | "tool" | "error"; title?: string; text: string; detail?: unknown };
type LlmTurn = { id: string; status: "running" | "completed" | "failed" | "interrupted"; messages: LlmMessage[]; display: ChatMessage[]; error?: string };
type LlmThread = { version: 1; id: string; cwd: string; model: string; preview: string; createdAt: number; updatedAt: number; archived?: boolean; silent?: boolean; turns: LlmTurn[] };
export const isLlmThread = (id: string) => id.startsWith("llm-");
const threadKey = (id: string) => `agent.llm.thread:${id}`;
const userSkills = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills");
const readTool: LlmTool = { name: "agent_read_file", description: "读取当前工作空间或已登记 Skill 的 UTF-8 文件；学习 SKILL.md 中引用的模块和合同。", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } };
const imageTool: LlmTool = { name: "agent_view_image", description: "实际查看 Backend 归档图片。先从画布、资产或制作工具回包获取真实 storageKey，再调用本工具；不要从文件名或 URL 猜图片内容。", inputSchema: { type: "object", properties: { storageKey: { type: "string" } }, required: ["storageKey"], additionalProperties: false } };

/** API-backed conversations reuse Backend settings, channel credentials and the authoritative MCP. */
export class LlmAgent {
    private controllers = new Map<string, AbortController>();
    constructor(private settings: LlmSettings, private backendUrl: string, private backendToken: string, private connectClient?: () => Promise<Client>) {}
    providers() { return configuredLlmProviders(this.settings.get("ai.config")); }
    provider(id?: string) { return resolveLlmProvider(this.settings.get("ai.config"), id || this.defaultModel()); }
    rememberCodexThread(id: string, model: string) { this.settings.set(`agent.codex.channel-model:${id}`, model); }
    codexThreadModel(id: string) { const model = this.settings.get(`agent.codex.channel-model:${id}`); return typeof model === "string" && this.providers().some(provider => provider.id === model && provider.kind === "codex-cli") ? model : undefined; }
    delegationModel(parentThreadId: string, requested?: string) {
        if (requested) return requested;
        return isLlmThread(parentThreadId) ? this.load(parentThreadId).model : this.codexThreadModel(parentThreadId) || this.defaultModel();
    }
    nativeWorkerModel(model?: string, threadId?: string) {
        if (threadId && !isLlmThread(threadId) && !model) return undefined;
        if (model && !model.includes("::")) return model;
        if (threadId && isLlmThread(threadId)) return model;
        const selected = model || this.defaultModel();
        if (!selected) return undefined;
        const provider = this.provider(selected);
        return provider.kind === "codex-cli" ? provider.model : selected;
    }
    defaultModel() {
        const config = this.settings.get("ai.config") as Json | null;
        const saved = this.settings.get("frontend.settings") as Json | null;
        const providers = this.providers();
        return providers.find(provider => provider.id === saved?.agentModel)?.id || providers.find(provider => provider.id === config?.textModel)?.id || providers[0]?.id;
    }
    models(nativeModels: Json[] = []) {
        const defaultModel = this.defaultModel();
        return { data: this.providers().map(provider => {
            const native = provider.kind === "codex-cli" ? nativeModels.find(model => model.model === provider.model) : undefined;
            return { id: provider.id, model: provider.id, displayName: provider.name, defaultReasoningEffort: native?.defaultReasoningEffort || "", supportedReasoningEfforts: native?.supportedReasoningEfforts || [], isDefault: provider.id === defaultModel, runtime: provider.kind === "codex-cli" ? "codex" : "llm" };
        }) };
    }
    startThread(cwd: string, model = this.defaultModel(), silent = false) {
        const provider = resolveLlmProvider(this.settings.get("ai.config"), model);
        if (provider.kind === "codex-cli") throw new Error("Codex CLI 渠道须创建原生 Codex 对话");
        const thread: LlmThread = { version: 1, id: `llm-${crypto.randomUUID()}`, cwd, model: provider.id, preview: "", createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000, turns: [], silent };
        this.save(thread);
        const index = this.index();
        this.settings.set("agent.llm.index", [...index, thread.id]);
        return this.summary(thread);
    }
    private index(): string[] {
        const value = this.settings.get("agent.llm.index");
        if (value == null) return [];
        if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !isLlmThread(id))) throw new Error("Agent 历史索引格式不支持，保留原数据");
        return value;
    }
    private load(id: string, cwd?: string): LlmThread {
        const value = this.settings.get(threadKey(id)) as LlmThread | null;
        if (!value || value.version !== 1 || value.id !== id || !Array.isArray(value.turns)) throw new Error("Agent 历史不存在或格式不支持，保留原数据");
        if (cwd && path.resolve(value.cwd).toLowerCase() !== path.resolve(cwd).toLowerCase()) throw new Error("Agent 对话不属于当前工作空间");
        return structuredClone(value);
    }
    private save(thread: LlmThread) { thread.updatedAt = Date.now() / 1000; this.settings.set(threadKey(thread.id), thread); }
    private summary(thread: LlmThread) { return { id: thread.id, cwd: thread.cwd, model: thread.model, preview: thread.preview, createdAt: thread.createdAt, updatedAt: thread.updatedAt, status: thread.turns.at(-1)?.status || "idle", source: "llm" }; }
    list(cwd: string, searchTerm = "") {
        return { data: this.index().map(id => this.load(id)).filter(thread => !thread.silent && !thread.archived && path.resolve(thread.cwd).toLowerCase() === path.resolve(cwd).toLowerCase() && thread.preview.toLowerCase().includes(searchTerm.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt).map(thread => this.summary(thread)), nextCursor: null };
    }
    read(id: string, cwd?: string) {
        const thread = this.load(id, cwd);
        // A persisted running turn after process restart is evidence of interruption, never a retry instruction.
        if (!this.controllers.has(id)) for (const turn of thread.turns) if (turn.status === "running") {
            turn.status = "interrupted"; turn.error = "Agent 进程已中断；工具可能已执行，请核对回执和任务，未自动重跑";
            this.completeMissingResults(turn);
            turn.display.push(this.display(id, turn.id, "interruption", "error", turn.error));
            this.save(thread);
        }
        return { thread: this.summary(thread), messages: thread.turns.flatMap(turn => turn.display), settledTurnIds: thread.turns.filter(turn => turn.status !== "running").map(turn => turn.id), historyReady: true };
    }
    archive(id: string, cwd: string) { const thread = this.load(id, cwd); thread.archived = true; this.save(thread); }
    interrupt(id?: string) {
        const controller = id ? this.controllers.get(id) : this.controllers.values().next().value;
        if (!controller) return false;
        controller.abort(); return true;
    }
    async prepare(id: string, cwd: string, emit: AgentEmit) {
        this.read(id, cwd);
        const client = await this.connect();
        try { await this.tools(client); emit("agent_bootstrap", { type: "mcp.complete", phase: "preheat", threadId: id, services: [{ name: "infinite-canvas", authStatus: "unsupported" }] }); }
        finally { await client.close(); }
        return this.read(id, cwd);
    }
    private async connect() {
        if (this.connectClient) return await this.connectClient();
        const client = new Client({ name: "infinite-canvas-agent", version: "1.0.0" });
        const transport = new StreamableHTTPClientTransport(new URL("/mcp", this.backendUrl), { requestInit: { headers: { authorization: `Bearer ${this.backendToken}` } } });
        try { await client.connect(transport); return client; }
        catch (error) { await client.close().catch(() => {}); throw error; }
    }
    private async tools(client: Client): Promise<LlmTool[]> {
        const tools: LlmTool[] = [];
        let cursor: string | undefined;
        do { const page = await client.listTools(cursor ? { cursor } : {}); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
        return [...tools, readTool, imageTool];
    }
    async skills(cwd: string) {
        const roots = [path.join(cwd, ".agents", "skills"), userSkills];
        const skills: Json[] = [], errors: Json[] = [];
        for (const root of roots) {
            let entries;
            try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push({ message: "无法读取 Skill 目录", path: root }); continue; }
            for (const entry of entries.filter(entry => entry.isDirectory())) {
                const file = path.join(root, entry.name, "SKILL.md");
                try {
                    const parsed = matter(await fs.readFile(file, "utf8"));
                    const disabled = this.settings.get(`agent.llm.skill-disabled:${file}`) === true;
                    skills.push({ name: String(parsed.data.name || entry.name), description: String(parsed.data.description || ""), path: file, scope: root === roots[0] ? "repo" : "user", enabled: !disabled });
                } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push({ message: "Skill 文件不可读", path: file }); }
            }
        }
        return { skills, errors };
    }
    async resolveSkill(cwd: string, selector: { name: string; path: string }, requireEnabled = false) {
        const skill = (await this.skills(cwd)).skills.find(skill => skill.name === selector.name && path.resolve(skill.path).toLowerCase() === path.resolve(selector.path).toLowerCase());
        if (!skill || requireEnabled && !skill.enabled) throw new Error("指定 Skill 不存在或已停用，请刷新列表");
        return skill;
    }
    async configureSkill(cwd: string, selector: { name: string; path: string }, enabled: boolean) {
        const skill = await this.resolveSkill(cwd, selector);
        this.settings.set(`agent.llm.skill-disabled:${skill.path}`, !enabled);
        return { effectiveEnabled: enabled, skill: { ...skill, enabled } };
    }
    async run(prompt: string, lifecycleEmit: AgentEmit, attachments: AgentAttachment[], options: { threadId?: string; cwd?: string; model?: string; effort?: string; skill?: { name: string; path: string }; messageText?: string; appEmit?: AgentEmit; onStart?: () => void; onThread?: (id: string) => void; onTurn?: (id: string) => void; onFinish?: () => void; permissionMode?: string }, projectId?: string) {
        const emit = options.appEmit || lifecycleEmit;
        const threadId = options.threadId || "";
        const cwd = options.cwd || "";
        if (this.controllers.has(threadId)) throw new Error("当前 Agent 对话已有运行中的任务");
        const controller = new AbortController();
        this.controllers.set(threadId, controller);
        let thread: LlmThread | undefined, turn: LlmTurn | undefined, client: Client | undefined;
        const usage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
        const event = (type: string, payload: Json = {}) => emit("agent_event", { agent: "llm", type, thread_id: options.threadId, turn_id: turn?.id, ...payload });
        try {
            options.onStart?.();
            thread = this.load(threadId, cwd);
            const provider = resolveLlmProvider(this.settings.get("ai.config"), options.model || thread.model);
            thread.model = provider.id;
            turn = { id: crypto.randomUUID(), status: "running", messages: [{ role: "user", parts: [{ text: prompt }, ...attachments.filter(item => item.dataUrl).map(item => ({ image: item.dataUrl! }))] }], display: [] };
            turn.display.push(this.display(thread.id, turn.id, "synthetic:user", "user", options.messageText || prompt));
            thread.turns.push(turn); thread.preview ||= options.messageText || prompt;
            this.save(thread); options.onThread?.(thread.id); options.onTurn?.(turn.id); event("turn.started");
            const skills = await this.skills(cwd);
            const selected = options.skill ? await this.resolveSkill(cwd, options.skill, true) : undefined;
            const instructions = `${AGENT_PROMPT}\n\n导演委派上下文：parentThreadId=${thread.id}，parentTurnId=${turn.id}，projectId=${projectId || "未绑定"}。调用 director_subagent 时使用这些身份，子代理只返回建议，结果由你核对后保存。\n\n可用 Skills（需要时先调用 agent_read_file 读取，继续读取相对引用）：\n${JSON.stringify(skills.skills.filter(skill => skill.enabled))}${selected ? `\n\n本轮用户调用的 Skill：\n${await fs.readFile(selected.path, "utf8")}` : ""}`;
            client = await this.connect();
            if (projectId) {
                const scope = await client.callTool({ name: "canvas_set_active_project", arguments: { id: projectId } }, undefined, { signal: controller.signal });
                if (scope.isError) throw new Error("无法绑定本轮画布，未执行后续工具");
            }
            const tools = await this.tools(client);
            while (true) {
                controller.signal.throwIfAborted();
                const itemId = crypto.randomUUID();
                const reply = await requestLlm(provider, instructions, llmHistoryForProvider(thread.turns.flatMap(turn => turn.messages), provider), tools, controller.signal, delta => event("item.updated", { item: { id: itemId, type: "agent_message", delta, model: provider.name } }), options.effort);
                controller.signal.throwIfAborted();
                const message = reply.message;
                turn.messages.push(message);
                if (reply.usage) { usage.input_tokens += reply.usage.input_tokens; usage.output_tokens += reply.usage.output_tokens; usage.cached_input_tokens += reply.usage.cached_input_tokens; event("usage.updated", { usage: { ...usage } }); }
                const text = textOf(message);
                if (text) { turn.display.push(this.display(thread.id, turn.id, itemId, "assistant", text, provider.name)); event("item.completed", { item: { id: itemId, type: "agent_message", text, model: provider.name } }); }
                this.save(thread); // Persist intent before executing any tool, including paid generation.
                if (!message.calls?.length) break;
                const toolImages: Array<{ image: string }> = [];
                for (const call of message.calls) {
                    controller.signal.throwIfAborted();
                    const item: Json = { id: call.id, type: "mcp_tool_call", server: "infinite-canvas", tool: call.name, arguments: call.arguments, status: "in_progress" };
                    event("item.started", { item });
                    let result: unknown;
                    try {
                        const input = JSON.parse(call.arguments);
                        if (call.name === "director_subagent") {
                            input.parentThreadId = thread.id;
                            if (input.action === "spawn") { input.parentTurnId = turn.id; input.model ||= thread.model; input.effort ||= options.effort; }
                            if (projectId && !input.projectId) input.projectId = projectId;
                        }
                        const previous = turn.messages.find(message => message.role === "tool" && message.callId === call.id);
                        if (previous) result = JSON.parse(textOf(previous));
                        else if (call.name === readTool.name) result = { content: [{ type: "text", text: await readAgentFile(cwd, String(input.path || "")) }] };
                        else if (call.name === imageTool.name) {
                            const storageKey = String(input.storageKey || "");
                            if (!storageKey) throw new Error("必须提供真实 storageKey");
                            const response = await fetch(new URL(`/media/${encodeURIComponent(storageKey)}`, this.backendUrl), { headers: { authorization: `Bearer ${this.backendToken}` }, signal: controller.signal });
                            const mimeType = response.headers.get("content-type")?.split(";")[0] || "";
                            if (!response.ok || !mimeType.startsWith("image/")) { await response.body?.cancel(); throw new Error("归档图片不可读或不是图片，未作视觉判断"); }
                            result = { content: [{ type: "image", mimeType, data: Buffer.from(await response.arrayBuffer()).toString("base64") }] };
                        }
                        else {
                            if (!tools.some(tool => tool.name === call.name)) throw new Error("未登记的工具");
                            result = await client.callTool({ name: call.name, arguments: input }, undefined, { signal: controller.signal });
                        }
                    } catch (error) {
                        if (controller.signal.aborted) throw error;
                        result = { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "工具调用失败" }] };
                    }
                    const toolResult = result as Json;
                    const content = Array.isArray(toolResult?.content) ? toolResult.content as Json[] : [];
                    const images = content.filter(item => item.type === "image" && item.data && item.mimeType);
                    const modelResult = images.length ? { ...toolResult, content: content.map(item => item.type === "image" ? { type: "text", text: "工具图片已作为下一条视觉输入传入" } : item) } : result;
                    turn.messages.push({ role: "tool", callId: call.id, callName: call.name, parts: [{ text: JSON.stringify(modelResult) }] });
                    toolImages.push(...images.map(item => ({ image: `data:${item.mimeType};base64,${item.data}` })));
                    const completed = { ...item, status: toolResult?.isError ? "failed" : "completed", result: modelResult };
                    turn.display.push(this.display(thread.id, turn.id, call.id, "tool", call.name, call.name, completed));
                    this.save(thread); event("item.completed", { item: completed });
                }
                if (toolImages.length) { turn.messages.push({ role: "user", parts: [{ text: "上一轮工具返回的实际图片（顺序与工具调用相同）：" }, ...toolImages] }); this.save(thread); }
            }
            turn.status = "completed";
        } catch (error) {
            const message = controller.signal.aborted ? "任务已停止；已提交的媒体任务请按 taskId 核对" : error instanceof Error ? error.message : "Agent 执行失败";
            if (turn && thread) { turn.status = controller.signal.aborted ? "interrupted" : "failed"; turn.error = message; this.completeMissingResults(turn); turn.display.push(this.display(thread.id, turn.id, "synthetic:error", "error", message)); }
            emit("agent_error", { message, threadId: options.threadId, turnId: turn?.id });
        } finally {
            try { if (thread) this.save(thread); }
            finally {
                await client?.close().catch(() => {});
                this.controllers.delete(threadId);
                event("turn.completed", { status: turn?.status || "failed", ...(turn?.error ? { error: { message: turn.error } } : {}) });
                emit("agent_done", { agent: "llm", threadId: options.threadId, turnId: turn?.id, status: turn?.status || "failed", usage });
                options.onFinish?.();
            }
        }
    }
    /** Structured workers have read-only file access and never get generation or canvas-write tools. */
    async structured(request: { cwd: string; prompt: string; schema: Json; model?: string; effort?: string; threadId?: string; turnId?: string; recoverOutput?: boolean; images?: string[]; readRoots?: string[]; onThread: (id: string) => void; onTurn?: (id: string) => void }) {
        if (request.recoverOutput && !request.threadId) throw new Error("AGENT_RECOVERY_REQUIRED: 缺少原 API 线程身份，未创建或重跑工作者");
        const validate = new Ajv({ strict: false, allErrors: true }).compile(request.schema);
        const parseOutput = (text: string): unknown => {
            const output: unknown = JSON.parse(text);
            if (!validate(output)) throw new Error(`Agent 结构化结果不符合合同：${validate.errors?.map(error => `${error.instancePath || "/"} ${error.message}`).join("；")}`);
            return output;
        };
        const threadId = request.threadId || this.startThread(request.cwd, request.model, true).id;
        this.read(threadId, request.cwd);
        const thread = this.load(threadId, request.cwd);
        if (!request.threadId) request.onThread(threadId);
        if (request.recoverOutput) {
            const turn = thread.turns.at(-1);
            if (!turn || turn.id !== request.turnId || turn.status !== "completed") throw new Error("AGENT_RECOVERY_REQUIRED: 原 API 回合没有可恢复的完整结果，未自动重跑");
            return { threadId, output: parseOutput(textOf(turn.messages.at(-1)!)) };
        }
        const provider = resolveLlmProvider(this.settings.get("ai.config"), request.model || thread.model);
        const images = await Promise.all((request.images || []).map(async file => ({ image: `data:${/\.jpe?g$/i.test(file) ? "image/jpeg" : /\.webp$/i.test(file) ? "image/webp" : "image/png"};base64,${(await fs.readFile(file)).toString("base64")}` })));
        const controller = new AbortController();
        if (this.controllers.has(threadId)) throw new Error("当前 Agent 对话已有运行中的任务");
        this.controllers.set(threadId, controller);
        const turn: LlmTurn = { id: crypto.randomUUID(), status: "running", messages: [{ role: "user", parts: [{ text: request.prompt }, ...images] }], display: [] };
        thread.turns.push(turn);
        try {
            this.save(thread); request.onTurn?.(turn.id);
            while (true) {
                const reply = await requestLlm(provider, `按用户提供的正式合同返回结构化结果；需要先读取 Skill 文件。只读文件，不执行命令，不提交媒体、不写业务数据。最终回复必须是严格 JSON，不使用代码块。结果必须符合 JSON Schema：\n${JSON.stringify(request.schema)}`, llmHistoryForProvider(thread.turns.flatMap(turn => turn.messages), provider), [readTool], controller.signal, undefined, request.effort);
                controller.signal.throwIfAborted(); turn.messages.push(reply.message); this.save(thread);
                if (!reply.message.calls?.length) {
                    const output = parseOutput(textOf(reply.message));
                    turn.status = "completed"; this.save(thread); return { threadId, output };
                }
                for (const call of reply.message.calls) {
                    let result: unknown;
                    try { if (call.name !== readTool.name) throw new Error("结构化工作者只有只读文件工具"); result = { text: await readAgentFile(request.cwd, String(JSON.parse(call.arguments).path || ""), request.readRoots) }; }
                    catch (error) { result = { isError: true, message: error instanceof Error ? error.message : "文件读取失败" }; }
                    turn.messages.push({ role: "tool", callId: call.id, callName: call.name, parts: [{ text: JSON.stringify(result) }] }); this.save(thread);
                }
            }
        } catch (error) { turn.status = "failed"; turn.error = error instanceof Error ? error.message : "结构化结果失败"; this.completeMissingResults(turn); this.save(thread); throw error; }
        finally { this.controllers.delete(threadId); }
    }
    private completeMissingResults(turn: LlmTurn) {
        const results = new Set(turn.messages.filter(message => message.role === "tool").map(message => message.callId));
        for (const call of turn.messages.flatMap(message => message.calls || [])) if (!results.has(call.id)) {
            turn.messages.push({ role: "tool", callId: call.id, callName: call.name, parts: [{ text: JSON.stringify({ isError: true, message: "执行状态未知：进程或请求中断。不得自动重提付费任务；先使用原 operationId/taskId 查询回执和结果。", input: call.arguments }) }] }); results.add(call.id);
        }
    }
    private display(threadId: string, turnId: string, itemId: string, role: ChatMessage["role"], text: string, title?: string, detail?: unknown): ChatMessage { return { id: `${threadId}:${turnId}:${itemId}`, itemId, threadId, turnId, role, text, title, detail }; }
}

/** Read-only local access for Skills; all business writes stay in Backend MCP. */
export async function readAgentFile(cwd: string, input: string, readRoots: string[] = []) {
    const file = await fs.realpath(path.resolve(cwd, input));
    const roots = await Promise.all([cwd, userSkills, ...readRoots].map(root => fs.realpath(root).catch(() => root)));
    if (!roots.some(root => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); })) throw new Error("文件不属于当前工作空间或已登记 Skill 目录");
    return await fs.readFile(file, "utf8");
}
