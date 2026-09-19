import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { registerBackendMcpHttpRoutes } from "./mcp.js";
import type { ResolvedConfig } from "./config.js";

async function fixture(t: import("node:test").TestContext, backendUrl = "http://127.0.0.1:1") {
  const app = express();
  app.use(express.json());
  const routes = registerBackendMcpHttpRoutes(app, {
    url: backendUrl,
    token: "test-token",
    port: 1,
    origins: [],
    listenHost: "127.0.0.1",
  } satisfies ResolvedConfig);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await routes.closeAll();
    server.close();
    await once(server, "close");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function mockBackend(t: import("node:test").TestContext, onMcpEvent?: (event: Record<string, unknown>) => void) {
  const app = express();
  app.use(express.json());
  app.post("/mcp/observability/events", (req, res) => {
    onMcpEvent?.(req.body as Record<string, unknown>);
    res.status(201).json({ ok: true });
  });
  app.get("/plugins/mcp", (_req, res) => res.json({ ok: true, declarations: [] }));
  app.get("/canvas/projects", (_req, res) =>
    res.json({
      ok: true,
      projects: [
        {
          id: "canvas-1",
          title: "测试画布",
          revision: 3,
          updatedAt: "2026-09-17T00:00:00.000Z",
          nodes: [
            {
              id: "image-1",
              type: "image",
              title: "角色参考",
              position: { x: 10, y: 20 },
              metadata: { storageKey: "media/image-1.png", status: "success" },
            },
            {
              id: "config-1",
              type: "config",
              title: "生图配置",
              position: { x: 430, y: 20 },
              metadata: { generationMode: "image", model: "test::image-model" },
            },
          ],
          connections: [],
          selectedNodeIds: ["image-1"],
        },
      ],
    }),
  );
  app.get("/canvas/projects/:id/collaboration", (req, res) => {
    if (req.params.id === "missing-canvas") {
      res.status(404).json({ ok: false, error: "画布不存在" });
      return;
    }
    res.json({
      ok: true,
      projectId: req.params.id,
      revision: 3,
      participants: [],
    });
  });
  app.get("/settings/ai-config", (_req, res) =>
    res.json({
      ok: true,
      config: {
        imageModel: "test::image-model",
        channels: [
          {
            id: "test",
            models: [{ name: "image-model", capability: "image" }],
          },
        ],
      },
    }),
  );
  app.get("/tasks", (_req, res) =>
    res.json({
      ok: true,
      tasks: [
        {
          id: "task-1",
          kind: "canvas-image",
          status: "running",
          progress: 0.5,
          input: { projectId: "canvas-1", nodeId: "config-1" },
          params: { model: "test::image-model" },
          createdAt: "2026-09-17T00:00:00.000Z",
          updatedAt: "2026-09-17T00:00:01.000Z",
        },
      ],
    }),
  );
  app.get("/tasks/:id", (req, res) =>
    res.json({
      ok: true,
      task: {
        id: req.params.id,
        kind: "canvas-image",
        status: "running",
        progress: 0.5,
        input: { projectId: "canvas-1", nodeId: "config-1" },
        params: { model: "test::image-model" },
        createdAt: "2026-09-17T00:00:00.000Z",
        updatedAt: "2026-09-17T00:00:01.000Z",
      },
      events: [],
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return `http://127.0.0.1:${address.port}`;
}

async function mockGenerationBackend(t: import("node:test").TestContext) {
  const app = express();
  app.use(express.json());
  app.post("/mcp/observability/events", (_req, res) => res.status(201).json({ ok: true }));
  let project: Record<string, unknown> = {
    id: "canvas-generate",
    title: "生成画布",
    revision: 0,
    updatedAt: "2026-09-17T00:00:00.000Z",
    nodes: [],
    connections: [],
  };
  let generationCommand: Record<string, unknown> | null = null;
  let singleTaskRequests = 0;
  let bulkTaskRequests = 0;
  let aiConfigRequests = 0;
  const taskRecord = (id: string) => ({
    id,
    kind: "canvas-image",
    status: "succeeded",
    progress: 1,
    input: { projectId: "canvas-generate", nodeId: id === "task-generated" ? "image-generated" : `image-${id}` },
    params: { model: "test::default-image" },
    result: { media: [{ storageKey: id === "task-generated" ? "image:generated" : `image:${id}` }] },
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:01.000Z",
  });
  app.get("/plugins/mcp", (_req, res) => res.json({ ok: true, declarations: [] }));
  app.get("/canvas/projects", (_req, res) => res.json({ ok: true, projects: [project] }));
  app.get("/settings/ai-config", (_req, res) => {
    aiConfigRequests += 1;
    res.json({
      ok: true,
      config: {
        imageModel: "test::default-image",
        channels: [{ id: "test", models: [{ name: "default-image", capability: "image" }] }],
      },
    });
  });
  app.post("/canvas/projects/:id/ops", (req, res) => {
    const operations = Array.isArray(req.body.operations) ? req.body.operations : [];
    const nodes = [...(project.nodes as Array<Record<string, unknown>> || [])];
    const connections = [...(project.connections as Array<Record<string, unknown>> || [])];
    for (const operation of operations) {
      if (operation.type === "add_node") {
        nodes.push({
          id: operation.id,
          type: operation.nodeType,
          title: operation.title,
          position: operation.position,
          width: operation.width || 340,
          height: operation.height || 240,
          metadata: operation.metadata || {},
        });
      }
      if (operation.type === "connect_nodes") connections.push(operation);
    }
    project = { ...project, revision: 1, nodes, connections };
    res.json({ ok: true, project, revision: 1, operationResults: operations.map(() => ({ ok: true })) });
  });
  app.post("/canvas/generation", (req, res) => {
    generationCommand = req.body;
    res.status(201).json({ ok: true, taskId: "task-generated", executor: "direct", task: { id: "task-generated" } });
  });
  app.get("/tasks", (req, res) => {
    bulkTaskRequests += 1;
    const ids = typeof req.query.taskIds === "string"
      ? req.query.taskIds.split(",").map((id) => id.trim()).filter(Boolean)
      : [];
    res.json({ ok: true, tasks: ids.map(taskRecord) });
  });
  app.get("/tasks/:id", (req, res) => {
    singleTaskRequests += 1;
    res.json({
      ok: true,
      task: taskRecord(req.params.id),
      events: [],
    });
  });
  const assets = new Map<string, Record<string, unknown>>();
  app.get("/canvas/assets", (_req, res) => res.json({ ok: true, assets: [...assets.values()], folders: [] }));
  app.post("/canvas/assets", (req, res) => {
    assets.set(String(req.body.id), req.body as Record<string, unknown>);
    res.json({ ok: true, asset: req.body });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    generationCommand: () => generationCommand,
    project: () => project,
    taskRequestCounts: () => ({ single: singleTaskRequests, bulk: bulkTaskRequests }),
    aiConfigRequestCount: () => aiConfigRequests,
  };
}

async function mcpClient(t: import("node:test").TestContext, url: string) {
  const client = new Client({ name: "mcp-http-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  t.after(() => client.close());
  return client;
}

function textPayload(result: unknown) {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const content = Array.isArray(record.content) ? record.content[0] : null;
  assert.ok(content && typeof content === "object" && "type" in content && content.type === "text");
  assert.ok("text" in content && typeof content.text === "string");
  return JSON.parse(content.text);
}

test("MCP HTTP returns 404 for an expired session so clients can reconnect", async (t) => {
  const url = await fixture(t);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": "expired-session",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });

  assert.equal(response.status, 404);
  assert.match(await response.text(), /session is no longer available/);
});

test("MCP HTTP keeps 400 for a non-initialize request without a session", async (t) => {
  const url = await fixture(t);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });

  assert.equal(response.status, 400);
  assert.match(await response.text(), /No valid MCP session ID provided/);
});

test("canvas_inspect returns one actionable canvas context", async (t) => {
  const events: Array<Record<string, unknown>> = [];
  const backendUrl = await mockBackend(t, (event) => events.push(event));
  const client = await mcpClient(t, await fixture(t, backendUrl));
  const result = await client.callTool({ name: "canvas_inspect", arguments: {} });
  const payload = textPayload(result);

  assert.equal(payload.ready, true);
  assert.equal(payload.currentState.project.id, "canvas-1");
  assert.deepEqual(payload.selection.map((node: { id: string }) => node.id), ["image-1"]);
  assert.equal(payload.referenceCandidates[0].storageKey, "media/image-1.png");
  assert.equal(payload.capabilities.find((item: { capability: string }) => item.capability === "image").available, true);
  assert.equal(typeof payload.traceId, "string");
  assert.deepEqual(events.map((event) => event.event), ["tool.started", "tool.succeeded"]);
  assert.equal(events[0].traceId, payload.traceId);
  assert.equal((events[0].inputSummary as Record<string, unknown>).textLength, 0);
});

test("collaboration tools share the common observability trace wrapper", async (t) => {
  const events: Array<Record<string, unknown>> = [];
  const backendUrl = await mockBackend(t, (event) => events.push(event));
  const client = await mcpClient(t, await fixture(t, backendUrl));
  const result = await client.callTool({
    name: "canvas_get_collaboration_state",
    arguments: { projectId: "canvas-1" },
  });
  const payload = textPayload(result);

  assert.equal(payload.projectId, "canvas-1");
  assert.equal(typeof payload.traceId, "string");
  assert.deepEqual(events.map((event) => event.event), ["tool.started", "tool.succeeded"]);
  assert.equal(events[0].tool, "canvas_get_collaboration_state");
  assert.equal(events[0].traceId, payload.traceId);
});

test("collaboration failures return the same structured error contract", async (t) => {
  const events: Array<Record<string, unknown>> = [];
  const backendUrl = await mockBackend(t, (event) => events.push(event));
  const client = await mcpClient(t, await fixture(t, backendUrl));
  const result = await client.callTool({
    name: "canvas_get_collaboration_state",
    arguments: { projectId: "missing-canvas" },
  });
  const payload = textPayload(result);

  assert.equal(result.isError, true);
  assert.equal(payload.error.code, "PROJECT_NOT_FOUND");
  assert.equal(typeof payload.traceId, "string");
  assert.deepEqual(events.map((event) => event.event), ["tool.started", "tool.failed"]);
  assert.equal(events[1].traceId, payload.traceId);
});

test("canvas_task_status defaults to the active canvas and suggests polling", async (t) => {
  const backendUrl = await mockBackend(t);
  const client = await mcpClient(t, await fixture(t, backendUrl));
  await client.callTool({ name: "canvas_inspect", arguments: {} });
  const result = await client.callTool({ name: "canvas_task_status", arguments: {} });
  const payload = textPayload(result);

  assert.equal(payload.query.projectId, "canvas-1");
  assert.equal(payload.summary.byStatus.running, 1);
  assert.equal(payload.tasks[0].suggestedAction.tool, "canvas_wait_tasks");
  assert.deepEqual(payload.tasks[0].suggestedAction.input.taskIds, ["task-1"]);
});

test("canvas_task_status with taskId ignores unrelated project and node filters", async (t) => {
  const backendUrl = await mockBackend(t);
  const client = await mcpClient(t, await fixture(t, backendUrl));
  const result = await client.callTool({
    name: "canvas_task_status",
    arguments: { taskId: "task-1", projectId: "wrong-project", nodeId: "missing-node" },
  });
  const payload = textPayload(result);

  assert.equal(payload.summary.total, 1);
  assert.equal(payload.tasks[0].taskId, "task-1");
});

test("direct canvas tools return recoverable structured errors", async (t) => {
  const backendUrl = await mockBackend(t);
  const client = await mcpClient(t, await fixture(t, backendUrl));
  const result = await client.callTool({
    name: "canvas_get_state",
    arguments: { projectId: "missing-canvas" },
  });
  const payload = textPayload(result);

  assert.equal(result.isError, true);
  assert.equal(payload.error.code, "PROJECT_NOT_FOUND");
  assert.equal(payload.error.recoverable, true);
  assert.equal(payload.currentState.requestedProjectId, "missing-canvas");
  assert.equal(payload.suggestedAction.tool, "canvas_list_projects");
});

test("canvas_generate_image resolves the configured default model and returns the next wait call", async (t) => {
  const backend = await mockGenerationBackend(t);
  const client = await mcpClient(t, await fixture(t, backend.url));
  const result = await client.callTool({
    name: "canvas_generate_image",
    arguments: { prompt: "一只纸雕风格的白鹤" },
  });
  const payload = textPayload(result);

  assert.equal(payload.ok, true);
  assert.equal(payload.directTasks[0].taskId, "task-generated");
  assert.equal(payload.next.tool, "canvas_wait_tasks");
  assert.deepEqual(payload.next.input.taskIds, ["task-generated"]);
  assert.equal(backend.generationCommand()?.model, "test::default-image");
  const nodes = backend.project().nodes as Array<Record<string, unknown>>;
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, "config");
  assert.equal((nodes[0].metadata as Record<string, unknown>).smart, true);
});

test("canvas_generate_image_batch submits keyed items in one MCP call", async (t) => {
  const backend = await mockGenerationBackend(t);
  const client = await mcpClient(t, await fixture(t, backend.url));
  const result = await client.callTool({
    name: "canvas_generate_image_batch",
    arguments: {
      projectId: "canvas-generate",
      items: [
        { key: "scene-a", prompt: "雪院入口", title: "场景 A" },
        { key: "scene-b", prompt: "雪院回廊", title: "场景 B" },
      ],
    },
  });
  const payload = textPayload(result);

  assert.equal(payload.ok, true);
  assert.equal(payload.count, 2);
  assert.deepEqual(payload.items.map((item: { key: string }) => item.key), ["scene-a", "scene-b"]);
  assert.equal(payload.items[0].directTasks[0].taskId, "task-generated");
  assert.deepEqual(payload.taskIds, ["task-generated"]);
  const nodes = backend.project().nodes as Array<Record<string, unknown>>;
  assert.equal(nodes.filter((node) => node.type === "text").length, 0);
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every((node) => node.type === "config" && (node.metadata as Record<string, unknown>).smart === true));
});

test("canvas_generate_image_batch resolves the default model once per batch", async (t) => {
  const backend = await mockGenerationBackend(t);
  const client = await mcpClient(t, await fixture(t, backend.url));
  const result = await client.callTool({
    name: "canvas_generate_image_batch",
    arguments: {
      projectId: "canvas-generate",
      items: [
        { key: "scene-a", prompt: "雪院入口" },
        { key: "scene-b", prompt: "雪院回廊" },
        { key: "scene-c", prompt: "书房门口" },
      ],
    },
  });
  const payload = textPayload(result);

  assert.equal(payload.ok, true);
  assert.equal(payload.count, 3);
  assert.equal(backend.aiConfigRequestCount(), 1);
});

test("canvas_wait_tasks returns terminal task output in taskId order", async (t) => {
  const backend = await mockGenerationBackend(t);
  const client = await mcpClient(t, await fixture(t, backend.url));
  const result = await client.callTool({
    name: "canvas_wait_tasks",
    arguments: { taskIds: ["task-generated"], pollMs: 250 },
  });
  const payload = textPayload(result);

  assert.equal(payload.ok, true);
  assert.equal(payload.timedOut, false);
  assert.equal(payload.summary.complete, 1);
  assert.equal(payload.tasks[0].taskId, "task-generated");
  assert.equal(payload.tasks[0].outputs[0].storageKey, "image:generated");
});

test("canvas_wait_tasks polls all taskIds through one bulk request per round", async (t) => {
  const backend = await mockGenerationBackend(t);
  const client = await mcpClient(t, await fixture(t, backend.url));
  const result = await client.callTool({
    name: "canvas_wait_tasks",
    arguments: { taskIds: ["task-a", "task-b", "task-c"], pollMs: 250 },
  });
  const payload = textPayload(result);

  assert.equal(payload.ok, true);
  assert.equal(payload.timedOut, false);
  assert.equal(payload.pollCount, 1);
  assert.equal(payload.summary.total, 3);
  assert.equal(payload.summary.complete, 3);
  assert.deepEqual(payload.tasks.map((task: { taskId: string }) => task.taskId), ["task-a", "task-b", "task-c"]);
  assert.deepEqual(backend.taskRequestCounts(), { single: 0, bulk: 1 });
});

test("assets_upsert_batch writes complete assets and verifies them by id", async (t) => {
  const backend = await mockGenerationBackend(t);
  const client = await mcpClient(t, await fixture(t, backend.url));
  const result = await client.callTool({
    name: "assets_upsert_batch",
    arguments: {
      items: [
        {
          id: "asset-scene-1",
          kind: "scene",
          title: "雪院入口",
          data: { image: { storageKey: "image:scene-1" }, colorCard: { storageKey: "image:card-1" } },
        },
      ],
    },
  });
  const payload = textPayload(result);

  assert.equal(payload.ok, true);
  assert.equal(payload.count, 1);
  assert.equal(payload.verifiedCount, 1);
  assert.equal(payload.assets[0].id, "asset-scene-1");
});
