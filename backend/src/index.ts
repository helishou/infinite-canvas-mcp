#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { loadConfig, saveConfig, ensureDataDirs } from "./config.js";
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
import { startBackendMcpServer } from "./mcp.js";

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

const db = new BackendDatabase();
const stores = createStores(db);
const events = new BackendEventBus();
const comfy = new ComfyUiBackend({ tasks: stores.tasks, settings: stores.settings, media: stores.media, events });
const runtime = createBackendRuntimeContext({ db, stores, comfy, events });
const runningHub = new RunningHubBackend(runtime.tasks, runtime.stores.settings, runtime.events, runtime.media);
const videoConcat = new VideoConcatBackend(runtime.tasks, undefined, runtime.events, runtime.media);

const { app } = startServer(runtime.db, config, { comfy: runtime.comfy, events: runtime.events, stores: runtime.stores });
registerComfyRoutes({ app, stores: runtime.stores, config, events: runtime.events }, runtime.comfy);

// Workflow import routes
const workflowStore = new WorkflowStore(db);
const workflowExecutor = new WorkflowExecutor(runtime.comfy, runtime.stores.tasks, runtime.stores.media, runtime.events, db);
registerWorkflowRoutes(app, workflowStore, workflowExecutor);
registerAgentRuntimeRoutes(app, runtime.stores, runningHub, videoConcat, runtime.events);
registerComfyRoutes({ app, stores: runtime.stores, config, events: runtime.events, basePath: "/agent" }, runtime.comfy);
const agent = createAgentRuntime({ backendUrl: config.url, backendToken: config.token });
runtime.agent = agent;
app.use("/agent", agent.app);
registerBackendErrorHandler(app);

const server = app.listen(config.port, "127.0.0.1", () => {
    logger.info(`总后台已启动 http://127.0.0.1:${config.port}`, { pid: process.pid, version: readVersion() });
});

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
    server.close(() => {
        db.close();
        process.exit(0);
    });
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
