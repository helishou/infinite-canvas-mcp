import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router-dom";
import "../src/styles/globals.css";

// Production AgentPanel with isolated HTTP/SSE fixtures. No requests reach the user's Backend.
const stats = { discovery: 0, connections: 0, blocked: 0 };
let refresh = () => {};
let discoveryFails = false;
let handshakeFails = false;
let delayDiscovery = false;
let releaseDiscovery: (() => void) | undefined;
const conversation = { revision: 1, conversationId: "fixture-conversation", threadId: "fixture-thread", status: "ready", mcpStatuses: {} };

window.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const path = url.pathname;
    if (path === "/health") return Response.json({ ok: false }); // Disable unrelated Backend hydration/polling.
    if (path === "/config") {
        stats.discovery += 1;
        refresh();
        if (delayDiscovery) await new Promise<void>((resolve) => { releaseDiscovery = resolve; });
        return Response.json({ ok: !discoveryFails, token: discoveryFails ? "" : "fixture-token" });
    }
    if (path === "/settings") return Response.json({ ok: true, settings: {} });
    if (path.startsWith("/agent/")) {
        if (path === "/agent/codex/threads/fixture-thread") return Response.json({ ok: true, conversation, messages: [], settledTurnIds: [], historyReady: true });
        if (path === "/agent/codex/threads") return Response.json({ ok: true, conversation, data: [] });
        return Response.json({ ok: true, data: [] });
    }
    stats.blocked += 1;
    refresh();
    throw new Error(`Harness blocked unexpected request: ${path}`);
};

class FixtureEventSource extends EventTarget {
    onerror: ((event: Event) => void) | null = null;
    closed = false;
    constructor(readonly url: string | URL) {
        super();
        const path = new URL(String(url), window.location.origin).pathname;
        if (path !== "/agent/events") throw new Error(`Harness blocked unexpected stream: ${path}`);
        stats.connections += 1;
        refresh();
        setTimeout(() => {
            if (this.closed) return;
            if (handshakeFails) this.onerror?.(new Event("error"));
            else this.dispatchEvent(new MessageEvent("hello", { data: JSON.stringify({ ok: true, protocolVersion: 6, conversation, codex: { busy: false } }) }));
        }, 0);
    }
    close() { this.closed = true; }
}
window.EventSource = FixtureEventSource as unknown as typeof EventSource;

const [{ AgentPanel }, { useAgentStore }] = await Promise.all([
    import("../src/components/agent/agent-panel"),
    import("../src/stores/use-agent-store"),
]);

function reset(mode: "success" | "discovery-failure" | "handshake-failure" | "delayed") {
    releaseDiscovery?.();
    releaseDiscovery = undefined;
    discoveryFails = mode === "discovery-failure";
    handshakeFails = mode === "handshake-failure";
    delayDiscovery = mode === "delayed";
    useAgentStore.getState().disconnectAgent({ panelOpen: false, panelClosing: false, token: "", activeTab: "setup", messages: [], activeThreadId: "", activeTurnId: "" });
    stats.discovery = 0;
    stats.connections = 0;
    stats.blocked = 0;
    refresh();
}
reset("success");

function Harness() {
    const [, render] = useState(0);
    refresh = () => render((value) => value + 1);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const connected = useAgentStore((state) => state.connected);
    const enabled = useAgentStore((state) => state.enabled);
    const entry = new URLSearchParams(window.location.search).has("launch")
        ? "/?agentUrl=http%3A%2F%2F127.0.0.1%3A17370%2Fagent&agentToken=fixture-launch-token"
        : "/";
    return <ConfigProvider><App><MemoryRouter initialEntries={[entry]}>
        <div style={{ padding: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button onClick={() => useAgentStore.getState().openPanel()}>Open sidebar</Button>
            <Button onClick={() => useAgentStore.getState().closePanel()}>Close sidebar</Button>
            <Button onClick={() => reset("success")}>Reset success</Button>
            <Button onClick={() => reset("discovery-failure")}>Reset discovery failure</Button>
            <Button onClick={() => reset("handshake-failure")}>Reset handshake failure</Button>
            <Button onClick={() => reset("delayed")}>Reset delayed discovery</Button>
            <Button onClick={() => { discoveryFails = false; handshakeFails = false; delayDiscovery = false; releaseDiscovery?.(); refresh(); }}>Recover service</Button>
            <Button onClick={() => { useAgentStore.setState({ token: "fixture-external-token" }); useAgentStore.getState().connectAgent({ silent: true }); }}>Connect from another entry</Button>
            <output data-testid="connection-state">{JSON.stringify({ ...stats, panelOpen, connected, enabled })}</output>
        </div>
        <div style={{ display: "flex", height: 760, justifyContent: "flex-end" }}><AgentPanel /></div>
    </MemoryRouter></App></ConfigProvider>;
}

const root = import.meta.hot?.data.root || createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<StrictMode><Harness /></StrictMode>);
