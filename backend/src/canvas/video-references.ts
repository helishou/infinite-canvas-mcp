import type { CanvasProject } from "../db.js";
import { effectiveCanvasNodeType } from "./image-references.js";

/**
 * 画布视频参考解析。
 *
 * 网页端组装生成命令时会自己把视频节点分进 `videoReferences`，但 Backend 的
 * MCP / Agent / 任务重跑路径只解析图片参考：视频节点（含 `generationMode: video`
 * 的智能节点）不产出任何参考，工作流随后报「缺少必选视频」。这里把视频参考的
 * 解析放进 Backend，与图片参考同源（同一份连线、同样的顺序语义）。
 */
export type ResolvedCanvasVideoReference = {
    id: string;
    name: string;
    storageKey?: string;
    url?: string;
    mimeType: string;
};

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nodesOf(project: CanvasProject) {
    return Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
}

function connectionsOf(project: CanvasProject) {
    return Array.isArray(project.connections) ? project.connections as Array<Record<string, unknown>> : [];
}

function orderOf(connection: Record<string, unknown>) {
    return typeof connection.order === "number" ? connection.order : Number.MAX_SAFE_INTEGER;
}

function incomingNodes(targetId: string, connections: Array<Record<string, unknown>>, nodeById: Map<string, Record<string, unknown>>) {
    return connections
        .filter((connection) => String(connection.toNodeId || "") === targetId)
        .sort((left, right) => orderOf(left) - orderOf(right))
        .flatMap((connection) => {
            const node = nodeById.get(String(connection.fromNodeId || ""));
            return node ? [node] : [];
        });
}

function outgoingNodes(sourceId: string, connections: Array<Record<string, unknown>>, nodeById: Map<string, Record<string, unknown>>) {
    return connections
        .filter((connection) => String(connection.fromNodeId || "") === sourceId)
        .sort((left, right) => orderOf(left) - orderOf(right))
        .flatMap((connection) => {
            const node = nodeById.get(String(connection.toNodeId || ""));
            return node ? [node] : [];
        });
}

/**
 * 单个视频源节点 → 参考。只有已经产出版本的视频节点能给参考：
 * 智能节点尚未生成（没有 storageKey/url）时跳过，不伪造空媒体。
 */
export function resolveCanvasVideoReferenceNode(node: Record<string, unknown>): ResolvedCanvasVideoReference | null {
    if (effectiveCanvasNodeType(node) !== "video") return null;
    const metadata = recordOf(node.metadata);
    const storageKey = String(metadata.storageKey || "").trim();
    const url = String(metadata.content || metadata.url || "").trim();
    if (!storageKey && !url) return null;
    const name = String(metadata.fileName || metadata.name || node.title || node.id || "reference.mp4");
    const mimeType = String(metadata.mimeType || "").startsWith("video/") ? String(metadata.mimeType) : "video/mp4";
    return {
        id: String(node.id || name),
        name: name.endsWith(".mp4") || /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.mp4`,
        ...(storageKey ? { storageKey } : {}),
        ...(url && !storageKey ? { url } : {}),
        mimeType,
    };
}

/** 显式参考节点 id 顺序 → 视频参考（图片节点会被忽略，由图片解析负责）。 */
export function resolveCanvasVideoReferencesByIds(
    project: CanvasProject,
    targetNodeId: string,
    referenceNodeIds: string[],
): ResolvedCanvasVideoReference[] {
    if (!referenceNodeIds.length) return [];
    const nodes = nodesOf(project);
    const connections = connectionsOf(project);
    const nodeById = new Map(nodes.map((node) => [String(node.id || ""), node]));
    // 与图片同构：参考挂在生成节点上；目标不是 config 时沿连线找到它的 config。
    const target = nodeById.get(targetNodeId);
    const owner = target && String(target.type || "") === "config"
        ? target
        : target
            ? outgoingNodes(targetNodeId, connections, nodeById).find((node) => String(node.type || "") === "config") || target
            : undefined;
    const ownerId = String(owner?.id || targetNodeId);
    const linked = new Map(incomingNodes(ownerId, connections, nodeById).map((node) => [String(node.id || ""), node]));
    const references: ResolvedCanvasVideoReference[] = [];
    const added = new Set<string>();
    for (const id of referenceNodeIds) {
        const node = nodeById.get(id) || linked.get(id);
        if (!node) continue;
        const reference = resolveCanvasVideoReferenceNode(node);
        if (!reference || added.has(reference.id)) continue;
        added.add(reference.id);
        references.push(reference);
    }
    return references;
}

/** 生成节点上的视频入边 → 视频参考，顺序与连线顺序一致。 */
export function resolveCanvasVideoReferences(project: CanvasProject, sourceNodeId: string): ResolvedCanvasVideoReference[] {
    const nodes = nodesOf(project);
    const connections = connectionsOf(project);
    const nodeById = new Map(nodes.map((node) => [String(node.id || ""), node]));
    const source = nodeById.get(sourceNodeId);
    if (!source) return [];
    const owner = String(source.type || "") === "config"
        ? source
        : outgoingNodes(sourceNodeId, connections, nodeById).find((node) => String(node.type || "") === "config")
            || incomingNodes(sourceNodeId, connections, nodeById).find((node) => String(node.type || "") === "config")
            || source;
    const references: ResolvedCanvasVideoReference[] = [];
    const added = new Set<string>();
    for (const node of incomingNodes(String(owner.id || ""), connections, nodeById)) {
        const reference = resolveCanvasVideoReferenceNode(node);
        if (!reference || added.has(reference.id)) continue;
        added.add(reference.id);
        references.push(reference);
    }
    return references;
}
