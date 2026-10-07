import React from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import localforage from "localforage";
import { ensureCanvasDraftLease } from "../src/lib/canvas/canvas-draft-session";
import "../src/styles/globals.css";

let project: any = { id: "formal-recovery-browser", title: "Formal Clip recovery fixture", revision: 5, createdAt: "", updatedAt: "", nodes: [{ id: "h3", type: "minimax-h3:formal-recovery-fixture", title: "Formal Clip", position: { x: 100, y: 100 }, width: 600, height: 400, metadata: { segments: [{ id: "clip", duration: 5, prompt: "Compiled prompt", result: "historical.mp4", productionClipProjection: { inputHash: "compiled" } }] } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, globalPrompt: "", viewport: { x: 0, y: 0, k: 1 } };
const submissions: unknown[] = [];
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (!["17370", "17371"].includes(url.port)) return originalFetch(input, init);
    if (url.pathname === `/canvas/projects/${project.id}/ops` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)); submissions.push(body);
        project = applyBackendCanvasDelta(project, body.operations, project.revision + 1);
        return Response.json({ ok: true, project, revision: project.revision });
    }
    const payload = url.pathname === "/config" ? { ok: true, token: "fixture-token" }
        : url.pathname.includes("/ops/") ? { ok: true, committed: false }
        : url.pathname === "/canvas/projects" ? { ok: true, projects: [project], total: 1 }
        : url.pathname === "/canvas/folders" ? { ok: true, folders: [] }
        : url.pathname.includes(`/canvas/projects/${project.id}`) ? { ok: true, project, context: { role: "ordinary", canvasId: project.id }, assets: [], operations: [], revision: project.revision }
        : { ok: true, settings: {}, data: [], tasks: [], operations: [], assets: [] };
    return Response.json(payload);
};
class OfflineSocket extends EventTarget { static OPEN = 1; static CLOSED = 3; readyState = 3; binaryType = "arraybuffer"; onopen = null; onmessage = null; onclose = null; onerror = null; send() {} close() {} }
window.WebSocket = OfflineSocket as unknown as typeof WebSocket;
class OfflineEvents extends EventTarget { static CLOSED = 2; readyState = 2; onopen = null; onmessage = null; onerror = null; close() {} }
window.EventSource = OfflineEvents as unknown as typeof EventSource;

await ensureCanvasDraftLease();
const { getBackendUrl, getCanvasDraftSessionId } = await import("../src/services/backend-api");
const outbox = localforage.createInstance({ name: "infinite-canvas-command-outbox", storeName: "commands" });
await outbox.setItem("old-formal-browser", { operationId: "old-formal-browser", projectId: project.id, ownerId: getCanvasDraftSessionId(), backend: getBackendUrl(), order: 1, base: structuredClone(project), baseRevision: project.revision,
    rejected: new URLSearchParams(window.location.search).has("hashFailure")
        ? 'HTTP 400 The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined'
        : "HTTP 400 字段 prompt 属于正式编译产物，请修改编译前源稿后重新编译", operations: [{ type: "update_h3_segment", nodeId: "h3", segmentId: "clip", patch: { prompt: "Preserved manual prompt" } }] });
const [{ useCanvasStore, hydrateCanvasProjects, flushCanvasSyncNow, applyBackendCanvasDelta }, { useBackendStore }, { registerNodeDefinitions }, { default: CanvasPage }, { default: i18n }] = await Promise.all([
    import("../src/stores/canvas/use-canvas-store"), import("../src/stores/use-backend-store"), import("../src/lib/canvas/node-registry"), import("../src/pages/canvas/project"), import("../src/i18n"),
]);
registerNodeDefinitions([{ type: "minimax-h3:formal-recovery-fixture", title: "Formal Clip", icon: null, defaultSize: { width: 600, height: 400 }, Content: () => <div>Preserved manual Clip editing draft</div> }], "formal-recovery-fixture");
useBackendStore.setState({ connected: true });
await hydrateCanvasProjects(); await flushCanvasSyncNow(); await i18n.changeLanguage("zh-CN");
Object.assign(window, { formalRecoveryFixture: { evidence: () => ({ submissions, project, conflicts: useCanvasStore.getState().canvasConflicts, connected: useBackendStore.getState().connected }), outbox: () => outbox.keys() } });
createRoot(document.getElementById("root")!).render(<ConfigProvider><App><div style={{ height: "100dvh" }}><MemoryRouter initialEntries={[`/canvas/${project.id}`]}><Routes><Route path="/canvas/:id" element={<CanvasPage />} /></Routes></MemoryRouter></div></App></ConfigProvider>);
