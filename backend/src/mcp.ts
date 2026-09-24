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
import { redactInlineMedia } from "./runtime/redact-inline-media.js";
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
import { createH3NodeMetadata, isH3NodeType, readH3Layout } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import type { CanvasImageGenerationInput } from "./canvas/image-dispatcher.js";
import type { CanvasTextGenerationInput } from "./canvas/text-dispatcher.js";
import { splitImageBuffer } from "./canvas/image-split.js";
import { cropImageBuffer, parseAspectRatio, type CropAnchor } from "./canvas/image-crop.js";
import {
  effectiveCanvasNodeType,
  resolveCanvasImageReferenceNode,
} from "./canvas/image-references.js";
import {
  backendComfyUi,
  createBackendClient,
} from "@basketikun/canvas-agent/runtime/comfy-client";
import { createLogger } from "./logger.js";
import type { McpObservabilityStore } from "./stores/types.js";

type McpProjectSource = "browser" | "session";
type BrowserActiveProjectResolver = () => string | null;
type McpSessionState = {
  activeProjectId: string | null;
  activeProjectSource: McpProjectSource;
  clientId: string;
};
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
  getBrowserActiveProjectId?: BrowserActiveProjectResolver,
): Promise<BackendMcpInstance> {
  const state: McpSessionState = {
    activeProjectId: null,
    activeProjectSource: "browser",
    clientId: `mcp:${crypto.randomUUID()}`,
  };
  // 插件 MCP（尤其 H3）只通过常驻 Backend API 访问画布、任务、媒体和设置，
  // 不再在 MCP 进程内创建自己的 ComfyUI/SQLite 业务副本。
  const backendApi = createBackendClient(config.url);
  const backendComfy = backendComfyUi(backendApi, () => []);
  const directBackend: PluginMcpBackend = {
    backendUrl: config.url,
    listCanvasProjects: () => backendApi.listCanvasProjects(),
    getCanvasProject: (projectId) => backendApi.getCanvasProject(projectId),
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
  registerBackendCanvasTools(server, config, backendApi, state, recordEvent, getBrowserActiveProjectId);
  registerDirectComfyTools(server, backendApi);
  registerAgentSessionCompatibilityTools(server, config);
  const context = buildPluginMcpContext(directBackend, backendComfy);
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
 * 客户端各自拥有 MCP 会话和 activeProjectId，但复用同一个 Node 进程、模块缓存与 Backend 生命周期；
 * 未被会话手动锁定时，默认目标来自浏览器实时协作连接当前聚焦的画布。
 */
export function registerBackendMcpHttpRoutes(
  app: Express,
  config: ResolvedConfig,
  observability?: McpObservabilityStore,
  getBrowserActiveProjectId?: BrowserActiveProjectResolver,
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
        getBrowserActiveProjectId,
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

// Backend 是外部 MCP 的执行入口；只有需要当前网页会话的工具才走下方 Agent 兼容转发。
const BACKEND_CANVAS_TOOLS = [
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
  "canvas_generate_image_batch",
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
  "canvas_wait_tasks",
  "generation_get_status",
  "mcp_observability_report",
  "models_list",
] as ToolName[];
const BACKEND_OWNED_TOOL_NAMES = new Set<string>([
  ...BACKEND_CANVAS_TOOLS,
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

const EXISTING_CANVAS_STATE_TOOLS = new Set<ToolName>([
  "canvas_apply_ops",
  "canvas_create_image_prompt_flow",
  "canvas_create_generation_flow",
  "canvas_generate_text",
  "canvas_generate_image",
  "canvas_generate_video",
  "canvas_generate_audio",
  "canvas_set_generation_references",
  "canvas_update_node",
  "canvas_update_node_text",
  "canvas_move_nodes",
  "canvas_resize_node",
  "canvas_delete_nodes",
  "canvas_connect_nodes",
  "canvas_select_nodes",
  "canvas_run_generation",
]);

function resolveMcpProjectId(
  state: McpSessionState,
  rawProjectId: unknown,
  getBrowserActiveProjectId?: BrowserActiveProjectResolver,
) {
  const explicit = String(rawProjectId || "").trim();
  if (explicit) return { projectId: explicit, source: "explicit-input" as const };
  if (state.activeProjectSource === "session" && state.activeProjectId)
    return { projectId: state.activeProjectId, source: "session-pinned" as const };
  const browserProjectId = String(getBrowserActiveProjectId?.() || "").trim();
  if (browserProjectId) {
    state.activeProjectId = browserProjectId;
    state.activeProjectSource = "browser";
    return { projectId: browserProjectId, source: "browser-focused" as const };
  }
  state.activeProjectId = null;
  state.activeProjectSource = "browser";
  return { projectId: "", source: "none" as const };
}

async function executeDirectCanvasTool(
  config: ResolvedConfig,
  backendApi: ReturnType<typeof createBackendClient>,
  state: McpSessionState,
  name: ToolName,
  input: Record<string, unknown>,
  getBrowserActiveProjectId?: BrowserActiveProjectResolver,
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
      await fetchCanvasProjects(config, episodeId ? { episodeId } : undefined, { summary: true })
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
        nodeCount: Number((project as Record<string, unknown>).nodeCount || 0),
        connectionCount: Number((project as Record<string, unknown>).connectionCount || 0),
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
    const target = resolveMcpProjectId(state, input.projectId, getBrowserActiveProjectId);
    const query = {
      ...input,
      ...(!taskId && !input.projectId && target.projectId
        ? { projectId: target.projectId }
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
  if (name === "canvas_generate_image_batch") {
    const projectId = resolveMcpProjectId(state, input.projectId, getBrowserActiveProjectId).projectId;
    if (!projectId) throw new Error("缺少 projectId；请先选择活动画布");
    const items = Array.isArray(input.items)
      ? (input.items as Array<Record<string, unknown>>)
      : [];
    const batchDefaults = recordOf(input.defaults);
    const defaultModel = items.some((item) => !String(item.model || batchDefaults.model || "").trim())
      ? String(
          (
            await applyGenerationDefaults(
              "canvas_generate_image",
              { projectId, ...batchDefaults },
              backendApi,
            )
          ).model || "",
        )
      : undefined;
    const results: Array<Record<string, unknown>> = [];
    const taskIds: string[] = [];
    for (const item of items) {
      try {
        const key = String(item.key || "");
        const { key: _key, ...generationInput } = item;
        const resolvedGenerationInput = await applyGenerationDefaults(
          "canvas_generate_image",
          { projectId, ...batchDefaults, ...generationInput },
          backendApi,
          defaultModel,
        );
        // 生产图像只创建一个智能 config 节点。不要走 canvas_generate_image，
        // 那条兼容路径会额外创建仅承载 prompt 的 text 节点。
        const smartNodeId = `config-smart-${crypto.randomUUID()}`;
        await executeDirectCanvasTool(
          config,
          backendApi,
          state,
          "canvas_create_config_node",
          {
            projectId,
            id: smartNodeId,
            mode: "image",
            autoRun: false,
            ...resolvedGenerationInput,
          },
        );
        const result = (await executeDirectCanvasTool(
          config,
          backendApi,
          state,
          "canvas_run_generation",
          {
            projectId,
            nodeId: smartNodeId,
            mode: "image",
            ...resolvedGenerationInput,
          },
        )) as Record<string, unknown>;
        const directTasks = Array.isArray(result.directTasks)
          ? result.directTasks
              .filter(
                (task): task is Record<string, unknown> =>
                  Boolean(task) && typeof task === "object" && !Array.isArray(task),
              )
              .map((task) => ({
                taskId: String(task.taskId || ""),
                nodeId: String(task.nodeId || ""),
                model: String(task.model || ""),
              }))
          : [];
        for (const task of directTasks) if (task.taskId) taskIds.push(task.taskId);
        results.push({
          key,
          operationId: result.operationId,
          directTasks,
        });
      } catch (error) {
        throw Object.assign(
          error instanceof Error ? error : new Error(String(error)),
          { taskIds: [...new Set(taskIds)], projectId },
        );
      }
    }
    const uniqueTaskIds = [...new Set(taskIds)];
    const wait =
      input.waitForCompletion === true
        ? await waitForCanvasTasks(backendApi, uniqueTaskIds, input)
        : undefined;
    return {
      ok: true,
      requestId: crypto.randomUUID(),
      projectId,
      count: results.length,
      items: results,
      taskIds: uniqueTaskIds,
      directTasks: results.flatMap((result) =>
        Array.isArray(result.directTasks) ? result.directTasks : [],
      ),
      ...(wait ? { wait } : {}),
      ...(uniqueTaskIds.length ? { next: waitTasksAction(uniqueTaskIds) } : {}),
    };
  }
  if (name === "canvas_wait_tasks") {
    const taskIds = Array.isArray(input.taskIds) ? input.taskIds.map(String) : [];
    return {
      ok: true,
      ...(await waitForCanvasTasks(backendApi, taskIds, input)),
    };
  }
  if (name === "canvas_inspect")
    return inspectCanvasContext(config, backendApi, state, input, getBrowserActiveProjectId);
  const projectId = resolveMcpProjectId(state, input.projectId, getBrowserActiveProjectId).projectId;
  const project = await fetchCurrentCanvasProject(config, projectId);
  const projectState = project as Record<string, unknown>;
  if (name === "canvas_get_state")
    return compactProjectSummary(projectState, input);
  if (name === "canvas_export_snapshot")
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
  preflightExistingCanvasState(name, toolInput, projectState);
  const request = buildCanvasToolRequest(name, toolInput, {
    nodes: nodesOf(projectState) as never,
    connections: connectionsOf(projectState) as never,
  });
  const rawOps = Array.isArray(request.input.ops)
    ? (request.input.ops as Array<Record<string, unknown>>)
    : [];
  const ops = await Promise.all(
    rawOps.map(async (op) =>
      op.type === "add_node" && isH3NodeType(op.nodeType)
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
  const canBatchSubmitIndependentImages =
    ops.length > 1 &&
    ops.every((op) => op.type === "run_generation" && String(op.mode || "image") === "image") &&
    new Set(ops.map((op) => String(op.nodeId || ""))).size === ops.length;
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
      if (!canBatchSubmitIndependentImages)
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
      if (!canBatchSubmitIndependentImages)
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
  if (canBatchSubmitIndependentImages && directTasks.length)
    withLoadingState = await fetchCurrentCanvasProject(config, project.id);
  const response: Record<string, unknown> = {
    ok: true,
    intent: name.startsWith("canvas_generate_")
      ? name.replace("canvas_generate_", "generate_")
      : undefined,
    projectId: withLoadingState.id,
    revision: operationResponse.revision,
    operationId: operationResponse.operationId,
    operationResults,
    affectedNodeIds: affectedNodeIds(ops),
    directTasks,
    next:
      directTasks.length === 1
        ? waitTasksAction([directTasks[0].taskId])
        : directTasks.length > 1
        ? waitTasksAction(directTasks.map((task) => task.taskId))
        : undefined,
  };
  return response;
}

function affectedNodeIds(operations: Array<Record<string, unknown>>) {
  const ids = new Set<string>();
  for (const operation of operations) {
    for (const key of ["id", "nodeId", "fromNodeId", "toNodeId"]) {
      const value = String(operation[key] || "").trim();
      if (value) ids.add(value);
    }
    for (const value of Array.isArray(operation.ids) ? operation.ids : []) {
      const id = String(value || "").trim();
      if (id) ids.add(id);
    }
  }
  return [...ids];
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

function registerBackendCanvasTools(
  server: McpServer,
  config: ResolvedConfig,
  backendApi: ReturnType<typeof createBackendClient>,
  state: McpSessionState,
  recordEvent: McpEventRecorder,
  getBrowserActiveProjectId?: BrowserActiveProjectResolver,
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
  for (const name of BACKEND_CANVAS_TOOLS) {
    const schema = toolInputSchemas[name];
    // Pass zod schema (not schema.shape) so MCP SDK walks each property and
    // serializes the .describe() text into JSON Schema "description" fields.
    // Using .shape bypasses the conversion and drops every field description,
    // making OpenAI tool-use guess at fields like items/tags/x-vs-dx.
    server.registerTool(
      name,
      {
        description: toolDescriptions[name],
        inputSchema: schema,
      },
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
            getBrowserActiveProjectId,
          );
          const context = mcpToolResultContext(value, input, state, name);
          // 画布类工具绕过上面的通用包装，因此在这里施加同一道输出上限。
          enforceToolOutputLimit(name, value);
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
          const errorContext = mcpToolErrorContext(error, rawInput, state);
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
            ...errorContext,
            outputSummary: {
              ...recordOf(errorContext.outputSummary),
              errorCode: details.code,
              ...payloadOverflowSummary(error),
            },
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
      const projectId = resolveMcpProjectId(state, input.projectId, getBrowserActiveProjectId).projectId;
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
  for (const name of ["assets_list", "assets_add", "assets_upsert_batch"] as ToolName[]) {
    const schema = toolInputSchemas[name];
    server.registerTool(
      name,
      { description: toolDescriptions[name], inputSchema: schema.shape },
      async (rawInput: Record<string, unknown>) => {
        const input = schema.parse(rawInput) as Record<string, unknown>;
        if (name === "assets_list") {
          // 以前 kind 之外的参数（keyword/page/pageSize）被静默忽略、永远返回全量；
          // 全量在资产多时可达 2 MB，会直接撞上输出上限，所以这里把参数真正落地。
          const all = (
            await backendApi.listAssets({
              kind:
                input.kind && input.kind !== "all"
                  ? String(input.kind)
                  : undefined,
            })
          ).assets;
          // 与工具描述一致地剥离内联媒体：单个资产的 coverUrl/data 可能是 2MB 的
          // base64（实测），不剥离时连 pageSize=1 都过不了输出上限，列表工具直接失效。
          const redacted = all.map((asset) => redactInlineMedia(asset));
          const keyword = String(input.keyword ?? "").trim().toLowerCase();
          const filtered = keyword
            ? redacted.filter((asset) => {
                const record = recordOf(asset);
                return [record.title, record.description, record.content]
                  .map((field) => String(field ?? ""))
                  .some((field) => field.toLowerCase().includes(keyword));
              })
            : redacted;
          const pageSize = Math.max(0, Number(input.pageSize ?? 0) || 0);
          const page = Math.max(1, Number(input.page ?? 1) || 1);
          if (pageSize > 0) {
            const start = (page - 1) * pageSize;
            return textResult({
              total: filtered.length,
              page,
              pageSize,
              items: filtered.slice(start, start + pageSize),
            });
          }
          return textResult(filtered);
        }
        if (name === "assets_upsert_batch") {
          const now = new Date().toISOString();
          const items = Array.isArray(input.items)
            ? (input.items as Array<Record<string, unknown>>)
            : [];
          const assets = await Promise.all(
            items.map((item) =>
              backendApi.upsertAsset({
                id: String(item.id || `asset-${crypto.randomUUID()}`),
                kind: String(item.kind || "image"),
                title: String(item.title || ""),
                coverUrl: String(item.coverUrl || ""),
                tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
                folderId: item.folderId == null ? null : String(item.folderId),
                ...(item.dramaId == null ? {} : { dramaId: String(item.dramaId) }),
                data: recordOf(item.data),
                note: item.note == null ? null : String(item.note),
                source: item.source == null ? null : String(item.source),
                metadata: recordOf(item.metadata),
                createdAt: now,
                updatedAt: now,
              }),
            ),
          );
          const listed = await backendApi.listAssets();
          const savedIds = new Set(
            listed.assets
              .filter(
                (asset): asset is Record<string, unknown> =>
                  Boolean(asset) && typeof asset === "object" && !Array.isArray(asset),
              )
              .map((asset) => String(asset.id || "")),
          );
          return textResult({
            ok: true,
            count: assets.length,
            verifiedCount: assets.filter((asset) => savedIds.has(String(asset.id || ""))).length,
            assets,
          });
        }
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
      const projectId = resolveMcpProjectId(state, rawInput.projectId, getBrowserActiveProjectId).projectId;
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
    "canvas_crop_image",
    {
      description:
        "按指定画幅比例裁切画布图片节点，默认严格 9:16。只抽取源图像素，不拉伸、不覆盖原图；生成新的图片媒体和新节点，并保留源节点。支持 nodeId 或 nodeIds 批量裁切，anchor 可选 center/top/bottom/left/right，也可传精确 cropRect 像素矩形。",
      inputSchema: z.object({
        projectId: z.string().optional(),
        nodeId: z.string().optional(),
        nodeIds: z.array(z.string()).min(1).optional(),
        aspectRatio: z.string().optional(),
        anchor: z.enum(["center", "top", "bottom", "left", "right"]).optional(),
        cropRect: z.object({
          left: z.number(),
          top: z.number(),
          width: z.number(),
          height: z.number(),
        }).optional(),
        gap: z.number().optional(),
      }).shape,
    },
    async (rawInput: Record<string, unknown>) => {
      const projectId = resolveMcpProjectId(state, rawInput.projectId, getBrowserActiveProjectId).projectId;
      if (!projectId) throw new Error("缺少 projectId；请先选择活动画布");
      const nodeIds = [
        ...(rawInput.nodeId ? [String(rawInput.nodeId)] : []),
        ...(Array.isArray(rawInput.nodeIds) ? rawInput.nodeIds.map(String) : []),
      ].filter(Boolean);
      const uniqueNodeIds = [...new Set(nodeIds)];
      if (!uniqueNodeIds.length) throw new Error("nodeId 或 nodeIds 至少传一个");

      const ratio = parseAspectRatio(String(rawInput.aspectRatio || "9:16"));
      const anchor = String(rawInput.anchor || "center") as CropAnchor;
      const rawRect = rawInput.cropRect;
      const cropRect = rawRect && typeof rawRect === "object" && !Array.isArray(rawRect)
        ? {
            left: Number((rawRect as Record<string, unknown>).left),
            top: Number((rawRect as Record<string, unknown>).top),
            width: Number((rawRect as Record<string, unknown>).width),
            height: Number((rawRect as Record<string, unknown>).height),
          }
        : undefined;
      const gap = Math.max(0, Number(rawInput.gap ?? 96));
      const project = await fetchCurrentCanvasProject(config, projectId);
      const projectNodes = nodesOf(project);
      const operations: Array<Record<string, unknown>> = [];
      const created: Array<Record<string, unknown>> = [];

      for (let index = 0; index < uniqueNodeIds.length; index += 1) {
        const nodeId = uniqueNodeIds[index];
        const node = projectNodes.find((item) => String(item.id) === nodeId);
        if (!node) throw new Error(`画布上找不到节点：${nodeId}`);
        const meta = (node.metadata || {}) as Record<string, unknown>;
        const storageKey = meta.storageKey ? String(meta.storageKey) : "";
        if (!storageKey) throw new Error(`节点 ${nodeId} 没有 storageKey（不是图片结果节点？）`);

        const source = await fetchMediaBuffer(config, storageKey);
        const cropped = await cropImageBuffer(source, {
          aspectWidth: ratio.width,
          aspectHeight: ratio.height,
          anchor,
          cropRect,
        });
        const media = await uploadMediaBinary(config, cropped.data, {
          name: `crop_${String(nodeId).replace(/[^\\w.-]/g, "_")}_${ratio.width}x${ratio.height}.png`,
          mimeType: "image/png",
          category: "output",
          width: cropped.width,
          height: cropped.height,
        });

        const sourcePosition = (node.position || {}) as Record<string, number>;
        const sourceWidth = Number(node.width || 0) || 340;
        const canvasWidth = Math.max(160, Math.round(sourceWidth));
        const canvasHeight = Math.max(160, Math.round(canvasWidth * ratio.height / ratio.width));
        const id = `image-${crypto.randomUUID()}`;
        const title = `${String(node.title || "图片")} · crop ${ratio.width}:${ratio.height}`;
        const position = {
          x: (Number(sourcePosition.x || 0) + sourceWidth + gap),
          y: Number(sourcePosition.y || 0) + index * (canvasHeight + gap),
        };
        operations.push({
          type: "add_node",
          nodeType: "image",
          id,
          title,
          position,
          width: canvasWidth,
          height: canvasHeight,
          metadata: {
            content: media.url,
            storageKey: media.storageKey,
            status: "success",
            naturalWidth: cropped.width,
            naturalHeight: cropped.height,
            bytes: media.bytes,
            mimeType: "image/png",
            cropSourceNodeId: nodeId,
            cropSourceStorageKey: storageKey,
            cropAspectRatio: `${ratio.width}:${ratio.height}`,
            cropRect: {
              left: cropped.left,
              top: cropped.top,
              width: cropped.width,
              height: cropped.height,
            },
            ...(meta.prompt ? { prompt: meta.prompt } : {}),
          },
        });
        operations.push({ type: "connect_nodes", fromNodeId: nodeId, toNodeId: id, role: "derived" });
        created.push({
          id,
          sourceNodeId: nodeId,
          sourceStorageKey: storageKey,
          storageKey: media.storageKey,
          url: media.url,
          sourceWidth: cropped.sourceWidth,
          sourceHeight: cropped.sourceHeight,
          left: cropped.left,
          top: cropped.top,
          width: cropped.width,
          height: cropped.height,
          aspectRatio: `${cropped.width}:${cropped.height}`,
        });
      }

      const applied = await applyBackendCanvasOperations(
        config,
        project.id,
        Number(project.revision || 0),
        operations,
        state.clientId,
      );
      return textResult({
        ok: true,
        projectId: project.id,
        sourceNodeIds: uniqueNodeIds,
        requestedAspectRatio: `${ratio.width}:${ratio.height}`,
        count: created.length,
        created,
        revision: applied.revision,
        originalNodesPreserved: true,
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
      state.activeProjectSource = "session";
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
      if (state.activeProjectId === id) {
        state.activeProjectId = null;
        state.activeProjectSource = "browser";
      }
      return textResult({ ok: true, deleted: deleted > 0 });
    },
  );
  server.registerTool(
    "canvas_set_active_project",
    {
      description:
        "设置当前活动画布（后续 MCP 操作目标）。传 id 会固定本 MCP 会话的目标；不传 id 则解除固定并恢复跟随浏览器当前聚焦画布。",
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
        state.activeProjectSource = "session";
      } else {
        state.activeProjectId = null;
        state.activeProjectSource = "browser";
      }
      return textResult({
        ok: true,
        activeProjectId:
          state.activeProjectId ||
          getBrowserActiveProjectId?.() ||
          null,
        source: state.activeProjectId ? state.activeProjectSource : "browser",
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
  if (!isH3NodeType(input.nodeType)) return input;
  const defaults = await backend.getH3Defaults();
  const metadata = recordOf(input.metadata);
  // 默认参数里的 layout 是「设为默认参数」一并保存的布局快照：
  // 节点宽高在这里消费，各模块区域宽高交给节点工厂写进 metadata。
  const layout = readH3Layout(defaults.layout);
  return {
    ...input,
    width: input.width ?? layout.width ?? 1960,
    height: input.height ?? layout.height ?? 1080,
    metadata: createH3NodeMetadata(defaults, metadata, layout.panes),
  };
}

async function applyGenerationDefaults(
  name: ToolName,
  input: Record<string, unknown>,
  backend: ReturnType<typeof createBackendClient>,
  cachedModel?: string,
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
  const aiConfig = cachedModel
    ? undefined
    : await backend.getAiConfig();
  const key = `${mode}Model`;
  const fallback = mode === "image" || mode === "text" ? aiConfig?.model : "";
  const model = String(cachedModel || aiConfig?.[key] || fallback || "").trim();
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
    if (node && ["image", "character", "scene"].includes(effectiveCanvasNodeType(node)))
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

  const addedReferenceIds = new Set<string>();
  const references = [...referencedIds].flatMap((id) => {
    const node = nodeById.get(id);
    if (!node) return [];
    return resolveCanvasImageReferenceNode(node, source, addedReferenceIds);
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
    referenceNodeIds: explicitReferenceIds.length ? explicitReferenceIds : undefined,
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

async function waitForCanvasTasks(
  backend: ReturnType<typeof createBackendClient>,
  taskIds: string[],
  input: Record<string, unknown>,
) {
  const timeoutMs = Math.max(
    1000,
    Math.min(1_800_000, Number(input.timeoutMs || 900_000)),
  );
  const pollMs = Math.max(250, Math.min(10_000, Number(input.pollMs || 2_000)));
  const startedAt = Date.now();
  const terminal = new Set(["succeeded", "failed", "cancelled", "completed", "missing"]);
  let pollCount = 1;
  let eventCount = 0;
  let waitMode = "poll";
  let tasks: Array<Record<string, unknown>> = [];
  const initial = (await listTasksFromBackend(backend, { taskIds })).tasks;
  const initialById = new Map(initial.map((task) => [String(task.taskId || ""), task]));
  tasks = taskIds.map((taskId) => initialById.get(taskId) || { taskId, status: "missing", progress: 0, outputs: [], error: "任务不存在或已被清理" });
  if (initial.length === taskIds.length && initial.length > 0 && initial.every((task) => String(task.kind || "").includes("h3"))) {
    const eventResult = await waitForH3TaskEvents(backend, taskIds, initial, timeoutMs);
    if (eventResult.connected) {
      tasks = eventResult.tasks;
      eventCount = eventResult.eventCount;
      waitMode = eventResult.usedStream ? "sse" : "snapshot";
    } else waitMode = "poll-fallback";
  }
  for (;;) {
    if (!tasks.length || !tasks.every((task) => terminal.has(String(task.status)))) {
      if (tasks.length) pollCount += 1;
      const result = await listTasksFromBackend(backend, { taskIds });
      const snapshots = new Map(result.tasks.map((task) => [String(task.taskId || ""), task]));
      tasks = taskIds.map((taskId) => snapshots.get(taskId) || { taskId, status: "missing", progress: 0, outputs: [], error: "任务不存在或已被清理" });
    }
    const complete = tasks.every((task) => terminal.has(String(task.status)));
    const elapsedMs = Date.now() - startedAt;
    if (complete || elapsedMs >= timeoutMs) {
      const pendingTaskIds = tasks
        .filter((task) => !terminal.has(String(task.status)))
        .map((task) => String(task.taskId || ""))
        .filter(Boolean);
      return {
        timedOut: !complete,
        elapsedMs,
        pollCount,
        eventCount,
        waitMode,
        summary: {
          total: tasks.length,
          complete: tasks.filter((task) => terminal.has(String(task.status))).length,
          byStatus: tasks.reduce<Record<string, number>>((counts, task) => {
            const status = String(task.status || "unknown");
            counts[status] = (counts[status] || 0) + 1;
            return counts;
          }, {}),
        },
        ...(pendingTaskIds.length ? { next: waitTasksAction(pendingTaskIds) } : {}),
        tasks,
      };
    }
    if (waitMode === "sse") waitMode = "poll-fallback";
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, timeoutMs - elapsedMs))));
  }
}

async function waitForH3TaskEvents(
  backend: ReturnType<typeof createBackendClient>, taskIds: string[], initial: Array<Record<string, unknown>>, timeoutMs: number,
) {
  const terminal = new Set(["succeeded", "failed", "cancelled", "completed", "missing"]);
  const tasks = new Map(initial.map((task) => [String(task.taskId || ""), task]));
  if ([...tasks.values()].every((task) => terminal.has(String(task.status)))) return { tasks: taskIds.map((id) => tasks.get(id)!), connected: true, eventCount: 0, usedStream: false };
  if (timeoutMs <= 0) return { tasks: [], connected: false, eventCount: 0 };
  const controller = new AbortController();
  let eventCount = 0;
  let cursor: string | undefined;
  let reconnects = 0;
  try {
    let stream = backend.streamEvents(controller.signal);
    const first = await withMcpTimeout(stream.next(), Math.min(timeoutMs, 10_000));
    if (!first || first.done || first.value.type !== "events.sync") throw new Error("SSE sync missing");
    // Subscribe first, then re-read exact task IDs to close the completion race.
    const fresh = (await listTasksFromBackend(backend, { taskIds })).tasks;
    for (const task of fresh) tasks.set(String(task.taskId || ""), task);
    const deadline = Date.now() + timeoutMs;
    while (![...tasks.values()].every((task) => terminal.has(String(task.status))) && Date.now() < deadline) {
      const next = await withMcpTimeout(stream.next().catch(() => ({ done: true as const, value: {} as Record<string, unknown> })), Math.max(1, deadline - Date.now()));
      if (next === null) break;
      if (next.done) {
        if (reconnects++ > 0 || !cursor) throw new Error("SSE disconnected");
        stream = backend.streamEvents(controller.signal, cursor);
        const resumed = await stream.next();
        if (resumed.done || resumed.value.type !== "events.sync") throw new Error("SSE replay failed");
        cursor = String(resumed.value.id || cursor);
        const recovered = (await listTasksFromBackend(backend, { taskIds })).tasks;
        for (const task of recovered) tasks.set(String(task.taskId || ""), task);
        continue;
      }
      const event = next.value;
      cursor = String(event.id || cursor || "") || undefined;
      if (!String(event.type || "").startsWith("task.")) continue;
      eventCount++;
      if (!taskIds.includes(String(event.entityId || ""))) continue;
      const payload = recordOf(event.payload);
      if (!terminal.has(String(payload.status || "")) && !["task.completed", "task.failed"].includes(String(event.type))) continue;
      const snapshots = (await listTasksFromBackend(backend, { taskIds })).tasks;
      for (const task of snapshots) tasks.set(String(task.taskId || ""), task);
    }
    controller.abort();
    return { tasks: taskIds.map((id) => tasks.get(id) || { taskId: id, status: "missing", progress: 0, outputs: [], error: "任务不存在或已被清理" }), connected: true, eventCount, usedStream: true };
  } catch {
    controller.abort();
    return { tasks: [], connected: false, eventCount };
  }
}

async function withMcpTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function listTasksFromBackend(
  backend: ReturnType<typeof createBackendClient>,
  input: Record<string, unknown>,
) {
  const taskId = typeof input.taskId === "string" ? input.taskId : "";
  const taskIds = Array.isArray(input.taskIds) ? input.taskIds.map(String).filter(Boolean) : [];
  const source = (
    taskId
      ? [await getTaskForQuery(backend, taskId)]
      : await backend.listTasks({
          taskIds: taskIds.length ? taskIds : undefined,
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
  const exactTaskQuery = Boolean(taskId);
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
      if (!exactTaskQuery && projectId && taskProjectId !== projectId) return false;
      if (!exactTaskQuery && nodeIds.size && !nodeIds.has(taskNodeId)) return false;
      if (!exactTaskQuery && segmentIds.size && !segmentIds.has(taskSegmentId)) return false;
      if (!exactTaskQuery && scope === "canvas" && !taskProjectId) return false;
      if (
        !exactTaskQuery &&
        scope === "image" &&
        !/image/i.test(`${task.kind} ${taskExecutor} ${taskModel}`)
      )
        return false;
      if (
        !exactTaskQuery &&
        scope === "video" &&
        !/video|h3/i.test(`${task.kind} ${taskExecutor} ${taskModel}`)
      )
        return false;
      return true;
    })
    .slice(0, Math.max(1, Math.min(500, Number(input.limit || 5))))
    .map(toCanvasTask);
  return { tasks };
}

async function getTaskForQuery(
  backend: ReturnType<typeof createBackendClient>,
  taskId: string,
) {
  try {
    return (await backend.getTask(taskId)).task;
  } catch (error) {
    const details = backendErrorInfo(error);
    const missing =
      details.code === "TASK_NOT_FOUND" ||
      (details.status === 404 && /task not found|任务不存在/i.test(safeErrorMessage(error))) ||
      /task not found|任务不存在/i.test(safeErrorMessage(error));
    if (missing) return null;
    throw error;
  }
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
    kind: String(task.kind || ""),
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
  getBrowserActiveProjectId?: BrowserActiveProjectResolver,
) {
  const projects = await fetchCanvasProjects(config);
  const requestedId = String(input.projectId || "");
  const target = resolveMcpProjectId(state, requestedId, getBrowserActiveProjectId);
  const selectedId = target.projectId;
  let project = selectedId
    ? projects.find((item) => item.id === selectedId)
      : projects.length === 1
        ? projects[0]
        : undefined;
  if (requestedId && !project) throw new Error(`画布不存在: ${requestedId}`);
  if (selectedId && !project && !requestedId) {
    state.activeProjectId = null;
    state.activeProjectSource = "browser";
    const browserProjectId = String(getBrowserActiveProjectId?.() || "").trim();
    if (browserProjectId) {
      state.activeProjectId = browserProjectId;
      project = projects.find((item) => item.id === browserProjectId);
    }
    if (!project && projects.length === 1) project = projects[0];
  }
  if (!project) {
    return {
      ok: true,
      ready: false,
      currentState: {
        activeProjectId: state.activeProjectId,
        source: state.activeProjectSource,
      },
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
  if (!state.activeProjectId && projects.length === 1 && !getBrowserActiveProjectId) {
    state.activeProjectId = project.id;
    state.activeProjectSource = "session";
  }
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
      source: requestedId ? "explicit-input" : target.source,
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
          ? waitTasksAction([task.taskId])
          : task.status === "succeeded"
            ? { tool: "canvas_inspect", input: { projectId: task.projectId } }
            : { action: "检查任务 error 和产物；当前不自动重新提交相同生成请求" },
    })),
  };
}

async function fetchCanvasProjects(
  config: ReturnType<typeof loadConfig>,
  filter?: { episodeId?: string },
  options: { summary?: boolean } = {},
): Promise<CanvasProject[]> {
  const params = new URLSearchParams();
  if (filter?.episodeId) params.set("episodeId", filter.episodeId);
  if (options.summary) params.set("summary", "true");
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

/**
 * 用本次写操作已经读取到的最新项目快照做轻量预检。
 * 不再额外调用完整 canvas_get_state，也不阻断幂等删除竞态。
 */
function preflightExistingCanvasState(
  name: ToolName,
  input: Record<string, unknown>,
  project: Record<string, unknown>,
) {
  if (!EXISTING_CANVAS_STATE_TOOLS.has(name)) return;

  const existingNodeIds = new Set(nodesOf(project).map((node) => String(node.id || "")).filter(Boolean));
  const missingNodeIds = new Set<string>();
  const requireNode = (value: unknown) => {
    const id = String(value || "").trim();
    if (id && !existingNodeIds.has(id)) missingNodeIds.add(id);
  };

  const referenceNodeIds = Array.isArray(input.referenceNodeIds)
    ? input.referenceNodeIds
    : [];
  switch (name) {
    case "canvas_apply_ops": {
      const knownNodeIds = new Set(existingNodeIds);
      const ops = Array.isArray(input.ops) ? input.ops : [];
      for (const item of ops) {
        const op = recordOf(item);
        const type = String(op.type || "");
        if (type === "add_node") {
          const id = String(op.id || "").trim();
          if (id) knownNodeIds.add(id);
          continue;
        }
        if (type === "update_node" || type === "run_generation") {
          const id = String(op.id || op.nodeId || "").trim();
          if (id && !knownNodeIds.has(id)) missingNodeIds.add(id);
          const refs = Array.isArray(op.referenceNodeIds) ? op.referenceNodeIds : [];
          for (const ref of refs) {
            const refId = String(ref || "").trim();
            if (refId && !knownNodeIds.has(refId)) missingNodeIds.add(refId);
          }
          continue;
        }
        if (type === "update_h3_segment" || type === "add_h3_segment" || type === "replace_h3_segments") {
          const id = String(op.nodeId || "").trim();
          if (id && !knownNodeIds.has(id)) missingNodeIds.add(id);
          continue;
        }
        if (type === "connect_nodes") {
          const fromNodeId = String(op.fromNodeId || "").trim();
          const toNodeId = String(op.toNodeId || "").trim();
          if (fromNodeId && !knownNodeIds.has(fromNodeId)) missingNodeIds.add(fromNodeId);
          if (toNodeId && !knownNodeIds.has(toNodeId)) missingNodeIds.add(toNodeId);
          continue;
        }
        if (type === "select_nodes") {
          for (const id of Array.isArray(op.ids) ? op.ids : []) {
            const nodeId = String(id || "").trim();
            if (nodeId && !knownNodeIds.has(nodeId)) missingNodeIds.add(nodeId);
          }
          continue;
        }
        // delete_node/delete_connections are intentionally not preflighted:
        // the collaboration protocol defines missing delete targets as idempotent no-ops.
        if (type === "delete_node") {
          const ids = [
            ...(op.id ? [String(op.id)] : []),
            ...(Array.isArray(op.ids) ? op.ids.map(String) : []),
          ];
          for (const id of ids) knownNodeIds.delete(id);
        }
      }
      break;
    }
    case "canvas_update_node":
    case "canvas_update_node_text":
    case "canvas_resize_node":
      requireNode(input.id);
      break;
    case "canvas_move_nodes":
      for (const item of Array.isArray(input.items) ? input.items : []) requireNode(recordOf(item).id);
      break;
    case "canvas_connect_nodes":
      for (const item of Array.isArray(input.connections) ? input.connections : []) {
        const connection = recordOf(item);
        requireNode(connection.fromNodeId);
        requireNode(connection.toNodeId);
      }
      break;
    case "canvas_select_nodes":
      for (const id of Array.isArray(input.ids) ? input.ids : []) requireNode(id);
      break;
    case "canvas_run_generation":
      requireNode(input.nodeId);
      for (const id of referenceNodeIds) requireNode(id);
      break;
    case "canvas_set_generation_references":
      requireNode(input.nodeId);
      for (const id of referenceNodeIds) requireNode(id);
      break;
    case "canvas_create_image_prompt_flow":
    case "canvas_create_generation_flow":
    case "canvas_generate_text":
    case "canvas_generate_image":
    case "canvas_generate_video":
    case "canvas_generate_audio":
      for (const id of referenceNodeIds) requireNode(id);
      break;
  }

  if (!missingNodeIds.size) return;
  const nodes = nodesOf(project);
  const summaries = nodes.slice(0, 100).map(nodeSummary);
  const preflight = {
    project: projectSummary(project as CanvasProject),
    missingNodeIds: [...missingNodeIds],
    nodes: summaries,
    referenceCandidates: summaries.filter((node) => node.type !== "config"),
    truncated: nodes.length > summaries.length,
  };
  const firstMissingNodeId = [...missingNodeIds][0];
  throw Object.assign(
    new Error(`当前画布状态已变化，找不到节点：${firstMissingNodeId}；请先调用 canvas_inspect 后重新组织操作`),
    {
      code: "NODE_NOT_FOUND",
      projectId: String(project.id || ""),
      nodeId: firstMissingNodeId,
      preflight,
    },
  );
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

/** canvas_get_state 默认只回节点摘要：真实画布的整幅节点 metadata 实测 3.3 MB（≈80 万 token），
 *  直接进模型上下文会挤爆窗口，也会撞上 0.5 MiB 输出上限（旧实现直接报 OUTPUT_TOO_LARGE）。
 *  需要某个节点的完整 metadata 时显式传 nodeIds；导出整图请用 canvas_export_snapshot。 */
function compactProjectSummary(project: Record<string, unknown>, input: Record<string, unknown>) {
  const nodes = nodesOf(project);
  const wanted = Array.isArray(input.nodeIds) ? new Set(input.nodeIds.map(String)) : null;
  const selected = wanted ? nodes.filter((node) => wanted.has(String(node.id))) : nodes;
  const summaries = wanted ? selected : selected.slice(0, 200).map(nodeSummary);
  return {
    ...projectSummary(project as unknown as CanvasProject),
    nodes: summaries,
    connections: connectionsOf(project),
    totalNodes: nodes.length,
    truncated: wanted ? false : selected.length > summaries.length,
    hint: '需要某节点的完整 metadata 时传 nodeIds: ["<id>"]；节点级细节也可用 canvas_inspect，导出整图用 canvas_export_snapshot',
  };
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

/** MCP 工具返回体硬上限（字节）。超过即报错，避免单次调用把模型上下文挤爆：
 *  实测 canvas_get_state 单次可返回 2.2M 字符（≈55 万 tokens），而 0.5 MiB 约合 13 万 tokens 的上限。
 *  可用环境变量 MCP_MAX_TOOL_OUTPUT_BYTES 覆盖；设为 0 表示关闭该保护。 */
const MAX_TOOL_OUTPUT_BYTES = (() => {
  const raw = Number(process.env.MCP_MAX_TOOL_OUTPUT_BYTES);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 512 * 1024;
})();

class McpPayloadOverflowError extends Error {
  readonly code = "OUTPUT_TOO_LARGE";
  readonly bytes: number;
  readonly chars: number;
  readonly limitBytes: number;
  constructor(bytes: number, chars: number, limitBytes: number, tool: string) {
    super(
      `工具 ${tool} 的返回体为 ${bytes} 字节（${chars} 字符），超过单次输出上限 ${limitBytes} 字节。请缩小查询范围后重试（例如指定 nodeIds、更小的 limit，或改用摘要型工具）。`,
    );
    this.name = "McpPayloadOverflowError";
    this.bytes = bytes;
    this.chars = chars;
    this.limitBytes = limitBytes;
  }
}

/** 测量返回体的 UTF-8 字节数与字符数（字节口径与线上传输一致）。无法序列化时返回 0（不拦截）。 */
function measureToolResultSize(result: unknown): { bytes: number; chars: number } {
  try {
    const text = JSON.stringify(result);
    return typeof text === "string"
      ? { bytes: Buffer.byteLength(text, "utf8"), chars: text.length }
      : { bytes: 0, chars: 0 };
  } catch {
    return { bytes: 0, chars: 0 };
  }
}

/** 成功返回体超过上限即抛错；调用方位于 try 内，会被统一记为 tool.failed/OUTPUT_TOO_LARGE。 */
function enforceToolOutputLimit(tool: string, payload: unknown) {
  if (MAX_TOOL_OUTPUT_BYTES <= 0) return;
  const { bytes, chars } = measureToolResultSize(payload);
  if (bytes > MAX_TOOL_OUTPUT_BYTES) throw new McpPayloadOverflowError(bytes, chars, MAX_TOOL_OUTPUT_BYTES, tool);
}

/** 超限时把「实际多大 / 上限多少」写进 outputSummary，让诊断能显示超了多少。
 *  注意 outputChars 与既有指标口径一致（字符数），字节数另开 outputBytes 字段。 */
function payloadOverflowSummary(error: unknown) {
  if (!(error instanceof McpPayloadOverflowError)) return {};
  return {
    outputBytes: error.bytes,
    outputBytesLimit: error.limitBytes,
    outputChars: error.chars,
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
              requestedTaskId: input.taskId || null,
            },
            errorContext: mcpToolErrorContext(error, input, state).outputSummary,
            suggestedAction,
          },
        ),
      },
    ],
  };
}

function backendErrorInfo(error: unknown) {
  const value = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const status = typeof value.status === "number" ? value.status : undefined;
  const kind = typeof value.kind === "string" ? value.kind : undefined;
  const code = typeof value.code === "string" ? value.code : undefined;
  return { status, kind, code };
}

function inputTaskIds(input: Record<string, unknown>) {
  const ids = Array.isArray(input.taskIds) ? input.taskIds.map(String).filter(Boolean) : [];
  const taskId = typeof input.taskId === "string" ? input.taskId : "";
  return [...new Set(taskId ? [taskId, ...ids] : ids)];
}

function waitTasksAction(taskIds: string[]) {
  const groups = chunkTaskIds(taskIds);
  return {
    tool: "canvas_wait_tasks",
    input: { taskIds: groups[0] || [] },
    ...(groups.length > 1
      ? {
          additionalActions: groups.slice(1).map((group) => ({
            tool: "canvas_wait_tasks",
            input: { taskIds: group },
          })),
        }
      : {}),
  };
}

function chunkTaskIds(taskIds: string[]) {
  const groups: string[][] = [];
  for (let index = 0; index < taskIds.length; index += 32)
    groups.push(taskIds.slice(index, index + 32));
  return groups;
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/([?&](?:token|api[_-]?key|authorization|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 240);
}

function errorTaskIds(error: unknown) {
  const value = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  return Array.isArray(value.taskIds)
    ? [...new Set(value.taskIds.map(String).filter(Boolean))]
    : [];
}

function errorOperationId(error: unknown, input: Record<string, unknown>) {
  const value = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  return optionalText(value.operationId || input.operationId);
}

function mcpToolErrorContext(
  error: unknown,
  input: Record<string, unknown>,
  state: McpSessionState,
): Partial<McpObservabilityEventInput> {
  const backendError = backendErrorInfo(error);
  const taskIds = errorTaskIds(error);
  const operationId = errorOperationId(error, input);
  const value = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const preflight = recordOf(value.preflight);
  const revision = ["revision", "expectedRevision", "actualRevision"]
    .map((key) => [key, value[key] as unknown] as const)
    .filter(([, item]) => typeof item === "number")
    .reduce<Record<string, number>>((result, [key, item]) => {
      result[key] = item as number;
      return result;
    }, {});
  return {
    projectId: optionalText(value.projectId || input.projectId || state.activeProjectId),
    nodeId: optionalText(value.nodeId || input.nodeId || input.id),
    operationId,
    taskId: optionalText(taskIds[0] || input.taskId),
    outputSummary: {
      errorCode: backendError.code,
      errorKind: backendError.kind,
      httpStatus: backendError.status,
      message: safeErrorMessage(error),
      createdTaskIds: taskIds,
      waitsForTasks: input.waitForCompletion === true || Array.isArray(input.taskIds),
      ...(Object.keys(preflight).length ? { preflight } : {}),
      ...(revision ? { ...revision } : {}),
    },
  };
}

function classifyToolError(
  error: unknown,
  input: Record<string, unknown>,
  state: McpSessionState,
) {
  const backendError = backendErrorInfo(error);
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
    backendError.code === "PROJECT_SELECTION_REQUIRED" ||
    /显式指定 projectId|活动画布|缺少 projectId/.test(message);
  const missingProject =
    backendError.code === "PROJECT_NOT_FOUND" || /画布不存在|project not found/i.test(message);
  const missingTask =
    backendError.code === "TASK_NOT_FOUND" ||
    (backendError.status === 404 && /task|任务/i.test(message)) ||
    /生成任务不存在|任务不存在|task not found/i.test(message);
  const missingNode =
    backendError.code === "NODE_NOT_FOUND" ||
    /(?:节点|node|生成目标).*(?:不存在|not found)|找不到(?:画布)?节点/i.test(
      message,
    );
  const missingModel =
    backendError.code === "MODEL_REQUIRED" ||
    (/模型/.test(message) && /未配置|没有配置|缺少/.test(message));
  const conflict =
    backendError.code === "REVISION_CONFLICT" || /revision|冲突|基线/.test(message);
  const invalidInput = error instanceof z.ZodError;
  const authFailure = backendError.status === 401 || backendError.status === 403;
  const timeout = backendError.kind === "timeout";
  const networkFailure = backendError.kind === "network";
  const invalidResponse = backendError.kind === "invalid_response";
  const payloadOverflow = error instanceof McpPayloadOverflowError;
  const code = payloadOverflow
    ? "OUTPUT_TOO_LARGE"
    : selectionRequired
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
                : authFailure
                  ? `BACKEND_HTTP_${backendError.status}`
                  : timeout
                    ? "BACKEND_TIMEOUT"
                    : networkFailure
                      ? "BACKEND_NETWORK_ERROR"
                      : invalidResponse
                        ? "BACKEND_INVALID_RESPONSE"
                        : backendError.status && backendError.status >= 500
                          ? `BACKEND_HTTP_${backendError.status}`
                          : "CANVAS_TOOL_FAILED";
  const taskIds = inputTaskIds(input);
  const projectId = String(input.projectId || state.activeProjectId || "");
  const suggestedAction = payloadOverflow
    ? {
        action:
          "缩小返回体后重试：为查询类工具传更小的 limit / nodeIds，或用 canvas_inspect 代替整图快照工具。",
      }
    : selectionRequired
    ? { tool: "canvas_list_projects", input: {} }
    : missingProject
      ? { tool: "canvas_list_projects", input: {} }
      : missingTask && projectId
        ? { tool: "canvas_task_status", input: { projectId } }
    : missingNode || conflict
      ? {
          tool: "canvas_inspect",
          input: {
            projectId: String(input.projectId || state.activeProjectId || "") || undefined,
          },
        }
      : missingModel
        ? { tool: "models_list", input: {} }
        : timeout && taskIds.length
          ? waitTasksAction(taskIds)
          : authFailure
            ? { action: "检查 Backend 地址、Token 和权限后再重试" }
            : { action: "检查 errorContext 后修正输入或连接；不要重复提交完全相同的失败请求" };
  const recoverable = selectionRequired || missingProject || missingTask || missingNode || missingModel || conflict || timeout || payloadOverflow;
  return {
    code,
    message,
    recoverable,
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
    if ((BACKEND_CANVAS_TOOLS as readonly string[]).includes(name))
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
          const error = Object.assign(
            new Error(String(errorRecord.message || valueRecord.error || "MCP 工具执行失败")),
            {
              code: typeof errorRecord.code === "string" ? errorRecord.code : undefined,
              status: typeof errorRecord.httpStatus === "number" ? errorRecord.httpStatus : undefined,
              kind: typeof errorRecord.errorKind === "string" ? errorRecord.errorKind : undefined,
            },
          );
          const details = classifyToolError(error, input, state);
          const errorContext = mcpToolErrorContext(error, input, state);
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
            ...errorContext,
            outputSummary: {
              ...recordOf(errorContext.outputSummary),
              errorCode: optionalText(errorRecord.code) || details.code,
              ...payloadOverflowSummary(error),
            },
          });
        } else {
          // 成功返回体也受硬上限约束：超限直接抛错，由下面 catch 记为 tool.failed/OUTPUT_TOO_LARGE。
          enforceToolOutputLimit(name, result);
          await recordMcpObservabilityEvent(recordEvent, {
            sessionId: state.clientId,
            traceId,
            event: "tool.succeeded",
            tool: name,
            durationMs: Date.now() - startedAt,
            inputSummary,
            ...mcpToolResultContext(value, input, state, name),
          });
        }
        return withTraceIdInToolResult(result, traceId);
      } catch (error) {
        const details = classifyToolError(error, input, state);
        const errorContext = mcpToolErrorContext(error, input, state);
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
          ...errorContext,
          outputSummary: {
            ...recordOf(errorContext.outputSummary),
            errorCode: details.code,
            ...payloadOverflowSummary(error),
          },
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
        text: JSON.stringify(withTraceId(value, traceId)),
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
    inputChars: serializedChars(input),
    hasProjectId: Boolean(input.projectId),
    hasNodeId: Boolean(input.nodeId || input.id),
    hasTaskId: Boolean(input.taskId),
    hasOperationId: Boolean(input.operationId),
    expectedRevision: typeof input.expectedRevision === "number" ? input.expectedRevision : undefined,
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
  tool?: string,
): Partial<McpObservabilityEventInput> {
  const result = recordOf(value);
  const tasks = Array.isArray(result.directTasks)
    ? result.directTasks.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  const firstTask = tasks[0] || {};
  const createdTaskIds = [...new Set([
    ...tasks.map((task) => String(task.taskId || "")).filter(Boolean),
    ...(typeof result.taskId === "string" ? [result.taskId] : []),
  ])];
  const operationResults = Array.isArray(result.operationResults)
    ? result.operationResults
    : [];
  const timings = Object.fromEntries(Object.entries(recordOf(result.timings)).filter(([key, value]) => /^(projectReadMs|compileMs|applyMs|promptBuildMs|queueMs|modelRunMs|archiveMs|elapsedMs)$/.test(key) && typeof value === "number" && Number.isFinite(value)));
  return {
    projectId: optionalText(result.projectId || input.projectId || state.activeProjectId),
    nodeId: optionalText(firstTask.nodeId || result.nodeId || input.nodeId || input.id),
    operationId: optionalText(result.operationId),
    taskId: optionalText(firstTask.taskId || result.taskId),
    outputSummary: {
      ok: result.ok !== false,
      outputChars: serializedChars(value),
      taskCount: createdTaskIds.length || (result.taskId ? 1 : 0),
      createdTaskIds,
      waitsForTasks: tool === "canvas_wait_tasks" || Boolean(result.wait) || input.waitForCompletion === true,
      operationCount: operationResults.length,
      returnedNodeCount: Array.isArray(result.nodes) ? result.nodes.length : undefined,
      ready: typeof result.ready === "boolean" ? result.ready : undefined,
      ...(Object.keys(timings).length ? { timings } : {}),
      ...(typeof result.elapsedMs === "number" ? { elapsedMs: result.elapsedMs } : {}),
      ...(typeof result.pollCount === "number" ? { pollCount: result.pollCount } : {}),
      ...(typeof result.eventCount === "number" ? { eventCount: result.eventCount } : {}),
      ...(typeof result.waitMode === "string" ? { waitMode: result.waitMode } : {}),
    },
  };
}

function serializedChars(value: unknown) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
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
function registerAgentSessionCompatibilityTools(
  server: McpServer,
  config: ReturnType<typeof loadConfig>,
) {
  const registeredTools =
    (server as unknown as { _registeredTools?: Record<string, unknown> })
      ._registeredTools || {};
  for (const name of toolNames.filter(
    (item) => !BACKEND_OWNED_TOOL_NAMES.has(item) && !item.startsWith("h3_"),
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
