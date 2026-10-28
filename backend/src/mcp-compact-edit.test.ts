import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { productionOperationContract } from "@basketikun/canvas-agent/drama/production-validation";
import { projectProductionRead } from "@basketikun/canvas-agent/drama/production-contract";
import { toolInputSchemas } from "@basketikun/canvas-agent/schemas";
import { KNOWN_FIRST_PARTY } from "@basketikun/canvas-agent/plugin-mcp";
import { BackendDatabase } from "./db.js";
import { EpisodeProductionService } from "./drama/production.js";
import { registerBackendMcpHttpRoutes } from "./mcp.js";

function value(result: any) {
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
}

async function fixture(t: TestContext, mode: "full" | "compact" | "default") {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-compact-"));
    const db = new BackendDatabase(":memory:");
    db.upsertCanvasFolder({ id: "drama", name: "Fixture", createdAt: "2026-01-01", isDrama: true });
    db.createCanvasProject({ id: "canvas", title: "Fixture", revision: 0, nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: "e", dramaId: "drama", episodeNumber: 1, title: "Fixture", synopsis: "", fullPlot: "", canvasId: "canvas" });
    const service = new EpisodeProductionService(db, undefined, root);
    let writes = 0;
    const events: any[] = [];
    const app = express(); app.use(express.json());
    app.get("/plugins/mcp", (_req, res) => res.json({ declarations: [{ id: "minimax-h3", enabled: true, version: KNOWN_FIRST_PARTY["minimax-h3"].version, tools: [] }] }));
    app.post("/mcp/observability/events", (req, res) => { events.push(req.body); res.json({ ok: true }); });
    app.get("/production/contract", (req, res) => res.json(productionOperationContract(String(req.query.operationType), { patchFields: req.query.includePatchFields === "true" })));
    app.get("/drama/episodes/e/production", (req, res) => res.json({ ok: true, production: projectProductionRead(service.get("e"), req.query) }));
    app.post("/drama/episodes/e/production/ops", async (req, res) => {
        writes++;
        try { res.json({ ok: true, production: await service.edit("e", req.body) }); }
        catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const routes = registerBackendMcpHttpRoutes(app, { url, token: "fixture", port: 0, origins: [] });
    const client = new Client({ name: `compact-benchmark-${mode}`, version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp?profile=production${mode === "default" ? "" : `&schema=${mode}`}`));
    t.after(async () => { await client.close(); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid temporary root"); await fs.rm(root, { recursive: true, force: true }); });
    await client.connect(transport);
    const call = (name: string, input: Record<string, unknown>) => client.callTool({ name, arguments: input });
    return { client, call, transport, url, events, service, writes: () => writes };
}

for (const mode of ["compact", "default"] as const) test(`${mode} edit retains strict business validation, exact input and original operation replay`, async t => {
    const f = await fixture(t, mode);
    const listed = (await f.client.listTools()).tools.find(tool => tool.name === "production_edit")!;
    assert.match(listed.description!, /精简声明/);
    const before = f.service.get("e").revision;
    const invalid = await f.call("production_edit", { kind: "episode", id: "e", operationId: "invalid", expectedRevision: before, ops: [{ type: "set_settings", patch: { parallelScenes: "invalid-boolean" } }] });
    assert.equal(invalid.isError, true);
    const failure = JSON.parse((invalid.content as any)[0].text);
    assert.equal(failure.error.code, "INVALID_INPUT");
    assert.equal(failure.suggestedAction.tool, "production_get_contract");
    assert.deepEqual(failure.suggestedAction.input, { operationType: "set_settings" });
    toolInputSchemas.production_get_contract.parse(failure.suggestedAction.input);
    assert.equal(f.writes(), 0);
    assert.equal(f.service.get("e").revision, before);
    const request = { kind: "episode", id: "e", operationId: "stable", expectedRevision: before, ops: [{ type: "set_settings", patch: { parallelScenes: false, videoAspectRatio: "16:9" } }] };
    value(await f.call("production_edit", request));
    assert.equal(f.service.get("e").draft.settings.parallelScenes, false);
    assert.equal(f.service.get("e").draft.settings.videoAspectRatio, "16:9");
    const committed = f.service.get("e").revision;
    const replay = value(await f.call("production_edit", request));
    assert.equal(replay.production.replayed, true);
    assert.equal(f.service.get("e").revision, committed);
    const fullClient = new Client({ name: "cross-schema-replay", version: "1" });
    t.after(() => fullClient.close());
    await fullClient.connect(new StreamableHTTPClientTransport(new URL(f.url + "/mcp?profile=production&schema=full")));
    const crossMode = value(await fullClient.callTool({ name: "production_edit", arguments: request }));
    assert.equal(crossMode.production.replayed, true);
    assert.equal(f.service.get("e").revision, committed);
    const successEvents = f.events.filter(event => event.tool === "production_edit" && event.event === "tool.succeeded");
    assert.equal(new Set(successEvents.map(event => event.inputSummary.schemaHash)).size, 2, "schema fingerprints must separate the two disclosures");
    const direct = await fetch(f.url + "/drama/episodes/e/production/ops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...request, operationId: "direct-invalid", expectedRevision: committed, ops: [{ type: "set_settings", patch: { parallelScenes: "invalid-boolean" } }] }) });
    assert.equal(direct.status, 400);
    assert.equal(f.service.get("e").revision, committed);
    const mismatch = await fetch(f.url + "/mcp?profile=production&schema=full", { method: "POST", headers: { "Content-Type": "application/json", "mcp-session-id": f.transport.sessionId! }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
    assert.equal(mismatch.status, 400);
    const badMode = await fetch(f.url + "/mcp?schema=typo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize" }) });
    assert.equal(badMode.status, 400);
    assert.ok(f.events.some(event => event.inputSummary?.schemaMode === "compact"));
});

test("cold and reused-contract edit costs are measured for identical business results", async t => {
    const samples: Array<Record<string, any>> = [];
    for (const mode of ["full", "compact"] as const) {
        const f = await fixture(t, mode);
        const started = performance.now();
        const list = await f.client.listTools();
        const catalogBytes = Buffer.byteLength(JSON.stringify(list.tools));
        const editBytes = Buffer.byteLength(JSON.stringify(list.tools.find(tool => tool.name === "production_edit")));
        const cold: any[] = [list];
        // An unfamiliar nested operation reads one real, canonical operation contract.
        if (mode === "compact") cold.push(await f.call("production_get_contract", { operationType: "set_settings" }));
        cold.push(await f.call("production_edit", { kind: "episode", id: "e", operationId: "cold", expectedRevision: 0, ops: [{ type: "set_settings", patch: { parallelScenes: false } }] }));
        cold.push(await f.call("production_get_source", { kind: "episode", id: "e", sourceSection: "settings" }));
        for (const item of cold.slice(1)) value(item);
        const coldMs = Math.round(performance.now() - started);
        const warmStarted = performance.now();
        const warm = [await f.call("production_edit", { kind: "episode", id: "e", operationId: "warm", expectedRevision: f.service.get("e").revision, ops: [{ type: "set_settings", patch: { parallelScenes: true } }] }), await f.call("production_get_source", { kind: "episode", id: "e", sourceSection: "settings" })];
        warm.forEach(value);
        assert.equal(f.service.get("e").draft.settings.parallelScenes, true);
        assert.equal(f.service.get("e").revision, 2);
        samples.push({ mode, catalogBytes, editBytes, cold: { calls: cold.length, bytes: cold.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0), elapsedMs: coldMs }, warm: { calls: warm.length, bytes: warm.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0), elapsedMs: Math.round(performance.now() - warmStarted) } });
    }
    assert.ok(samples[1].editBytes < samples[0].editBytes * 0.6);
    assert.ok(samples[1].cold.bytes < samples[0].cold.bytes);
    assert.equal(samples[1].warm.calls, samples[0].warm.calls);
    console.log(JSON.stringify({ scenario: "canonical-settings-edit-and-readback", includesHandshake: false, samples }));
});
