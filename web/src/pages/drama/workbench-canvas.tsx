import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, ConfigProvider } from "antd";
import { PanelBottomClose } from "lucide-react";
import { useNavigate, useSearchParams, type NavigateFunction, type NavigateOptions, type To } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CanvasHostContext, WorkbenchCanvasContext, setWorkbenchCanvasOverlayTarget, type CanvasTarget, type ProductionCanvasTarget } from "@/lib/canvas/canvas-host";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useMediaPreviewStore } from "@/stores/use-media-preview-store";
import { canvasHostLocation } from "@/lib/canvas/canvas-host-navigation";
import { dramaWorkbenchPath } from "./workbench-entry";

const CanvasSurface = lazy(() => import("@/pages/canvas/project").then(module => ({ default: module.CanvasSurface })));

const CANVAS_STATE_PREFIX = "workbench-canvas-v1:";
// 每次页面加载生成一个标识：刷新后不自动弹开画布，同一页面内切换分集仍沿用原打开状态。
const PAGE_LOAD_ID = Math.random().toString(36).slice(2);
type StoredCanvasState = { target: CanvasTarget; visible: boolean; loadId?: string };
function readStoredCanvasState(storageKey?: string): StoredCanvasState | null {
    if (!storageKey || typeof window === "undefined") return null;
    try {
        const parsed = JSON.parse(sessionStorage.getItem(CANVAS_STATE_PREFIX + storageKey) || "null") as Partial<StoredCanvasState> | null;
        if (!parsed?.target?.projectId) return null;
        return {
            target: {
                projectId: String(parsed.target.projectId),
                ...(parsed.target.nodeId ? { nodeId: String(parsed.target.nodeId) } : {}),
                ...(parsed.target.segmentId ? { segmentId: String(parsed.target.segmentId) } : {}),
            },
            visible: parsed.visible === true && parsed.loadId === PAGE_LOAD_ID,
        };
    } catch { return null; }
}

export function WorkbenchCanvas({ children, storageKey }: { children: ReactNode; storageKey?: string }) {
    const navigate = useNavigate(), { t } = useTranslation();
    const [parentSearch] = useSearchParams();
    // 画布位置会话级持久化：刷新后仍记得上次定位的节点，但不会自动把浮层重新盖到工作台上。
    const restored = useMemo(() => readStoredCanvasState(storageKey), [storageKey]);
    const [target, setTarget] = useState<CanvasTarget | undefined>(restored?.target);
    const [search, setCanvasSearch] = useState(() => new URLSearchParams({
        ...(restored?.target.nodeId ? { nodeId: restored.target.nodeId } : {}),
        ...(restored?.target.segmentId ? { segmentId: restored.target.segmentId } : {}),
    }));
    const [visible, setVisible] = useState(Boolean(restored?.visible)), [requestId, setRequestId] = useState(restored ? 1 : 0);
    useEffect(() => {
        if (!storageKey || !target) return;
        try { sessionStorage.setItem(CANVAS_STATE_PREFIX + storageKey, JSON.stringify({ target, visible, loadId: PAGE_LOAD_ID })); } catch { /* 存储不可用时只是刷新后不恢复 */ }
    }, [storageKey, target, visible]);
    const returnFocus = useRef<HTMLElement | null>(null), panel = useRef<HTMLDivElement>(null), overlay = useRef<HTMLDivElement>(null), workbench = useRef<HTMLDivElement>(null);
    const popupContainer = useCallback(() => panel.current || document.body, []);
    const collapse = useCallback(() => { panel.current?.querySelectorAll<HTMLMediaElement>("video, audio").forEach(media => media.pause()); useMediaPreviewStore.getState().close(); setVisible(false); requestAnimationFrame(() => returnFocus.current?.focus({ preventScroll: true })); }, []);
    const openCanvas = useCallback((next: CanvasTarget) => {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (next.nodeId || next.segmentId) useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
        setTarget(next); setCanvasSearch(new URLSearchParams({ ...(next.nodeId ? { nodeId: next.nodeId } : {}), ...(next.segmentId ? { segmentId: next.segmentId } : {}) })); setVisible(true); setRequestId(value => value + 1);
    }, [t]);
    const restoreCanvas = useCallback(() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setVisible(true); }, []);
    const switchProductionCanvas = useCallback((destination: ProductionCanvasTarget) => {
        useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
        useAgentStore.getState().closePanel();
        if (destination.episodeId) {
            const nextStorageKey = `episode:${destination.episodeId}`;
            try { sessionStorage.setItem(CANVAS_STATE_PREFIX + nextStorageKey, JSON.stringify({ target: { projectId: destination.projectId }, visible: destination.keepCanvasOpen, loadId: PAGE_LOAD_ID })); } catch { /* The route still switches if session storage is unavailable. */ }
            if (storageKey === nextStorageKey) {
                returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                setTarget({ projectId: destination.projectId });
                setCanvasSearch(new URLSearchParams());
                setVisible(destination.keepCanvasOpen);
                setRequestId(value => value + 1);
            }
            const currentWorkspace = parentSearch.get("workspace");
            const workspace = currentWorkspace && currentWorkspace !== "series" ? currentWorkspace : undefined;
            navigate(dramaWorkbenchPath(destination.dramaId, destination.episodeId, workspace));
            return;
        }
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setTarget({ projectId: destination.projectId });
        setCanvasSearch(new URLSearchParams());
        setVisible(destination.keepCanvasOpen);
        setRequestId(value => value + 1);
        const nextSearch = new URLSearchParams(parentSearch);
        nextSearch.set("workspace", "series");
        nextSearch.set("seriesView", "planning");
        nextSearch.delete("target"); nextSearch.delete("nodeId"); nextSearch.delete("segmentId");
        navigate({ search: `?${nextSearch.toString()}` }, { replace: true });
    }, [navigate, parentSearch, t]);
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
                const overlayFocusables = overlay.current?.querySelectorAll<HTMLElement>("#canvas-director-dialog[aria-hidden='false'] button:not([disabled]), #canvas-director-dialog[aria-hidden='false'] a[href], #canvas-director-dialog[aria-hidden='false'] input:not([disabled]), #canvas-director-dialog[aria-hidden='false'] textarea:not([disabled]), #canvas-director-dialog[aria-hidden='false'] select:not([disabled]), #canvas-director-dialog[aria-hidden='false'] [tabindex='0'], [data-agent-launcher] button:not([disabled])") || [];
                items.push(...Array.from(overlayFocusables).filter(item => item.getClientRects().length > 0));
                const first = items[0], last = items.at(-1);
                if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
                return;
            }
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (document.querySelector("#canvas-director-dialog[aria-hidden='false']")) return;
            if (document.querySelector(".ant-modal-wrap:not([style*='display: none']), .ant-dropdown:not(.ant-dropdown-hidden), .ant-drawer-open, [data-canvas-transient-tool]")) return;
            queueMicrotask(() => { if (!event.defaultPrevented) collapse(); });
        };
        window.addEventListener("keydown", keydown);
        return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", keydown); };
    }, [visible, collapse]);
    useEffect(() => { if (workbench.current) workbench.current.inert = visible; }, [visible]);
    useEffect(() => {
        setWorkbenchCanvasOverlayTarget(visible ? overlay.current : null);
        return () => { if (visible) setWorkbenchCanvasOverlayTarget(null); };
    }, [target, visible]);
    const host = useMemo(() => target ? { projectId: target.projectId, active: visible, search, requestId, navigate: canvasNavigate, collapse, popupContainer, switchProductionCanvas } : null, [target, visible, search, requestId, canvasNavigate, collapse, popupContainer, switchProductionCanvas]);
    return <WorkbenchCanvasContext.Provider value={{ openCanvas, restoreCanvas, switchProductionCanvas, visible, hasCanvas: Boolean(target) }}>
        <div ref={workbench} className="h-full" data-workbench-underlay>{children}</div>
        {host && createPortal(<CanvasHostContext.Provider value={host}>
            <div ref={overlay} hidden={!visible} className="fixed inset-0 z-[900] bg-background/60 p-0 sm:p-3" data-workbench-canvas>
                <div ref={panel} role="dialog" aria-modal="true" aria-label={t("director.canvasOverlay.title")} tabIndex={-1} onClickCapture={event => {
                    const link = (event.target as Element).closest?.("a[href]");
                    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    const href = link.getAttribute("href");
                    if (href?.startsWith("/")) { event.preventDefault(); event.stopPropagation(); canvasNavigate(href); }
                }} className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background outline-none sm:rounded-xl sm:border sm:border-border">
                    <header className="absolute right-2 top-2 z-[100] flex h-10 items-center"><span className="sr-only">{t("director.canvasOverlay.title")}</span><Button type="text" icon={<PanelBottomClose className="size-4" />} onClick={collapse}>{t("director.canvasOverlay.collapse")}</Button></header>
                    <ConfigProvider getPopupContainer={() => panel.current || document.body}><div className="min-h-0 flex-1"><Suspense fallback={<p className="p-6 text-sm text-muted-foreground">{t("director.atomic.loading")}</p>}><CanvasSurface key={host.projectId} projectId={host.projectId} /></Suspense></div></ConfigProvider>
                </div>
            </div>
        </CanvasHostContext.Provider>, document.body)}
    </WorkbenchCanvasContext.Provider>;
}
