#!/usr/bin/env node
import { startHttpServer, createAgentApp } from "./server/http.js";
import { startStandaloneCompat } from "./server/standalone-compat.js";

export { createAgentApp, startHttpServer };
export { createAgentRuntime } from "./runtime/agent-runtime.js";

startStandaloneCompat();
