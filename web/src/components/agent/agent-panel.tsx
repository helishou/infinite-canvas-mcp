import { lazy, Suspense, useEffect } from "react";
import { Badge, Button, Modal } from "antd";
import { LoaderCircle, MessageSquare } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LocalAgentPanel } from "./local-agent-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { productionObjectForPresentation } from "@/lib/production-object";
import { useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";

const ProductionEditor = lazy(() => import("@/pages/drama/production").then(module => ({ default: module.ProductionEditor })));

export function AgentPanel() {
    const { t } = useTranslation();
    const { pathname, search } = useLocation();
    const navigate = useNavigate();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const panelOpen = useAgentStore(state => state.panelOpen);
    const panelMounted = useAgentStore(state => state.panelMounted);
    const busy = useAgentStore(state => state.sending || state.waiting);
    const approvalCount = useAgentStore(state => state.pendingApprovals.length + (state.pendingTool ? 1 : 0));
    const closePanel = useAgentStore(state => state.closePanel);
    const context = useProductionWorkspaceStore(state => state.context);
    const production = useProductionWorkspaceStore(state => state.production);
    const readiness = useProductionWorkspaceStore(state => state.readiness);
    const panelTab = useProductionWorkspaceStore(state => state.panelTab);
    const selectedObject = useProductionWorkspaceStore(state => state.selectedObject);
    const recoveryPending = useProductionWorkspaceStore(state => state.recoveryPending);
    const followTarget = useProductionFollowStore(state => state.target);
    const following = useProductionFollowStore(state => state.following);
    const pending = useProductionFollowStore(state => state.pendingPresentation);
    const presentation = useProductionFollowStore(state => state.presentation);
    const canvasPage = /^\/canvas\/[^/]+/.test(pathname);
    const owner = canvasPage ? context?.owner : undefined;
    const objectOpen = Boolean(owner && panelOpen && panelTab === "object");
    const scriptOpen = new URLSearchParams(search).get("workspace") === "story";
    const tasksOpen = new URLSearchParams(search).get("workspace") === "production" && !new URLSearchParams(search).has("target");
    const objectTitle = tasksOpen ? t("productionCanvas.tasks") : selectedObject?.targetKind === "segment" && selectedObject.clipIndex ? t("productionCanvas.clip", { number: selectedObject.clipIndex }) : selectedObject?.title;
    const chatOpen = panelOpen && !objectOpen;
    const current = readiness?.presentation || (presentation?.canvasId === context?.canvasId ? presentation : null);
    const currentObject = current && productionObjectForPresentation(current, production);
    const label = currentObject?.targetKind === "segment" ? currentObject.clipIndex ? t("productionCanvas.clip", { number: currentObject.clipIndex }) : t("productionCanvas.videoTarget") : currentObject?.title;

    useEffect(() => {
        if (panelOpen) useCanvasSidePanelStore.getState().closePanel();
    }, [panelOpen]);
    useEffect(() => {
        const media = window.matchMedia("(max-width: 767px)");
        const sync = () => useProductionFollowStore.getState().setGuardReason("director-popup", chatOpen && canvasPage && media.matches ? t("productionCanvas.chatCoversCanvas") : "");
        sync(); media.addEventListener("change", sync);
        return () => { media.removeEventListener("change", sync); useProductionFollowStore.getState().setGuardReason("director-popup", ""); };
    }, [chatOpen, canvasPage, t]);
    useEffect(() => {
        if (!panelOpen) return;
        const onEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !objectOpen && !document.querySelector('.ant-modal-wrap:not(.ant-modal-hidden)')) closePanel();
        };
        window.addEventListener("keydown", onEscape);
        return () => window.removeEventListener("keydown", onEscape);
    }, [panelOpen, objectOpen, closePanel]);

    const openChat = () => {
        useProductionWorkspaceStore.getState().setPanelTab("director");
        if (chatOpen) closePanel(); else useAgentStore.getState().openPanel();
    };
    return <>
        <div className="fixed bottom-4 right-4 z-[80] flex max-w-[calc(100vw-32px)] flex-col items-end gap-2" data-canvas-shortcuts-ignore>
            {!chatOpen && canvasPage && owner && (current || recoveryPending) && <button type="button" className="max-w-[min(340px,calc(100vw-32px))] truncate bg-transparent text-xs" style={{ color: theme.node.muted }} onClick={() => {
                const query = new URLSearchParams(search); query.set("workspace", "production"); query.delete("target"); query.delete("nodeId"); query.delete("segmentId");
                navigate({ search: query.toString() }, { replace: true });
                useProductionWorkspaceStore.getState().setSelectedObject(null);
                useProductionWorkspaceStore.getState().setPanelTab("object");
                useAgentStore.getState().openPanel();
            }} aria-label={t("productionCanvas.tasks")}>
                {recoveryPending ? t("productionCanvas.recovery") : <>{label ? `${label} · ` : ""}{t(`productionCanvas.progress.${current!.status}`)}</>}
            </button>}
            {!chatOpen && followTarget?.kind && followTarget.id && (!following || pending) && <Button type="text" onClick={() => useProductionFollowStore.getState().resume()}>{t("productionHub.follow.return")}</Button>}
            <div className="flex items-center gap-2">
                <Badge count={approvalCount} size="small">
                    <Button type={chatOpen ? "default" : "primary"} shape="round" className="!h-11 !px-4" aria-label={t("productionCanvas.openChat")} aria-expanded={chatOpen} aria-controls="canvas-director-dialog" icon={busy ? <LoaderCircle className="size-4 animate-spin" /> : <MessageSquare className="size-4" />} onClick={openChat}>{t("productionCanvas.director")}</Button>
                </Badge>
            </div>
        </div>
        <section id="canvas-director-dialog" role="dialog" aria-label={t("productionCanvas.chatDialog")} aria-hidden={!chatOpen} inert={!chatOpen}
            data-canvas-shortcuts-ignore data-canvas-no-zoom
            className="fixed bottom-20 right-4 z-[75] flex w-[min(460px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border shadow-xl"
            style={{ height: "min(640px, calc(100dvh - 112px))", background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text, visibility: chatOpen ? "visible" : "hidden", pointerEvents: chatOpen ? "auto" : "none" }}>
            <LocalAgentPanel embedded compact headless={!panelMounted} autoConnect />
        </section>
        {owner && <Modal open={objectOpen} forceRender title={scriptOpen ? t("productionCanvas.script") : objectTitle || t("productionCanvas.object")} onCancel={closePanel} footer={null} width={scriptOpen || /^(asset|frame|shot|segment):/.test(new URLSearchParams(search).get("target") || "") ? "min(800px, calc(100vw - 32px))" : "min(1120px, calc(100vw - 32px))"} centered styles={{ body: { maxHeight: "calc(100dvh - 160px)", overflow: "auto" } }}>
            <Suspense fallback={null}><ProductionEditor key={`${owner.kind}:${owner.id}`} owner={owner} embedded dialog /></Suspense>
        </Modal>}
    </>;
}
