import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import { canvasSelectionOverlayBounds, canvasSelectionWorldBounds, collectCanvasSelectionIds } from "@/lib/canvas/canvas-selection";
import { queryCanvasSpatialIndex, type CanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasNodeData, Position, SelectionBox } from "@/types/canvas";

type CanvasSelectionPointer = { clientX: number; clientY: number };
type CanvasRect = { left: number; top: number; width: number; height: number };
type MutableRef<T> = { current: T };

export function createCanvasSelectionFrameScheduler(
    update: (pointer: CanvasSelectionPointer) => void,
    requestFrame: (callback: FrameRequestCallback) => number = (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id: number) => void = (id) => window.cancelAnimationFrame(id),
) {
    let frameId: number | null = null;
    let pointer: CanvasSelectionPointer | null = null;

    return {
        setPointer(next: CanvasSelectionPointer) {
            pointer = next;
        },
        schedule(next: CanvasSelectionPointer) {
            pointer = next;
            if (frameId !== null) return;
            frameId = requestFrame(() => {
                frameId = null;
                if (pointer) update(pointer);
            });
        },
        flush() {
            if (frameId !== null) {
                cancelFrame(frameId);
                frameId = null;
            }
            if (pointer) update(pointer);
        },
        clearPointer() {
            pointer = null;
        },
        cancel() {
            if (frameId !== null) {
                cancelFrame(frameId);
                frameId = null;
            }
            pointer = null;
        },
    };
}

type UseCanvasMarqueeSelectionOptions<T extends CanvasNodeData> = {
    canvasRectRef: MutableRef<CanvasRect | null>;
    selectionBoxRef: MutableRef<SelectionBox | null>;
    selectedNodeIdsRef: MutableRef<Set<string>>;
    nodeSpatialIndex: CanvasSpatialIndex<T>;
    screenToCanvas: (clientX: number, clientY: number) => Position;
    setSelectionBox: Dispatch<SetStateAction<SelectionBox | null>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
};

export function useCanvasMarqueeSelection<T extends CanvasNodeData>({
    canvasRectRef,
    selectionBoxRef,
    selectedNodeIdsRef,
    nodeSpatialIndex,
    screenToCanvas,
    setSelectionBox,
    setSelectedNodeIds,
}: UseCanvasMarqueeSelectionOptions<T>) {
    const selectionOverlayRef = useRef<SVGSVGElement | null>(null);
    const updateSelectionPreviewRef = useRef<(clientX: number, clientY: number) => void>(() => {});
    const schedulerRef = useRef<ReturnType<typeof createCanvasSelectionFrameScheduler> | null>(null);

    if (!schedulerRef.current) {
        schedulerRef.current = createCanvasSelectionFrameScheduler(({ clientX, clientY }) => {
            updateSelectionPreviewRef.current(clientX, clientY);
        });
    }
    const scheduler = schedulerRef.current;

    const writeSelectionOverlay = useCallback((selection: SelectionBox) => {
        const overlay = selectionOverlayRef.current;
        if (!overlay) return;
        const bounds = canvasSelectionOverlayBounds(selection.startLocalX, selection.startLocalY, selection.currentLocalX, selection.currentLocalY);
        overlay.style.left = `${bounds.left}px`;
        overlay.style.top = `${bounds.top}px`;
        overlay.style.width = `${bounds.width}px`;
        overlay.style.height = `${bounds.height}px`;
    }, []);

    const updateSelectionPreview = useCallback((clientX: number, clientY: number) => {
        const currentSelection = selectionBoxRef.current;
        if (!currentSelection) return;

        const world = screenToCanvas(clientX, clientY);
        const rect = canvasRectRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);
        const selectionBounds = canvasSelectionWorldBounds(currentSelection.startWorldX, currentSelection.startWorldY, world.x, world.y);
        const nextSelected = collectCanvasSelectionIds(
            queryCanvasSpatialIndex(nodeSpatialIndex, selectionBounds).map((node) => node.id),
            currentSelection.initialSelectedNodeIds,
            currentSelection.additive,
            currentSelection.excludeNodeIds,
        );

        const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y, currentLocalX: localX, currentLocalY: localY };
        selectionBoxRef.current = nextSelectionBox;
        // 框选框是临时的 DOM 绘制状态；每帧直接改 SVG 尺寸，避免整张画布随选框重渲染。
        writeSelectionOverlay(nextSelectionBox);
        if (!sameIdSet(selectedNodeIdsRef.current, nextSelected)) {
            selectedNodeIdsRef.current = nextSelected;
            setSelectedNodeIds(nextSelected);
        }
    }, [canvasRectRef, nodeSpatialIndex, screenToCanvas, selectedNodeIdsRef, setSelectedNodeIds, selectionBoxRef, writeSelectionOverlay]);
    updateSelectionPreviewRef.current = updateSelectionPreview;

    const flushSelectionFrame = useCallback(() => {
        scheduler.flush();
    }, [scheduler]);

    const finishSelectionBox = useCallback((clientX?: number, clientY?: number) => {
        if (clientX != null && clientY != null) scheduler.setPointer({ clientX, clientY });
        flushSelectionFrame();
        scheduler.clearPointer();
        selectionBoxRef.current = null;
        setSelectionBox(null);
    }, [flushSelectionFrame, scheduler, selectionBoxRef, setSelectionBox]);

    const scheduleSelectionPreview = useCallback((clientX: number, clientY: number, buttons: number) => {
        if (!selectionBoxRef.current) return;
        const pointer = { clientX, clientY };
        scheduler.setPointer(pointer);
        if (buttons === 0) {
            finishSelectionBox();
            return;
        }
        scheduler.schedule(pointer);
    }, [finishSelectionBox, scheduler, selectionBoxRef]);

    const cancelSelectionFrame = useCallback(() => {
        scheduler.cancel();
    }, [scheduler]);

    useEffect(() => () => scheduler.cancel(), [scheduler]);

    return {
        selectionOverlayRef,
        updateSelectionPreview,
        finishSelectionBox,
        scheduleSelectionPreview,
        cancelSelectionFrame,
    };
}

function sameIdSet(first: ReadonlySet<string>, second: ReadonlySet<string>) {
    if (first.size !== second.size) return false;
    for (const id of first) if (!second.has(id)) return false;
    return true;
}
