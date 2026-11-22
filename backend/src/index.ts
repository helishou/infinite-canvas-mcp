#!/usr/bin/env node
import { DirectorSubagents, registerDirectorSubagentRoutes } from "./drama/director-subagents.js";
import { productionCompilationBusy } from "./drama/compilation.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { DATA_DIR, loadConfig, saveConfig, ensureDataDirs } from "./config.js";
import { BackendDatabase } from "./db.js";
import { registerBackendErrorHandler, setSelectionRealtime, startServer } from "./server.js";
import { createLogger } from "./logger.js";
import { createStores } from "./stores/index.js";
import { registerComfyRoutes } from "./server/comfy-routes.js";
import { BackendEventBus } from "./events.js";
import { createBackendRuntimeContext } from "./runtime/context.js";
import { holdUnknownSubmission, submissionDecision, submissionDiagnostic } from "./engine-contract/submission-outcome.js";
import { VideoConcatBackend } from "./engine-contract/video-concat.js";
import { SubtitleTranscribeBackend } from "./runtime/subtitle-transcribe.js";
import { registerSubtitleTranscribeRoutes } from "./server/subtitle-transcribe-routes.js";
import { registerAudioTranscribeRoutes } from "./server/audio-transcribe-routes.js";
import { registerAgentRuntimeRoutes } from "./server/agent-runtime-routes.js";
import { FinalComposer } from "./drama/final-composer.js";
import { createAgentRuntime } from "@basketikun/canvas-agent/runtime/agent-runtime";
import { HermesAgent, isHermesThread } from "@basketikun/canvas-agent/agent/hermes-agent";
import { ProductionAgentPool } from "@basketikun/canvas-agent/agent/production";
import { engineTargets, probeEngineTarget, WorkflowCatalog } from "./engine-contract/workflow-catalog.js";
import { WorkflowModelCatalog } from "./workflows/model-catalog.js";
import { registerWorkflowRoutes } from "./workflows/routes.js";
import { registerBackendMcpHttpRoutes, startBackendMcpServer } from "./mcp.js";
import { DirectImageBackend } from "./engine-contract/chatgpt-image.js";
import { CanvasImageDispatcher } from "./canvas/image-dispatcher.js";
import { registerCanvasGenerationRoutes } from "./server/canvas-generation-routes.js";
import { registerDramaRestyleRoutes } from "./server/drama-restyle-routes.js";
import { registerDramaAssetRegenerateRoutes } from "./server/drama-asset-regenerate-routes.js";
import { writeBackH3Task } from "./canvas/h3-task-writeback.js";
import { CanvasGenerationService } from "./canvas/generation-service.js";
import { CanvasTextDispatcher } from "./canvas/text-dispatcher.js";
import { CanvasVideoDispatcher } from "./canvas/video-dispatcher.js";
import { DirectVideoBackend } from "./engine-contract/direct-video.js";
import { DirectAudioBackend } from "./engine-contract/direct-audio.js";
import { CanvasAudioDispatcher } from "./canvas/audio-dispatcher.js";
import { CanvasH3Runner } from "./canvas/h3-runner.js";
import { CANVAS_BROWSER_TASK_KIND, CanvasBrowserScriptDispatcher } from "./canvas/browser-script-dispatcher.js";
import { registerCanvasBrowserScriptRoutes } from "./server/browser-script-routes.js";
import { acquireBackendInstanceLock } from "./instance-lock.js";
import { CanvasReferenceService } from "./canvas/reference-service.js";
import { createDevReloadGate } from "./runtime/dev-reload.js";
import { startRuntimeMonitor } from "./engine-contract/slow-operation.js";
import { registerCanvasCollaborationRoutes } from "./server/canvas-collaboration-routes.js";
import { registerCanvasReferenceRoutes } from "./server/canvas-reference-routes.js";
import { EpisodeProductionService } from "./drama/production.js";
import { SharedAssetCoordinator } from "./drama/shared-assets.js";
import { NativeProductionGeneration } from "./drama/native-generation.js";
import { EpisodeProductionRunner } from "./drama/production-runner.js";
import { PipelineStore } from "./drama/pipeline-store.js";
import { DramaPipeline } from "./drama/pipeline.js";
import { resolveOutlineModel } from "./drama/outline-proposal.js";
import { videoCapabilitiesOf } from "./canvas/model-video-capability.js";
import { registerDramaPipelineRoutes } from "./server/drama-pipeline-routes.js";
import { registerDramaProductionRoutes } from "./server/drama-production-routes.js";
import { registerDramaPrerunRoutes } from "./server/drama-prerun-routes.js";
import { registerDramaVideoReprocessRoutes } from "./server/drama-video-reprocess-routes.js";
import { registerDramaPlanningRoutes, registerDramaPlanningStateRoutes, registerDramaScriptRoutes, registerDramaStageRoutes, registerDramaTopicProposalRoute, registerDramaEpisodeGroupingRoutes } from "./server/drama-planning-routes.js";
import { registerDramaSourceChapterRoutes } from "./server/drama-source-chapter-routes.js";
import { registerAssetSpecRoutes } from "./server/asset-spec-routes.js";
import { CanvasRealtimeHub } from "./canvas/realtime-hub.js";
import {
  applyNetworkSettings,
  NETWORK_SETTINGS_KEY,
} from "./server/connection-routes.js";

const logger = createLogger("main");

/**
 * 进程级兜底必须早于任何 await。
 *
 * 之前这两个 handler 注册在 startBackendHttpServer() 的末尾（约 489 行），启动过程中
 * 任何一次 await 失败都会直接以 triggerUncaughtException 结束进程 —— 日志里只剩
 * 一句 `fetch failed / ECONNREFUSED`，连调用栈都留不下（例如指向已停掉的 3900 渠道）。
 *
 * 放到模块最顶部：既留住带 stack/cause 的证据，也不让单点异常顺手带走整个后端。
 */
function describeError(error: unknown): Record<string, unknown> {
    const cause = (error as { cause?: unknown } | null)?.cause;
    const code = (cause as { code?: string } | undefined)?.code;
    return {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        ...(cause ? { cause: `${cause instanceof Error ? cause.message : String(cause)}${code ? ` (${code})` : ""}` } : {}),
    };
}

process.on("uncaughtException", (error) => logger.error("uncaughtException", describeError(error)));
process.on("unhandledRejection", (reason) => logger.error("unhandledRejection", describeError(reason)));

try {
  if (process.argv[2] === "mcp") {
    await startBackendMcpServer();
  } else {
    await startBackendHttpServer();
  }
} catch (error) {
  // 启动阶段失败：把完整栈写进日志再退出，别只留一句 fetch failed 让人猜
  logger.error("boot-failed", describeError(error));
  process.exit(1);
}

async function startBackendHttpServer() {
  const startupTimingsMs: Record<string, number> = { imports: Math.round(performance.now()) };
  let startupStageStarted = performance.now();
  const markStartupStage = (stage: string) => {
    const now = performance.now();
    startupTimingsMs[stage] = Math.round(now - startupStageStarted);
    startupStageStarted = now;
  };
  const config = loadConfig(true);
  saveConfig(config);
  ensureDataDirs();
  const releaseInstanceLock = await acquireBackendInstanceLock(DATA_DIR);
  markStartupStage("configAndLock");

  const db = new BackendDatabase();
  const stores = createStores(db);
  applyNetworkSettings(config, stores.settings.get(NETWORK_SETTINGS_KEY));
  markStartupStage("databaseAndStores");
  const events = new BackendEventBus();
  const writeBackStandaloneH3Task = async (
    task: import("./db.js").RuntimeTask,
  ) => {
    if (task.params?.parentTaskId) return;
    await writeBackH3Task(stores, events, task);
  };
  const runtime = createBackendRuntimeContext({ db, stores, events });

  const videoConcat = new VideoConcatBackend(
    runtime.tasks,
    undefined,
    runtime.events,
    runtime.media,
  );
  const subtitleTranscriber = new SubtitleTranscribeBackend(runtime.tasks, runtime.media, runtime.events);

  // Workflow import routes
  const workflowStore = new WorkflowCatalog(() => engineTargets(runtime.stores.settings.get("ai.config")));
  void workflowStore.refresh().catch(() => {});
  const workflowModels = new WorkflowModelCatalog(
    workflowStore,
    stores.settings,
  );
  await workflowModels.syncStoredConfig().catch((error) => {
    logger.warn("工作流模型目录启动同步失败，稍后自动重试", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  markStartupStage("executorsAndWorkflowCatalog");
  const directImage = new DirectImageBackend(
    runtime.stores.tasks,
    runtime.stores.media,
  );
  // 执行引擎不再是一个全局开关：引擎作为 kind="engine" 的渠道配置，按模型走 /v1/*。
  const canvasImageDispatcher = new CanvasImageDispatcher(
    config,
    runtime.stores,
    directImage,
    workflowStore,
    runtime.events,
  );
  const canvasTextDispatcher = new CanvasTextDispatcher(config, runtime.stores);
  const directVideo = new DirectVideoBackend(config, runtime.stores.settings, runtime.stores.tasks, runtime.stores.media);
  const canvasVideoDispatcher = new CanvasVideoDispatcher(runtime.stores, workflowStore, videoConcat, directVideo);
  const directAudio = new DirectAudioBackend(runtime.stores.settings, runtime.stores.tasks, runtime.stores.media);
  const canvasAudioDispatcher = new CanvasAudioDispatcher(runtime.stores, directAudio);
  const canvasBrowserScriptDispatcher = new CanvasBrowserScriptDispatcher(runtime.stores, runtime.events, canvasTextDispatcher);
  // H3 节点只剩「自选视频模型」链路；具体跑本地还是 RunningHub 由引擎侧工作流参数决定。
  const canvasH3Runner = new CanvasH3Runner(runtime.stores, runtime.events, canvasVideoDispatcher);
  const canvasGeneration = new CanvasGenerationService(
    canvasImageDispatcher,
    runtime.stores,
    runtime.events,
    canvasTextDispatcher,
    canvasVideoDispatcher,
    canvasH3Runner,
    canvasAudioDispatcher,
    canvasBrowserScriptDispatcher,
    runtime.db,
  );
  const canvasReferences = new CanvasReferenceService(runtime.stores, (alert) => logger.warn("疑似参考资产循环写入", alert));
  const devReload = process.env.INFINITE_CANVAS_DEV_WATCH === "1" && process.send ? createDevReloadGate() : null;
  const devActiveTask = devReload ? db.db.prepare("SELECT 1 FROM tasks WHERE status IN ('queued','running','awaiting_confirmation') LIMIT 1") : null;
  const { app, drainHttpConnections } = startServer(runtime.db, config, {
    devReloadMiddleware: devReload?.middleware,
    events: runtime.events,
    stores: runtime.stores,
    resolveH3Confirmation: () => {
      throw new Error("H3 生成已迁移到执行引擎");
    },
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
      if (task.kind.startsWith("runninghub:"))
        throw new Error("RunningHub 任务已迁移到执行引擎，请在引擎里取消");
      if (task.kind === "video-concat" || task.kind === "video-trim" || task.kind === "video-audio-extract") return videoConcat.cancel(task.id);
      if (task.kind === "direct-video") return directVideo.cancel(task.id);
      if (task.kind === "direct-audio") return directAudio.cancel(task.id);
      if (task.kind.startsWith("image:")) return directImage.cancel(task.id);
      throw new Error(`任务类型 ${task.kind} 没有注册取消执行器`);
    },
    reclaimTask: async (task) => {
      if (task.kind !== "canvas-video") throw new Error(`任务类型 ${task.kind} 不支持引擎回捞`);
      return await canvasVideoDispatcher.reclaim(task.id);
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
        throw new Error("本地 ComfyUI 预设执行已下线：请改用执行引擎的模型");
      if (task.kind === "runninghub:workflow") throw new Error("RunningHub 执行已迁移到执行引擎（comfyui2api）");
      throw new Error(`任务类型 ${task.kind} 没有注册重试执行器`);
    },
    prepareAiConfig: async (value) =>
      (await workflowModels.syncConfig(value)).config,
  });
  registerComfyRoutes(
    { app, stores: runtime.stores, config, events: runtime.events },
  );
  // 画布工作流页已下线：前端只跳转到引擎控制台，地址由这里给，避免写死。
  app.get("/api/engine/console", async (_req, res) => {
    const target = await probeEngineTarget(
      engineTargets(runtime.stores.settings.get("ai.config")),
    );
    const url = target ? `${target.baseUrl.replace(/\/v1$/i, "")}/` : "";
    res.json({ ok: Boolean(url), url });
  });
  registerWorkflowRoutes(
    app,
    workflowStore,
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
  registerDramaRestyleRoutes(app, runtime.db, runtime.stores, canvasGeneration);
  // 影策审计缺口#6：按当前方案一键重做参考图（资产卡反查 → 真出图 → 写回 → 可选标脏）。
  registerDramaAssetRegenerateRoutes(app, runtime.db, runtime.stores, canvasGeneration);
  const episodeProduction = new EpisodeProductionService(runtime.db, runtime.events);

  // 成片自动重合成（影策 finalStale 真链路）：复用 VideoConcatBackend 这个后端合成引擎。
  // 触发点选 canvas-h3-run 父任务 task.completed —— 段视频已全部回写、父任务刚转 succeeded，
  // 比「按段写回」更可靠（不会在批量生成的中间态反复合成），且一次批量只触发一次。
  const finalComposer = new FinalComposer({
    db: runtime.db,
    production: episodeProduction,
    videoConcat,
    tasks: runtime.tasks,
    events: runtime.events,
  });
  runtime.events.subscribe((event) => {
    if (event.type !== "task.completed") return;
    const task = event.payload as { kind?: string; projectId?: string; input?: Record<string, unknown>; params?: Record<string, unknown> } | undefined;
    if (!task) return;
    const kind = String(task.kind || "");
    if (kind !== "canvas-h3-run" && kind !== "canvas-video") return;
    const binding = task.params?.canvasBinding as Record<string, unknown> | undefined;
    const projectId = String(task.projectId || task.input?.projectId || binding?.projectId || "");
    if (!projectId) return;
    const episode = runtime.db.getDramaEpisodeByCanvasId(projectId);
    if (!episode) return;
    void finalComposer.recomposeIfStale(episode.id).catch((error) =>
      logger.warn("成片自动重合成失败（不阻断生成）", { episodeId: episode.id, error: error instanceof Error ? error.message : String(error) }),
    );
  });
  // 手动兜底入口：前端「合成成品」或诊断可显式触发（默认只在确实过期时动手，force=true 强制）。
  app.post("/drama/episodes/:episodeId/final/recompose", async (req, res) => {
    try {
      const result = await finalComposer.recomposeIfStale(req.params.episodeId, { force: (req.body as Record<string, unknown> | undefined)?.force === true });
      res.json({ ok: result.status !== "failed", ...result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  const productionHermes = new HermesAgent(runtime.stores.settings, config.url, config.token);
  // 画布文本任务打通导演 agent：模型选到 hermes 渠道时由它执行（structured 单轮，
  // 输出若是对象取 text/demand 字段，否则原样返回字符串）。
  canvasTextDispatcher.setHermesRunner(async ({ model, prompt }) => {
    // 导演 agent（Hermes structured）强制 JSON 输出；把回答包进 {text} 字段，
    // 既给模型一个明确的落点，也避免它回显 schema。
    // 模型偶发用散文回话（不按 JSON）：带逐次加强的纠正前缀重试（最多 3 次），
    // 比把失败直接抛给前端更有用。
    const runStructured = async (extra?: string) => {
      const { output } = await productionHermes.structured({
        cwd: process.cwd(),
        prompt: extra ? `${extra}\n\n${prompt}` : prompt,
        schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
        model,
        effort: "auto",
        onThread: () => undefined,
      });
      return output;
    };
    const toText = (output: unknown) => {
      const nested = (output && typeof output === "object" ? output : {}) as Record<string, unknown>;
      const text = typeof output === "string" ? output : String(nested.text ?? "");
      if (!text.trim()) throw new Error("Hermes 文本任务返回了空内容");
      return text;
    };
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return toText(await runStructured(attempt === 1 ? undefined : "你上一次的回复不是合法 JSON，这是不合格的回答。重新回答：严格只输出一个 JSON 对象 {\"text\":\"你的回答\"}，不要代码块、不要解释、不要开场白，JSON 之外一个字都不要有。"));
      } catch (error) {
        lastError = error;
        if (attempt < 3) logger.warn(`Hermes 文本任务第 ${attempt} 轮未按 JSON 回复，重试`, { error: error instanceof Error ? error.message : String(error), model });
      }
    }
    throw lastError;
  });
  const productionAgents = new ProductionAgentPool(undefined, {
    canRun: request => request.threadId ? isHermesThread(request.threadId) : productionHermes.provider(request.model)?.kind === "hermes",
    run: request => productionHermes.structured(request),
    retainHistory: (threadId, title) => productionHermes.retainHistory(threadId, title),
  }, (model, threadId) => productionHermes.nativeWorkerModel(model, threadId));
  process.once("exit", () => productionAgents.stop());
  app.get("/production/worker-status", (_req, res) => res.json({
    ok: true,
    busy: productionAgents.busy,
    compilationBusy: productionCompilationBusy(),
    ...(devReload ? { reload: { activeTask: Boolean(devActiveTask?.get()), mutationsInFlight: devReload.mutationsInFlight } } : {}),
  }));
  const episodeProductionRunner = new EpisodeProductionRunner(episodeProduction, runtime.stores, canvasGeneration);
  registerDramaProductionRoutes(app, episodeProduction, episodeProductionRunner, undefined, runtime.events, productionAgents);
  // 视频生成前只读体检：GET/POST /drama/episodes/:episodeId/prerun（不创建任务、不写库）。
  registerDramaPrerunRoutes(app, episodeProduction);
  // 视频已生成但结果回写失败：只重跑本地后处理，不重新提交模型、不扣费。
  registerDramaVideoReprocessRoutes(app, runtime.db, runtime.stores, runtime.events);
  registerDramaTopicProposalRoute(app, runtime.stores);
  registerDramaPlanningRoutes(app, runtime.db, runtime.stores);
  registerDramaEpisodeGroupingRoutes(app, runtime.db, runtime.stores, runtime.events);
  registerDramaScriptRoutes(app, runtime.db, runtime.stores);
  registerDramaPlanningStateRoutes(app, runtime.db);
  registerDramaSourceChapterRoutes(app, runtime.db);
  registerDramaStageRoutes(app, runtime.db);
  registerAssetSpecRoutes(app, runtime.db);
  // 全自动流水线：独立 store + 编排器，HTTP 自调用复用现成生成/编译/op 能力。
  const pipelineStore = new PipelineStore();
  const dramaPipeline = new DramaPipeline({
    store: pipelineStore, token: config.token, baseUrl: config.url,
    resolveTextModel: () => resolveOutlineModel(runtime.stores.settings.get("ai.config")),
    // 资产参考图默认模型：设置页 ai.config.imageModel（制作设置 imageModelsByKind 可逐类型覆盖）。
    resolveImageModel: () => String((runtime.stores.settings.get("ai.config") as Record<string, unknown> | undefined)?.imageModel || "").trim(),
    // C5：段提示词字数上限真值取已登记视频模型的 promptMaxChars；无登记返回 undefined=不限制。
    resolveVideoPromptMaxChars: (modelValue: string) => videoCapabilitiesOf(runtime.stores.settings.get("ai.config"), modelValue).promptMaxChars,
  });
  registerDramaPipelineRoutes(app, dramaPipeline, runtime.db);
  dramaPipeline.startLoop();
  const canvasProduction = new EpisodeProductionService(runtime.db, runtime.events, undefined, true);
  const directorSubagents = new DirectorSubagents(runtime.stores, productionAgents, runtime.events, process.cwd(), (threadId, model) => productionHermes.delegationModel(threadId, model), kind => kind === "episode" ? episodeProduction : canvasProduction);
  directorSubagents.reconcileStartup();
  registerDirectorSubagentRoutes(app, directorSubagents);
  const canvasProductionRunner = new EpisodeProductionRunner(canvasProduction, runtime.stores, canvasGeneration);
  registerDramaProductionRoutes(app, canvasProduction, canvasProductionRunner, "/canvas/projects/:episodeId/production", runtime.events, productionAgents);
  const nativeProductionGeneration = new NativeProductionGeneration(runtime.db, runtime.stores, episodeProduction, canvasProduction, runtime.events);
  nativeProductionGeneration.start();
  canvasGeneration.observeProduction(nativeProductionGeneration);
  new SharedAssetCoordinator(runtime.db).start();
  registerCanvasBrowserScriptRoutes(app, canvasBrowserScriptDispatcher);
  registerCanvasReferenceRoutes(app, canvasReferences);
  registerAgentRuntimeRoutes(
    app,
    runtime.stores,
    videoConcat,
    runtime.events,
  );
  registerSubtitleTranscribeRoutes(app, subtitleTranscriber, runtime.events);
  registerAudioTranscribeRoutes(app);
  registerComfyRoutes(
    {
      app,
      stores: runtime.stores,
      config,
      events: runtime.events,
      basePath: "/agent",
    },
  );
  const agent = createAgentRuntime({
    backendUrl: config.url,
    backendToken: config.token,
    settings: runtime.stores.settings,
  });
  runtime.agent = agent;
  app.use("/agent", agent.app);
  const canvasRealtime = new CanvasRealtimeHub(config, db, events);
  setSelectionRealtime(canvasRealtime);
  const mcpHttp = registerBackendMcpHttpRoutes(
    app,
    config,
    stores.mcpObservability,
    () => canvasRealtime.focusedProjectId(),
  );
  markStartupStage("routesAndAgent");
  // 启动时只读取最新 10 条需要恢复的生成任务；超出范围的记录保持原状，
  // 不因未入选而标记失败。终态只考虑仍绑定的 H3 父任务和未收口的生成日志。
  const recoveryTasks = db.listStartupRecoveryTasks([], 10);
  markStartupStage("recoverySelection");
  for (const task of recoveryTasks) {
    const binding = task.params?.canvasBinding as { generationLogId?: string } | undefined;
    const pendingLog = binding?.generationLogId ? stores.logs.get(binding.generationLogId) : null;
    if (task.kind === "comfyui:minimax-h3"
      && ["succeeded", "failed", "cancelled"].includes(task.status)
      && pendingLog && ["queued", "running"].includes(pendingLog.status)) {
      void writeBackH3Task(stores, runtime.events, task).catch((error) =>
        logger.warn("H3 子任务终态日志修复失败", {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      continue;
    }
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
  }
  // ── 孤儿任务回收（防僵尸堆积）───────────────────────────────────
  // backend 重启（tsx --watch 源码热更、崩溃等）会杀掉内存中的执行循环，遗留
  // status=running/queued 的任务永远无人跟踪。上面的 resume 循环只恢复了
  // 特定类型、且确实提交到 ComfyUI（有 promptId）的任务；其余（如 workflow 类型、
  // 有处理器但从未提交的 comfyui 任务、无恢复处理器的画布任务）是僵尸任务，
  // 会在列表里无限堆积。此处仅检查本次入选任务（尚未监听端口、不会有新任务），
  // 确认无法恢复时置为 failed；未入选的旧任务保持原状。
  for (const selected of recoveryTasks) {
    const task = stores.tasks.get(selected.id);
    if (!task) continue;
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
      task.kind.startsWith("runninghub:");
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
    // 已提交的 ComfyUI/RunningHub 子任务按各自远端 ID 恢复观察；只把未提交且没有
    // 可安全重放的本地队列意图标记失败，避免猜测任务是否已计费。
    if (task.kind.startsWith("comfyui:") || task.kind.startsWith("runninghub:")) {
      const events = stores.tasks.events(task.id);
      const submitted = events.find((e) => e.type === "submitted")?.payload;
      const promptId = task.kind.startsWith("runninghub:") ? submitted?.taskId : submitted?.promptId;
      const decision = submissionDecision(task, events);
      // 确定没提交（可安全重提）或已拿到远端 ID（resume 会恢复观察）的任务保持原状。
      if (decision === "resubmit" || decision === "observe") continue;
      const createdTs = task.createdAt ? new Date(task.createdAt).getTime() : 0;
      // 超过 24 小时的 ComfyUI 任务，其 history 早被 ComfyUI 清理，resume 观察必然超时失败。
      const tooOld = task.kind.startsWith("comfyui:") && createdTs > 0 && Date.now() - createdTs > 24 * 60 * 60 * 1000;
      if (decision === "reconcile" && !tooOld) {
        // 提交窗口内的 unknown 既不重提也不误判失败：保留 running 并写明核对入口。
        holdUnknownSubmission(stores.tasks, task.id, "backend 重启后未找到远端提交回执");
        continue;
      }
      if (typeof promptId !== "string" || !promptId || tooOld) {
        stores.tasks.update(task.id, {
          status: "failed",
          error:
            decision === "reconcile"
              ? submissionDiagnostic("backend 重启后提交状态仍未确认且已超过可恢复窗口（孤儿任务回收）")
              : tooOld && promptId
                ? "backend 重启后该 ComfyUI 任务已超过 24 小时，history 已不可恢复，已自动置为失败（孤儿任务回收）"
                : task.kind.startsWith("runninghub:")
                  ? "backend 重启后该 RunningHub 任务没有远端 taskId，无法安全恢复，已自动置为失败（孤儿任务回收）"
                  : "backend 重启后该 ComfyUI 任务没有 promptId，无法安全恢复，已自动置为失败（孤儿任务回收）",
        });
        stores.tasks.addEvent(task.id, "status", { status: "failed" });
      }
    }
    // canvas-*/direct-* 类型：上面的 resume 循环已尝试恢复，此处不再处理
  }
  // 这两个恢复循环会重放排队/中断的任务，可能连到已经停掉的渠道（例如 3900 的
  // voiceStudio）。之前是裸 void，一旦 reject 就是未处理的 Promise 拒绝。
  void episodeProductionRunner.resumePending().catch((error) =>
    logger.warn("resume-pending-failed", { runner: "episode", ...describeError(error) }),
  );
  void canvasProductionRunner.resumePending().catch((error) =>
    logger.warn("resume-pending-failed", { runner: "canvas", ...describeError(error) }),
  );
  markStartupStage("recoveryDispatch");
  registerCanvasCollaborationRoutes(app, db, canvasRealtime);
  registerBackendErrorHandler(app);
  // The dev watcher keeps the public MCP port bound while each child serves on its loopback target port.
  const internalListenPort = Number(process.env.INFINITE_CANVAS_BACKEND_LISTEN_PORT);
  const listenHost = internalListenPort ? "127.0.0.1" : config.listenHost || "127.0.0.1";
  const server = app.listen(
    internalListenPort || config.port,
    listenHost,
    () => {
      markStartupStage("listen");
      logger.info(`总后台已启动 ${config.url}`, {
        listenHost,
        pid: process.pid,
        version: readVersion(),
        startupTimingsMs,
        startupTotalMs: Math.round(performance.now()),
      });
      process.send?.({ type: "dev:ready", pid: process.pid, listenHost: config.listenHost });
    },
  );
  canvasRealtime.attach(server);
  const stopRuntimeMonitor = startRuntimeMonitor(logger);

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
  // 已移到模块顶部（import 之后、首个 await 之前）：注册在这里太晚，
  // 启动阶段的失败会直接打穿进程且不留栈。见文件开头 describeError/process.on。

  const shutdown = (signal: string) => {
    const shutdownStartedAt = performance.now();
    logger.info(`${signal} received, shutting down…`);
    stopRuntimeMonitor();
    releaseInstanceLock();
    canvasRealtime.close();
    void mcpHttp.closeAll().finally(() => {
      logger.info("backend-shutdown-stage", { stage: "mcp", elapsedMs: Math.round(performance.now() - shutdownStartedAt) });
      drainHttpConnections();
      server.close(() => {
        db.close();
        logger.info("backend-shutdown-stage", { stage: "closed", elapsedMs: Math.round(performance.now() - shutdownStartedAt) });
        process.exit(0);
      });
    });
    setTimeout(() => {
      logger.warn("backend-shutdown-stage", { stage: "forced-exit", elapsedMs: Math.round(performance.now() - shutdownStartedAt) });
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  if (devReload && process.send) {
    process.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || (message as { type?: string }).type !== "dev:reload") return;
      const accepted = devReload.tryReload(() => agent.session.codexBusy || agent.session.runtimeStateSnapshot.conversation.status === "running" || productionAgents.busy
        || productionCompilationBusy() || Boolean(devActiveTask?.get()));
      process.send?.({ type: "dev:reload-status", accepted }, undefined, undefined, () => { if (accepted) shutdown("DEV_RELOAD"); });
    });
  }
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

