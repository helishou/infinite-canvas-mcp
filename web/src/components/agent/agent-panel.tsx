import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
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

    // 导演悬浮按钮可拖动：位置持久化到 localStorage，拖动阈值避免误触发点开对话。
    const LAUNCHER_POS_KEY = "agent-launcher-pos";
    type LauncherPos = { left: number; top: number };
    const [launcherPos, setLauncherPos] = useState<LauncherPos | null>(() => {
        try {
            const raw = localStorage.getItem(LAUNCHER_POS_KEY);
            if (!raw) return null;
            const p = JSON.parse(raw) as LauncherPos;
            return Number.isFinite(p?.left) && Number.isFinite(p?.top) ? p : null;
        } catch { return null; }
    });
    const drag = useRef<{ startX: number; startY: number; originLeft: number; originTop: number; moved: boolean; lastPos: LauncherPos | null } | null>(null);
    const suppressClick = useRef(false);
    const launcherRef = useRef<HTMLDivElement>(null);
    const onLauncherPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        const el = launcherRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        drag.current = { startX: e.clientX, startY: e.clientY, originLeft: rect.left, originTop: rect.top, moved: false, lastPos: launcherPos };
    };
    const onLauncherPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
        if (!d.moved && Math.hypot(dx, dy) < 5) return;
        if (!d.moved) {
            // 关键：不能在 pointerdown 就 setPointerCapture —— 那会让后续 click 的目标
            // 重定向到外层 launcher div，按钮的 onClick 永远收不到（表现为点了没反应）。
            // 只有确认进入拖动（超过阈值）才捕获，保证普通点击仍落在按钮上。
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        }
        d.moved = true;
        const el = launcherRef.current;
        if (!el) return;
        const maxLeft = window.innerWidth - el.offsetWidth - 4;
        const maxTop = window.innerHeight - el.offsetHeight - 4;
        const next = {
            left: Math.min(Math.max(4, d.originLeft + dx), Math.max(4, maxLeft)),
            top: Math.min(Math.max(4, d.originTop + dy), Math.max(4, maxTop)),
        };
        d.lastPos = next;
        setLauncherPos(next);
    };
    const endLauncherDrag = (e?: React.PointerEvent<HTMLDivElement>) => {
        if (drag.current?.moved) {
            suppressClick.current = true;
            const pos = drag.current.lastPos;
            try { if (pos) localStorage.setItem(LAUNCHER_POS_KEY, JSON.stringify(pos)); } catch { /* 存储不可用不影响本次拖动 */ }
            window.setTimeout(() => { suppressClick.current = false; }, 0);
        }
        drag.current = null;
        if (e) { try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ } }
    };
    useEffect(() => { if (homePage) setWelcomeDismissed(false); }, [homePage]);
    // 首屏气泡只用来点名入口：页头滚出视口后自动收起，避免一直压住卡片底部操作。
    useEffect(() => {
        if (!homePage || welcomeDismissed || chatOpen) return;
        const header = document.querySelector("[data-page-header]");
        if (!header) return;
        const observer = new IntersectionObserver(([entry]) => {
            if (!entry?.isIntersecting) setWelcomeDismissed(true);
        });
        observer.observe(header);
        return () => observer.disconnect();
    }, [homePage, welcomeDismissed, chatOpen]);
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
    const launcherStyle: React.CSSProperties = launcherPos
        ? { left: launcherPos.left, top: launcherPos.top, right: "auto", bottom: "auto" }
        : {};
    const launcher = <div ref={launcherRef}
        className={`fixed bottom-4 right-4 flex max-w-[calc(100vw-24px)] cursor-grab touch-none flex-col items-end gap-3 active:cursor-grabbing ${workbenchCanvasOverlay ? "z-[1000]" : "z-[80]"} sm:bottom-5`}
        style={launcherStyle}
        data-agent-launcher data-chat-open={chatOpen} data-canvas-shortcuts-ignore
        onPointerDown={onLauncherPointerDown} onPointerMove={onLauncherPointerMove}
        onPointerUp={endLauncherDrag} onPointerCancel={endLauncherDrag}
        onDoubleClick={() => { try { localStorage.removeItem(LAUNCHER_POS_KEY); } catch { /* ignore */ } setLauncherPos(null); }}>
        {/* 首页创作台已有同名主标题，这里不再重复弹欢迎气泡，避免压住页面右下角内容。 */}
        {homePage && pathname !== "/" && !chatOpen && !welcomeDismissed && <div data-director-welcome-bubble className="relative flex max-w-[calc(100vw-24px)] items-center gap-1 rounded-xl border border-border bg-card px-2 py-2 text-foreground shadow-sm">
            <span aria-hidden="true" data-director-welcome-tail className="pointer-events-none absolute -bottom-1.5 right-8 size-3 rotate-45 border-b border-r border-border bg-card" />
            <button type="button" className="rounded-lg px-2 py-1.5 text-sm leading-relaxed transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { setWelcomeDismissed(true); setCreativeEntryOpen(true); useProductionWorkspaceStore.getState().setPanelTab("director"); useAgentStore.getState().openPanel(); }}>{t("landing.ideaTitle")}</button>
            <button type="button" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-label={t("productionCanvas.dismissWelcome")} onClick={() => setWelcomeDismissed(true)}><X className="size-3.5" /></button>
        </div>}
        <Badge count={reminders.count} size="small">
            <Button type={chatOpen ? "default" : "primary"} shape="round" className="!h-10 !rounded-full !px-4 !text-sm !font-medium !shadow-lg" aria-label={t("productionCanvas.openChat")} aria-expanded={chatOpen} aria-controls="canvas-director-dialog" icon={busy ? <LoaderCircle className="size-4 animate-spin" /> : <MessageSquare className="size-4" />} onClick={() => { if (suppressClick.current) return; openChat(); }}>{t("productionCanvas.director")}</Button>
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
        <div className="flex min-h-0 flex-1 flex-col pb-[60px]">
            <AgentCreativeWelcome active={welcomeOpen} onShowChat={() => setCreativeEntryOpen(false)} onClose={closePanel} headerAction={headerControls} />
            <LocalAgentPanel embedded compact headless={!panelMounted || welcomeOpen} autoConnect headerAction={headerControls} />
        </div>
    </section>;
    // 抽屉里是整页制作台：锁定元素引用，生产进度、跟随目标、面板开合等父级更新都不再连带重渲染整棵制作台。
    // 制作数据仍由各 Store/Backend 事件驱动，制作对象或画布身份变化时才换 key 重建。
    const productionEditor = useMemo(() => owner ? <div data-canvas-shortcuts-ignore data-canvas-no-zoom>
        <Suspense fallback={null}><ProductionEditor key={`${owner.kind}:${owner.id}`} owner={owner} embedded dialog /></Suspense>
    </div> : null, [owner?.kind, owner?.id]);
    return <>
        {workbenchCanvasOverlay ? createPortal(launcher, workbenchCanvasOverlay) : launcher}
        {workbenchCanvasOverlay ? createPortal(chatDialog, workbenchCanvasOverlay) : chatDialog}
        {owner && <Drawer rootClassName="canvas-blocking-overlay" open={objectOpen} forceRender title={objectAgentSwitch} onClose={closePanel} placement="right" size="min(1120px, calc(100vw - 24px))" styles={{ body: { overflow: "auto", padding: 16 } }}>
            {productionEditor}
        </Drawer>}
    </>;
}
