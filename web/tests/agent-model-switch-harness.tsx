import React from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router-dom";
import i18n from "../src/i18n";
import "../src/styles/globals.css";
import type { AgentConversationState, AgentModel } from "../src/stores/use-agent-store";

// Exercise the production panel without touching Backend conversations or models.
const models: AgentModel[] = [
    { id: "cli", model: "cli::model", displayName: "CLI model", runtime: "codex", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
    { id: "api", model: "api::model", displayName: "API model", runtime: "llm", defaultReasoningEffort: "", supportedReasoningEfforts: [] },
    { id: "api-two", model: "api::two", displayName: "API two", runtime: "llm", defaultReasoningEffort: "", supportedReasoningEfforts: [] },
];
const skill = { name: "fixture-skill", path: "fixture/SKILL.md", description: "Fixture", enabled: true, scope: "project" as const, managed: false };
const resets: string[] = [];
let turns = 0;
let failure = false;
let delayed = false;
let release: (() => void) | undefined;
let conversation: AgentConversationState = { revision: 1, conversationId: "original", threadId: "codex-original", status: "ready", mcpStatuses: {} };
let stream: FixtureEvents;
const runtime = () => ({ instanceId: "fixture", revision: conversation.revision, conversation, codex: { busy: false, threadId: conversation.threadId, turnId: "" }, pendingApprovals: [] });
class FixtureEvents extends EventTarget {
    onerror = null;
    closed = false;
    constructor() {
        super();
        stream = this;
        queueMicrotask(() => {
            if (!this.closed) this.dispatchEvent(new MessageEvent("hello", { data: JSON.stringify({ protocolVersion: 6, conversation, runtime: runtime() }) }));
        });
    }
    close() { this.closed = true; }
}
window.EventSource = FixtureEvents as unknown as typeof EventSource;
window.fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input), location.origin).pathname;
    if (path.endsWith("/codex/threads/reset")) {
        const { model } = JSON.parse(String(init?.body));
        resets.push(model);
        if (delayed) await new Promise<void>(resolve => { release = resolve; });
        if (failure) return Response.json({ ok: false, error: "Fixture creation failed" }, { status: 503 });
        conversation = { ...conversation, revision: conversation.revision + 1, conversationId: `new-${resets.length}`, threadId: `${model.startsWith("api::") ? "llm-" : "codex-"}${resets.length}`, status: "ready" };
        // The SSE state may arrive before the reset response, as on Backend.
        stream.dispatchEvent(new MessageEvent("conversation_changed", { data: JSON.stringify(conversation) }));
        await new Promise(resolve => setTimeout(resolve, 50));
        return Response.json({ ok: true, conversation });
    }
    if (path.endsWith("/codex/turn")) { turns++; throw new Error("Unexpected model submission"); }
    if (path.endsWith("/codex/models")) return Response.json({ ok: true, data: models });
    if (path.endsWith("/codex/skills")) return Response.json({ ok: true, data: [skill] });
    if (path.endsWith("/codex/state")) return Response.json({ ok: true, runtime: runtime() });
    if (path.endsWith("/codex/threads")) return Response.json({ ok: true, conversation, data: [{ id: "codex-original", preview: "Original history" }] });
    if (path.includes("/codex/threads/")) return Response.json({ ok: true, conversation, messages: conversation.threadId === "codex-original" ? [{ id: "old", threadId: conversation.threadId, role: "assistant", text: "Original history" }] : [], historyReady: true });
    return Response.json({ ok: true, data: [], settings: {} });
};
await i18n.changeLanguage("zh-CN");
const [{ LocalAgentPanel }, { useAgentStore }, { useAgentSkillStore }] = await Promise.all([
    import("../src/components/agent/local-agent-panel"), import("../src/stores/use-agent-store"), import("../src/stores/use-agent-skill-store"),
]);
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0RkAAAAASUVORK5CYII=";
useAgentStore.setState({
    enabled: true, connected: false, url: "http://fixture.invalid/agent", token: "fixture", activeThreadId: conversation.threadId, conversation,
    model: models[0].model, models, prompt: "  保留换行\n和输入 $fixture-skill @画布内容  ",
    attachments: [{ id: "image", name: "image.png", type: "image/png", size: 68, width: 1, height: 1, url: pixel, dataUrl: pixel }],
    canvasReferences: [{ nodeId: "text", label: "画布内容", title: "画布内容", kind: "text", text: "参考正文" }],
    canvasContext: { snapshot: { projectId: "fixture", title: "Fixture", nodes: [{ id: "text", type: "text", title: "画布内容", metadata: {} } as any], connections: [], selectedNodeIds: [] }, applyOps: () => useAgentStore.getState().canvasContext!.snapshot, undoOps: () => null, canUndo: false },
    sending: false, waiting: false, activeTab: "chat", queuedPrompts: [],
});
useAgentSkillStore.setState({ skills: [skill], loaded: true, selectedSkill: skill });
Object.assign(window, { modelSwitchFixture: {
    read: () => {
        const state = useAgentStore.getState();
        return { resets, turns, connected: state.connected, loading: state.loadingThreads, model: state.model, thread: state.activeThreadId, prompt: state.prompt, attachments: state.attachments, references: state.canvasReferences, skill: useAgentSkillStore.getState().selectedSkill?.name, messages: state.messages };
    },
    fail: (value: boolean) => { failure = value; },
    delay: () => { delayed = true; },
    release: () => { delayed = false; release?.(); },
    busy: (value: boolean) => useAgentStore.setState({ codexRuntime: { ...useAgentStore.getState().codexRuntime, busy: value } }),
    mismatch: () => useAgentStore.setState({ model: models[0].model }),
    language: (language: string) => i18n.changeLanguage(language),
} });
createRoot(document.getElementById("root")!).render(<ConfigProvider><App><MemoryRouter><div style={{ height: 850 }}><LocalAgentPanel embedded /></div></MemoryRouter></App></ConfigProvider>);
