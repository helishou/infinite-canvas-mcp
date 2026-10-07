import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router-dom";
import "../src/styles/globals.css";
import i18n from "../src/i18n";

const calls: Array<{ method: string; path: string; body?: unknown }> = [];
let interruptStatus = 200;
const conversation = { revision: 4, conversationId: "queue-conversation", threadId: "queue-thread", status: "running" as const, mcpStatuses: {} };
let runtime = { instanceId: "queue-runtime", revision: 10, heartbeatIntervalMs: 15000, codex: { busy: true, threadId: "queue-thread", turnId: "active-turn" }, conversation, pendingApprovals: [] };

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const method = init?.method || (input instanceof Request ? input.method : "GET");
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init?.body; }
    calls.push({ method, path: url.pathname, body });
    if (method === "POST" && url.pathname === "/agent/codex/turn") return Response.json({ ok: true, threadId: "queue-thread" });
    if (method === "POST" && url.pathname === "/agent/codex/interrupt") return Response.json({ ok: interruptStatus < 300 }, { status: interruptStatus });
    if (url.pathname === "/agent/codex/threads") return Response.json({ ok: true, workspace: { workspacePath: "C:/fixture", activeThreadId: "queue-thread" }, conversation, data: [{ id: "queue-thread", preview: "Queue fixture" }] });
    if (url.pathname === "/agent/codex/threads/queue-thread") return Response.json({ ok: true, conversation, messages: [], settledTurnIds: [], historyReady: true });
    if (url.pathname === "/agent/codex/models") return Response.json({ ok: true, data: [] });
    if (url.pathname === "/agent/codex/skills") return Response.json({ ok: true, data: [] });
    if (url.pathname === "/agent/codex/state") return Response.json({ ok: true, runtime });
    if (url.pathname.endsWith("/settings")) return Response.json({ ok: true, settings: {} });
    if (method === "GET") return Response.json({ ok: true, data: [], projects: [], tasks: [] });
    return Response.json({ ok: true });
};

await i18n.changeLanguage("zh-CN");
const [{ AgentPanel }, { useAgentStore }, { useProductionWorkspaceStore }] = await Promise.all([
    import("../src/components/agent/agent-panel"),
    import("../src/stores/use-agent-store"),
    import("../src/stores/use-production-workspace-store"),
]);
useProductionWorkspaceStore.setState({ panelTab: "director" });
useAgentStore.setState({
    enabled: false,
    connected: true,
    url: "http://127.0.0.1:17370/agent",
    token: "queue-fixture-token",
    panelOpen: true,
    panelMounted: true,
    activeTab: "chat",
    prompt: "",
    attachments: [],
    canvasReferences: [],
    messages: [],
    activeThreadId: "queue-thread",
    activeTurnId: "active-turn",
    waiting: true,
    sending: false,
    conversation,
    codexRuntime: { instanceId: "queue-runtime", revision: 10, busy: true, threadId: "queue-thread", turnId: "active-turn" },
    queuedPrompts: [],
    pausedPromptQueueScopes: [],
    pendingTool: null,
    pendingApprovals: [],
});

Object.assign(window, {
    __agentPromptQueueTest: {
        calls,
        async flushQueue() { await (await import("../src/stores/use-agent-store")).flushAgentPromptQueue(); },
        snapshot: () => {
            const state = useAgentStore.getState();
            return { queue: state.queuedPrompts.map((item) => ({ id: item.id, status: item.status, text: item.payload.messageText, attachments: item.payload.attachments.map(({ id, url, dataUrl }) => ({ id, url, dataUrl })) })), paused: state.pausedPromptQueueScopes.length > 0, users: state.messages.filter((item) => item.role === "user").map((item) => ({ id: item.id, clientMessageId: item.clientMessageId, text: item.text })) };
        },
        setInterruptStatus(status: number) { interruptStatus = status; },
        setQueuePaused(paused: boolean) {
            const state = useAgentStore.getState();
            state.setPromptQueuePaused(state.activeThreadId, state.conversation.conversationId, paused);
        },
        setLanguage(language: string) { return i18n.changeLanguage(language); },
        setAttachmentFixture() {
            const dataUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E";
            useAgentStore.setState({ attachments: [{ id: "image-attachment", name: "fixture.svg", type: "image/svg+xml", size: dataUrl.length, width: 1, height: 1, url: dataUrl, dataUrl }] });
        },
        setIdle(revision = 11, advanceConversationRevision = true, clearRuntimeThread = false) {
            const previous = useAgentStore.getState().conversation;
            const ready = { ...previous, revision: previous.revision + (advanceConversationRevision ? 1 : 0), status: "ready" as const };
            runtime = { ...runtime, revision, codex: { busy: false, threadId: clearRuntimeThread ? "" : "queue-thread", turnId: clearRuntimeThread ? "" : "active-turn" }, conversation: ready };
            useAgentStore.setState({ conversation: ready, waiting: false, sending: false, activeTurnId: "", codexRuntime: { instanceId: runtime.instanceId, revision, busy: false, threadId: runtime.codex.threadId, turnId: runtime.codex.turnId } });
        },
        setIdleInNewInstance(instanceId: string, revision = 1) {
            const previous = useAgentStore.getState().conversation;
            const ready = { ...previous, revision: previous.revision + 1, status: "ready" as const };
            runtime = { ...runtime, instanceId, revision, codex: { busy: false, threadId: "queue-thread", turnId: "" }, conversation: ready };
            useAgentStore.setState({ conversation: ready, waiting: false, sending: false, activeTurnId: "", codexRuntime: { instanceId, revision, busy: false, threadId: "", turnId: "" } });
        },
        setBusy(revision = 12) {
            const previous = useAgentStore.getState().conversation;
            const running = { ...previous, revision: previous.revision + 1, status: "running" as const };
            runtime = { ...runtime, revision, codex: { busy: true, threadId: "queue-thread", turnId: "active-turn" }, conversation: running };
            useAgentStore.setState({ conversation: running, waiting: true, sending: false, activeTurnId: "active-turn", codexRuntime: { instanceId: runtime.instanceId, revision, busy: true, threadId: "queue-thread", turnId: "active-turn" } });
        },
    },
});

createRoot(document.getElementById("root")!).render(
    <StrictMode><ConfigProvider><App><MemoryRouter initialEntries={["/canvas/test"]}><AgentPanel /></MemoryRouter></App></ConfigProvider></StrictMode>,
);
