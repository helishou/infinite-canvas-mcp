import React, { useCallback, useEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";

/** 平移/缩放时是否只做命令式 DOM 写入（跳过 React 渲染）。 */
export type ViewportChangeOptions = { live?: boolean };

type InfiniteCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    /** 实时视口。渲染时读它而不是 state，避免命令式写入被滞后的 state 覆盖回去。 */
    viewportRef: React.RefObject<ViewportTransform>;
    /** 注册「立即把视口写进 DOM」的函数，父组件在拖动/滚轮中直接调用，跳过 React 渲染。 */
    registerViewportWriter?: (writer: ((next: ViewportTransform) => void) | null) => void;
    tool: "select" | "pan";
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform, options?: ViewportChangeOptions) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onCanvasDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    children: React.ReactNode;
};

export function InfiniteCanvas({ containerRef, viewportRef, registerViewportWriter, tool, backgroundMode = "lines", onViewportChange, onCanvasMouseDown, onCanvasDeselect, onCanvasDoubleClick, onContextMenu, onDrop, children }: InfiniteCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const transformRef = useRef<HTMLDivElement | null>(null);
    const gridRef = useRef<HTMLDivElement | null>(null);
    const lastWrittenViewportRef = useRef<{
        frame: HTMLDivElement | null;
        grid: HTMLDivElement | null;
        x: number;
        y: number;
        k: number;
    } | null>(null);
    // 平移/缩放期间视口每帧都在变，走 React state 会让整棵画布树（几百个节点）跟着重渲染。
    // 这里直接把变换写进 DOM：拖动只改 style，React 一次都不跑。
    const writeViewport = useCallback((next: ViewportTransform) => {
        const frame = transformRef.current;
        const grid = gridRef.current;
        const previous = lastWrittenViewportRef.current;
        if (previous && previous.frame === frame && previous.grid === grid && previous.x === next.x && previous.y === next.y && previous.k === next.k) return;
        if (frame) frame.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.k})`;
        if (grid) {
            const gridSize = 48 * next.k;
            grid.style.backgroundSize = `${gridSize}px ${gridSize}px`;
            grid.style.backgroundPosition = `${next.x % gridSize}px ${next.y % gridSize}px`;
        }
        if (frame || grid) lastWrittenViewportRef.current = { frame, grid, x: next.x, y: next.y, k: next.k };
    }, []);
    useEffect(() => {
        registerViewportWriter?.(writeViewport);
        return () => registerViewportWriter?.(null);
    }, [registerViewportWriter, writeViewport]);
    // 每次 React 渲染后与最新视口对齐，避免重渲染把 transform 退回滞后的 state 值。
    useEffect(() => {
        writeViewport(viewportRef.current);
    });
    const panState = useRef({
        isPanning: false,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        initialK: 1,
        hasMoved: false,
        startedOnBackground: false,
    });
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    const wheelViewportRef = useRef<ViewportTransform | null>(null);
    const wheelCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const flushPendingWheelViewport = useCallback(() => {
        if (wheelCommitTimerRef.current) {
            clearTimeout(wheelCommitTimerRef.current);
            wheelCommitTimerRef.current = null;
        }
        const next = wheelViewportRef.current;
        wheelViewportRef.current = null;
        if (next) onViewportChange(next, { live: false });
    }, [onViewportChange]);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [isControlPressed, setIsControlPressed] = useState(false);
    const [isPanning, setIsPanning] = useState(false);

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current);
        },
        [],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Control") setIsControlPressed(true);
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']")) return;
            event.preventDefault();
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") {
                const target = event.target instanceof Element ? event.target : null;
                if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']"))) event.preventDefault();
                setIsSpacePressed(false);
            }
            if (event.key === "Control") setIsControlPressed(false);
        };

        const handleBlur = () => {
            flushPendingWheelViewport();
            setIsSpacePressed(false);
            setIsControlPressed(false);
            panState.current.isPanning = false;
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, [flushPendingWheelViewport]);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;

        const delta = -event.deltaY;
        const factor = Math.pow(1.1, delta / 100);
        // 读实时视口：缩放走命令式写入，state 是滞后的，用它会算错增量。
        const current = viewportRef.current;
        const newScale = Math.min(Math.max(current.k * factor, 0.05), 5);
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const worldX = (mouseX - current.x) / current.k;
        const worldY = (mouseY - current.y) / current.k;

        const next = {
            x: mouseX - worldX * newScale,
            y: mouseY - worldY * newScale,
            k: newScale,
        };
        onViewportChange(next, { live: true });
        wheelViewportRef.current = next;
        if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current);
        // 滚轮停止后提交最终视口，让裁剪范围、持久化快照与命令式 DOM 回到同一版本。
        wheelCommitTimerRef.current = setTimeout(flushPendingWheelViewport, 500);
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        flushPendingWheelViewport();
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");
        const temporaryTool = event.ctrlKey || isSpacePressed;
        const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
        const shouldPan = event.button === 1 || (event.button === 0 && activeTool === "pan" && isBackgroundClick);

        if (shouldPan) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            // 滚轮缩放只会先写实时 ref/DOM，React viewport 可能尚未补重算。
            // 平移必须从同一份实时视口起步，否则第一帧会跳回缩放前的 state。
            const current = viewportRef.current;
            panState.current = {
                isPanning: true,
                startX: event.clientX,
                startY: event.clientY,
                initialX: current.x,
                initialY: current.y,
                initialK: current.k,
                hasMoved: false,
                startedOnBackground: isBackgroundClick,
            };
            setIsPanning(true);
            document.body.style.cursor = "grabbing";
            return;
        }

        if (event.button === 0 && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
        }
    };

    const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],[data-node-id],[data-connection-id]")) return;
        onCanvasDoubleClick?.(event);
    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (!panState.current.isPanning) return;

            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                panState.current.hasMoved = true;
            }

            nextViewportRef.current = {
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: panState.current.initialK,
            };
            if (frameRef.current) return;
            frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null;
                // live：父组件只做命令式 DOM 写入，不 setState，拖动期间零 React 渲染。
                if (nextViewportRef.current) onViewportChange(nextViewportRef.current, { live: true });
            });
        };

        const handlePointerUp = () => {
            if (!panState.current.isPanning) return;
            if (frameRef.current) {
                cancelAnimationFrame(frameRef.current);
                frameRef.current = null;
            }

            if (!panState.current.hasMoved && panState.current.startedOnBackground) {
                onCanvasDeselect?.();
            }
            panState.current.isPanning = false;
            setIsPanning(false);
            document.body.style.cursor = "";
            // 拖动结束后提交最终视口，触发一次视口裁剪重算。
            if (panState.current.hasMoved && nextViewportRef.current) onViewportChange(nextViewportRef.current, { live: false });
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            document.body.style.cursor = "";
        };
    }, [onCanvasDeselect, onViewportChange]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Prevent canvas scrolling from moving the page while preserving native scrolling inside overlays and dialogs.
        const preventWheelScroll = (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;
            event.preventDefault();
        };
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        return () => container.removeEventListener("wheel", preventWheelScroll);
    }, [containerRef]);

    const temporaryTool = isControlPressed || isSpacePressed;
    const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
    const cursor = isPanning ? "grabbing" : activeTool === "pan" ? "grab" : undefined;

    return (
        <div
            ref={containerRef}
            className="relative h-full w-full select-none overflow-hidden"
            style={{ background: theme.canvas.background, cursor }}
            onPointerDown={handlePointerDown}
            onDoubleClick={handleDoubleClick}
            onWheel={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <CanvasGrid viewport={viewportRef.current} mode={backgroundMode} gridRef={gridRef} />
            <div
                ref={transformRef}
                className="absolute origin-top-left"
                style={{
                    transform: `translate(${viewportRef.current.x}px, ${viewportRef.current.y}px) scale(${viewportRef.current.k})`,
                }}
            >
                {children}
            </div>
        </div>
    );
}

const CanvasGrid = React.memo(function CanvasGrid({ viewport, mode, gridRef }: { viewport: ViewportTransform; mode: CanvasBackgroundMode; gridRef?: React.RefObject<HTMLDivElement | null> }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = 48 * viewport.k;
    const x = viewport.x % gridSize;
    const y = viewport.y % gridSize;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            ref={gridRef}
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
});
