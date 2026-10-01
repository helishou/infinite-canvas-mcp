import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import express from "express";
import * as Y from "yjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KNOWN_FIRST_PARTY } from "@basketikun/canvas-agent/plugin-mcp";
import { BackendDatabase } from "./db.js";
import { registerBackendMcpHttpRoutes } from "./mcp.js";

async function fixture(t: TestContext) {
    const db = new BackendDatabase(":memory:");
    db.createCanvasProject({ id: "delta-http", title: "isolated ten narrative edits", revision: 0, updatedAt: new Date().toISOString(), connections: [], nodes: [{
        id: "h3", type: "minimax-h3:video", title: "isolated", position: { x: 0, y: 0 }, width: 400, height: 300,
        metadata: { rootMarker: "keep", segments: Array.from({ length: 11 }, (_, i) => ({
            id: `s${i + 1}`, title: `clip-${i + 1}`, duration: 8, taskMode: "t2va", status: i === 0 ? "running" : "success",
            runtimeTaskId: i === 0 ? "existing-child" : "", parentTaskId: "existing-parent", resultStorageKey: `video:history-${i}`,
            prompt: "Unrelated camera, dialogue and lighting must remain intact. ".repeat(300) + "😀 She holds the golden bell, not the doorbell.",
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
    const routes = registerBackendMcpHttpRoutes(app, { url: `http://127.0.0.1:${apiAddress.port}`, token: "isolated-delta-test", port: 1, origins: [], listenHost: "127.0.0.1" });
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
    });
    const edits = () => ["prompt", "openingState", "endingState", "continuityIn", "continuityOut", "timeline[].action"].map((field) => ({ field, find: "golden bell", replace: "thin jade pendant", expectedMatches: field.startsWith("timeline") ? 2 : 1 }));
    const updates = () => Array.from({ length: 10 }, (_, i) => ({ segmentId: `s${i + 1}`, edits: edits() }));
    const invoke = (changes: unknown = updates(), extra: Record<string, unknown> = {}) => client.callTool({ name: "h3_update_clips", arguments: { projectId: "delta-http", nodeId: "h3", updates: changes, ...extra } });
    const segments = () => (db.getCanvasProject("delta-http")!.nodes as any[])[0].metadata.segments;
    const documents = () => (db as any).db.prepare("SELECT target_key, document_id, state FROM canvas_text_documents WHERE project_id = ? ORDER BY target_key").all("delta-http") as Array<{ target_key: string; document_id: string; state: Uint8Array }>;
    return { db, original, commits, writeBodies, client, invoke, updates, segments, documents, race: () => { race = true; }, failLate: () => { failLate = true; } };
}

function payload(result: any) {
    const text = result.content?.find((entry: any) => entry.type === "text")?.text;
    assert.equal(typeof text, "string");
    return JSON.parse(text);
}

function assertNoWrite(f: Awaited<ReturnType<typeof fixture>>) {
    assert.equal(f.writeBodies.length, 0);
    assert.equal(f.commits.length, 0);
    assert.deepEqual(f.db.getCanvasProject("delta-http"), f.original);
}

test("actual HTTP ten-target dryRun, commit, field readback and raw Yjs state agree", async (t) => {
    const f = await fixture(t);
    const catalog = await f.client.listTools();
    const descriptor: any = catalog.tools.find((tool) => tool.name === "h3_update_clips");
    assert.ok(descriptor.inputSchema.properties.dryRun);
    assert.ok(descriptor.inputSchema.properties.updates.items.properties.edits);
    const beforeDocs = f.documents();
    const previewResult = await f.invoke(f.updates(), { dryRun: true, expectedRevision: 0 });
    assert.notEqual(previewResult.isError, true);
    const preview = payload(previewResult);
    assert.equal(preview.applied, false);
    assert.equal(preview.valueSource, "proposed");
    assert.equal(preview.revision, 0);
    assertNoWrite(f);
    assert.deepEqual(f.documents(), beforeDocs);
    const input = { projectId: "delta-http", nodeId: "h3", expectedRevision: preview.revision, updates: f.updates() };
    const result = await f.invoke(input.updates, { expectedRevision: preview.revision });
    assert.notEqual(result.isError, true);
    const receipt = payload(result);
    assert.equal(receipt.applied, true);
    assert.equal(receipt.valueSource, "committed");
    assert.equal(receipt.count, 10);
    assert.equal(receipt.revision, 1);
    assert.equal(f.writeBodies.length, 1);
    assert.equal(f.writeBodies[0].expectedRevision, 0);
    assert.equal(f.commits.length, 1);
    const originalSegments = (f.original!.nodes as any[])[0].metadata.segments;
    for (let i = 0; i < 10; i++) {
        const actual = f.segments()[i], old = originalSegments[i];
        assert.equal(actual.prompt, old.prompt.replace("golden bell", "thin jade pendant"));
        assert.match(actual.prompt, /😀.*doorbell/);
        for (const key of ["duration", "status", "runtimeTaskId", "parentTaskId", "resultStorageKey", "referenceBindings", "unrelated"]) assert.deepEqual(actual[key], old[key]);
        const read = payload(await f.client.callTool({ name: "h3_get_clip", arguments: { projectId: "delta-http", nodeId: "h3", segmentId: actual.id, fields: ["openingState", "endingState", "continuityIn", "continuityOut", "timeline"] } }));
        assert.deepEqual(read.fields, Object.fromEntries(["openingState", "endingState", "continuityIn", "continuityOut", "timeline"].map((key) => [key, actual[key]])));
        assert.equal("semantic" in read.prompt, false);
        assert.ok(Buffer.byteLength(JSON.stringify(read)) < 2200);
    }
    assert.deepEqual(f.segments()[10], originalSegments[10]);
    for (const row of f.documents()) {
        const old = beforeDocs.find((entry) => entry.target_key === row.target_key)!;
        assert.equal(row.document_id, old.document_id);
        const segmentId = JSON.parse(row.target_key)[1];
        const doc = new Y.Doc();
        try { Y.applyUpdate(doc, row.state); assert.equal(doc.getText("text").toString(), f.segments().find((s: any) => s.id === segmentId).prompt); }
        finally { doc.destroy(); }
    }
    assert.equal(f.commits[0].operations.filter((operation: any) => operation.textUpdates?.length).length, 10);
    const legacy = { ...input, updates: f.segments().slice(0, 10).map((s: any) => ({ segmentId: s.id, patch: { prompt: s.prompt, openingState: s.openingState, endingState: s.endingState, continuityIn: s.continuityIn, continuityOut: s.continuityOut, timeline: s.timeline } })) };
    const requestBytes = Buffer.byteLength(JSON.stringify(input));
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacy));
    assert.ok(requestBytes < legacyBytes / 10);
    console.log("H3_NARRATIVE_HTTP_METRICS=" + JSON.stringify({ targets: 10, writeRpcCalls: 1, revisionDelta: 1, requestBytes, legacyBytes, receiptBytes: Buffer.byteLength(JSON.stringify(receipt)), previewBytes: Buffer.byteLength(JSON.stringify(preview)), documentReadback: "PASS", historyPreserved: "PASS" }));
});

for (const [name, corrupt] of [
    ["last-target count mismatch", (updates: any[]) => { updates[9].edits[0].expectedMatches = 2; }],
    ["new invalid reference", (updates: any[]) => { updates[9].edits[0].replace = "<Picture 999>"; }],
] as const) {
    test(`actual HTTP ${name} rejects before any persisted state change`, async (t) => {
        const f = await fixture(t), docs = f.documents(), changes = f.updates();
        corrupt(changes);
        const result = await f.invoke(changes);
        assert.equal(result.isError, true);
        assertNoWrite(f);
        assert.deepEqual(f.documents(), docs);
    });
}

test("actual HTTP stale revision and precommit race refuse to overwrite drafts", async (t) => {
    const f = await fixture(t);
    const invalid = await f.invoke(f.updates(), { expectedRevision: 99 });
    assert.equal(invalid.isError, true);
    assertNoWrite(f);
    const docs = f.documents();
    f.race();
    const result = await f.invoke(f.updates(), { expectedRevision: 0 });
    assert.equal(result.isError, true);
    assert.equal(f.commits.length, 1); // only the independently injected actor edit
    assert.deepEqual(f.segments(), (f.original!.nodes as any[])[0].metadata.segments);
    assert.deepEqual(f.documents(), docs);
});

test("late authority rejection rolls back earlier collaborative document updates too", async (t) => {
    const f = await fixture(t), docs = f.documents();
    f.failLate();
    const result = await f.invoke();
    assert.equal(result.isError, true);
    assert.equal(f.writeBodies.length, 1);
    assert.equal(f.commits.length, 0);
    assert.deepEqual(f.db.getCanvasProject("delta-http"), f.original);
    assert.deepEqual(f.documents(), docs);
});
