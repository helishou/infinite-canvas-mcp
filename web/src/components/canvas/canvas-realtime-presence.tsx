import { useCallback, useEffect, useRef, useState } from "react";
import { MousePointer2 } from "lucide-react";

import { getBackendUrl, getCanvasCollaborationClient } from "@/services/backend-api";
import { getBackendTokenShared } from "@/lib/backend-token";
import { useBackendStore } from "@/stores/use-backend-store";
import type { CanvasNodeData, Position, ViewportTransform } from "@/types/canvas";

export type CanvasRealtimePeer = {
    clientId: string;
    label: string;
    color: string;
    cursor?: Position;
    selectedNodeIds: string[];
};

export function useCanvasRealtimePresence(projectId: string, selectedNodeIds: Set<string>) {
    const connected = useBackendStore((state) => state.connected);
    const [peers, setPeers] = useState<CanvasRealtimePeer[]>([]);
    const socketRef = useRef<WebSocket | null>(null);
    const frameRef = useRef<number | null>(null);
    const cursorRef = useRef<Position | undefined>(undefined);
    const selectedRef = useRef<string[]>([]);
    const client = getCanvasCollaborationClient();
    const color = peerColor(client.clientId);

    const flushPresence = useCallback(() => {
        frameRef.current = null;
        const socket = socketRef.current;
        if (socket?.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: "presence", cursor: cursorRef.current, selectedNodeIds: selectedRef.current }));
    }, []);

    const publishCursor = useCallback((cursor: Position) => {
        cursorRef.current = cursor;
        if (frameRef.current == null) frameRef.current = requestAnimationFrame(flushPresence);
    }, [flushPresence]);

    useEffect(() => {
        selectedRef.current = [...selectedNodeIds];
        if (frameRef.current == null) frameRef.current = requestAnimationFrame(flushPresence);
    }, [flushPresence, selectedNodeIds]);

    useEffect(() => {
        if (!connected || !projectId) {
            setPeers([]);
            return;
        }
        const url = realtimeUrl(projectId, client.clientId, client.label, color);
        const socket = new WebSocket(url);
        let disposed = false;
        socketRef.current = socket;
        socket.addEventListener("open", flushPresence);
        socket.addEventListener("message", (event) => {
            if (disposed) return;
            try {
                const value = JSON.parse(String(event.data)) as { type?: string; projectId?: string; participants?: CanvasRealtimePeer[] };
                if (value.type === "presence" && value.projectId === projectId && Array.isArray(value.participants)) {
                    setPeers(value.participants.filter((peer) => peer.clientId !== client.clientId));
                }
            } catch { /* 丢弃损坏的瞬时 presence；持久化画布不受影响 */ }
        });
        socket.addEventListener("close", () => { if (!disposed) setPeers([]); });
        return () => {
            disposed = true;
            if (socketRef.current === socket) socketRef.current = null;
            socket.close();
            setPeers([]);
        };
    }, [client.clientId, client.label, color, connected, flushPresence, projectId]);

    useEffect(() => () => { if (frameRef.current != null) cancelAnimationFrame(frameRef.current); }, []);
    return { peers, publishCursor };
}

export function CanvasRealtimePresenceLayer({ peers, nodes, viewport }: { peers: CanvasRealtimePeer[]; nodes: CanvasNodeData[]; viewport: ViewportTransform }) {
    if (!peers.length) return null;
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    return (
        <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden" aria-hidden>
            {peers.flatMap((peer) => peer.selectedNodeIds.flatMap((id) => {
                const node = nodesById.get(id);
                if (!node) return [];
                return [<div key={`${peer.clientId}:${id}`} className="absolute rounded-lg border-2" style={{ left: viewport.x + node.position.x * viewport.k, top: viewport.y + node.position.y * viewport.k, width: node.width * viewport.k, height: node.height * viewport.k, borderColor: peer.color, boxShadow: `0 0 0 2px ${peer.color}22` }} />];
            }))}
            {peers.map((peer) => peer.cursor ? (
                <div key={peer.clientId} className="absolute flex items-start" style={{ transform: `translate3d(${viewport.x + peer.cursor.x * viewport.k}px, ${viewport.y + peer.cursor.y * viewport.k}px, 0)`, color: peer.color }}>
                    <MousePointer2 className="size-5 fill-current" />
                    <span className="ml-0.5 mt-4 rounded px-1.5 py-0.5 text-[10px] font-medium text-white" style={{ background: peer.color }}>{peer.label}</span>
                </div>
            ) : null)}
        </div>
    );
}

function realtimeUrl(projectId: string, clientId: string, label: string, color: string) {
    const backend = new URL(getBackendUrl());
    const local = (backend.hostname === "127.0.0.1" || backend.hostname === "localhost") && backend.port === "17370";
    const base = local ? new URL(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/canvas/realtime`) : new URL(`${backend.protocol === "https:" ? "wss" : "ws"}://${backend.host}/canvas/realtime`);
    base.searchParams.set("token", getBackendTokenShared());
    base.searchParams.set("projectId", projectId);
    base.searchParams.set("clientId", clientId);
    base.searchParams.set("label", label);
    base.searchParams.set("color", color);
    return base.toString();
}

function peerColor(clientId: string) {
    const colors = ["#0f766e", "#b45309", "#be123c", "#1d4ed8", "#6d28d9", "#3f6212"];
    let hash = 0;
    for (let index = 0; index < clientId.length; index += 1) hash = (hash * 31 + clientId.charCodeAt(index)) | 0;
    return colors[Math.abs(hash) % colors.length];
}
