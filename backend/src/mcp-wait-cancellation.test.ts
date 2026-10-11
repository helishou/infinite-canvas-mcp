import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KNOWN_FIRST_PARTY } from "@basketikun/canvas-agent/plugin-mcp";
import { BackendDatabase } from "./db.js";
import { registerBackendMcpHttpRoutes } from "./mcp.js";

test("cancelling MCP task wait aborts the in-flight Backend poll without cancelling the task", async t => {
  const db = new BackendDatabase(":memory:");
  const api = express();
  api.use(express.json());
  api.get("/plugins/mcp", (_req, res) => res.json({ ok: true, declarations: [{ id: "minimax-h3", enabled: true, version: KNOWN_FIRST_PARTY["minimax-h3"].version, tools: [] }] }));
  api.post("/mcp/observability/events", (_req, res) => res.json({ ok: true }));
  const task = { id: "wait-stays-queued", kind: "canvas:image", status: "queued", progress: 0, input: {}, params: {}, result: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), outputs: [] };
  let reads = 0;
  let pollStarted!: () => void;
  const pollStartedPromise = new Promise<void>(resolve => { pollStarted = resolve; });
  let pollAborted = false;
  api.get("/tasks", (_req, res) => {
    reads++;
    if (reads === 1) return void res.json({ tasks: [task] });
    pollStarted();
    res.on("close", () => { if (!res.writableEnded) pollAborted = true; });
    const timer = setTimeout(() => { if (!res.destroyed) res.json({ tasks: [task] }); }, 5000);
    res.on("close", () => clearTimeout(timer));
  });
  const apiServer = api.listen(0, "127.0.0.1");
  await once(apiServer, "listening");
  const apiAddress = apiServer.address();
  if (!apiAddress || typeof apiAddress === "string") throw new Error("API port missing");
  const host = express();
  host.use(express.json());
  const routes = registerBackendMcpHttpRoutes(host, { url: `http://127.0.0.1:${apiAddress.port}`, token: "mcp-cancel-test", port: 1, origins: [], listenHost: "127.0.0.1" });
  const mcpServer = host.listen(0, "127.0.0.1");
  await once(mcpServer, "listening");
  const address = mcpServer.address();
  if (!address || typeof address === "string") throw new Error("MCP port missing");
  const client = new Client({ name: "mcp-wait-cancel-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp?token=mcp-cancel-test`)));
  t.after(async () => {
    await client.close(); await routes.closeAll();
    await new Promise<void>(resolve => mcpServer.close(() => resolve()));
    await new Promise<void>(resolve => apiServer.close(() => resolve()));
    db.close();
  });

  const controller = new AbortController();
  const call = client.callTool({ name: "canvas_wait_tasks", arguments: { taskIds: [task.id], timeoutMs: 30_000, pollMs: 250 } }, undefined, { signal: controller.signal });
  await pollStartedPromise;
  controller.abort(new DOMException("test cancellation", "AbortError"));
  await assert.rejects(call);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pollAborted, true);
  assert.equal(task.status, "queued");
  assert.equal(reads, 2);
});
