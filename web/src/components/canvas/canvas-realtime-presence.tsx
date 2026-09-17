import { useCallback, useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { MousePointer2 } from "lucide-react";
import { connectCanvasRealtime, type CanvasPeer } from "@/services/api/canvas-realtime";
import { getCanvasCollaborationClient } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData, Position, ViewportTransform } from "@/types/canvas";

const emptyPeers: CanvasPeer[] = [];
const usePresence = create<{ peers: Record<string, CanvasPeer[]>; errors: Record<string, string> }>(() => ({ peers: {}, errors: {} }));
const viewportWriters = new Map<string, (viewport: ViewportTransform) => void>();

export function writeCanvasPresenceViewport(projectId: string, viewport: ViewportTransform) {
    viewportWriters.get(projectId)?.(viewport);
}

/** 父画布只持有发送句柄，不订阅高频远端光标。 */
export function useCanvasRealtimePresence(projectId: string, selectedNodeIds: Set<string>) {
    const url = useBackendStore((state) => state.url);
    const token = useBackendStore((state) => state.token);
    const connection = useRef<ReturnType<typeof connectCanvasRealtime> | null>(null);
    const selectedRef = useRef<string[]>([]);
    useEffect(() => {
        if (!projectId || !token) return;
        let membership = "";
        const session = connectCanvasRealtime(projectId, (peers) => {
            usePresence.setState((state) => ({ peers: { ...state.peers, [projectId]: peers } }));
            const next = peers.map((peer) => `${peer.connectionId}:${peer.label}`).sort().join("|");
            if (membership === next) return;
            membership = next;
            const participants = [...new Map(peers.map((peer) => [peer.clientId, peer])).values()];
            useCanvasStore.setState((state) => ({ collaborators: { ...state.collaborators, [projectId]: participants.map((peer) => ({ clientId: peer.clientId, label: peer.label, kind: "browser" as const, lastActivityAt: new Date().toISOString() })) } }));
        }, (error) => usePresence.setState((state) => ({ errors: { ...state.errors, [projectId]: error } })));
        connection.current = session;
        session.update({ selectedNodeIds: selectedRef.current });
        return () => {
            if (connection.current === session) connection.current = null;
            session.close();
        };
    }, [projectId, url, token]);
    useEffect(() => {
        selectedRef.current = [...selectedNodeIds];
        connection.current?.update({ selectedNodeIds: selectedRef.current });
    }, [selectedNodeIds]);
    const publishCursor = useCallback((cursor?: Position) => connection.current?.update({ cursor }), []);
    const publishDrag = useCallback((positions: Map<string, Position>) => connection.current?.update({ drag: [...positions].map(([nodeId, position]) => ({ nodeId, position })) }), []);
    return { publishCursor, publishDrag };
}

export function CanvasRealtimePresenceLayer({ projectId, nodes, viewport }: { projectId: string; nodes: CanvasNodeData[]; viewport: ViewportTransform }) {
    const peers = usePresence((state) => state.peers[projectId] || emptyPeers);
    const error = usePresence((state) => state.errors[projectId] || "");
    const layer = useRef<HTMLDivElement>(null);
    const latestViewport = useRef(viewport);
    latestViewport.current = viewport;
    useEffect(() => {
        const write = (next: ViewportTransform) => {
            if (!layer.current) return;
            layer.current.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.k})`;
            layer.current.style.setProperty("--inverse-scale", String(1 / next.k));
        };
        viewportWriters.set(projectId, write);
        write(latestViewport.current);
        return () => { if (viewportWriters.get(projectId) === write) viewportWriters.delete(projectId); };
    }, [projectId]);
    useEffect(() => { writeCanvasPresenceViewport(projectId, viewport); }, [projectId, viewport]);
    const ownId = getCanvasCollaborationClient().clientId;
    const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    return (
        <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
            {error ? <div className="absolute bottom-24 left-4 text-xs text-amber-600 dark:text-amber-400" role="status">{error}</div> : null}
            <div ref={layer} className="absolute inset-0 origin-top-left" aria-hidden>
                {peers.filter((peer) => peer.clientId !== ownId).map((peer) => (
                    <div key={peer.connectionId}>
                        {peer.selectedNodeIds.map((id) => {
                            const node = nodesById.get(id);
                            if (!node) return null;
                            const position = peer.drag?.find((item) => item.nodeId === id)?.position || node.position;
                            return <div key={id} className="absolute rounded-lg border-solid" style={{ left: position.x, top: position.y, width: node.width, height: node.height, borderWidth: "calc(2px * var(--inverse-scale))", borderColor: peer.color }} />;
                        })}
                        {peer.cursor ? <div className="absolute flex origin-top-left items-start" style={{ left: peer.cursor.x, top: peer.cursor.y, transform: "scale(var(--inverse-scale))", color: peer.color }}>
                            <MousePointer2 className="size-5 fill-current" />
                            <span className="ml-0.5 mt-4 rounded px-1.5 py-0.5 text-[10px] font-medium text-white" style={{ background: peer.color }}>{peer.label}</span>
                        </div> : null}
                    </div>
                ))}
            </div>
        </div>
    );
}
