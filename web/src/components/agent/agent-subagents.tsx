import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, theme as antdTheme } from "antd";
import { Users, ChevronRight, RefreshCw, LoaderCircle, Clock3, CheckCircle2, CircleAlert, CircleX, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DirectorSubagentResult, DirectorSubagentSummary } from "@basketikun/canvas-agent/agent/delegation";
import { directorSubagentRequest, fetchBackendTask } from "@/services/backend-api";
import { useAgentStore } from "@/stores/use-agent-store";
import { useBackendStore } from "@/stores/use-backend-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { AgentChatMessage } from "./agent-chat-message";

export function AgentSubagents({ theme }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    const { token } = antdTheme.useToken();
    const [expanded, setExpanded] = useState(false);
    const [selected, setSelected] = useState("");
    const root = useRef<HTMLElement>(null);
    const [previewBounds, setPreviewBounds] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
    const parentThreadId = useAgentStore(state => state.activeThreadId);
    const projectId = useAgentStore(state => state.canvasContext?.snapshot.projectId || state.productionTurnObject?.canvasId || "");
    const backendUrl = useBackendStore(state => state.url);
    const [tasks, setTasks] = useState<DirectorSubagentSummary[]>([]);
    const [results, setResults] = useState<Record<string, DirectorSubagentResult>>({});
    const [inputs, setInputs] = useState<Record<string, { value?: Record<string, unknown>; error?: string }>>({});
    const [error, setError] = useState("");
    const [reading, setReading] = useState("");
    const [nextOffset, setNextOffset] = useState<number | null>(null);
    const [refreshEpoch, refresh] = useState(0);
    const generation = useRef(0);
    const ownedScope = useRef("");
    const scope = JSON.stringify([backendUrl, projectId, parentThreadId]);
    useEffect(() => {
        if (!selected || !root.current) { setPreviewBounds(null); return; }
        const anchor = root.current.closest<HTMLElement>("#canvas-director-dialog, [data-agent-preview-anchor]") || root.current.parentElement!;
        const position = () => {
            const rect = anchor.getBoundingClientRect();
            const available = rect.left - 28;
            const width = available >= 280 ? Math.min(720, available) : Math.max(0, window.innerWidth - 32);
            const left = available >= 280 ? rect.left - width - 12 : 16;
            const top = Math.max(16, Math.min(rect.top, window.innerHeight - 200));
            setPreviewBounds({ left, top, width, height: Math.max(160, Math.min(rect.height || 640, window.innerHeight - top - 16)) });
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") { event.stopPropagation(); setSelected(""); }
        };
        position();
        const observer = new ResizeObserver(position);
        observer.observe(anchor);
        window.addEventListener("resize", position);
        window.addEventListener("keydown", closeOnEscape, true);
        return () => { observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("keydown", closeOnEscape, true); };
    }, [selected, scope]);
    useEffect(() => {
        const epoch = ++generation.current;
        if (ownedScope.current !== scope) {
            ownedScope.current = scope;
            setTasks([]); setResults({}); setInputs({}); setError(""); setNextOffset(null); setExpanded(false); setSelected("");
        }
        setReading("");
        if (!projectId || !parentThreadId) return;
        let eventRevision = 0;
        const load = () => {
            const atEvent = eventRevision;
            void directorSubagentRequest({ action: "list", projectId, parentThreadId }).then(response => {
                if (generation.current !== epoch) return;
                // An event received while loading is newer than the in-flight snapshot.
                if (eventRevision !== atEvent) return load();
                setTasks(response.tasks || []); setNextOffset(response.nextOffset ?? null); setError("");
            }).catch(reason => { if (generation.current === epoch) setError(String(reason)); });
        };
        const event = (input: Event) => {
            const detail = (input as CustomEvent).detail;
            if (detail?.type === "drama-production.updated") { eventRevision++; load(); return; }
            const task = detail?.payload as DirectorSubagentSummary & { kind?: string };
            if (!task || task.kind !== "director-subagent" || task.projectId !== projectId || task.parentThreadId !== parentThreadId) return;
            eventRevision++;
            setTasks(previous => {
                const old = previous.find(item => item.taskId === task.taskId);
                if (old && old.updatedAt > task.updatedAt) return previous;
                return [task, ...previous.filter(item => item.taskId !== task.taskId)].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.taskId.localeCompare(a.taskId));
            });
        };
        load();
        window.addEventListener("backend-event", event);
        window.addEventListener("backend-connected", load);
        return () => { generation.current++; window.removeEventListener("backend-event", event); window.removeEventListener("backend-connected", load); };
    }, [projectId, parentThreadId, backendUrl, scope, refreshEpoch]);
    const read = async (task: DirectorSubagentSummary) => {
        const epoch = generation.current;
        setReading(task.taskId); setError("");
        try {
            const response = await directorSubagentRequest({ action: "get", projectId, parentThreadId, taskId: task.taskId, artifactHash: task.artifactHash, view: "result", chunkBytes: 8192 });
            let result = response.result;
            if (response.chunk) {
                let text = response.chunk.text, cursor = response.chunk.nextCursor;
                while (cursor) {
                    if (generation.current !== epoch) return;
                    const page = await directorSubagentRequest({ action: "get", projectId, parentThreadId, taskId: task.taskId, artifactHash: task.artifactHash, view: "result", chunkBytes: 8192, cursor });
                    if (!page.chunk) throw new Error("Missing result chunk");
                    text += page.chunk.text; cursor = page.chunk.nextCursor;
                }
                result = JSON.parse(text) as DirectorSubagentResult;
            }
            if (generation.current === epoch && result) setResults(previous => ({ ...previous, [`${task.taskId}:${task.artifactHash || ""}`]: result! }));
        } catch (reason) { if (generation.current === epoch) setError(String(reason)); }
        finally { if (generation.current === epoch) setReading(""); }
    };
    const more = async () => {
        if (nextOffset === null) return;
        const epoch = generation.current;
        try {
            const response = await directorSubagentRequest({ action: "list", projectId, parentThreadId, offset: nextOffset });
            if (generation.current !== epoch) return;
            setTasks(previous => [...previous, ...(response.tasks || []).filter(task => !previous.some(item => item.taskId === task.taskId))]);
            setNextOffset(response.nextOffset ?? null);
        } catch (reason) { if (generation.current === epoch) setError(String(reason)); }
    };
    // A failed discovery request is not evidence that a child exists. Empty
    // conversations reserve no chrome, divider, spacing, or disclosure control.
    if (!projectId || !parentThreadId || ownedScope.current !== scope || !tasks.length) return null;
    const active = tasks.filter(task => ["queued", "running"].includes(task.status)).length;
    const detail = tasks.find(task => task.taskId === selected);
    const result = detail && results[`${detail.taskId}:${detail.artifactHash || ""}`];
    const status = (task: DirectorSubagentSummary) => task.adoption ? "adopted" : ["queued", "running", "failed", "cancelled"].includes(task.status) ? task.status : task.validity === "stale" ? "stale" : task.outcome === "partial" ? "partial" : task.outcome === "needs_human" ? "needs_human" : "pending_review";
    const statusIcon = (task: DirectorSubagentSummary) => {
        const value = status(task);
        const Icon = value === "running" && !error ? LoaderCircle : value === "adopted" ? CheckCircle2 : value === "failed" ? CircleX : ["needs_human", "stale"].includes(value) ? CircleAlert : Clock3;
        const color = value === "failed" ? token.colorError : ["needs_human", "stale"].includes(value) ? token.colorWarning : value === "adopted" ? token.colorSuccess : theme.node.muted;
        return <Icon aria-hidden className={`size-3.5 shrink-0 ${value === "running" && !error ? "animate-spin motion-reduce:animate-none" : ""}`} style={{ color }} />;
    };
    const activate = (task: DirectorSubagentSummary) => {
        if (selected === task.taskId) { setSelected(""); return; }
        setSelected(task.taskId);
        if (!inputs[task.taskId]?.value) {
            const epoch = generation.current;
            void fetchBackendTask(task.taskId).then(response => {
                if (generation.current !== epoch) return;
                const saved = response.task;
                if (!saved?.input || saved.id !== task.taskId || saved.kind !== "director-subagent" || saved.projectId !== projectId || saved.input.parentThreadId !== parentThreadId) throw new Error(t("agent.subagents.inputUnavailable"));
                setInputs(previous => ({ ...previous, [task.taskId]: { value: saved.input } }));
            }).catch(reason => { if (generation.current === epoch) setInputs(previous => ({ ...previous, [task.taskId]: { error: String(reason) } })); });
        }
        if (task.resultAvailable && !results[`${task.taskId}:${task.artifactHash || ""}`]) void read(task);
    };
    return <section ref={root} className="min-w-0" data-testid="agent-subagents">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="rounded px-1 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10" style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", color: theme.node.muted }}>
            <ChevronRight aria-hidden className={`size-3 shrink-0 transition-transform motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} />
            <Users aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{t("agent.subagents.title", { count: tasks.length })}</span>
            <span className="ml-auto shrink-0 text-[11px]">{error ? t("agent.subagents.syncShort") : active > 0 ? t("agent.subagents.active", { count: active }) : t("agent.subagents.settled")}</span>
        </button>
        {expanded && <div className="mt-1 space-y-2 pl-4" data-testid="agent-subagents-body">
            {error && <div role="alert" className="text-xs" style={{ color: theme.node.muted }}><p>{t("agent.subagents.syncError")}</p><details><summary className="cursor-pointer">{t("agent.subagents.errorDetails")}</summary><p className="break-words">{error}</p></details><Button type="text" size="small" icon={<RefreshCw className="size-3" />} onClick={() => refresh(value => value + 1)}>{t("agent.subagents.refresh")}</Button></div>}
            <div className="max-h-[25dvh] space-y-0.5 overflow-y-auto overscroll-contain">{tasks.map(task => <button key={task.taskId} type="button" aria-haspopup="dialog" aria-expanded={selected === task.taskId} onClick={() => activate(task)} className="rounded px-2 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/10" style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: selected === task.taskId ? theme.toolbar.activeBg : undefined }} data-testid="agent-subagent">
                {statusIcon(task)}
                <span className="min-w-0 flex-1"><span className="block truncate font-medium" style={{ color: theme.node.text }} title={task.title}>{task.title}</span><span className="mt-0.5 block truncate text-[11px]" style={{ color: theme.node.muted }}>{t(`agent.subagents.role.${task.role}`)}</span></span>
                <span className="shrink-0 text-[11px]" style={{ color: theme.node.muted }}>{t(`agent.subagents.status.${status(task)}`)}</span>
                <ChevronRight aria-hidden className={`size-3 shrink-0 ${selected === task.taskId ? "rotate-90" : ""}`} style={{ color: theme.node.muted }} />
            </button>)}</div>

            {nextOffset !== null && <Button type="text" size="small" onClick={() => void more()}>{t("agent.subagents.more")}</Button>}
        </div>}
        {detail && previewBounds && createPortal(
            <section role="dialog" aria-label={detail.title} aria-modal="false" data-canvas-shortcuts-ignore data-canvas-no-zoom data-testid="agent-subagent-preview" className="fixed z-[90] flex flex-col overflow-hidden rounded-xl border shadow-lg" style={{ ...previewBounds, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}>
                <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: theme.node.stroke }}>
                    <strong className="min-w-0 truncate text-sm" title={detail.title}>{detail.title}</strong>
                    <Button type="text" size="small" icon={<X className="size-4" />} aria-label={t("agent.message.close")} onClick={() => setSelected("")} />
                </header>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-4 py-3 text-xs" data-testid="agent-subagent-detail">
                    <section className="space-y-3" data-testid="agent-subagent-input">
                        <h2 className="text-sm font-semibold">{t("agent.subagents.input")}</h2>
                        {inputs[detail.taskId]?.error ? <p role="alert">{inputs[detail.taskId].error}</p> : !inputs[detail.taskId]?.value ? <p>{t("agent.subagents.readingInput")}</p> : <>
                            <h3 className="font-medium">{t("agent.subagents.inputPrompt")}</h3>
                            <AgentChatMessage theme={theme} item={{ id: `subagent-input:${detail.taskId}`, role: "user", text: String(inputs[detail.taskId].value!.prompt || "") }} />
                            {inputs[detail.taskId].value!.context ? <><h3 className="font-medium">{t("agent.subagents.inputContext")}</h3><p className="whitespace-pre-wrap break-words">{String(inputs[detail.taskId].value!.context)}</p></> : null}
                            {inputs[detail.taskId].value!.workPackage ? <details><summary className="cursor-pointer">{t("agent.subagents.inputWorkPackage")}</summary><pre className="mt-2 whitespace-pre-wrap break-words text-xs">{JSON.stringify(inputs[detail.taskId].value!.workPackage, null, 2)}</pre></details> : null}
                        </>}
                    </section>
                    <section className="mt-4 space-y-2 border-t pt-4" style={{ borderColor: theme.node.stroke }} data-testid="agent-subagent-result">
                        <h2 className="text-sm font-semibold">{t("agent.subagents.result")}</h2>
                {detail.error && <p className="whitespace-pre-wrap break-words">{detail.error}</p>}
                {!detail.binding || detail.binding === "unbound" ? <p>{t("agent.subagents.unbound")}</p> : null}
                {detail.artifactHash && <p className="break-all">{t("agent.subagents.artifact", { hash: detail.artifactHash })}</p>}
                {detail.adoption && <p>{t("agent.subagents.adoptedRevision", { revision: detail.adoption.revision })}</p>}
                {detail.contentDeliveryMode && <p>{t(detail.contentDeliveryMode === "interactive_segment" ? "sceneProduction.interactiveAdvice" : "sceneProduction.automaticAdvice")}</p>}
                {detail.status === "succeeded" && detail.outcome === "partial" && detail.validity !== "stale" && <Button size="small" onClick={() => {
                    const epoch = generation.current;
                    void directorSubagentRequest({ action: "continue", projectId, parentThreadId, taskId: detail.taskId, operationId: `continue:${detail.taskId}:${detail.artifactHash}`, continuationIntent: "explicit" })
                        .then(() => { if (generation.current === epoch) refresh(value => value + 1); })
                        .catch(reason => { if (generation.current === epoch) setError(String(reason)); });
                }}>{t("sceneProduction.continueAdvice")}</Button>}
                {detail.recoverable && <Button size="small" onClick={() => {
                    const epoch = generation.current;
                    void directorSubagentRequest({ action: "recover", projectId, parentThreadId, taskId: detail.taskId, operationId: `recover:${detail.taskId}:${detail.updatedAt}` })
                        .then(() => { if (generation.current === epoch) refresh(value => value + 1); })
                        .catch(reason => { if (generation.current === epoch) setError(String(reason)); });
                }}>{t("agent.subagents.recover")}</Button>}
                {reading === detail.taskId && <p role="status" style={{ color: theme.node.muted }}>{t("agent.subagents.readingResult")}</p>}
                {detail.resultAvailable && !result && reading !== detail.taskId && <Button type="text" size="small" onClick={() => void read(detail)}>{t("agent.subagents.readResult")}</Button>}
                {!detail.resultAvailable && !detail.error && <p style={{ color: theme.node.muted }}>{t(["queued", "running"].includes(detail.status) ? "agent.subagents.workingDetail" : "agent.subagents.noResult")}</p>}
                {result && <><p className="whitespace-pre-wrap break-words text-sm">{result.summary}</p><AgentChatMessage theme={theme} item={{ id: `subagent-result:${detail.taskId}`, role: "assistant", text: result.content }} />{result.unresolved.length > 0 && <div style={{ color: theme.node.muted }}><p>{t("agent.subagents.unresolved")}</p><ul className="list-disc pl-4">{result.unresolved.map((item, index) => <li className="break-words" key={index}>{item}</li>)}</ul></div>}</>}
                    </section>
                </div>
            </section>, document.body,
        )}
    </section>;
}
