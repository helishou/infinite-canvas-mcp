import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BackendDatabase } from "./db.js";
import { startServer } from "./server.js";
import { registerBackendMcpHttpRoutes } from "./mcp.js";
import { KNOWN_FIRST_PARTY } from "@basketikun/canvas-agent/plugin-mcp";
import express from "express";
import { toolInputSchemas } from "@basketikun/canvas-agent/schemas";

function value(result: any) {
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content.find((item: any) => item.type === "text").text);
}

test("HTTP MCP lightweight reads preserve media identity, selection and batch snapshot semantics", async t => {
    const originalToken = process.env.INFINITE_CANVAS_BACKEND_TOKEN;
    process.env.INFINITE_CANVAS_BACKEND_TOKEN = "fixture";
    t.after(() => { if (originalToken === undefined) delete process.env.INFINITE_CANVAS_BACKEND_TOKEN; else process.env.INFINITE_CANVAS_BACKEND_TOKEN = originalToken; });
    const db = new BackendDatabase(":memory:");
    const largeText = "private prompt 中文".repeat(3000);
    db.createCanvasProject({ id: "efficient", title: "Read fixture", revision: 0, nodes: [
        { id: "actor", type: "character", title: "Actor", metadata: { content: "data:image/png;base64,secret", storageKey: "old-cover", characterPrimaryIndex: 1,
            characterImages: [{ storageKey: "image:first" }, { storageKey: "image:selected", width: 768, height: 1024 }], prompt: largeText, history: [largeText] } },
        { id: "scene", type: "scene", metadata: { sceneImage: { storageKey: "image:scene", width: 1920 }, storageKey: "wrong-scene" } },
        { id: "generator", type: "image", metadata: { smart: true, generationMode: "image", model: "fixture", generateAudio: false, seed: 0, prompt: largeText } },
        ...Array.from({ length: 10 }, (_, i) => ({ id: `filler-${i}`, type: "image", title: `Filler ${i}`, metadata: {} })),
        { id: "h3", type: "minimax-h3:video", metadata: { segments: Array.from({ length: 10 }, (_, i) => ({ id: `clip-${i}`, prompt: largeText, duration: 4, modelName: "fixture", status: "idle", referenceBindings: [] })) } },
    ], selectedNodeIds: ["h3"], connections: [{ id: "edge", fromNodeId: "actor", toNodeId: "h3" }] });
    db.replacePluginDeclarations([{ id: "minimax-h3", enabled: true, version: KNOWN_FIRST_PARTY["minimax-h3"].version, tools: [] }]);
    const config = { url: "http://127.0.0.1", port: 0, token: "fixture", origins: ["*"] };
    const { app } = startServer(db, config);
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const routes = registerBackendMcpHttpRoutes(app, { ...config, url });
    const client = new Client({ name: "efficient-reads", version: "1" });
    t.after(async () => { await client.close(); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const catalog = (await client.listTools()).tools;
    assert.ok(catalog.find(tool => tool.name === "canvas_get_state")!.inputSchema.properties!.projection);
    assert.ok(catalog.find(tool => tool.name === "h3_get_clip")!.inputSchema.properties!.segmentIds);
    const fullResult = await call("canvas_get_state", { projectId: "efficient", nodeIds: ["actor"] });
    assert.ok(value(fullResult).nodes[0].metadata.history);
    assert.equal(value(fullResult).connections.length, 1);
    const lightResult = await call("canvas_get_state", { projectId: "efficient", nodeIds: ["actor", "scene", "missing"], projection: "media" });
    const light = value(lightResult);
    assert.equal(light.nodes[0].media.storageKey, "image:selected");
    assert.equal(light.nodes[0].media.naturalWidth, 768);
    assert.equal(light.nodes[1].media.storageKey, "image:scene");
    assert.deepEqual(light.missingNodeIds, ["missing"]);
    assert.equal(light.connections, undefined);
    assert.ok(!JSON.stringify(light).includes("private prompt"));
    const sizes = { fullBytes: Buffer.byteLength(JSON.stringify(fullResult)), mediaBytes: Buffer.byteLength(JSON.stringify(lightResult)) };
    assert.ok(sizes.mediaBytes < sizes.fullBytes * 0.2);
    const gen = value(await call("canvas_get_state", { projectId: "efficient", nodeIds: ["generator"], projection: "generation" }));
    assert.equal(gen.nodes[0].generation.generateAudio, false);
    assert.equal(gen.nodes[0].generation.seed, 0);
    assert.equal((await call("canvas_get_state", { projectId: "efficient", projection: "media" })).isError, true);
    const context = value(await call("canvas_inspect", { projectId: "efficient", view: "context", nodeLimit: 1 }));
    assert.deepEqual(context.selection.map((node: any) => node.id), ["h3"]);
    assert.equal(context.capabilities, undefined);
    assert.equal(context.nodes, undefined);
    db.createCanvasProject({ id: "oversized", title: "Full read fixture", revision: 0, nodes: [{ id: "large", type: "image", metadata: { prompt: "中文".repeat(150000) } }], connections: [] });
    const overflow: any = await call("canvas_get_state", { projectId: "oversized", nodeIds: ["large"], projection: "full" });
    assert.equal(overflow.isError, true);
    assert.equal(JSON.parse(overflow.content[0].text).error.code, "OUTPUT_TOO_LARGE");
    const invalid = await fetch(url + "/canvas/projects/efficient?view=nodes&projection=unknown", { headers: { Authorization: "Bearer fixture" } });
    assert.equal(invalid.status, 400);

    let snapshotReads = 0;
    const original = db.getCanvasProjectH3Context.bind(db);
    db.getCanvasProjectH3Context = (...args) => { snapshotReads++; return original(...args); };
    const start = performance.now();
    const batchResult = await call("h3_get_clip", { projectId: "efficient", nodeId: "h3", segmentIds: ["clip-2", "clip-0", "clip-2", "absent"], include: ["runtime"] });
    const batch = value(batchResult);
    assert.equal(snapshotReads, 1);
    assert.deepEqual(batch.items.map((item: any) => item.segmentId), ["clip-2", "clip-0"]);
    assert.deepEqual(batch.missingSegmentIds, ["absent"]);
    assert.equal(batch.items[0].runtime.modelName, "fixture");
    assert.ok(!JSON.stringify(batch).includes("private prompt"));
    const single = value(await call("h3_get_clip_runtime", { projectId: "efficient", nodeId: "h3", segmentId: "clip-0", view: "saved" }));
    assert.equal(single.runtime.modelName, "fixture");
    assert.equal(single.planHash, undefined);
    assert.equal((await call("h3_get_clip", { projectId: "efficient", nodeId: "h3", segmentId: "clip-0", segmentIds: ["clip-0"] })).isError, true);
    assert.equal((await call("h3_get_clip", { projectId: "efficient", nodeId: "h3", segmentIds: ["clip-0"], include: ["references"] })).isError, true);
    const same = value(await call("h3_get_clip", { projectId: "efficient", nodeId: "h3", segmentIds: ["clip-0"], ifRevision: batch.revision, fields: ["prompt"] }));
    assert.equal(same.items[0].unchanged, true);
    assert.equal(same.items[0].fields, undefined);
    const ids = Array.from({ length: 10 }, (_, i) => `clip-${i}`);
    const read = await call("h3_get_clip", { projectId: "efficient", nodeId: "h3", segmentIds: ids, include: ["runtime"] });
    const writeInput = { projectId: "efficient", nodeId: "h3", operationId: "efficient-batch", expectedRevision: value(read).revision, updates: ids.map(segmentId => ({ segmentId, patch: { seed: 123 } })) };
    const write = await call("h3_update_clips", writeInput);
    value(write);
    const check = await call("h3_get_clip", { projectId: "efficient", nodeId: "h3", segmentIds: ids, include: ["runtime"] });
    assert.ok(value(check).items.every((item: any) => item.runtime.seed === 123));
    const committedRevision = value(check).revision;
    assert.equal(value(await call("h3_update_clips", writeInput)).replayed, true);
    assert.equal(db.getCanvasProject("efficient")!.revision, committedRevision);
    console.log(JSON.stringify({ scenario: "10-clip-edit", calls: 3, totalBytes: [read, write, check].reduce((sum, result) => sum + Buffer.byteLength(JSON.stringify(result)), 0) }));
    console.log(JSON.stringify({ scenario: "same-media-query", calls: { legacy: 1, projected: 1 }, ...sizes, batchBytes: Buffer.byteLength(JSON.stringify(batchResult)), batchReadCalls: 1, elapsedMs: Math.round(performance.now() - start) }));
});

test("artifact recovery preserves owner identity and produces valid next-tool input", async t => {
    const app = express(); app.use(express.json());
    app.get("/plugins/mcp", (_req, res) => res.json({ declarations: [] }));
    app.get("/drama/episodes/e/production", (_req, res) => res.status(404).json({ code: "ARTIFACT_NOT_FOUND", error: "no artifact was selected" }));
    app.post("/mcp/observability/events", (_req, res) => res.json({ ok: true }));
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const routes = registerBackendMcpHttpRoutes(app, { url, token: "fixture", port: 0, origins: [] });
    const client = new Client({ name: "recovery-fixture", version: "1" });
    t.after(async () => { await client.close(); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
    const result: any = await client.callTool({ name: "production_get_artifact", arguments: { kind: "episode", id: "e", targetId: "absent", snapshot: "published" } });
    assert.equal(result.isError, true);
    const error = JSON.parse(result.content[0].text);
    const next = error.suggestedAction || error.error?.suggestedAction;
    assert.equal(next.tool, "production_get_artifact_index");
    assert.deepEqual(next.input, { kind: "episode", id: "e", snapshot: "published" });
    toolInputSchemas.production_get_artifact_index.parse(next.input);
});
