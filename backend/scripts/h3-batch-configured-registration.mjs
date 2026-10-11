// Read-only verification of the user's configured MCP transport; no Canvas mutations.
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import os from "node:os";
import path from "node:path";
const dataDir = process.env.INFINITE_CANVAS_DATA_DIR || path.join(os.homedir(), ".infinite-canvas");
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(dataDir, "backend.json"), "utf8")); } catch { /* explicit env can configure remote deployments */ }
const target = new URL(process.env.INFINITE_CANVAS_MCP_URL || "/mcp", process.env.INFINITE_CANVAS_BACKEND_URL || config.url || "http://127.0.0.1:17370");
const token = process.env.INFINITE_CANVAS_BACKEND_TOKEN || target.searchParams.get("token") || config.token;
const headers = token ? { authorization: `Bearer ${token}` } : {};
const client = new Client({ name: "readonly-h3-batch-registration", version: "1" });
try {
    // Administrative restart prerequisite only: read public health and filtered task ledger.
    // Credentials stay inside this process and are never printed.
    // Preserve reverse-proxy prefixes such as /api instead of jumping to the origin root.
    const backendBase = new URL(target.href); backendBase.search = "";
    backendBase.pathname = backendBase.pathname.replace(/\/mcp\/?$/, "/");
    const healthResponse = await fetch(new URL("health", backendBase), { headers });
    if (!healthResponse.ok) throw new Error("Backend health probe failed");
    const health = await healthResponse.json();
    const active = new Map();
    for (const status of ["queued", "running", "awaiting_confirmation"]) {
        for (let offset = 0; ; offset += 500) {
            const url = new URL("tasks", backendBase);
            url.searchParams.set("status", status);
            url.searchParams.set("limit", "500");
            url.searchParams.set("offset", String(offset));
            const response = await fetch(url, { headers });
            if (!response.ok) throw new Error("Backend task safety probe failed");
            const body = await response.json();
            if (!Array.isArray(body.tasks) || body.tasks.some((task) => task.status !== status)) throw new Error("Backend task filter contract not honored");
            for (const task of body.tasks) active.set(task.id, { id: task.id, kind: task.kind, status: task.status });
            if (body.tasks.length < 500) break;
        }
    }
    console.log("H3_BATCH_RELOAD_GUARD=" + JSON.stringify({ pid: health.pid, activeTaskCount: active.size, activeTasks: [...active.values()] }));
    await client.connect(new StreamableHTTPClientTransport(target, { requestInit: { headers } }));
    const catalog = await client.listTools();
    console.log("H3_BATCH_CONFIGURED=" + JSON.stringify({ transport: "streamable-http", origin: target.origin, toolRegistered: catalog.tools.some((tool) => tool.name === "h3_update_clips") }));
} finally { await client.close(); }
