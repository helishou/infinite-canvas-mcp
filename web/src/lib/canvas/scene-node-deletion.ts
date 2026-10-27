import { isH3NodeType } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import type { CanvasNodeData } from "@/types/canvas";

type CanvasConnection = { fromNodeId: string; toNodeId: string };

const activeNodeStatuses = new Set(["queued", "loading", "generating", "awaiting_confirmation"]);

export function isSceneBoundH3Node(node: CanvasNodeData | undefined | null): boolean {
    return Boolean(node && isH3NodeType(node.type) && String(node.metadata?.productionSceneId || "").trim());
}

/** Keep this predicate in parity with Backend operation-authority.ts. */
export function isEmptySceneBoundH3Node(node: CanvasNodeData | undefined | null, connections: readonly CanvasConnection[]): boolean {
    if (!isSceneBoundH3Node(node)) return false;
    const metadata = node!.metadata;
    const segments = Array.isArray(metadata?.segments) ? metadata.segments : [];
    return segments.length === 0
        && !metadata?.content
        && !metadata?.storageKey
        && !metadata?.runtimeTaskId
        && !activeNodeStatuses.has(String(metadata?.status || ""))
        && !connections.some(connection => connection.fromNodeId === node!.id || connection.toNodeId === node!.id);
}

export function isProtectedSceneBoundH3Node(node: CanvasNodeData | undefined | null, connections: readonly CanvasConnection[]): boolean {
    return isSceneBoundH3Node(node) && !isEmptySceneBoundH3Node(node, connections);
}
