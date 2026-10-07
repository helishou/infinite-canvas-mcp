import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider, theme } from "antd";
import { AgentChatComposer } from "../src/components/agent/agent-chat-composer";
import { AgentHistoryView } from "../src/components/agent/agent-history-view";
import { selectAvailableAgentModel } from "../src/lib/agent/agent-model-selection";
import { canvasThemes } from "../src/lib/canvas-theme";
import type { AgentModel } from "../src/stores/use-agent-store";
import i18n from "../src/i18n";
import "../src/styles/globals.css";

// Isolated test page: all Backend requests are intercepted by the browser check.
const models: AgentModel[] = ["A", "B"].map((name, index) => ({ id: `${name}::same-model`, model: `${name}::same-model`, displayName: `${name} / same-model`, defaultReasoningEffort: "", supportedReasoningEfforts: [], isDefault: index === 0 }));
function Harness() {
    const [selected, setSelected] = useState(selectAvailableAgentModel(models, "retired-codex-model", "high"));
    const [prompt, setPrompt] = useState("");
    const [legacy, setLegacy] = useState(false);
    const [dark, setDark] = useState(false);
    const [, redraw] = useState(0);
    return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}><App><main className={`${dark ? "dark bg-slate-950 text-white" : "bg-white text-slate-900"} min-h-screen p-4`}>
        <button onClick={() => setDark(!dark)}>Theme</button><button onClick={() => void i18n.changeLanguage(i18n.language === "zh-CN" ? "en-US" : "zh-CN").then(() => redraw(value => value + 1))}>Language</button>
        <div className="mx-auto max-w-lg"><AgentChatComposer models={selected.models} model={selected.model} reasoningEffort={selected.reasoningEffort} onModelChange={model => setSelected(selectAvailableAgentModel(models, model, ""))} onReasoningEffortChange={() => {}} prompt={prompt} onPromptChange={setPrompt} onSubmit={() => {}} disabled={false} sending={false} waiting={false} theme={canvasThemes[dark ? "dark" : "light"]} />
        <AgentHistoryView theme={canvasThemes[dark ? "dark" : "light"]} threads={[]} activeThreadId="" workspacePath="fixture" loading={false} busy={false} connected legacyHistory={legacy} onLegacyHistoryChange={setLegacy} onRefresh={() => {}} onNewThread={() => {}} onResumeThread={() => {}} onDeleteThreads={() => {}} /></div>
        <output data-testid="model">{selected.model}</output><output data-testid="effort">{selected.reasoningEffort}</output><output data-testid="legacy">{String(legacy)}</output>
    </main></App></ConfigProvider>;
}
void i18n.changeLanguage("zh-CN").then(() => createRoot(document.getElementById("root")!).render(<Harness />));
