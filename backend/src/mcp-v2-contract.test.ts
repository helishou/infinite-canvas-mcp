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

test("HTTP MCP v2 exposes the new contracts, compact asset reads, idempotent writes and runtime diagnostics", async t => {
  const db = new BackendDatabase(":memory:");
  const backend = express();
  backend.use(express.json());
  const largePrompt = "保留完整正文\r\n".repeat(100000);
  const largeProduction = { episodeId: "large", revision: 1, publishedVersion: 1, draft: { director: { engine: { runtimeId: "pinned" }, sourceHash: "full-source-hash", modules: {}, workflow: {}, assets: {}, source: { brief: "sample", script: largePrompt }, artifacts: [{ id: "h3-segment", targetId: "segment", prompt: largePrompt, sha256: "prompt-hash" }] }, scenes: [], shots: [], clipGroups: [] } };
  backend.get("/canvas/projects/large/production", (req, res) => res.json({ ok: true, production: projectProductionRead(largeProduction, req.query) }));
  backend.post("/canvas/projects/large/production/ops", (_req, res) => res.json({ ok: true, production: { ...largeProduction, revision: 2, replayed: false } }));
  let productionBlocked = true, productionSubmissions = 0, simulateProductionRace = false;
  const productionIssue = { code: "TARGET_AWAITING_REVIEW", path: "request.targets", message: "Original image needs review", severity: "error", blockingRun: { runId: "original", status: "awaiting_review", taskIds: ["original-task"] }, nextAction: { action: "review", message: "Read the existing run", tool: "drama_get_production_batch", input: { episodeId: "guarded", runId: "original" } } };
  backend.post(["/drama/episodes/guarded/production/preflight", "/canvas/projects/guarded/production/preflight"], (_req, res) => res.json({ ok: true, preflight: { valid: !productionBlocked, diagnostics: productionBlocked ? [productionIssue] : [], nextActions: productionBlocked ? [productionIssue.nextAction] : [] } }));
  backend.post(["/drama/episodes/guarded/production/compile", "/drama/episodes/guarded/production/runs", "/canvas/projects/guarded/production/runs"], (_req, res) => {
    productionSubmissions++;
    if (simulateProductionRace) return void res.status(400).json({ ok: false, code: productionIssue.code, error: productionIssue.message, diagnostics: [productionIssue], nextActions: [productionIssue.nextAction] });
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
  assert.equal(client.getServerVersion()?.version, "0.1.0+mcp2");
  assert.equal(secondClient.getServerVersion()?.version, "0.1.0+mcp2");
  assert.ok(secondCatalog.tools.some(entry => entry.name === "mcp_get_command_receipt"));
  const tool = (name: string) => catalog.tools.find(entry => entry.name === name)!;
  assert.ok(tool("mcp_get_command_receipt"));
  assert.ok(tool("assets_get"));
  for (const name of ["production_compile", "production_get_compilation", "production_apply_compilation", "production_diagnose_bindings"]) assert.ok(tool(name));
  assert.ok((tool("production_compile").inputSchema as any).required.includes("expectedRevision"));
  const productionCalls = [
    { name: "production_compile", arguments: { kind: "episode", id: "guarded", expectedRevision: 1, operationId: "compile-original" } },
    { name: "drama_start_production_run", arguments: { episodeId: "guarded", expectedRevision: 1, version: 1, runId: "new", idempotencyKey: "new", targets: ["asset:STYLE_MOTHER"] } },
    { name: "canvas_start_production_run", arguments: { projectId: "guarded", expectedRevision: 1, version: 1, runId: "new", idempotencyKey: "new", targets: ["asset:STYLE_MOTHER"] } },
  ];
  for (const call of productionCalls.slice(1)) {
    const result = await client.callTool(call);
    assert.equal(result.isError, undefined);
    const blocked = JSON.parse(textOf(result));
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.mediaSubmitted, false);
    assert.deepEqual(blocked.preflight.nextActions[0].input, { episodeId: "guarded", runId: "original" });
  }
  assert.equal(productionSubmissions, 0, "blocked preflights must never reach a compile/start endpoint");
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
  assert.equal(race.suggestedAction.tool, "drama_get_production_batch");
  assert.equal(productionSubmissions, 2);
  assert.ok((tool("production_apply_compilation").inputSchema as any).required.includes("preparedId"));
  const largeRead = await client.callTool({ name: "canvas_get_production", arguments: { projectId: "large" } });
  assert.equal(largeRead.isError, undefined);
  assert.ok(textOf(largeRead).length < 5000);
  assert.equal(JSON.parse(textOf(largeRead)).production.revision, 1);
  const largeWrite = await client.callTool({ name: "canvas_edit_production", arguments: { projectId: "large", operationId: "large-write", expectedRevision: 1, ops: [{ type: "set_director_brief", brief: "sample" }] } });
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
  const receiptValue = JSON.parse(textOf(receipt));
  assert.equal(receiptValue.found, true);
  assert.equal(receiptValue.status, "committed");
  assert.equal("payload" in receiptValue, false);
  const crossSessionReceipt = await secondClient.callTool({ name: "mcp_get_command_receipt", arguments: { operationId: "asset-add-v2-1" } });
  assert.equal(JSON.parse(textOf(crossSessionReceipt)).status, "committed");

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
  assert.equal(reportValue.runtime.mcpContractVersion, 2);
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
