import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KNOWN_FIRST_PARTY } from "@basketikun/canvas-agent/plugin-mcp";
import { BackendDatabase } from "./db.js";
import { registerBackendMcpHttpRoutes } from "./mcp.js";
import { registerCanvasGenerationRoutes } from "./server/canvas-generation-routes.js";
import { CanvasGenerationService } from "./canvas/generation-service.js";
import { CanvasH3Runner } from "./canvas/h3-runner.js";
import { createStores } from "./stores/index.js";
import { BackendEventBus } from "./events.js";

function payload(result: any) {
    const text = result.content?.find((entry: any) => entry.type === "text")?.text;
    assert.equal(typeof text, "string");
    return JSON.parse(text);
}

async function fixture(t: TestContext) {
    const db = new BackendDatabase(":memory:");
    db.createCanvasProject({ id: "hardening", title: "isolated MCP hardening", revision: 0, connections: [], nodes: [
        { id: "h3", type: "minimax-h3:video", position: { x: 0, y: 0 }, width: 400, height: 300, metadata: { segments: [
            { id: "A", title: "Clip A", duration: 4, taskMode: "ref2va", prompt: "Old <Picture 4>", referenceBindings: [], status: "idle" },
            { id: "B", title: "Clip B", duration: 4, taskMode: "ref2va", prompt: "B", referenceBindings: [], status: "idle" },
        ] } },
        { id: "character", type: "character", title: "Actor", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {
            characterName: "Actor", characterAssetId: "actor-asset", characterImages: [
                { url: "https://media.test/actor.png", storageKey: "image:actor", outfit: "default" },
                { url: "https://media.test/other.png", storageKey: "image:other", outfit: "other" },
            ],
        } },
    ] });
    const writes: any[] = [], events: any[] = [];
    let race = false;
    const api = express(); api.use(express.json());
    const stores = createStores(db), eventBus = new BackendEventBus();
    const runner = new CanvasH3Runner(stores, eventBus, {} as never, {} as never);
    registerCanvasGenerationRoutes(api, new CanvasGenerationService({} as never, runner, stores, eventBus, {} as never, {} as never));
    api.get("/plugins/mcp", (_req, res) => res.json({ ok: true, declarations: [{ id: "minimax-h3", enabled: true, version: KNOWN_FIRST_PARTY["minimax-h3"].version, tools: [] }] }));
    api.post("/mcp/observability/events", (req, res) => { events.push(req.body); res.json({ ok: true }); });
    api.get("/canvas/projects/:id", (req, res) => res.json({ ok: true, project: db.getCanvasProject(req.params.id) }));
    api.get("/canvas/projects/:id/h3-context", (req, res) => {
        const parseIds = (value: unknown) => {
            try { const parsed = JSON.parse(typeof value === "string" ? value : "[]"); return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed as string[] : []; }
            catch { return []; }
        };
        const project = db.getCanvasProjectH3Context(req.params.id, String(req.query.nodeId || ""), typeof req.query.segmentId === "string" ? req.query.segmentId : undefined, { sourceNodeIds: parseIds(req.query.sourceNodeIds), assetIds: parseIds(req.query.assetIds) });
        if (!project) return void res.status(404).json({ ok: false, code: "NODE_NOT_FOUND", error: "H3 节点不存在" });
        res.json({ ok: true, project });
    });
    api.get("/canvas/projects/:id/h3-node-summary", (req, res) => {
        const project = db.getCanvasH3NodeSummary(req.params.id, String(req.query.nodeId || ""));
        if (!project) return void res.status(404).json({ ok: false, code: "NODE_NOT_FOUND", error: "H3 节点不存在" });
        res.json({ ok: true, project });
    });
    api.get("/tasks/:id", (req, res) => {
        const task = db.getTask(req.params.id);
        if (!task) { res.status(404).json({ ok: false, code: "TASK_NOT_FOUND", error: "task not found" }); return; }
        res.json({ ok: true, task, events: taskEvents.get(task.id) || [] });
    });
    const taskEvents = new Map<string, any[]>();
    api.post("/canvas/projects/:id/ops", (req, res) => {
        writes.push(req.body);
        if (race) { race = false; db.applyCanvasProjectOperations("hardening", undefined, [{ type: "update_h3_segment", nodeId: "h3", segmentId: "A", patch: { prompt: "Peer edit" } }]); }
        try { res.json({ ok: true, ...db.applyCanvasProjectOperations(req.params.id, req.body.expectedRevision, req.body.operations, { baseRevision: req.body.baseRevision, operationId: req.body.operationId }) }); }
        catch (error) {
            const detail = error as Error & { code?: string; revision?: number; expectedRevision?: number; conflictTargets?: string[] };
            res.status(detail.code === "REVISION_CONFLICT" ? 409 : 400).json({ ok: false, code: detail.code || "REVISION_CONFLICT", error: detail.message || String(error), ...(detail.revision === undefined ? {} : { revision: detail.revision }), ...(detail.expectedRevision === undefined ? {} : { expectedRevision: detail.expectedRevision }), ...(detail.conflictTargets ? { conflictTargets: detail.conflictTargets } : {}) });
        }
    });
    const apiServer = api.listen(0, "127.0.0.1"); await once(apiServer, "listening");
    const address = apiServer.address(); if (!address || typeof address === "string") throw new Error("API address missing");
    const app = express(); app.use(express.json());
    const routes = registerBackendMcpHttpRoutes(app, { url: `http://127.0.0.1:${address.port}`, token: "isolated-hardening", port: 1, origins: [] });
    const mcpServer = app.listen(0, "127.0.0.1"); await once(mcpServer, "listening");
    const ma = mcpServer.address(); if (!ma || typeof ma === "string") throw new Error("MCP address missing");
    const client = new Client({ name: "hardening-acceptance", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ma.port}/mcp?token=isolated-hardening`)));
    t.after(async () => { await client.close(); await routes.closeAll(); await new Promise<void>((resolve) => mcpServer.close(() => resolve())); await new Promise<void>((resolve) => apiServer.close(() => resolve())); db.close(); });
    const args = { projectId: "hardening", nodeId: "h3", segmentId: "A" };
    const prepare = (extra: any = {}) => client.callTool({ name: "h3_prepare_clip", arguments: { ...args, patch: { prompt: "New <Subject 1>" }, characters: [{ characterNodeId: "character", selectedOutfitStorageKeys: ["image:actor"], voiceEnabled: false }], ...extra } });
    const segments = () => (db.getCanvasProject("hardening")!.nodes as any[])[0].metadata.segments;
    const seedTask = (id: string, segmentId: string, storageKey: string) => {
        db.createTask(id, "comfyui:minimax-h3", { prompt: "captured input" }, { canvasBinding: { projectId: "hardening", nodeId: "h3", segmentId } });
        db.updateTask(id, { status: "succeeded", progress: 1, result: { media: [{ storageKey, filename: `${segmentId}.mp4`, mimeType: "video/mp4" }] } });
    };
    return { db, writes, events, client, args, prepare, segments, seedTask, taskEvents, race: () => { race = true; } };
}

test("real HTTP declares joint prepare and applies final prompt/character/reference candidate once", async (t) => {
    const f = await fixture(t), catalog = await f.client.listTools();
    const tool = catalog.tools.find((entry) => entry.name === "h3_prepare_clip");
    assert.ok(tool, "a source handler must be exposed through actual MCP registration");
    assert.equal(tool.annotations?.readOnlyHint, false);
    const result = await f.prepare({ expectedRevision: 0 }); assert.notEqual(result.isError, true, JSON.stringify(payload(result)));
    assert.equal(payload(result).revision, 1); assert.equal(f.writes.length, 1);
    assert.equal(f.segments()[0].prompt, "New <Subject 1>");
    assert.equal(Object.keys(f.segments()[0].h3CharacterGroups).length, 1);
    assert.equal(f.segments()[1].prompt, "B");
});

test("real HTTP prepare preview is zero-write and invalid final references return structured issues", async (t) => {
    const f = await fixture(t), before = structuredClone(f.db.getCanvasProject("hardening"));
    const preview = await f.prepare({ dryRun: true, expectedRevision: 0 });
    assert.notEqual(preview.isError, true); assert.equal(payload(preview).applied, false);
    assert.equal(f.writes.length, 0); assert.deepEqual(f.db.getCanvasProject("hardening"), before);
    const bad = await f.prepare({ patch: { prompt: "<Picture 999>" }, expectedRevision: 0 });
    assert.equal(bad.isError, true); const rejected = payload(bad);
    assert.equal(rejected.error.code, "REFERENCE_INVALID");
    assert.equal(rejected.error.retryPolicy, "after_input_change");
    assert.equal(rejected.error.issues[0].code, "prompt_reference_missing");
    assert.equal(f.writes.length, 0); assert.deepEqual(f.db.getCanvasProject("hardening"), before);
    assert.ok(f.events.some((event) => event.event === "tool.failed" && event.errorCode === "REFERENCE_INVALID"));
    const read = await f.client.callTool({ name: "h3_get_clip", arguments: f.args }); assert.notEqual(read.isError, true);
});

test("real HTTP atomic preparation rejects stale revision and race without overwriting peer draft", async (t) => {
    const f = await fixture(t);
    const stale = await f.prepare({ expectedRevision: 9 }); assert.equal(stale.isError, true); assert.equal(f.writes.length, 0);
    f.race();
    const result = await f.prepare({ expectedRevision: 0 }); assert.equal(result.isError, true);
    assert.equal(f.segments()[0].prompt, "Peer edit"); assert.equal(f.db.getCanvasProject("hardening")!.revision, 1);
    assert.equal(f.segments()[0].h3CharacterGroups, undefined); assert.equal(f.segments()[1].prompt, "B");
});

test("real HTTP Clip result lookup rejects the other Clip's exact task or storage and returns verified identity", async (t) => {
    const f = await fixture(t);
    f.seedTask("task-A", "A", "video:A"); f.seedTask("task-B", "B", "video:B");
    const read = (extra: any) => f.client.callTool({ name: "h3_get_clip", arguments: { ...f.args, include: ["result"], ...extra } });
    const wrongTask = await read({ taskId: "task-B", storageKey: "video:B" }); assert.equal(wrongTask.isError, true);
    assert.equal(payload(wrongTask).error.code, "MEDIA_IDENTITY_MISMATCH");
    const wrongFile = await read({ taskId: "task-A", storageKey: "video:B" }); assert.equal(wrongFile.isError, true);
    const correct = await read({ taskId: "task-A", storageKey: "video:A" }); assert.notEqual(correct.isError, true);
    assert.deepEqual(payload(correct).result.identity, { projectId: "hardening", nodeId: "h3", segmentId: "A", taskId: "task-A", storageKey: "video:A" });
    assert.equal(payload(correct).result.media.url, "/media/video%3AA");
    assert.equal(f.writes.length, 0);
});

test("real HTTP a shared parent requires a matching Clip event, not a flat/latest output", async (t) => {
    const f = await fixture(t);
    f.db.createTask("shared-parent", "canvas-h3-run", { projectId: "hardening", nodeIds: ["h3"] }, {});
    f.db.updateTask("shared-parent", { status: "succeeded", progress: 1, result: { media: [{ storageKey: "video:B", mimeType: "video/mp4" }] } });
    f.taskEvents.set("shared-parent", [{ type: "clip_completed", payload: { nodeId: "h3", segmentId: "B", output: { storageKey: "video:B", mimeType: "video/mp4" } } }]);
    const read = () => f.client.callTool({ name: "h3_get_clip", arguments: { ...f.args, include: ["result"], taskId: "shared-parent", storageKey: "video:B" } });
    assert.equal((await read()).isError, true);
    f.taskEvents.set("shared-parent", [{ type: "clip_completed", payload: { nodeId: "h3", segmentId: "A", output: { storageKey: "video:A", mimeType: "video/mp4" } } }]);
    const good = await f.client.callTool({ name: "h3_get_clip", arguments: { ...f.args, include: ["result"], taskId: "shared-parent", storageKey: "video:A" } });
    assert.notEqual(good.isError, true); assert.equal(payload(good).result.identity.segmentId, "A");
    assert.equal(f.writes.length, 0);
});


test("real HTTP H3 diagnostic tools advertise positive readOnlyHint for safe reconnect", async (t) => {
    const f = await fixture(t), catalog = await f.client.listTools();
    for (const name of ["h3_get_node", "h3_get_clip_prompt", "h3_get_clip_references", "h3_get_clip_runtime"]) {
        assert.equal(catalog.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, true, name);
    }
});


test("real HTTP history, no-result and omitted result scope never guess a latest file", async (t) => {
    const f = await fixture(t);
    const empty = await f.client.callTool({ name: "h3_get_clip", arguments: { ...f.args, include: ["result"] } });
    assert.notEqual(empty.isError, true); assert.equal(payload(empty).result.available, false);
    f.seedTask("old-A", "A", "video:old-A");
    const history = await f.client.callTool({ name: "h3_get_clip", arguments: { ...f.args, include: ["result"], taskId: "old-A", storageKey: "video:old-A" } });
    assert.notEqual(history.isError, true); assert.equal(payload(history).result.currentOutput, false);
    const ignored = await f.client.callTool({ name: "h3_get_clip", arguments: { ...f.args, taskId: "old-A" } });
    assert.equal(ignored.isError, true); assert.equal(payload(ignored).error.code, "INVALID_INPUT");
    const conflict = f.db.getTask("old-A")!;
    f.db.updateTask("old-A", { result: { media: [{ storageKey: "video:old-A", mimeType: "video/mp4", segmentId: "B" }] } });
    const wrongOutput = await f.client.callTool({ name: "h3_get_clip", arguments: { ...f.args, include: ["result"], taskId: conflict.id, storageKey: "video:old-A" } });
    assert.equal(wrongOutput.isError, true); assert.equal(payload(wrongOutput).error.code, "MEDIA_IDENTITY_MISMATCH");
    assert.equal(f.writes.length, 0);
});

test("real HTTP prepare refuses runtime-field edits and foreign outfits with zero writes", async (t) => {
    const f = await fixture(t), before = structuredClone(f.db.getCanvasProject("hardening"));
    for (const patch of [{ prompt: "changed", parentTaskId: "overwrite-owner" }, { prompt: "changed", id: "B" }, { duration: -1 }]) {
        const result = await f.prepare({ patch }); assert.equal(result.isError, true);
    }
    const invalidOutfit = await f.prepare({ characters: [{ characterNodeId: "character", selectedOutfitStorageKeys: ["image:snake-not-an-outfit"] }] });
    assert.equal(invalidOutfit.isError, true);
    assert.equal(payload(invalidOutfit).error.code, "REFERENCE_INVALID");
    assert.deepEqual(f.db.getCanvasProject("hardening"), before); assert.equal(f.writes.length, 0);
});


test("real MCP -> generation HTTP -> runner preserves idempotency conflict code without dispatch", async (t) => {
    const f = await fixture(t); f.seedTask("occupied-key", "B", "video:B");
    const old = structuredClone(f.db.getTask("occupied-key"));
    const conflict = await f.client.callTool({ name: "h3_run_clip", arguments: { ...f.args, idempotencyKey: "occupied-key" } });
    assert.equal(conflict.isError, true);
    assert.equal(payload(conflict).error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(payload(conflict).error.retryPolicy, "after_input_change");
    assert.deepEqual(f.db.getTask("occupied-key"), old); assert.equal(f.writes.length, 0);
});


test("real HTTP schema rejection names nested unknown fields before the plugin handler runs", async (t) => {
    const f = await fixture(t);
    const result = await f.prepare({ characters: [{ characterNodeId: "character", selectedOutfitStorageKeys: ["image:actor"], bogusTag: "wrong" }] });
    assert.equal(result.isError, true); const error = payload(result).error;
    assert.equal(error.code, "INVALID_INPUT"); assert.equal(error.handlerInvoked, false);
    const issue = error.issues.find((value: any) => value.code === "additionalProperties");
    assert.deepEqual(issue.path, ["characters", "0", "bogusTag"]);
    assert.ok(issue.allowedFields.includes("selectedOutfitStorageKeys"));
    assert.equal(f.writes.length, 0);
});
