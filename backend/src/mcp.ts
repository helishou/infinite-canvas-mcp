import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "node:crypto";
import { nanoid } from "nanoid";

import { loadConfig } from "./config.js";
import { BackendDatabase } from "./db.js";
import { ComfyUiBackend } from "./comfyui/bridge.js";
import { createStores } from "./stores/index.js";
import { PluginMcpRegistry, buildPluginMcpContext, type PluginMcpDeclaration, type PluginMcpBackend } from "@basketikun/canvas-agent/plugin-mcp";
import type { CanvasProject, GenerationLogStatus } from "./db.js";
import type { PluginDeclaration } from "./db.js";
import type { ComfyUiClient } from "@basketikun/canvas-agent/runtime/comfy-client";
import { toolDescriptions, toolInputSchemas, toolNames, type ToolName } from "@basketikun/canvas-agent/schemas";
import { buildCanvasToolRequest } from "@basketikun/canvas-agent/operations";
import { DirectImageBackend } from "./runtime/chatgpt-image.js";
import { CanvasImageDispatcher, type CanvasImageGenerationInput, type CanvasImageGenerationResult } from "./canvas/image-dispatcher.js";
import { WorkflowStore } from "./workflows/store.js";
import { WorkflowExecutor } from "./workflows/executor.js";

/** 当前活动画布 ID（MCP 进程内状态，用于多画布路由）。 */
let activeProjectId: string | null = null;

/** Backend 进程外的 MCP stdio 入口：直接打开 Backend 数据库和 ComfyUI Bridge。 */
export async function startBackendMcpServer() {
    const config = loadConfig(true);
    const db = new BackendDatabase();
    const stores = createStores(db);
    const comfy = new ComfyUiBackend({ tasks: stores.tasks, settings: stores.settings, media: stores.media });
    const directImage = new DirectImageBackend(stores.tasks, stores.media);
    const workflowStore = new WorkflowStore(db);
    const workflowExecutor = new WorkflowExecutor(comfy, stores.tasks, stores.media, undefined, db);
    const imageDispatcher = new CanvasImageDispatcher(config, stores, comfy, directImage, workflowStore, workflowExecutor);
    const directBackend: PluginMcpBackend = {
        listCanvasProjects: async () => db.listCanvasProjects(),
        upsertCanvasProject: async (project) => db.upsertCanvasProject(project as CanvasProject),
        replaceCanvasProjects: async (projects) => db.replaceCanvasProjects(projects as CanvasProject[]),
        replacePluginDeclarations: async (declarations) => db.replacePluginDeclarations(declarations as PluginDeclaration[]),
        runtimeMediaStore: async (name, dataUrl, storageKey) => {
            if (storageKey) {
                const media = stores.media.meta(decodeURIComponent(storageKey));
                if (!media) throw new Error(`media not found: ${storageKey}`);
                return { path: media.filePath };
            }
            return { path: stores.media.storeDataUrl(dataUrl, name).path };
        },
        runtimeMediaPath: async (ref) => {
            const url = new URL(ref || "", config.url);
            if (!url.pathname.startsWith("/media/")) return ref;
            const storageKey = decodeURIComponent(url.pathname.slice("/media/".length));
            const media = stores.media.meta(storageKey);
            if (!media) throw new Error(`media not found: ${storageKey}`);
            return media.filePath;
        },
        listGenerationLogs: async (options = {}) => stores.logs.list({ ...options, status: options.status && ["queued", "running", "success", "failed", "cancelled"].includes(options.status) ? options.status as GenerationLogStatus : undefined }),
        createGenerationLog: async (input) => stores.logs.create(input as never),
        updateGenerationLog: async (id, patch) => stores.logs.update(id, patch as never),
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
    registerDirectCanvasTools(server, db, stores, config, imageDispatcher);
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

function registerDirectCanvasTools(server: McpServer, db: BackendDatabase, stores: ReturnType<typeof createStores>, config: ReturnType<typeof loadConfig>, imageDispatcher: CanvasImageDispatcher) {
    for (const name of DIRECT_CANVAS_TOOLS) {
        const schema = toolInputSchemas[name];
        server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (rawInput: Record<string, unknown>) => {
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
            const ops = Array.isArray(request.input.ops) ? request.input.ops as Array<Record<string, unknown>> : [];
            applyCanvasOps(state, ops);
            state.updatedAt = new Date().toISOString();
            const saved = await saveCanvasProject(config, state as CanvasProject);
            const directTasks: Array<{ taskId: string; nodeId: string; model: string }> = [];
            for (const op of ops) {
                if (op.type !== "run_generation" || String(op.mode || "image") !== "image") continue;
                const source = nodesOf(state).find((node) => String(node.id) === String(op.nodeId));
                if (!source) continue;
                const sourceMetadata = recordOf(source.metadata);
                const selectedModel = String(sourceMetadata.model || "").trim();
                if (!selectedModel) continue;
                const imageRequest = buildCanvasImageRequest(source, state, op, selectedModel);
                const sourceId = String(source.id);
                const task = imageDispatcher.start(imageRequest, {
                    onCompleted: (result, completed) => completeCanvasImageGeneration(config, db, saved.id, sourceId, imageRequest.prompt, selectedModel, result, completed.id),
                    onFailed: (error, failed) => failDirectImageGeneration(config, db, saved.id, sourceId, failed.id, error.message),
                });
                markDirectImageLoading(state, sourceId, task.taskId);
                directTasks.push({ taskId: task.taskId, nodeId: sourceId, model: selectedModel });
            }
            const withLoadingState = directTasks.length ? await saveCanvasProject(config, state as CanvasProject) : saved;
            return textResult({ ok: true, projectId: withLoadingState.id, directTasks, state: compactProject(withLoadingState as Record<string, unknown>) });
        });
    }
    for (const name of ["assets_list", "assets_add"] as ToolName[]) {
        const schema = toolInputSchemas[name];
        server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (rawInput: Record<string, unknown>) => {
            const input = schema.parse(rawInput) as Record<string, unknown>;
            if (name === "assets_list") return textResult(stores.assets.list({ kind: input.kind && input.kind !== "all" ? String(input.kind) : undefined }));
            const now = new Date().toISOString();
            const asset = stores.assets.upsert({ id: `asset-${crypto.randomUUID()}`, kind: String(input.kind || "text"), title: String(input.title || ""), coverUrl: String(input.imageUrl || ""), tags: Array.isArray(input.tags) ? input.tags.map(String) : [], folderId: null, data: { content: input.content || "", imageUrl: input.imageUrl || "" }, note: input.note ? String(input.note) : null, source: input.source ? String(input.source) : null, metadata: {}, createdAt: now, updatedAt: now });
            return textResult(asset);
        });
    }
    // ── 画布管理（创建/删除/切换） ──────────────────────────────────────
    server.registerTool("canvas_create_project", {
        description: "创建新画布。返回 id、title、createdAt。可选 title（默认「未命名画布」）。",
        inputSchema: z.object({ title: z.string().optional() }).shape,
    }, async (rawInput: Record<string, unknown>) => {
        const title = String(rawInput.title || "未命名画布").trim() || "未命名画布";
        const now = new Date().toISOString();
        const id = nanoid();
        const project: CanvasProject = {
            id, title, createdAt: now, updatedAt: now,
            nodes: [], connections: [], chatSessions: [], activeChatId: null,
            backgroundMode: "lines", showImageInfo: false, globalPrompt: "",
            viewport: { x: 0, y: 0, zoom: 1 },
        };
        const saved = await saveCanvasProject(config, project);
        activeProjectId = id;
        return textResult({ ok: true, id: saved.id, title: saved.title, createdAt: saved.createdAt });
    });
    server.registerTool("canvas_delete_project", {
        description: "按 id 删除画布。删除后 activeProjectId 自动清空（若指向被删画布）。",
        inputSchema: z.object({ id: z.string() }).shape,
    }, async (rawInput: Record<string, unknown>) => {
        const id = String(rawInput.id);
        const deleted = await deleteCanvasProject(config, id);
        if (activeProjectId === id) activeProjectId = null;
        return textResult({ ok: true, deleted: deleted > 0 });
    });
    server.registerTool("canvas_set_active_project", {
        description: "设置当前活动画布（后续 MCP 操作目标）。不传 id 则清空（fallback 到列表第一个）。",
        inputSchema: z.object({ id: z.string().optional() }).shape,
    }, async (rawInput: Record<string, unknown>) => {
        const id = rawInput.id ? String(rawInput.id) : "";
        if (id) {
            const project = db.getCanvasProject(id);
            if (!project) throw new Error(`画布不存在: ${id}`);
            activeProjectId = id;
        } else {
            activeProjectId = null;
        }
        return textResult({ ok: true, activeProjectId: activeProjectId || null });
    });
}

function buildCanvasImageRequest(source: Record<string, unknown>, project: Record<string, unknown>, op: Record<string, unknown>, model: string): CanvasImageGenerationInput {
    const metadata = recordOf(source.metadata);
    const incomingConnections = connectionsOf(project).filter((connection) => String(connection.toNodeId) === String(source.id));
    const connectedTextPrompts = incomingConnections.flatMap((connection) => {
        const node = nodesOf(project).find((item) => String(item.id) === String(connection.fromNodeId));
        if (!node || String(node.type) !== "text") return [];
        const textMetadata = recordOf(node.metadata);
        const content = String(textMetadata.content || "").trim();
        return content ? [content] : [];
    });
    const rawPrompt = String(op.prompt || connectedTextPrompts.join("\n\n") || metadata.composerContent || metadata.prompt || "");
    const referencedIds = new Set<string>();
    for (const match of rawPrompt.matchAll(/@\[node:([^\]]+)\]/g)) referencedIds.add(match[1]);
    for (const connection of incomingConnections) {
        const node = nodesOf(project).find((item) => String(item.id) === String(connection.fromNodeId));
        if (node && String(node.type) === "image") referencedIds.add(String(node.id));
    }
    if (String(source.type) === "image" && (metadata.content || metadata.url || metadata.storageKey)) referencedIds.add(String(source.id));

    const prompt = rawPrompt.replace(/@\[node:([^\]]+)\]/g, (_token, id: string) => {
        const node = nodesOf(project).find((item) => String(item.id) === id);
        return node && String(node.type) === "text" ? String(recordOf(node.metadata).content || "") : "";
    }).trim();
    if (!prompt) throw new Error("画布图片提示词为空");

    const references = [...referencedIds].flatMap((id) => {
        const node = nodesOf(project).find((item) => String(item.id) === id);
        if (!node || String(node.type) !== "image") return [];
        const nodeMetadata = recordOf(node.metadata);
        return [{
            id,
            name: `${String(node.title || id).replace(/[^\w\u4e00-\u9fff-]+/g, "-")}.png`,
            storageKey: String(nodeMetadata.storageKey || "") || undefined,
            dataUrl: String(nodeMetadata.content || "").startsWith("data:") ? String(nodeMetadata.content) : undefined,
            url: String(nodeMetadata.content || nodeMetadata.url || "") || undefined,
            mimeType: String(nodeMetadata.mimeType || "image/png"),
        }];
    });
    const params = recordOf(metadata.params || metadata.customFieldValues);
    const size = normalizeGptImageSize(metadata.size);
    const [width, height] = size.split("x").map(Number);
    return {
        model,
        prompt,
        references,
        size,
        width,
        height,
        quality: String(metadata.quality || "auto"),
        count: Math.max(1, Math.min(4, Number(metadata.count || 1))),
        params,
        clientTaskId: `canvas-${crypto.randomUUID()}`,
    };
}

async function completeCanvasImageGeneration(
    config: ReturnType<typeof loadConfig>,
    db: BackendDatabase,
    projectId: string,
    sourceId: string,
    prompt: string,
    model: string,
    result: CanvasImageGenerationResult,
    taskId: string,
) {
    const project = db.getCanvasProject(projectId);
    if (!project) return;
    const nodes = nodesOf(project);
    const connections = connectionsOf(project);
    const source = nodes.find((node) => String(node.id) === sourceId);
    if (!source) return;
    const sourcePosition = recordOf(source.position);
    const sourceWidth = Number(source.width || 320);
    const createdIds: string[] = [];
    result.media.forEach((output, index) => {
        const id = `image-${crypto.randomUUID()}`;
        createdIds.push(id);
        nodes.push({
            id,
            type: "image",
            title: `${String(source.title || "图片生成")}｜结果${result.media.length > 1 ? ` ${index + 1}` : ""}`,
            position: { x: Number(sourcePosition.x || 0) + sourceWidth + 96 + index * 720, y: Number(sourcePosition.y || 0) },
            width: output.width || 680,
            height: output.height || 454,
            metadata: {
                content: output.url,
                url: output.url,
                storageKey: output.storageKey || "",
                mimeType: output.mimeType || "image/png",
                bytes: output.bytes,
                naturalWidth: output.width,
                naturalHeight: output.height,
                prompt,
                model,
                generationType: result.media.length && model.toLowerCase().includes("gpt-image") ? "edit" : "generation",
                source: "MCP canvas image dispatcher",
                status: "success",
            },
        });
        connections.push({ id: `connection-${crypto.randomUUID()}`, fromNodeId: sourceId, toNodeId: id });
    });
    if (!createdIds.length) throw new Error("生成完成但没有返回图片");
    source.metadata = { ...recordOf(source.metadata), status: "success", runtimeTaskId: undefined, errorDetails: undefined, model, prompt, primaryImageId: createdIds[0], generationTaskId: taskId };
    project.updatedAt = new Date().toISOString();
    await saveCanvasProject(config, project);
}

function markDirectImageLoading(project: Record<string, unknown>, nodeId: string, taskId: string) {
    const node = nodesOf(project).find((item) => String(item.id) === nodeId);
    if (!node) return;
    node.metadata = { ...recordOf(node.metadata), status: "loading", runtimeTaskId: taskId, errorDetails: undefined };
}

async function failDirectImageGeneration(config: ReturnType<typeof loadConfig>, db: BackendDatabase, projectId: string, sourceId: string, taskId: string, error: string) {
    const project = db.getCanvasProject(projectId);
    if (!project) return;
    const source = nodesOf(project).find((node) => String(node.id) === sourceId);
    if (!source) return;
    source.metadata = { ...recordOf(source.metadata), status: "error", runtimeTaskId: undefined, errorDetails: error };
    project.updatedAt = new Date().toISOString();
    await saveCanvasProject(config, project);
}

function normalizeGptImageSize(value: unknown) {
    const size = String(value || "1024x1024").trim().toLowerCase();
    if (/^\d+x\d+$/.test(size)) return size;
    if (size === "16:9") return "1536x1024";
    if (size === "9:16") return "1024x1536";
    return "1024x1024";
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function listTasks(db: BackendDatabase, input: Record<string, unknown>) {
    const taskId = typeof input.taskId === "string" ? input.taskId : "";
    const rows = taskId
        ? db.db.prepare("SELECT * FROM tasks WHERE id = ?").all(taskId)
        : db.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(500, Number(input.limit || 100))));
    return (rows as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), kind: String(row.kind), status: String(row.status), progress: Number(row.progress), input: parseJson(row.input_json), params: parseJson(row.params_json), result: row.result_json ? parseJson(row.result_json) : null, error: row.error ? String(row.error) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }));
}
function parseJson(value: unknown): Record<string, unknown> { try { const parsed = JSON.parse(String(value || "{}")); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; } }

function currentProject(db: BackendDatabase) {
    const projects = db.listCanvasProjects();
    if (activeProjectId) {
        const found = projects.find((p) => p.id === activeProjectId);
        if (found) return found;
    }
    if (projects.length === 0) throw new Error("当前没有画布项目");
    return projects[0];
}
function nodesOf(project: Record<string, unknown>) { return Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : []; }
function connectionsOf(project: Record<string, unknown>) { return Array.isArray(project.connections) ? project.connections as Array<Record<string, unknown>> : []; }
function compactProject(project: Record<string, unknown>) { return { ...project, nodes: nodesOf(project), connections: connectionsOf(project) }; }
function textResult(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }; }

async function saveCanvasProject(config: ReturnType<typeof loadConfig>, project: CanvasProject): Promise<CanvasProject> {
    const response = await fetch(`${config.url.replace(/\/$/, "")}/canvas/projects?token=${encodeURIComponent(config.token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(project),
    });
    const body = await response.json().catch(() => ({})) as { project?: CanvasProject; error?: string };
    if (!response.ok || !body.project) throw new Error(body.error || `画布写入失败: HTTP ${response.status}`);
    return body.project;
}

async function deleteCanvasProject(config: ReturnType<typeof loadConfig>, id: string): Promise<number> {
    const response = await fetch(`${config.url.replace(/\/$/, "")}/canvas/projects/${encodeURIComponent(id)}?token=${encodeURIComponent(config.token)}`, { method: "DELETE" });
    const body = await response.json().catch(() => ({})) as { deleted?: number; error?: string };
    if (!response.ok) throw new Error(body.error || `画布删除失败: HTTP ${response.status}`);
    return Number(body.deleted || 0);
}

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
        server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (input: Record<string, unknown>) => {
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
