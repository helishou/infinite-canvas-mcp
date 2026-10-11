import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { ensureCanvasDraftLease } from "../src/lib/canvas/canvas-draft-session";
import "../src/styles/globals.css";

await ensureCanvasDraftLease();
const { useCanvasProductionContext } = await import("../src/components/production/canvas-production-workspace");
const { useProductionWorkspaceStore } = await import("../src/stores/use-production-workspace-store");
const { fetchBackendProject } = await import("../src/services/backend-api");
const [{ default: ProductionPage }, { default: ProductionHubPage }, { default: CanvasLibraryPage }, { AppTopNav }, { AgentPanel }, { ProductionFollowController }, { CanvasTopBar }, { useAgentStore }, { useBackendStore }, { useProductionFollowStore }, { editEpisodeProduction, fetchEpisodeProduction }, { default: i18n }] = await Promise.all([
    import("../src/pages/drama/production"), import("../src/pages/production"), import("../src/pages/canvas"), import("../src/components/layout/app-top-nav"), import("../src/components/agent/agent-panel"),
    import("../src/components/production/production-follow-controller"), import("../src/components/canvas/canvas-top-bar"), import("../src/stores/use-agent-store"), import("../src/stores/use-backend-store"), import("../src/stores/use-production-follow-store"), import("../src/services/backend-api"), import("../src/i18n"),
]);
const { default: LegacyDirectorPage } = await import("../src/pages/director");
function Canvas() {
    const { id = "" } = useParams(); const noop = () => {};
    useCanvasProductionContext(id);
    const [title, setTitle] = useState("Canvas");
    useEffect(() => { let active = true; void fetchBackendProject(id).then(({ project }) => { if (active) setTitle(id === "linked" ? "第一集" : String(project?.title || "Canvas")); }); return () => { active = false; }; }, [id]);
    return <div className="relative min-h-64"><h1 className="pt-20">{title}</h1><CanvasTopBar projectId={id} title="Canvas" titleDraft="" isTitleEditing={false} onTitleDraftChange={noop} onStartTitleEditing={noop} onFinishTitleEditing={noop} onCancelTitleEditing={noop} canUndo={false} canRedo={false} onHome={noop} onProjects={noop} onCreateProject={noop} onDeleteProject={noop} onExportProject={noop} exporting={false} transferBusy={false} onImportImage={noop} onOpenPlugins={noop} onUndo={noop} onRedo={noop} agentOpen={false} compactAgentStatus={{ connected: false, enabled: false, activity: "" }} onToggleAgent={noop} onOpenGenerationLogs={noop} collaborators={[]} onFindNode={noop} /></div>;
}
function Shell() {
    const location = useLocation(), navigate = useNavigate();
    const productionRevision = useProductionWorkspaceStore(state => state.production?.revision);
    const prompt = useAgentStore(s => s.prompt);
    const attachmentCount = useAgentStore(s => s.attachments.length);
    const referenceCount = useAgentStore(s => s.canvasReferences.length);
    const agentConnected = useAgentStore(s => s.connected);
    const agentSending = useAgentStore(s => s.sending);
    const agentWaiting = useAgentStore(s => s.waiting);
    const agentResult = useAgentStore(s => s.scopedTaskResult);
    return <><AppTopNav /><AgentPanel /><ProductionFollowController />
        <div className="flex gap-3 p-2"><button onClick={() => navigate("/director/retry")}>test retry</button><button onClick={() => navigate("/canvas/standalone?productionKind=canvas&productionId=standalone")}>test canvas</button><button onClick={() => navigate("/canvas")}>test canvas library</button><button onClick={() => navigate("/production")}>test production hub</button><button onClick={() => navigate("/director")}>test legacy projects</button><button onClick={() => navigate("/drama/episodes/ep/production")}>test episode</button><button onClick={() => navigate("/director/linked")}>test linked canvas</button><button onClick={() => navigate("/drama")}>test old drama route</button><button onClick={() => void i18n.changeLanguage(i18n.language === "zh-CN" ? "en-US" : "zh-CN")}>test language</button><button onClick={() => void (async () => { const owner = { projectId: "standalone" }; const current = await fetchEpisodeProduction(owner).then(value => value.production); const currentWork = { workId: "follow-fixture", module: "assets" as const, action: "author" as const, targetKind: "asset" as const, targetId: "STYLE_MOTHER", inputRevision: current.revision + 1, sourceHash: current.draft.director?.sourceHash || "a".repeat(64) }; await editEpisodeProduction(owner, current.revision, [{ type: "set_director_workflow", patch: { currentWork } }], "follow-fixture-start"); useBackendStore.setState({ connected: true, checking: false }); useProductionFollowStore.getState().setTarget({ kind: "canvas", id: "standalone", workId: "follow-fixture" }); })()}>test begin follow</button><button onClick={() => void (async () => { const owner = { projectId: "standalone" }; const current = await fetchEpisodeProduction(owner).then(value => value.production); const prior = current.draft.director?.workflow.currentWork; if (!prior) return; const currentWork = { ...prior, module: "story" as const, action: "author" as const, targetKind: "scene" as const, targetId: "scene-follow", inputRevision: current.revision + 1 }; await editEpisodeProduction(owner, current.revision, [{ type: "set_director_workflow", patch: { currentWork } }], "follow-fixture-next"); window.dispatchEvent(new CustomEvent("backend-event", { detail: { type: "drama-production.updated", entityId: "standalone" } })); })()}>test advance focus</button></div>
        <Routes><Route path="/production" element={<ProductionHubPage />} /><Route path="/director" element={<LegacyDirectorPage />} /><Route path="/director/:projectId" element={<ProductionPage />} /><Route path="/drama" element={<ProductionHubPage />} /><Route path="/drama/episodes/:episodeId/production" element={<ProductionPage />} /><Route path="/canvas" element={<CanvasLibraryPage />} /><Route path="/canvas/:id" element={<Canvas />} /></Routes>
        <output aria-label="production revision">{productionRevision}</output><output aria-label="location">{location.pathname}{location.search}</output><output aria-label="agent draft">{prompt}</output><output aria-label="agent preservation">{JSON.stringify({ prompt, attachmentCount, referenceCount })}</output><output aria-label="agent state">{JSON.stringify({ connected: agentConnected, sending: agentSending, waiting: agentWaiting, result: agentResult })}</output>
    </>;
}
const initialRoute = new URLSearchParams(window.location.search).get("start") || "/production";
createRoot(document.getElementById("root")!).render(<ConfigProvider><App><MemoryRouter initialEntries={[initialRoute]}><Shell /></MemoryRouter></App></ConfigProvider>);
