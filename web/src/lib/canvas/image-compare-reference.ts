import { CanvasNodeType, type CanvasConnection, type CanvasImageReferenceSnapshot, type CanvasNodeData } from "@/types/canvas";
import { canvasNodeImage } from "@/lib/canvas/canvas-image-renderability";

export type CanvasCompareReference = {
    storageKey?: string;
    content: string;
};

/** Convert each supported input-reference representation into the preview contract. */
function normalizeCompareReference(value: unknown): CanvasCompareReference | null {
    if (typeof value === "string") {
        const reference = value.trim();
        if (!reference) return null;
        return reference.startsWith("image:")
            ? { storageKey: reference, content: "" }
            : { content: reference };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const reference = value as { storageKey?: unknown; url?: unknown; content?: unknown };
    const storageKey = typeof reference.storageKey === "string" ? reference.storageKey.trim() : "";
    const content = typeof reference.url === "string" && reference.url
        ? reference.url
        : typeof reference.content === "string" ? reference.content : "";
    return storageKey || content ? { ...(storageKey ? { storageKey } : {}), content } : null;
}

/**
 * Resolve the image that was actually used for the selected result.
 *
 * A result image may have been generated with explicit references that are not
 * represented by the current graph (for example, after history selection or
 * reconnects). The generation snapshot is therefore the source of truth;
 * graph traversal is only the legacy fallback for older nodes.
 */
export function findCanvasCompareReference(
    node: CanvasNodeData,
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    snapshotReferences?: CanvasImageReferenceSnapshot[],
): CanvasCompareReference | null {
    if (node.metadata?.loopOutputSlot) {
        const inputConnections = connections.filter((connection) => connection.toNodeId === node.id && connection.role === "loop-input-reference");
        const nodeById = new Map(nodes.map((item) => [item.id, item]));
        const inputImage = inputConnections.map((connection) => nodeById.get(connection.fromNodeId))
            .map((inputNode) => inputNode ? canvasNodeImage(inputNode) : null)
            .find((image) => image?.storageKey || image?.content);
        // The per-round reference edge identifies the matching input slot. Never
        // replace a missing input with an unrelated fixed reference from the snapshot.
        return normalizeCompareReference(inputImage);
    }
    const snapshotReference = snapshotReferences?.map(normalizeCompareReference)
        .find((reference): reference is CanvasCompareReference => reference !== null);
    if (snapshotReference) return snapshotReference;

    // Local style-transfer image nodes persist the actual input order on metadata.references:
    // [target image, style image]. Compare the result with the target, not the style exemplar.
    if (node.metadata?.model === "local-style-transfer" && node.metadata.generationType === "edit") {
        const targetReference = normalizeCompareReference(node.metadata.references?.[0]);
        if (targetReference) return targetReference;
    }
    if (!node || !node.metadata?.content) return null;
    const nodeById = new Map(nodes.map((item) => [item.id, item]));
    const upstreamByNode = new Map<string, string[]>();
    for (const connection of connections) {
        const list = upstreamByNode.get(connection.toNodeId);
        if (list) list.push(connection.fromNodeId);
        else upstreamByNode.set(connection.toNodeId, [connection.fromNodeId]);
    }
    const queue: Array<{ id: string; depth: number }> = [{ id: node.id, depth: 0 }];
    const visited = new Set<string>([node.id]);
    const maxHops = 16;
    while (queue.length) {
        const { id, depth } = queue.shift()!;
        if (depth >= maxHops) continue;
        for (const upstreamId of upstreamByNode.get(id) || []) {
            if (visited.has(upstreamId)) continue;
            visited.add(upstreamId);
            const source = nodeById.get(upstreamId);
            if (source?.type === CanvasNodeType.Character) continue;
            if (source?.type === CanvasNodeType.Image && (source.metadata?.content || source.metadata?.storageKey)) {
                return normalizeCompareReference(canvasNodeImage(source));
            }
            if (source?.type === CanvasNodeType.Config) {
                queue.push({ id: upstreamId, depth: depth + 1 });
            }
        }
    }
    return null;
}
