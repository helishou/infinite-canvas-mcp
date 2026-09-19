import type { MouseEvent as ReactMouseEvent } from "react";
import { memo, useCallback, useSyncExternalStore, useState } from "react";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { useCanvasDragPreviewPair } from "@/lib/canvas/canvas-drag-preview";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "@/types/canvas";

const EMPTY_ACTIVE_CONNECTION_POINTER: Position = { x: 0, y: 0 };
const activeConnectionPointers = new Map<string, Position>();
const activeConnectionPointerListeners = new Map<string, Set<() => void>>();

function notifyActiveConnectionPointer(projectId: string) {
    activeConnectionPointerListeners.get(projectId)?.forEach((listener) => listener());
}

export function writeActiveConnectionPointer(projectId: string, position: Position) {
    const current = activeConnectionPointers.get(projectId);
    if (current?.x === position.x && current.y === position.y) return;
    activeConnectionPointers.set(projectId, position);
    // Drag moves are already coalesced by the caller; notify in that frame so the line does not lag another frame.
    notifyActiveConnectionPointer(projectId);
}

export function clearActiveConnectionPointer(projectId: string) {
    if (!activeConnectionPointers.delete(projectId)) return;
    notifyActiveConnectionPointer(projectId);
}

function useActiveConnectionPointer(projectId: string) {
    const subscribe = useCallback((listener: () => void) => {
        const listeners = activeConnectionPointerListeners.get(projectId) || new Set<() => void>();
        listeners.add(listener);
        activeConnectionPointerListeners.set(projectId, listeners);
        return () => {
            listeners.delete(listener);
            if (!listeners.size) activeConnectionPointerListeners.delete(projectId);
        };
    }, [projectId]);
    const getSnapshot = useCallback(() => activeConnectionPointers.get(projectId) || EMPTY_ACTIVE_CONNECTION_POINTER, [projectId]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// 连线描边样式的唯一来源：真实连线与 H3 参考图连线都用它，避免两边样式分叉。
// 强调色用主题蓝色 linkActive，与节点选中边框（activeStroke）区分开。
export function connectionStrokeStyle(theme: CanvasTheme, active: boolean) {
    return {
        stroke: active ? theme.node.linkActive : theme.node.muted,
        strokeWidth: active ? 3 : 2,
        strokeOpacity: active ? 1 : 0.82,
        style: { filter: active ? `drop-shadow(0 0 8px ${theme.node.linkActive}66)` : undefined },
    };
}

function buildConnectionPathD(from: CanvasNodeData, to: CanvasNodeData, fromPosition?: Position, toPosition?: Position) {
    const sourcePosition = fromPosition || from.position;
    const targetPosition = toPosition || to.position;
    const startX = sourcePosition.x + from.width;
    const startY = sourcePosition.y + from.height / 2;
    const endX = targetPosition.x;
    const endY = targetPosition.y + to.height / 2;
    const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
    return `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;
}

export const ConnectionPath = memo(function ConnectionPath({
    projectId,
    connection,
    from,
    to,
    fromPosition,
    toPosition,
    theme,
    active,
    onSelect,
    onContextMenu,
    onDelete,
}: {
    projectId: string;
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    fromPosition?: Position;
    toPosition?: Position;
    theme: CanvasTheme;
    active: boolean;
    onSelect: (connectionId: string) => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>, connectionId: string) => void;
    onDelete?: (connectionId: string) => void;
}) {
    const [hovered, setHovered] = useState(false);
    const [deleteHovered, setDeleteHovered] = useState(false);
    const { fromPosition: dragFromPosition, toPosition: dragToPosition } = useCanvasDragPreviewPair(projectId, from.id, to.id);
    const sourcePosition = dragFromPosition || fromPosition || from.position;
    const targetPosition = dragToPosition || toPosition || to.position;
    const startX = sourcePosition.x + from.width;
    const startY = sourcePosition.y + from.height / 2;
    const endX = targetPosition.x;
    const endY = targetPosition.y + to.height / 2;
    const dx = Math.abs(endX - startX);
    const curvature = Math.max(dx * 0.5, 50);
    const pathD = buildConnectionPathD(from, to, sourcePosition, targetPosition);

    // Cubic Bezier midpoint at t=0.5
    // B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3, at t=0.5:
    const midX = (startX + 3 * (startX + curvature) + 3 * (endX - curvature) + endX) / 8;
    const midY = (startY + 3 * startY + 3 * endY + endY) / 8;
    const strokeStyle = connectionStrokeStyle(theme, active);

    return (
        <g
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect(connection.id);
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu?.(event, connection.id);
                }}
            />
            <path
                d={pathD}
                fill="none"
                {...strokeStyle}
                style={{ ...strokeStyle.style, pointerEvents: "none" }}
            />
            {(hovered || active) && onDelete && (
                <g
                    transform={`translate(${midX}, ${midY})`}
                    data-connection-delete={connection.id}
                    style={{ pointerEvents: "none" }}
                >
                    <title>断开连线</title>
                    <rect x={-10} y={-10} width={20} height={20} rx={5} fill={theme.node.panel} fillOpacity={0.96} stroke={deleteHovered ? "#f87171" : theme.node.muted} strokeWidth={1.2} style={{ pointerEvents: "all", cursor: "pointer", filter: "drop-shadow(0 2px 5px rgba(0,0,0,.28))" }} onMouseEnter={() => setDeleteHovered(true)} onMouseLeave={() => setDeleteHovered(false)} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onDelete?.(connection.id); }} onClick={(event) => event.stopPropagation()} />
                    <line x1={-3.5} y1={-3.5} x2={3.5} y2={3.5} stroke={deleteHovered ? "#fca5a5" : theme.node.text} strokeWidth={1.7} strokeLinecap="round" style={{ pointerEvents: "none" }} />
                    <line x1={3.5} y1={-3.5} x2={-3.5} y2={3.5} stroke={deleteHovered ? "#fca5a5" : theme.node.text} strokeWidth={1.7} strokeLinecap="round" style={{ pointerEvents: "none" }} />
                </g>
            )}
        </g>
    );
}, (previous, next) => previous.connection === next.connection
    && previous.projectId === next.projectId
    && previous.from === next.from
    && previous.to === next.to
    && previous.fromPosition === next.fromPosition
    && previous.toPosition === next.toPosition
    && previous.theme === next.theme
    && previous.active === next.active
    && previous.onSelect === next.onSelect
    && previous.onContextMenu === next.onContextMenu
    && previous.onDelete === next.onDelete);

/** 密集总览下的轻量连线：保留选择/右键能力，去掉每条连线的 hover、删除按钮和拖动订阅。 */
export const ConnectionOverviewPath = memo(function ConnectionOverviewPath({
    connection,
    from,
    to,
    active,
    theme,
    onSelect,
    onContextMenu,
}: {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    active: boolean;
    theme: CanvasTheme;
    onSelect: (connectionId: string) => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>, connectionId: string) => void;
}) {
    const pathD = buildConnectionPathD(from, to);
    return (
        <path
            data-connection-id={connection.id}
            d={pathD}
            fill="none"
            stroke={active ? theme.node.linkActive : theme.node.muted}
            strokeWidth={active ? 2.5 : 1.2}
            strokeOpacity={active ? 1 : 0.58}
            style={{ cursor: "pointer", pointerEvents: "stroke" }}
            onClick={(event) => {
                event.stopPropagation();
                onSelect(connection.id);
            }}
            onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onContextMenu?.(event, connection.id);
            }}
        />
    );
}, (previous, next) => previous.connection === next.connection
    && previous.from === next.from
    && previous.to === next.to
    && previous.active === next.active
    && previous.theme === next.theme
    && previous.onSelect === next.onSelect
    && previous.onContextMenu === next.onContextMenu);

export function ActiveConnectionPath({ projectId, node, handle, target }: { projectId: string; node?: CanvasNodeData; handle: ConnectionHandle; target?: CanvasNodeData }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mouseWorld = useActiveConnectionPointer(projectId);
    if (!node) return null;

    const startX = handle.handleType === "source" ? node.position.x + node.width : mouseWorld.x;
    const startY = handle.handleType === "source" ? node.position.y + node.height / 2 : mouseWorld.y;
    const endX = handle.handleType === "source" ? mouseWorld.x : node.position.x;
    const endY = handle.handleType === "source" ? mouseWorld.y : node.position.y + node.height / 2;
    const snappedStartX = handle.handleType === "target" && target ? target.position.x + target.width : startX;
    const snappedStartY = handle.handleType === "target" && target ? target.position.y + target.height / 2 : startY;
    const snappedEndX = handle.handleType === "source" && target ? target.position.x : endX;
    const snappedEndY = handle.handleType === "source" && target ? target.position.y + target.height / 2 : endY;
    const distance = Math.abs(snappedEndX - snappedStartX);
    const pathD = `M ${snappedStartX} ${snappedStartY} C ${snappedStartX + distance * 0.5} ${snappedStartY}, ${snappedEndX - distance * 0.5} ${snappedEndY}, ${snappedEndX} ${snappedEndY}`;

    return <path d={pathD} stroke={theme.node.linkActive} strokeWidth="2" fill="none" strokeDasharray="5,5" />;
}
