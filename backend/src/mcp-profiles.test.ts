import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KNOWN_FIRST_PARTY } from "@basketikun/canvas-agent/plugin-mcp";
import { isToolInProfile, MCP_PROFILES } from "@basketikun/canvas-agent/tool-profiles";
import { registerBackendMcpHttpRoutes } from "./mcp.js";

test("HTTP profile catalogs are isolated, frozen per session and retain task/recovery dependencies", async t => {
    const app = express(); app.use(express.json());
    let writes = 0;
    let emptyProjects = false;
    const events: any[] = [];
    app.get("/plugins/mcp", (_req, res) => res.json({ declarations: [{ id: "minimax-h3", enabled: true, version: KNOWN_FIRST_PARTY["minimax-h3"].version, tools: [] }] }));
    app.get("/canvas/projects", (_req, res) => res.json({ projects: emptyProjects ? [] : [{ id: "p", title: "Fixture", revision: 1, nodeCount: 1 }] }));
    app.get("/canvas/projects/:id", (_req, res) => res.json({ project: { id: "p", revision: 1, nodes: [{ id: "n", type: "image", title: "Fixture", metadata: { storageKey: "image:fixture" } }], connections: [] } }));
    app.post("/mcp/observability/events", (req, res) => { events.push(req.body); res.json({ ok: true }); });
    app.post("/canvas/generation", (_req, res) => { writes++; res.json({ ok: true }); });
    app.post("/canvas/image-ops", (req, res) => res.json({ ok: true, op: "colors", echoed: req.body.op, colors: [{ hex: "#0000ff", rgb: { r: 0, g: 0, b: 255 }, ratio: 1 }] }));
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const routes = registerBackendMcpHttpRoutes(app, { url, token: "fixture", port: 0, origins: [] });
    const clients: Client[] = [];
    t.after(async () => { await Promise.all(clients.map(c => c.close())); await routes.closeAll(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
    const samples: Array<Record<string, unknown>> = [];
    for (const profile of MCP_PROFILES) {
        const started = performance.now();
        const client = new Client({ name: `profile-${profile}`, version: "1" }); clients.push(client);
        const transport = new StreamableHTTPClientTransport(new URL(url + `/mcp?profile=${profile}`));
        await client.connect(transport);
        const tools = (await client.listTools()).tools;
        const names = new Set(tools.map(tool => tool.name));
        const edit = tools.find(tool => tool.name === "production_edit");
        if (edit) {
            assert.match(edit.description || "", /精简声明/);
            assert.ok(!JSON.stringify(edit.inputSchema).includes("\"committed\""), "default session should use the compact declaration");
        }
        assert.ok(tools.every(tool => isToolInProfile(profile, tool.name)));
        for (const name of ["canvas_get_state", "mcp_get_command_receipt", "canvas_wait_tasks", "production_get_compilation", "production_get_artifact_index"]) assert.ok(names.has(name), `${profile} missing ${name}`);
        if (profile === "full") assert.equal(tools.length, 159);
        else assert.ok(tools.length < 159);
        if (profile === "full") {
            const imageOps = await client.callTool({ name: "canvas_image_ops", arguments: { op: "colors", storageKey: "image:fixture" } });
            assert.notEqual(imageOps.isError, true);
            const body = JSON.parse((imageOps.content as any)[0].text);
            assert.equal(body.op, "colors");
            assert.equal(body.echoed, "colors", "canvas_image_ops must forward op to the backend route without a project");
            assert.equal(body.colors[0].hex, "#0000ff");
        }
        if (profile === "h3") for (const name of ["production_edit", "h3_update_clips", "h3_run_clip", "h3_get_clip"]) assert.ok(names.has(name));
        const read = await client.callTool({ name: "canvas_get_state", arguments: { projectId: "p", nodeIds: ["n"], projection: "media" } });
        assert.notEqual(read.isError, true);
        assert.equal(JSON.parse((read.content as any)[0].text).nodes[0].media.storageKey, "image:fixture", "old remote Backend fallback must still project locally");
        const bytes = Buffer.byteLength(JSON.stringify(tools));
        const cold = { calls: 2, bytes: bytes + Buffer.byteLength(JSON.stringify(read)), elapsedMs: Math.round(performance.now() - started) };
        const warmStart = performance.now();
        const warmRead = await client.callTool({ name: "canvas_get_state", arguments: { projectId: "p", nodeIds: ["n"], projection: "media" } });
        const warm = { calls: 1, bytes: Buffer.byteLength(JSON.stringify(warmRead)), elapsedMs: Math.round(performance.now() - warmStart) };
        assert.notEqual(warmRead.isError, true);
        samples.push({ profile, tools: tools.length, catalogBytes: bytes, cold, warm });
        const mismatch = await fetch(url + `/mcp?profile=${profile === "full" ? "h3" : "full"}`, { method: "POST", headers: { "Content-Type": "application/json", "mcp-session-id": transport.sessionId! }, body: JSON.stringify({ jsonrpc: "2.0", id: 90, method: "tools/list" }) });
        assert.equal(mismatch.status, 400);
        assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), tools.map(tool => tool.name));
        if (profile === "diagnostics") {
            assert.equal(names.has("canvas_generate_image"), false);
            const blocked = await client.callTool({ name: "canvas_generate_image", arguments: { prompt: "must not run" } });
            assert.equal(blocked.isError, true);
            assert.match(JSON.stringify(blocked.content), /disabled|not found|Unknown/i);
            emptyProjects = true;
            const empty = await client.callTool({ name: "canvas_inspect", arguments: { view: "context" } });
            const action = JSON.parse((empty.content as any)[0].text).suggestedAction;
            assert.equal(action.tool, undefined, "a diagnostic session must not suggest an excluded creation tool");
            assert.match(action.action, /profile=canvas/);
        }
    }
    const invalid = await fetch(url + "/mcp?profile=typo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    assert.equal(invalid.status, 400);
    assert.equal(writes, 0);
    const readEvents = events.filter(event => event.event === "tool.succeeded" && event.tool === "canvas_get_state");
    assert.equal(readEvents.length, 10);
    assert.ok(readEvents.every(event => /^[a-f0-9]{64}$/.test(event.inputSummary.schemaHash) && event.outputSummary.readReturnedContent === true));
    assert.equal(new Set(readEvents.map(event => event.inputSummary.schemaHash)).size, MCP_PROFILES.length);
    console.log(JSON.stringify({ scenario: "profile-discovery-and-same-media-read", samples }));
});
