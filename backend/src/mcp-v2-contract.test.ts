import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KNOWN_FIRST_PARTY } from "@basketikun/canvas-agent/plugin-mcp";
import { BackendDatabase } from "./db.js";
import { registerBackendMcpHttpRoutes } from "./mcp.js";
import { registerMcpCommandTestRoutes } from "./mcp-command-test-routes.js";
import { projectProductionRead } from "@basketikun/canvas-agent/drama/production-contract";

function textOf(result: any) { return String(result.content?.find((entry: any) => entry.type === "text")?.text || ""); }
function commandReceiptOf(result: any) { return JSON.parse(textOf(result)); }

test("HTTP MCP v3 exposes the new contracts, compact asset reads, idempotent writes and runtime diagnostics", async t => {
  const db = new BackendDatabase(":memory:");
  const backend = express();
  backend.use(express.json());
  const largePrompt = "保留完整正文\r\n".repeat(100000);
  const largeProduction = { episodeId: "large", revision: 1, publishedVersion: 1, draft: { director: { engine: { runtimeId: "pinned" }, sourceHash: "full-source-hash", modules: {}, workflow: {}, assets: {}, source: { brief: "sample", script: largePrompt }, artifacts: [{ id: "h3-segment", targetId: "segment", prompt: largePrompt, sha256: "prompt-hash" }] }, scenes: [], shots: [], clipGroups: [] } };
  let requestedEpisodePage = "", requestedComfyView = "", requestedMaterialsLimit = "", requestedCompilationId = "";
  backend.get("/settings/ai-config", (_req, res) => res.json({ ok: true, config: { channels: [
    { id: "alpha", models: [{ name: "text-1", capability: "text" }, { name: "image-1", capability: "image" }] },
    { id: "beta", models: [{ name: "text-2", capability: "text" }, { name: "text-3", capability: "text" }] },
  ] } }));
  backend.get("/canvas/projects/large/production", (req, res) => res.json({ ok: true, production: projectProductionRead(largeProduction, req.query) }));
  backend.get("/drama/projects/drama-large", (req, res) => res.json({ ok: true, drama: req.query.view === "summary"
    ? { id: "drama-large", name: "大项目", outlinePreview: "o".repeat(360), outlineLength: 100000 }
    : { id: "drama-large", name: "大项目", outline: "o".repeat(100000) } }));
  backend.get("/drama/projects/drama-large/episodes", (req, res) => {
    requestedEpisodePage = `${req.query.page}:${req.query.pageSize}:${req.query.view}`;
    res.json({ ok: true, dramaId: "drama-large", total: 45, page: Number(req.query.page), pageSize: Number(req.query.pageSize), episodes: [{ id: `episode-${req.query.page}`, episodeNumber: Number(req.query.page), title: "一集", synopsis: "梗概", canvasId: null }] });
  });
  backend.get("/canvas/projects/material-project", (_req, res) => res.json({ ok: true, project: { id: "material-project", title: "素材画布", revision: 1, nodes: [], connections: [] } }));
  backend.get("/canvas/projects/material-project/nodes/material-node/materials", (req, res) => {
    requestedMaterialsLimit = String(req.query.limit || "");
    res.json({ ok: true, projectId: "material-project", nodeId: "material-node", materials: [] });
  });
  backend.get("/drama/episodes/multi/production/compilations/:operationId", (req, res) => {
    requestedCompilationId = req.params.operationId;
    res.json({ ok: true, compilation: { sourceSaved: true, operationId: requestedCompilationId, status: "running", targetCount: 2, targetIds: ["SEG1", "SEG2"],
      counts: { ready: 1, running: 1, blocked: 0, failed: 0, translated: 0, translating: 1 },
      phases: { source: "saved", compilation: "running", application: "pending", translation: "translating", mediaSubmitted: false }, mediaSubmitted: false } });
  });
  backend.get("/comfy/tasks/comfy-summary-task", (req, res) => {
    requestedComfyView = String(req.query.view || "");
    res.json({ ok: true, task: { id: "comfy-summary-task", kind: "comfyui:test", status: "running", progress: 0.5, createdAt: "now", updatedAt: "now", ...(req.query.view === "full" ? { input: { prompt: largePrompt } } : {}) }, ...(req.query.view === "summary" ? {} : { events: Array(1000).fill({ type: "progress", payload: { data: "large".repeat(50) } }) }) });
  });
  backend.post("/canvas/projects/large/production/ops", (_req, res) => res.json({ ok: true, production: { ...largeProduction, revision: 2, replayed: false } }));
  let productionBlocked = true, productionSubmissions = 0, productionAttempts = 0, preflightCalls = 0, simulateProductionRace = false;
  const productionIssue = { code: "TARGET_AWAITING_REVIEW", path: "request.targets", message: "Original image needs review", severity: "error", blockingRun: { runId: "original", status: "awaiting_review", taskIds: ["original-task"] }, nextAction: { action: "review", message: "Read the existing run", tool: "production_get_batch", input: { kind: "episode", id: "guarded", runId: "original" } } };
  backend.post(["/drama/episodes/guarded/production/preflight", "/canvas/projects/guarded/production/preflight"], (_req, res) => { preflightCalls++; res.json({ ok: true, preflight: { valid: !productionBlocked, diagnostics: productionBlocked ? [productionIssue] : [], nextActions: productionBlocked ? [productionIssue.nextAction] : [] } }); });
  backend.post(["/drama/episodes/guarded/production/compile", "/drama/episodes/guarded/production/runs", "/canvas/projects/guarded/production/runs"], (_req, res) => {
    productionAttempts++;
    if (productionBlocked || simulateProductionRace) return void res.status(400).json({ ok: false, code: productionIssue.code, error: productionIssue.message, diagnostics: [productionIssue], nextActions: [productionIssue.nextAction] });
    productionSubmissions++;
    res.json({ ok: true, compilation: { preparedId: "prepared" }, run: { runId: "new" } });
  });
  registerMcpCommandTestRoutes(backend, db);
  backend.get("/plugins/mcp", (_req, res) => res.json({ ok: true, declarations: [{ id: "minimax-h3", enabled: true, version: KNOWN_FIRST_PARTY["minimax-h3"].version, tools: [] }] }));
  backend.post("/mcp/observability/events", (req, res) => { db.createMcpObservabilityEvent(req.body); res.json({ ok: true }); });
  const api = backend.listen(0, "127.0.0.1");
  await once(api, "listening");
  const apiAddress = api.address();
  if (!apiAddress || typeof apiAddress === "string") throw new Error("API port missing");
  const host = express();
  host.use(express.json());
  const routes = registerBackendMcpHttpRoutes(host, { url: `http://127.0.0.1:${apiAddress.port}`, token: "mcp-v2-test", port: 1, origins: [], listenHost: "127.0.0.1" });
  const server = host.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP port missing");
  const mcpUrl = `http://127.0.0.1:${address.port}/mcp?token=mcp-v2-test`;
  const client = new Client({ name: "mcp-v2-contract-test", version: "1" });
  const secondClient = new Client({ name: "mcp-v2-contract-test-second-session", version: "1" });
  await Promise.all([
    client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl))),
    secondClient.connect(new StreamableHTTPClientTransport(new URL(mcpUrl))),
  ]);
  t.after(async () => {
    await Promise.all([client.close(), secondClient.close()]); await routes.closeAll();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => api.close(() => resolve()));
    db.close();
  });

  const catalog = await client.listTools();
  const secondCatalog = await secondClient.listTools();
  assert.equal(client.getServerVersion()?.version, "0.1.0+mcp3");
  assert.equal(secondClient.getServerVersion()?.version, "0.1.0+mcp3");
  assert.ok(secondCatalog.tools.some(entry => entry.name === "mcp_get_command_receipt"));
  const tool = (name: string) => catalog.tools.find(entry => entry.name === name)!;
  assert.ok(tool("mcp_get_command_receipt"));
  assert.match(tool("production_get_compilation").description, /production_edit 的 operationId/);
  assert.ok(tool("assets_get"));
  const modelPageResult = await client.callTool({ name: "models_list", arguments: { capability: "text", page: 2, pageSize: 1 } });
  const modelPage = JSON.parse(textOf(modelPageResult));
  assert.equal(modelPage.total, 3);
  assert.equal(modelPage.page, 2);
  assert.deepEqual(modelPage.models.map((model: any) => model.id), ["beta::text-2"]);
  const dramaSummaryResult = await client.callTool({ name: "drama_get_project", arguments: { dramaId: "drama-large" } });
  const dramaSummaryValue = JSON.parse(textOf(dramaSummaryResult));
  assert.equal(dramaSummaryValue.drama.outlinePreview.length, 360);
  assert.equal(dramaSummaryValue.drama.outlineLength, 100000);
  assert.equal("outline" in dramaSummaryValue.drama, false);
  const dramaFullResult = await client.callTool({ name: "drama_get_project", arguments: { dramaId: "drama-large", view: "full" } });
  assert.equal(JSON.parse(textOf(dramaFullResult)).drama.outline.length, 100000);
  const episodePageResult = await client.callTool({ name: "drama_list_episodes", arguments: { dramaId: "drama-large", page: 3, pageSize: 2 } });
  assert.equal(requestedEpisodePage, "3:2:summary");
  assert.equal(JSON.parse(textOf(episodePageResult)).total, 45);
  const combinedStatusResult = await client.callTool({ name: "production_get_compilation", arguments: { kind: "episode", id: "multi", operationId: "parent-edit" } });
  const combinedStatus = JSON.parse(textOf(combinedStatusResult));
  assert.equal(requestedCompilationId, "parent-edit");
  assert.equal(combinedStatus.compilation.targetCount, 2);
  assert.equal(combinedStatus.compilation.phases.translation, "translating");
  assert.equal(combinedStatus.compilation.mediaSubmitted, false);
  assert.ok(Buffer.byteLength(textOf(combinedStatusResult), "utf8") < 1500, "one aggregate status read stays compact for the two-target task");
  const materialsResult = await client.callTool({ name: "h3_get_node_materials", arguments: { projectId: "material-project", nodeId: "material-node" } });
  assert.equal(requestedMaterialsLimit, "50");
  assert.deepEqual(JSON.parse(textOf(materialsResult)).materials, []);
  const comfySummaryResult = await client.callTool({ name: "comfyui_get_task", arguments: { taskId: "comfy-summary-task" } });
  assert.equal(requestedComfyView, "summary");
  const comfySummaryValue = JSON.parse(textOf(comfySummaryResult));
  assert.equal(comfySummaryValue.task.status, "running");
  assert.equal("input" in comfySummaryValue.task, false);
  assert.equal("events" in comfySummaryValue, false);
  for (const name of ["production_compile", "production_get_compilation", "production_apply_compilation", "production_diagnose_bindings"]) assert.ok(tool(name));
  assert.ok((tool("production_compile").inputSchema as any).required.includes("expectedRevision"));
  const productionCalls = [
    { name: "production_compile", arguments: { kind: "episode", id: "guarded", expectedRevision: 1, operationId: "compile-original" } },
    { name: "production_start_run", arguments: { kind: "episode", id: "guarded", expectedRevision: 1, version: 1, runId: "new", idempotencyKey: "new", targets: ["asset:STYLE_MOTHER"] } },
    { name: "production_start_run", arguments: { kind: "canvas", id: "guarded", expectedRevision: 1, version: 1, runId: "new", idempotencyKey: "new", targets: ["asset:STYLE_MOTHER"] } },
  ];
  for (const call of productionCalls.slice(1)) {
    const result = await client.callTool(call);
    assert.equal(result.isError, true);
    const blocked = JSON.parse(textOf(result));
    assert.equal(blocked.error.code, "TARGET_AWAITING_REVIEW");
    assert.equal(blocked.error.issues[0].blockingRun.runId, "original");
    assert.deepEqual(blocked.suggestedAction.input, { kind: "episode", id: "guarded", runId: "original" });
  }
  assert.equal(productionSubmissions, 0, "blocked submission-boundary checks must never submit production");
  assert.equal(productionAttempts, 2, "each authorized start reaches the authoritative Backend boundary exactly once");
  assert.equal(preflightCalls, 0, "MCP must not add a duplicate automatic preflight");
  productionBlocked = false;
  const prepared = await client.callTool(productionCalls[0]);
  assert.equal(JSON.parse(textOf(prepared)).compilation.preparedId, "prepared");
  assert.equal(productionSubmissions, 1);
  simulateProductionRace = true;
  const raced = await client.callTool(productionCalls[1]);
  assert.equal(raced.isError, true, "execution races remain real failures rather than fabricated successful runs");
  const race = JSON.parse(textOf(raced));
  assert.equal(race.error.code, "TARGET_AWAITING_REVIEW");
  assert.equal(race.error.issues[0].path, "request.targets");
  assert.equal(race.error.issues[0].blockingRun.runId, "original");
  assert.equal(race.suggestedAction.tool, "production_get_batch");
  assert.equal(productionSubmissions, 1, "a race must not create a second production submission");
  assert.equal(productionAttempts, 4);
  assert.equal(preflightCalls, 0);
  assert.ok((tool("production_apply_compilation").inputSchema as any).required.includes("preparedId"));
  const largeRead = await client.callTool({ name: "production_get", arguments: { kind: "canvas", id: "large" } });
  assert.equal(largeRead.isError, undefined);
  assert.ok(textOf(largeRead).length < 5000);
  assert.equal(JSON.parse(textOf(largeRead)).production.revision, 1);
  const largeWrite = await client.callTool({ name: "production_edit", arguments: { kind: "canvas", id: "large", operationId: "large-write", expectedRevision: 1, ops: [{ type: "set_director_brief", brief: "sample" }] } });
  assert.ok(textOf(largeWrite).length < 2000);
  assert.equal(JSON.parse(textOf(largeWrite)).production.revision, 2);
  assert.equal(JSON.parse(textOf(largeWrite)).production.sourceHash, "full-source-hash");
  assert.ok((tool("assets_add").inputSchema as any).required.includes("operationId"));
  assert.ok((tool("assets_upsert_batch").inputSchema as any).required.includes("operationId"));
  assert.ok((tool("h3_update_clips").inputSchema as any).allOf.some((entry: any) => entry.then?.required?.includes("operationId") && entry.then?.required?.includes("expectedRevision")));
  const applySchema = tool("canvas_apply_ops").inputSchema as any;
  assert.deepEqual(applySchema.required, ["projectId", "operationId", "expectedRevision", "ops"]);
  const h3Schema = tool("h3_update_clips").inputSchema as any;
  assert.ok(h3Schema.allOf);
  assert.ok((tool("assets_list").description || "").includes("默认第 1 页"));

  const add = (operationId: string, title: string, content: string) => client.callTool({ name: "assets_add", arguments: { operationId, kind: "text", title, content, tags: ["素材"] } });
  const first = await add("asset-add-v2-1", "人物卡", "沈昭宁的完整资产正文");
  assert.notEqual(first.isError, true);
  const firstReceipt = JSON.parse(textOf(first));
  assert.equal(firstReceipt.committed, true);
  const replay = await add("asset-add-v2-1", "人物卡", "沈昭宁的完整资产正文");
  assert.equal(JSON.parse(textOf(replay)).replayed, true);
  const changed = await add("asset-add-v2-1", "人物卡", "changed");
  assert.equal(changed.isError, true);
  assert.equal(JSON.parse(textOf(changed)).error.code, "OPERATION_ID_REUSED");
  assert.equal(db.listAssets().length, 1);

  const receipt = await client.callTool({ name: "mcp_get_command_receipt", arguments: { operationId: "asset-add-v2-1" } });
  const receiptValue = commandReceiptOf(receipt);
  assert.deepEqual(receiptValue, { found: true, status: "committed" });
  const crossSessionReceipt = await secondClient.callTool({ name: "mcp_get_command_receipt", arguments: { operationId: "asset-add-v2-1" } });
  assert.deepEqual(commandReceiptOf(crossSessionReceipt), { found: true, status: "committed" });

  const translatingOperationId = "translation-status-only";
  db.prepareMcpCommand({ operationId: translatingOperationId, tool: "production_translate_compiled_prompts", targetId: "episode-1", request: { operationId: translatingOperationId }, payload: { stage: "translate" }, receipt: { translationStatus: "translating", targetIds: ["SEG1", "SEG2"], translatedCount: 1, cachedCount: 0 } });
  const translationReceipt = await client.callTool({ name: "mcp_get_command_receipt", arguments: { operationId: translatingOperationId } });
  assert.deepEqual(commandReceiptOf(translationReceipt), { found: true, status: "translating", targetCount: 2, targetIds: ["SEG1", "SEG2"], translatedCount: 1, cachedCount: 0, nextAction: { action: "wait", operationId: translatingOperationId } });

  const rejectedTranslationId = "translation-rejected-status";
  db.prepareMcpCommand({ operationId: rejectedTranslationId, tool: "production_translate_compiled_prompts", targetId: "episode-1", request: { operationId: rejectedTranslationId }, payload: { stage: "translate" }, receipt: { translationStatus: "applying" } });
  db.rejectMcpCommand(rejectedTranslationId, "TRANSLATION_FAILED", "failed before commit");
  const rejectedTranslation = await client.callTool({ name: "mcp_get_command_receipt", arguments: { operationId: rejectedTranslationId } });
  assert.deepEqual(commandReceiptOf(rejectedTranslation), { found: true, status: "rejected", targetCount: 0, nextAction: { action: "review_failure" }, errorCode: "TRANSLATION_FAILED" },
    "a rejected command must not keep advertising its last in-flight phase");

  const rejectedOperationId = "rejected-status-only";
  db.prepareMcpCommand({ operationId: rejectedOperationId, tool: "assets_upsert_batch", targetId: "asset-library", request: { operationId: rejectedOperationId }, payload: {}, receipt: {} });
  db.rejectMcpCommand(rejectedOperationId, "INVALID_INPUT", "Detailed internal error should not be returned here");
  const rejectedReceipt = await client.callTool({ name: "mcp_get_command_receipt", arguments: { operationId: rejectedOperationId } });
  assert.deepEqual(commandReceiptOf(rejectedReceipt), { found: true, status: "rejected", errorCode: "INVALID_INPUT" });
  const missingReceipt = await client.callTool({ name: "mcp_get_command_receipt", arguments: { operationId: "missing-operation" } });
  assert.deepEqual(commandReceiptOf(missingReceipt), { found: false, status: "not_found" });

  const listing = await client.callTool({ name: "assets_list", arguments: { keyword: "人物", pageSize: 1 } });
  const listValue = JSON.parse(textOf(listing));
  assert.equal(listValue.total, 1);
  assert.equal("data" in listValue.items[0], false);
  const detail = await client.callTool({ name: "assets_get", arguments: { id: firstReceipt.assetIds[0] } });
  assert.equal(JSON.parse(textOf(detail)).data.content, "沈昭宁的完整资产正文");

  const batchInput = { operationId: "asset-batch-v2-1", items: [{ id: "asset-batch-item-1", kind: "text", title: "批量资料", data: { content: "批量写入正文" } }] };
  const batch = await client.callTool({ name: "assets_upsert_batch", arguments: batchInput });
  const batchReceipt = JSON.parse(textOf(batch));
  assert.equal(batchReceipt.committed, true);
  assert.deepEqual(batchReceipt.assetIds, ["asset-batch-item-1"]);
  assert.equal("assets" in batchReceipt, false);
  const batchReplay = await client.callTool({ name: "assets_upsert_batch", arguments: batchInput });
  assert.equal(JSON.parse(textOf(batchReplay)).replayed, true);
  assert.equal(db.listAssets().length, 2);
  const batchDetail = await client.callTool({ name: "assets_get", arguments: { id: "asset-batch-item-1" } });
  assert.equal(JSON.parse(textOf(batchDetail)).data.content, "批量写入正文");

  const report = await client.callTool({ name: "mcp_observability_report", arguments: { from: "2026-01-01", tool: "assets_add" } });
  const reportValue = JSON.parse(textOf(report));
  assert.equal(reportValue.runtime.mcpContractVersion, 3);
  assert.equal(reportValue.runtime.h3PluginVersion, KNOWN_FIRST_PARTY["minimax-h3"].version);
  assert.match(reportValue.runtime.toolSchemaHash, /^[a-f0-9]{64}$/);
  assert.equal("daily" in reportValue, false);
  assert.ok(reportValue.byTool.every((entry: any) => entry.tool === "assets_add"));
  const fullReport = await client.callTool({ name: "mcp_observability_report", arguments: { view: "full" } });
  assert.ok(Array.isArray(JSON.parse(textOf(fullReport)).daily));
  const conflictingReport = await client.callTool({ name: "mcp_observability_report", arguments: { traceId: "trace-any", tool: "assets_add" } });
  assert.equal(conflictingReport.isError, true);
  assert.equal(JSON.parse(textOf(conflictingReport)).error.code, "INVALID_INPUT");
});
