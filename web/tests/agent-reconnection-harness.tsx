import React, { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router-dom";
import "../src/styles/globals.css";
import i18n from "../src/i18n";

let connections = 0, submissions = 0;
const conversation = { revision: 4, conversationId: "reconnect-conversation", threadId: "reconnect-thread", status: "ready", mcpStatuses: {} };
const runtime = { instanceId: "reconnect-runtime", revision: 10, heartbeatIntervalMs: 15000, codex: { busy: false, threadId: conversation.threadId, turnId: "" }, conversation, pendingApprovals: [] };
const AGENT_PROTOCOL_VERSION = 6;
class FixtureEvents {
    listeners = new Map<string, EventListener>();
    closed = false;
    onerror: unknown;
    constructor() {
        connections++;
        queueMicrotask(() => {
            if (!this.closed) this.listeners.get("hello")?.(new MessageEvent("hello", { data: JSON.stringify({ protocolVersion: AGENT_PROTOCOL_VERSION, conversation, runtime, codex: runtime.codex }) }));
        });
    }
    addEventListener(name: string, callback: EventListener) { this.listeners.set(name, callback); }
    close() { this.closed = true; }
}
window.EventSource = FixtureEvents as unknown as typeof EventSource;
window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    if (url.pathname.endsWith("/codex/turn")) {
        submissions++;
        return Response.json({ ok: false, code: "CLIENT_DISCONNECTED", error: "发起任务的网页已断开，请重新连接后再试" }, { status: 409 });
    }
    if (url.pathname.endsWith("/codex/threads")) return Response.json({ ok: true, workspace: { activeThreadId: conversation.threadId }, conversation, data: [] });
    if (url.pathname.endsWith("/codex/state")) return Response.json({ ok: true, runtime });
    if (url.pathname.includes("/codex/threads/")) return Response.json({ ok: true, conversation, messages: [], settledTurnIds: [], historyReady: true });
    return Response.json({ ok: true, data: [], tasks: [], settings: {} });
};
await i18n.changeLanguage("zh-CN");
const [{ LocalAgentPanel }, { useAgentStore }] = await Promise.all([
    import("../src/components/agent/local-agent-panel"), import("../src/stores/use-agent-store"),
]);
useAgentStore.setState({ enabled: true, connected: false, url: "http://127.0.0.1:17370/agent", token: "fixture", activeThreadId: conversation.threadId, conversation: conversation as any, prompt: "保留这条未发出的任务", attachments: [], canvasReferences: [], sending: false, waiting: false, activeTab: "chat", queuedPrompts: [] });
function Harness() {
    const state = useSyncExternalStore(useAgentStore.subscribe, useAgentStore.getState);
    return <><h1>模拟连接拒绝，不调用模型</h1><LocalAgentPanel embedded /><output data-testid="connection-evidence">{JSON.stringify({ connections, submissions, connected: state.connected, prompt: state.prompt, sending: state.sending })}</output></>;
}
createRoot(document.getElementById("root")!).render(<ConfigProvider><App><MemoryRouter><Harness /></MemoryRouter></App></ConfigProvider>);
