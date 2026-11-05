import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KNOWN_FIRST_PARTY } from "@basketikun/canvas-agent/plugin-mcp";
import { BackendDatabase } from "./db.js";
import { EpisodeProductionService } from "./drama/production.js";
import { registerDramaProductionRoutes } from "./server/drama-production-routes.js";
import { registerBackendMcpHttpRoutes } from "./mcp.js";

const source = {
    shots: [{ id: "S27", title: "病猪与卖粮的解释", duration_frames: 132, story_order: 0 }, { id: "S39", title: "停雨威胁", duration_frames: 192, story_order: 1 }],
    segments: [{ id: "stable-explanation", shot_ids: ["S27"] }, { id: "E2-CLIP-11", shot_ids: ["S39"] }],
};

test("HTTP MCP catalog and workbench calls resolve page ordinals and retain stable identities after insertion", async t => {
    const db = new BackendDatabase(":memory:");
    const service = new EpisodeProductionService(db);
    const saved = { episodeId: "ep", revision: 1, draft: { director: { source: structuredClone(source) } } };
    (service as any).getForRead = () => structuredClone(saved);
    (service as any).clipWorkbench = (_id: string, targetId: string) => ({ ...structuredClone(saved), clipWorkbench: { segment: saved.draft.director.source.segments.find(clip => clip.id === targetId) } });
    (service as any).shotWorkbench = (_id: string, targetId: string) => ({ ...structuredClone(saved), shotWorkbench: { shot: saved.draft.director.source.shots.find(shot => shot.id === targetId) } });
    const app = express(); app.use(express.json());
    app.get("/plugins/mcp", (_req, res) => res.json({ declarations: [{ id: "minimax-h3", enabled: true, version: KNOWN_FIRST_PARTY["minimax-h3"].version, tools: [] }] }));
    app.post("/mcp/observability/events", (_req, res) => res.json({ ok: true }));
    registerDramaProductionRoutes(app, service);
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const routes = registerBackendMcpHttpRoutes(app, { url, token: "fixture", port: 0, origins: [] });
    const client = new Client({ name: "numbering-test", version: "1" });
    t.after(async () => { await client.close(); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
    const catalog = await client.listTools();
    assert.ok(catalog.tools.find(tool => tool.name === "production_get_workbench")!.inputSchema.properties!.clipNumber);
    const call = async (name: string, input: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: { kind: "episode", id: "ep", ...input } });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        return JSON.parse((result.content as any[])[0].text).production;
    };
    const first = await call("production_get_workbench", { view: "shot_workbench", clipNumber: 1, shotInClip: 1 });
    assert.equal(JSON.parse(first.chunk.text).shot.id, "S27");
    assert.equal(first.numbering.memberships[0].segmentId, "stable-explanation");
    const directory = await call("production_get", { view: "numbering", pageSize: 1 });
    assert.equal(directory.numbering.items[0].clipNumber, 1);
    saved.draft.director.source.segments.unshift({ id: "inserted", shot_ids: [] }); saved.revision++;
    const shifted = await call("production_get_workbench", { view: "clip_workbench", clipNumber: 2 });
    assert.equal(JSON.parse(shifted.chunk.text).segment.id, "stable-explanation");
    const stable = await call("production_get_workbench", { view: "clip_workbench", targetId: "stable-explanation" });
    assert.equal(stable.numbering.clipNumber, 2);
    const conflict = await client.callTool({ name: "production_get_workbench", arguments: { kind: "episode", id: "ep", view: "clip_workbench", targetId: "E2-CLIP-11", clipNumber: 1 } });
    assert.equal(conflict.isError, true);
});

test("H3 summary maps physical order to live source ordinals without rewriting canvas or old IDs", () => {
    const db = new BackendDatabase(":memory:");
    try {
        db.createCanvasProject({ id: "canvas", title: "Test", nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { segments: [
            { id: "physical-threat", productionClipProjection: { targetId: "E2-CLIP-11" } },
            { id: "physical-explanation", productionClipProjection: { targetId: "stable-explanation" } },
        ] } }], connections: [] });
        db.db.prepare("INSERT INTO canvas_productions(project_id,revision,draft_json,published_version,updated_at) VALUES(?,?,?,?,?)")
            .run("canvas", 1, JSON.stringify({ director: { source } }), 0, new Date().toISOString());
        const before = db.getCanvasProject("canvas");
        const clips = () => ((db.getCanvasH3NodeSummary("canvas", "h3") as any).nodes[0].metadata.segments);
        assert.equal(clips()[0].productionNumbering.clipNumber, 2);
        assert.equal(clips()[1].productionNumbering.clipNumber, 1);
        const changed = { ...source, segments: [...source.segments].reverse() };
        db.db.prepare("UPDATE canvas_productions SET draft_json=?,revision=2 WHERE project_id=?").run(JSON.stringify({ director: { source: changed } }), "canvas");
        assert.equal(clips()[0].productionNumbering.clipNumber, 1);
        assert.deepEqual(db.getCanvasProject("canvas"), before);
    } finally { db.close(); }
});
