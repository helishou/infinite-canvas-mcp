import type { CanvasProject } from "../db.js";

export type ResolvedCanvasImageReference = {
    id: string;
    name: string;
    storageKey?: string;
    dataUrl?: string;
    url?: string;
    mimeType: string;
};

/**
 * 从画布图谱解析图片生成的参考图。
 * sourceNodeId 是本次生成的源节点：配置节点直接读入边；生成结果节点
 * 先沿父级配置节点回溯，再把自身作为改图源，顺序与前端展示顺序一致。
 */
export function resolveCanvasImageReferences(project: CanvasProject, sourceNodeId: string) {
    const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
    const connections = Array.isArray(project.connections) ? project.connections as Array<Record<string, unknown>> : [];
    const nodeById = new Map(nodes.map((node) => [String(node.id || ""), node]));
    const source = nodeById.get(sourceNodeId);
    if (!source) return null;

    const references: ResolvedCanvasImageReference[] = [];
    const added = new Set<string>();
    if (String(source.type || "") === "image") addImageReference(source, references, added);

    const inputNode = String(source.type || "") === "config"
        ? source
        : outgoingNodes(sourceNodeId, connections, nodeById).find((node) => String(node.type || "") === "config")
            || incomingNodes(sourceNodeId, connections, nodeById).find((node) => String(node.type || "") === "config");
    const referenceTarget = inputNode || source;
    for (const node of incomingNodes(String(referenceTarget.id || ""), connections, nodeById)) {
        if (String(node.type || "") === "image") addImageReference(node, references, added);
    }
    return references;
}

function incomingNodes(targetId: string, connections: Array<Record<string, unknown>>, nodeById: Map<string, Record<string, unknown>>) {
    return connections
        .filter((connection) => String(connection.toNodeId || "") === targetId)
        .sort((left, right) => {
            const leftOrder = typeof left.order === "number" ? left.order : Number.MAX_SAFE_INTEGER;
            const rightOrder = typeof right.order === "number" ? right.order : Number.MAX_SAFE_INTEGER;
            return leftOrder - rightOrder;
        })
        .flatMap((connection) => {
            const node = nodeById.get(String(connection.fromNodeId || ""));
            return node ? [node] : [];
        });
}

function outgoingNodes(sourceId: string, connections: Array<Record<string, unknown>>, nodeById: Map<string, Record<string, unknown>>) {
    return connections
        .filter((connection) => String(connection.fromNodeId || "") === sourceId)
        .sort((left, right) => {
            const leftOrder = typeof left.order === "number" ? left.order : Number.MAX_SAFE_INTEGER;
            const rightOrder = typeof right.order === "number" ? right.order : Number.MAX_SAFE_INTEGER;
            return leftOrder - rightOrder;
        })
        .flatMap((connection) => {
            const node = nodeById.get(String(connection.toNodeId || ""));
            return node ? [node] : [];
        });
}

function addImageReference(node: Record<string, unknown>, references: ResolvedCanvasImageReference[], added: Set<string>) {
    const id = String(node.id || "");
    const metadata = recordOf(node.metadata);
    const content = String(metadata.content || metadata.url || "");
    const storageKey = String(metadata.storageKey || "");
    if (!id || (!content && !storageKey) || added.has(id)) return;
    added.add(id);
    references.push({
        id,
        name: `${String(node.title || id).replace(/[^\w\u4e00-\u9fff-]+/g, "-")}.png`,
        ...(storageKey ? { storageKey } : {}),
        ...(content.startsWith("data:") ? { dataUrl: content } : {}),
        ...(content && !content.startsWith("data:") ? { url: content } : {}),
        mimeType: String(metadata.mimeType || "image/png"),
    });
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
