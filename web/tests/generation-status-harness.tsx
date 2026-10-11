import React from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import i18n from "../src/i18n";
import { canvasThemes } from "../src/lib/canvas-theme";
import { AgentToolCard } from "../src/components/agent/agent-chat-message";
import { formatAgentActivity, type AgentEventItem } from "../src/components/agent/agent-event-formatters";
import "../src/styles/globals.css";
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") || "zh-CN");
const theme = params.get("theme") === "light" ? canvasThemes.light : canvasThemes.dark;
const result = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const diagnostic = { code: "PROMPT_EXTERNAL_CONTEXT", targetId: "SEG1", shotId: "SH1", path: "director.source.shots.SH1.visual", matchedText: "preceding segment", origin: "source", nextAction: { message: "Expand the local camera conditions." } };
const cases: Record<string, Partial<AgentEventItem>> = {
    empty: { result: result({ tasks: [] }) },
    mixed: { result: result({ tasks: ["queued", "running", "succeeded", "failed"].map(status => ({ status })) }) },
    error: { result: { ...result({ ok: false, error: { message: "fetch failed" } }), isError: true } },
    transport: { status: "failed", error: { message: "Transport closed" } },
    missing: { status: "failed" },
    unavailable: { result: {} },
    ...Object.fromEntries(["queued", "running", "blocked", "failed", "interrupted", "succeeded"].map(status => ["compile-" + status, { tool: "production_compile", result: result({ compilation: { status, operationId: "compile-current", expectedRevision: 4, ...(status === "blocked" ? { blockingDiagnostic: diagnostic, reused: true, reusedFromOperationId: "compile-original" } : {}) } }) }])),
    diagnostics: { tool: "production_get_compilation", arguments: { view: "diagnostics" }, result: result({ compilation: { status: "blocked", operationId: "compile-current", items: [diagnostic] } }) },
    targets: { tool: "production_get_compilation", arguments: { view: "targets" }, result: result({ compilation: { status: "succeeded", operationId: "compile-current", application: { revision: 5 } } }) },
};
createRoot(document.getElementById("root")!).render(<ConfigProvider><App><div style={{ background: theme.canvas.background, padding: 20 }}>
{Object.entries(cases).map(([id, data]) => {
    const message = formatAgentActivity({ type: "item.completed", item: { type: "mcp_tool_call", tool: "generation_get_status", status: "completed", ...data } })!;
    return <div key={id} data-testid={id} style={{ marginBottom: 12 }}><AgentToolCard title={message.title!} text={message.text} detail={message.detail} theme={theme} /></div>;
})}</div></App></ConfigProvider>);
