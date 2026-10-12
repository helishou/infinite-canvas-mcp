import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Modal } from "antd";
import { useTranslation } from "react-i18next";
import { canvasThemes } from "@/lib/canvas-theme";
import { onCanvasTextEvent, getCanvasTextSession } from "@/services/api/canvas-text";
import { dismissBackendCanvasTextSuggestion, getCanvasTextSuggestions, listBackendCanvasTextSuggestions } from "@/services/api/canvas-text-suggestions";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasTextSuggestion, CanvasTextTarget } from "@/types/canvas-plugin";

export function canvasTextTargetExists(project: CanvasProject | undefined, target: CanvasTextTarget) {
    if (!target.nodeId || target.field === "globalPrompt") return false;
    const node = project?.nodes.find((item) => item.id === target.nodeId);
    if (!node) return false;
    const metadata = (node.metadata || {}) as Record<string, unknown>;
    if (target.segmentId) return Array.isArray(metadata.segments) && metadata.segments.some((item: unknown) => String((item as { id?: unknown })?.id || "") === target.segmentId);
    if (target.textItemId) return Array.isArray(node.metadata?.texts) && node.metadata.texts.some((item) => item.id === target.textItemId);
    return true;
}

function targetLabel(project: CanvasProject | undefined, target: CanvasTextTarget, legacyLabel: string) {
    if (!target.nodeId || target.field === "globalPrompt") return legacyLabel;
    const node = project?.nodes.find((item) => item.id === target.nodeId);
    return [node?.title || target.nodeId, target.segmentId, target.textItemId, target.field].filter(Boolean).join(" · ");
}

export function CanvasTextSuggestionsDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));
    const { message } = App.useApp();
    const [loading, setLoading] = useState(false);
    const [acting, setActing] = useState(false);
    const busy = loading || acting;
    const actionPending = useRef(false);
    const [error, setError] = useState("");
    const [items, setItems] = useState<CanvasTextSuggestion[]>([]);
    const refreshVersion = useRef(0);
    const pending = useMemo(() => items.filter((item) => item.status === "pending").length, [items]);
    const refresh = useCallback(async () => {
        const version = ++refreshVersion.current;
        setLoading(true); setError("");
        try {
            const next = await listBackendCanvasTextSuggestions(projectId);
            if (version === refreshVersion.current) setItems(next);
        } catch (error) {
            if (version === refreshVersion.current) setError(error instanceof Error ? error.message : String(error));
        } finally { if (version === refreshVersion.current) setLoading(false); }
    }, [projectId]);
    useEffect(() => {
        setItems([]);
        if (open) void refresh();
        return () => { refreshVersion.current += 1; };
    }, [open, refresh]);
    useEffect(() => {
        if (!open) return;
        const unsubscribe = onCanvasTextEvent((event) => {
            const value = event as { type?: string; entityId?: string; payload?: { operations?: Array<{ textSuggestion?: unknown }> } };
            if (value.type === "canvas.updated" && value.entityId === projectId && (!value.payload?.operations || value.payload.operations.some((operation) => operation.textSuggestion))) void refresh();
        });
        return () => { unsubscribe(); };
    }, [open, projectId, refresh]);
    const run = async (task: () => Promise<void>, success: string) => {
        if (actionPending.current) return;
        actionPending.current = true;
        setActing(true); setError("");
        try { await task(); await refresh(); message.success(success); }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { actionPending.current = false; setActing(false); }
    };
    const apply = (item: CanvasTextSuggestion) => run(async () => {
        if (!canvasTextTargetExists(useCanvasStore.getState().projects.find((current) => current.id === projectId), item.target)) throw new Error(t("canvasRecovery.targetUnavailable"));
        const session = getCanvasTextSession(projectId, item.target);
        await session.initialize();
        const snapshot = session.getSnapshot();
        if (!snapshot.ready || snapshot.blocked) throw new Error(snapshot.error || t("canvasRecovery.textNotReady"));
        const suggestions = getCanvasTextSuggestions(projectId, item.target);
        await suggestions.refresh();
        await suggestions.apply(item.id, session.getDocumentId(), snapshot.text);
    }, t("canvasRecovery.appliedMessage"));
    const actionClass = "rounded px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40";
    return <>
        <Modal title={t("canvasRecovery.suggestions")} open={open} onCancel={onClose} footer={null} width={720}>
            <div className="mb-3 flex items-center justify-between text-xs" style={{ color: theme.node.muted }}>
                <span>{loading ? t("canvasRecovery.loading") : t("canvasRecovery.summary", { pending, count: items.length })}</span>
                <button type="button" className={actionClass} disabled={busy} onClick={() => void refresh()}>{t("canvasRecovery.refresh")}</button>
            </div>
            {error ? <p role="alert" className="mb-3 text-sm text-red-500">{error}</p> : null}
            {!busy && !items.length ? <p className="py-8 text-center text-sm" style={{ color: theme.node.muted }}>{t("canvasRecovery.empty")}</p> : null}
            <div className="max-h-[60vh] overflow-auto">
                {items.map((item) => {
                    const exists = canvasTextTargetExists(project, item.target);
                    return <section key={item.id} className="border-t py-3" style={{ borderColor: theme.node.stroke }}>
                        <div className="flex items-center justify-between gap-4 text-xs">
                            <span className="min-w-0 truncate">{targetLabel(project, item.target, t("canvasRecovery.legacyTarget"))}</span>
                            <span className={`shrink-0 ${exists ? "" : "text-red-500"}`} style={exists ? { color: theme.node.muted } : undefined}>{exists ? t(`canvasRecovery.status.${item.status}`) : `${t(item.target.field === "globalPrompt" ? "canvasRecovery.featureRemoved" : "canvasRecovery.targetDeleted")} · ${t(`canvasRecovery.status.${item.status}`)}`}</span>
                        </div>
                        <p className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words text-sm">{item.text}</p>
                        <div className="mt-2 flex gap-1">
                            <button type="button" className={actionClass} onClick={() => void navigator.clipboard.writeText(item.text).then(() => message.success(t("canvasRecovery.copiedMessage"))).catch((error) => setError(error instanceof Error ? error.message : String(error)))}>{t("canvasRecovery.copy")}</button>
                            {item.status === "pending" ? <>
                                <button type="button" className={actionClass} disabled={busy || !exists} onClick={() => void apply(item)}>{t("canvasRecovery.apply")}</button>
                                <button type="button" className={actionClass} disabled={busy} onClick={() => void run(() => dismissBackendCanvasTextSuggestion(projectId, item.id), t("canvasRecovery.dismissedMessage"))}>{t("canvasRecovery.dismiss")}</button>
                            </> : null}
                        </div>
                    </section>;
                })}
            </div>
        </Modal>
    </>;
}
