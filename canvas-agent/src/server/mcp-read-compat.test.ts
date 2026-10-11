import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removedToolMigrations } from "../canvas/tool-migrations.js";

test("Agent HTTP forwards historical views and Backend export references", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-mcp-compat-"));
    const originalDir = process.env.INFINITE_CANVAS_AGENT_CONFIG_DIR;
    process.env.INFINITE_CANVAS_AGENT_CONFIG_DIR = root;
    t.after(async () => { if (originalDir === undefined) delete process.env.INFINITE_CANVAS_AGENT_CONFIG_DIR; else process.env.INFINITE_CANVAS_AGENT_CONFIG_DIR = originalDir; await fs.rm(root, { recursive: true, force: true }); });
    const { createAgentApp } = await import("./http.js");
    const backend = express(); backend.use(express.json()); let businessRequests = 0;
    backend.use((req, _res, next) => { if (!req.path.startsWith("/agent") && req.path.startsWith("/canvas/projects") || req.path.startsWith("/drama/")) businessRequests++; next(); });
    backend.get("/plugins/mcp", (_req, res) => res.json({ ok: true, declarations: [] }));
    backend.get("/drama/episodes/e/production", (req, res) => {
        assert.equal(req.query.ifRevision, "7");
        assert.equal(req.query.view, "source");
        assert.equal(req.query.sourceSection, "segments");
        res.json({ ok: true, production: { revision: 7, unchanged: true } });
    });
    backend.get(["/drama/episodes/e/production/versions/2", "/canvas/projects/c/production/versions/2", "/drama/scenes/s/production/versions/2"], (req, res) => {
        assert.equal(req.headers.authorization, "Bearer fixture");
        assert.equal(req.query.view, "summary");
        res.json({ ok: true, version: { version: 2, snapshot: { view: "summary" } } });
    });
    backend.post("/canvas/projects/c/mcp-export", (req, res) => {
        assert.equal(req.headers.authorization, "Bearer fixture");
        res.json({ ok: true, export: { projectId: "c", revision: 2, sha256: "fixed", downloadPath: "/mcp/exports/fixed" } });
    });
    backend.post("/director/subagents", (req, res) => {
        assert.equal(req.headers.authorization, "Bearer fixture");
        assert.equal(req.body.parentThreadId, "director-thread");
        assert.equal(req.body.view, "summary");
        res.json({ ok: true, task: { taskId: "child", status: "queued" }, replayed: false });
    });
    const server = backend.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const agent = createAgentApp({ listen: false, backendUrl: url, backendToken: "fixture" });
    backend.use("/agent", agent.app);
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const call = async (name: string, input: Record<string, unknown>) => {
        const res = await fetch(`${url}/agent/api/tools`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, input }) });
        assert.equal(res.status, 200); return await res.json() as any;
    };
    for (const [name, input] of [["production_get_version", { kind: "episode", id: "e", version: 2 }], ["production_get_version", { kind: "canvas", id: "c", version: 2 }], ["production_get_scene_version", { sceneId: "s", version: 2 }]] as const) {
        assert.equal((await call(name, input)).result.version.snapshot.view, "summary");
    }
    assert.equal((await call("production_get", { kind: "episode", id: "e", view: "source", sourceSection: "segments", ifRevision: 7 })).result.production.unchanged, true);
    assert.equal((await call("canvas_export_snapshot", { projectId: "c" })).result.export.projectId, "c");
    assert.equal((await call("director_subagent", { action: "spawn", projectId: "c", parentThreadId: "director-thread", operationId: "stable", title: "分镜核对", role: "shots", prompt: "只核对已有源稿" })).result.task.taskId, "child");
    const priorRequests = businessRequests;
    for (const name of Object.keys(removedToolMigrations)) {
        const response = await fetch(`${url}/agent/api/tools`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, input: {} }) });
        assert.equal(response.status, 400);
        const notice: any = await response.json(); assert.equal(notice.code, "TOOL_REMOVED"); assert.equal(notice.migration.replacement, removedToolMigrations[name].replacement);
    }
    assert.equal(businessRequests, priorRequests, "retired calls must never be forwarded");
});
