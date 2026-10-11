import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { directorSubagentSchema } from "./delegation.js";
import { LlmAgent, readAgentFile, type LlmSettings } from "./llm.js";
import { configuredLlmProviders, llmHistoryForProvider, parseLlmReply, requestLlm, type Json, type LlmProvider } from "./llm-provider.js";

function settings(config: Json) {
    const data = new Map<string, unknown>([["ai.config", config]]);
    const store: LlmSettings = { get: key => structuredClone(data.get(key)), set: (key, value) => { data.set(key, structuredClone(value)); } };
    return { data, store };
}
async function modelServer(t: import("node:test").TestContext, handler: (body: Json, response: http.ServerResponse) => void) {
    const server = http.createServer(async (request, response) => {
        let body = ""; for await (const chunk of request) body += chunk;
        handler(JSON.parse(body), response);
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function sse(response: http.ServerResponse, values: Json[]) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const value of values) response.write(`data: ${JSON.stringify(value)}\r\n\r\n`);
    response.end("data: [DONE]\r\n\r\n");
}

test("structured image review encodes verified local files at the API boundary and fails before requesting missing media", async t => {
    let requests = 0;
    const url = await modelServer(t, (body, response) => {
        requests++;
        const parts = body.messages.flatMap((message: Json) => Array.isArray(message.content) ? message.content : []);
        assert.ok(parts.some((part: Json) => part.type === "image_url" && part.image_url.url === "data:image/png;base64,cG5n"));
        sse(response, [{ choices: [{ delta: { content: '{"status":"complete"}' }, finish_reason: "stop" }] }]);
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-images-"));
    t.after(() => fs.rm(root, { recursive: true }));
    const file = path.join(root, "image.png"); await fs.writeFile(file, "png");
    const { store } = settings(config(url)), agent = new LlmAgent(store, url, "");
    const request = { cwd: root, prompt: "inspect", schema: { type: "object", required: ["status"] }, onThread: () => {} };
    await agent.structured({ ...request, images: [file] });
    await assert.rejects(agent.structured({ ...request, images: [path.join(root, "missing.png")] }), /ENOENT/);
    assert.equal(requests, 1);
});
const provider = (baseUrl: string, apiFormat: LlmProvider["apiFormat"] = "openai-chat"): LlmProvider => ({ id: "a::model", model: "model", name: "a / model", baseUrl, apiKey: "secret-test-key", apiFormat, systemPrompt: "" });
const config = (baseUrl: string, apiFormat = "openai-chat") => ({ textModel: "a::model", channels: [{ id: "a", name: "A", baseUrl, apiKey: "secret-test-key", apiFormat, models: [{ name: "model", capability: "text" }] }] });

test("canvas channel identity distinguishes equal model names and excludes browser scripts / Comfy", () => {
    const value = configuredLlmProviders({ channels: [
        { ...config("http://a").channels[0], models: [{ name: "same", capability: "text" }, { name: "script", capability: "text", script: "fetch()" }, { name: "image", capability: "image" }] },
        { ...config("http://b").channels[0], id: "b", models: [{ name: "same", capability: "text" }] },
        { ...config("http://c").channels[0], id: "local", kind: "comfyui" },
    ] });
    assert.deepEqual(value.map(item => item.id), ["a::same", "b::same"]);
});

test("Codex channel uses native model identity and effort catalog without HTTP credentials", () => {
    const { store } = settings({ textModel: "cli::native", channels: [{ id: "cli", name: "Codex", kind: "codex-cli", models: [{ name: "native", capability: "text" }] }] });
    const agent = new LlmAgent(store, "http://unused", "");
    assert.equal(agent.provider().kind, "codex-cli"); assert.equal(agent.provider().apiKey, ""); assert.equal(agent.provider().baseUrl, "");
    assert.equal(agent.nativeWorkerModel(), "native"); assert.equal(agent.nativeWorkerModel("cli::native"), "native");
    const catalog = agent.models([{ model: "native", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }]);
    assert.equal(catalog.data[0].model, "cli::native"); assert.equal(catalog.data[0].runtime, "codex"); assert.equal(catalog.data[0].defaultReasoningEffort, "high");
    agent.rememberCodexThread("codex-thread", "cli::native"); assert.equal(agent.codexThreadModel("codex-thread"), "cli::native");
    assert.throws(() => agent.startThread(process.cwd()), /原生 Codex/);
});

test("streamed tool arguments execute exactly once through MCP and persist for restoration", async t => {
    let requests = 0, executed = 0;
    const bodies: Json[] = [];
    const url = await modelServer(t, (body, response) => {
        bodies.push(body); requests++;
        if (requests === 1) sse(response, [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "canvas_test_write", arguments: '{"value":' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"checked"}' } }] }, finish_reason: "tool_calls" }] },
        ]);
        else sse(response, [{ choices: [{ delta: { content: "已完成" }, finish_reason: "stop" }] }]);
    });
    const { store, data } = settings(config(url));
    const connect = async () => {
        const server = new McpServer({ name: "fixture", version: "1" });
        server.registerTool("canvas_test_write", { inputSchema: { value: z.string() } }, async ({ value }) => { executed++; assert.equal(value, "checked"); return { content: [{ type: "text", text: "saved" }] }; });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new Client({ name: "fixture", version: "1" });
        await client.connect(clientTransport);
        return client;
    };
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-llm-test-"));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    const agent = new LlmAgent(store, url, "", connect);
    const thread = agent.startThread(cwd);
    const events: Json[] = [];
    let finished = false;
    await agent.run("修改测试画布", (type, payload) => events.push({ type, payload }), [], { threadId: thread.id, cwd, onFinish: () => { finished = true; } });
    assert.equal(executed, 1); assert.equal(requests, 2); assert.equal(finished, true);
    assert.equal(bodies[1].messages.find((message: Json) => message.role === "tool").tool_call_id, "call-1");
    assert.ok(events.some(event => event.type === "agent_event" && event.payload.type === "item.updated"));
    const restored = new LlmAgent(store, url, "", connect).read(thread.id, cwd);
    assert.equal(restored.thread.status, "completed");
    assert.ok(restored.messages.some(message => message.role === "assistant" && message.text === "已完成"));
    assert.equal(JSON.stringify(data.get(`agent.llm.thread:${thread.id}`)).includes("secret-test-key"), false);
    assert.throws(() => agent.read(thread.id, path.join(cwd, "other")), /工作空间/);
});

test("API delegation binds the actual parent/channel and preserves an explicit canvas over the active canvas", async t => {
    let requests = 0, delegated: Json | undefined;
    const url = await modelServer(t, (_body, response) => {
        requests++;
        if (requests === 1) sse(response, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "delegate-1", function: { name: "director_subagent", arguments: JSON.stringify({ action: "spawn", projectId: "requested-canvas", parentThreadId: "wrong-director", operationId: "one", title: "核对分镜", role: "shots", prompt: "确认覆盖范围" }) } }] }, finish_reason: "tool_calls" }] }]);
        else sse(response, [{ choices: [{ delta: { content: "已派发，等待结果" }, finish_reason: "stop" }] }]);
    });
    const { store } = settings(config(url));
    const connect = async () => {
        const server = new McpServer({ name: "fixture", version: "1" });
        server.registerTool("canvas_set_active_project", { inputSchema: { id: z.string() } }, async () => ({ content: [{ type: "text", text: "bound" }] }));
        server.registerTool("director_subagent", { inputSchema: directorSubagentSchema }, async input => { delegated = input; return { content: [{ type: "text", text: JSON.stringify({ taskId: "child-1", status: "queued" }) }] }; });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new Client({ name: "fixture", version: "1" }); await client.connect(clientTransport); return client;
    };
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "director-delegate-api-"));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    const agent = new LlmAgent(store, url, "", connect), thread = agent.startThread(cwd);
    await agent.run("派一个分镜子代理", () => {}, [], { threadId: thread.id, cwd }, "real-canvas");
    assert.equal(delegated?.projectId, "requested-canvas", "explicit project identity is never silently replaced by the active canvas");
    assert.equal(delegated?.parentThreadId, thread.id);
    assert.ok(delegated?.parentTurnId);
    assert.equal(delegated?.model, thread.model);
    assert.equal(requests, 2);
});

test("truncated tool stream cannot execute tools; upstream credentials are not exposed", async t => {
    const url = await modelServer(t, (_body, response) => sse(response, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "partial", function: { name: "write", arguments: "{}" } }] } }] }]));
    await assert.rejects(requestLlm(provider(url), "", [{ role: "user", parts: [{ text: "x" }] }], [], new AbortController().signal), /响应流中断/);
    const errorUrl = await modelServer(t, (_body, response) => { response.writeHead(401); response.end("secret-test-key private upstream body"); });
    await assert.rejects(requestLlm(provider(errorUrl), "", [], [], new AbortController().signal), error => error instanceof Error && error.message.includes("401") && !error.message.includes("secret-test-key"));
});

test("Responses reasoning and Gemini thought signatures survive same-provider replay, but not model switches", () => {
    const p = provider("http://unused", "openai");
    const reply = parseLlmReply(p, [{ type: "response.completed", response: { status: "completed", output: [{ type: "reasoning", encrypted_content: "opaque" }, { type: "function_call", call_id: "r1", name: "read", arguments: "{}" }] } }]);
    assert.equal(llmHistoryForProvider([reply.message], p)[0].native?.[0].encrypted_content, "opaque");
    const switched = llmHistoryForProvider([reply.message, { role: "tool", callId: "r1", callName: "read", parts: [{ text: "saved" }] }], { ...p, id: "b::model", apiFormat: "gemini" });
    assert.equal(switched[0].native, undefined); assert.equal(switched[1].role, "user");
    const g = parseLlmReply(provider("http://unused", "gemini"), [{ candidates: [{ finishReason: "STOP", content: { parts: [{ thoughtSignature: "signed", functionCall: { name: "read", args: {} } }] } }] }]);
    assert.equal(g.message.native?.[0].thoughtSignature, "signed");
});

test("restart keeps unknown tool intent and never replays it automatically", () => {
    const { store, data } = settings(config("http://unused"));
    const agent = new LlmAgent(store, "http://unused", "");
    const thread = agent.startThread(process.cwd());
    const persisted = data.get(`agent.llm.thread:${thread.id}`) as Json;
    persisted.turns = [{ id: "crashed-turn", status: "running", display: [], messages: [{ role: "assistant", parts: [], calls: [{ id: "submitted", name: "generate", arguments: '{"operationId":"stable"}' }] }] }];
    store.set(`agent.llm.thread:${thread.id}`, persisted);
    const restored = agent.read(thread.id, process.cwd());
    assert.deepEqual(restored.settledTurnIds, ["crashed-turn"]);
    assert.equal(restored.thread.status, "interrupted");
    const updated = data.get(`agent.llm.thread:${thread.id}`) as Json;
    assert.match(updated.turns[0].messages[1].parts[0].text, /不得自动重提/);
});

test("structured worker recovery uses its completed original turn without another model request", async t => {
    let requests = 0, turnId = "";
    const url = await modelServer(t, (_body, response) => { requests++; sse(response, [{ choices: [{ delta: { content: '{"status":"complete"}' }, finish_reason: "stop" }] }]); });
    const { store } = settings(config(url));
    const agent = new LlmAgent(store, url, "");
    const request = { cwd: process.cwd(), prompt: "complete", schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] }, onThread: () => {}, onTurn: (id: string) => { turnId = id; } };
    const result = await agent.structured(request);
    assert.deepEqual(result.output, { status: "complete" });
    assert.deepEqual((await agent.structured({ ...request, threadId: result.threadId, turnId, recoverOutput: true })).output, result.output);
    assert.equal(requests, 1);
    await assert.rejects(agent.structured({ ...request, threadId: result.threadId, turnId: "wrong-turn", recoverOutput: true }), /RECOVERY_REQUIRED/);
    let created = false;
    await assert.rejects(agent.structured({ ...request, recoverOutput: true, onThread: () => { created = true; } }), /RECOVERY_REQUIRED/);
    assert.equal(created, false); assert.equal(requests, 1);
});

test("read-only skill files cannot escape the workspace by traversal", async t => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-llm-read-"));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    await fs.writeFile(path.join(cwd, "SKILL.md"), "fixture");
    assert.equal(await readAgentFile(cwd, "SKILL.md"), "fixture");
    await assert.rejects(readAgentFile(cwd, path.join(process.cwd(), "package.json")), /不属于/);
});

test("structured workers reject invalid results locally without a schema-capable API or paid retry", async t => {
    let requests = 0;
    const url = await modelServer(t, (body, response) => {
        requests++; assert.equal(body.response_format, undefined);
        assert.match(body.messages[0].content, /JSON Schema/);
        sse(response, [{ choices: [{ delta: { content: '{"wrong":"value"}' }, finish_reason: "stop" }] }]);
    });
    const { store } = settings(config(url));
    const agent = new LlmAgent(store, url, "");
    await assert.rejects(agent.structured({ cwd: process.cwd(), prompt: "fixture", schema: { type: "object", required: ["status"] }, onThread: () => {} }), /不符合合同/);
    assert.equal(requests, 1);
});

test("stopping a response restores idle state and cannot execute an unfinished tool", async t => {
    const waiting = Promise.withResolvers<void>();
    const url = await modelServer(t, (_body, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.write('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n'); waiting.resolve(); });
    const { store } = settings(config(url));
    const agent = new LlmAgent(store, url, "", async () => {
        const [a, b] = InMemoryTransport.createLinkedPair();
        const server = new McpServer({ name: "stop", version: "1" });
        server.registerTool("fixture_read", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "fixture" }] }));
        await server.connect(b);
        const client = new Client({ name: "stop", version: "1" }); await client.connect(a); return client;
    });
    const thread = agent.startThread(process.cwd());
    let finished = false;
    const run = agent.run("fixture", () => {}, [], { cwd: process.cwd(), threadId: thread.id, onFinish: () => { finished = true; } });
    await waiting.promise; assert.equal(agent.interrupt(thread.id), true);
    await run;
    assert.equal(finished, true); assert.equal(agent.read(thread.id).thread.status, "interrupted");
    assert.equal(agent.interrupt(thread.id), false);
});
