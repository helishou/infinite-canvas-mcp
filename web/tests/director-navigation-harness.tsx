import React from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { ensureCanvasDraftLease } from "../src/lib/canvas/canvas-draft-session";
import "../src/styles/globals.css";

await ensureCanvasDraftLease();
const [{ default: DirectorPage }, { default: ProductionPage }, { AppTopNav }, { CanvasTopBar }, { useAgentStore }, { default: i18n }] = await Promise.all([
    import("../src/pages/director"), import("../src/pages/drama/production"), import("../src/components/layout/app-top-nav"),
    import("../src/components/canvas/canvas-top-bar"), import("../src/stores/use-agent-store"), import("../src/i18n"),
]);
function Canvas() {
    const { id = "" } = useParams(); const noop = () => {};
    return <div className="relative h-64"><CanvasTopBar projectId={id} title="Canvas" titleDraft="" isTitleEditing={false} onTitleDraftChange={noop} onStartTitleEditing={noop} onFinishTitleEditing={noop} onCancelTitleEditing={noop} canUndo={false} canRedo={false} onHome={noop} onProjects={noop} onCreateProject={noop} onDeleteProject={noop} onExportProject={noop} exporting={false} transferBusy={false} onImportImage={noop} onOpenPlugins={noop} onUndo={noop} onRedo={noop} agentOpen={false} compactAgentStatus={{ connected: false, enabled: false, activity: "" }} onToggleAgent={noop} globalPrompt="" onOpenGenerationLogs={noop} collaborators={[]} onFindNode={noop} /></div>;
}
function Shell() {
    const location = useLocation(), navigate = useNavigate();
    const prompt = useAgentStore(s => s.prompt);
    return <><AppTopNav />
        <div className="flex gap-3 p-2"><button onClick={() => navigate("/director/retry")}>test retry</button><button onClick={() => navigate("/canvas/standalone")}>test canvas</button><button onClick={() => navigate("/drama/episodes/ep/production")}>test episode</button><button onClick={() => navigate("/director/linked")}>test linked canvas</button><button onClick={() => void i18n.changeLanguage(i18n.language === "zh-CN" ? "en-US" : "zh-CN")}>test language</button></div>
        <Routes><Route path="/director" element={<DirectorPage />} /><Route path="/director/:projectId" element={<ProductionPage />} /><Route path="/drama/episodes/:episodeId/production" element={<ProductionPage />} /><Route path="/canvas/:id" element={<Canvas />} /></Routes>
        <output aria-label="location">{location.pathname}</output><output aria-label="agent draft">{prompt}</output>
    </>;
}
createRoot(document.getElementById("root")!).render(<ConfigProvider><App><MemoryRouter initialEntries={["/director"]}><Shell /></MemoryRouter></App></ConfigProvider>);
