import type { CanvasTextTarget } from "@/lib/canvas/collaborative-text-session";

export function deletesCanvasTextTarget(operation: Record<string, unknown>, target: CanvasTextTarget) {
    if (operation.type === "delete_node") return operation.id === target.nodeId;
    if (operation.type === "delete_h3_segment") return operation.nodeId === target.nodeId && operation.segmentId === target.segmentId;
    // A replacement can remove a Clip and add the same ID in one transaction.
    if (operation.type === "replace_h3_segments") return operation.nodeId === target.nodeId && Boolean(target.segmentId);
    return false;
}

export function evictDeletedCanvasTextSessions<T extends { backend: string; projectId: string; target: CanvasTextTarget }>(
    sessions: Map<string, T>, backend: string, projectId: string, operations: Array<Record<string, unknown>>,
) {
    for (const [key, entry] of sessions) {
        if (entry.backend === backend && entry.projectId === projectId && operations.some((operation) => deletesCanvasTextTarget(operation, entry.target))) {
            sessions.delete(key);
        }
    }
}

/** Obsolete drafts remain in the outbox, but cannot block generation from other nodes. */
export async function flushCurrentCanvasTextSessions(sessions: Iterable<{
    initialize: () => Promise<void>;
    getSnapshot: () => { pending: number };
    hasReplacedDocument: () => boolean;
    flush: () => Promise<void>;
}>) {
    await Promise.all([...sessions].map(async (session) => {
        await session.initialize();
        if (session.getSnapshot().pending && !session.hasReplacedDocument()) await session.flush();
    }));
}
