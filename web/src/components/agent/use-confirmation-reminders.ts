import { useEffect, useMemo, useRef, useState } from "react";
import { App } from "antd";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAgentStore } from "@/stores/use-agent-store";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { useTaskConfirmationStore } from "@/stores/use-task-confirmation-store";
import { collectConfirmationReminders, ConfirmationReminderController, type ConfirmationReminder } from "@/lib/confirmation-reminders";
import { setAttentionTitle } from "@/lib/app-title";

const preferenceKey = "canvas.confirmation-reminders.enabled";
const shownKey = "canvas.confirmation-reminders.shown"; // Ephemeral UI markers, never approval receipts.
function readPreference() { try { return localStorage.getItem(preferenceKey) === "on"; } catch { return false; } }
function readShown() { try { const value = JSON.parse(sessionStorage.getItem(shownKey) || "[]"); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []; } catch { return []; } }
function permission(): NotificationPermission | "unsupported" { return typeof Notification === "undefined" || !window.isSecureContext ? "unsupported" : Notification.permission; }

export function useConfirmationReminders() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate(), location = useLocation();
    const approvals = useAgentStore(state => state.pendingApprovals);
    const pendingTool = useAgentStore(state => state.pendingTool);
    const threadId = useAgentStore(state => state.activeThreadId);
    const context = useProductionWorkspaceStore(state => state.context);
    const production = useProductionWorkspaceStore(state => state.production);
    const readiness = useProductionWorkspaceStore(state => state.readiness);
    const taskConfirmations = useTaskConfirmationStore(state => state.items);
    const canvasMatch = /^\/canvas\/([^/]+)/.exec(location.pathname);
    let canvasId = context?.canvasId;
    if (canvasMatch) { try { canvasId = decodeURIComponent(canvasMatch[1]); } catch { canvasId = undefined; } }
    const [enabled, setEnabled] = useState(readPreference);
    const [status, setStatus] = useState(permission);
    const [requesting, setRequesting] = useState(false);
    const [sendFailed, setSendFailed] = useState(false);
    const focused = useRef(document.hasFocus());
    const mounted = useRef(false);
    const requests = useMemo(() => collectConfirmationReminders({ approvals, pendingTool, threadId, route: location.pathname + location.search, context, production, readiness, taskConfirmations: taskConfirmations.filter(item => item.projectId === canvasId) }), [approvals, pendingTool, threadId, location.pathname, location.search, context, production, readiness, taskConfirmations, canvasId]);
    const live = useRef({ requests, enabled, t, navigate }); live.current = { requests, enabled, t, navigate };
    const controller = useRef<ConfirmationReminderController | null>(null);
    if (!controller.current) controller.current = new ConfirmationReminderController({
        background: () => document.visibilityState === "hidden" || !focused.current,
        allowed: () => permission() === "granted",
        show: (items, click, fail) => {
            const notification = new Notification(live.current.t("confirmationReminders.title"), { body: live.current.t("confirmationReminders.body", { count: items.length }), tag: "infinite-canvas-confirmations", requireInteraction: true });
            notification.onclick = event => { event.preventDefault(); click(); };
            notification.onerror = event => fail(event);
            return notification;
        },
        activate: (item: ConfirmationReminder) => {
            const currentThread = useAgentStore.getState().activeThreadId;
            if (item.kind !== "decision" && item.threadId && item.threadId !== currentThread) return;
            window.focus();
            useProductionFollowStore.getState().pause(live.current.t("confirmationReminders.opening"));
            live.current.navigate(item.path);
            if (item.kind === "task") { useAgentStore.getState().closePanel(); return; }
            useProductionWorkspaceStore.getState().setPanelTab(item.object ? "object" : "director");
            if (item.object) useProductionWorkspaceStore.getState().setSelectedObject(item.object);
            useAgentStore.getState().openPanel();
            if (item.kind === "decision" && item.threadId && item.threadId !== currentThread) useAgentStore.setState({ activeTab: "history" });
        },
        remember: ids => { try { sessionStorage.setItem(shownKey, JSON.stringify(ids)); } catch { /* Memory deduplication remains active. */ } },
        failed: () => setSendFailed(true),
    }, readShown());

    useEffect(() => { controller.current!.update(requests, enabled); }, [requests, enabled]);
    useEffect(() => {
        mounted.current = true;
        const sync = () => { setStatus(permission()); controller.current!.update(live.current.requests, live.current.enabled); };
        const gainFocus = () => { focused.current = true; sync(); };
        const loseFocus = () => { focused.current = false; sync(); };
        const visibility = () => { focused.current = document.hasFocus(); sync(); };
        const settings = (event: StorageEvent) => { if (event.key === preferenceKey) { live.current.enabled = readPreference(); setEnabled(live.current.enabled); sync(); } };
        window.addEventListener("focus", gainFocus); window.addEventListener("blur", loseFocus);
        document.addEventListener("visibilitychange", visibility); window.addEventListener("storage", settings);
        return () => { mounted.current = false; window.removeEventListener("focus", gainFocus); window.removeEventListener("blur", loseFocus); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("storage", settings); controller.current!.close(); };
    }, []);
    useEffect(() => {
        setAttentionTitle(requests.length ? t("confirmationReminders.tabTitle", { count: requests.length }) : "");
        return () => setAttentionTitle("");
    }, [requests.length, t]);

    const toggle = async () => {
        if (requesting) return;
        const current = permission();
        if (enabled && current === "granted" && !sendFailed) {
            try { localStorage.setItem(preferenceKey, "off"); } catch { /* Session preference still applies. */ }
            live.current.enabled = false; setEnabled(false); controller.current!.close(); return;
        }
        if (current === "unsupported") { setStatus(current); message.info(t("confirmationReminders.unsupported")); return; }
        if (current === "denied") { setStatus(current); message.info(t("confirmationReminders.denied")); return; }
        setRequesting(true);
        try {
            const result = current === "granted" ? current : await Notification.requestPermission();
            if (!mounted.current) return;
            setStatus(result);
            if (result !== "granted") { message.info(t("confirmationReminders.notAllowed")); return; }
            controller.current!.retry(); setSendFailed(false);
            try { localStorage.setItem(preferenceKey, "on"); } catch { /* Session preference still applies. */ }
            live.current.enabled = true; setEnabled(true); message.success(t("confirmationReminders.enabled"));
            controller.current!.update(live.current.requests, true);
        } catch { if (mounted.current) { setSendFailed(true); message.warning(t("confirmationReminders.failed")); } }
        finally { if (mounted.current) setRequesting(false); }
    };
    const hint = sendFailed ? "failed" : status === "unsupported" ? "unsupported" : status === "denied" ? "denied" : enabled && status === "granted" ? "disable" : "enable";
    return { count: requests.length, enabled: enabled && status === "granted" && !sendFailed, requesting, toggle, hint: t(`confirmationReminders.${hint}`) };
}
