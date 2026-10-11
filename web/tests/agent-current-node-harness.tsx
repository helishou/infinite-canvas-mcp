import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter, useLocation } from "react-router-dom";
import "../src/styles/globals.css";

let nodeId = "node-a", segmentId = "clip-a", reads = 0;
const presentation = () => ({ key: nodeId, workId: "current-work", owner: { kind: "canvas", id: "current-canvas" }, canvasId: "current-canvas", workspace: "production", action: "produce", status: "working", nodeId, segmentId });
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    if (!["17370", "17371"].includes(url.port)) return originalFetch(input, init);
    const payload = url.pathname.endsWith("/readiness") ? (++reads, { ok: true, readiness: { presentation: presentation() } }) : { ok: true, config: null, token: "", settings: {}, threads: [], data: [], messages: [] };
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
};
class OfflineEvents extends EventTarget { static CLOSED = 2; readyState = 2; onopen = null; onmessage = null; onerror = null; close() {} }
window.EventSource = OfflineEvents as unknown as typeof EventSource;
const [{ AgentPanel }, { ProductionFollowController }, { useAgentStore }, { useBackendStore }, { useProductionFollowStore }, { useThemeStore }, { default: i18n }] = await Promise.all([
    import("../src/components/agent/agent-panel"), import("../src/components/production/production-follow-controller"), import("../src/stores/use-agent-store"), import("../src/stores/use-backend-store"), import("../src/stores/use-production-follow-store"), import("../src/stores/use-theme-store"), import("../src/i18n"),
]);
useAgentStore.setState({ enabled: true, connected: false, panelOpen: true, panelMounted: true, activeTab: "chat", prompt: "保留草稿", waiting: true, messages: [] });
useBackendStore.setState({ connected: true, checking: false });
useProductionFollowStore.setState({ target: { kind: "canvas", id: "current-canvas", workId: "current-work" }, presentation: presentation() as any, following: false, guardReasons: {}, guardReason: "", lastPath: "", expectedPath: "" });
Object.assign(window, { currentNodeFixture: {
    advance: () => { nodeId = "node-b"; segmentId = "clip-b"; },
    open: () => useAgentStore.getState().openPanel(),
    clear: () => useProductionFollowStore.setState({ target: undefined, presentation: null, following: false }),
    appearance: (language: string, theme: "light" | "dark") => { void i18n.changeLanguage(language); useThemeStore.setState({ theme }); },
    snapshot: () => ({ reads, follow: useProductionFollowStore.getState().following, open: useAgentStore.getState().panelOpen, prompt: useAgentStore.getState().prompt, waiting: useAgentStore.getState().waiting }),
} });
function Shell() {
    const location = useLocation();
    const [focus, setFocus] = useState("");
    useEffect(() => {
        const onFocus = (event: Event) => setFocus(JSON.stringify((event as CustomEvent).detail));
        window.addEventListener("production-focus", onFocus);
        return () => window.removeEventListener("production-focus", onFocus);
    }, []);
    return <><ProductionFollowController /><AgentPanel /><output data-testid="location">{location.pathname}{location.search}</output><output data-testid="focus">{focus}</output></>;
}
createRoot(document.getElementById("root")!).render(<ConfigProvider><App><MemoryRouter initialEntries={["/canvas/current-canvas"]}><Shell /></MemoryRouter></App></ConfigProvider>);
