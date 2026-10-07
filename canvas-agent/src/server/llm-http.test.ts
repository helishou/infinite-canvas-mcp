import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

test("embedded Agent creates, runs and restores a channel conversation without starting Codex", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-llm-http-"));
    process.env.INFINITE_CANVAS_AGENT_CONFIG_DIR = directory;
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const { createAgentApp } = await import("./http.js");
    const app = express();
    app.use(express.json());
    let executions = 0, requests = 0;
    app.all("/mcp", async (req, res) => {
        assert.equal(req.headers.authorization, "Bearer fixture-token");
        const server = new McpServer({ name: "fixture", version: "1" });
        server.registerTool("canvas_set_active_project", { inputSchema: { id: z.string() } }, async ({ id }) => { assert.equal(id, "fixture-canvas"); return { content: [{ type: "text", text: "bound" }] }; });
        server.registerTool("fixture_write", { inputSchema: {} }, async () => { executions++; return { content: [{ type: "text", text: "saved" }] }; });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        res.on("close", () => { void server.close(); });
        await transport.handleRequest(req, res, req.body);
    });
    app.get("/media/:storageKey", (req, res) => {
        assert.equal(req.headers.authorization, "Bearer fixture-token");
        assert.equal(req.params.storageKey, "image:fixture");
        res.type("image/png").send(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"));
    });
    app.post("/v1/chat/completions", (req, res) => {
        requests++;
        if (requests === 2) {
            const messages = req.body.messages;
            const toolIndices = messages.flatMap((message: any, index: number) => message.role === "tool" ? [index] : []);
            const imageIndex = messages.findIndex((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === "image_url"));
            assert.ok(imageIndex > Math.max(...toolIndices));
            assert.match(messages[imageIndex].content[1].image_url.url, /^data:image\/png;base64,/);
        }
        res.json({ choices: [{ message: requests === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "fixture-call", type: "function", function: { name: "fixture_write", arguments: "{}" } }, { id: "image-call", type: "function", function: { name: "agent_view_image", arguments: '{"storageKey":"image:fixture"}' } }] } : { role: "assistant", content: "完成" }, finish_reason: requests === 1 ? "tool_calls" : "stop" }] });
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const values = new Map<string, unknown>([["ai.config", { textModel: "channel::fixture", channels: [{ id: "channel", name: "Fixture", apiFormat: "openai-chat", baseUrl: url, apiKey: "fixture-key", models: [{ name: "fixture", capability: "text" }] }] }]]);
    const agent = createAgentApp({ listen: false, backendUrl: url, backendToken: "fixture-token", settings: { get: key => values.get(key), set: (key, value) => { values.set(key, structuredClone(value)); } } });
    app.use("/agent", agent.app);
    const json = async (route: string, body?: unknown) => {
        const response = await fetch(`${url}/agent${route}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(response.status, 200); return await response.json() as any;
    };
    const models = await json("/codex/models");
    assert.deepEqual(models.data.map((item: any) => item.model), ["channel::fixture"]);
    const disconnected = await fetch(`${url}/agent/codex/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "disconnected-client", prompt: "must not execute" }) });
    assert.equal(disconnected.status, 409);
    assert.equal((await disconnected.json() as any).code, "CLIENT_DISCONNECTED");
    assert.equal(requests, 0);
    assert.equal(agent.session.codexBusy, false);
    const events = new AbortController();
    const response = await fetch(`${url}/agent/events?clientId=fixture-client`, { signal: events.signal });
    assert.equal(response.status, 200);
    const reset = await json("/codex/threads/reset", { clientId: "fixture-client", model: "channel::fixture" });
    assert.ok(reset.workspace.activeThreadId.startsWith("llm-")); assert.equal(reset.conversation.status, "ready");
    await json("/canvas/state?clientId=fixture-client", { projectId: "fixture-canvas", nodes: [], connections: [] });
    await json("/codex/turn", { clientId: "fixture-client", threadId: reset.workspace.activeThreadId, conversationId: reset.conversation.conversationId, expectedRevision: reset.conversation.revision, model: "channel::fixture", prompt: "write" });
    // One-off test observation, not a product timeout/retry policy.
    const deadline = Date.now() + 5000;
    while (agent.session.codexBusy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(agent.session.codexBusy, false); assert.equal(executions, 1); assert.equal(requests, 2);
    const history = await json(`/codex/threads/${reset.workspace.activeThreadId}`);
    assert.ok(history.messages.some((message: any) => message.role === "assistant" && message.text === "完成"));
    const listed = await json("/codex/threads?source=llm"); assert.equal(listed.data[0].id, reset.workspace.activeThreadId);
    assert.equal(JSON.stringify(history).includes("fixture-key"), false);
    const { CodexAppClient } = await import("../agent/codex-client.js");
    const originalStart = CodexAppClient.start;
    let cliEmit: (type: string, payload: unknown) => void = () => {};
    let cliModel = "";
    const fakeCodex = {
        listModels: async () => ({ data: [{ id: "native", model: "native", displayName: "Native", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] }),
        startThread: async (cwd: string, _permission: unknown, preheat: boolean, model: string) => {
            assert.equal(model, "native"); assert.equal(preheat, true);
            cliEmit("agent_bootstrap", { type: "mcp.complete", phase: "preheat", threadId: "codex-fixture", services: [{ name: "infinite-canvas", authStatus: "unsupported" }] });
            return { id: "codex-fixture", cwd, model };
        },
        startTurn: async (threadId: string, _prompt: string, _files: string[], _permission: unknown, model: string, _effort: unknown, onTurn: (id: string) => void) => {
            cliModel = model; onTurn("cli-turn");
            cliEmit("agent_event", { agent: "codex", type: "turn.started", thread_id: threadId, turn_id: "cli-turn" });
            cliEmit("agent_done", { agent: "codex", thread_id: threadId, turn_id: "cli-turn" });
        },
    };
    CodexAppClient.start = async emit => { cliEmit = emit; return fakeCodex as unknown as CodexAppClient; };
    t.after(() => { CodexAppClient.start = originalStart; });
    const mixedConfig = values.get("ai.config") as any;
    mixedConfig.channels.push({ id: "cli", name: "Codex", kind: "codex-cli", baseUrl: "", apiKey: "", models: [{ name: "native", capability: "text" }] });
    const mixedModels = await json("/codex/models?source=llm");
    assert.equal(mixedModels.data.find((model: any) => model.model === "cli::native").defaultReasoningEffort, "high");
    const mismatch = await fetch(`${url}/agent/codex/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "fixture-client", threadId: reset.workspace.activeThreadId, prompt: "fixture", model: "cli::native" }) });
    assert.equal(mismatch.status, 409); assert.equal((await mismatch.json() as any).code, "MODEL_RUNTIME_CHANGED");
    const nativeReset = await json("/codex/threads/reset", { clientId: "fixture-client", model: "cli::native" });
    assert.equal(nativeReset.workspace.activeThreadId, "codex-fixture"); assert.equal(nativeReset.conversation.status, "ready");
    await json("/codex/turn", { clientId: "fixture-client", threadId: "codex-fixture", prompt: "fixture", model: "cli::native", effort: "high" });
    const nativeDeadline = Date.now() + 5000;
    while (agent.session.codexBusy && Date.now() < nativeDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cliModel, "native"); assert.equal(agent.session.codexBusy, false);
    events.abort(); await response.body?.cancel().catch(() => {});
});
