import React, { useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ensureCanvasDraftLease } from "../src/lib/canvas/canvas-draft-session";
import type { CanvasNodeContext } from "../src/types/canvas-plugin";
import "../src/styles/globals.css";

const project = { id: "focus-fixture", title: "Focus fixture", revision: 1, createdAt: "", updatedAt: "", nodes: [{ id: "h3-fixture", type: "minimax-h3:focus-fixture", title: "H3 focus fixture", position: { x: 1400, y: 700 }, width: 3000, height: 1400, metadata: { segments: [{ id: "clip-1", duration: 5 }, { id: "clip-2", duration: 5 }] } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, globalPrompt: "", viewport: { x: 0, y: 0, k: 1 } };
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (!url.port || !["17370", "17371"].includes(url.port)) return originalFetch(input, init);
    const payload = url.pathname === "/config" ? { ok: true, token: "fixture-token" }
        : url.pathname.endsWith("/character-assets/sync") ? { ok: true, operations: [], revision: 1 }
        : url.pathname.includes("/canvas/projects/focus-fixture") ? { ok: true, project, operations: [], revision: 1, context: { role: "ordinary", canvasId: project.id } }
        : url.pathname === "/canvas/projects" ? { ok: true, projects: [project], total: 1 }
        : { ok: true, projects: [project], config: null, context: null, settings: {}, assets: [], folders: [], data: [], operations: [] };
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
};
class OfflineSocket extends EventTarget {
    static OPEN = 1; static CLOSED = 3; readyState = 3; binaryType = "arraybuffer";
    onopen = null; onmessage = null; onclose = null; onerror = null;
    send() {} close() {}
}
window.WebSocket = OfflineSocket as unknown as typeof WebSocket;
class OfflineEvents extends EventTarget { static CLOSED = 2; readyState = 2; onopen = null; onmessage = null; onerror = null; close() {} }
window.EventSource = OfflineEvents as unknown as typeof EventSource;

await ensureCanvasDraftLease();
const [{ useCanvasStore }, { registerNodeDefinitions }, { getPluginNodeView }, { useProductionFollowStore }, { useThemeStore }, { default: CanvasPage }] = await Promise.all([
    import("../src/stores/canvas/use-canvas-store"), import("../src/lib/canvas/node-registry"), import("../src/stores/canvas/plugin-node-view"), import("../src/stores/use-production-follow-store"), import("../src/stores/use-theme-store"), import("../src/pages/canvas/project"),
]);
function FixtureH3({ ctx }: { ctx: CanvasNodeContext }) {
    const view = useSyncExternalStore(ctx.view.subscribe, ctx.view.getSnapshot);
    const requestId = Number(view.h3FocusRequest || 0);
    useEffect(() => {
        if (!requestId) return;
        const frame = requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("minimax-h3-focus-preview", { detail: { projectId: project.id, nodeId: "h3-fixture", requestId } })));
        return () => cancelAnimationFrame(frame);
    }, [requestId]);
    return <div style={{ width: "100%", height: "100%" }}>
        <div className="minimax-player-stage" style={{ width: 960, height: 220, margin: 24, background: "#446" }}>Preview</div>
        <div data-testid="focused-clip">{String(view.selectedSegmentId || "")}</div>
        <div style={{ margin: 24 }}>Prompt, timeline and settings occupy the rest of this 3000 × 1400 node.</div>
    </div>;
}
registerNodeDefinitions([{ type: "minimax-h3:focus-fixture", title: "H3 focus fixture", icon: null, defaultSize: { width: 3000, height: 1400 }, Content: FixtureH3 }], "focus-fixture");
useCanvasStore.setState({ hydrated: true, projects: [project as any], folders: [] });
const focus = () => {
    useProductionFollowStore.getState().setTarget({ kind: "canvas", id: project.id, workId: "fixture-work" });
    window.dispatchEvent(new CustomEvent("production-focus", { detail: { canvasId: project.id, nodeId: "h3-fixture", segmentId: "clip-2", workId: "fixture-work" } }));
};
Object.assign(window, { focusFixture: {
    focus,
    view: () => getPluginNodeView(project.id, "h3-fixture").getSnapshot(),
    metadata: () => useCanvasStore.getState().projects.find(item => item.id === project.id)?.nodes[0].metadata,
    theme: (value: "dark" | "light") => useThemeStore.setState({ theme: value }),
} });
createRoot(document.getElementById("root")!).render(<ConfigProvider><App><div style={{ height: "100dvh" }}><MemoryRouter initialEntries={[`/canvas/${project.id}?nodeId=h3-fixture&segmentId=clip-2`]}><Routes><Route path="/canvas/:id" element={<CanvasPage />} /></Routes></MemoryRouter></div></App></ConfigProvider>);
