import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { registerBackendMcpHttpRoutes } from "./mcp.js";
import { KNOWN_FIRST_PARTY } from "@basketikun/canvas-agent/plugin-mcp";
import { productionToolNames } from "@basketikun/canvas-agent/drama/production-tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("MCP exposes only current tools and retired names are unavailable", async t => {
    const app = express(); app.use(express.json()); let writes = 0;
    const canvas: any = { id: "fixture-canvas", title: "Fixture canvas", revision: 0, nodes: [], connections: [] };
    let uploadedBytes = Buffer.alloc(0);
    app.get("/canvas/projects", (_req, res) => res.json({ projects: [{ id: canvas.id, title: canvas.title, revision: canvas.revision, nodeCount: canvas.nodes.length }] }));
    app.get("/canvas/projects/:id", (_req, res) => res.json({ project: canvas }));
    app.post("/media/upload-binary", express.raw({ type: "*/*", limit: "100mb" }), (req, res) => {
        uploadedBytes = Buffer.from(req.body);
        res.status(201).json({ ok: true, media: { storageKey: "image:fixture-turnaround", url: "/media/image%3Afixture-turnaround", bytes: uploadedBytes.length } });
    });
    app.post("/canvas/projects/:id/ops", (req, res) => {
        const operations = req.body.operations || [];
        canvas.nodes.push(...operations.map((op: any) => ({ id: op.id, type: op.nodeType, title: op.title, position: op.position, width: op.width, height: op.height, metadata: op.metadata })));
        canvas.revision++;
        res.json({ ok: true, project: canvas, revision: canvas.revision, operationResults: [] });
    });
    app.get("/plugins/mcp", (_req, res) => res.json({ ok: true, declarations: [{ id: "minimax-h3", enabled: true, version: KNOWN_FIRST_PARTY["minimax-h3"].version, tools: [] }] }));
    app.post("/mcp/observability/events", (_req, res) => res.json({ ok: true }));
    app.post(["/drama/episodes/:id/production/ops", "/canvas/projects/:id/production/ops", "/canvas/projects/:id/ops", "/canvas/generation"], (_req, res) => { writes++; res.json({ ok: true }); });
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const routes = registerBackendMcpHttpRoutes(app, { url, port: 0, token: "fixture", origins: [] });
    const client = new Client({ name: "pruning-fixture", version: "1" });
    t.after(async () => { await client.close(); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
    const catalog = await client.listTools(); const names = new Set(catalog.tools.map(tool => tool.name));
    for (const name of productionToolNames) assert.ok(names.has(name));
    const retiredNames = ["production_list_legacy", "production_preview_continuity_upgrade", "drama_get_production", "canvas_get_production", "canvas_create_text_node", "canvas_create_text_nodes", "canvas_split_image", "canvas_crop_image"];
    assert.ok(names.has("canvas_import_local_images"), "the local-image importer must be exposed as a native MCP tool");
    const importTool = catalog.tools.find(tool => tool.name === "canvas_import_local_images");
    assert.ok(importTool?.inputSchema && "items" in (importTool.inputSchema.properties || {}), "import tool must advertise image items");
    for (const name of retiredNames) {
        assert.equal(names.has(name), false);
    }
    for (const [name, arguments_] of [
        ["canvas_create_node", { projectId: "p", nodeType: "image" }],
        ["canvas_apply_ops", { projectId: "p", operationId: "plain-node-op", expectedRevision: 0, ops: [{ type: "add_node", nodeType: "text", metadata: { content: "plain" } }] }],
        ["canvas_apply_commands", { projectId: "p", operationId: "plain-node-command", baseRevision: 0, operations: [{ type: "add_node", nodeType: "audio", metadata: {} }] }],
    ] as const) {
        const result = await client.callTool({ name, arguments: arguments_ });
        assert.equal(result.isError, true, `${name} must reject ordinary node creation`);
    }
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "canvas-import-test-"));
    t.after(async () => { await rm(tempDir, { recursive: true, force: true }); });
    const imagePath = path.join(tempDir, "turnaround.png");
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    await writeFile(imagePath, imageBytes);
    const importResult = await client.callTool({ name: "canvas_import_local_images", arguments: { items: [{ filePath: imagePath, title: "角色三视图" }], role: "character_turnaround" } });
    assert.notEqual(importResult.isError, true, JSON.stringify(importResult));
    const importReceipt = JSON.parse(String(importResult.content.find((item: any) => item.type === "text")?.text || "{}"));
    assert.equal(importReceipt.projectId, canvas.id, "omitted projectId must resolve to the session's unique active canvas");
    assert.equal(importReceipt.count, 1);
    assert.equal(uploadedBytes.equals(imageBytes), true, "the original attachment bytes must be uploaded unchanged");
    assert.equal(canvas.nodes.length, 1);
    assert.equal(canvas.nodes[0].type, "image");
    assert.equal(canvas.nodes[0].metadata.storageKey, "image:fixture-turnaround");
    assert.equal(canvas.nodes[0].metadata.role, "character_turnaround");
    assert.equal(writes, 0);
    assert.equal(client.getServerVersion()?.version, "0.1.0+mcp3");
    const invalid = await fetch(url + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", "mcp-session-id": "expired" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "h3_update_clip", arguments: {} } }) });
    assert.equal(invalid.status, 404);
    const bytes = Buffer.byteLength(JSON.stringify(catalog.tools));
    assert.ok(bytes < 216777, `catalog must shrink from the observed baseline: ${bytes}`);
    console.log(JSON.stringify({ catalogTools: catalog.tools.length, catalogBytes: bytes, unifiedTools: productionToolNames.length }));
    assert.equal(catalog.tools.length, 156);
    assert.equal(names.size, catalog.tools.length, "catalog names must remain unique");
});
