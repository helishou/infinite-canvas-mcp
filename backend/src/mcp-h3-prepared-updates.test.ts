import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import express from "express";
import * as Y from "yjs";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { PreparedH3UpdateFiles } from "./canvas/prepared-h3-update-files.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KNOWN_FIRST_PARTY } from "@basketikun/canvas-agent/plugin-mcp";
import { BackendDatabase } from "./db.js";
import { registerBackendMcpHttpRoutes } from "./mcp.js";

async function fixture(t: TestContext) {
    const dir = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "h3-prepared-http-"));
    const root = path.join(dir, "source"), archive = path.join(dir, "plans"); await mkdir(root);
    const files = new PreparedH3UpdateFiles(root, archive);
    const db = new BackendDatabase(":memory:");
    db.createCanvasProject({ id: "delta-http", title: "isolated ten narrative edits", revision: 0, updatedAt: new Date().toISOString(), connections: [], nodes: [{
        id: "h3", type: "minimax-h3:video", title: "isolated", position: { x: 0, y: 0 }, width: 400, height: 300,
        metadata: { rootMarker: "keep", segments: Array.from({ length: 11 }, (_, i) => ({
            id: `s${i + 1}`, title: `clip-${i + 1}`, duration: 8, taskMode: "t2va", status: i === 0 ? "running" : "success",
            runtimeTaskId: i === 0 ? "existing-child" : "", parentTaskId: "existing-parent", resultStorageKey: `video:history-${i}`,
            prompt: "Unrelated camera, dialogue and lighting must remain intact. ".repeat(300) + "😀 She holds the golden bell, not the doorbell. <d>Keep my dialogue.</d>" + Array.from({ length: 20 }, (_, j) => ` Hidden prop reminder ${j};`).join(""),
            openingState: "golden bell visible", endingState: "golden bell concealed",
            continuityIn: "golden bell enters", continuityOut: "golden bell leaves",
            timeline: [{ start: 0, end: 4, action: "Show golden bell", camera: "Fixed" }, { start: 4, end: 8, action: "Hide golden bell", camera: "Close" }],
            referenceBindings: [], unrelated: { keep: true },
        })) },
    }] });
    // Create real collaborative documents before mutation; later inspect raw states, not a getter that repairs drift.
    for (let i = 1; i <= 11; i++) db.getCanvasText("delta-http", { nodeId: "h3", segmentId: `s${i}`, field: "prompt" });
    const original = structuredClone(db.getCanvasProject("delta-http"));
    const commits: any[] = [];
    const writeBodies: any[] = [];
    let race = false;
    let failLate = false;
    db.onCanvasCommit((commit) => commits.push(commit));
    const api = express();
    api.use(express.json({ limit: "4mb" }));
    api.get("/plugins/mcp", (_req, res) => res.json({ ok: true, declarations: [{ id: "minimax-h3", enabled: true, version: KNOWN_FIRST_PARTY["minimax-h3"].version, tools: [] }] }));
    api.post("/mcp/observability/events", (_req, res) => res.json({ ok: true }));
    api.get("/canvas/projects/:id", (req, res) => res.json({ ok: true, project: db.getCanvasProject(req.params.id) }));
    api.post("/canvas/projects/:id/ops", (req, res) => {
        writeBodies.push(structuredClone(req.body));
        if (race) {
            race = false;
            db.applyCanvasProjectOperations(req.params.id, undefined, [{ type: "update_node", id: "h3", patch: { title: "external edit" } }]);
        }
        const operations = structuredClone(req.body.operations);
        if (failLate) { failLate = false; operations.at(-1).patch.status = "queued"; }
        try {
            const result = db.applyCanvasProjectOperations(req.params.id, req.body.expectedRevision, operations, { baseRevision: req.body.baseRevision, operationId: req.body.operationId });
            res.json({ ok: true, ...result });
        } catch (error) { res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
    const apiServer = api.listen(0, "127.0.0.1");
    await once(apiServer, "listening");
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") throw new Error("API port missing");
    const app = express();
    app.use(express.json({ limit: "4mb" }));
    const routes = registerBackendMcpHttpRoutes(app, { url: `http://127.0.0.1:${apiAddress.port}`, token: "isolated-delta-test", port: 1, origins: [], listenHost: "127.0.0.1" }, undefined, undefined, files);
    const mcpServer = app.listen(0, "127.0.0.1");
    await once(mcpServer, "listening");
    const address = mcpServer.address();
    if (!address || typeof address === "string") throw new Error("MCP port missing");
    const client = new Client({ name: "isolated-narrative-acceptance", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp?token=isolated-delta-test`)));
    t.after(async () => {
        await client.close();
        await routes.closeAll();
        await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
        await new Promise<void>((resolve) => apiServer.close(() => resolve()));
        db.close();
        await rm(dir, { recursive: true, force: true });
    });
    const edits = () => ["prompt", "openingState", "endingState", "continuityIn", "continuityOut", "timeline[].action"].map((field) => ({ field, find: "golden bell", replace: "thin jade pendant", expectedMatches: field.startsWith("timeline") ? 2 : 1 }));
    const updates = () => Array.from({ length: 10 }, (_, i) => ({ segmentId: `s${i + 1}`, edits: edits() }));
    const invoke = (changes: unknown = updates(), extra: Record<string, unknown> = {}) => client.callTool({ name: "h3_update_clips", arguments: { projectId: "delta-http", nodeId: "h3", updates: changes, ...extra } });
    const segments = () => (db.getCanvasProject("delta-http")!.nodes as any[])[0].metadata.segments;
    const documents = () => (db as any).db.prepare("SELECT target_key, document_id, state FROM canvas_text_documents WHERE project_id = ? ORDER BY target_key").all("delta-http") as Array<{ target_key: string; document_id: string; state: Uint8Array }>;
    return { db, original, commits, writeBodies, client, invoke, updates, segments, documents, dir, root, archive, files, connect: async () => { const c = new Client({ name: "prepared-reconnect", version: "1" }); await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp?token=isolated-delta-test`))); return c; }, race: () => { race = true; }, failLate: () => { failLate = true; } };
}

function payload(result: any) {
    const text = result.content?.find((entry: any) => entry.type === "text")?.text;
    assert.equal(typeof text, "string");
    return JSON.parse(text);
}


const digest = (text: string) => createHash("sha256").update(text).digest("hex");
async function sourceFile(f: Awaited<ReturnType<typeof fixture>>, change?: (source: any) => void) {
    const source = { formatVersion: 1, projectId: "delta-http", nodeId: "h3", expectedRevision: 0, items: f.segments().slice(0, 10).map((s: any, i: number) => ({
        segmentId: s.id, before: { prompt: s.prompt, continuityOut: s.continuityOut }, update: { segmentId: s.id, edits: Array.from({ length: i === 9 ? 20 : 19 }, (_, j) => ({ field: "prompt", find: ` Hidden prop reminder ${j};`, replace: "", expectedMatches: 1 })) },
    })) };
    change?.(source);
    const text = JSON.stringify(source), filePath = path.join(f.root, "plan.json"); await writeFile(filePath, text);
    return { source, text, filePath, fileSha256: digest(text) };
}
async function prepare(f: Awaited<ReturnType<typeof fixture>>, file: Awaited<ReturnType<typeof sourceFile>>) {
    return f.client.callTool({ name: "h3_prepare_clip_updates", arguments: { projectId: "delta-http", nodeId: "h3", filePath: file.filePath, fileSha256: file.fileSha256 } });
}
const byHandle = (id: string, extra: any = {}) => ({ name: "h3_update_clips", arguments: { projectId: "delta-http", nodeId: "h3", preparedId: id, ...extra } });

test("actual HTTP 191-edit ten-Clip preparation, immutable short-handle commit, replay and raw Yjs verification", async (t) => {
    const f = await fixture(t), file = await sourceFile(f), beforeDocs = f.documents();
    const catalog = await f.client.listTools();
    assert.ok(catalog.tools.some((tool) => tool.name === "h3_prepare_clip_updates"));
    assert.ok((catalog.tools.find((tool) => tool.name === "h3_update_clips")!.inputSchema as any).properties.preparedId);
    const started = performance.now(), loaded = await prepare(f, file), preparationMs = performance.now() - started;
    assert.notEqual(loaded.isError, true);
    const plan = payload(loaded);
    assert.equal(plan.applied, false); assert.equal(plan.count, 10); assert.equal(plan.revision, 0);
    assert.equal(f.writeBodies.length, 0); assert.equal(f.commits.length, 0); assert.deepEqual(f.documents(), beforeDocs);
    const frozen = await f.files.read(plan.preparedId);
    const proposed = frozen.previewItems as any[];
    assert.equal(proposed.reduce((n, item) => n + item.changePreviews.length, 0), 10);
    await writeFile(file.filePath, JSON.stringify({ changed: "after import" }));
    const preview = await f.client.callTool(byHandle(plan.preparedId, { dryRun: true }));
    assert.notEqual(preview.isError, true); assert.equal(f.writeBodies.length, 0);
    const commitStarted = performance.now(), result = await f.client.callTool(byHandle(plan.preparedId)), commitMs = performance.now() - commitStarted;
    assert.notEqual(result.isError, true);
    const receipt = payload(result); assert.equal(receipt.revision, 1); assert.equal(f.commits.length, 1);
    assert.equal(f.writeBodies[0].operationId, receipt.operationId); assert.equal(f.writeBodies[0].expectedRevision, 0);
    for (let i = 0; i < 10; i++) {
        let expected = file.source.items[i].before.prompt;
        for (const edit of file.source.items[i].update.edits) expected = expected.replace(edit.find, edit.replace);
        const actual = f.segments()[i]; assert.equal(actual.prompt, expected); assert.match(actual.prompt, /<d>Keep my dialogue.<\/d>/);
        const old = (f.original!.nodes as any[])[0].metadata.segments[i];
        for (const key of ["duration", "timeline", "status", "runtimeTaskId", "parentTaskId", "resultStorageKey", "referenceBindings", "unrelated"]) assert.deepEqual(actual[key], old[key]);
        const read = payload(await f.client.callTool({ name: "h3_get_clip", arguments: { projectId: "delta-http", nodeId: "h3", segmentId: actual.id, fields: ["prompt"] } }));
        assert.equal(read.fields.prompt, expected);
        const serialized = JSON.stringify(read.fields.prompt), summary = receipt.items[i].fieldSummaries.prompt;
        assert.equal(summary.sha256, digest(serialized)); assert.equal(summary.bytes, Buffer.byteLength(serialized));
    }
    for (const row of f.documents()) {
        const doc = new Y.Doc();
        try { Y.applyUpdate(doc, row.state); const id = JSON.parse(row.target_key)[1]; assert.equal(doc.getText("text").toString(), f.segments().find((s: any) => s.id === id).prompt); }
        finally { doc.destroy(); }
    }
    assert.deepEqual(f.segments()[10], (f.original!.nodes as any[])[0].metadata.segments[10]);
    const other = await f.connect();
    try {
        const replay = payload(await other.callTool(byHandle(plan.preparedId)));
        assert.equal(replay.operationId, receipt.operationId); assert.equal(replay.revision, 1); assert.equal(replay.replayed, true); assert.equal(f.commits.length, 1);
        const discard = await other.callTool({ name: "h3_discard_clip_updates", arguments: { projectId: "delta-http", nodeId: "h3", preparedId: plan.preparedId } });
        assert.notEqual(discard.isError, true); await assert.rejects(f.files.read(plan.preparedId));
        assert.equal((await readdir(f.archive)).length, 0);
    } finally { await other.close(); }
    const inlineChars = JSON.stringify({ projectId: "delta-http", nodeId: "h3", expectedRevision: 0, updates: file.source.items.map((item: any) => item.update) }).length;
    const shortChars = JSON.stringify(byHandle(plan.preparedId).arguments).length;
    assert.ok(shortChars < inlineChars / 30);
    console.log("H3_PREPARED_HTTP_METRICS=" + JSON.stringify({ targets: 10, editOperations: 191, inlineChars, shortChars, preparationMs, commitMs, planReceiptBytes: Buffer.byteLength(JSON.stringify(plan)), commitReceiptBytes: Buffer.byteLength(JSON.stringify(receipt)), originalUpdateBytes: plan.originalUpdateBytes, selectedUpdateBytes: plan.selectedUpdateBytes, actualCommits: f.commits.length, dialogueTimesHistoryAndYjs: "PASS", reconnectReplay: "PASS", planCleanup: "PASS" }));
});

for (const [label, corrupt] of [
    ["last item stale before", (s: any) => { s.items[9].before.prompt = "stale"; }],
    ["last item wrong count", (s: any) => { s.items[9].update.edits[0].expectedMatches = 2; }],
    ["last item invalid reference", (s: any) => { s.items[9].update.edits[0].replace = "<Picture 999>"; }],
    ["dialogue edit outside authorization", (s: any) => { s.items[9].update.edits.push({ field: "prompt", find: "<d>Keep my dialogue.</d>", replace: "<d>changed</d>", expectedMatches: 1 }); }],
] as const) {
    test(`actual HTTP file preflight rejects ${label} with no plan or Canvas write`, async (t) => {
        const f = await fixture(t), docs = f.documents(), file = await sourceFile(f, corrupt);
        const result = await prepare(f, file); assert.equal(result.isError, true);
        assert.equal(f.writeBodies.length, 0); assert.equal(f.commits.length, 0); assert.deepEqual(f.documents(), docs);
        assert.deepEqual(f.db.getCanvasProject("delta-http"), f.original);
        await assert.rejects(readdir(f.archive), { code: "ENOENT" });
    });
}

test("actual HTTP revision change after freezing refuses commit without rebasing", async (t) => {
    const f = await fixture(t), plan = payload(await prepare(f, await sourceFile(f))), docs = f.documents();
    f.db.applyCanvasProjectOperations("delta-http", 0, [{ type: "update_node", id: "h3", patch: { title: "other actor" } }]);
    const result = await f.client.callTool(byHandle(plan.preparedId)); assert.equal(result.isError, true);
    assert.equal(f.commits.length, 1); assert.deepEqual(f.documents(), docs);
    assert.deepEqual(f.segments(), (f.original!.nodes as any[])[0].metadata.segments);
});

test("actual HTTP late rejection rolls back both drafts and collaborative text", async (t) => {
    const f = await fixture(t), plan = payload(await prepare(f, await sourceFile(f))), docs = f.documents();
    f.failLate(); const result = await f.client.callTool(byHandle(plan.preparedId)); assert.equal(result.isError, true);
    assert.equal(f.commits.length, 0); assert.deepEqual(f.db.getCanvasProject("delta-http"), f.original); assert.deepEqual(f.documents(), docs);
});

test("receipt replay after another actor edits returns history without overwriting the new state", async (t) => {
    const f = await fixture(t), plan = payload(await prepare(f, await sourceFile(f)));
    const receipt = payload(await f.client.callTool(byHandle(plan.preparedId)));
    assert.equal(receipt.revision, 1);
    f.db.applyCanvasProjectOperations("delta-http", 1, [{ type: "update_h3_segment", nodeId: "h3", segmentId: "s1", patch: { prompt: "another actor's approved newer draft" } }]);
    const replay = payload(await f.client.callTool(byHandle(plan.preparedId)));
    assert.equal(replay.replayed, true); assert.equal(replay.revision, 1); assert.equal(f.commits.length, 2);
    assert.equal(f.segments()[0].prompt, "another actor's approved newer draft");
    assert.equal(f.db.getCanvasProject("delta-http")!.revision, 2);
});
