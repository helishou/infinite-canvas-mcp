import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { BackendDatabase } from "./db.js";
import { ComfyUiBackend } from "./comfyui/bridge.js";
import { createStores } from "./stores/index.js";
import { PluginMcpRegistry, buildPluginMcpContext, type PluginMcpDeclaration, type PluginMcpBackend } from "@basketikun/canvas-agent/plugin-mcp";
import type { ComfyUiClient } from "@basketikun/canvas-agent/runtime/comfy-client";

/** Backend 进程外的 MCP stdio 入口：直接打开 Backend 数据库和 ComfyUI Bridge。 */
export async function startBackendMcpServer() {
    const config = loadConfig(true);
    const db = new BackendDatabase();
    const stores = createStores(db);
    const comfy = new ComfyUiBackend({ tasks: stores.tasks, settings: stores.settings });
    const directBackend: PluginMcpBackend = {
        listCanvasProjects: async () => db.listCanvasProjects(),
        replaceCanvasProjects: async (projects) => db.replaceCanvasProjects(projects),
        runtimeMediaStore: async (name, dataUrl) => ({ path: stores.media.storeDataUrl(dataUrl, name).path }),
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
    registerDirectComfyTools(server, comfy, stores);
    const context = buildPluginMcpContext({ url: config.url, token: config.token, backendUrl: config.url }, directBackend, comfyClient);
    const registry = new PluginMcpRegistry(server, context);
    await registry.apply(db.listPluginDeclarations().map((item): PluginMcpDeclaration => ({ id: item.id, name: item.name, version: item.version, mcp: { enabled: item.enabled, tools: item.tools as never } })));
    await server.connect(new StdioServerTransport());
}

function registerDirectComfyTools(server: McpServer, comfy: ComfyUiBackend, stores: ReturnType<typeof createStores>) {
    server.registerTool("comfyui_status", { description: "检查本地 ComfyUI 连接和系统状态。", inputSchema: z.object({}).shape }, async () => ({ content: [{ type: "text", text: JSON.stringify(await comfy.status()) }] }));
    server.registerTool("comfyui_list_presets", { description: "列出本地 ComfyUI 内置预设。", inputSchema: z.object({}).shape }, async () => ({ content: [{ type: "text", text: JSON.stringify(comfy.presets()) }] }));
    server.registerTool("comfyui_run", { description: "运行本地 ComfyUI 预设。", inputSchema: z.object({ preset: z.string(), input: z.record(z.unknown()).optional(), params: z.record(z.unknown()).optional() }).shape }, async (input) => ({ content: [{ type: "text", text: JSON.stringify(await comfy.run(input.preset, input.input || {}, input.params || {})) }] }));
    server.registerTool("comfyui_get_task", { description: "查询 ComfyUI 任务。", inputSchema: z.object({ taskId: z.string() }).shape }, async ({ taskId }) => { const task = stores.tasks.get(taskId); if (!task) throw new Error(`task not found: ${taskId}`); return { content: [{ type: "text", text: JSON.stringify({ task, events: stores.tasks.events(taskId) }) }] }; });
    server.registerTool("comfyui_cancel_task", { description: "取消 ComfyUI 任务。", inputSchema: z.object({ taskId: z.string() }).shape }, async ({ taskId }) => ({ content: [{ type: "text", text: JSON.stringify(comfy.cancel(taskId)) }] }));
}
