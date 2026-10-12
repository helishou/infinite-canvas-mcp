import React, { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";

type PanelBounds = { left: number; top: number; right: number; bottom: number; width: number; height: number };

export function canvasNodePanelLayout(anchor: { x: number; y: number }, panel: PanelBounds, viewport: PanelBounds) {
    const margin = 12;
    const width = Math.max(0, Math.min(600, viewport.width - margin * 2));
    const horizontalMargin = Math.min(margin, Math.max(0, (viewport.width - width) / 2));
    const minLeft = viewport.left + horizontalMargin;
    const maxLeft = viewport.right - horizontalMargin - width;
    const left = Math.min(Math.max(anchor.x - width / 2, minLeft), maxLeft);
    const shiftX = left - (anchor.x - width / 2);
    const viewportHeight = Math.max(0, viewport.height - margin * 2);
    const naturalHeight = Math.min(Math.max(panel.height, 0), viewportHeight);
    const below = Math.max(0, viewport.bottom - margin - anchor.y);
    const above = Math.max(0, anchor.y - viewport.top - margin);

    // Keep the below-node placement when it can show a usable portion; otherwise use the larger side.
    const keepBelow = below >= Math.min(120, naturalHeight) || below >= above;
    let top = keepBelow ? anchor.y : anchor.y - Math.min(naturalHeight, above);
    let maxHeight = Math.min(naturalHeight, keepBelow ? below : above);
    if (top < viewport.top + margin) top = viewport.top + margin;
    maxHeight = Math.max(0, Math.min(maxHeight, viewport.bottom - margin - top));

    return { width, maxHeight, shiftX, shiftY: top - anchor.y };
}

export function shouldShowCanvasNodePanel({ activeNodeId, nodeId, isNodeResizing, hasSelectionBox, hidden }: {
    activeNodeId: string | null;
    nodeId: string;
    isNodeResizing: boolean;
    hasSelectionBox: boolean;
    hidden: boolean;
}) {
    return !isNodeResizing && activeNodeId === nodeId && !hasSelectionBox && !hidden;
}

export function syncCanvasZoom(element: Pick<HTMLElement, "style"> | null, zoom: number) {
    element?.style.setProperty("--canvas-zoom", String(zoom));
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Keep smart-generation controls screen-sized and inside the visible canvas while anchored to their node. */
export function CanvasNodePanelFrame({ children, isSmartGenerationNode }: { children: ReactNode; isSmartGenerationNode: boolean }) {
    const frameRef = useRef<HTMLDivElement>(null);
    const style: CSSProperties | undefined = isSmartGenerationNode
        ? { marginLeft: -300, transform: "scale(calc(1 / var(--canvas-zoom, 1)))", transformOrigin: "top center", maxHeight: "calc(100dvh - 24px)", overflowY: "auto", overscrollBehavior: "contain" }
        : undefined;

    useIsomorphicLayoutEffect(() => {
        if (!isSmartGenerationNode) return;
        const frame = frameRef.current;
        const node = frame?.parentElement;
        const surface = frame?.closest<HTMLElement>("[data-canvas-interaction-surface]");
        const viewportTransform = frame?.closest<HTMLElement>("[data-canvas-viewport-transform]");
        if (!frame || !node || !surface || !viewportTransform) return;

        let scheduled = 0;
        const update = () => {
            if (scheduled) cancelAnimationFrame(scheduled);
            scheduled = requestAnimationFrame(() => {
                scheduled = 0;
                const zoom = Number.parseFloat(viewportTransform.style.getPropertyValue("--canvas-zoom")) || 1;
                const nodeRect = node.getBoundingClientRect();
                const frameRect = frame.getBoundingClientRect();
                const viewportRect = surface.getBoundingClientRect();
                const layout = canvasNodePanelLayout(
                    { x: nodeRect.left + nodeRect.width / 2, y: nodeRect.bottom },
                    { left: frameRect.left, top: frameRect.top, right: frameRect.right, bottom: frameRect.bottom, width: frameRect.width, height: Math.max(frame.scrollHeight, frameRect.height) },
                    { left: viewportRect.left, top: viewportRect.top, right: viewportRect.right, bottom: viewportRect.bottom, width: viewportRect.width, height: viewportRect.height },
                );
                frame.style.width = `${layout.width}px`;
                frame.style.marginLeft = `${-layout.width / 2}px`;
                frame.style.maxHeight = `${layout.maxHeight}px`;
                frame.style.transform = `translate(${layout.shiftX / zoom}px, ${layout.shiftY / zoom}px) scale(calc(1 / var(--canvas-zoom, 1)))`;
            });
        };

        const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
        resizeObserver?.observe(surface);
        resizeObserver?.observe(node);
        if (frame.firstElementChild) resizeObserver?.observe(frame.firstElementChild);
        const mutationObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
        mutationObserver?.observe(viewportTransform, { attributes: true, attributeFilter: ["style"] });
        window.addEventListener("resize", update);
        window.addEventListener("scroll", update, true);
        update();
        return () => {
            if (scheduled) cancelAnimationFrame(scheduled);
            resizeObserver?.disconnect();
            mutationObserver?.disconnect();
            window.removeEventListener("resize", update);
            window.removeEventListener("scroll", update, true);
        };
    }, [isSmartGenerationNode]);

    return (
        <div
            ref={frameRef}
            data-canvas-node-panel
            data-canvas-node-panel-kind={isSmartGenerationNode ? "smart-generation" : "node"}
            className={`absolute left-1/2 top-full z-[70] w-[600px] pt-4 ${isSmartGenerationNode ? "overflow-y-auto overscroll-contain" : "-translate-x-1/2"}`.trim()}
            style={style}
        >
            {children}
        </div>
    );
}
