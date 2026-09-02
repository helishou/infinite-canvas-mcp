#!/usr/bin/env node
import { startHttpServer, createAgentApp } from "./server/http.js";
import { startMcpServer } from "./server/mcp.js";
import { startStandaloneCompat } from "./server/standalone-compat.js";

export { createAgentApp, startHttpServer };
export { createAgentRuntime } from "./runtime/agent-runtime.js";

if (process.argv[2] === "mcp") await startMcpServer();
else startStandaloneCompat();
