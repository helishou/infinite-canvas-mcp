import express, {
  type NextFunction,
  type Request,
  type Response,
  type Express,
} from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  type ResolvedConfig,
  DATA_DIR,
  ensureDataDirs,
  loadRootConfig,
  saveRootConfig,
  loadFrontendSettings,
  type FrontendSettings,
} from "./config.js";
import type {
  Asset,
  AssetFolder,
  CanvasFolder,
  CanvasProject,
  GenerationLog,
  GenerationLogStatus,
  RuntimeTask,
  RuntimeTaskStatus,
} from "./db.js";
import type { ComfyUiBackend } from "./comfyui/bridge.js";
import { createLogger } from "./logger.js";
import { createStores } from "./stores/index.js";
import type {
  GenerationLogInput,
  LogDeleteScope,
  Stores,
} from "./stores/types.js";
import { BackendEventBus, type CanvasEventSource } from "./events.js";
import type { CanvasOperation } from "./canvas/project-ops.js";
import { diagnoseCanvasProject } from "./canvas/project-diagnostics.js";
import {
  detectLineInset,
  type DetectLineInsetParams,
} from "./canvas/image-split-detect.js";
import {
  CANVAS_TASKS_PATH,
  CANVAS_TASK_ROUTE,
  canvasTaskActionRoute,
} from "@basketikun/canvas-agent/generation-api";
import {
  isLocalConnection,
  registerConnectionRoutes,
} from "./server/connection-routes.js";
import { CanvasDraftSessionLeases } from "./canvas/draft-session-leases.js";
import { registerMcpObservabilityRoutes } from "./server/mcp-observability-routes.js";

const logger = createLogger("backend");

/** startServer 的可选依赖（comfy 路由由 index.ts 单独挂载）。 */
export type ServerDeps = {
  comfy?: ComfyUiBackend;
  events?: BackendEventBus;
  stores?: Stores;
  cancelTask?: (task: RuntimeTask) => RuntimeTask;
  retryTask?: (task: RuntimeTask) => RuntimeTask | Promise<RuntimeTask>;
  prepareAiConfig?: (config: unknown) => unknown | Promise<unknown>;
};

/** 启动总后台 HTTP 服务，返回 Express app（listen 由 index.ts 负责）。 */
export function startServer(
  db: Parameters<typeof createStores>[0],
  config: ResolvedConfig,
  deps: ServerDeps = {},
) {
  const stores: Stores = deps.stores ?? createStores(db);
  const events = deps.events ?? new BackendEventBus();
  db.onCanvasCommit((commit) =>
    events.publishCanvasDelta({
      entityId: commit.projectId,
      revision: commit.revision,
      operations: commit.operations,
      operationResults: commit.operationResults,
      updatedAt: commit.updatedAt,
      operationId: commit.operationId,
      source: commit.source as CanvasEventSource,
    }),
  );
  const app = express();
  const draftSessionLeases = new CanvasDraftSessionLeases();
  const FRONTEND_SETTINGS_KEY = "frontend.settings";
  const STRUCTURED_SETTING_KEYS = new Map([
    ["webdav", "webdav.config"],
    ["prompt-sources", "prompt.sources"],
    ["custom-prompts", "prompts.custom"],
    ["image-workbench-references", "image-workbench.references"],
  ]);
  if (stores.settings.get(FRONTEND_SETTINGS_KEY) === undefined) {
    const legacy = loadFrontendSettings();
    if (Object.keys(legacy).length)
      stores.settings.set(FRONTEND_SETTINGS_KEY, legacy);
  }
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100mb" }));

  // ── CORS ─────────────────────────────────────────────────────────────
  // Allow-Headers 走 reflect 模式：把预检请求里的
  // Access-Control-Request-Headers 原样回给 Access-Control-Allow-Headers。
  // 这样新加自定义 header（x-media-* 之类）不用每次都改这里。
  // 注意：reflect 模式要求 Allow-Origin 是 echo（不能 *），
  // 且 Allow-Credentials 必须是 true。
  const CORS_ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
  // reflect 之外保留一组明确白名单（防止浏览器没发 Request-Headers
  // 时，比如简单 GET 请求没有预检，Allow-Headers 还是空）。
  const CORS_ALLOWED_HEADERS_DEFAULT =
    "Content-Type, Authorization, x-media-name, x-media-width, x-media-height, x-media-duration-ms, x-media-category";
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origins = config.origins ?? [];
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin)) {
      res.status(403).json({ ok: false, error: "origin not allowed" });
      return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS);
    // 预检请求：reflect 客户端请求的 header；非预检：给默认白名单
    const requestHeaders = req.headers["access-control-request-headers"];
    res.setHeader(
      "Access-Control-Allow-Headers",
      typeof requestHeaders === "string" && requestHeaders
        ? requestHeaders
        : CORS_ALLOWED_HEADERS_DEFAULT,
    );
    // OPTIONS 预检请求直接返回，不进入后续 middleware（auth 等会拦截）。
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // ── Token 鉴权（/health 和 /config 免鉴权） ────────────────────────
  app.use((req: Request, res: Response, next: NextFunction) => {
    const url = req.url!.split("?")[0];
    if (url === "/health" || url === "/config") return next();
    // 只读媒体端点免 token：浏览器来源已由上方 CORS 白名单限制，且媒体 URL 内嵌的
    // token 会在 backend 重启后失效，豁免后可避免历史产物在 token 轮换后 401 而“消失”。
    // 仅豁免 GET 读取类端点，写入类（如 POST /runtime/media）仍受 token 保护。
    if (
      url === "/media" ||
      url.startsWith("/media/") ||
      url.startsWith("/runtime/media-file")
    )
      return next();
    const token =
      (req.query.token as string | undefined) ||
      req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token !== config.token) {
      return void res.status(401).json({ ok: false, error: "invalid token" });
    }
    next();
  });

  // ── 请求日志 ─────────────────────────────────────────────────────────
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      if (req.method === "OPTIONS" || res.statusCode < 400) return;
      // 查询参数可能携带 Backend token；日志只记录路由路径，禁止把凭据写进终端或日志文件。
      logger.warn(`${req.method} ${req.path}`, {
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });

  // ── 公共路由 ─────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      protocolVersion: 1,
      node: process.version,
      pid: process.pid,
    });
  });
  app.get("/config", (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (
      (config.listenHost === "0.0.0.0" || !isLocalConnection(req)) &&
      token !== config.token
    )
      return void res
        .status(401)
        .json({
          ok: false,
          error: "远端或局域网开放模式请手动提供后台密钥",
          hasToken: true,
        });
    res.json({
      ok: true,
      protocolVersion: 1,
      url: config.url,
      token: config.token,
      hasToken: true,
    });
  });
  registerConnectionRoutes(app, config, stores.settings);
  app.post("/canvas/draft-sessions/:owner/acquire", (req, res) => {
    const owner = String(req.params.owner || "").trim();
    const holderId =
      typeof req.body?.holderId === "string" ? req.body.holderId.trim() : "";
    if (!owner || !holderId)
      return void res
        .status(400)
        .json({ ok: false, error: "owner 和 holderId 必填" });
    const lease = draftSessionLeases.acquire(owner, holderId);
    if (!lease.owned)
      return void res.status(409).json({
        ok: false,
        code: "DRAFT_SESSION_LEASE_HELD",
        error: "这份草稿仍由另一窗口使用",
        lease,
      });
    res.json({ ok: true, lease });
  });
  app.get("/canvas/draft-sessions/:owner/lease", (req, res) => {
    const owner = String(req.params.owner || "").trim();
    const holderId =
      typeof req.query.holderId === "string" ? req.query.holderId.trim() : "";
    if (!owner)
      return void res.status(400).json({ ok: false, error: "owner 必填" });
    res.json({
      ok: true,
      lease: draftSessionLeases.status(owner, holderId || undefined),
    });
  });
  app.post("/canvas/draft-sessions/:owner/release", (req, res) => {
    const owner = String(req.params.owner || "").trim();
    const holderId =
      typeof req.body?.holderId === "string" ? req.body.holderId.trim() : "";
    if (!owner || !holderId)
      return void res
        .status(400)
        .json({ ok: false, error: "owner 和 holderId 必填" });
    res.json({
      ok: true,
      released: draftSessionLeases.release(owner, holderId),
    });
  });
  app.get("/data-dir", (_req, res) => {
    const root = loadRootConfig();
    res.json({
      ok: true,
      dataDir: DATA_DIR,
      configuredDataDir: root.dataDir || null,
    });
  });
  app.post("/data-dir", (req, res) => {
    const { dataDir } = req.body as { dataDir?: string };
    if (dataDir !== undefined) {
      if (!path.isAbsolute(dataDir))
        return void res
          .status(400)
          .json({ ok: false, error: "dataDir 必须是绝对路径" });
      const root = loadRootConfig();
      root.dataDir = dataDir.trim() || undefined;
      saveRootConfig(root);
      // 重新解析 DATA_DIR（动态更新运行时的路径常量）。
      // 注意：已有数据文件仍在旧目录，新路径在 backend 重启后生效。
      // 如需迁移数据，需手动移动文件并更新路径。
    }
    const root = loadRootConfig();
    res.json({
      ok: true,
      dataDir: DATA_DIR,
      configuredDataDir: root.dataDir || null,
    });
  });
  // ── Frontend settings ───────────────────────────────────────────────
  app.get("/settings", (_req, res) => {
    res.json({
      ok: true,
      settings: stores.settings.get(FRONTEND_SETTINGS_KEY) || {},
    });
  });
  app.patch("/settings", (req, res) => {
    const patch = req.body as Partial<FrontendSettings>;
    if (!patch || typeof patch !== "object") {
      return void res
        .status(400)
        .json({ ok: false, error: "请求体必须是对象" });
    }
    const current = stores.settings.get(FRONTEND_SETTINGS_KEY);
    const settings = {
      ...(current && typeof current === "object" && !Array.isArray(current)
        ? current
        : {}),
      ...patch,
    };
    stores.settings.set(FRONTEND_SETTINGS_KEY, settings);
    events.publish({
      type: "settings.updated",
      entityId: FRONTEND_SETTINGS_KEY,
      payload: { synced: true },
    });
    res.json({ ok: true, settings });
  });
  app.get("/settings/data/:scope", (req, res) => {
    const key = STRUCTURED_SETTING_KEYS.get(String(req.params.scope || ""));
    if (!key)
      return void res.status(404).json({ ok: false, error: "未知设置域" });
    res.json({ ok: true, value: stores.settings.get(key) ?? null });
  });
  app.put("/settings/data/:scope", (req, res) => {
    const key = STRUCTURED_SETTING_KEYS.get(String(req.params.scope || ""));
    if (!key)
      return void res.status(404).json({ ok: false, error: "未知设置域" });
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "value"))
      return void res.status(400).json({ ok: false, error: "value 必填" });
    stores.settings.set(key, req.body.value);
    events.publish({
      type: "settings.updated",
      entityId: key,
      payload: { synced: true },
    });
    res.json({ ok: true, value: req.body.value });
  });
  const AI_CONFIG_KEY = "ai.config";
  app.get("/settings/ai-config", (_req, res) => {
    res.json({ ok: true, config: stores.settings.get(AI_CONFIG_KEY) || null });
  });
  app.put("/settings/ai-config", async (req, res) => {
    let config = req.body?.config;
    if (!config || typeof config !== "object" || Array.isArray(config))
      return void res
        .status(400)
        .json({ ok: false, error: "AI 配置必须是对象" });
    if (deps.prepareAiConfig) config = await deps.prepareAiConfig(config);
    stores.settings.set(AI_CONFIG_KEY, config);
    events.publish({
      type: "settings.updated",
      entityId: AI_CONFIG_KEY,
      payload: { synced: true },
    });
    res.json({ ok: true });
  });

  // H3 默认参数是 Backend 权威设置；浏览器 localStorage 只用于一次性迁移。
  const H3_DEFAULTS_KEY = "plugin:minimax-h3:defaults:v1";
  app.get("/plugins/minimax-h3/defaults", (_req, res) => {
    res.json({
      ok: true,
      defaults: stores.settings.get(H3_DEFAULTS_KEY) || null,
    });
  });
  app.put("/plugins/minimax-h3/defaults", (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
      return void res
        .status(400)
        .json({ ok: false, error: "defaults 必须是对象" });
    const settings = { ...(req.body as Record<string, unknown>) };
    if (settings.videoSteps === undefined && settings.steps !== undefined)
      settings.videoSteps = settings.steps;
    delete settings.steps;
    // layout 是「设为默认参数」随参数保存的布局快照（节点宽高 + 各模块宽高）。
    // 调用方不发 layout（例如 MCP 保存生成参数）时保留上一次的快照，避免顺手把布局清掉。
    if (settings.layout === undefined) {
      const previous = stores.settings.get(H3_DEFAULTS_KEY) as { layout?: unknown } | null;
      if (previous && typeof previous === "object" && previous.layout !== undefined)
        settings.layout = previous.layout;
    }
    stores.settings.set(H3_DEFAULTS_KEY, settings);
    events.publish({
      type: "settings.updated",
      entityId: H3_DEFAULTS_KEY,
      payload: settings,
    });
    res.json({ ok: true, defaults: settings });
  });
  app.delete("/plugins/minimax-h3/defaults", (_req, res) => {
    stores.settings.delete(H3_DEFAULTS_KEY);
    events.publish({
      type: "settings.updated",
      entityId: H3_DEFAULTS_KEY,
      payload: null,
    });
    res.json({ ok: true, defaults: null });
  });

  // ── Runtime status ────────────────────────────────────────────────
  app.get("/runtime/status", async (_req, res) => {
    const extra: Record<string, unknown> = {
      sqlite: true,
      node: process.version,
    };
    if (deps.comfy) extra.comfyui = await deps.comfy.status();
    res.json({ ok: true, ...extra });
  });
  app.get("/events", (req, res) => {
    res
      .status(200)
      .set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
    res.flushHeaders();
    let closed = false;
    const write = (event: import("./events.js").BackendEvent) => {
      if (closed) return;
      // 客户端（浏览器）断连后写已关闭的 socket 会抛 EPIPE，吞掉以免崩进程。
      try {
        res.write(
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      } catch {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      }
    };
    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);
    const unsubscribe = events.subscribe(write);
    const replay = events.replay(
      req.get("Last-Event-ID") ||
        (typeof req.query.cursor === "string" ? req.query.cursor : undefined),
    );
    if (!replay.reset) replay.events.forEach(write);
    res.write(
      `id: ${replay.cursor}\nevent: events.sync\ndata: ${JSON.stringify({ cursor: replay.cursor, reset: replay.reset })}\n\n`,
    );
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    res.on("error", cleanup);
  });

  // ── Canvas projects ──────────────────────────────────────────────────
  app.get("/canvas/projects", (req, res) => {
    // v7: 画布表无 folder_id 列，过滤改用 ?episodeId=xxx；不传 = 返回全部。
    // 旧的 ?folderId=xxx 参数已废弃，前端通过 /drama 页面用 episodeId 过滤即可。
    const episodeIdParam = req.query.episodeId;
    let filter: { episodeId?: string; id?: string } | undefined;
    if (typeof episodeIdParam === "string" && episodeIdParam) {
      filter = { episodeId: episodeIdParam };
    } else if (typeof req.query.id === "string" && req.query.id) {
      filter = { id: req.query.id };
    }
    const useSummary = req.query.summary === "true";
    const projects = useSummary
      ? filter
        ? db.listCanvasProjectSummaries(filter)
        : db.listCanvasProjectSummaries()
      : filter?.episodeId
        ? db.listCanvasProjectsByEpisode(filter.episodeId)
        : stores.projects.list();
    res.json({ ok: true, projects });
  });
  app.get("/canvas/projects/:id", (req, res) => {
    const project =
      req.query.summary === "true"
        ? db.listCanvasProjectSummaries({ id: req.params.id })[0]
        : db.getCanvasProject(req.params.id);
    if (!project)
      return void res.status(404).json({ ok: false, error: "画布不存在" });
    res.json({ ok: true, project });
  });
  app.get("/canvas/projects/:id/drama", (req, res) => {
    if (!db.getCanvasProject(req.params.id))
      return void res.status(404).json({ ok: false, error: "画布不存在" });
    const episode = db.getDramaEpisodeByCanvasId(req.params.id);
    const drama = episode
      ? stores.canvasFolders.list().find((item) => item.id === episode.dramaId) || null
      : null;
    res.json({ ok: true, projectId: req.params.id, episode, drama });
  });
  app.get("/canvas/projects/:id/changes", (req, res) => {
    try {
      res.json({
        ok: true,
        ...db.readCanvasChanges(req.params.id, Number(req.query.afterRevision)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res
        .status(message.startsWith("画布不存在:") ? 404 : 400)
        .json({ ok: false, error: message });
    }
  });
  app.get("/canvas/projects/:id/text", (req, res) => {
    try {
      res.json({
        ok: true,
        ...db.getCanvasText(req.params.id, {
          field: req.query.field,
          nodeId: req.query.nodeId,
          segmentId: req.query.segmentId,
          textItemId: req.query.textItemId,
        }),
      });
    } catch (error) {
      res
        .status(400)
        .json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });
  app.get("/canvas/projects/:id/text-suggestions", (req, res) => {
    try {
      res.json({
        ok: true,
        suggestions: db.listCanvasTextSuggestions(
          req.params.id,
          req.query.field
            ? {
                field: req.query.field,
                nodeId: req.query.nodeId,
                segmentId: req.query.segmentId,
                textItemId: req.query.textItemId,
              }
            : undefined,
        ),
      });
    } catch (error) {
      res
        .status(400)
        .json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });
  app.put("/canvas/projects", (_req, res) => {
    res
      .status(410)
      .json({
        ok: false,
        code: "SNAPSHOT_WRITE_REMOVED",
        error:
          "已停用整批画布覆盖；新建使用 POST /canvas/projects，已有画布使用 /canvas/projects/:id/ops",
      });
  });
  app.post("/canvas/projects", (req, res) => {
    const project = req.body as CanvasProject;
    if (!project?.id)
      return void res.status(400).json({ ok: false, error: "project.id 必填" });
    try {
      const result = stores.projects.create(project);
      if (result.created)
        events.publishCanvasSnapshot({
          entityId: result.project.id,
          revision: 0,
          payload: result.project,
        });
      res.status(result.created ? 201 : 200).json({ ok: true, ...result });
    } catch (error) {
      const value = error as Error & {
        code?: string;
        project?: CanvasProject;
        revision?: number;
      };
      res
        .status(value.code === "PROJECT_EXISTS" ? 409 : 400)
        .json({
          ok: false,
          code: value.code,
          error: value.message,
          project: value.project,
          revision: value.revision,
        });
    }
  });
  app.post("/canvas/projects/:id/ops", (req, res) => {
    const expectedRevision =
      req.body?.expectedRevision === undefined
        ? undefined
        : Number(req.body.expectedRevision);
    const operations = Array.isArray(req.body?.operations)
      ? (req.body.operations as CanvasOperation[])
      : [];
    const operationId = String(req.body?.operationId || crypto.randomUUID());
    const source = canvasEventSource(req.body?.source);
    if (!operations.length)
      return void res
        .status(400)
        .json({ ok: false, error: "operations 不能为空" });
    try {
      const result = db.applyCanvasProjectOperations(
        req.params.id,
        expectedRevision,
        operations,
        {
          operationId,
          source,
          ...(req.body?.baseRevision !== undefined
            ? { baseRevision: Number(req.body.baseRevision) }
            : {}),
        },
      );
      res.json({
        ok: true,
        projectId: result.project.id,
        revision: result.revision,
        operationId,
        duplicated: result.duplicated,
        operationResults: result.operationResults,
        operations: result.operations,
        ...(req.query.response === "delta"
          ? { updatedAt: result.project.updatedAt }
          : { project: result.project }),
      });
    } catch (error) {
      const value = error as Error & {
        code?: string;
        project?: CanvasProject;
        revision?: number;
        conflictTargets?: string[];
      };
      if (
        [
          "REVISION_CONFLICT",
          "FIELD_CONFLICT",
          "OPERATION_ID_REUSED",
          "RECEIPT_UNAVAILABLE",
          "TEXT_DOCUMENT_REPLACED",
          "TEXT_CONFLICT",
          "TEXT_SUGGESTION_RESOLVED",
        ].includes(value.code || "")
      )
        return void res
          .status(409)
          .json({
            ok: false,
            code: value.code,
            error: value.message,
            projectId: req.params.id,
            revision: value.revision,
            project: value.project,
            conflictTargets: value.conflictTargets,
          });
      if (value.message.startsWith("画布不存在:"))
        return void res.status(404).json({ ok: false, error: value.message });
      logger.warn("画布增量操作被拒绝", {
        projectId: req.params.id,
        expectedRevision,
        error: value.message || String(error),
        operations: operations.map((operation) => ({
          type: String(operation?.type || ""),
          id: String(
            operation?.id || operation?.nodeId || operation?.assetId || "",
          ),
          segmentId: String(operation?.segmentId || ""),
        })),
      });
      res
        .status(400)
        .json({ ok: false, error: value.message || String(error) });
    }
  });
  app.delete("/canvas/projects/:id", (req, res) => {
    const deleted = stores.projects.delete(req.params.id);
    events.publishCanvasSnapshot({
      entityId: req.params.id,
      payload: { deleted },
    });
    res.json({ ok: true, deleted });
  });
  // ── H3 节点历史运行产物（按需取，替代 metadata.materials 字段）──
  app.get("/canvas/projects/:id/nodes/:nodeId/materials", (req, res) => {
    const projectId = req.params.id;
    const nodeId = req.params.nodeId;
    if (!stores.projects.get(projectId))
      return void res
        .status(404)
        .json({ ok: false, error: `画布不存在: ${projectId}` });
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    const segmentId =
      typeof req.query.segmentId === "string" ? req.query.segmentId : undefined;
    const materials = stores.projects.getH3NodeMaterials(
      projectId,
      nodeId,
      limit,
      segmentId,
    );
    res.json({ ok: true, projectId, nodeId, materials });
  });
  app.get("/canvas/folders", (_req, res) => {
    res.json({ ok: true, folders: stores.canvasFolders.list() });
  });
  app.post("/canvas/folders", (req, res) => {
    const folder = req.body as CanvasFolder;
    if (!folder?.id)
      return void res.status(400).json({ ok: false, error: "folder.id 必填" });
    const result = stores.canvasFolders.upsert(folder);
    events.publishCanvasFolder({ entityId: result.id, payload: result });
    res.status(201).json({ ok: true, folder: result });
  });
  app.delete("/canvas/folders/:id", (req, res) => {
    const dramaId = String(req.params.id || "");
    if (db.isDramaProject(dramaId))
      return void res.status(409).json({ ok: false, error: "这是短剧项目，请在短剧制作台中删除" });
    const deleted = stores.canvasFolders.delete(dramaId);
    events.publishCanvasFolder({
      entityId: dramaId,
      payload: { deleted },
    });
    res.json({ ok: true, deleted });
  });
  app.delete("/drama/projects/:dramaId", (req, res) => {
    const dramaId = String(req.params.dramaId || "");
    if (!db.isDramaProject(dramaId))
      return void res.status(404).json({ ok: false, error: "剧目不存在" });
    for (const asset of stores.assets.list({ kind: "drama-file", dramaId })) {
      const storageKey = typeof asset.data.storageKey === "string" ? asset.data.storageKey : "";
      stores.assets.delete(asset.id);
      if (storageKey) stores.media.delete(storageKey);
    }
    const deleted = stores.canvasFolders.deleteDrama(dramaId);
    events.publishCanvasFolder({ entityId: dramaId, payload: { deleted } });
    res.json({ ok: true, deleted });
  });
  // ── Drama episodes：剧目 → 分集 → 画布 ───────────────────────────────
  app.get("/drama/projects/:dramaId/episodes", (req, res) => {
    const dramaId = String(req.params.dramaId || "");
    const drama = stores.canvasFolders
      .list()
      .find((item) => item.id === dramaId);
    if (!drama)
      return void res.status(404).json({ ok: false, error: "剧目不存在" });
    const episodes = db.listDramaEpisodes(dramaId);
    res.json({ ok: true, dramaId, episodes });
  });
  // 剧目级自定义资产：LUT、字体、参考文档、压缩包等任意二进制文件。
  app.get("/drama/projects/:dramaId/assets", (req, res) => {
    const dramaId = String(req.params.dramaId || "");
    const drama = stores.canvasFolders.list().find((item) => item.id === dramaId);
    if (!drama)
      return void res.status(404).json({ ok: false, error: "剧目不存在" });
    const assets = stores.assets.list({ kind: "drama-file", dramaId });
    res.json({ ok: true, dramaId, assets });
  });
  app.post(
    "/drama/projects/:dramaId/assets",
    express.raw({ type: "*/*", limit: "100mb" }),
    (req, res) => {
      const dramaId = String(req.params.dramaId || "");
      const drama = stores.canvasFolders.list().find((item) => item.id === dramaId);
      if (!drama)
        return void res.status(404).json({ ok: false, error: "剧目不存在" });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!body.length)
        return void res.status(400).json({ ok: false, error: "资产文件为空" });
      const encodedName = String(req.headers["x-asset-name"] || "asset.bin");
      let fileName = "asset.bin";
      try { fileName = path.basename(decodeURIComponent(encodedName)) || "asset.bin"; }
      catch { return void res.status(400).json({ ok: false, error: "资产文件名无效" }); }
      const mimeType = String(req.headers["content-type"] || "application/octet-stream").split(";", 1)[0];
      let media: ReturnType<Stores["media"]["store"]> | null = null;
      try {
        media = stores.media.store(body, { name: fileName, mimeType, category: "library" });
        const now = new Date().toISOString();
        const asset = stores.assets.upsert({
          id: `drama-file-${crypto.randomUUID()}`,
          kind: "drama-file",
          title: fileName,
          coverUrl: "",
          tags: [],
          folderId: null,
          dramaId,
          data: { dramaId, storageKey: media.storageKey, fileName, mimeType: media.mimeType, bytes: media.bytes },
          note: null,
          source: "drama-upload",
          metadata: { extension: path.extname(fileName).toLowerCase() },
          createdAt: now,
          updatedAt: now,
        });
        events.publish({ type: "asset.updated", entityId: asset.id, payload: asset });
        res.status(201).json({ ok: true, asset });
      } catch (error) {
        if (media) stores.media.delete(media.storageKey);
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  );
  app.delete("/drama/projects/:dramaId/assets/:assetId", (req, res) => {
    const dramaId = String(req.params.dramaId || "");
    const asset = stores.assets.get(String(req.params.assetId || ""));
    if (!asset || asset.kind !== "drama-file" || asset.dramaId !== dramaId)
      return void res.status(404).json({ ok: false, error: "剧目资产不存在" });
    const storageKey = typeof asset.data.storageKey === "string" ? asset.data.storageKey : "";
    const deleted = stores.assets.delete(asset.id);
    if (storageKey) stores.media.delete(storageKey);
    events.publish({ type: "asset.updated", entityId: asset.id, payload: { deleted } });
    res.json({ ok: true, deleted });
  });
  app.post("/drama/projects/:dramaId/episodes", (req, res) => {
    const dramaId = String(req.params.dramaId || "");
    const drama = stores.canvasFolders
      .list()
      .find((item) => item.id === dramaId);
    if (!drama)
      return void res.status(404).json({ ok: false, error: "剧目不存在" });
    const body = req.body as {
      id?: unknown;
      episodeNumber?: unknown;
      title?: unknown;
      synopsis?: unknown;
      fullPlot?: unknown;
      canvasId?: unknown;
    };
    const episodeNumber = Number(body.episodeNumber);
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1)
      return void res
        .status(400)
        .json({ ok: false, error: "episodeNumber 必须是大于等于 1 的整数" });
    const title = String(body.title ?? `第 ${episodeNumber} 集`).trim();
    const synopsis = String(body.synopsis ?? "");
    const fullPlot = String(body.fullPlot ?? "");
    const canvasId =
      body.canvasId === undefined ||
      body.canvasId === null ||
      body.canvasId === ""
        ? null
        : String(body.canvasId);
    if (canvasId && !db.getCanvasProject(canvasId))
      return void res
        .status(404)
        .json({ ok: false, error: "绑定的画布不存在" });
    const canvasOwner = canvasId
      ? db.getDramaEpisodeByCanvasId(canvasId)
      : null;
    if (canvasOwner)
      return void res
        .status(409)
        .json({ ok: false, error: `画布已绑定到分集: ${canvasOwner.id}` });
    if (db.getDramaEpisodeByNumber(dramaId, episodeNumber))
      return void res
        .status(409)
        .json({
          ok: false,
          error: `分集编号已存在: ${dramaId}/${episodeNumber}`,
        });
    try {
      const episode = db.upsertDramaEpisode({
        id: typeof body.id === "string" ? body.id : undefined,
        dramaId,
        episodeNumber,
        title,
        synopsis,
        fullPlot,
        canvasId,
      });
      events.publish({
        type: "drama-episode.updated",
        entityId: episode.id,
        payload: episode,
      });
      res.status(201).json({ ok: true, episode });
    } catch (error) {
      res
        .status(409)
        .json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });
  app.get("/drama/episodes/:episodeId", (req, res) => {
    const episode = db.getDramaEpisode(req.params.episodeId);
    if (!episode)
      return void res.status(404).json({ ok: false, error: "分集不存在" });
    res.json({
      ok: true,
      episode,
      canvas: episode.canvasId ? db.getCanvasProject(episode.canvasId) : null,
    });
  });
  app.patch("/drama/episodes/:episodeId", (req, res) => {
    const body = req.body as {
      episodeNumber?: unknown;
      title?: unknown;
      synopsis?: unknown;
      fullPlot?: unknown;
      canvasId?: unknown;
    };
    const patch: {
      episodeNumber?: number;
      title?: string;
      synopsis?: string;
      fullPlot?: string;
      canvasId?: string | null;
    } = {};
    if (body.episodeNumber !== undefined) {
      const value = Number(body.episodeNumber);
      if (!Number.isInteger(value) || value < 1)
        return void res
          .status(400)
          .json({ ok: false, error: "episodeNumber 必须是大于等于 1 的整数" });
      patch.episodeNumber = value;
    }
    if (body.title !== undefined) patch.title = String(body.title).trim();
    if (body.synopsis !== undefined) patch.synopsis = String(body.synopsis);
    if (body.fullPlot !== undefined) patch.fullPlot = String(body.fullPlot);
    if (body.canvasId !== undefined)
      patch.canvasId =
        body.canvasId === null || body.canvasId === ""
          ? null
          : String(body.canvasId);
    if (patch.canvasId && !db.getCanvasProject(patch.canvasId))
      return void res
        .status(404)
        .json({ ok: false, error: "绑定的画布不存在" });
    try {
      const episode = db.updateDramaEpisode(req.params.episodeId, patch);
      if (!episode)
        return void res.status(404).json({ ok: false, error: "分集不存在" });
      events.publish({
        type: "drama-episode.updated",
        entityId: episode.id,
        payload: episode,
      });
      res.json({
        ok: true,
        episode,
        canvas: episode.canvasId ? db.getCanvasProject(episode.canvasId) : null,
      });
    } catch (error) {
      res
        .status(409)
        .json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });
  app.delete("/drama/episodes/:episodeId", (req, res) => {
    const deleted = db.deleteDramaEpisode(req.params.episodeId);
    if (deleted)
      events.publish({
        type: "drama-episode.updated",
        entityId: req.params.episodeId,
        payload: { deleted },
      });
    res.json({ ok: true, deleted });
  });
  // ── Image split: auto-detect 切分线宽度 ───────────────────────────────
  app.post("/canvas/image-split/detect-line-inset", async (req, res) => {
    const body = req.body as {
      dataUrl?: string;
      rows?: number;
      columns?: number;
      horizontalLines?: number[];
      verticalLines?: number[];
    };
    if (!body.dataUrl)
      return void res
        .status(400)
        .json({ ok: false, error: "需要提供 dataUrl" });
    if (typeof body.rows !== "number" || typeof body.columns !== "number") {
      return void res
        .status(400)
        .json({ ok: false, error: "rows / columns 必填" });
    }
    const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(
      String(body.dataUrl),
    );
    if (!match)
      return void res
        .status(400)
        .json({ ok: false, error: "dataUrl 必须是 base64 data URL" });
    const buffer = Buffer.from(match[1], "base64");
    const params: DetectLineInsetParams = {
      rows: Math.max(1, Math.floor(body.rows)),
      columns: Math.max(1, Math.floor(body.columns)),
      horizontalLines: Array.isArray(body.horizontalLines)
        ? body.horizontalLines
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n))
        : undefined,
      verticalLines: Array.isArray(body.verticalLines)
        ? body.verticalLines
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n))
        : undefined,
    };
    try {
      const result = await detectLineInset(buffer, params);
      res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ ok: false, error: message });
    }
  });
  app.get("/canvas/projects/:id/diagnostics", (req, res) => {
    const project = stores.projects.get(req.params.id);
    if (!project)
      return void res
        .status(404)
        .json({ ok: false, error: `画布不存在: ${req.params.id}` });
    res.json({
      ok: true,
      projectId: project.id,
      revision: Number(project.revision || 0),
      issues: diagnoseCanvasProject(project, stores),
    });
  });

  // ── Assets ───────────────────────────────────────────────────────────
  app.get("/canvas/assets", (req, res) => {
    const kind = req.query.kind as string | undefined;
    const folderId = req.query.folderId as string | undefined;
    const dramaId = req.query.dramaId as string | undefined;
    res.json({
      ok: true,
      assets: stores.assets.list({ kind, folderId, dramaId }),
      folders: stores.assets.folders(),
    });
  });
  app.put("/canvas/assets", (req, res) => {
    const body = req.body as { assets?: Asset[]; folders?: AssetFolder[] };
    const assets = Array.isArray(body.assets)
      ? body.assets.filter(
          (a): a is Asset =>
            a && typeof a === "object" && !Array.isArray(a) && !!a.id,
        )
      : [];
    const folders = Array.isArray(body.folders)
      ? body.folders.filter(
          (f): f is AssetFolder =>
            f && typeof f === "object" && !Array.isArray(f) && !!f.id,
        )
      : [];
    stores.assets.replaceAll(assets, folders);
    const result = {
      assets: stores.assets.list(),
      folders: stores.assets.folders(),
    };
    events.publish({ type: "asset.updated", payload: result });
    res.json({ ok: true, ...result });
  });
  app.post("/canvas/assets", (req, res) => {
    const asset = req.body as Asset;
    if (!asset?.id)
      return void res.status(400).json({ ok: false, error: "asset.id 必填" });
    const result = stores.assets.upsert(asset);
    events.publish({
      type: "asset.updated",
      entityId: result.id,
      payload: result,
    });
    res.status(201).json({ ok: true, asset: result });
  });
  app.patch("/canvas/assets/:id", (req, res) => {
    const current = stores.assets.get(req.params.id);
    if (!current)
      return void res.status(404).json({ ok: false, error: "asset not found" });
    const next = {
      ...current,
      ...(req.body as Partial<Asset>),
      id: current.id,
      updatedAt: new Date().toISOString(),
    };
    const result = stores.assets.upsert(next);
    events.publish({
      type: "asset.updated",
      entityId: result.id,
      payload: result,
    });
    res.json({ ok: true, asset: result });
  });
  app.delete("/canvas/assets/:id", (req, res) => {
    const deleted = stores.assets.delete(req.params.id);
    events.publish({
      type: "asset.updated",
      entityId: req.params.id,
      payload: { deleted },
    });
    res.json({ ok: true, deleted });
  });

  // ── Asset folders ────────────────────────────────────────────────────
  app.post("/canvas/assets/folders", (req, res) => {
    const folder = req.body as AssetFolder;
    if (!folder?.id)
      return void res.status(400).json({ ok: false, error: "folder.id 必填" });
    const result = stores.assets.upsertFolder(folder);
    events.publish({
      type: "asset.updated",
      entityId: result.id,
      payload: result,
    });
    res.status(201).json({ ok: true, folder: result });
  });
  app.delete("/canvas/assets/folders/:id", (req, res) => {
    const deleted = stores.assets.deleteFolder(req.params.id);
    events.publish({
      type: "asset.updated",
      entityId: req.params.id,
      payload: { deleted },
    });
    res.json({ ok: true, deleted });
  });

  // ── Media ────────────────────────────────────────────────────────────
  /** 上传媒体（JSON 兼容入口；新代码优先使用 /media/upload-binary） */
  app.post("/media/upload", (req, res) => {
    const body = req.body as {
      name?: string;
      dataUrl?: string;
      storageKey?: string;
      width?: number;
      height?: number;
      durationMs?: number;
      category?: "input" | "output" | "library";
    };
    if (!body.dataUrl)
      return void res
        .status(400)
        .json({ ok: false, error: "需要提供 dataUrl（base64 data URL）" });
    try {
      const media = stores.media.storeDataUrl(
        String(body.dataUrl),
        body.name || "media.bin",
        {
          storageKey: body.storageKey,
          category: body.category,
          width: body.width ?? null,
          height: body.height ?? null,
          durationMs: body.durationMs ?? null,
        },
      );
      res.status(201).json({
        ok: true,
        media: {
          storageKey: media.storageKey,
          url: stores.media.url(media),
          mimeType: media.mimeType,
          bytes: media.bytes,
          width: media.width,
          height: media.height,
          durationMs: media.durationMs,
        },
      });
    } catch (error) {
      res
        .status(400)
        .json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  /** 上传媒体二进制，避免工作流和本地素材在浏览器与后台之间转 base64。 */
  app.post(
    "/media/upload-binary",
    express.raw({ type: "*/*", limit: "100mb" }),
    (req, res) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const encodedName = String(req.headers["x-media-name"] || "media.bin");
      const name = decodeURIComponent(encodedName);
      const mimeType = String(
        req.headers["content-type"] || "application/octet-stream",
      ).split(";", 1)[0];
      const categoryHeader = String(req.headers["x-media-category"] || "input");
      const category =
        categoryHeader === "output" || categoryHeader === "library"
          ? categoryHeader
          : "input";
      const storageKeyHeader = String(
        req.headers["x-media-storage-key"] || "",
      ).trim();
      if (!body.length)
        return void res.status(400).json({ ok: false, error: "媒体内容为空" });
      try {
        const media = stores.media.store(body, {
          name,
          mimeType,
          category,
          storageKey: storageKeyHeader || undefined,
          width: Number(req.headers["x-media-width"]) || null,
          height: Number(req.headers["x-media-height"]) || null,
          durationMs: Number(req.headers["x-media-duration-ms"]) || null,
        });
        res
          .status(201)
          .json({
            ok: true,
            media: {
              storageKey: media.storageKey,
              url: stores.media.url(media),
              mimeType: media.mimeType,
              bytes: media.bytes,
              width: media.width,
              height: media.height,
              durationMs: media.durationMs,
            },
          });
      } catch (error) {
        res
          .status(400)
          .json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    },
  );

  /** 代理读取媒体文件。视频必须支持 Range，浏览器才能按需缓冲和 seek，避免整段读入内存后播放卡顿。 */
  app.get("/media/:storageKey", async (req, res) => {
    const storageKey = decodeURIComponent(req.params.storageKey);
    const media = stores.media.meta(storageKey);
    if (!media)
      return void res.status(404).json({ ok: false, error: "media not found" });
    try {
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("Content-Type", media.mimeType);
      res.setHeader("Accept-Ranges", "bytes");
      const bytes = fs.statSync(media.filePath).size;
      const range = req.headers.range;
      if (!range) {
        res.setHeader("Content-Length", String(bytes));
        fs.createReadStream(media.filePath).pipe(res);
        return;
      }
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) {
        res.setHeader("Content-Range", `bytes */${bytes}`);
        return void res.status(416).end();
      }
      const suffixLength = match[1] ? 0 : Number(match[2]);
      const start = match[1]
        ? Number(match[1])
        : Math.max(0, bytes - suffixLength);
      const end = match[1]
        ? match[2]
          ? Math.min(Number(match[2]), bytes - 1)
          : bytes - 1
        : bytes - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= bytes ||
        end < start
      ) {
        res.setHeader("Content-Range", `bytes */${bytes}`);
        return void res.status(416).end();
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${bytes}`);
      res.setHeader("Content-Length", String(end - start + 1));
      fs.createReadStream(media.filePath, { start, end }).pipe(res);
    } catch {
      res.status(404).json({ ok: false, error: "媒体文件丢失" });
    }
  });

  /** 删除媒体文件 */
  app.delete("/media/:storageKey", (req, res) => {
    const storageKey = decodeURIComponent(req.params.storageKey);
    if (!stores.media.meta(storageKey))
      return void res.status(404).json({ ok: false, error: "media not found" });
    res.json({ ok: true, deleted: stores.media.delete(storageKey) });
  });

  // ── runtime media（H3 ref 落地 / 兼容旧 Agent /runtime/media*） ──────
  app.post("/runtime/media", (req, res) => {
    const name = String(req.body?.name || "media.bin");
    const dataUrl = String(req.body?.dataUrl || "");
    const storageKey = req.body?.storageKey
      ? String(req.body.storageKey)
      : undefined;
    try {
      // 复用后端已有的媒体：避免把本就在后端的文件再 base64 下载→重传（H3 串 clip 的
      // previousVideo 即此情形——上一段视频后端刚生成完，前端却原路下载回来再传一次，
      // 体积暴涨触发 413）。传 storageKey 时直接返回本地路径，不再解码 dataUrl。
      if (storageKey) {
        const meta = stores.media.meta(decodeURIComponent(storageKey));
        if (!meta)
          return void res
            .status(404)
            .json({ ok: false, error: `media not found: ${storageKey}` });
        return void res.status(201).json({
          ok: true,
          media: {
            id: meta.storageKey,
            path: meta.filePath,
            name: path.basename(name),
            mimeType: meta.mimeType,
            bytes: meta.bytes,
            url: stores.media.url(meta),
          },
        });
      }
      const media = stores.media.storeDataUrl(dataUrl, name);
      res
        .status(201)
        .json({
          ok: true,
          media: {
            id: media.storageKey,
            path: media.path,
            name: path.basename(name),
            mimeType: media.mimeType,
            bytes: media.bytes,
            url: stores.media.url(media),
          },
        });
    } catch (error) {
      res
        .status(400)
        .json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });
  app.get("/runtime/media-file", (req, res) => {
    try {
      const name = String(req.query.name || req.query.file || "");
      const data = stores.media.readNamed(name);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.type("application/octet-stream").send(data);
    } catch (error) {
      res
        .status(400)
        .json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  // ── Generation logs ──────────────────────────────────────────────────
  app.get("/plugins/mcp", (_req, res) => {
    res.json({ ok: true, declarations: db.listPluginDeclarations() });
  });
  app.put("/plugins/mcp", (req, res) => {
    const declarations = Array.isArray(req.body?.declarations)
      ? req.body.declarations
      : [];
    const result = db.replacePluginDeclarations(declarations);
    // 声明是完整快照：卸载/移除的插件必须从权威清单删除；清理放在成功 upsert 后。
    if (result.length)
      db.db
        .prepare(
          `DELETE FROM plugin_declarations WHERE id NOT IN (${result.map(() => "?").join(",")})`,
        )
        .run(...result.map((item) => item.id));
    else db.db.prepare("DELETE FROM plugin_declarations").run();
    events.publish({
      type: "plugin.updated",
      payload: { declarations: result },
    });
    res.json({ ok: true, declarations: result });
  });

  app.get("/plugins/installed", (_req, res) => {
    const plugins = db.getSetting("plugins.installed");
    res.json({ ok: true, plugins: Array.isArray(plugins) ? plugins : [] });
  });
  app.put("/plugins/installed", (req, res) => {
    const plugins = Array.isArray(req.body?.plugins)
      ? req.body.plugins.filter(
          (item: unknown) =>
            item && typeof item === "object" && !Array.isArray(item),
        )
      : [];
    db.setSetting("plugins.installed", plugins);
    res.json({ ok: true, plugins });
  });
  app.get("/plugins/storage", (req, res) => {
    const pluginId = String(req.query.pluginId || "").trim();
    const key = String(req.query.key || "").trim();
    if (!pluginId || !key)
      return void res
        .status(400)
        .json({ ok: false, error: "pluginId 和 key 必填" });
    res.json({
      ok: true,
      value: db.getSetting(`plugin.storage.${pluginId}.${key}`) ?? null,
    });
  });
  app.put("/plugins/storage", (req, res) => {
    const pluginId = String(req.body?.pluginId || "").trim();
    const key = String(req.body?.key || "").trim();
    if (!pluginId || !key)
      return void res
        .status(400)
        .json({ ok: false, error: "pluginId 和 key 必填" });
    db.setSetting(`plugin.storage.${pluginId}.${key}`, req.body?.value);
    res.json({ ok: true });
  });
  app.delete("/plugins/storage", (req, res) => {
    const pluginId = String(req.query.pluginId || "").trim();
    const key = String(req.query.key || "").trim();
    if (!pluginId || !key)
      return void res
        .status(400)
        .json({ ok: false, error: "pluginId 和 key 必填" });
    db.db
      .prepare("DELETE FROM runtime_settings WHERE key = ?")
      .run(`plugin.storage.${pluginId}.${key}`);
    res.json({ ok: true });
  });

  app.get("/prompts/cache", (req, res) => {
    const sourceId = String(req.query.sourceId || "").trim();
    if (!sourceId)
      return void res.status(400).json({ ok: false, error: "sourceId 必填" });
    res.json({
      ok: true,
      cache: db.getSetting(`prompt.cache.${sourceId}`) ?? null,
    });
  });
  app.put("/prompts/cache", (req, res) => {
    const sourceId = String(req.body?.sourceId || "").trim();
    const cache = req.body?.cache;
    if (
      !sourceId ||
      !cache ||
      typeof cache !== "object" ||
      Array.isArray(cache)
    )
      return void res
        .status(400)
        .json({ ok: false, error: "sourceId 和有效 cache 必填" });
    db.setSetting(`prompt.cache.${sourceId}`, cache);
    res.json({ ok: true });
  });

  app.get("/generation-logs", (req, res) => {
    const projectId = req.query.projectId as string | undefined;
    const nodeId = req.query.nodeId as string | undefined;
    const status = [
      "queued",
      "running",
      "success",
      "failed",
      "cancelled",
    ].includes(req.query.status as string)
      ? (req.query.status as GenerationLogStatus)
      : undefined;
    const limit = Number(req.query.limit || 500);
    res.json({
      ok: true,
      logs: stores.logs.list({
        projectId,
        nodeId,
        status,
        limit,
        offset: Number(req.query.offset || 0),
        segmentId:
          typeof req.query.segmentId === "string"
            ? req.query.segmentId
            : undefined,
        runtimeTaskId:
          typeof req.query.runtimeTaskId === "string"
            ? req.query.runtimeTaskId
            : undefined,
        platform:
          typeof req.query.platform === "string"
            ? req.query.platform
            : undefined,
        model:
          typeof req.query.model === "string" ? req.query.model : undefined,
        from: typeof req.query.from === "string" ? req.query.from : undefined,
        to: typeof req.query.to === "string" ? req.query.to : undefined,
      }),
    });
  });
  app.post("/generation-logs", (req, res) => {
    const body = req.body as GenerationLogInput;
    if (!body.projectId || !body.platform || !body.startedAt) {
      return void res
        .status(400)
        .json({ ok: false, error: "projectId、platform、startedAt 为必填项" });
    }
    const log = stores.logs.create(body);
    events.publish({
      type: "generation-log.updated",
      entityId: log.id,
      payload: log,
    });
    res.status(201).json({ ok: true, log });
  });
  app.patch("/generation-logs/:id", (req, res) => {
    try {
      const log = stores.logs.update(req.params.id, req.body);
      events.publish({
        type: "generation-log.updated",
        entityId: log.id,
        payload: log,
      });
      res.json({ ok: true, log });
    } catch (error) {
      res.status(404).json({ ok: false, error: (error as Error).message });
    }
  });
  app.delete("/generation-logs", (req, res) => {
    const options: LogDeleteScope = {};
    if (req.query.id) options.id = String(req.query.id);
    if (req.query.projectId) options.projectId = String(req.query.projectId);
    if (req.query.nodeId) options.nodeId = String(req.query.nodeId);
    if (!options.id && !options.projectId && !options.nodeId) {
      return void res
        .status(400)
        .json({ ok: false, error: "删除日志必须指定范围" });
    }
    res.json({ ok: true, deleted: stores.logs.delete(options) });
  });
  app.delete("/generation-logs/:id", (req, res) => {
    res.json({ ok: true, deleted: stores.logs.delete({ id: req.params.id }) });
  });

  // ── Tasks ────────────────────────────────────────────────────────────
  app.get(CANVAS_TASKS_PATH, (req, res) => {
    const status =
      typeof req.query.status === "string" ? req.query.status : undefined;
    const kind =
      typeof req.query.kind === "string" ? req.query.kind : undefined;
    const model =
      typeof req.query.model === "string" ? req.query.model : undefined;
    const scope = ["all", "canvas", "image", "video"].includes(
      String(req.query.scope),
    )
      ? (String(req.query.scope) as "all" | "canvas" | "image" | "video")
      : undefined;
    const list = (value: unknown) =>
      typeof value === "string"
        ? value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
    const taskId = typeof req.query.taskId === "string" ? req.query.taskId : "";
    const taskIds = list(req.query.taskIds);
    const tasks = taskId
      ? stores.tasks.get(taskId)
        ? [stores.tasks.get(taskId)!]
        : []
      : taskIds.length
        ? taskIds.flatMap((id) => {
            const task = stores.tasks.get(id);
            return task ? [task] : [];
          })
        : stores.tasks.list({
          status: status as RuntimeTaskStatus | undefined,
          kind,
          model,
          scope,
          projectId:
            typeof req.query.projectId === "string"
              ? req.query.projectId
              : undefined,
          nodeIds: list(req.query.nodeIds),
          segmentIds: list(req.query.segmentIds),
          limit: Number(req.query.limit || 500),
          offset: Number(req.query.offset || 0),
        });
    res.json({ ok: true, tasks });
  });
  app.get(CANVAS_TASK_ROUTE, (req, res) => {
    const task = stores.tasks.get(req.params.id);
    if (!task)
      return void res.status(404).json({ ok: false, error: "task not found", code: "TASK_NOT_FOUND" });
    res.json({
      ok: true,
      task,
      events: stores.tasks.events(req.params.id, Number(req.query.after || 0)),
    });
  });
  app.post(CANVAS_TASKS_PATH, (req, res) => {
    const body = req.body as {
      kind?: string;
      clientTaskId?: string;
      input?: Record<string, unknown>;
      params?: Record<string, unknown>;
    };
    if (!body.kind)
      return void res.status(400).json({ ok: false, error: "kind 必填" });
    const task = body.clientTaskId
      ? stores.tasks.create(
          body.clientTaskId,
          body.kind,
          body.input || {},
          body.params || {},
        )
      : stores.tasks.create(body.kind, body.input || {}, body.params || {});
    events.publish({ type: "task.created", entityId: task.id, payload: task });
    res.status(201).json({ ok: true, task });
  });
  app.patch(CANVAS_TASK_ROUTE, (req, res) => {
    const patch = req.body as {
      status?: RuntimeTaskStatus;
      progress?: number;
      result?: Record<string, unknown> | null;
      error?: string | null;
    };
    try {
      const task = stores.tasks.update(req.params.id, patch);
      events.publish({
        type:
          task.status === "succeeded"
            ? "task.completed"
            : task.status === "failed"
              ? "task.failed"
              : "task.updated",
        entityId: task.id,
        payload: task,
      });
      res.json({ ok: true, task });
    } catch (error) {
      res.status(404).json({ ok: false, error: (error as Error).message });
    }
  });
  app.post(canvasTaskActionRoute("cancel"), (req, res) => {
    try {
      const taskId = String(req.params.id);
      const current = stores.tasks.get(taskId);
      if (!current)
        return void res
          .status(404)
          .json({ ok: false, error: "task not found", code: "TASK_NOT_FOUND" });
      const task = deps.cancelTask
        ? deps.cancelTask(current)
        : stores.tasks.cancel(taskId);
      events.publish({
        type: "task.updated",
        entityId: task.id,
        payload: task,
      });
      res.json({ ok: true, task });
    } catch (error) {
      res.status(409).json({ ok: false, error: (error as Error).message });
    }
  });
  app.post(canvasTaskActionRoute("retry"), async (req, res) => {
    try {
      const current = stores.tasks.get(String(req.params.id));
      if (!current)
        return void res
          .status(404)
          .json({ ok: false, error: "task not found", code: "TASK_NOT_FOUND" });
      if (!deps.retryTask)
        return void res
          .status(409)
          .json({
            ok: false,
            error: `任务类型 ${current.kind} 没有注册重试执行器`,
          });
      const task = await deps.retryTask(current);
      events.publish({
        type: "task.created",
        entityId: task.id,
        payload: task,
      });
      res.status(201).json({ ok: true, task, parentTaskId: current.id });
    } catch (error) {
      res
        .status(409)
        .json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  registerMcpObservabilityRoutes(app, stores.mcpObservability);
  registerBackendErrorHandler(app);

  return { app: app as Express, stores, events };
}

function canvasEventSource(value: unknown): CanvasEventSource {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const allowedKinds = new Set<CanvasEventSource["kind"]>([
    "browser",
    "mcp",
    "agent",
    "task",
    "system",
  ]);
  const kind = allowedKinds.has(source.kind as CanvasEventSource["kind"])
    ? (source.kind as CanvasEventSource["kind"])
    : "system";
  return {
    clientId: String(source.clientId || `${kind}:anonymous`).slice(0, 128),
    kind,
    ...(source.label ? { label: String(source.label).slice(0, 80) } : {}),
  };
}

/** 在调用方挂载额外路由后再次安装，确保挂载路由也返回统一 JSON 错误。 */
export function registerBackendErrorHandler(app: Express) {
  type HttpError = Error & { status?: number };
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as HttpError).status || 500;
    logger.error(error.message, { stack: error.stack });
    res.status(status).json({ ok: false, error: error.message });
  });
}
