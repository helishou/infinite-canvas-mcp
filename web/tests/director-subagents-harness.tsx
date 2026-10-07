import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, App } from "antd";
import { getAntThemeConfig } from "../src/lib/app-theme";
import { canvasThemes } from "../src/lib/canvas-theme";
import { AgentSubagents } from "../src/components/agent/agent-subagents";
import { useAgentStore } from "../src/stores/use-agent-store";
import i18n from "../src/i18n";
import "../src/styles/globals.css";

const scenario = new URLSearchParams(location.search).get("scenario");
let tasks = scenario?.startsWith("empty") ? [] : JSON.parse(sessionStorage.getItem("subagents-fixture") || "null") || [
    { taskId: "child-a", projectId: "canvas", parentThreadId: "director", title: "核对人物连续性", role: "continuity", status: "running", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", sourceRevision: 4, error: null, resultAvailable: false },
    { taskId: "child-b", projectId: "canvas", parentThreadId: "director", title: "检查镜头覆盖", role: "shots", status: "queued", createdAt: "2026-01-01T00:00:01Z", updatedAt: "2026-01-01T00:00:01Z", sourceRevision: 4, error: null, resultAvailable: false },
];
const calls: Record<string, any>[] = [];
let holdResult = false, release: (() => void) | undefined;
let failList = scenario === "empty-error";
window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    if (url.pathname.startsWith("/tasks/")) return Response.json({ ok: true, task: { id: url.pathname.split("/").pop(), kind: "director-subagent", projectId: "canvas", status: "running", input: { parentThreadId: "director", prompt: "核对 Clip 8 与 Clip 9 的人物、持物与起止状态，保留原对白。", context: "只读检查第二场，不生成媒体。", workPackage: { revision: 4, scope: ["Clip 8", "Clip 9"] } } } });
    if (!url.pathname.endsWith("/director/subagents")) return Response.json({ ok: true, settings: {} });
    const body = JSON.parse(String(init?.body || "{}")); calls.push(body);
    if (body.action === "list") {
        if (failList) return Response.json({ error: "fixture unavailable" }, { status: 503 });
        return Response.json({ ok: true, tasks: tasks.filter((task: any) => task.parentThreadId === body.parentThreadId && task.projectId === body.projectId), nextOffset: null });
    }
    if (holdResult) await new Promise<void>(resolve => { release = resolve; });
    return Response.json({ ok: true, task: tasks.find((task: any) => task.taskId === body.taskId), result: { status: "needs_human", summary: "有一项需要主导演核对", content: "## 分镜建议\n先拍信封，再拍人物反应。", unresolved: ["确认前镜中信封是否已拆开"] } });
};
const emit = (task: Record<string, unknown>) => window.dispatchEvent(new CustomEvent("backend-event", { detail: { type: "task.updated", payload: { ...task, kind: "director-subagent" } } }));
Object.assign(window, { __subagentFixture: {
    calls,
    complete() { tasks[0] = { ...tasks[0], status: "succeeded", outcome: "needs_human", resultAvailable: true, updatedAt: "2026-01-01T00:00:02Z" }; sessionStorage.setItem("subagents-fixture", JSON.stringify(tasks)); emit(tasks[0]); },
    fail() { tasks[1] = { ...tasks[1], status: "failed", error: "模型渠道暂不可用", updatedAt: "2026-01-01T00:00:03Z" }; emit(tasks[1]); },
    emitForeign() { emit({ ...tasks[0], taskId: "foreign", title: "不属于此会话", parentThreadId: "other" }); },
    lifecycle(patch: Record<string, unknown>) { tasks[0] = { ...tasks[0], ...patch, updatedAt: new Date().toISOString() }; sessionStorage.setItem("subagents-fixture", JSON.stringify(tasks)); emit(tasks[0]); },
    holdResult() { holdResult = true; },
    releaseResult() { release?.(); holdResult = false; },
    failList(value: boolean) { failList = value; window.dispatchEvent(new Event("backend-connected")); },
} });
useAgentStore.setState({ activeThreadId: "director", canvasContext: { snapshot: { projectId: "canvas" } } as never });
await i18n.changeLanguage("zh-CN");
function Harness() {
    const [dark, setDark] = useState(true);
    return <ConfigProvider theme={getAntThemeConfig(dark)}><App><main className={`${dark ? "dark " : ""}min-h-screen bg-background p-5 text-foreground`}>
        <div className="mb-5 flex gap-4"><button onClick={() => setDark(value => !value)}>Theme</button><button onClick={() => (window as any).__subagentFixture.complete()}>Complete child</button><button onClick={() => (window as any).__subagentFixture.fail()}>Fail child</button><button onClick={() => void i18n.changeLanguage(i18n.language === "zh-CN" ? "en-US" : "zh-CN")}>Language</button><button onClick={() => useAgentStore.setState({ activeThreadId: "other" })}>Other director</button><button onClick={() => useAgentStore.setState({ activeThreadId: "director" })}>Original director</button></div>
        <div data-agent-preview-anchor className="fixed right-5 top-24 h-[560px] w-[360px] overflow-y-auto rounded-xl border p-3"><AgentSubagents theme={canvasThemes[dark ? "dark" : "light"]} /></div>
    </main></App></ConfigProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
