import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "node:crypto";

import { loadConfig } from "./config.js";
import { BackendDatabase } from "./db.js";
import { ComfyUiBackend } from "./comfyui/bridge.js";
import { createStores } from "./stores/index.js";
import { PluginMcpRegistry, buildPluginMcpContext, type PluginMcpDeclaration, type PluginMcpBackend } from "@basketikun/canvas-agent/plugin-mcp";
import type { ComfyUiClient } from "@basketikun/canvas-agent/runtime/comfy-client";
import { toolDescriptions, toolInputSchemas, toolNames, type ToolName } from "@basketikun/canvas-agent/schemas";
import { buildCanvasToolRequest } from "@basketikun/canvas-agent/operations";

/** Backend 进程外的 MCP stdio 入口：直接打开 Backend 数据库和 ComfyUI Bridge。 */
export async function startBackendMcpServer() {
    const config = loadConfig(true);
    const db = new BackendDatabase();
    const stores = createStores(db);
    const comfy = new ComfyUiBackend({ tasks: stores.tasks, settings: stores.settings, media: stores.media });
    const directBackend: PluginMcpBackend = {
        listCanvasProjects: async () => db.listCanvasProjects(),
        replaceCanvasProjects: async (projects) => db.replaceCanvasProjects(projects),
        runtimeMediaStore: async (name, dataUrl) => ({ path: stores.media.storeDataUrl(dataUrl, name).path }),
        runtimeMediaPath: async (ref) => {
            const url = new URL(ref || "", config.url);
            if (!url.pathname.startsWith("/media/")) return ref;
            const storageKey = decodeURIComponent(url.pathname.slice("/media/".length));
            const media = stores.media.meta(storageKey);
            if (!media) throw new Error(`media not found: ${storageKey}`);
            return media.filePath;
        },
        comfyModels: (signal) => comfy.models(signal),
        comfyRun: (preset, input, params) => comfy.run(preset, input, params),
        comfyGetTask: async (id, after = 0) => {
            const task = stores.tasks.get(id);
            if (!task) throw new Error(`task not found: ${id}`);
            return { task, events: stores.tasks.events(id, after) };
        },
        comfyCancel: async (id) => comfy.cancel(id),
    };
    const comfyClient: ComfyUiClient = {
        status: () => comfy.status(), models: (signal) => comfy.models(signal), presets: () => comfy.presets(),
        run: (preset, input, params) => comfy.run(preset, input, params), cancel: (id) => Promise.resolve(comfy.cancel(id)),
        getUrl: async () => comfy.getUrl(), setUrl: async (url) => comfy.setUrl(url),
    };
    const server = new McpServer({ name: "infinite-canvas-backend", version: "0.1.0" });
    registerDirectCanvasTools(server, db, stores);
    registerDirectComfyTools(server, comfy, stores);
    registerBrowserCompatibilityTools(server, config);
    const context = buildPluginMcpContext({ url: config.url, token: config.token, backendUrl: config.url }, directBackend, comfyClient);
    const registry = new PluginMcpRegistry(server, context);
    const readDeclarations = () => db.listPluginDeclarations().map((item): PluginMcpDeclaration => ({
        id: item.id,
        name: item.name,
        version: item.version,
        mcp: { enabled: item.enabled, tools: item.tools as never },
    }));
    await registry.apply(readDeclarations());
    const declarationSync = setInterval(() => {
        void registry.apply(readDeclarations()).catch((error) => console.error("plugin MCP sync failed", error));
    }, 3000);
    declarationSync.unref();
    await server.connect(new StdioServerTransport());
}

const DIRECT_CANVAS_TOOLS = [
    "canvas_list_projects", "canvas_get_state", "canvas_get_selection", "canvas_export_snapshot", "canvas_apply_ops",
    "canvas_create_node", "canvas_create_text_node", "canvas_create_text_nodes", "canvas_create_config_node",
    "canvas_create_image_prompt_flow", "canvas_create_generation_flow", "canvas_generate_text", "canvas_generate_image", "canvas_generate_video", "canvas_generate_audio",
    "canvas_update_node", "canvas_update_node_text", "canvas_move_nodes", "canvas_resize_node", "canvas_delete_nodes", "canvas_connect_nodes", "canvas_select_nodes", "canvas_set_viewport", "canvas_run_generation", "generation_get_status",
] as ToolName[];
const DIRECT_TOOL_NAMES = new Set<ToolName>([...DIRECT_CANVAS_TOOLS, "assets_list", "assets_add", "comfyui_status", "comfyui_list_presets", "comfyui_run", "comfyui_get_task", "comfyui_cancel_task", "generation_get_status"]);

function registerDirectCanvasTools(server: McpServer, db: BackendDatabase, stores: ReturnType<typeof createStores>) {
    for (const name of DIRECT_CANVAS_TOOLS) {
        const schema = toolInputSchemas[name];
        server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (rawInput) => {
            const input = schema.parse(rawInput) as Record<string, unknown>;
            if (name === "canvas_list_projects") {
                const keyword = String(input.keyword || "").trim().toLowerCase();
                const all = db.listCanvasProjects()
                    .filter((project) => !keyword || String(project.title || project.name || "").toLowerCase().includes(keyword))
                    .map((project) => ({ id: project.id, title: project.title, updatedAt: project.updatedAt, nodeCount: Array.isArray(project.nodes) ? project.nodes.length : 0, connectionCount: Array.isArray(project.connections) ? project.connections.length : 0 }));
                const pageSize = Math.max(1, Math.min(100, Number(input.pageSize || 20)));
                const page = Math.max(1, Number(input.page || 1));
                return textResult({ projects: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize });
            }
            if (name === "generation_get_status") return textResult(listTasks(db, input));
            const project = currentProject(db); const state = project as Record<string, unknown>;
            if (name === "canvas_get_state" || name === "canvas_export_snapshot") return textResult(compactProject(state));
            if (name === "canvas_get_selection") { const ids = new Set(Array.isArray(state.selectedNodeIds) ? state.selectedNodeIds.map(String) : []); return textResult({ nodes: nodesOf(state).filter((node) => ids.has(String(node.id))) }); }
            const request = buildCanvasToolRequest(name, input, { nodes: nodesOf(state), connections: connectionsOf(state), viewport: state.viewport as never } as never);
            applyCanvasOps(state, Array.isArray(request.input.ops) ? request.input.ops as Array<Record<string, unknown>> : []);
            state.updatedAt = new Date().toISOString(); db.upsertCanvasProject(state as never);
            return textResult({ ok: true, projectId: project.id, state: compactProject(state) });
        });
    }
    for (const name of ["assets_list", "assets_add"] as ToolName[]) {
        const schema = toolInputSchemas[name];
        server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (rawInput) => {
            const input = schema.parse(rawInput) as Record<string, unknown>;
            if (name === "assets_list") return textResult(stores.assets.list({ kind: input.kind && input.kind !== "all" ? String(input.kind) : undefined }));
            const now = new Date().toISOString();
            const asset = stores.assets.upsert({ id: `asset-${crypto.randomUUID()}`, kind: String(input.kind || "text"), title: String(input.title || ""), coverUrl: String(input.imageUrl || ""), tags: Array.isArray(input.tags) ? input.tags.map(String) : [], folderId: null, data: { content: input.content || "", imageUrl: input.imageUrl || "" }, note: input.note ? String(input.note) : null, source: input.source ? String(input.source) : null, metadata: {}, createdAt: now, updatedAt: now });
            return textResult(asset);
        });
    }
}

function listTasks(db: BackendDatabase, input: Record<string, unknown>) {
    const taskId = typeof input.taskId === "string" ? input.taskId : "";
    const rows = taskId
        ? db.db.prepare("SELECT * FROM tasks WHERE id = ?").all(taskId)
        : db.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(500, Number(input.limit || 100))));
    return (rows as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), kind: String(row.kind), status: String(row.status), progress: Number(row.progress), input: parseJson(row.input_json), params: parseJson(row.params_json), result: row.result_json ? parseJson(row.result_json) : null, error: row.error ? String(row.error) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }));
}
function parseJson(value: unknown): Record<string, unknown> { try { const parsed = JSON.parse(String(value || "{}")); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; } }

function currentProject(db: BackendDatabase) { const project = db.listCanvasProjects()[0]; if (!project) throw new Error("当前没有画布项目"); return project; }
function nodesOf(project: Record<string, unknown>) { return Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : []; }
function connectionsOf(project: Record<string, unknown>) { return Array.isArray(project.connections) ? project.connections as Array<Record<string, unknown>> : []; }
function compactProject(project: Record<string, unknown>) { return { ...project, nodes: nodesOf(project), connections: connectionsOf(project) }; }
function textResult(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }; }
function applyCanvasOps(project: Record<string, unknown>, ops: Array<Record<string, unknown>>) {
    const nodes = nodesOf(project); const connections = connectionsOf(project);
    project.nodes = nodes;
    project.connections = connections;
    for (const op of ops) {
        if (op.type === "add_node") { const node = { id: String(op.id || `${String(op.nodeType || "node")}-${crypto.randomUUID()}`), type: String(op.nodeType || "text"), title: String(op.title || ""), position: op.position || { x: Number(op.x || 0), y: Number(op.y || 0) }, width: Number(op.width || 320), height: Number(op.height || 240), metadata: op.metadata || {} }; nodes.push(node); }
        if (op.type === "update_node") { const node = nodes.find((item) => item.id === op.id); if (!node) throw new Error(`找不到节点：${String(op.id)}`); Object.assign(node, op.patch || {}); if (op.metadata) node.metadata = { ...(node.metadata as object || {}), ...(op.metadata as object) }; }
        if (op.type === "delete_node") { const ids = new Set(Array.isArray(op.ids) ? op.ids.map(String) : [String(op.id || "")]); for (let index = nodes.length - 1; index >= 0; index--) if (ids.has(String(nodes[index].id))) nodes.splice(index, 1); for (let index = connections.length - 1; index >= 0; index--) if (ids.has(String(connections[index].fromNodeId)) || ids.has(String(connections[index].toNodeId))) connections.splice(index, 1); }
        if (op.type === "connect_nodes") connections.push({ id: `connection-${crypto.randomUUID()}`, fromNodeId: op.fromNodeId, toNodeId: op.toNodeId });
        if (op.type === "select_nodes") project.selectedNodeIds = Array.isArray(op.ids) ? op.ids : [];
        if (op.type === "set_viewport") project.viewport = op.viewport;
    }
}

function registerDirectComfyTools(server: McpServer, comfy: ComfyUiBackend, stores: ReturnType<typeof createStores>) {
    server.registerTool("comfyui_status", { description: "检查本地 ComfyUI 连接和系统状态。", inputSchema: z.object({}).shape }, async () => ({ content: [{ type: "text", text: JSON.stringify(await comfy.status()) }] }));
    server.registerTool("comfyui_list_presets", { description: "列出本地 ComfyUI 内置预设。", inputSchema: z.object({}).shape }, async () => ({ content: [{ type: "text", text: JSON.stringify(comfy.presets()) }] }));
    server.registerTool("comfyui_run", { description: "运行本地 ComfyUI 预设。", inputSchema: z.object({ preset: z.string(), input: z.record(z.unknown()).optional(), params: z.record(z.unknown()).optional() }).shape }, async (input) => ({ content: [{ type: "text", text: JSON.stringify(await comfy.run(input.preset, input.input || {}, input.params || {})) }] }));
    server.registerTool("comfyui_get_task", { description: "查询 ComfyUI 任务。", inputSchema: z.object({ taskId: z.string() }).shape }, async ({ taskId }) => { const task = stores.tasks.get(taskId); if (!task) throw new Error(`task not found: ${taskId}`); return { content: [{ type: "text", text: JSON.stringify({ task, events: stores.tasks.events(taskId) }) }] }; });
    server.registerTool("comfyui_cancel_task", { description: "取消 ComfyUI 任务。", inputSchema: z.object({ taskId: z.string() }).shape }, async ({ taskId }) => ({ content: [{ type: "text", text: JSON.stringify(comfy.cancel(taskId)) }] }));
}

/** 工作台、网页导航和对话工具仍需要当前浏览器会话，保留旧协议兼容入口。 */
function registerBrowserCompatibilityTools(server: McpServer, config: ReturnType<typeof loadConfig>) {
    for (const name of toolNames.filter((item) => !DIRECT_TOOL_NAMES.has(item) && !item.startsWith("h3_"))) {
        const schema = toolInputSchemas[name];
        server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (input) => {
            const response = await fetch(`${config.url.replace(/\/$/, "")}/agent/api/tools`, {
                method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
                body: JSON.stringify({ name, input: schema.parse(input) }),
            });
            const body = await response.json().catch(() => ({})) as { ok?: boolean; result?: unknown; error?: string };
            if (!response.ok || !body.ok) throw new Error(body.error || `浏览器 Agent 工具调用失败：HTTP ${response.status}`);
            return textResult(body.result);
        });
    }
}
