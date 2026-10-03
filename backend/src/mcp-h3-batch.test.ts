import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KNOWN_FIRST_PARTY } from "@basketikun/canvas-agent/plugin-mcp";
import { BackendDatabase } from "./db.js";
import { registerBackendMcpHttpRoutes } from "./mcp.js";
import { registerMcpCommandTestRoutes } from "./mcp-command-test-routes.js";

async function fixture(t: TestContext) {
    const db = new BackendDatabase(":memory:");
    db.createCanvasProject({ id: "batch-http", title: "isolated batch", revision: 0, updatedAt: new Date().toISOString(), connections: [], nodes: [{
        id: "h3", type: "minimax-h3:video", title: "fixture", position: { x: 0, y: 0 }, width: 400, height: 300,
        metadata: { segments: Array.from({ length: 6 }, (_, i) => ({ id: `s${i + 1}`, title: `old-${i + 1}`, duration: 6, taskMode: "t2va", status: "idle", prompt: "An empty room.", referenceBindings: [] })) },
    }] });
    const commits: unknown[] = [];
    db.onCanvasCommit((commit) => { commits.push(commit); });
    const writeBodies: any[] = [];
    let race = false;
    let failLast = false;
    const api = express();
    api.use(express.json());
    registerMcpCommandTestRoutes(api, db);
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
        if (failLast) {
            failLast = false;
            // Deliberately exercise the real transaction's late authority failure after valid earlier ops.
            operations[operations.length - 1].patch.status = "running";
        }
        try {
            const result = db.applyCanvasProjectOperations(req.params.id, req.body.expectedRevision, operations, { baseRevision: req.body.baseRevision, operationId: req.body.operationId, ...(req.body.mcpCommand ? { mcpCommand: req.body.mcpCommand } : {}) });
            res.json({ ok: true, ...result });
        } catch (error) {
            const value = error as Error & { code?: string };
            if (req.body.mcpCommand) db.rejectMcpCommand(req.body.operationId, value.code || "MCP_COMMAND_REJECTED", value.message);
            res.status(409).json({ ok: false, code: value.code, error: value.message });
        }
    });
    const apiServer = api.listen(0, "127.0.0.1");
    await once(apiServer, "listening");
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") throw new Error("API port missing");
    const backendUrl = `http://127.0.0.1:${apiAddress.port}`;
    const app = express();
    app.use(express.json());
    const routes = registerBackendMcpHttpRoutes(app, { url: backendUrl, token: "isolated-test-token", port: 1, origins: [], listenHost: "127.0.0.1" });
    const mcpServer = app.listen(0, "127.0.0.1");
    await once(mcpServer, "listening");
    const address = mcpServer.address();
    if (!address || typeof address === "string") throw new Error("MCP port missing");
    const client = new Client({ name: "h3-batch-contract-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp?token=isolated-test-token`)));
    t.after(async () => {
        await client.close();
        await routes.closeAll();
        await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
        await new Promise<void>((resolve) => apiServer.close(() => resolve()));
        db.close();
    });
    const updates = () => Array.from({ length: 6 }, (_, i) => ({ segmentId: `s${i + 1}`, patch: { title: `new-${i + 1}`, duration: 7 } }));
    let operationNumber = 0;
    const invoke = (changes: unknown = updates(), extra: Record<string, unknown> = {}) => client.callTool({ name: "h3_update_clips", arguments: { projectId: "batch-http", nodeId: "h3", updates: changes, operationId: String(extra.operationId || `batch-op-${++operationNumber}`), expectedRevision: db.getCanvasProject("batch-http")!.revision, ...extra } });
    const segments = () => (db.getCanvasProject("batch-http")!.nodes as any[])[0].metadata.segments;
    return { db, commits, writeBodies, client, invoke, updates, segments, race: () => { race = true; }, failLast: () => { failLast = true; } };
}

function payload(result: any) {
    const text = result.content?.find((entry: any) => entry.type === "text")?.text;
    assert.equal(typeof text, "string");
    return JSON.parse(text);
}

test("actual MCP HTTP boundary commits six updates in one strict-revision transaction", async (t) => {
    const f = await fixture(t);
    const tools = await f.client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "h3_update_clips"));
    const result = await f.invoke();
    assert.notEqual(result.isError, true);
    const data = payload(result);
    assert.equal(data.atomic, true);
    assert.equal(data.count, 6);
    assert.equal(data.revision, 1);
    assert.equal(f.writeBodies.length, 1);
    assert.equal(f.writeBodies[0].expectedRevision, 0);
    assert.equal("baseRevision" in f.writeBodies[0], false);
    assert.equal(f.commits.length, 1);
    assert.equal(f.db.getCanvasProject("batch-http")!.revision, 1);
    assert.deepEqual(f.segments().map((segment: any) => segment.duration), [7, 7, 7, 7, 7, 7]);
    assert.deepEqual(data.segmentIds, f.segments().slice(0, 6).map((segment: any) => segment.id));
    assert.deepEqual(data.updatedFields, ["title", "duration"]);
    for (let i = 0; i < 6; i++) assert.equal(data.items[i].values.title, f.segments()[i].title);
    assert.ok(Buffer.byteLength(JSON.stringify(data)) < 4096);
});

test("reference error on the last target crosses MCP as error and commits nothing", async (t) => {
    const f = await fixture(t);
    const changes = f.updates();
    changes[5].patch = { prompt: "The figure in <Picture 999>." } as any;
    const result = await f.invoke(changes);
    assert.equal(result.isError, true);
    assert.equal(f.writeBodies.length, 0);
    assert.equal(f.commits.length, 0);
    assert.equal(f.db.getCanvasProject("batch-http")!.revision, 0);
    assert.equal(f.segments()[0].title, "old-1");
});

test("concurrent unrelated edit cannot rebase a batch validated against old references", async (t) => {
    const f = await fixture(t);
    f.race();
    const result = await f.invoke();
    assert.equal(result.isError, true);
    assert.equal(f.writeBodies[0].expectedRevision, 0);
    assert.equal(f.commits.length, 1); // only the independently injected actor edit
    assert.equal(f.segments()[0].title, "old-1");
    assert.equal(f.db.getCanvasProject("batch-http")!.revision, 1);
});

test("late backend authority rejection rolls back earlier updates and revisions", async (t) => {
    const f = await fixture(t);
    const before = structuredClone(f.db.getCanvasProject("batch-http"));
    f.failLast();
    const result = await f.invoke();
    assert.equal(result.isError, true);
    assert.equal(f.writeBodies.length, 1);
    assert.equal(f.commits.length, 0);
    assert.deepEqual(f.db.getCanvasProject("batch-http"), before);
});
