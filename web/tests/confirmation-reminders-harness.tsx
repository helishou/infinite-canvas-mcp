import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { AgentPanel } from "@/components/agent/agent-panel";
import { useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { getAntThemeConfig } from "@/lib/app-theme";
import { setApplicationTitle } from "@/lib/app-title";
import { useTaskConfirmationStore } from "@/stores/use-task-confirmation-store";
import { taskConfirmationReminders } from "@/lib/confirmation-reminders";

await i18n.changeLanguage("zh-CN");
const tool = (id: string) => ({ requestId: id, name: "canvas_apply_ops", input: { ops: [] } });
useAgentStore.setState({ enabled: false, connected: false, activeThreadId: "reminder-fixture", prompt: "保留这条未发送草稿", panelOpen: false,
    conversation: { revision: 1, conversationId: "reminder-fixture", threadId: "reminder-fixture", status: "ready", mcpStatuses: {} },
    pendingTool: sessionStorage.getItem("reminder-test-pending") ? tool(sessionStorage.getItem("reminder-test-pending")!) : null });


function Harness() {
    const location = useLocation(), navigate = useNavigate();
    const { t } = useTranslation();
    const theme = useThemeStore(state => state.theme);
    const panelOpen = useAgentStore(state => state.panelOpen), draft = useAgentStore(state => state.prompt);
    useEffect(() => setApplicationTitle(t("meta.title")), [t]);
    const pending = (id: string) => { sessionStorage.setItem("reminder-test-pending", id); useAgentStore.setState({ pendingTool: tool(id) }); };
    return <ConfigProvider theme={getAntThemeConfig(theme === "dark")}><App><AgentPanel />
        <main><button onClick={() => pending("first")}>pending first</button><button onClick={() => pending("second")}>pending second</button>
            <button onClick={() => { sessionStorage.removeItem("reminder-test-pending"); useAgentStore.setState({ pendingTool: null }); }}>resolve pending</button>
            <button onClick={() => navigate("/canvas/another")}>another canvas</button>
            <button onClick={() => void i18n.changeLanguage(i18n.language === "zh-CN" ? "en-US" : "zh-CN")}>language</button>
            <button onClick={() => useThemeStore.setState({ theme: theme === "dark" ? "light" : "dark" })}>theme</button>
            <button onClick={() => useTaskConfirmationStore.getState().setSnapshot("original", taskConfirmationReminders([{ id: "h3-task", kind: "video", projectId: "original", status: "awaiting_confirmation", progress: 60, result: { confirmation: { revision: 1, pending: [{ nodeId: "h3", segmentId: "clip", firstPassFingerprint: "first-pass", firstPassResult: "preview.mp4" }] } } }], "original"))}>pending h3</button>
            <button onClick={() => useTaskConfirmationStore.getState().clear("original")}>resolve h3</button>
            <button onClick={() => { useAgentStore.setState({ prompt: "" }); navigate("/"); }}>creative welcome</button>
            <output aria-label="test location">{location.pathname}{location.search}</output><output aria-label="test panel">{String(panelOpen)}</output><output aria-label="test draft">{draft}</output>
        </main>
    </App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><MemoryRouter initialEntries={["/canvas/original"]}><Harness /></MemoryRouter></StrictMode>);
