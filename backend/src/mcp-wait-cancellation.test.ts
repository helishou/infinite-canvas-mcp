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

test("timed-out SSE wait returns the latest observed progress without an extra status call", async t => {
  const app = express(); app.use(express.json());
  const task = { id: "progress-task", kind: "canvas:image", status: "running", progress: 0.2, input: {}, params: {}, result: null, error: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", outputs: [] };
  let reads = 0;
  app.get("/plugins/mcp", (_req, res) => res.json({ declarations: [] }));
  app.post("/mcp/observability/events", (_req, res) => res.json({ ok: true }));
  app.get("/tasks", (_req, res) => { reads++; res.json({ tasks: [task] }); });
  app.get("/events", (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream"); res.flushHeaders();
    res.write('event: events.sync\ndata: {"type":"events.sync"}\n\n');
    const send = (progress: number, updatedAt: string) => res.write(`event: task.updated\ndata: ${JSON.stringify({ entityId: task.id, payload: { status: "running", progress, updatedAt } })}\n\n`);
    const first = setTimeout(() => send(0.7, "2026-01-01T00:00:02.000Z"), 100);
    const stale = setTimeout(() => send(0.3, "2026-01-01T00:00:01.000Z"), 200);
    res.on("close", () => { clearTimeout(first); clearTimeout(stale); });
  });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const routes = registerBackendMcpHttpRoutes(app, { url: `http://127.0.0.1:${address.port}`, token: "fixture", port: 0, origins: [] });
  const client = new Client({ name: "wait-progress-test", version: "1" });
  t.after(async () => { await client.close(); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  const result: any = await client.callTool({ name: "canvas_wait_tasks", arguments: { taskIds: [task.id], timeoutMs: 1000 } });
  assert.notEqual(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.timedOut, true);
  assert.equal(body.tasks[0].status, "running");
  assert.equal(body.tasks[0].progress, 0.7);
  assert.deepEqual(body.pendingTaskIds, [task.id]);
  assert.equal(body.waitMode, "sse");
  assert.equal(reads, 2, "one initial read and one race-closing read; no follow-up status tool needed");
});

test("SSE wait re-reads the task snapshot instead of idling until the deadline", async t => {
  const app = express(); app.use(express.json());
  const base = { kind: "canvas:image", input: {}, params: {}, result: null, error: null, createdAt: "2026-01-01T00:00:00.000Z", outputs: [] };
  const task = (status: string, updatedAt: string) => ({ ...base, id: "silent-task", status, progress: status === "succeeded" ? 1 : 0.3, updatedAt });
  let reads = 0;
  app.get("/plugins/mcp", (_req, res) => res.json({ declarations: [] }));
  app.post("/mcp/observability/events", (_req, res) => res.json({ ok: true }));
  app.get("/tasks", (_req, res) => {
    reads++;
    // 该任务不推 `task.*` 事件（画布图片子任务），只在快照里更新状态。
    res.json({ tasks: [reads >= 3 ? task("succeeded", "2026-01-01T00:00:09.000Z") : task("running", "2026-01-01T00:00:01.000Z")] });
  });
  app.get("/events", (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream"); res.flushHeaders();
    res.write('event: events.sync\ndata: {"type":"events.sync"}\n\n');
  });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const routes = registerBackendMcpHttpRoutes(app, { url: `http://127.0.0.1:${address.port}`, token: "fixture", port: 0, origins: [] });
  const client = new Client({ name: "wait-silent-task-test", version: "1" });
  t.after(async () => { await client.close(); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  const started = Date.now();
  const result: any = await client.callTool({ name: "canvas_wait_tasks", arguments: { taskIds: ["silent-task"], timeoutMs: 60_000, pollMs: 250 } });
  const elapsed = Date.now() - started;
  assert.notEqual(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.timedOut, false, "任务已完成时必须按完成返回，而不是等满窗口");
  assert.equal(body.tasks[0].status, "succeeded");
  assert.ok(elapsed < 30_000, `无事件任务应在快照回查后返回，实测 ${elapsed}ms`);
});
