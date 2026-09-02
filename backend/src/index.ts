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
registerAgentRuntimeRoutes(app, runtime.stores, runningHub, videoConcat, runtime.events);
registerComfyRoutes({ app, stores: runtime.stores, config, events: runtime.events, basePath: "/agent" }, runtime.comfy);
const agent = createAgentRuntime({ backendUrl: config.url, backendToken: config.token });
runtime.agent = agent;
app.use("/agent", agent.app);
registerBackendErrorHandler(app);

const server = app.listen(config.port, "127.0.0.1", () => {
    logger.info(`总后台已启动 http://127.0.0.1:${config.port}`, { pid: process.pid, version: readVersion() });
});

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

function readVersion() {
    try {
        const pkgPath = path.join(import.meta.dirname || ".", "..", "package.json");
        return String(JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || "0.0.0");
    } catch {
        return "0.0.0";
    }
}
}
