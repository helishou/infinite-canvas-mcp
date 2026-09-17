import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Modal } from "antd";
import { MessagesSquare } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { onCanvasTextEvent, getCanvasTextSession } from "@/services/api/canvas-text";
import { dismissBackendCanvasTextSuggestion, getCanvasTextSuggestions, listBackendCanvasTextSuggestions } from "@/services/api/canvas-text-suggestions";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasTextSuggestion, CanvasTextTarget } from "@/types/canvas-plugin";

export function canvasTextTargetExists(project: CanvasProject | undefined, target: CanvasTextTarget) {
    if (!target.nodeId) return target.field === "globalPrompt";
    const node = project?.nodes.find((item) => item.id === target.nodeId);
    if (!node) return false;
    const metadata = (node.metadata || {}) as Record<string, unknown>;
    if (target.segmentId) return Array.isArray(metadata.segments) && metadata.segments.some((item: unknown) => String((item as { id?: unknown })?.id || "") === target.segmentId);
    if (target.textItemId) return Array.isArray(node.metadata?.texts) && node.metadata.texts.some((item) => item.id === target.textItemId);
    return true;
}

function targetLabel(project: CanvasProject | undefined, target: CanvasTextTarget) {
    if (!target.nodeId) return "全局提示词";
    const node = project?.nodes.find((item) => item.id === target.nodeId);
    return [node?.title || target.nodeId, target.segmentId, target.textItemId, target.field].filter(Boolean).join(" · ");
}

const statusText = { pending: "待确认", applied: "已采用", dismissed: "已忽略" } as const;

export function CanvasTextSuggestionsButton({ projectId }: { projectId: string }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [items, setItems] = useState<CanvasTextSuggestion[]>([]);
    const refreshVersion = useRef(0);
    const pending = useMemo(() => items.filter((item) => item.status === "pending").length, [items]);
    const refresh = useCallback(async () => {
        const version = ++refreshVersion.current;
        setBusy(true); setError("");
        try {
            const next = await listBackendCanvasTextSuggestions(projectId);
            if (version === refreshVersion.current) setItems(next);
        } catch (error) {
            if (version === refreshVersion.current) setError(error instanceof Error ? error.message : String(error));
        } finally { if (version === refreshVersion.current) setBusy(false); }
    }, [projectId]);
    useEffect(() => { void refresh(); }, [refresh]);
    useEffect(() => {
        const unsubscribe = onCanvasTextEvent((event) => {
            const value = event as { type?: string; entityId?: string; payload?: { operations?: Array<{ textSuggestion?: unknown }> } };
            if (value.type === "canvas.updated" && value.entityId === projectId && (!value.payload?.operations || value.payload.operations.some((operation) => operation.textSuggestion))) void refresh();
        });
        return () => { unsubscribe(); };
    }, [projectId, refresh]);
    const run = async (task: () => Promise<void>, success: string) => {
        setBusy(true); setError("");
        try { await task(); await refresh(); message.success(success); }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    const apply = (item: CanvasTextSuggestion) => run(async () => {
        if (!canvasTextTargetExists(project, item.target)) throw new Error("目标已删除，不能采用；可忽略或复制候选内容");
        const session = getCanvasTextSession(projectId, item.target);
        await session.initialize();
        const snapshot = session.getSnapshot();
        if (!snapshot.ready || snapshot.blocked) throw new Error(snapshot.error || "目标文本尚未就绪");
        const suggestions = getCanvasTextSuggestions(projectId, item.target);
        await suggestions.refresh();
        await suggestions.apply(item.id, session.getDocumentId(), snapshot.text);
    }, "已采用候选");
    const buttonClass = "flex h-8 shrink-0 items-center gap-1 rounded px-2 text-xs transition hover:bg-black/5 dark:hover:bg-white/10";
    const actionClass = "rounded px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40";
    return <>
        <button type="button" aria-label="改写候选" className={buttonClass} style={{ color: pending ? theme.node.text : theme.node.muted }} onClick={() => { setOpen(true); void refresh(); }}>
            <MessagesSquare className="size-3.5" /><span>改写候选{pending ? ` ${pending}` : ""}</span>
        </button>
        <Modal title="改写候选" open={open} onCancel={() => setOpen(false)} footer={null} width={720}>
            <div className="mb-3 flex items-center justify-between text-xs" style={{ color: theme.node.muted }}>
                <span>{busy ? "正在读取…" : `${pending} 条待确认 · ${items.length} 条记录`}</span>
                <button type="button" className={actionClass} disabled={busy} onClick={() => void refresh()}>刷新</button>
            </div>
            {error ? <p role="alert" className="mb-3 text-sm text-red-500">{error}</p> : null}
            {!busy && !items.length ? <p className="py-8 text-center text-sm" style={{ color: theme.node.muted }}>当前画布没有改写候选</p> : null}
            <div className="max-h-[60vh] overflow-auto">
                {items.map((item) => {
                    const exists = canvasTextTargetExists(project, item.target);
                    return <section key={item.id} className="border-t py-3" style={{ borderColor: theme.node.stroke }}>
                        <div className="flex items-center justify-between gap-4 text-xs">
                            <span className="min-w-0 truncate">{targetLabel(project, item.target)}</span>
                            <span className={`shrink-0 ${exists ? "" : "text-red-500"}`} style={exists ? { color: theme.node.muted } : undefined}>{exists ? statusText[item.status] : `目标已删除 · ${statusText[item.status]}`}</span>
                        </div>
                        <p className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words text-sm">{item.text}</p>
                        <div className="mt-2 flex gap-1">
                            <button type="button" className={actionClass} onClick={() => void navigator.clipboard.writeText(item.text).then(() => message.success("已复制候选"))}>复制</button>
                            {item.status === "pending" ? <>
                                <button type="button" className={actionClass} disabled={busy || !exists} onClick={() => void apply(item)}>采用</button>
                                <button type="button" className={actionClass} disabled={busy} onClick={() => void run(() => dismissBackendCanvasTextSuggestion(projectId, item.id), "已忽略候选")}>忽略</button>
                            </> : null}
                        </div>
                    </section>;
                })}
            </div>
        </Modal>
    </>;
}
