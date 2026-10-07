import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { registerBackendMcpHttpRoutes } from "./mcp.js";
import { KNOWN_FIRST_PARTY } from "@basketikun/canvas-agent/plugin-mcp";
import { productionToolNames } from "@basketikun/canvas-agent/drama/production-tools";
import { removedToolMigrations } from "@basketikun/canvas-agent/tool-migrations";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("MCP v3 removes 37 names, exposes all unified tools, and rejects retired calls before execution", async t => {
    const app = express(); app.use(express.json()); let writes = 0;
    app.get("/plugins/mcp", (_req, res) => res.json({ ok: true, declarations: [{ id: "minimax-h3", enabled: true, version: KNOWN_FIRST_PARTY["minimax-h3"].version, tools: [] }] }));
    app.post("/mcp/observability/events", (_req, res) => res.json({ ok: true }));
    app.post(["/drama/episodes/:id/production/ops", "/canvas/projects/:id/production/ops", "/canvas/projects/:id/ops", "/canvas/generation"], (_req, res) => { writes++; res.json({ ok: true }); });
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const routes = registerBackendMcpHttpRoutes(app, { url, port: 0, token: "fixture", origins: [] });
    const client = new Client({ name: "pruning-fixture", version: "1" });
    t.after(async () => { await client.close(); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
    const catalog = await client.listTools(); const names = new Set(catalog.tools.map(tool => tool.name));
    for (const name of productionToolNames) assert.ok(names.has(name));
    for (const name of Object.keys(removedToolMigrations)) {
        assert.equal(names.has(name), false);
        await assert.rejects(client.callTool({ name, arguments: {} }), (error: any) => error.code === -32602 && error.data?.code === "TOOL_REMOVED" && error.data?.migration.replacement === removedToolMigrations[name].replacement);
    }
    assert.equal(writes, 0);
    assert.equal(client.getServerVersion()?.version, "0.1.0+mcp3");
    const invalid = await fetch(url + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", "mcp-session-id": "expired" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "h3_update_clip", arguments: {} } }) });
    assert.equal(invalid.status, 404);
    const bytes = Buffer.byteLength(JSON.stringify(catalog.tools));
    assert.ok(bytes < 216777, `catalog must shrink from the observed baseline: ${bytes}`);
    console.log(JSON.stringify({ catalogTools: catalog.tools.length, catalogBytes: bytes, unifiedTools: productionToolNames.length, removedNames: Object.keys(removedToolMigrations).length }));
    assert.equal(catalog.tools.length, 149);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-stdio-retirement-"));
    await fs.writeFile(path.join(temporary, "backend.json"), JSON.stringify({ url, token: "fixture", port: (server.address() as any).port, origins: [] }));
    const stdio = new Client({ name: "stdio-retirement-fixture", version: "1" });
    try {
        await stdio.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "--input-type=module", "-e", 'import {startBackendMcpServer} from "./src/mcp.ts"; await startBackendMcpServer();'], cwd: process.cwd(),
            env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")), PORT: "", INFINITE_CANVAS_DATA_DIR: temporary, INFINITE_CANVAS_BACKEND_TOKEN: "fixture" }, stderr: "pipe" }));
        const stdioNames = new Set((await stdio.listTools()).tools.map(tool => tool.name));
        for (const name of Object.keys(removedToolMigrations)) assert.equal(stdioNames.has(name), false);
        const missing: any = await stdio.callTool({ name: "h3_update_clip", arguments: {} });
        assert.equal(missing.isError, true); assert.match(missing.content[0].text, /not found/);
    } finally { await stdio.close(); await fs.rm(temporary, { recursive: true, force: true }); }
});
