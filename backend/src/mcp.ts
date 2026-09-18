import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import crypto from "node:crypto";
import {
  executeCollaborationTool,
  isCollaborationTool,
} from "@basketikun/canvas-agent/collaboration-tools";
import { nanoid } from "nanoid";
import type { Express, Request, Response } from "express";

import { loadConfig, type ResolvedConfig } from "./config.js";
import {
  PluginMcpRegistry,
  buildPluginMcpContext,
  loadPluginMcpDeclarationsFromBackend,
  type PluginMcpBackend,
} from "@basketikun/canvas-agent/plugin-mcp";
import type { CanvasProject, McpObservabilityEventInput } from "./db.js";
import {
  toolDescriptions,
  toolInputSchemas,
  toolNames,
  type ToolName,
} from "@basketikun/canvas-agent/schemas";
import {
  buildCanvasToolRequest,
  sanitizeCanvasPrompt,
} from "@basketikun/canvas-agent/operations";
import { createH3NodeMetadata } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import type { CanvasImageGenerationInput } from "./canvas/image-dispatcher.js";
import type { CanvasTextGenerationInput } from "./canvas/text-dispatcher.js";
import { splitImageBuffer } from "./canvas/image-split.js";
import {
  backendComfyUi,
  createBackendClient,
} from "@basketikun/canvas-agent/runtime/comfy-client";
import { createLogger } from "./logger.js";
import type { McpObservabilityStore } from "./stores/types.js";

type McpSessionState = { activeProjectId: string | null; clientId: string };
type BackendMcpInstance = { server: McpServer; registry: PluginMcpRegistry };
type McpEventRecorder = (event: McpObservabilityEventInput) => void | Promise<void>;
const logger = createLogger("mcp-http");

/** Backend 进程外的 MCP stdio 入口：所有业务写入都经由常驻 Backend API。 */
export async function startBackendMcpServer() {
  const config = loadConfig(true);
  const instance = await createBackendMcpInstance(config);
  const declarationSync = setInterval(() => {
    void refreshPluginDeclarations(config, [instance.registry]).catch((error) =>
      console.error("plugin MCP sync failed", error),
    );
  }, 3000);
  declarationSync.unref();
  const transport = new StdioServerTransport();
  transport.onclose = () => clearInterval(declarationSync);
  await instance.server.connect(transport);
}

async function createBackendMcpInstance(
  config: ResolvedConfig,
  recordEvent: McpEventRecorder = (event) => postMcpObservabilityEvent(config, event),
): Promise<BackendMcpInstance> {
  const state: McpSessionState = {
    activeProjectId: null,
    clientId: `mcp:${crypto.randomUUID()}`,
  };
  // 插件 MCP（尤其 H3）只通过常驻 Backend API 访问画布、任务、媒体和设置，
  // 不再在 MCP 进程内创建自己的 ComfyUI/SQLite 业务副本。
  const backendApi = createBackendClient(config.url);
  const backendComfy = backendComfyUi(backendApi, () => []);
  const directBackend: PluginMcpBackend = {
    listCanvasProjects: () => backendApi.listCanvasProjects(),
    applyCanvasOperations: (projectId, operations, expectedRevision) =>
      applyBackendCanvasOperations(
        config,
        projectId,
        expectedRevision,
        operations,
        state.clientId,
      ),
    replacePluginDeclarations: (declarations) =>
      backendApi.replacePluginDeclarations(declarations),
    canvasRunGeneration: (input) => backendApi.canvasRunGeneration(input),
    getTask: (id) => backendApi.getTask(id),
    cancelTask: (id) => backendApi.cancelTask(id),
    getH3Defaults: () => backendApi.getH3Defaults(),
    setH3Defaults: (settings) => backendApi.setH3Defaults(settings),
    resetH3Defaults: () => backendApi.resetH3Defaults(),
  };
  const server = new McpServer({
    name: "infinite-canvas-backend",
    version: "0.1.0",
  });
  installMcpToolObservability(server, state, recordEvent);
  registerDirectCanvasTools(server, config, backendApi, state, recordEvent);
  registerDirectComfyTools(server, backendApi);
  registerBrowserCompatibilityTools(server, config);
  const context = buildPluginMcpContext(
    { url: config.url, token: config.token, backendUrl: config.url },
    directBackend,
    backendComfy,
    (name, input) =>
      executeDirectCanvasTool(config, backendApi, state, name, input),
  );
  const registry = new PluginMcpRegistry(server, context);
  await registry.apply(await loadPluginMcpDeclarationsFromBackend(backendApi));
  return { server, registry };
}

async function refreshPluginDeclarations(
  config: ResolvedConfig,
  registries: PluginMcpRegistry[],
) {
  if (!registries.length) return;
  const backend = createBackendClient(config.url);
  const declarations = await loadPluginMcpDeclarationsFromBackend(backend);
  await Promise.all(registries.map((registry) => registry.apply(declarations)));
}

type HttpMcpSession = {
  instance: BackendMcpInstance;
  transport: StreamableHTTPServerTransport;
};

/**
 * 在常驻 Backend 进程内提供共享 Streamable HTTP MCP。
 * 客户端各自拥有 MCP 会话和 activeProjectId，但复用同一个 Node 进程、模块缓存与 Backend 生命周期。
 */
export function registerBackendMcpHttpRoutes(
  app: Express,
  config: ResolvedConfig,
  observability?: McpObservabilityStore,
) {
  const sessions = new Map<string, HttpMcpSession>();
  let declarationSync: ReturnType<typeof setInterval> | null = null;

  const stopDeclarationSyncIfIdle = () => {
    if (sessions.size || !declarationSync) return;
    clearInterval(declarationSync);
    declarationSync = null;
  };
  const ensureDeclarationSync = () => {
    if (declarationSync) return;
    declarationSync = setInterval(() => {
      const registries = [...sessions.values()].map(
        ({ instance }) => instance.registry,
      );
      void refreshPluginDeclarations(config, registries).catch((error) =>
        logger.error("插件 MCP 声明同步失败", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }, 3000);
    declarationSync.unref();
  };
  const sessionIdOf = (req: Request) => {
    const value = req.headers["mcp-session-id"];
    return typeof value === "string" ? value : "";
  };
  const invalidSession = (res: Response, sessionId: string) =>
    res.status(sessionId ? 404 : 400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: sessionId
          ? "Not Found: MCP session is no longer available"
          : "Bad Request: No valid MCP session ID provided",
      },
      id: null,
    });
  const fail = (res: Response, error: unknown) => {
    logger.error("MCP HTTP 请求失败", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.headersSent)
      res
        .status(500)
        .json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
  };

  app.post("/mcp", async (req, res) => {
    const sessionId = sessionIdOf(req);
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      try {
        await existing.transport.handleRequest(req, res, req.body);
      } catch (error) {
        fail(res, error);
      }
      return;
    }
    if (sessionId || !isInitializeRequest(req.body)) {
      invalidSession(res, sessionId);
      return;
    }

    let instance: BackendMcpInstance | null = null;
    try {
      instance = await createBackendMcpInstance(
        config,
        observability
          ? (event) => {
              observability.record(event);
            }
          : undefined,
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (initializedSessionId) => {
          sessions.set(initializedSessionId, {
            instance: instance!,
            transport,
          });
          ensureDeclarationSync();
          logger.info("MCP HTTP 会话已连接", {
            sessionId: initializedSessionId,
            sessionCount: sessions.size,
          });
        },
      });
      transport.onclose = () => {
        const closedSessionId = transport.sessionId;
        if (closedSessionId) sessions.delete(closedSessionId);
        stopDeclarationSyncIfIdle();
        logger.info("MCP HTTP 会话已断开", {
          sessionId: closedSessionId || null,
          sessionCount: sessions.size,
        });
      };
      transport.onerror = (error) =>
        logger.warn("MCP HTTP 传输异常", { error: error.message });
      await instance.server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (instance) await instance.server.close().catch(() => undefined);
      fail(res, error);
    }
  });

  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = sessionIdOf(req);
    const session = sessions.get(sessionId);
    if (!session) {
      invalidSession(res, sessionId);
      return;
    }
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      fail(res, error);
    }
  };
  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  return {
    sessionCount: () => sessions.size,
    closeAll: async () => {
      if (declarationSync) clearInterval(declarationSync);
      declarationSync = null;
      const active = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(
        active.map(({ instance }) => instance.server.close()),
      );
    },
  };
}

const DIRECT_CANVAS_TOOLS = [
  "canvas_list_projects",
  "canvas_inspect",
  "canvas_get_state",
  "canvas_get_selection",
  "canvas_export_snapshot",
  "canvas_apply_ops",
  "canvas_create_node",
  "canvas_create_text_node",
  "canvas_create_text_nodes",
  "canvas_create_config_node",
  "canvas_create_image_prompt_flow",
  "canvas_create_generation_flow",
  "canvas_generate_text",
  "canvas_generate_image",
  "canvas_generate_video",
  "canvas_generate_audio",
  "canvas_update_node",
  "canvas_update_node_text",
  "canvas_move_nodes",
  "canvas_resize_node",
  "canvas_delete_nodes",
  "canvas_connect_nodes",
  "canvas_set_generation_references",
  "canvas_select_nodes",
  "canvas_run_generation",
  "canvas_task_status",
  "generation_get_status",
  "mcp_observability_report",
  "models_list",
] as ToolName[];
const DIRECT_TOOL_NAMES = new Set<string>([
  ...DIRECT_CANVAS_TOOLS,
  "assets_list",
  "assets_add",
  "canvas_split_image",
  "canvas_create_project",
  "canvas_delete_project",
  "canvas_set_active_project",
  "canvas_diagnose_project",
  "canvas_fix_diagnostics",
  "drama_create_project",
  "drama_list_episodes",
  "drama_get_episode",
  "drama_create_episode",
  "drama_update_episode",
  "drama_delete_episode",
  "drama_delete_project",
  "comfyui_status",
  "comfyui_get_task",
  "comfyui_cancel_task",
  "generation_get_status",
  "models_list",
]);

async function executeDirectCanvasTool(
  config: ResolvedConfig,
  backendApi: ReturnType<typeof createBackendClient>,
  state: McpSessionState,
  name: ToolName,
  input: Record<string, unknown>,
) {
  if (name === "canvas_list_projects") {
    // v7: 画布不再直接归属剧目；按分集过滤用 episodeId。
    const episodeId =
      typeof input.episodeId === "string" && input.episodeId.trim()
        ? input.episodeId.trim()
        : undefined;
    const keyword = String(input.keyword || "")
      .trim()
      .toLowerCase();
    const all = (
      await fetchCanvasProjects(config, episodeId ? { episodeId } : undefined)
    )
      .filter(
        (project) =>
          !keyword ||
          String(project.title || project.name || "")
            .toLowerCase()
            .includes(keyword),
      )
      .map((project) => ({
        id: project.id,
        title: project.title,
        updatedAt: project.updatedAt,
        nodeCount: Array.isArray(project.nodes) ? project.nodes.length : 0,
        connectionCount: Array.isArray(project.connections)
          ? project.connections.length
          : 0,
      }));
    const pageSize = Math.max(1, Math.min(100, Number(input.pageSize || 20)));
    const page = Math.max(1, Number(input.page || 1));
    return {
      projects: all.slice((page - 1) * pageSize, page * pageSize),
      total: all.length,
      page,
      pageSize,
    };
  }
  if (name === "generation_get_status" || name === "canvas_task_status") {
    const taskId = String(input.taskId || "");
    const query = {
      ...input,
      ...(!taskId && !input.projectId && state.activeProjectId
        ? { projectId: state.activeProjectId }
        : {}),
      ...(name === "canvas_task_status" && input.nodeId
        ? { nodeIds: [String(input.nodeId)] }
        : {}),
      ...(name === "canvas_task_status" ? { scope: "canvas" } : {}),
    };
    if (name === "canvas_task_status" && !taskId && !query.projectId)
      throw new Error("缺少 projectId；请先选择活动画布");
    const result = await listTasksFromBackend(backendApi, query);
    if (name === "generation_get_status") return result;
    if (taskId && !result.tasks.length) throw new Error(`生成任务不存在：${taskId}`);
    return summarizeCanvasTasks(result.tasks, query);
  }
  if (name === "mcp_observability_report")
    return fetchMcpObservabilityReport(
      config,
      typeof input.traceId === "string" ? input.traceId : undefined,
    );
  if (name === "models_list") {
    const config = await backendApi.getAiConfig();
    const channels = Array.isArray(config.channels)
      ? config.channels.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : [];
    const capability = String(input.capability || "");
    const models = channels.flatMap((channel) => {
      const channelId = String(channel.id || "");
      const entries = Array.isArray(channel.models)
        ? channel.models.filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) && typeof item === "object" && !Array.isArray(item),
          )
        : [];
      return entries
        .filter(
          (model) =>
            !capability || String(model.capability || "") === capability,
        )
        .map((model) => ({
          id: `${channelId}::${String(model.name || "")}`,
          name: String(model.name || ""),
          capability: String(model.capability || "text"),
        }));
    });
    return { models };
  }
  if (name === "canvas_inspect")
    return inspectCanvasContext(config, backendApi, state, input);
  const projectId = String(input.projectId || state.activeProjectId || "");
  const project = await fetchCurrentCanvasProject(config, projectId);
  const projectState = project as Record<string, unknown>;
  if (name === "canvas_get_state" || name === "canvas_export_snapshot")
    return compactProject(projectState);
  if (name === "canvas_get_selection") {
    const ids = new Set(
      Array.isArray(projectState.selectedNodeIds)
        ? projectState.selectedNodeIds.map(String)
        : [],
    );
    return {
      nodes: nodesOf(projectState).filter((node) => ids.has(String(node.id))),
    };
  }
  const generationInput = await applyGenerationDefaults(name, input, backendApi);
  const toolInput =
    name === "canvas_create_node"
      ? await applyNodeFactoryDefaults(generationInput, backendApi)
      : generationInput;
  const request = buildCanvasToolRequest(name, toolInput, {
    nodes: nodesOf(projectState) as never,
    connections: connectionsOf(projectState) as never,
  });
  const rawOps = Array.isArray(request.input.ops)
    ? (request.input.ops as Array<Record<string, unknown>>)
    : [];
  const ops = await Promise.all(
    rawOps.map(async (op) =>
      op.type === "add_node" && String(op.nodeType || "") === "minimax-h3:video"
        ? await applyNodeFactoryDefaults(op, backendApi)
        : op,
    ),
  );
  const operationResponse = await applyBackendCanvasOperations(
    config,
    project.id,
    Number(project.revision || 0),
    ops,
    state.clientId,
  );
  const operationResults = operationResponse.operationResults;
  const saved = operationResponse.project;
  const directTasks: Array<{ taskId: string; nodeId: string; model: string }> =
    [];
  let withLoadingState = saved;
  for (const op of ops) {
    if (op.type !== "run_generation") continue;
    const currentState = withLoadingState as Record<string, unknown>;
    const source = nodesOf(currentState).find(
      (node) => String(node.id) === String(op.nodeId),
    );
    if (!source) continue;
    const sourceMetadata = recordOf(source.metadata);
    const sourceId = String(source.id);
    const mode = String(op.mode || "image");
    if (mode === "text") {
      const selectedModel = String(sourceMetadata.model || "").trim();
      if (!selectedModel) throw new Error(`节点 ${sourceId} 未配置文本模型`);
      const textRequest = buildCanvasTextRequest(
        source,
        currentState,
        op,
        selectedModel,
      );
      const task = await backendApi.canvasRunGeneration({
        ...textRequest,
        mode: "text",
      });
      withLoadingState = await fetchCurrentCanvasProject(config, project.id);
      directTasks.push({
        taskId: task.taskId,
        nodeId: sourceId,
        model: selectedModel,
      });
    } else if (mode === "image") {
      const selectedModel = String(sourceMetadata.model || "").trim();
      if (!selectedModel) throw new Error(`节点 ${sourceId} 未配置图片模型`);
      const imageRequest = buildCanvasImageRequest(
        source,
        currentState,
        op,
        selectedModel,
      );
      const task = await backendApi.canvasRunGeneration({
        ...imageRequest,
        mode: "image",
      });
      withLoadingState = await fetchCurrentCanvasProject(config, project.id);
      directTasks.push({
        taskId: task.taskId,
        nodeId: sourceId,
        model: selectedModel,
      });
    } else if (mode === "video") {
      const videoRequest = await buildCanvasVideoRequest(
        source,
        currentState,
        project.id,
        backendApi,
        op,
      );
      const task = await backendApi.canvasRunGeneration(videoRequest);
      directTasks.push({
        taskId: task.taskId,
        nodeId: sourceId,
        model: String(videoRequest.model || ""),
      });
    } else if (mode === "audio") {
      const audioRequest = buildCanvasAudioRequest(source, currentState, project.id, op);
      const task = await backendApi.canvasRunGeneration(audioRequest);
      directTasks.push({
        taskId: task.taskId,
        nodeId: sourceId,
        model: String(audioRequest.model || ""),
      });
    } else {
      throw new Error(`Backend 画布生成执行器暂未注册模式：${mode}`);
    }
  }
  return {
    ok: true,
    intent: name.startsWith("canvas_generate_")
      ? name.replace("canvas_generate_", "generate_")
      : undefined,
    projectId: withLoadingState.id,
    operationId: operationResponse.operationId,
    operationResults,
    directTasks,
    next:
      directTasks.length === 1
        ? {
            tool: "canvas_task_status",
            input: { taskId: directTasks[0].taskId },
          }
        : directTasks.length > 1
          ? {
              tool: "canvas_task_status",
              input: { projectId: withLoadingState.id },
            }
          : undefined,
    state: compactProject(withLoadingState as Record<string, unknown>),
  };
}

function buildCanvasAudioRequest(source: Record<string, unknown>, _project: Record<string, unknown>, projectId: string, op: Record<string, unknown>): CanvasGenerationCommand {
  const metadata = recordOf(source.metadata);
  const params = { ...recordOf(metadata.audioParams), ...recordOf(metadata.comfyParams), ...recordOf(op.params) };
  const model = String(op.model || metadata.model || metadata.audioModel || "").trim();
  if (!model) throw new Error("画布音频生成缺少 model");
  return {
    mode: "audio",
    model,
    projectId,
    nodeId: String(source.id || ""),
    prompt: sanitizeCanvasPrompt(String(op.prompt || metadata.prompt || metadata.composerContent || "")),
    params: {
      ...params,
      voice: String(op.voice || metadata.audioVoice || params.voice || "alloy"),
      format: String(op.format || metadata.audioFormat || params.format || "mp3"),
      speed: String(op.speed || metadata.audioSpeed || params.speed || "1"),
      instructions: String(op.instructions || metadata.audioInstructions || params.instructions || ""),
    },
    clientTaskId: String(op.idempotencyKey || `canvas-audio-${crypto.randomUUID()}`),
  };
}

function registerDirectCanvasTools(
  server: McpServer,
  config: ResolvedConfig,
  backendApi: ReturnType<typeof createBackendClient>,
  state: McpSessionState,
  recordEvent: McpEventRecorder,
) {
  for (const name of toolNames.filter(isCollaborationTool)) {
    server.registerTool(
      name,
      {
        description: toolDescriptions[name],
        inputSchema: toolInputSchemas[name],
      },
      async (input: unknown) =>
        textResult(
          await executeCollaborationTool(backendApi, name, input, {
            clientId: state.clientId,
            kind: "mcp",
            label: "MCP",
          }),
        ),
    );
  }
  for (const name of DIRECT_CANVAS_TOOLS) {
    const schema = toolInputSchemas[name];
    // Pass zod schema (not schema.shape) so MCP SDK walks each property and
    // serializes the .describe() text into JSON Schema "description" fields.
    // Using .shape bypasses the conversion and drops every field description,
    // making OpenAI tool-use guess at fields like items/tags/x-vs-dx.
    server.registerTool(
      name,
      { description: toolDescriptions[name], inputSchema: schema },
      async (rawInput: Record<string, unknown>) => {
        const traceId = crypto.randomUUID();
        const startedAt = Date.now();
        const inputSummary = summarizeMcpToolInput(rawInput);
        await recordMcpObservabilityEvent(recordEvent, {
          sessionId: state.clientId,
          traceId,
          event: "tool.started",
          tool: name,
          projectId: optionalText(rawInput.projectId || state.activeProjectId),
          nodeId: optionalText(rawInput.nodeId || rawInput.id),
          inputSummary,
        });
        try {
          const input = schema.parse(rawInput) as Record<string, unknown>;
          const value = await executeDirectCanvasTool(
            config,
            backendApi,
            state,
            name,
            input,
          );
          const context = mcpToolResultContext(value, input, state);
          await recordMcpObservabilityEvent(recordEvent, {
            sessionId: state.clientId,
            traceId,
            event: "tool.succeeded",
            tool: name,
            durationMs: Date.now() - startedAt,
            inputSummary,
            ...context,
          });
          return textResult(withTraceId(value, traceId));
        } catch (error) {
          const details = classifyToolError(error, rawInput, state);
          await recordMcpObservabilityEvent(recordEvent, {
            sessionId: state.clientId,
            traceId,
            event: "tool.failed",
            tool: name,
            projectId: optionalText(rawInput.projectId || state.activeProjectId),
            nodeId: optionalText(rawInput.nodeId || rawInput.id),
            durationMs: Date.now() - startedAt,
            errorCode: details.code,
            recoverable: details.recoverable,
            suggestedTool: details.suggestedTool,
            inputSummary,
            outputSummary: { errorCode: details.code },
          });
          return toolErrorResult(error, name, rawInput, state, traceId, details);
        }
      },
    );
  }
  // ── H3 节点历史运行产物（按需取，替代 metadata.materials 字段）──
  server.registerTool(
    "h3_get_node_materials",
    {
      description: toolDescriptions.h3_get_node_materials,
      inputSchema: toolInputSchemas.h3_get_node_materials,
    },
    async (rawInput: Record<string, unknown>) => {
      const input = toolInputSchemas.h3_get_node_materials.parse(rawInput) as {
        projectId?: string;
        nodeId: string;
        segmentId?: string;
        limit?: number;
      };
      const projectId = String(input.projectId || state.activeProjectId || "");
      if (!projectId)
        throw new Error(
          "缺少 projectId（先调用 canvas_set_active_project 或显式传入）",
        );
      const project = await fetchCurrentCanvasProject(config, projectId);
      if (!project) throw new Error(`画布不存在: ${projectId}`);
      const materials = await backendApi.getH3NodeMaterials(
        project.id,
        String(input.nodeId),
        Number(input.limit || 200),
        input.segmentId ? String(input.segmentId) : undefined,
      );
      return textResult({
        ok: true,
        projectId: project.id,
        nodeId: String(input.nodeId),
        materials,
      });
    },
  );
  for (const name of ["assets_list", "assets_add"] as ToolName[]) {
    const schema = toolInputSchemas[name];
    server.registerTool(
      name,
      { description: toolDescriptions[name], inputSchema: schema.shape },
      async (rawInput: Record<string, unknown>) => {
        const input = schema.parse(rawInput) as Record<string, unknown>;
        if (name === "assets_list")
          return textResult(
            (
              await backendApi.listAssets({
                kind:
                  input.kind && input.kind !== "all"
                    ? String(input.kind)
                    : undefined,
              })
            ).assets,
          );
        const now = new Date().toISOString();
        const asset = await backendApi.upsertAsset({
          id: `asset-${crypto.randomUUID()}`,
          kind: String(input.kind || "text"),
          title: String(input.title || ""),
          coverUrl: String(input.imageUrl || ""),
          tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
          folderId: null,
          data: {
            content: input.content || "",
            imageUrl: input.imageUrl || "",
          },
          note: input.note ? String(input.note) : null,
          source: input.source ? String(input.source) : null,
          metadata: {},
          createdAt: now,
          updatedAt: now,
        });
        return textResult(asset);
      },
    );
  }
  // ── 画布管理（创建/删除/切换） ──────────────────────────────────────
  server.registerTool(
    "canvas_split_image",
    {
      description:
        "把画布上的一张图片节点按 rows×columns 等分切分，生成多个新的图片节点（与前端「分割」工具同一算法）。适合把宫格分镜图切成单格。切出的节点自动排在被切节点右侧并连线。",
      inputSchema: z.object({
        projectId: z.string().optional(),
        nodeId: z.string(),
        rows: z.number().optional(),
        columns: z.number().optional(),
        horizontalLines: z.array(z.number()).optional(),
        verticalLines: z.array(z.number()).optional(),
        inset: z.number().optional(),
        gap: z.number().optional(),
        keepEmptySlots: z.boolean().optional(),
      }).shape,
    },
    async (rawInput: Record<string, unknown>) => {
      const nodeId = String(rawInput.nodeId || "");
      const rows = Math.max(
        1,
        Math.min(12, Math.floor(Number(rawInput.rows ?? 2))),
      );
      const columns = Math.max(
        1,
        Math.min(12, Math.floor(Number(rawInput.columns ?? 2))),
      );
      const gap = Number(rawInput.gap ?? 24);
      const projectId = rawInput.projectId ? String(rawInput.projectId) : "";
      const project = await fetchCurrentCanvasProject(config, projectId);
      const node = nodesOf(project).find((item) => String(item.id) === nodeId);
      if (!node) throw new Error(`画布上找不到节点：${nodeId}`);
      const meta = (node.metadata || {}) as Record<string, unknown>;
      const storageKey = meta.storageKey ? String(meta.storageKey) : "";
      if (!storageKey)
        throw new Error(`节点 ${nodeId} 没有 storageKey（不是图片结果节点？）`);

      const source = await fetchMediaBuffer(config, storageKey);
      const inset = Math.max(
        0,
        Math.min(40, Math.floor(Number(rawInput.inset ?? 0))),
      );
      const { pieces } = await splitImageBuffer(source, {
        rows,
        columns,
        inset,
        horizontalLines: Array.isArray(rawInput.horizontalLines)
          ? rawInput.horizontalLines.map(Number)
          : undefined,
        verticalLines: Array.isArray(rawInput.verticalLines)
          ? rawInput.verticalLines.map(Number)
          : undefined,
      });
      if (!pieces.length) throw new Error("切分结果为空");

      const pos = (node.position || {}) as Record<string, number>;
      const nodeW = Number(node.width || 0) || 340;
      const nodeH = Number(node.height || 0) || 240;
      const cellW = Math.round(nodeW / columns);
      const cellH = Math.round(nodeH / rows);
      const baseX = (pos.x || 0) + nodeW + 96;
      const baseY = pos.y || 0;
      const parentTitle = String(node.title || "图片");

      const created: Array<{
        id: string;
        row: number;
        column: number;
        storageKey: string;
        width: number;
        height: number;
      }> = [];
      const operations: Array<Record<string, unknown>> = [];
      for (const piece of pieces) {
        const media = await uploadMediaBinary(config, piece.data, {
          name: `split_${String(nodeId).replace(/[^\w.-]/g, "_")}_r${piece.row + 1}c${piece.column + 1}.png`,
          mimeType: "image/png",
          category: "output",
          width: piece.width,
          height: piece.height,
        });
        const id = `image-${crypto.randomUUID()}`;
        operations.push({
          type: "add_node",
          nodeType: "image",
          id,
          title: `${parentTitle} · r${piece.row + 1}c${piece.column + 1}`,
          position: {
            x: baseX + piece.column * (cellW + gap),
            y: baseY + piece.row * (cellH + gap),
          },
          width: cellW,
          height: cellH,
          metadata: {
            content: media.url,
            storageKey: media.storageKey,
            status: "success",
            naturalWidth: piece.width,
            naturalHeight: piece.height,
            bytes: media.bytes,
            mimeType: "image/png",
            ...(meta.prompt ? { prompt: meta.prompt } : {}),
          },
        });
        operations.push({
          type: "connect_nodes",
          fromNodeId: nodeId,
          toNodeId: id,
        });
        created.push({
          id,
          row: piece.row,
          column: piece.column,
          storageKey: media.storageKey,
          width: piece.width,
          height: piece.height,
        });
      }

      const applied = await applyBackendCanvasOperations(
        config,
        project.id,
        Number(project.revision || 0),
        operations,
      );
      return textResult({
        ok: true,
        sourceNodeId: nodeId,
        rows,
        columns,
        count: created.length,
        created,
        revision: applied.revision,
      });
    },
  );
  server.registerTool(
    "canvas_create_project",
    {
      description:
        "创建独立画布。画布是生产资产容器，不直接挂在剧目下；要归属某一集，请在 drama_create_episode 或 drama_update_episode 中传 canvasId。",
      inputSchema: z.object({
        title: z
          .string()
          .optional()
          .describe("画布标题；不传时为「未命名画布」"),
      }),
    },
    async (rawInput: Record<string, unknown>) => {
      const title =
        String(rawInput.title || "未命名画布").trim() || "未命名画布";
      const now = new Date().toISOString();
      const id = nanoid();
      const project: CanvasProject = {
        id,
        title,
        createdAt: now,
        updatedAt: now,
        revision: 0,
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        globalPrompt: "",
        viewport: { x: 0, y: 0, zoom: 1 },
      };
      const saved = await saveCanvasProject(config, project);
      state.activeProjectId = id;
      return textResult({
        ok: true,
        id: saved.id,
        title: saved.title,
        createdAt: saved.createdAt,
      });
    },
  );
  const dramaCreateProjectSchema = z.object({
    name: z.string().trim().min(1).max(200),
    outline: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    coverStorageKey: z.string().nullable().optional(),
  });
  server.registerTool(
    "drama_create_project",
    {
      description:
        "在短剧制作台创建新的剧目。返回剧目 id、名称和资料；创建后会同步到短剧制作台。",
      inputSchema: dramaCreateProjectSchema,
    },
    async (rawInput: Record<string, unknown>) => {
      const input = dramaCreateProjectSchema.parse(rawInput);
      const now = new Date().toISOString();
      const folder = {
        id: nanoid(),
        name: input.name,
        createdAt: now,
        updatedAt: now,
        outline: input.outline?.trim() || "",
        description: input.description?.trim() || "",
        coverStorageKey: input.coverStorageKey ?? null,
        tags: (input.tags || []).map((tag) => tag.trim()).filter(Boolean),
        isDrama: true,
      };
      const saved = await backendApi.post<{
        ok: boolean;
        folder?: Record<string, unknown>;
      }>("/canvas/folders", folder);
      return textResult({ ok: true, folder: saved.folder || folder });
    },
  );
  const dramaCreateEpisodeSchema = z.object({
    dramaId: z
      .string()
      .trim()
      .min(1)
      .describe("剧目 ID；来自 drama_create_project 返回的 folder.id"),
    episodeNumber: z
      .number()
      .int()
      .min(1)
      .describe("分集编号，从 1 开始；同一剧目不可重复"),
    title: z.string().optional().describe("分集标题；不传时默认「第 N 集」"),
    synopsis: z
      .string()
      .optional()
      .describe("分集剧情/梗概，独立存储在分集实体，不要只写进画布文本节点"),
    canvasId: z
      .string()
      .nullable()
      .optional()
      .describe("绑定的画布 ID；不传或 null 表示暂不绑定。画布只能绑定一集"),
  });
  const dramaUpdateEpisodeSchema = z.object({
    episodeId: z.string().trim().min(1).describe("分集 ID"),
    episodeNumber: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("新的分集编号；同一剧目不可重复"),
    title: z.string().optional().describe("新的分集标题"),
    synopsis: z.string().optional().describe("新的分集剧情/梗概"),
    canvasId: z
      .string()
      .nullable()
      .optional()
      .describe("新的画布 ID；传 null 解除绑定"),
  });
  server.registerTool(
    "drama_list_episodes",
    {
      description:
        "列出一个剧目的全部分集，按 episodeNumber 升序返回；每项含标题、剧情和绑定画布 ID。",
      inputSchema: z.object({
        dramaId: z.string().trim().min(1).describe("剧目 ID"),
      }),
    },
    async (rawInput: Record<string, unknown>) => {
      const dramaId = String(rawInput.dramaId).trim();
      return textResult(await backendApi.listDramaEpisodes(dramaId));
    },
  );
  server.registerTool(
    "drama_get_episode",
    {
      description:
        "读取单个分集的完整字段，并返回其绑定画布的完整数据；未绑定画布时 canvas 为 null。",
      inputSchema: z.object({
        episodeId: z.string().trim().min(1).describe("分集 ID"),
      }),
    },
    async (rawInput: Record<string, unknown>) => {
      return textResult(
        await backendApi.getDramaEpisode(String(rawInput.episodeId).trim()),
      );
    },
  );
  server.registerTool(
    "drama_create_episode",
    {
      description:
        "创建剧目下的一集。分集是剧目与画布之间的实体，剧情字段独立保存；可选绑定一个已有画布。",
      inputSchema: dramaCreateEpisodeSchema,
    },
    async (rawInput: Record<string, unknown>) => {
      const input = dramaCreateEpisodeSchema.parse(rawInput);
      const result = await backendApi.createDramaEpisode(input.dramaId, {
        episodeNumber: input.episodeNumber,
        title: input.title,
        synopsis: input.synopsis,
        canvasId: input.canvasId,
      });
      return textResult(result);
    },
  );
  server.registerTool(
    "drama_update_episode",
    {
      description:
        "更新分集字段或更换绑定画布。传 canvasId=null 可解除绑定，不会删除画布或分集剧情。",
      inputSchema: dramaUpdateEpisodeSchema,
    },
    async (rawInput: Record<string, unknown>) => {
      const input = dramaUpdateEpisodeSchema.parse(rawInput);
      const { episodeId, ...patch } = input;
      return textResult(await backendApi.updateDramaEpisode(episodeId, patch));
    },
  );
  server.registerTool(
    "drama_delete_episode",
    {
      description: "删除分集记录；不会删除其绑定的画布，画布会变成独立资产。",
      inputSchema: z.object({
        episodeId: z.string().trim().min(1).describe("分集 ID"),
      }),
    },
    async (rawInput: Record<string, unknown>) => {
      const episodeId = String(rawInput.episodeId).trim();
      return textResult({
        episodeId,
        ...(await backendApi.deleteDramaEpisode(episodeId)),
      });
    },
  );
  server.registerTool(
    "drama_delete_project",
    {
      description:
        "删除短剧制作台中的剧目。只删除剧目归档，剧目下的场景画布会保留并回到待编排场景。",
      inputSchema: z.object({ id: z.string().trim().min(1) }).shape,
    },
    async (rawInput: Record<string, unknown>) => {
      const input = z.object({ id: z.string().trim().min(1) }).parse(rawInput);
      const result = await backendApi.delete<{ ok: boolean; deleted?: number }>(
        `/drama/projects/${encodeURIComponent(input.id)}`,
      );
      return textResult({
        ok: true,
        id: input.id,
        deleted: Number(result.deleted || 0) > 0,
      });
    },
  );
  server.registerTool(
    "canvas_delete_project",
    {
      description:
        "按 id 删除画布。删除后 activeProjectId 自动清空（若指向被删画布）。",
      inputSchema: z.object({ id: z.string() }).shape,
    },
    async (rawInput: Record<string, unknown>) => {
      const id = String(rawInput.id);
      const deleted = await deleteCanvasProject(config, id);
      if (state.activeProjectId === id) state.activeProjectId = null;
      return textResult({ ok: true, deleted: deleted > 0 });
    },
  );
  server.registerTool(
    "canvas_set_active_project",
    {
      description:
        "设置当前活动画布（后续 MCP 操作目标）。不传 id 则清空；存在多个画布时不会自动挑选目标。",
      inputSchema: z.object({ id: z.string().optional() }).shape,
    },
    async (rawInput: Record<string, unknown>) => {
      const id = rawInput.id ? String(rawInput.id) : "";
      if (id) {
        const project = (await fetchCanvasProjects(config)).find(
          (item) => item.id === id,
        );
        if (!project) throw new Error(`画布不存在: ${id}`);
        state.activeProjectId = id;
      } else {
        state.activeProjectId = null;
      }
      return textResult({
        ok: true,
        activeProjectId: state.activeProjectId || null,
      });
    },
  );
  server.registerTool(
    "canvas_diagnose_project",
    {
      description:
        "只读诊断指定画布，检查悬空连线、重复连线、二次生成残留参考、丢失媒体和孤立结果节点。",
      inputSchema: z.object({ projectId: z.string() }).shape,
    },
    async (rawInput: Record<string, unknown>) => {
      const projectId = String(rawInput.projectId || "").trim();
      if (!projectId) throw new Error("projectId 必填");
      return textResult(await backendApi.diagnoseCanvasProject(projectId));
    },
  );
  server.registerTool(
    "canvas_fix_diagnostics",
    {
      description:
        "按 issueId 应用诊断建议。必须明确传 projectId 和 issueIds；实际修改仍由 revision 保护的画布操作事务完成。",
      inputSchema: z.object({
        projectId: z.string(),
        issueIds: z.array(z.string()).min(1),
        expectedRevision: z.number().optional(),
      }).shape,
    },
    async (rawInput: Record<string, unknown>) => {
      const projectId = String(rawInput.projectId || "").trim();
      const report = await backendApi.diagnoseCanvasProject(projectId);
      const wanted = new Set((rawInput.issueIds as string[]).map(String));
      const selected = report.issues.filter(
        (issue) =>
          issue &&
          typeof issue === "object" &&
          wanted.has(String((issue as Record<string, unknown>).issueId || "")),
      );
      if (selected.length !== wanted.size)
        throw new Error("存在无效或已消失的 issueId，请重新诊断后再修复");
      const operations = selected.flatMap((issue) =>
        Array.isArray((issue as Record<string, unknown>).suggestedOperations)
          ? ((issue as Record<string, unknown>).suggestedOperations as Array<
              Record<string, unknown>
            >)
          : [],
      );
      if (!operations.length)
        return textResult({
          ok: true,
          fixed: [],
          message: "选中的问题没有自动修复建议，请人工处理",
        });
      const result = await backendApi.applyCanvasOperations(
        projectId,
        operations,
        rawInput.expectedRevision === undefined
          ? report.revision
          : Number(rawInput.expectedRevision),
      );
      return textResult({
        ok: true,
        fixed: selected.map((issue) =>
          String((issue as Record<string, unknown>).issueId),
        ),
        ...result,
      });
    },
  );
}

async function buildCanvasVideoRequest(
  source: Record<string, unknown>,
  project: Record<string, unknown>,
  projectId: string,
  backend: ReturnType<typeof createBackendClient>,
  op: Record<string, unknown>,
): Promise<CanvasGenerationCommand> {
  const metadata = recordOf(source.metadata);
  const segments = Array.isArray(metadata.segments)
    ? (metadata.segments as Array<Record<string, unknown>>)
    : [];
  const segmentId = String(
    op.segmentId || segments[0]?.id || "",
  );
  const segment =
    segments.find((item) => String(item.id || "") === segmentId) ||
    segments[0] ||
    {};
  const refs = (
    Array.isArray(segment.refItems)
      ? (segment.refItems as Array<Record<string, unknown>>)
      : [
          ...(Array.isArray(recordOf(segment.refs).image)
            ? (recordOf(segment.refs).image as Array<Record<string, unknown>>)
            : []),
          ...(Array.isArray(recordOf(segment.refs).video)
            ? (recordOf(segment.refs).video as Array<Record<string, unknown>>)
            : []),
          ...(Array.isArray(recordOf(segment.refs).audio)
            ? (recordOf(segment.refs).audio as Array<Record<string, unknown>>)
            : []),
        ]
  ).filter((ref) => ref.role !== "character_identity");
  const selectedModel = String(op.model || metadata.model || metadata.videoModel || "").trim();
  if (selectedModel && !/^minimax-h3(?::|$)/i.test(selectedModel)) {
    const params = { ...recordOf(metadata.comfyParams), ...recordOf(op.params) };
    const handle = (ref: Record<string, unknown>) => ({
      id: String(ref.id || "") || undefined,
      name: String(ref.name || "") || undefined,
      storageKey: String(ref.storageKey || "") || undefined,
      url: String(ref.url || "") || undefined,
      mimeType: String(ref.mimeType || "") || undefined,
    });
    return {
      mode: "video",
      model: selectedModel,
      projectId,
      nodeId: String(source.id || ""),
      prompt: sanitizeCanvasPrompt(String(op.prompt || metadata.prompt || metadata.composerContent || "")),
      references: refs.filter((ref) => String(ref.type || "image") === "image").map(handle),
      videoReferences: refs.filter((ref) => String(ref.type || "") === "video").map(handle),
      size: String(op.size || metadata.size || "") || undefined,
      seconds: String(op.seconds || metadata.seconds || "") || undefined,
      resolution: String(op.resolution || metadata.vquality || "") || undefined,
      params,
      clientTaskId: String(op.idempotencyKey || `canvas-${crypto.randomUUID()}`),
    };
  }
  const paths = await Promise.all(
    refs.map(
      async (ref): Promise<Record<string, unknown> & { path: string }> => {
        const value = String(ref.storageKey || ref.url || "");
        return {
          ...ref,
          path: value ? await backend.runtimeMediaPath(value) : "",
        };
      },
    ),
  );
  const images = paths
    .filter((ref) => String(ref.type || "image") === "image" && ref.path)
    .map((ref) => ref.path);
  const videos = paths
    .filter((ref) => String(ref.type || "") === "video" && ref.path)
    .map((ref) => ref.path);
  const audios = paths
    .filter((ref) => String(ref.type || "") === "audio" && ref.path)
    .map((ref) => ref.path);
  const previousIndex = Math.max(
    0,
    segments.findIndex(
      (item) => String(item.id || "") === String(segment.id || ""),
    ) - 1,
  );
  const previous =
    previousIndex >= 0 ? String(segments[previousIndex]?.result || "") : "";
  const previousVideo = previous
    ? await backend.runtimeMediaPath(previous)
    : "";
  const params: Record<string, unknown> = {
    ...recordOf(metadata.comfyParams),
    ...metadata,
    ...segment,
    ...recordOf(op.params),
    modelName: String(
      segment.modelName ||
        metadata.modelName ||
        metadata.minimaxBaseModel ||
        "",
    ),
    canvasBinding: { projectId, nodeId: String(source.id || ""), segmentId },
  };
  for (const key of [
    "segments",
    "refs",
    "refItems",
    "result",
    "results",
    "content",
    "url",
    "storageKey",
  ])
    delete params[key];
  return {
    mode: "video",
    model: "minimax-h3:video",
    preset: "minimax-h3",
    projectId,
    nodeId: String(source.id || ""),
    segmentId,
    input: {
      prompt: String(op.prompt || segment.prompt || metadata.prompt || ""),
      references: images,
      video: videos[0],
      audios,
      ...(previousVideo ? { previousVideo } : {}),
    },
    params,
    idempotencyKey: String(
      op.idempotencyKey || `canvas-${crypto.randomUUID()}`,
    ),
  };
}

async function applyNodeFactoryDefaults(
  input: Record<string, unknown>,
  backend: ReturnType<typeof createBackendClient>,
) {
  if (String(input.nodeType || "") !== "minimax-h3:video") return input;
  const defaults = await backend.getH3Defaults();
  const metadata = recordOf(input.metadata);
  return {
    ...input,
    width: input.width ?? 1960,
    height: input.height ?? 1080,
    metadata: createH3NodeMetadata(defaults, metadata),
  };
}

async function applyGenerationDefaults(
  name: ToolName,
  input: Record<string, unknown>,
  backend: ReturnType<typeof createBackendClient>,
) {
  if (input.model) return input;
  const generateNow = name.startsWith("canvas_generate_");
  const namedMode = generateNow
    ? name.replace("canvas_generate_", "")
    : name === "canvas_create_image_prompt_flow"
      ? "image"
      : "";
  const autoRun =
    generateNow ||
    ((name === "canvas_create_generation_flow" ||
      name === "canvas_create_image_prompt_flow" ||
      name === "canvas_create_config_node") &&
      input.autoRun === true);
  if (!autoRun) return input;
  const mode = String(namedMode || input.mode || "image") as
    | "text"
    | "image"
    | "video"
    | "audio";
  const aiConfig = await backend.getAiConfig();
  const key = `${mode}Model`;
  const fallback = mode === "image" || mode === "text" ? aiConfig.model : "";
  const model = String(aiConfig[key] || fallback || "").trim();
  if (!model)
    throw new Error(
      `没有配置默认${generationModeLabel(mode)}模型；请显式传 model 或先在模型设置中配置`,
    );
  return { ...input, model };
}

function generationModeLabel(mode: string) {
  return mode === "text"
    ? "文本"
    : mode === "video"
      ? "视频"
      : mode === "audio"
        ? "音频"
        : "图片";
}

export function buildCanvasImageRequest(
  source: Record<string, unknown>,
  project: Record<string, unknown>,
  op: Record<string, unknown>,
  model: string,
): CanvasImageGenerationInput {
  const metadata = recordOf(source.metadata);
  const incomingConnections = connectionsOf(project).filter(
    (connection) => String(connection.toNodeId) === String(source.id),
  );
  const connectedTextPrompts = incomingConnections.flatMap((connection) => {
    const node = nodesOf(project).find(
      (item) => String(item.id) === String(connection.fromNodeId),
    );
    if (!node || String(node.type) !== "text") return [];
    const textMetadata = recordOf(node.metadata);
    const content = String(textMetadata.content || "").trim();
    return content ? [content] : [];
  });
  const rawPrompt = sanitizeCanvasPrompt(
    String(
      op.prompt ||
        connectedTextPrompts.join("\n\n") ||
        metadata.composerContent ||
        metadata.prompt ||
        "",
    ),
  );
  const nodes = nodesOf(project);
  const nodeById = new Map(nodes.map((item) => [String(item.id), item]));
  const referencedIds = new Set<string>();
  const explicitReferenceIds = Array.isArray(op.referenceNodeIds)
    ? op.referenceNodeIds.map(String)
    : [];
  // MCP callers may explicitly name image or character nodes. Character nodes
  // are asset containers; expand them to their primary character image before
  // routing so the workflow sees a real image reference.
  for (const id of explicitReferenceIds) referencedIds.add(id);
  for (const match of rawPrompt.matchAll(/@\[node:([^\]]+)\]/g))
    referencedIds.add(match[1]);
  for (const connection of incomingConnections) {
    const node = nodeById.get(String(connection.fromNodeId));
    if (node && ["image", "character"].includes(String(node.type)))
      referencedIds.add(String(node.id));
  }
  if (
    String(source.type) === "image" &&
    (metadata.content || metadata.url || metadata.storageKey)
  )
    referencedIds.add(String(source.id));

  const prompt = rawPrompt
    .replace(/@\[node:([^\]]+)\]/g, (_token, id: string) => {
      const node = nodeById.get(id);
      return node && String(node.type) === "text"
        ? String(recordOf(node.metadata).content || "")
        : "";
    })
    .trim();
  if (!prompt) throw new Error("画布图片提示词为空");

  const references = [...referencedIds].flatMap((id) => {
    const node = nodeById.get(id);
    if (!node) return [];
    const nodeMetadata = recordOf(node.metadata);
    if (String(node.type) === "character") {
      const images = Array.isArray(nodeMetadata.characterImages)
        ? nodeMetadata.characterImages as Array<Record<string, unknown>>
        : [];
      if (!images.length) return [];
      const characterReferences = recordOf(metadata.characterReferences);
      const selection = recordOf(characterReferences[id]);
      const selectedKeys = Array.isArray(selection.imageKeys) ? new Set(selection.imageKeys.map(String)) : undefined;
      return images.flatMap((image, index) => {
        const key = String(image.storageKey || image.url || image.name || `image-${index}`);
        if (selectedKeys && !selectedKeys.has(key)) return [];
        const content = String(image.url || "");
        if (!content && !image.storageKey) return [];
        return [{
          id: `${id}:character-image:${key}`,
          name: String(image.name || node.title || id),
          storageKey: String(image.storageKey || "") || undefined,
          dataUrl: content.startsWith("data:") ? content : undefined,
          url: content && !content.startsWith("data:") ? content : undefined,
          mimeType: String(image.mimeType || "image/png"),
        }];
      });
    }
    if (String(node.type) !== "image") return [];
    return [{
      id,
      name: `${String(node.title || id).replace(/[^\w\u4e00-\u9fff-]+/g, "-")}.png`,
      storageKey: String(nodeMetadata.storageKey || "") || undefined,
      dataUrl: String(nodeMetadata.content || "").startsWith("data:")
        ? String(nodeMetadata.content)
        : undefined,
      url: String(nodeMetadata.content || nodeMetadata.url || "") || undefined,
      mimeType: String(nodeMetadata.mimeType || "image/png"),
    }];
  });
  const params = {
    ...recordOf(metadata.params || metadata.customFieldValues),
    ...recordOf(op.params),
  };
  const size = normalizeGptImageSize(metadata.size);
  const [width, height] = size.split("x").map(Number);
  return {
    projectId: String(project.id || "") || undefined,
    nodeId: String(source.id || "") || undefined,
    model,
    prompt,
    references,
    size,
    width,
    height,
    quality: String(metadata.quality || "auto"),
    count: Math.max(1, Math.min(4, Number(metadata.count || 1))),
    params,
    clientTaskId: String(op.idempotencyKey || `canvas-${crypto.randomUUID()}`),
    resultPolicy:
      String(op.resultPolicy || "replace-active") === "append"
        ? "append"
        : "replace-active",
  };
}

function buildCanvasTextRequest(
  source: Record<string, unknown>,
  project: Record<string, unknown>,
  op: Record<string, unknown>,
  model: string,
): CanvasTextGenerationInput {
  // 文本反推与图片生成使用同一套 @节点替换和参考图解析，避免 MCP 与网页端对图谱产生两种解释。
  const compiled = buildCanvasImageRequest(source, project, op, model);
  const metadata = recordOf(source.metadata);
  return {
    projectId: compiled.projectId,
    nodeId: compiled.nodeId,
    model,
    prompt: compiled.prompt,
    references: compiled.references,
    count: Math.max(
      1,
      Math.min(4, Number(metadata.textCount || metadata.count || 1)),
    ),
    params: {
      ...(compiled.params || {}),
      ...(metadata.reasoningEffort
        ? { reasoningEffort: metadata.reasoningEffort }
        : {}),
    },
    clientTaskId: compiled.clientTaskId,
    resultPolicy: compiled.resultPolicy,
  };
}

function normalizeGptImageSize(value: unknown) {
  const size = String(value || "1024x1024")
    .trim()
    .toLowerCase();
  if (/^\d+x\d+$/.test(size)) return size;
  if (size === "16:9") return "1536x1024";
  if (size === "9:16") return "1024x1536";
  return "1024x1024";
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function listTasksFromBackend(
  backend: ReturnType<typeof createBackendClient>,
  input: Record<string, unknown>,
) {
  const taskId = typeof input.taskId === "string" ? input.taskId : "";
  const source = (
    taskId
      ? [
          await backend
            .getTask(taskId)
            .then((value) => value.task)
            .catch(() => null),
        ]
      : await backend.listTasks({
          scope: ["all", "canvas", "image", "video"].includes(
            String(input.scope || "all"),
          )
            ? (String(input.scope || "all") as
                | "all"
                | "canvas"
                | "image"
                | "video")
            : "all",
          projectId:
            typeof input.projectId === "string" ? input.projectId : undefined,
          nodeIds: Array.isArray(input.nodeIds)
            ? input.nodeIds.map(String)
            : undefined,
          segmentIds: Array.isArray(input.segmentIds)
            ? input.segmentIds.map(String)
            : undefined,
        })
  ) as Array<{
    id?: string;
    kind: string;
    input?: Record<string, unknown>;
    params?: Record<string, unknown>;
    status: string;
    progress: number;
    result?: unknown;
    error?: string | null;
    createdAt: string;
    updatedAt: string;
    executor?: string;
    model?: string;
    projectId?: string;
    nodeId?: string;
    segmentId?: string;
  }>;
  const nodeIds = new Set(
    Array.isArray(input.nodeIds) ? input.nodeIds.map(String) : [],
  );
  const segmentIds = new Set(
    Array.isArray(input.segmentIds) ? input.segmentIds.map(String) : [],
  );
  const projectId = String(input.projectId || "");
  const scope = String(input.scope || "all");
  const tasks = source
    .filter((task): task is NonNullable<typeof task> => Boolean(task))
    .filter((task) => {
      const taskInput = task.input || {};
      const params = task.params || {};
      const taskProjectId = String(
        task.projectId || taskInput.projectId || params.projectId || "",
      );
      const taskNodeId = String(
        task.nodeId || taskInput.nodeId || params.nodeId || "",
      );
      const taskSegmentId = String(
        task.segmentId || taskInput.segmentId || params.segmentId || "",
      );
      const taskExecutor = String(task.executor || params.executor || "");
      const taskModel = String(
        task.model || params.model || params.modelName || taskInput.model || "",
      );
      if (projectId && taskProjectId !== projectId) return false;
      if (nodeIds.size && !nodeIds.has(taskNodeId)) return false;
      if (segmentIds.size && !segmentIds.has(taskSegmentId)) return false;
      if (scope === "canvas" && !taskProjectId) return false;
      if (
        scope === "image" &&
        !/image/i.test(`${task.kind} ${taskExecutor} ${taskModel}`)
      )
        return false;
      if (
        scope === "video" &&
        !/video|h3/i.test(`${task.kind} ${taskExecutor} ${taskModel}`)
      )
        return false;
      return true;
    })
    .slice(0, Math.max(1, Math.min(500, Number(input.limit || 100))))
    .map(toCanvasTask);
  return { tasks };
}

function toCanvasTask(task: {
  id?: string;
  kind: string;
  input?: Record<string, unknown>;
  params?: Record<string, unknown>;
  status: string;
  progress: number;
  result?: unknown;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
  parentTaskId?: string;
  projectId?: string;
  nodeId?: string;
  segmentId?: string;
  executor?: string;
  model?: string;
  outputs?: Array<Record<string, unknown>>;
}) {
  const input = task.input || {};
  const params = task.params || {};
  const binding =
    params.canvasBinding && typeof params.canvasBinding === "object"
      ? (params.canvasBinding as Record<string, unknown>)
      : {};
  const result =
    task.result && typeof task.result === "object"
      ? (task.result as Record<string, unknown>)
      : {};
  return {
    taskId: String(task.id || ""),
    parentTaskId:
      task.parentTaskId ||
      (typeof params.parentTaskId === "string"
        ? params.parentTaskId
        : undefined),
    projectId:
      task.projectId ||
      String(input.projectId || params.projectId || binding.projectId || "") ||
      undefined,
    nodeId:
      task.nodeId ||
      String(input.nodeId || params.nodeId || binding.nodeId || "") ||
      undefined,
    segmentId:
      task.segmentId ||
      String(input.segmentId || params.segmentId || binding.segmentId || "") ||
      undefined,
    executor:
      task.executor ||
      String(
        params.executor ||
          (task.kind.startsWith("comfyui:") ? "comfy" : task.kind),
      ),
    model:
      task.model ||
      String(params.model || params.modelName || input.model || "") ||
      undefined,
    status: task.status,
    progress: Number(task.progress || 0),
    outputs: Array.isArray(task.outputs)
      ? task.outputs
      : Array.isArray(result.media)
        ? result.media
        : Array.isArray(result.images)
          ? result.images
          : [],
    error: task.error || undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function inspectCanvasContext(
  config: ResolvedConfig,
  backend: ReturnType<typeof createBackendClient>,
  state: McpSessionState,
  input: Record<string, unknown>,
) {
  const projects = await fetchCanvasProjects(config);
  const requestedId = String(input.projectId || "");
  const selectedId = requestedId || state.activeProjectId || "";
  let project = selectedId
    ? projects.find((item) => item.id === selectedId)
    : projects.length === 1
      ? projects[0]
      : undefined;
  if (requestedId && !project) throw new Error(`画布不存在: ${requestedId}`);
  if (state.activeProjectId && !project && !requestedId) {
    state.activeProjectId = null;
    if (projects.length === 1) project = projects[0];
  }
  if (!project) {
    return {
      ok: true,
      ready: false,
      currentState: { activeProjectId: state.activeProjectId },
      projects: projects.map(projectSummary),
      suggestedAction: projects.length
        ? {
            tool: "canvas_set_active_project",
            reason: "存在多个画布，需要明确选择操作目标",
          }
        : {
            tool: "canvas_create_project",
            reason: "当前还没有画布",
          },
    };
  }
  if (!state.activeProjectId && projects.length === 1)
    state.activeProjectId = project.id;
  const projectState = project as Record<string, unknown>;
  const nodes = nodesOf(projectState);
  const selectedIds = new Set(
    Array.isArray(projectState.selectedNodeIds)
      ? projectState.selectedNodeIds.map(String)
      : [],
  );
  const nodeLimit = Math.max(1, Math.min(500, Number(input.nodeLimit || 100)));
  const summaries = nodes.slice(0, nodeLimit).map(nodeSummary);
  const aiConfig = await backend.getAiConfig();
  const models = configuredModels(aiConfig);
  return {
    ok: true,
    ready: true,
    currentState: {
      activeProjectId: state.activeProjectId,
      targetProjectId: project.id,
      project: projectSummary(project),
    },
    selection: summaries.filter((node) => selectedIds.has(node.id)),
    nodes: summaries,
    truncated: nodes.length > summaries.length,
    referenceCandidates: summaries.filter((node) => node.type !== "config"),
    generationTargets: summaries.filter(
      (node) => node.generationMode || node.type === "config",
    ),
    capabilities: (["text", "image", "video", "audio"] as const).map(
      (capability) => ({
        capability,
        defaultModel: String(aiConfig[`${capability}Model`] || "") || null,
        models: models.filter((model) => model.capability === capability),
        available: models.some((model) => model.capability === capability),
        tool: `canvas_generate_${capability}`,
      }),
    ),
    suggestedAction: {
      generate: "直接调用 canvas_generate_text/image/video/audio",
      existingNode: "调用 canvas_run_generation",
      task: "生成返回 taskId 后调用 canvas_task_status",
    },
  };
}

function projectSummary(project: CanvasProject) {
  return {
    id: project.id,
    title: project.title,
    revision: Number(project.revision || 0),
    updatedAt: project.updatedAt,
    nodeCount: Array.isArray(project.nodes) ? project.nodes.length : 0,
    connectionCount: Array.isArray(project.connections)
      ? project.connections.length
      : 0,
  };
}

function nodeSummary(node: Record<string, unknown>) {
  const metadata = recordOf(node.metadata);
  const position = recordOf(node.position);
  return {
    id: String(node.id || ""),
    type: String(node.type || ""),
    title: String(node.title || ""),
    position: { x: Number(position.x || 0), y: Number(position.y || 0) },
    status: String(metadata.status || "") || undefined,
    generationMode:
      String(
        metadata.generationMode ||
          (String(node.type || "").includes("minimax") ? "video" : ""),
      ) || undefined,
    model: String(metadata.model || "") || undefined,
    storageKey: String(metadata.storageKey || "") || undefined,
  };
}

function configuredModels(aiConfig: Record<string, unknown>) {
  const channels = Array.isArray(aiConfig.channels)
    ? aiConfig.channels.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  return channels.flatMap((channel) => {
    const channelId = String(channel.id || "");
    const models = Array.isArray(channel.models)
      ? channel.models.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : [];
    return models.map((model) => ({
      id: `${channelId}::${String(model.name || "")}`,
      name: String(model.name || ""),
      capability: String(model.capability || "text"),
    }));
  });
}

function summarizeCanvasTasks(
  tasks: ReturnType<typeof toCanvasTask>[],
  query: Record<string, unknown>,
) {
  const counts = tasks.reduce<Record<string, number>>((result, task) => {
    result[task.status] = (result[task.status] || 0) + 1;
    return result;
  }, {});
  return {
    ok: true,
    query: {
      taskId: query.taskId || undefined,
      projectId: query.projectId || undefined,
      nodeId: query.nodeId || undefined,
    },
    summary: { total: tasks.length, byStatus: counts },
    tasks: tasks.map((task) => ({
      ...task,
      suggestedAction:
        task.status === "queued" || task.status === "running"
          ? { tool: "canvas_task_status", input: { taskId: task.taskId } }
          : task.status === "succeeded"
            ? { tool: "canvas_inspect", input: { projectId: task.projectId } }
            : { action: "检查 error，修正输入或模型配置后重新生成" },
    })),
  };
}

async function fetchCanvasProjects(
  config: ReturnType<typeof loadConfig>,
  filter?: { episodeId?: string },
): Promise<CanvasProject[]> {
  const params = new URLSearchParams();
  if (filter?.episodeId) params.set("episodeId", filter.episodeId);
  params.set("token", config.token);
  const url = `${config.url.replace(/\/$/, "")}/canvas/projects?${params.toString()}`;
  const response = await fetch(url);
  const body = (await response.json().catch(() => ({}))) as {
    projects?: CanvasProject[];
    error?: string;
  };
  if (!response.ok || !Array.isArray(body.projects))
    throw new Error(body.error || `读取画布失败: HTTP ${response.status}`);
  return body.projects;
}

async function fetchCurrentCanvasProject(
  config: ReturnType<typeof loadConfig>,
  projectId: string,
): Promise<CanvasProject> {
  const projects = await fetchCanvasProjects(config);
  if (projectId) {
    const found = projects.find((project) => project.id === projectId);
    if (found) return found;
    throw new Error(`画布不存在: ${projectId}`);
  }
  if (projects.length !== 1)
    throw new Error("请显式指定 projectId 或先设置唯一活动画布");
  return projects[0];
}

function nodesOf(project: Record<string, unknown>) {
  return Array.isArray(project.nodes)
    ? (project.nodes as Array<Record<string, unknown>>)
    : [];
}
function connectionsOf(project: Record<string, unknown>) {
  return Array.isArray(project.connections)
    ? (project.connections as Array<Record<string, unknown>>)
    : [];
}
function compactProject(project: Record<string, unknown>) {
  const { viewport: _viewport, ...withoutViewport } = project;
  return {
    ...withoutViewport,
    nodes: nodesOf(project),
    connections: connectionsOf(project),
  };
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function toolErrorResult(
  error: unknown,
  tool: ToolName,
  input: Record<string, unknown>,
  state: McpSessionState,
  traceId?: string,
  classified = classifyToolError(error, input, state),
) {
  const { message, code, suggestedAction } = classified;
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: false,
            traceId,
            error: { code, message, recoverable: classified.recoverable },
            currentState: {
              tool,
              activeProjectId: state.activeProjectId,
              requestedProjectId: input.projectId || null,
            },
            suggestedAction,
          },
          null,
          2,
        ),
      },
    ],
  };
}

function classifyToolError(
  error: unknown,
  input: Record<string, unknown>,
  state: McpSessionState,
) {
  const message =
    error instanceof z.ZodError
      ? error.issues
          .map(
            (issue) =>
              `${issue.path.join(".") || "input"}: ${issue.message}`,
          )
          .join("; ")
      : error instanceof Error
        ? error.message
        : String(error);
  const selectionRequired =
    /显式指定 projectId|活动画布|缺少 projectId/.test(message);
  const missingProject = /画布不存在/.test(message);
  const missingTask = /任务不存在/.test(message);
  const missingNode = /找不到|节点.+不存在|生成目标不存在/.test(message);
  const missingModel = /模型/.test(message) && /未配置|没有配置|缺少/.test(message);
  const conflict = /revision|冲突|基线/.test(message);
  const invalidInput = error instanceof z.ZodError;
  const code = selectionRequired
    ? "PROJECT_SELECTION_REQUIRED"
    : missingProject
      ? "PROJECT_NOT_FOUND"
      : missingTask
        ? "TASK_NOT_FOUND"
        : missingNode
          ? "NODE_NOT_FOUND"
          : missingModel
            ? "MODEL_REQUIRED"
            : conflict
              ? "REVISION_CONFLICT"
              : invalidInput
                ? "INVALID_INPUT"
                : "CANVAS_TOOL_FAILED";
  const suggestedAction = selectionRequired || missingProject
    ? { tool: "canvas_inspect", input: {} }
    : missingNode || conflict
      ? {
          tool: "canvas_inspect",
          input: {
            projectId: String(input.projectId || state.activeProjectId || "") || undefined,
          },
        }
      : missingModel
        ? { tool: "models_list", input: {} }
        : { action: "根据 error 修正输入后重试；不要重复提交完全相同的失败请求" };
  return {
    code,
    message,
    recoverable: true,
    suggestedAction,
    suggestedTool: "tool" in suggestedAction ? suggestedAction.tool : undefined,
  };
}

function withTraceId(value: unknown, traceId: string) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), traceId }
    : { traceId, result: value };
}

type McpToolRegistration = (
  name: string,
  options: unknown,
  handler: (input: Record<string, unknown>) => unknown | Promise<unknown>,
) => unknown;

/**
 * Wrap the common MCP registration point so collaboration, compatibility and
 * dynamically loaded plugin tools cannot silently miss observability events.
 * Direct canvas tools already have a richer wrapper below, so they are left as-is.
 */
function installMcpToolObservability(
  server: McpServer,
  state: McpSessionState,
  recordEvent: McpEventRecorder,
) {
  const target = server as unknown as { registerTool: McpToolRegistration };
  const registerTool = target.registerTool.bind(server);
  target.registerTool = (name, options, handler) => {
    if ((DIRECT_CANVAS_TOOLS as readonly string[]).includes(name))
      return registerTool(name, options, handler);
    return registerTool(name, options, async (rawInput) => {
      const input = recordOf(rawInput);
      const traceId = crypto.randomUUID();
      const startedAt = Date.now();
      const inputSummary = summarizeMcpToolInput(input);
      await recordMcpObservabilityEvent(recordEvent, {
        sessionId: state.clientId,
        traceId,
        event: "tool.started",
        tool: name,
        projectId: optionalText(input.projectId || state.activeProjectId),
        nodeId: optionalText(input.nodeId || input.id),
        inputSummary,
      });
      try {
        const result = await handler(input);
        const value = mcpToolResultValue(result);
        const resultRecord = recordOf(result);
        const valueRecord = recordOf(value);
        if (resultRecord.isError === true || valueRecord.ok === false) {
          const errorRecord = recordOf(valueRecord.error);
          const error = new Error(
            String(errorRecord.message || valueRecord.error || "MCP 工具执行失败"),
          );
          const details = classifyToolError(error, input, state);
          await recordMcpObservabilityEvent(recordEvent, {
            sessionId: state.clientId,
            traceId,
            event: "tool.failed",
            tool: name,
            projectId: optionalText(input.projectId || state.activeProjectId),
            nodeId: optionalText(input.nodeId || input.id),
            durationMs: Date.now() - startedAt,
            errorCode: optionalText(errorRecord.code) || details.code,
            recoverable:
              typeof errorRecord.recoverable === "boolean"
                ? errorRecord.recoverable
                : details.recoverable,
            suggestedTool: details.suggestedTool,
            inputSummary,
            outputSummary: {
              errorCode: optionalText(errorRecord.code) || details.code,
            },
          });
        } else {
          await recordMcpObservabilityEvent(recordEvent, {
            sessionId: state.clientId,
            traceId,
            event: "tool.succeeded",
            tool: name,
            durationMs: Date.now() - startedAt,
            inputSummary,
            ...mcpToolResultContext(value, input, state),
          });
        }
        return withTraceIdInToolResult(result, traceId);
      } catch (error) {
        const details = classifyToolError(error, input, state);
        await recordMcpObservabilityEvent(recordEvent, {
          sessionId: state.clientId,
          traceId,
          event: "tool.failed",
          tool: name,
          projectId: optionalText(input.projectId || state.activeProjectId),
          nodeId: optionalText(input.nodeId || input.id),
          durationMs: Date.now() - startedAt,
          errorCode: details.code,
          recoverable: details.recoverable,
          suggestedTool: details.suggestedTool,
          inputSummary,
          outputSummary: { errorCode: details.code },
        });
        return toolErrorResult(
          error,
          name as ToolName,
          input,
          state,
          traceId,
          details,
        );
      }
    });
  };
}

function mcpToolResultValue(result: unknown) {
  const content = recordOf(result).content;
  if (!Array.isArray(content)) return result;
  const text = content
    .map(recordOf)
    .find((item) => item.type === "text" && typeof item.text === "string")?.text;
  if (typeof text !== "string") return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function withTraceIdInToolResult(result: unknown, traceId: string) {
  const source = recordOf(result);
  if (!Array.isArray(source.content)) return result;
  const metadata = { ...recordOf(source._meta), traceId };
  let attached = false;
  const content = source.content.map((entry) => {
    const item = recordOf(entry);
    if (attached || item.type !== "text" || typeof item.text !== "string")
      return entry;
    try {
      const value = JSON.parse(item.text);
      attached = true;
      return {
        ...item,
        text: JSON.stringify(withTraceId(value, traceId), null, 2),
      };
    } catch {
      return entry;
    }
  });
  return attached ? { ...source, content, _meta: metadata } : { ...source, _meta: metadata };
}

function summarizeMcpToolInput(input: Record<string, unknown>) {
  const ops = Array.isArray(input.ops)
    ? input.ops.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  const references = Array.isArray(input.referenceNodeIds)
    ? input.referenceNodeIds
    : [];
  const text = [input.prompt, input.text, input.content].find(
    (value) => typeof value === "string",
  );
  return {
    parameterKeys: Object.keys(input).sort(),
    hasProjectId: Boolean(input.projectId),
    hasNodeId: Boolean(input.nodeId || input.id),
    hasTaskId: Boolean(input.taskId),
    hasModel: Boolean(input.model),
    mode: typeof input.mode === "string" ? input.mode : undefined,
    textLength: typeof text === "string" ? text.length : 0,
    referenceCount: references.length,
    itemCount: Array.isArray(input.items) ? input.items.length : 0,
    operationCount: ops.length,
    operationTypes: [...new Set(ops.map((op) => String(op.type || "unknown")))],
  };
}

function mcpToolResultContext(
  value: unknown,
  input: Record<string, unknown>,
  state: McpSessionState,
): Partial<McpObservabilityEventInput> {
  const result = recordOf(value);
  const tasks = Array.isArray(result.directTasks)
    ? result.directTasks.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  const firstTask = tasks[0] || {};
  const operationResults = Array.isArray(result.operationResults)
    ? result.operationResults
    : [];
  return {
    projectId: optionalText(result.projectId || input.projectId || state.activeProjectId),
    nodeId: optionalText(firstTask.nodeId || result.nodeId || input.nodeId || input.id),
    operationId: optionalText(result.operationId),
    taskId: optionalText(firstTask.taskId || result.taskId),
    outputSummary: {
      ok: result.ok !== false,
      taskCount: tasks.length || (result.taskId ? 1 : 0),
      operationCount: operationResults.length,
      returnedNodeCount: Array.isArray(result.nodes) ? result.nodes.length : undefined,
      ready: typeof result.ready === "boolean" ? result.ready : undefined,
    },
  };
}

async function recordMcpObservabilityEvent(
  recordEvent: McpEventRecorder,
  event: McpObservabilityEventInput,
) {
  if (event.tool === "mcp_observability_report") return;
  try {
    await recordEvent(event);
  } catch (error) {
    logger.warn("MCP observability event failed", {
      tool: event.tool,
      event: event.event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function postMcpObservabilityEvent(
  config: ResolvedConfig,
  event: McpObservabilityEventInput,
) {
  const response = await fetch(
    `${config.url.replace(/\/$/, "")}/mcp/observability/events`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(event),
    },
  );
  if (!response.ok)
    throw new Error(`HTTP ${response.status}`);
}

async function fetchMcpObservabilityReport(
  config: ResolvedConfig,
  traceId?: string,
) {
  const path = traceId
    ? `/mcp/observability/traces/${encodeURIComponent(traceId)}`
    : "/mcp/observability/report";
  const response = await fetch(`${config.url.replace(/\/$/, "")}${path}`, {
    headers: { authorization: `Bearer ${config.token}` },
  });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok)
    throw new Error(String(body.error || `读取 MCP 诊断失败: HTTP ${response.status}`));
  return traceId
    ? { traceId, events: Array.isArray(body.events) ? body.events : [] }
    : recordOf(body.report);
}

function optionalText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

async function saveCanvasProject(
  config: ReturnType<typeof loadConfig>,
  project: CanvasProject,
): Promise<CanvasProject> {
  const response = await fetch(
    `${config.url.replace(/\/$/, "")}/canvas/projects?token=${encodeURIComponent(config.token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(project),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    project?: CanvasProject;
    error?: string;
  };
  if (!response.ok || !body.project)
    throw new Error(body.error || `画布写入失败: HTTP ${response.status}`);
  return body.project;
}

async function applyBackendCanvasOperations(
  config: ReturnType<typeof loadConfig>,
  projectId: string,
  expectedRevision: number | undefined,
  operations: Array<Record<string, unknown>>,
  clientId = `mcp:${process.pid}`,
  operationId = crypto.randomUUID(),
) {
  const response = await fetch(
    `${config.url.replace(/\/$/, "")}/canvas/projects/${encodeURIComponent(projectId)}/ops?token=${encodeURIComponent(config.token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: expectedRevision,
        operations,
        operationId,
        source: { clientId, kind: "mcp", label: "MCP" },
      }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    project?: CanvasProject;
    operationResults?: unknown[];
    revision?: number;
    error?: string;
  };
  if (!response.ok || !body.project)
    throw new Error(body.error || `画布操作失败: HTTP ${response.status}`);
  return {
    project: body.project,
    operationResults: body.operationResults || [],
    revision: Number(body.revision || body.project.revision || 0),
    operationId,
  };
}

async function deleteCanvasProject(
  config: ReturnType<typeof loadConfig>,
  id: string,
): Promise<number> {
  const response = await fetch(
    `${config.url.replace(/\/$/, "")}/canvas/projects/${encodeURIComponent(id)}?token=${encodeURIComponent(config.token)}`,
    { method: "DELETE" },
  );
  const body = (await response.json().catch(() => ({}))) as {
    deleted?: number;
    error?: string;
  };
  if (!response.ok)
    throw new Error(body.error || `画布删除失败: HTTP ${response.status}`);
  return Number(body.deleted || 0);
}

/** 按 storageKey 取回媒体二进制（走 Backend 的 /media 读取接口）。 */
async function fetchMediaBuffer(
  config: ReturnType<typeof loadConfig>,
  storageKey: string,
): Promise<Buffer> {
  const base = config.url.replace(/\/$/, "");
  const url = `${base}/media/${encodeURIComponent(storageKey)}?token=${encodeURIComponent(config.token)}`;
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`读取媒体失败（HTTP ${response.status}）：${storageKey}`);
  return Buffer.from(await response.arrayBuffer());
}

/** 上传二进制媒体到 Backend，返回 storageKey / url / bytes。 */
async function uploadMediaBinary(
  config: ReturnType<typeof loadConfig>,
  data: Buffer,
  options: {
    name: string;
    mimeType: string;
    category?: "input" | "output" | "library";
    width?: number | null;
    height?: number | null;
  },
): Promise<{ storageKey: string; url: string; bytes: number }> {
  const base = config.url.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "content-type": options.mimeType,
    "x-media-name": encodeURIComponent(options.name),
    "x-media-category": options.category || "output",
  };
  if (options.width) headers["x-media-width"] = String(options.width);
  if (options.height) headers["x-media-height"] = String(options.height);
  const response = await fetch(
    `${base}/media/upload-binary?token=${encodeURIComponent(config.token)}`,
    {
      method: "POST",
      headers,
      body: new Uint8Array(data),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    media?: { storageKey?: string; url?: string; bytes?: number };
    error?: string;
  };
  if (!response.ok || !body.media?.storageKey)
    throw new Error(body.error || `媒体上传失败: HTTP ${response.status}`);
  return {
    storageKey: String(body.media.storageKey),
    url: String(body.media.url || ""),
    bytes: Number(body.media.bytes || data.length),
  };
}

function registerDirectComfyTools(
  server: McpServer,
  backend: ReturnType<typeof createBackendClient>,
) {
  server.registerTool(
    "comfyui_status",
    {
      description: "检查本地 ComfyUI 连接和系统状态。",
      inputSchema: z.object({}).shape,
    },
    async () => ({
      content: [
        { type: "text", text: JSON.stringify(await backend.comfyStatus()) },
      ],
    }),
  );
  server.registerTool(
    "comfyui_get_task",
    {
      description: "查询 ComfyUI 任务。",
      inputSchema: z.object({ taskId: z.string() }).shape,
    },
    async ({ taskId }) => {
      const result = await backend.comfyGetTask(taskId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
  server.registerTool(
    "comfyui_cancel_task",
    {
      description: "取消 ComfyUI 任务。",
      inputSchema: z.object({ taskId: z.string() }).shape,
    },
    async ({ taskId }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await backend.comfyCancel(taskId)),
        },
      ],
    }),
  );
}

/** 工作台、网页导航和对话工具仍需要当前浏览器会话，保留旧协议兼容入口。 */
function registerBrowserCompatibilityTools(
  server: McpServer,
  config: ReturnType<typeof loadConfig>,
) {
  const registeredTools =
    (server as unknown as { _registeredTools?: Record<string, unknown> })
      ._registeredTools || {};
  for (const name of toolNames.filter(
    (item) => !DIRECT_TOOL_NAMES.has(item) && !item.startsWith("h3_"),
  )) {
    if (registeredTools[name]) continue;
    const schema = toolInputSchemas[name];
    server.registerTool(
      name,
      { description: toolDescriptions[name], inputSchema: schema.shape },
      async (input: Record<string, unknown>) => {
        const response = await fetch(
          `${config.url.replace(/\/$/, "")}/agent/api/tools`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.token}`,
            },
            body: JSON.stringify({ name, input: schema.parse(input) }),
          },
        );
        const body = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          result?: unknown;
          error?: string;
        };
        if (!response.ok || !body.ok)
          throw new Error(
            body.error || `浏览器 Agent 工具调用失败：HTTP ${response.status}`,
          );
        return textResult(body.result);
      },
    );
  }
}
