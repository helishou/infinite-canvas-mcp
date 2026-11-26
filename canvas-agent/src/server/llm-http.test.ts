import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import express from "express";

/**
 * 旧的「任意 OpenAI 兼容渠道当导演模型」链路已从导演链路移除（agent-channels.ts 只收 codex-cli / hermes），
 * 因此这里不再驱动那条 HTTP 回合，改为守当前契约：混合渠道下拉不拉本机 Codex，切换引擎必须重置线程。
 */
test("混合渠道下拉不启动 Codex，且不允许跨引擎复用线程", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-channel-http-"));
    process.env.INFINITE_CANVAS_AGENT_CONFIG_DIR = directory;
    t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }));
    // 预热会拉起真实 hermes acp 子进程，测试里没有画布 MCP 可用；停掉它，否则进程被 stdio 挂住。
    const { HermesAgent } = await import("../agent/hermes-agent.js");
    const originalWarm = HermesAgent.prototype.warm;
    HermesAgent.prototype.warm = async () => true;
    t.after(() => { HermesAgent.prototype.warm = originalWarm; });
    const { createAgentApp } = await import("./http.js");
    const app = express();
    app.use(express.json());
    const values = new Map<string, unknown>([["ai.config", {
        textModel: "hermes-local::qwen",
        channels: [
            { id: "hermes-local", name: "Hermes", kind: "hermes", models: [{ name: "qwen", capability: "text" }] },
            { id: "cli", name: "Codex", kind: "codex-cli", models: [{ name: "native", capability: "text" }] },
        ],
    }]]);
    const agent = createAgentApp({ listen: false, backendUrl: "http://127.0.0.1:9", backendToken: "fixture-token", settings: { get: key => values.get(key), set: (key, value) => { values.set(key, structuredClone(value)); } } });
    app.use("/agent", agent.app);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const json = async (route: string, body?: unknown) => {
        const response = await fetch(`${url}/agent${route}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(response.status, 200); return await response.json() as any;
    };
    const models = await json("/codex/models?source=llm");
    assert.deepEqual(models.data.map((item: any) => item.model), ["hermes-local::qwen", "cli::native"]);
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
    // turn 要求网页已连上事件流；结束后必须 abort，否则测试进程被 SSE 挂住。
    const events = new AbortController();
    t.after(() => events.abort());
    const stream = await fetch(`${url}/agent/events?clientId=fixture-client`, { signal: events.signal });
    assert.equal(stream.status, 200);
    // 先建 Codex 原生线程（用假 client，不碰真实 ACP）；再用 Hermes 模型发起回合，必须被拒绝。
    const nativeReset = await json("/codex/threads/reset", { clientId: "fixture-client", model: "cli::native" });
    assert.equal(nativeReset.workspace.activeThreadId, "codex-fixture"); assert.equal(nativeReset.conversation.status, "ready");
    const mismatch = await fetch(`${url}/agent/codex/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "fixture-client", threadId: nativeReset.workspace.activeThreadId, prompt: "fixture", model: "hermes-local::qwen" }) });
    assert.equal(mismatch.status, 409); assert.equal((await mismatch.json() as any).code, "MODEL_RUNTIME_CHANGED");
    await json("/codex/turn", { clientId: "fixture-client", threadId: "codex-fixture", prompt: "fixture", model: "cli::native", effort: "high" });
    const nativeDeadline = Date.now() + 5000;
    while (agent.session.codexBusy && Date.now() < nativeDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cliModel, "native"); assert.equal(agent.session.codexBusy, false);
});
