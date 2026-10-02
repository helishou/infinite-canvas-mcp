// Read-only verification of the user's configured MCP transport; no Canvas mutations.
import fs from "node:fs";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const require = createRequire(new URL("../../canvas-agent/package.json", import.meta.url));
const yaml = require("yaml");
const config = yaml.parse(fs.readFileSync("C:/Users/wxy/AppData/Local/hermes/config.yaml", "utf8"));
const entry = config.mcp_servers["infinite-canvas"];
const target = new URL(entry.url);
const client = new Client({ name: "readonly-h3-batch-registration", version: "1" });
try {
    // Administrative restart prerequisite only: read public health and filtered task ledger.
    // Credentials stay inside this process and are never printed.
    const authorization = target.searchParams.get("token");
    const headers = authorization ? { authorization: `Bearer ${authorization}` } : {};
    const healthResponse = await fetch(new URL("/health", target.origin), { headers });
    if (!healthResponse.ok) throw new Error("Backend health probe failed");
    const health = await healthResponse.json();
    const active = new Map();
    for (const status of ["queued", "running", "awaiting_confirmation"]) {
        for (let offset = 0; ; offset += 500) {
            const url = new URL("/tasks", target.origin);
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
    await client.connect(new StreamableHTTPClientTransport(target));
    const catalog = await client.listTools();
    console.log("H3_BATCH_CONFIGURED=" + JSON.stringify({ transport: "streamable-http", origin: target.origin, toolRegistered: catalog.tools.some((tool) => tool.name === "h3_update_clips") }));
} finally { await client.close(); }
