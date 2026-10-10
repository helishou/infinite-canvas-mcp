import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, ConfigProvider } from "antd";
import { PanelBottomClose } from "lucide-react";
import { useNavigate, type NavigateFunction, type NavigateOptions, type To } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CanvasHostContext, WorkbenchCanvasContext, type CanvasTarget } from "@/lib/canvas/canvas-host";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { useMediaPreviewStore } from "@/stores/use-media-preview-store";
import { canvasHostLocation } from "@/lib/canvas/canvas-host-navigation";

const CanvasSurface = lazy(() => import("@/pages/canvas/project").then(module => ({ default: module.CanvasSurface })));

export function WorkbenchCanvas({ children }: { children: ReactNode }) {
    const navigate = useNavigate(), { t } = useTranslation();
    const [target, setTarget] = useState<CanvasTarget>();
    const [search, setCanvasSearch] = useState(() => new URLSearchParams());
    const [visible, setVisible] = useState(false), [requestId, setRequestId] = useState(0);
    const returnFocus = useRef<HTMLElement | null>(null), panel = useRef<HTMLDivElement>(null), workbench = useRef<HTMLDivElement>(null);
    const popupContainer = useCallback(() => panel.current || document.body, []);
    const collapse = useCallback(() => { panel.current?.querySelectorAll<HTMLMediaElement>("video, audio").forEach(media => media.pause()); useMediaPreviewStore.getState().close(); setVisible(false); requestAnimationFrame(() => returnFocus.current?.focus()); }, []);
    const openCanvas = useCallback((next: CanvasTarget) => {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (next.nodeId || next.segmentId) useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
        setTarget(next); setCanvasSearch(new URLSearchParams({ ...(next.nodeId ? { nodeId: next.nodeId } : {}), ...(next.segmentId ? { segmentId: next.segmentId } : {}) })); setVisible(true); setRequestId(value => value + 1);
    }, [t]);
    const restoreCanvas = useCallback(() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setVisible(true); }, []);
    const canvasNavigate = useCallback(((to: To | number, options?: NavigateOptions) => {
        if (typeof to === "number") { collapse(); return; }
        const destination = canvasHostLocation(to, target?.projectId || "");
        if (destination) {
            openCanvas({ projectId: destination.projectId, nodeId: destination.search.get("nodeId") || undefined, segmentId: destination.search.get("segmentId") || undefined });
            setCanvasSearch(destination.search);
        } else { collapse(); navigate(to, options); }
    }) as NavigateFunction, [collapse, navigate, openCanvas, target?.projectId]);
    useEffect(() => {
        if (!visible) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        panel.current?.focus();
        const keydown = (event: KeyboardEvent) => {
            if (event.key === "Tab" && panel.current && !document.querySelector(".ant-modal-wrap:not([style*='display: none'])")) {
                const items = Array.from(panel.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex='0']")).filter(item => item.getClientRects().length > 0);
                const first = items[0], last = items.at(-1);
                if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
                return;
            }
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (document.querySelector(".ant-modal-wrap:not([style*='display: none']), .ant-dropdown:not(.ant-dropdown-hidden), [data-canvas-transient-tool]")) return;
            queueMicrotask(() => { if (!event.defaultPrevented) collapse(); });
        };
        window.addEventListener("keydown", keydown);
        return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", keydown); };
    }, [visible, collapse]);
    useEffect(() => { if (workbench.current) workbench.current.inert = visible; }, [visible]);
    const host = useMemo(() => target ? { projectId: target.projectId, active: visible, search, requestId, navigate: canvasNavigate, collapse, popupContainer } : null, [target, visible, search, requestId, canvasNavigate, collapse, popupContainer]);
    return <WorkbenchCanvasContext.Provider value={{ openCanvas, restoreCanvas, visible, hasCanvas: Boolean(target) }}>
        <div ref={workbench} data-workbench-underlay>{children}</div>
        {host && createPortal(<CanvasHostContext.Provider value={host}>
            <div hidden={!visible} className="fixed inset-0 z-[900] bg-background/60 p-0 sm:p-3" data-workbench-canvas>
                <div ref={panel} role="dialog" aria-modal="true" aria-label={t("director.canvasOverlay.title")} tabIndex={-1} onClickCapture={event => {
                    const link = (event.target as Element).closest?.("a[href]");
                    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    const href = link.getAttribute("href");
                    if (href?.startsWith("/")) { event.preventDefault(); event.stopPropagation(); canvasNavigate(href); }
                }} className="flex h-full min-h-0 flex-col overflow-hidden bg-background outline-none sm:rounded-xl sm:border sm:border-border">
                    <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2"><span className="text-sm font-medium">{t("director.canvasOverlay.title")}</span><Button type="text" icon={<PanelBottomClose className="size-4" />} onClick={collapse}>{t("director.canvasOverlay.collapse")}</Button></header>
                    <ConfigProvider getPopupContainer={() => panel.current || document.body}><div className="min-h-0 flex-1"><Suspense fallback={<p className="p-6 text-sm text-muted-foreground">{t("director.atomic.loading")}</p>}><CanvasSurface key={host.projectId} projectId={host.projectId} /></Suspense></div></ConfigProvider>
                </div>
            </div>
        </CanvasHostContext.Provider>, document.body)}
    </WorkbenchCanvasContext.Provider>;
}
