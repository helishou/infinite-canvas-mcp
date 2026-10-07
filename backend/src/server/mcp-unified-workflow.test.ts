import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";
import { EpisodeProductionService } from "../drama/production.js";
import { registerDramaProductionRoutes } from "./drama-production-routes.js";
import { registerBackendMcpHttpRoutes } from "../mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("unified MCP keeps same-ID owners isolated across sessions and completes edit/check/publish/read/recover without generation", async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "unified-production-"));
    const priorToken = process.env.INFINITE_CANVAS_BACKEND_TOKEN; process.env.INFINITE_CANVAS_BACKEND_TOKEN = "fixture";
    const db = new BackendDatabase(path.join(temporary, "fixture.sqlite"));
    db.upsertCanvasFolder({ id: "drama", name: "fixture", isDrama: true, createdAt: new Date().toISOString() });
    for (const id of ["same", "episode-canvas", "unrelated"]) db.createCanvasProject({ id, title: id, revision: 0, nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: "same", dramaId: "drama", episodeNumber: 1, title: "episode", synopsis: "", canvasId: "episode-canvas" });
    const config = { url: "http://127.0.0.1", token: "fixture", port: 0, origins: [] };
    const { app, stores } = startServer(db, config);
    const episode = new EpisodeProductionService(db, undefined, temporary);
    const canvas = new EpisodeProductionService(db, undefined, temporary, true);
    registerDramaProductionRoutes(app, episode);
    registerDramaProductionRoutes(app, canvas, undefined, "/canvas/projects/:episodeId/production");
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    config.url = `http://127.0.0.1:${(server.address() as any).port}`;
    const routes = registerBackendMcpHttpRoutes(app, config);
    const clients = [new Client({ name: "episode-session", version: "1" }), new Client({ name: "canvas-session", version: "1" })];
    t.after(async () => {
        await Promise.all(clients.map(client => client.close())); await routes.closeAll(); server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await fs.rm(temporary, { recursive: true, force: true });
        if (priorToken === undefined) delete process.env.INFINITE_CANVAS_BACKEND_TOKEN; else process.env.INFINITE_CANVAS_BACKEND_TOKEN = priorToken;
    });
    await Promise.all(clients.map(client => client.connect(new StreamableHTTPClientTransport(new URL(config.url + "/mcp")))));
    for (const [index, kind] of (["episode", "canvas"] as const).entries()) {
        const client = clients[index], input = { kind, id: "same" }, cost = { calls: 0, bytes: 0, elapsedMs: 0 };
        const call = async (name: string, arguments_: Record<string, unknown>) => {
            const started = performance.now(); const result: any = await client.callTool({ name, arguments: arguments_ });
            cost.calls++; cost.bytes += Buffer.byteLength(JSON.stringify(result)); cost.elapsedMs += performance.now() - started;
            assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text);
        };
        await call("canvas_set_active_project", { id: "unrelated" });
        const initial = await call("production_get", input);
        const edit = { ...input, operationId: `original-${kind}`, expectedRevision: initial.production.revision, ops: [{ type: "upsert_scene", scene: { id: "scene", heading: "内景", location: "房间", timeOfDay: "夜", blocks: [{ id: "block", kind: "action", text: `${kind} 中文\n正文😀` }] } }] };
        const changed = await call("production_edit", edit);
        const replay = await call("production_edit", edit); assert.equal(replay.production.replayed, true);
        const check = await call("production_preflight", { ...input, action: "publish", request: { operationId: `publish-${kind}`, expectedRevision: changed.production.revision, stage: "script" } });
        assert.equal(check.preflight.valid, true);
        const published = await call("production_publish", { ...input, operationId: `publish-${kind}`, expectedRevision: changed.production.revision, stage: "script" });
        const historical = await call("production_get_version", { ...input, version: published.production.publishedVersion, view: "full" });
        assert.equal(historical.version.snapshot.scenes[0].blocks[0].text, `${kind} 中文\n正文😀`);
        await call("production_list_versions", input); await call("production_get_readiness", input);
        const task = stores.tasks.create(`existing-${kind}`, "canvas-image", { projectId: kind === "episode" ? "episode-canvas" : "same", nodeId: "existing" }, {});
        stores.tasks.update(task.id, { status: "succeeded", progress: 1, result: { media: [] } });
        const status = await call("canvas_task_status", { taskId: task.id }); assert.equal(status.tasks[0].taskId, task.id);
        const restored = await call("production_restore", { ...input, operationId: `restore-${kind}`, expectedRevision: published.production.revision, version: published.production.publishedVersion });
        assert.ok(restored.production.revision > published.production.revision);
        console.log(JSON.stringify({ flow: "edit_check_publish_query_restore", kind, ...cost }));
    }
    assert.equal(episode.get("same").draft.scenes[0].blocks[0].text, "episode 中文\n正文😀");
    assert.equal(canvas.get("same").draft.scenes[0].blocks[0].text, "canvas 中文\n正文😀");
    assert.equal(stores.tasks.list().length, 2, "only the explicitly seeded completed tasks may exist");
});
