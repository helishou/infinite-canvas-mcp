import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { registerBackendMcpHttpRoutes } from "./mcp.js";
import type { ResolvedConfig } from "./config.js";

test("HTTP MCP 声明同步直接读进程内权威数据，不依赖自 HTTP 请求", async t => {
  const app = express();
  app.use(express.json());
  let httpDeclarationReads = 0;
  app.get("/plugins/mcp", (_req, res) => { httpDeclarationReads++; res.status(503).json({ ok: false }); });
  app.post("/mcp/observability/events", (_req, res) => res.status(201).json({ ok: true }));
  const routes = registerBackendMcpHttpRoutes(
    app,
    { url: "http://127.0.0.1:1", token: "fixture", port: 1, origins: [] } satisfies ResolvedConfig,
    undefined,
    undefined,
    undefined,
    () => [{ id: "minimax-h3", name: "MiniMax H3", version: "1.5.5", enabled: true, tools: [] }],
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await routes.closeAll();
    server.close();
    await once(server, "close");
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new Client({ name: "declaration-source-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  t.after(() => client.close());
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes("h3_get_node"), "进程内 reader 的声明应加载 H3 插件工具");
  assert.equal(httpDeclarationReads, 0, "进程内 reader 不应再请求 /plugins/mcp");
});
