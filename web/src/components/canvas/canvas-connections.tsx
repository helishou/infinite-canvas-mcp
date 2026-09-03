import type { MouseEvent as ReactMouseEvent } from "react";
import { useState } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "@/types/canvas";

export function ConnectionPath({
    connection,
    from,
    to,
    active,
    onSelect,
    onContextMenu,
    onDelete,
}: {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    active: boolean;
    onSelect: () => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>) => void;
    onDelete?: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [hovered, setHovered] = useState(false);
    const [deleteHovered, setDeleteHovered] = useState(false);
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const dx = Math.abs(endX - startX);
    const curvature = Math.max(dx * 0.5, 50);
    const pathD = `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;

    // Cubic Bezier midpoint at t=0.5
    // B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3, at t=0.5:
    const midX = (startX + 3 * (startX + curvature) + 3 * (endX - curvature) + endX) / 8;
    const midY = (startY + 3 * startY + 3 * endY + endY) / 8;

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
                    onSelect();
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu?.(event);
                }}
            />
            <path
                d={pathD}
                stroke={active ? theme.node.activeStroke : theme.node.muted}
                strokeWidth={active ? 3 : 2}
                strokeOpacity={active ? 1 : 0.82}
                fill="none"
                style={{ filter: active ? `drop-shadow(0 0 8px ${theme.node.activeStroke}66)` : undefined, pointerEvents: "none" }}
            />
            {(hovered || active) && onDelete && (
                <g
                    transform={`translate(${midX}, ${midY})`}
                    data-connection-delete={connection.id}
                    style={{ pointerEvents: "none" }}
                >
                    <title>断开连线</title>
                    <rect x={-10} y={-10} width={20} height={20} rx={5} fill={theme.node.panel} fillOpacity={0.96} stroke={deleteHovered ? "#f87171" : theme.node.muted} strokeWidth={1.2} style={{ pointerEvents: "all", cursor: "pointer", filter: "drop-shadow(0 2px 5px rgba(0,0,0,.28))" }} onMouseEnter={() => setDeleteHovered(true)} onMouseLeave={() => setDeleteHovered(false)} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onDelete(); }} onClick={(event) => event.stopPropagation()} />
                    <line x1={-3.5} y1={-3.5} x2={3.5} y2={3.5} stroke={deleteHovered ? "#fca5a5" : theme.node.text} strokeWidth={1.7} strokeLinecap="round" style={{ pointerEvents: "none" }} />
                    <line x1={3.5} y1={-3.5} x2={-3.5} y2={3.5} stroke={deleteHovered ? "#fca5a5" : theme.node.text} strokeWidth={1.7} strokeLinecap="round" style={{ pointerEvents: "none" }} />
                </g>
            )}
        </g>
    );
}

export function ActiveConnectionPath({ node, handle, mouseWorld, target }: { node?: CanvasNodeData; handle: ConnectionHandle; mouseWorld: Position; target?: CanvasNodeData }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
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

    return <path d={pathD} stroke={theme.node.activeStroke} strokeWidth="2" fill="none" strokeDasharray="5,5" />;
}
