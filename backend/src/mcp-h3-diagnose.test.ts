import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import test from "node:test";

import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { registerBackendMcpHttpRoutes } from "./mcp.js";
import type { ResolvedConfig } from "./config.js";
import { BackendDatabase } from "./db.js";
import { createStores } from "./stores/index.js";
import { diagnoseH3Clips } from "./canvas/h3-diagnose.js";
import { h3PromptContent } from "./canvas/h3-params.js";

const hash = (prompt: string) => createHash("sha256").update(h3PromptContent(prompt)).digest("hex");

function textPayload(result: unknown) {
    const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const content = Array.isArray(record.content) ? record.content[0] : null;
    assert.ok(content && typeof content === "object" && "type" in content && (content as { type?: string }).type === "text");
    const text = (content as { text?: string }).text;
    assert.equal(typeof text, "string");
    return JSON.parse(String(text));
}

async function mcpClient(t: import("node:test").TestContext, url: string) {
    const client = new Client({ name: "mcp-h3-diagnose-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    t.after(() => client.close());
    return client;
}

test("production_diagnose_clips is registered, forwards its filters, and returns the diagnosis", async t => {
    // A stand-in Backend that runs the real diagnosis over the real stores.
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const stores = createStores(db);
    stores.projects.create({
        id: "p",
        nodes: [{ id: "n", type: "minimax-h3", metadata: { segments: [
            { id: "a", prompt: "A。", directorEngine: "acheng", directorSourceHash: "s1" },
            { id: "b", prompt: "B。", directorEngine: "acheng", directorSourceHash: "s1" },
        ] } }],
        connections: [],
    });
    stores.projects.getH3ProductionRequirements = () => ({
        ownerId: "ep", revision: 3, version: 7,
        clips: [{ nodeId: "n", segmentId: "a", sourceHash: "s1", promptContentHash: hash("A。"), storyboardRequired: false, shots: [], literalDialogues: [] }],
    }) as never;

    const seen: Array<Record<string, unknown>> = [];
    const backend = express();
    backend.get("/plugins/mcp", (_req, res) => res.json({ ok: true, declarations: [] }));
    backend.get("/canvas/projects/:id/h3-diagnose", (req, res) => {
        seen.push({ ...req.query });
        const raw = req.query.nodeIds;
        const nodeIds = typeof raw === "string" && raw ? JSON.parse(raw) as string[] : undefined;
        try {
            res.json({ ok: true, ...diagnoseH3Clips(stores, {
                projectId: req.params.id,
                nodeId: typeof req.query.nodeId === "string" ? req.query.nodeId : undefined,
                nodeIds,
                offset: Number.parseInt(String(req.query.offset ?? "0"), 10),
                pageSize: Number.parseInt(String(req.query.pageSize ?? "200"), 10),
            }) });
        } catch (error) {
            res.status(404).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
    const backendServer = backend.listen(0, "127.0.0.1");
    await once(backendServer, "listening");
    t.after(() => new Promise<void>((resolve, reject) => backendServer.close(error => error ? reject(error) : resolve())));
    const backendAddress = backendServer.address();
    if (!backendAddress || typeof backendAddress === "string") throw new Error("missing backend port");

    const app = express();
    app.use(express.json());
    app.get("/plugins/mcp", (_req, res) => res.json({ ok: true, declarations: [] }));
    app.post("/mcp/observability/events", (_req, res) => res.status(201).json({ ok: true }));
    const routes = registerBackendMcpHttpRoutes(app, {
        url: `http://127.0.0.1:${backendAddress.port}`,
        token: "test-token",
        port: 1,
        origins: [],
        listenHost: "127.0.0.1",
    } satisfies ResolvedConfig);
    const mcpServer = app.listen(0, "127.0.0.1");
    await once(mcpServer, "listening");
    t.after(async () => {
        await routes.closeAll();
        mcpServer.close();
        await once(mcpServer, "close");
    });
    const mcpAddress = mcpServer.address();
    if (!mcpAddress || typeof mcpAddress === "string") throw new Error("missing mcp port");
    const client = await mcpClient(t, `http://127.0.0.1:${mcpAddress.port}/mcp`);

    const listed = await client.listTools();
    assert.equal(listed.tools.some(tool => tool.name === "production_diagnose_clips"), true, "tool must be registered on the MCP surface");

    const result = textPayload(await client.callTool({
        name: "production_diagnose_clips",
        arguments: { projectId: "p", nodeIds: ["n"], pageSize: 1 },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.total, 2);
    assert.equal(result.rows.length, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.nextOffset, 1);
    assert.equal(result.publishedVersion, 7);
    assert.equal(result.counts.match, 1);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].nodeIds, JSON.stringify(["n"]), "nodeIds must survive MCP -> REST as a JSON string");
    assert.equal(seen[0].pageSize, "1");
    assert.equal(seen[0].nodeId, undefined, "nodeId must stay absent when only nodeIds is supplied");

    // A missing project must surface as an in-band tool error, not a silent empty diagnosis.
    const missing = await client.callTool({
        name: "production_diagnose_clips",
        arguments: { projectId: "nope" },
    }) as { isError?: boolean; content?: Array<{ text?: string }> };
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing), /画布不存在|404/);
});
