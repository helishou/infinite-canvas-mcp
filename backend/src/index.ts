#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { DATA_DIR, loadConfig, saveConfig, ensureDataDirs } from "./config.js";
import { BackendDatabase } from "./db.js";
import { registerBackendErrorHandler, startServer } from "./server.js";
import { createLogger } from "./logger.js";
import { createStores } from "./stores/index.js";
import { ComfyUiBackend } from "./comfyui/bridge.js";
import { registerComfyRoutes } from "./server/comfy-routes.js";
import { BackendEventBus } from "./events.js";
import { createBackendRuntimeContext } from "./runtime/context.js";
import { RunningHubBackend } from "./runtime/runninghub.js";
import { VideoConcatBackend } from "./runtime/video-concat.js";
import { registerAgentRuntimeRoutes } from "./server/agent-runtime-routes.js";
import { createAgentRuntime } from "@basketikun/canvas-agent/runtime/agent-runtime";
import { WorkflowStore } from "./workflows/store.js";
import { WorkflowExecutor } from "./workflows/executor.js";
import { WorkflowModelCatalog } from "./workflows/model-catalog.js";
import { registerWorkflowRoutes } from "./workflows/routes.js";
import { registerBackendMcpHttpRoutes, startBackendMcpServer } from "./mcp.js";
import { DirectImageBackend } from "./runtime/chatgpt-image.js";
import { CanvasImageDispatcher } from "./canvas/image-dispatcher.js";
import { registerCanvasGenerationRoutes } from "./server/canvas-generation-routes.js";
import { writeBackH3Task } from "./canvas/h3-task-writeback.js";
import { CanvasH3Runner } from "./canvas/h3-runner.js";
import { CanvasGenerationService } from "./canvas/generation-service.js";
import { CanvasTextDispatcher } from "./canvas/text-dispatcher.js";
import { CanvasVideoDispatcher } from "./canvas/video-dispatcher.js";
import { DirectVideoBackend } from "./runtime/direct-video.js";
import { DirectAudioBackend } from "./runtime/direct-audio.js";
import { CanvasAudioDispatcher } from "./canvas/audio-dispatcher.js";
import { CANVAS_BROWSER_TASK_KIND, CanvasBrowserScriptDispatcher } from "./canvas/browser-script-dispatcher.js";
import { registerCanvasBrowserScriptRoutes } from "./server/browser-script-routes.js";
import { acquireBackendInstanceLock } from "./instance-lock.js";
import { CanvasReferenceService } from "./canvas/reference-service.js";
import { registerCanvasReferenceRoutes } from "./server/canvas-reference-routes.js";
import { CanvasRealtimeHub } from "./canvas/realtime-hub.js";
import {
  applyNetworkSettings,
  NETWORK_SETTINGS_KEY,
} from "./server/connection-routes.js";

const logger = createLogger("main");

if (process.argv[2] === "mcp") {
  await startBackendMcpServer();
} else {
  await startBackendHttpServer();
}

async function startBackendHttpServer() {
  const config = loadConfig(true);
  saveConfig(config);
  ensureDataDirs();
  const releaseInstanceLock = acquireBackendInstanceLock(DATA_DIR);

  const db = new BackendDatabase();
  const stores = createStores(db);
  applyNetworkSettings(config, stores.settings.get(NETWORK_SETTINGS_KEY));
  const events = new BackendEventBus();
  const writeBackStandaloneH3Task = async (
    task: import("./db.js").RuntimeTask,
  ) => {
    if (task.params?.parentTaskId) return;
    await writeBackH3Task(stores, events, task);
  };
  const comfy = new ComfyUiBackend({
    tasks: stores.tasks,
    settings: stores.settings,
    media: stores.media,
    events,
    onTaskTerminal: writeBackStandaloneH3Task,
  });
  const runtime = createBackendRuntimeContext({ db, stores, comfy, events });
  const runningHub = new RunningHubBackend(
    runtime.tasks,
    runtime.stores.settings,
    runtime.events,
    runtime.media,
    writeBackStandaloneH3Task,
  );
  const canvasH3Runner = new CanvasH3Runner(
    runtime.stores,
    runtime.events,
    runtime.comfy,
    runningHub,
  );
  const videoConcat = new VideoConcatBackend(
    runtime.tasks,
    undefined,
    runtime.events,
    runtime.media,
  );

  // Workflow import routes
  const workflowStore = new WorkflowStore(db);
  const workflowModels = new WorkflowModelCatalog(
    workflowStore,
    stores.settings,
  );
  await workflowModels.syncStoredConfig();
  const workflowExecutor = new WorkflowExecutor(
    runtime.comfy,
    runtime.stores.tasks,
    runtime.stores.media,
    runtime.events,
    db,
  );
  const directImage = new DirectImageBackend(
    runtime.stores.tasks,
    runtime.stores.media,
  );
  const canvasImageDispatcher = new CanvasImageDispatcher(
    config,
    runtime.stores,
    runtime.comfy,
    directImage,
    workflowStore,
    workflowExecutor,
    runtime.events,
  );
  const canvasTextDispatcher = new CanvasTextDispatcher(config, runtime.stores);
  const directVideo = new DirectVideoBackend(config, runtime.stores.settings, runtime.stores.tasks, runtime.stores.media);
  const canvasVideoDispatcher = new CanvasVideoDispatcher(runtime.stores, runtime.comfy, workflowStore, workflowExecutor, videoConcat, directVideo);
  const directAudio = new DirectAudioBackend(config, runtime.stores.settings, runtime.stores.tasks, runtime.stores.media);
  const canvasAudioDispatcher = new CanvasAudioDispatcher(runtime.stores, directAudio);
  const canvasBrowserScriptDispatcher = new CanvasBrowserScriptDispatcher(runtime.stores, runtime.events, canvasTextDispatcher);
  const canvasGeneration = new CanvasGenerationService(
    canvasImageDispatcher,
    canvasH3Runner,
    runtime.stores,
    runtime.events,
    runtime.comfy,
    runningHub,
    canvasTextDispatcher,
    canvasVideoDispatcher,
    canvasAudioDispatcher,
    canvasBrowserScriptDispatcher,
  );
  const canvasReferences = new CanvasReferenceService(runtime.stores);
  const { app } = startServer(runtime.db, config, {
    comfy: runtime.comfy,
    events: runtime.events,
    stores: runtime.stores,
    cancelTask: (task) => {
      if (task.kind === "canvas-image")
        return canvasImageDispatcher.cancel(task.id);
      if (task.kind === "canvas-text")
        return canvasTextDispatcher.cancel(task.id);
      if (task.kind === "canvas-video")
        return canvasVideoDispatcher.cancel(task.id);
      if (task.kind === "canvas-audio")
        return canvasAudioDispatcher.cancel(task.id);
      if (task.kind === CANVAS_BROWSER_TASK_KIND)
        return canvasBrowserScriptDispatcher.cancel(task.id);
      if (task.kind === "canvas-h3-run") return canvasH3Runner.cancel(task.id);
      if (task.kind.startsWith("comfyui:"))
        return runtime.comfy.cancel(task.id);
      if (task.kind === "runninghub:minimax-h3")
        return runningHub.cancel(task.id);
      if (task.kind === "video-concat") return videoConcat.cancel(task.id);
      if (task.kind === "direct-video") return directVideo.cancel(task.id);
      if (task.kind === "direct-audio") return directAudio.cancel(task.id);
      if (task.kind === "workflow") return workflowExecutor.cancel(task.id);
      if (task.kind.startsWith("image:")) return directImage.cancel(task.id);
      throw new Error(`任务类型 ${task.kind} 没有注册取消执行器`);
    },
    retryTask: async (task) => {
      if (task.kind === "canvas-image")
        return canvasImageDispatcher.retry(task);
      if (task.kind === "canvas-text") return canvasTextDispatcher.retry(task);
      if (task.kind === "canvas-video") return canvasVideoDispatcher.retry(task);
      if (task.kind === "canvas-audio") return canvasAudioDispatcher.retry(task);
      if (task.kind === CANVAS_BROWSER_TASK_KIND) return canvasBrowserScriptDispatcher.retry(task);
      const clientTaskId = `retry-${crypto.randomUUID()}`;
      const params = { ...task.params, parentTaskId: task.id };
      if (task.kind.startsWith("comfyui:"))
        return runtime.comfy.run(
          task.kind.slice("comfyui:".length),
          task.input,
          params,
          undefined,
          clientTaskId,
        );
      if (task.kind === "runninghub:minimax-h3")
        return runningHub.run(task.input, params, clientTaskId);
      if (task.kind === "direct-video") return directVideo.retry(task);
      if (task.kind === "direct-audio") return directAudio.retry(task);
      throw new Error(`任务类型 ${task.kind} 没有注册重试执行器`);
    },
    prepareAiConfig: async (value) =>
      (await workflowModels.syncConfig(value)).config,
  });
  registerComfyRoutes(
    { app, stores: runtime.stores, config, events: runtime.events },
    runtime.comfy,
  );
  registerWorkflowRoutes(
    app,
    workflowStore,
    workflowExecutor,
    runtime.comfy,
    async (name) => {
      const result = await workflowModels.exposeImportedWorkflow(name);
      if (result.changed)
        runtime.events.publish({
          type: "settings.updated",
          entityId: "ai.config",
          payload: { synced: true },
        });
    },
    (name) => {
      if (workflowModels.detachDeletedWorkflow(name))
        runtime.events.publish({
          type: "settings.updated",
          entityId: "ai.config",
          payload: { synced: true },
        });
    },
  );
  registerCanvasGenerationRoutes(app, canvasGeneration);
  registerCanvasBrowserScriptRoutes(app, canvasBrowserScriptDispatcher);
  registerCanvasReferenceRoutes(app, canvasReferences);
  registerAgentRuntimeRoutes(
    app,
    runtime.stores,
    runningHub,
    videoConcat,
    runtime.events,
  );
  registerComfyRoutes(
    {
      app,
      stores: runtime.stores,
      config,
      events: runtime.events,
      basePath: "/agent",
    },
    runtime.comfy,
  );
  const agent = createAgentRuntime({
    backendUrl: config.url,
    backendToken: config.token,
  });
  runtime.agent = agent;
  app.use("/agent", agent.app);
  const canvasRealtime = new CanvasRealtimeHub(config, db, events);
  const mcpHttp = registerBackendMcpHttpRoutes(
    app,
    config,
    stores.mcpObservability,
    () => canvasRealtime.focusedProjectId(),
  );
  // Backend 重启后继续观察已提交但尚未结束的 ComfyUI 任务；绑定信息在 SQLite 中。
  // 注意：stores.tasks.list() 默认按 created_at DESC LIMIT 500，仅含最近任务；
  // 老任务（含孤儿）会被截断，必须用 status 过滤才能覆盖全部 running/queued。
  for (const task of [
    ...stores.tasks.list({ status: "running" }),
    ...stores.tasks.list({ status: "queued" }),
  ]) {
    if (
      ["queued", "running"].includes(task.status) &&
      task.kind === "canvas-image"
    )
      canvasImageDispatcher.resume(task);
    if (
      ["queued", "running"].includes(task.status) &&
      task.kind === "canvas-text"
    )
      canvasTextDispatcher.resume(task);
    if (
      ["queued", "running"].includes(task.status) &&
      task.kind === "canvas-video"
    )
      canvasVideoDispatcher.resume(task);
    if (
      ["queued", "running"].includes(task.status) &&
      task.kind === "canvas-audio"
    )
      canvasAudioDispatcher.resume(task);
    if (task.kind === CANVAS_BROWSER_TASK_KIND && task.status === "running")
      canvasBrowserScriptDispatcher.resume(task);
    if (
      ["queued", "running"].includes(task.status) &&
      task.kind === "direct-video"
    )
      directVideo.resume(task.id);
    if (
      ["queued", "running"].includes(task.status) &&
      task.kind === "direct-audio"
    )
      directAudio.resume(task.id);
    if (
      ["queued", "running"].includes(task.status) &&
      task.kind === "canvas-h3-run"
    )
      canvasH3Runner.resume(task);
    if (
      ["succeeded", "failed", "cancelled"].includes(task.status) &&
      task.kind === "canvas-h3-run"
    ) {
      void canvasH3Runner
        .reconcileTerminal(task)
        .catch((error) =>
          logger.warn("H3 终态节点回写修复失败", {
            taskId: task.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }
    if (
      ["succeeded", "failed", "cancelled"].includes(task.status) &&
      (task.kind === "comfyui:minimax-h3" ||
        task.kind === "runninghub:minimax-h3")
    ) {
      const binding = task.params?.canvasBinding as
        | { generationLogId?: string }
        | undefined;
      const log = binding?.generationLogId
        ? stores.logs.get(binding.generationLogId)
        : null;
      if (log && (log.status === "queued" || log.status === "running")) {
        void writeBackH3Task(stores, runtime.events, task).catch((error) =>
          logger.warn("H3 子任务终态日志修复失败", {
            taskId: task.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    if (
      ["queued", "running"].includes(task.status) &&
      task.kind.startsWith("comfyui:")
    )
      runtime.comfy.resume(task.id);
      if (
        ["queued", "running"].includes(task.status) &&
        task.kind === "runninghub:minimax-h3"
      )
        runningHub.resume(task.id);
  }
  // ── 孤儿任务回收（防僵尸堆积）───────────────────────────────────
  // backend 重启（tsx --watch 源码热更、崩溃等）会杀掉内存中的执行循环，遗留
  // status=running/queued 的任务永远无人跟踪。上面的 resume 循环只恢复了
  // 特定类型、且确实提交到 ComfyUI（有 promptId）的任务；其余（如 workflow 类型、
  // 有处理器但从未提交的 comfyui 任务、无恢复处理器的画布任务）是僵尸任务，
  // 会在列表里无限堆积。此处（尚未监听端口、不会有新任务）统一置为 failed。
  for (const task of [
    ...stores.tasks.list({ status: "running" }),
    ...stores.tasks.list({ status: "queued" }),
  ]) {
    if (task.status !== "queued" && task.status !== "running") continue;
    const hasHandler =
      task.kind === "canvas-image" ||
      task.kind === "canvas-text" ||
      task.kind === "canvas-video" ||
      task.kind === "canvas-audio" ||
      task.kind === CANVAS_BROWSER_TASK_KIND ||
      task.kind === "direct-video" ||
      task.kind === "direct-audio" ||
      task.kind === "canvas-h3-run" ||
      task.kind.startsWith("comfyui:") ||
      task.kind === "runninghub:minimax-h3";
    if (!hasHandler) {
      // 无恢复处理器（例如 workflow 类型，启动循环未为其调用 resume）→ 必然僵尸
      stores.tasks.update(task.id, {
        status: "failed",
        error:
          "backend 重启后该任务无活跃执行且无对应恢复处理器，已自动置为失败（孤儿任务回收）",
      });
      stores.tasks.addEvent(task.id, "status", { status: "failed" });
      continue;
    }
    // comfyui / runninghub 类型必须依赖 ComfyUI promptId 才能恢复；没有则说明从未提交，
    // 重启后无法恢复 → 置失败。有 promptId 的已由上面的 resume 循环挂上观察循环，跳过。
    if (task.kind.startsWith("comfyui:") || task.kind === "runninghub:minimax-h3") {
      const promptId = stores.tasks
        .events(task.id)
        .find((e) => e.type === "submitted")?.payload?.promptId;
      const createdTs = task.createdAt ? new Date(task.createdAt).getTime() : 0;
      // 超过 24 小时的 ComfyUI 任务，其 history 早被 ComfyUI 清理，resume 观察必然超时失败，
      // 与其让其挂在 running 里最多 1 小时，不如直接置失败（孤儿任务回收）。
      const tooOld = createdTs > 0 && Date.now() - createdTs > 24 * 60 * 60 * 1000;
      if (typeof promptId !== "string" || !promptId || tooOld) {
        stores.tasks.update(task.id, {
          status: "failed",
          error:
            tooOld && promptId
              ? "backend 重启后该 ComfyUI 任务已超过 24 小时，history 已不可恢复，已自动置为失败（孤儿任务回收）"
              : "backend 重启后该 ComfyUI 任务从未提交到 ComfyUI（无 promptId），已自动置为失败（孤儿任务回收）",
        });
        stores.tasks.addEvent(task.id, "status", { status: "failed" });
      }
    }
    // canvas-*/direct-* 类型：上面的 resume 循环已尝试恢复，此处不再处理
  }
  app.get("/canvas/projects/:id/collaboration", (req, res) => {
    const project = db.getCanvasProject(req.params.id);
    if (!project)
      return void res.status(404).json({ ok: false, error: "画布不存在" });
    res.json({
      ok: true,
      projectId: project.id,
      revision: Number(project.revision || 0),
      participants: canvasRealtime.participants(project.id),
    });
  });
  registerBackendErrorHandler(app);
  const server = app.listen(
    config.port,
    config.listenHost || "127.0.0.1",
    () => {
      logger.info(`总后台已启动 ${config.url}`, {
        listenHost: config.listenHost || "127.0.0.1",
        pid: process.pid,
        version: readVersion(),
      });
    },
  );
  canvasRealtime.attach(server);

  // ── 连接泄漏/僵尸连接防护 ────────────────────────────────────────────
  // 浏览器（Edge 等）频繁开关连接时，若 server 不主动释放半关闭 socket，
  // 会堆积 CLOSE_WAIT 直至 fd 耗尽拖垮进程（“老是挂掉”的根因之一）。
  // 收紧超时，让僵尸/慢连接尽快被回收。
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  server.requestTimeout = 120_000;
  try {
    (server as unknown as { timeout: number }).timeout = 120_000;
  } catch {
    /* 部分 Node 版本只读 */
  }

  // ── 进程级异常兜底 ───────────────────────────────────────────────────
  // 单点异常（如 SSE 断连后的 EPIPE、媒体读取错误）不应直接杀掉进程；
  // 记录日志后继续运行，配合 tsx --watch 的热重载更稳健。
  process.on("uncaughtException", (error) =>
    logger.error("uncaughtException", {
      message: error.message,
      stack: error.stack,
    }),
  );
  process.on("unhandledRejection", (reason) =>
    logger.error("unhandledRejection", { reason: String(reason) }),
  );

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down…`);
    releaseInstanceLock();
    canvasRealtime.close();
    void mcpHttp.closeAll().finally(() =>
      server.close(() => {
        db.close();
        process.exit(0);
      }),
    );
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // tsx --watch 默认用 SIGINT 重启：Express 5 异步关闭、可能不触发 SIGINT 监听器，
  // 补一个 beforeExit 走同样收尾，避免每次热重载都卡到 10s 兜底才退。
  process.on("beforeExit", () => {
    db.close();
  });

  function readVersion() {
    try {
      const pkgPath = path.join(
        import.meta.dirname || ".",
        "..",
        "package.json",
      );
      return String(
        JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || "0.0.0",
      );
    } catch {
      return "0.0.0";
    }
  }
}
