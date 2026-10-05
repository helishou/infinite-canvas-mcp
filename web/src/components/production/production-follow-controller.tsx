import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { productionPresentationPath, productionTarget, productionLocationKey } from "@/lib/production-navigation";
import { fetchProductionReadiness } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";

export function ProductionFollowController() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const connected = useBackendStore(state => state.connected);
    const target = useProductionFollowStore(state => state.target);
    const following = useProductionFollowStore(state => state.following);
    const pending = useProductionFollowStore(state => state.pendingPresentation);
    const guardReason = useProductionFollowStore(state => state.guardReason);
    const currentPath = productionLocationKey(location.pathname, location.search);
    const priorPath = useRef("");
    const requestSequence = useRef(0);
    const forceFocus = useRef(false);
    const lastFocusKey = useRef("");

    const refreshPresentation = useCallback(async () => {
        const follow = useProductionFollowStore.getState();
        const active = follow.target;
        if (!active || !active.kind || !active.id || !connected) return;
        const owner = { kind: active.kind, id: active.id } as const;
        const sequence = ++requestSequence.current;
        const stillCurrent = () => {
            const target = useProductionFollowStore.getState().target;
            return Boolean(target && sequence === requestSequence.current && target.kind === active.kind && target.id === active.id && target.workId === active.workId && target.runId === active.runId);
        };
        try {
            const { readiness } = await fetchProductionReadiness(productionTarget(owner), { runId: active.runId });
            if (!stillCurrent()) return;
            const presentation = readiness.presentation;
            if (!presentation) return;
            if (presentation.owner.kind !== owner.kind || presentation.owner.id !== owner.id || presentation.workId !== active.workId) {
                useProductionFollowStore.getState().setPendingPresentation(presentation);
                useProductionFollowStore.getState().pause("Backend 当前工作目标已变化；请确认后恢复跟随");
                return;
            }
            useProductionFollowStore.getState().setPresentation(presentation);
            const latest = useProductionFollowStore.getState();
            if (!latest.following || latest.guardReason) {
                latest.setPendingPresentation(presentation);
                return;
            }
            const path = productionPresentationPath(presentation);
            if (path !== productionLocationKey(location.pathname, location.search)) {
                latest.expectPath(path);
                navigate(path, { replace: true });
            } else {
                const focusKey = `${presentation.workId}:${presentation.canvasId}:${presentation.nodeId}:${presentation.segmentId}`;
                if (presentation.nodeId && (forceFocus.current || lastFocusKey.current !== focusKey)) window.dispatchEvent(new CustomEvent("production-focus", { detail: presentation }));
            }
            lastFocusKey.current = `${presentation.workId}:${presentation.canvasId}:${presentation.nodeId}:${presentation.segmentId}`;
            forceFocus.current = false;
            latest.setLastPath(path);
            latest.setPendingPresentation(null);
        } catch (error) {
            if (!stillCurrent()) return;
            const message = error instanceof Error ? error.message : t("productionHub.follow.readFailed");
            useProductionFollowStore.getState().setPendingPresentation(useProductionFollowStore.getState().presentation);
            useProductionFollowStore.getState().setGuardReason("backend", message);
        }
    }, [connected, location.pathname, location.search, navigate, t]);

    useEffect(() => {
        const state = useProductionFollowStore.getState();
        if (!priorPath.current) {
            priorPath.current = currentPath;
            if (state.lastPath && state.lastPath !== currentPath && state.following) state.pause("检测到手动切页；自动跟随已暂停");
            state.setLastPath(currentPath);
            return;
        }
        if (priorPath.current === currentPath) return;
        priorPath.current = currentPath;
        if (state.consumeExpectedPath(currentPath)) {
            state.setLastPath(currentPath);
            return;
        }
        if (state.following) state.pause("检测到手动切页；自动跟随已暂停");
        useProductionFollowStore.getState().setLastPath(currentPath);
    }, [currentPath]);

    useEffect(() => {
        if (!target || !connected) return;
        void refreshPresentation();
        const refresh = (event: Event) => {
            const payload = (event as CustomEvent<{ type?: string; entityId?: string; payload?: { status?: string; operations?: Array<{ nodeId?: string; segmentId?: string; patch?: { status?: string } }> } }>).detail;
            const current = useProductionFollowStore.getState().target;
            const latestPresentation = useProductionFollowStore.getState().presentation;
            if (payload?.type === "drama-production.updated" && current && (payload.entityId === current.id || latestPresentation?.aliases?.includes(String(payload.entityId || "")) || latestPresentation?.canvasId === payload.entityId)) void refreshPresentation();
            if (latestPresentation?.taskId && payload?.type === "task.updated" && payload.entityId === latestPresentation.taskId && payload.payload?.status && !["queued", "running"].includes(payload.payload.status)) void refreshPresentation();
            if (latestPresentation?.taskId && payload?.type === "canvas.updated" && payload.entityId === latestPresentation.canvasId && payload.payload?.operations?.some(op => op.nodeId === latestPresentation.nodeId && op.segmentId !== latestPresentation.segmentId && ["running", "loading"].includes(op.patch?.status || ""))) void refreshPresentation();
        };
        const resume = () => { forceFocus.current = true; void refreshPresentation(); };
        window.addEventListener("backend-event", refresh);
        window.addEventListener("backend-connected", resume);
        window.addEventListener("production-follow-resume", resume);
        return () => {
            window.removeEventListener("backend-event", refresh);
            window.removeEventListener("backend-connected", resume);
            window.removeEventListener("production-follow-resume", resume);
        };
    }, [target?.id, target?.kind, target?.workId, target?.runId, connected, refreshPresentation]);

    useEffect(() => {
        const observed = new WeakSet<Element>();
        const isVisible = (element: Element) => !element.classList.contains("ant-modal-hidden") && getComputedStyle(element).display !== "none";
        const sync = () => {
            const modals = Array.from(document.querySelectorAll(".ant-modal-wrap"));
            for (const modal of modals) if (!observed.has(modal)) {
                observed.add(modal);
                observer.observe(modal, { attributes: true, attributeFilter: ["class", "style", "aria-hidden"] });
            }
            const open = modals.some(isVisible);
            useProductionFollowStore.getState().setGuardReason("modal", open ? t("productionHub.follow.modalOpen") : "");
        };
        const observer = new MutationObserver(sync);
        observer.observe(document.body, { childList: true });
        sync();
        return () => observer.disconnect();
    }, [t]);

    useEffect(() => {
        if (following && pending && !useProductionFollowStore.getState().guardReason) void refreshPresentation();
    }, [following, pending?.key, guardReason, refreshPresentation]);

    return null;
}
