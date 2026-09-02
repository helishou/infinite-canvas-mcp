import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { toolDescriptions, toolInputSchemas, toolNames, type ToolName } from "../canvas/schemas.js";
import { AGENT_PROMPT, loadConfig, VERSION } from "../config.js";
import { createBackendClient } from "../runtime/comfy-client.js";
import { startPluginMcp } from "./plugin-mcp.js";

type CanvasAgentToolResponse = { ok?: boolean; result?: unknown; error?: string };

/** 启动通过标准输入输出通信的 MCP 服务。 */
export async function startMcpServer() {
    const config = loadConfig(true);
    const backend = createBackendClient(config.backendUrl || `http://127.0.0.1:17370`);
    const server = new McpServer({ name: "canvas-agent", version: VERSION }, { instructions: AGENT_PROMPT });
    toolNames.forEach((name) => registerCanvasTool(server, backend, name));
    await startPluginMcp(server); // 插件 MCP 动态注册(冷启动加载 + 轮询浏览器启用态)
    await server.connect(new StdioServerTransport());
}

/** 向 MCP Server 注册单个 Canvas Agent 工具。 */
function registerCanvasTool(server: McpServer, backend: ReturnType<typeof createBackendClient>, name: ToolName) {
    const schema = toolInputSchemas[name];
    server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (input: unknown) => {
        const result = await postCanvasAgentTool(backend, name, schema.parse(input));
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    });
}

/** 将 MCP 工具调用转发到本地 Canvas Agent HTTP 服务。 */
async function postCanvasAgentTool(backend: ReturnType<typeof createBackendClient>, name: ToolName, input: unknown) {
    const body = await backend.post<CanvasAgentToolResponse>("/agent/api/tools", { name, input });
    if (!body.ok) throw new Error(body.error || "tool call failed");
    return body.result;
}
