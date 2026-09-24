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

async function mockBackend(t: import("node:test").TestContext, onMcpEvent?: (event: Record<string, unknown>) => void, h3 = false) {
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
  const h3Task = { id: "h3-parent", kind: "canvas-h3-run", status: "awaiting_confirmation", progress: 0.5, input: { projectId: "canvas-1", nodeId: "h3-node" }, result: { confirmation: { pending: [{ nodeId: "h3-node", segmentId: "clip-1", firstPassFingerprint: "fp-1", firstPassResult: "/media/first.mp4" }] } }, createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:01.000Z" };
  app.post("/tasks/:id/h3-confirmation", (req, res) => res.json({ ok: true, task: { ...h3Task, status: "running", result: { ...h3Task.result, phase: "second_pass" }, input: h3Task.input, decision: req.body } }));
  app.get("/tasks", (_req, res) =>
    res.json({
      ok: true,
      tasks: h3 ? [h3Task] : [
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
    h3 ? res.json({ ok: true, task: h3Task, events: [] }) :
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

async function mockOversizedBackend(t: import("node:test").TestContext, onMcpEvent?: (event: Record<string, unknown>) => void) {
  const app = express();
  app.use(express.json());
  app.post("/mcp/observability/events", (req, res) => {
    onMcpEvent?.(req.body as Record<string, unknown>);
    res.status(201).json({ ok: true });
  });
  // 单个画布节点携带 ~1 MB 文本：canvas_export_snapshot（整图导出）会把它原样放进返回体，触发输出上限。
  // canvas_get_state 自改为默认回节点摘要后已不会超限，故本用例改用导出工具验证同一道熔断。
  const oversized = "x".repeat(1024 * 1024);
  app.get("/plugins/mcp", (_req, res) => res.json({ ok: true, declarations: [] }));
  // 素材库同样会超限：声明了 keyword/page/pageSize 但以前被忽略，永远返回全量。
  // 每个素材的内联 coverUrl 是 ~30KB 的 base64 dataURL（贴近真实：实测有资产是 2MB）。
  // 剥离后 pageSize=5 只剩几 KB（可正常返回）；不剥离则必然超限。
  const assetPayload = `data:image/png;base64,${"y".repeat(30 * 1024)}`;
  app.get("/canvas/assets", (_req, res) =>
    res.json({
      ok: true,
      folders: [],
      assets: Array.from({ length: 60 }, (_, index) => ({
        id: `asset-${index}`,
        kind: "image",
        title: index === 7 ? "霓虹猫耳少女" : `素材 ${index}`,
        content: index === 7 ? "oversized-probe" : undefined,
        coverUrl: assetPayload,
      })),
    }),
  );
  app.get("/canvas/projects", (_req, res) =>
    res.json({
      ok: true,
      projects: [
        {
          id: "canvas-oversized",
          title: "超大画布",
          revision: 3,
          updatedAt: "2026-09-17T00:00:00.000Z",
          nodes: [
            {
              id: "node-huge",
              type: "text",
              title: "超大节点",
              position: { x: 0, y: 0 },
              metadata: { content: oversized },
            },
          ],
          connections: [],
          selectedNodeIds: [],
        },
      ],
    }),
  );
  app.get("/canvas/projects/:id/collaboration", (req, res) =>
    res.json({ ok: true, projectId: req.params.id, revision: 3, participants: [] }),
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

async function mockGenerationBackend(
  t: import("node:test").TestContext,
  options: { conflictOnOps?: boolean } = {},
) {
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
  let opsRequests = 0;
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
    opsRequests += 1;
    if (options.conflictOnOps) {
      res.status(409).json({ ok: false, code: "REVISION_CONFLICT", error: "revision conflict" });
      return;
    }
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
    opsRequestCount: () => opsRequests,
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
  assert.equal(typeof (events[0].inputSummary as Record<string, unknown>).inputChars, "number");
  assert.equal(typeof (events[1].outputSummary as Record<string, unknown>).outputChars, "number");
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

test("H3 MCP 暂停态返回待确认 Clip，等待立即返回且确认命令复用父任务", async (t) => {
  const backendUrl = await mockBackend(t, undefined, true);
  const client = await mcpClient(t, await fixture(t, backendUrl));
  const status = textPayload(await client.callTool({ name: "canvas_task_status", arguments: { taskId: "h3-parent" } }));
  assert.equal(status.tasks[0].status, "awaiting_confirmation");
  assert.equal(status.tasks[0].confirmation.pending[0].segmentId, "clip-1");
  assert.equal(status.tasks[0].suggestedAction.tool, "canvas_h3_confirmation");
  const wait = textPayload(await client.callTool({ name: "canvas_wait_tasks", arguments: { taskIds: ["h3-parent"], timeoutMs: 1000 } }));
  assert.equal(wait.timedOut, false);
  assert.equal(wait.summary.needsAction, 1);
  assert.equal(wait.summary.workflowComplete, 0);
  assert.equal(wait.next.tool, "canvas_h3_confirmation");
  const decision = textPayload(await client.callTool({ name: "canvas_h3_confirmation", arguments: { taskId: "h3-parent", segmentIds: ["clip-1"], firstPassFingerprint: "fp-1", action: "keep_first_pass" } }));
  assert.equal(decision.task.taskId, "h3-parent");
  assert.equal(decision.task.status, "running");
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

test("返回体超过上限时直接报错并给出可恢复建议", async (t) => {
  const events: Array<Record<string, unknown>> = [];
  const backendUrl = await mockOversizedBackend(t, (event) => events.push(event));
  const client = await mcpClient(t, await fixture(t, backendUrl));
  const result = await client.callTool({ name: "canvas_export_snapshot", arguments: { projectId: "canvas-oversized" } });
  const payload = textPayload(result);

  assert.equal(result.isError, true, "超限必须报错而不是把大返回体交给模型");
  assert.equal(payload.error.code, "OUTPUT_TOO_LARGE");
  assert.equal(payload.error.recoverable, true);
  assert.ok(payload.suggestedAction.action, "必须给出缩小返回体的建议");
  // 返回体本身必须很小：不能为了报错再把大对象带回来
  assert.ok(JSON.stringify(result).length < 4000, `错误响应应保持精简，实际 ${JSON.stringify(result).length}`);

  // 观测事件应记为失败，并带上实际大小
  const failed = events.find((event) => event.event === "tool.failed");
  assert.ok(failed, "应记录 tool.failed 事件");
  assert.equal(failed.errorCode, "OUTPUT_TOO_LARGE");
  const outputSummary = failed.outputSummary as Record<string, unknown>;
  assert.equal(outputSummary.outputBytesLimit, 512 * 1024, "应记录上限字节数");
  assert.ok(Number(outputSummary.outputBytes) > 512 * 1024, "应记录超限时的实际字节数");
  assert.ok(
    Number(outputSummary.outputChars) > 1_000_000 && Number(outputSummary.outputChars) < 1_100_000,
    `outputChars 必须是字符数口径（约 1.05M），实际 ${outputSummary.outputChars}`,
  );
  assert.ok(!events.some((event) => event.event === "tool.succeeded"), "超限不得记为成功");
});

test("assets_list 剥离内联媒体并支持分页（超限时的退路）", async (t) => {
  const backendUrl = await mockOversizedBackend(t);
  const client = await mcpClient(t, await fixture(t, backendUrl));

  // 剥离生效后，连「全量列出」都不再超限（修复前这里是必然超限的）
  const full = await client.callTool({ name: "assets_list", arguments: {} });
  assert.notEqual(full.isError, true, `剥离内联媒体后全量也不应超限: ${JSON.stringify(textPayload(full)).slice(0, 200)}`);
  const fullBody = textPayload(full);
  // 数组返回体会被 withTraceId 包成 { traceId, result: [...] }
  const fullItems = (Array.isArray(fullBody) ? fullBody : fullBody.result) as unknown[];
  assert.equal(fullItems.length, 60, "全量应返回 60 条");
  assert.ok(
    JSON.stringify(fullItems).length < 100_000,
    `剥离后体积应很小，实际 ${JSON.stringify(fullItems).length} 字符`,
  );
  assert.ok(!JSON.stringify(fullItems).includes("data:image"), "返回体里不应残留任何 dataURL 原文");

  // 分页与 keyword 过滤：声明过的参数必须真正生效
  const paged = await client.callTool({ name: "assets_list", arguments: { pageSize: 5, page: 1 } });
  assert.notEqual(paged.isError, true);
  const pagedBody = textPayload(paged);
  assert.equal(pagedBody.total, 60, "total 应是过滤后的总数");
  assert.equal(pagedBody.pageSize, 5);
  assert.equal((pagedBody.items as unknown[]).length, 5, "应只返回 pageSize 条");
  // 内联媒体必须被替换成占位符，而不是原始 base64
  const firstItem = (pagedBody.items as Array<Record<string, unknown>>)[0];
  assert.equal(firstItem.coverUrl, "[inline-media:image/png]", "内联 coverUrl 应被剥离");

  const searched = await client.callTool({ name: "assets_list", arguments: { keyword: "霓虹猫耳", pageSize: 5 } });
  assert.notEqual(searched.isError, true);
  const searchedBody = textPayload(searched);
  assert.equal(searchedBody.total, 1, "keyword 应真正过滤（此前被静默忽略）");
  assert.equal((searchedBody.items as Array<Record<string, unknown>>)[0].title, "霓虹猫耳少女");
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

test("existing-node tools reject stale node IDs before submitting operations", async (t) => {
  const backend = await mockGenerationBackend(t);
  const client = await mcpClient(t, await fixture(t, backend.url));
  const result = await client.callTool({
    name: "canvas_update_node",
    arguments: {
      projectId: "canvas-generate",
      id: "stale-node",
      patch: { title: "不应写入" },
    },
  });
  const payload = textPayload(result);

  assert.equal(result.isError, true);
  assert.equal(payload.error.code, "NODE_NOT_FOUND");
  assert.deepEqual(payload.errorContext.preflight.missingNodeIds, ["stale-node"]);
  assert.deepEqual(payload.errorContext.preflight.nodes, []);
  assert.equal(payload.suggestedAction.tool, "canvas_inspect");
  assert.equal(backend.opsRequestCount(), 0);
});

test("revision conflicts are returned without automatic replay", async (t) => {
  const backend = await mockGenerationBackend(t, { conflictOnOps: true });
  const client = await mcpClient(t, await fixture(t, backend.url));
  const result = await client.callTool({
    name: "canvas_apply_ops",
    arguments: {
      projectId: "canvas-generate",
      ops: [{ type: "add_node", id: "new-node", nodeType: "text", title: "保留冲突" }],
    },
  });
  const payload = textPayload(result);

  assert.equal(result.isError, true);
  assert.equal(payload.error.code, "REVISION_CONFLICT");
  assert.equal(payload.suggestedAction.tool, "canvas_inspect");
  assert.equal(backend.opsRequestCount(), 1);
  assert.equal((backend.project().nodes as Array<unknown>).length, 0);
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
  assert.equal("state" in payload, false);
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

test("canvas_get_state 默认回节点摘要，而不是整幅节点 metadata", async (t) => {
  const backendUrl = await mockBackend(t);
  const client = await mcpClient(t, await fixture(t, backendUrl));
  const result = await client.callTool({ name: "canvas_get_state", arguments: { projectId: "canvas-1" } });
  const payload = textPayload(result);

  assert.notEqual(result.isError, true, "默认摘要不应报错");
  assert.ok(Array.isArray(payload.nodes), "应有 nodes 数组");
  assert.equal(typeof payload.totalNodes, "number", "应报告总数");
  assert.equal(payload.totalNodes, 2);
  assert.equal(payload.truncated, false);
  for (const node of payload.nodes as Array<Record<string, unknown>>) {
    assert.ok(!("metadata" in node), "摘要节点不得携带完整 metadata");
  }
  assert.equal(JSON.stringify(payload).includes("generationSnapshot"), false);
});

test("canvas_get_state 显式传 nodeIds 时回完整节点", async (t) => {
  const backendUrl = await mockBackend(t);
  const client = await mcpClient(t, await fixture(t, backendUrl));
  const result = await client.callTool({ name: "canvas_get_state", arguments: { projectId: "canvas-1", nodeIds: ["image-1"] } });
  const payload = textPayload(result);
  const nodes = payload.nodes as Array<Record<string, unknown>>;

  assert.equal(nodes.length, 1, "只应回请求的节点");
  assert.equal(nodes[0].id, "image-1");
  assert.equal((nodes[0].metadata as Record<string, unknown>).storageKey, "media/image-1.png", "显式索取时应回完整 metadata");
});
