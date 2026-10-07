import { lazy, Suspense, useEffect, useState } from "react";
import { Badge, Button, Modal, Tooltip } from "antd";
import { Bell, BellOff, LoaderCircle, LocateFixed, MessageSquare, X } from "lucide-react";
import { useConfirmationReminders } from "./use-confirmation-reminders";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LocalAgentPanel } from "./local-agent-panel";
import { AgentCreativeWelcome } from "./agent-creative-welcome";
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
    const progressControl = <Tooltip title={t(followTarget?.kind && followTarget.id ? "productionCanvas.returnToAgentNodeHint" : "productionCanvas.noAgentTarget")} placement="bottom">
        <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8"
            aria-label={t("productionCanvas.returnToAgentNode")} disabled={!followTarget?.kind || !followTarget.id}
            icon={<LocateFixed className="size-3.5" />} onClick={() => {
                closePanel();
                useProductionFollowStore.getState().resume();
            }} />
    </Tooltip>;
    const headerControls = <>{reminderControl}{progressControl}</>;
    return <>
        <div className="fixed bottom-4 right-4 z-[80] flex max-w-[calc(100vw-32px)] flex-col items-end gap-2" data-canvas-shortcuts-ignore>
            {homePage && !chatOpen && !welcomeDismissed && <div data-director-welcome-bubble className="relative flex max-w-[calc(100vw-32px)] items-center gap-1 rounded-xl border px-2 py-1.5 shadow-sm" style={{ background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}>
                <span aria-hidden="true" data-director-welcome-tail className="pointer-events-none absolute -bottom-1.5 right-8 size-3 rotate-45 border-b border-r" style={{ background: theme.node.panel, borderColor: theme.node.stroke }} />
                <button type="button" className="px-2 py-1.5 text-sm" onClick={() => { setWelcomeDismissed(true); setCreativeEntryOpen(true); useProductionWorkspaceStore.getState().setPanelTab("director"); useAgentStore.getState().openPanel(); }}>{t("landing.ideaTitle")}</button>
                <button type="button" className="grid size-6 shrink-0 place-items-center rounded hover:bg-black/5 dark:hover:bg-white/10" aria-label={t("productionCanvas.dismissWelcome")} onClick={() => setWelcomeDismissed(true)}><X className="size-3.5" /></button>
            </div>}
            <Badge count={reminders.count} size="small">
                <Button type={chatOpen ? "default" : "primary"} shape="round" className="!h-11 !px-4" aria-label={t("productionCanvas.openChat")} aria-expanded={chatOpen} aria-controls="canvas-director-dialog" icon={busy ? <LoaderCircle className="size-4 animate-spin" /> : <MessageSquare className="size-4" />} onClick={openChat}>{t("productionCanvas.director")}</Button>
            </Badge>
        </div>
        <section id="canvas-director-dialog" role="dialog" aria-label={t("productionCanvas.chatDialog")} aria-hidden={!chatOpen} inert={!chatOpen}
            data-canvas-shortcuts-ignore data-canvas-no-zoom
            className="fixed bottom-20 right-4 z-[75] flex w-[min(460px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border shadow-xl"
            style={{ height: "min(640px, calc(100dvh - 112px))", background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text, visibility: chatOpen ? "visible" : "hidden", pointerEvents: chatOpen ? "auto" : "none" }}>
            {(canvasPage && owner && (current || recoveryPending) || followTarget?.kind && followTarget.id && (!following || pending)) && <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-b border-border px-3 py-2" data-director-production-controls>
                {canvasPage && owner && (current || recoveryPending) && <button type="button" className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-xs hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.muted }} onClick={() => {
                    const query = new URLSearchParams(search); query.set("workspace", "production"); query.delete("target"); query.delete("nodeId"); query.delete("segmentId");
                    navigate({ search: query.toString() }, { replace: true });
                    useProductionWorkspaceStore.getState().setSelectedObject(null);
                    useProductionWorkspaceStore.getState().setPanelTab("object");
                    useAgentStore.getState().openPanel();
                }} aria-label={t("productionCanvas.tasks")}>
                    {recoveryPending ? t("productionCanvas.recovery") : <>{label ? `${label} · ` : ""}{t(`productionCanvas.progress.${current!.status}`)}</>}
                </button>}
                {followTarget?.kind && followTarget.id && (!following || pending) && <Button type="text" size="small" onClick={() => useProductionFollowStore.getState().resume()}>{t("productionHub.follow.return")}</Button>}
            </div>}
            <div className="flex min-h-0 flex-1 flex-col">
                <AgentCreativeWelcome active={welcomeOpen} onShowChat={() => setCreativeEntryOpen(false)} onClose={closePanel} headerAction={headerControls} />
                <LocalAgentPanel embedded compact headless={!panelMounted || welcomeOpen} autoConnect headerAction={headerControls} />
            </div>
        </section>
        {owner && <Modal open={objectOpen} forceRender title={t("productionCanvas.object")} onCancel={closePanel} footer={null} width="min(1120px, calc(100vw - 32px))" centered styles={{ body: { maxHeight: "calc(100dvh - 160px)", overflow: "auto" } }}>
            <Suspense fallback={null}><ProductionEditor key={`${owner.kind}:${owner.id}`} owner={owner} embedded dialog /></Suspense>
        </Modal>}
    </>;
}
