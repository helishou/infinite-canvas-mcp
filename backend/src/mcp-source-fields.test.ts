import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KNOWN_FIRST_PARTY } from "@basketikun/canvas-agent/plugin-mcp";
import { BackendDatabase } from "./db.js";
import { EpisodeProductionService } from "./drama/production.js";
import { registerDramaProductionRoutes } from "./server/drama-production-routes.js";
import { registerBackendMcpHttpRoutes } from "./mcp.js";

function value(result: any) { assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); }

test("HTTP source fields reduce a targeted read without fetching hidden canvas context and preserve history/scene routes", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-fields-"));
    const db = new BackendDatabase(":memory:");
    const service = new EpisodeProductionService(db, undefined, root);
    const privateText = "private-authored-performance😀".repeat(2500);
    const saved = { episodeId: "e", revision: 7, publishedVersion: 1, draft: { director: { sourceHash: "a".repeat(64), artifacts: [], source: {
        version: 2, prompt_assembly: { version: 2 }, ledger: { contract_version: 2 },
        shots: [{ id: "shot", duration_frames: 96, camera: { framing: "wide" }, performance: privateText }],
        segments: [{ id: "clip", shot_ids: ["shot"] }],
    } } } };
    (service as any).getForRead = () => structuredClone(saved);
    (service as any).version = () => ({ version: 1, snapshot: saved.draft, createdAt: "saved", stage: "director" });
    let runtimeReads = 0;
    (service as any).targetOccupancy = () => { runtimeReads++; return []; };
    (service as any).canvasEditorialState = () => { runtimeReads++; return { privateCanvas: privateText }; };
    const app = express(); app.use(express.json());
    app.get("/plugins/mcp", (_req, res) => res.json({ declarations: [{ id: "minimax-h3", enabled: true, version: KNOWN_FIRST_PARTY["minimax-h3"].version, tools: [] }] }));
    app.post("/mcp/observability/events", (_req, res) => res.json({ ok: true }));
    app.get("/drama/episodes/old/production", (_req, res) => res.json({ production: { source: { privateBody: privateText } } }));
    registerDramaProductionRoutes(app, service);
    registerDramaProductionRoutes(app, service, undefined, "/drama/scenes/:episodeId/production");
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const routes = registerBackendMcpHttpRoutes(app, { url, token: "fixture", port: 0, origins: [] });
    const client = new Client({ name: "source-fields-fixture", version: "1" });
    t.after(async () => { await client.close(); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid temporary root"); await fs.rm(root, { recursive: true, force: true }); });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
    const call = (name: string, input: Record<string, unknown>) => client.callTool({ name, arguments: input });
    const catalog = await client.listTools();
    assert.ok(catalog.tools.find(tool => tool.name === "production_get_source")!.inputSchema.properties!.fields);
    const input = { kind: "episode", id: "e", sourceSection: "shots", targetIds: ["shot"] };
    const started = performance.now();
    const full = await call("production_get_source", input);
    const fullBody = value(full).production;
    assert.equal(fullBody.source.items[0].performance, privateText);
    assert.ok(fullBody.canvasInputs);
    const before = runtimeReads;
    const light = await call("production_get_source", { ...input, fields: ["duration_frames", "camera"] });
    const projected = value(light).production;
    assert.deepEqual(projected.source.items, [{ id: "shot", camera: { framing: "wide" }, duration_frames: 96 }]);
    assert.equal(projected.partialSource, true);
    assert.equal(projected.canvasInputs, undefined);
    assert.equal(projected.targetStatus, undefined);
    assert.equal(projected.clipRefreshes, undefined);
    assert.equal(runtimeReads, before);
    assert.deepEqual(projected.targetClipMappings, [{ shotId: "shot", segmentIds: ["clip"] }]);
    const fullBytes = Buffer.byteLength(JSON.stringify(full)), fieldBytes = Buffer.byteLength(JSON.stringify(light));
    assert.ok(fieldBytes < fullBytes * 0.1);
    const history = value(await call("production_get_version_source", { ...input, version: 1, fields: ["camera"] }));
    assert.deepEqual(history.version.snapshot.source.items[0], { id: "shot", camera: { framing: "wide" } });
    const scene = value(await call("production_get_scene_production", { sceneId: "s", view: "source", sourceSection: "shots", fields: ["duration_frames"] }));
    assert.deepEqual(scene.production.source[0], { id: "shot", duration_frames: 96 });
    const sceneVersion = value(await call("production_get_scene_version", { sceneId: "s", version: 1, view: "source", sourceSection: "shots", fields: ["camera"] }));
    assert.deepEqual(sceneVersion.version.snapshot.source[0], { id: "shot", camera: { framing: "wide" } });
    const old: any = await call("production_get_source", { ...input, id: "old", fields: ["camera"] });
    assert.equal(old.isError, true);
    assert.equal(JSON.parse(old.content[0].text).error.code, "SOURCE_FIELDS_UNSUPPORTED");
    assert.equal(JSON.parse(old.content[0].text).error.recoverable, true);
    assert.equal(JSON.parse(old.content[0].text).error.retryPolicy, "after_input_change");
    assert.match(JSON.stringify(old.content), /SOURCE_FIELDS_UNSUPPORTED/);
    assert.ok(!JSON.stringify(old).includes("private-authored-performance"));
    const invalid = await fetch(url + "/drama/episodes/e/production/versions/1?fields=%5B%22camera%22%5D");
    assert.equal(invalid.status, 400);
    const bytes = Buffer.byteLength(JSON.stringify(catalog));
    console.log(JSON.stringify({ scenario: "same-shot-camera-and-duration-read", calls: { full: 1, fields: 1 }, fullBytes, fieldBytes, coldFullBytes: bytes + fullBytes, coldFieldBytes: bytes + fieldBytes, elapsedMs: Math.round(performance.now() - started), hiddenRuntimeReads: runtimeReads - before }));
});
