import { lazy, Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Badge, Button, Drawer, Tooltip } from "antd";
import { Bell, BellOff, LoaderCircle, LocateFixed, MessageSquare, X } from "lucide-react";
import { useConfirmationReminders } from "./use-confirmation-reminders";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LocalAgentPanel } from "./local-agent-panel";
import { AgentCreativeWelcome } from "./agent-creative-welcome";
import { productionObjectForPresentation } from "@/lib/production-object";
import { useAgentStore } from "@/stores/use-agent-store";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { useWorkbenchCanvasOverlayTarget } from "@/lib/canvas/canvas-host";

const ProductionEditor = lazy(() => import("@/pages/drama/production").then(module => ({ default: module.ProductionEditor })));

export function AgentPanel() {
    const { t } = useTranslation();
    const { pathname, search } = useLocation();
    const navigate = useNavigate();
    const panelOpen = useAgentStore(state => state.panelOpen);
    const panelMounted = useAgentStore(state => state.panelMounted);
    const workbenchCanvasOverlay = useWorkbenchCanvasOverlayTarget();
    const busy = useAgentStore(state => state.sending || state.waiting);
    const reminders = useConfirmationReminders();
    const closePanel = useAgentStore(state => state.closePanel);
    const context = useProductionWorkspaceStore(state => state.context);
    const production = useProductionWorkspaceStore(state => state.production);
    const readiness = useProductionWorkspaceStore(state => state.readiness);
    const panelTab = useProductionWorkspaceStore(state => state.panelTab);
    const recoveryPending = useProductionWorkspaceStore(state => state.recoveryPending);
    const followTarget = useProductionFollowStore(state => state.target);
    const following = useProductionFollowStore(state => state.following);
    const pending = useProductionFollowStore(state => state.pendingPresentation);
    const presentation = useProductionFollowStore(state => state.presentation);
    const canvasPage = /^\/canvas\/[^/]+/.test(pathname);
    const owner = canvasPage ? context?.owner : undefined;
    const objectOpen = Boolean(owner && panelOpen && panelTab === "object");
    const chatOpen = panelOpen && (!canvasPage || panelTab !== "object");
    const homePage = pathname === "/" || ["/production", "/drama"].includes(pathname) && !new URLSearchParams(search).has("dramaId");
    const [welcomeDismissed, setWelcomeDismissed] = useState(false);
    const [creativeEntryOpen, setCreativeEntryOpen] = useState(false);
    const welcomeOpen = homePage && chatOpen && creativeEntryOpen;
    useEffect(() => { if (homePage) setWelcomeDismissed(false); }, [homePage]);
    useEffect(() => {
        if (!homePage || !chatOpen) return;
        setWelcomeDismissed(true);
        const agent = useAgentStore.getState();
        if (!agent.sending && !agent.waiting && !agent.creativeLaunch && !agent.prompt.trim() && !agent.attachments.length && !agent.canvasReferences.length) setCreativeEntryOpen(true);
    }, [homePage, chatOpen]);
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
    const reminderControl = <Tooltip title={reminders.hint} placement="bottom">
        <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" loading={reminders.requesting}
            aria-label={t("confirmationReminders.button")} aria-pressed={reminders.enabled}
            icon={reminders.enabled ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />} onClick={() => void reminders.toggle()} />
    </Tooltip>;
    const hasFollowTarget = Boolean(followTarget?.kind && followTarget.id);
    const progressLabel = t(!following || pending ? "productionHub.follow.return" : "productionCanvas.returnToAgentNodeHint");
    const progressControl = hasFollowTarget && <Tooltip title={progressLabel} placement="bottom">
        <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" aria-label={progressLabel}
            icon={<LocateFixed className="size-3.5" />} onClick={() => {
                closePanel();
                useProductionFollowStore.getState().resume();
            }} />
    </Tooltip>;
    const headerControls = <>{reminderControl}{progressControl}</>;
    const objectAgentSwitch = owner ? <div className="flex items-center gap-1" role="group" aria-label={t("productionCanvas.object")}>
        <Button type={panelTab === "object" ? "primary" : "text"} size="small" aria-pressed={panelTab === "object"} onClick={() => { useProductionWorkspaceStore.getState().setPanelTab("object"); useAgentStore.getState().openPanel(); }}>{t("productionCanvas.object")}</Button>
        <Button type={panelTab === "director" ? "primary" : "text"} size="small" aria-pressed={panelTab === "director"} onClick={() => { useProductionWorkspaceStore.getState().setPanelTab("director"); useAgentStore.getState().openPanel(); }}>Agent</Button>
    </div> : null;
    const launcher = <div className={`fixed bottom-4 right-0 flex max-w-[calc(100vw-12px)] flex-col items-end gap-3 ${workbenchCanvasOverlay ? "z-[1000]" : "z-[80]"} sm:bottom-5`} data-agent-launcher data-chat-open={chatOpen} data-canvas-shortcuts-ignore>
        {homePage && !chatOpen && !welcomeDismissed && <div data-director-welcome-bubble className="relative flex max-w-[calc(100vw-24px)] items-center gap-1 rounded-xl border border-border bg-card px-2 py-2 text-foreground shadow-sm">
            <span aria-hidden="true" data-director-welcome-tail className="pointer-events-none absolute -bottom-1.5 right-8 size-3 rotate-45 border-b border-r border-border bg-card" />
            <button type="button" className="rounded-lg px-2 py-1.5 text-sm leading-relaxed transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { setWelcomeDismissed(true); setCreativeEntryOpen(true); useProductionWorkspaceStore.getState().setPanelTab("director"); useAgentStore.getState().openPanel(); }}>{t("landing.ideaTitle")}</button>
            <button type="button" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-label={t("productionCanvas.dismissWelcome")} onClick={() => setWelcomeDismissed(true)}><X className="size-3.5" /></button>
        </div>}
        <Badge count={reminders.count} size="small">
            <Button type={chatOpen ? "default" : "primary"} shape="round" className="!h-11 !rounded-l-xl !rounded-r-none !px-4 !text-sm !font-medium !shadow-none" aria-label={t("productionCanvas.openChat")} aria-expanded={chatOpen} aria-controls="canvas-director-dialog" icon={busy ? <LoaderCircle className="size-4 animate-spin" /> : <MessageSquare className="size-4" />} onClick={openChat}>{t("productionCanvas.director")}</Button>
        </Badge>
    </div>;
    const chatDialog = <section id="canvas-director-dialog" role="dialog" aria-label={t("productionCanvas.chatDialog")} aria-hidden={!chatOpen} inert={!chatOpen}
        data-canvas-shortcuts-ignore data-canvas-no-zoom
        className="fixed inset-y-0 right-0 z-[75] flex w-[min(760px,100vw)] flex-col overflow-hidden rounded-l-xl border border-border bg-card text-foreground shadow-xl transition-transform duration-300 ease-out motion-reduce:transition-none"
        style={{ zIndex: workbenchCanvasOverlay ? 950 : undefined, transform: chatOpen ? "translateX(0)" : "translateX(100%)", pointerEvents: chatOpen ? "auto" : "none" }}>
        {owner && <div className="shrink-0 border-b border-border px-3 py-2">{objectAgentSwitch}</div>}
        {canvasPage && owner && (current || recoveryPending) && <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-2.5" data-director-production-controls>
            <button type="button" className="min-w-0 flex-1 truncate rounded-md px-1.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => {
                const query = new URLSearchParams(search); query.set("workspace", "production"); query.delete("target"); query.delete("nodeId"); query.delete("segmentId");
                navigate({ search: query.toString() }, { replace: true });
                useProductionWorkspaceStore.getState().setSelectedObject(null);
                useProductionWorkspaceStore.getState().setPanelTab("object");
                useAgentStore.getState().openPanel();
            }} aria-label={t("productionCanvas.tasks")}>
                {recoveryPending ? t("productionCanvas.recovery") : <>{label ? `${label} · ` : ""}{t(`productionCanvas.progress.${current!.status}`)}</>}
            </button>
        </div>}
        <div className="flex min-h-0 flex-1 flex-col">
            <AgentCreativeWelcome active={welcomeOpen} onShowChat={() => setCreativeEntryOpen(false)} onClose={closePanel} headerAction={headerControls} />
            <LocalAgentPanel embedded compact headless={!panelMounted || welcomeOpen} autoConnect headerAction={headerControls} />
        </div>
    </section>;
    return <>
        {workbenchCanvasOverlay ? createPortal(launcher, workbenchCanvasOverlay) : launcher}
        {workbenchCanvasOverlay ? createPortal(chatDialog, workbenchCanvasOverlay) : chatDialog}
        {owner && <Drawer rootClassName="canvas-blocking-overlay" open={objectOpen} forceRender title={objectAgentSwitch} onClose={closePanel} placement="right" size="min(1120px, calc(100vw - 24px))" styles={{ body: { overflow: "auto", padding: 16 } }}>
            <div data-canvas-shortcuts-ignore data-canvas-no-zoom><Suspense fallback={null}><ProductionEditor key={`${owner.kind}:${owner.id}`} owner={owner} embedded dialog /></Suspense></div>
        </Drawer>}
    </>;
}
