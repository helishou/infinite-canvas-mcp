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
import { registerWorkflowRoutes } from "./workflows/routes.js";
import { registerBackendMcpHttpRoutes, startBackendMcpServer } from "./mcp.js";
import { DirectImageBackend } from "./runtime/chatgpt-image.js";
import { CanvasImageDispatcher } from "./canvas/image-dispatcher.js";
import { registerCanvasGenerationRoutes } from "./server/canvas-generation-routes.js";
import { writeBackH3Task } from "./canvas/h3-task-writeback.js";
import { CanvasH3Runner } from "./canvas/h3-runner.js";
import { CanvasGenerationService } from "./canvas/generation-service.js";
import { acquireBackendInstanceLock } from "./instance-lock.js";
import { CanvasReferenceService } from "./canvas/reference-service.js";
import { registerCanvasReferenceRoutes } from "./server/canvas-reference-routes.js";
import { CanvasRealtimeHub } from "./canvas/realtime-hub.js";

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
const events = new BackendEventBus();
const writeBackStandaloneH3Task = async (task: import("./db.js").RuntimeTask) => {
    if (task.params?.parentTaskId) return;
    await writeBackH3Task(stores, events, task);
};
const comfy = new ComfyUiBackend({ tasks: stores.tasks, settings: stores.settings, media: stores.media, events, onTaskTerminal: writeBackStandaloneH3Task });
const runtime = createBackendRuntimeContext({ db, stores, comfy, events });
const runningHub = new RunningHubBackend(runtime.tasks, runtime.stores.settings, runtime.events, runtime.media, writeBackStandaloneH3Task);
const canvasH3Runner = new CanvasH3Runner(runtime.stores, runtime.events, runtime.comfy, runningHub);
const videoConcat = new VideoConcatBackend(runtime.tasks, undefined, runtime.events, runtime.media);

// Workflow import routes
const workflowStore = new WorkflowStore(db);
const workflowExecutor = new WorkflowExecutor(runtime.comfy, runtime.stores.tasks, runtime.stores.media, runtime.events, db);
const directImage = new DirectImageBackend(runtime.stores.tasks, runtime.stores.media);
const canvasImageDispatcher = new CanvasImageDispatcher(config, runtime.stores, runtime.comfy, directImage, workflowStore, workflowExecutor, runtime.events);
const canvasGeneration = new CanvasGenerationService(canvasImageDispatcher, canvasH3Runner, runtime.stores, runtime.events, runtime.comfy, runningHub);
const canvasReferences = new CanvasReferenceService(runtime.stores, runtime.events);
const { app } = startServer(runtime.db, config, {
    comfy: runtime.comfy, events: runtime.events, stores: runtime.stores,
    cancelTask: (task) => {
        if (task.kind === "canvas-image") return canvasImageDispatcher.cancel(task.id);
        if (task.kind === "canvas-h3-run") return canvasH3Runner.cancel(task.id);
        if (task.kind.startsWith("comfyui:")) return runtime.comfy.cancel(task.id);
        if (task.kind === "runninghub:minimax-h3") return runningHub.cancel(task.id);
        if (task.kind === "video-concat") return videoConcat.cancel(task.id);
        if (task.kind === "workflow") return workflowExecutor.cancel(task.id);
        if (task.kind.startsWith("image:")) return directImage.cancel(task.id);
        throw new Error(`任务类型 ${task.kind} 没有注册取消执行器`);
    },
    retryTask: async (task) => {
        if (task.kind === "canvas-image") return canvasImageDispatcher.retry(task);
        const clientTaskId = `retry-${crypto.randomUUID()}`;
        const params = { ...task.params, parentTaskId: task.id };
        if (task.kind.startsWith("comfyui:")) return runtime.comfy.run(task.kind.slice("comfyui:".length), task.input, params, undefined, clientTaskId);
        if (task.kind === "runninghub:minimax-h3") return runningHub.run(task.input, params, clientTaskId);
        throw new Error(`任务类型 ${task.kind} 没有注册重试执行器`);
    },
});
registerComfyRoutes({ app, stores: runtime.stores, config, events: runtime.events }, runtime.comfy);
registerWorkflowRoutes(app, workflowStore, workflowExecutor, runtime.comfy);
registerCanvasGenerationRoutes(app, canvasGeneration);
registerCanvasReferenceRoutes(app, canvasReferences);
registerAgentRuntimeRoutes(app, runtime.stores, runningHub, videoConcat, runtime.events);
registerComfyRoutes({ app, stores: runtime.stores, config, events: runtime.events, basePath: "/agent" }, runtime.comfy);
const agent = createAgentRuntime({ backendUrl: config.url, backendToken: config.token });
runtime.agent = agent;
app.use("/agent", agent.app);
const mcpHttp = registerBackendMcpHttpRoutes(app, config);
// Backend 重启后继续观察已提交但尚未结束的 ComfyUI 任务；绑定信息在 SQLite 中。
for (const task of stores.tasks.list()) {
    if (["queued", "running"].includes(task.status) && task.kind === "canvas-image") canvasImageDispatcher.resume(task);
    if (["queued", "running"].includes(task.status) && task.kind === "canvas-h3-run") canvasH3Runner.resume(task);
    if (["succeeded", "failed", "cancelled"].includes(task.status) && task.kind === "canvas-h3-run") {
        void canvasH3Runner.reconcileTerminal(task).catch((error) => logger.warn("H3 终态节点回写修复失败", { taskId: task.id, error: error instanceof Error ? error.message : String(error) }));
    }
    if (["succeeded", "failed", "cancelled"].includes(task.status) && (task.kind === "comfyui:minimax-h3" || task.kind === "runninghub:minimax-h3")) {
        const binding = task.params?.canvasBinding as { generationLogId?: string } | undefined;
        const log = binding?.generationLogId ? stores.logs.get(binding.generationLogId) : null;
        if (log && (log.status === "queued" || log.status === "running")) {
            void writeBackH3Task(stores, runtime.events, task).catch((error) => logger.warn("H3 子任务终态日志修复失败", { taskId: task.id, error: error instanceof Error ? error.message : String(error) }));
        }
    }
    if (["queued", "running"].includes(task.status) && task.kind.startsWith("comfyui:")) runtime.comfy.resume(task.id);
    if (["queued", "running"].includes(task.status) && task.kind === "runninghub:minimax-h3") runningHub.resume(task.id);
}
registerBackendErrorHandler(app);

const server = app.listen(config.port, "127.0.0.1", () => {
    logger.info(`总后台已启动 http://127.0.0.1:${config.port}`, { pid: process.pid, version: readVersion() });
});
const canvasRealtime = new CanvasRealtimeHub(config);
canvasRealtime.attach(server);

// ── 连接泄漏/僵尸连接防护 ────────────────────────────────────────────
// 浏览器（Edge 等）频繁开关连接时，若 server 不主动释放半关闭 socket，
// 会堆积 CLOSE_WAIT 直至 fd 耗尽拖垮进程（“老是挂掉”的根因之一）。
// 收紧超时，让僵尸/慢连接尽快被回收。
server.keepAliveTimeout = 30_000;
server.headersTimeout = 35_000;
server.requestTimeout = 120_000;
try { (server as unknown as { timeout: number }).timeout = 120_000; } catch { /* 部分 Node 版本只读 */ }

// ── 进程级异常兜底 ───────────────────────────────────────────────────
// 单点异常（如 SSE 断连后的 EPIPE、媒体读取错误）不应直接杀掉进程；
// 记录日志后继续运行，配合 tsx --watch 的热重载更稳健。
process.on("uncaughtException", (error) => logger.error("uncaughtException", { message: error.message, stack: error.stack }));
process.on("unhandledRejection", (reason) => logger.error("unhandledRejection", { reason: String(reason) }));

const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down…`);
    releaseInstanceLock();
    canvasRealtime.close();
    void mcpHttp.closeAll().finally(() => server.close(() => {
        db.close();
        process.exit(0);
    }));
    setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// tsx --watch 默认用 SIGINT 重启：Express 5 异步关闭、可能不触发 SIGINT 监听器，
// 补一个 beforeExit 走同样收尾，避免每次热重载都卡到 10s 兜底才退。
process.on("beforeExit", () => { db.close(); });

function readVersion() {
    try {
        const pkgPath = path.join(import.meta.dirname || ".", "..", "package.json");
        return String(JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || "0.0.0");
    } catch {
        return "0.0.0";
    }
}
}
