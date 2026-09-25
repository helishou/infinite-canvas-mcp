type Node = Record<string, unknown>;
type Project = Record<string, unknown>;
type StateInput = { view?: "index" | "graph"; nodeIds?: string[]; nodeOffset?: number; nodeLimit?: number; ifRevision?: number; projectId?: string };

function record(value: unknown): Node {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Node : {};
}

function bytes(value: unknown) {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export class CanvasStateOverflowError extends Error {
    constructor(readonly bytes: number, readonly chars: number) {
        super("画布单个节点目录项超过 MCP 输出上限，请缩小查询范围");
    }
}

export function validateCanvasStateInput(input: StateInput) {
    if (input.ifRevision !== undefined && (!input.projectId || input.nodeIds !== undefined || input.nodeOffset !== undefined || input.nodeLimit !== undefined || input.view === "graph")) {
        throw new Error("ifRevision 只适用于指定 projectId 的完整默认节点目录，不可与 nodeIds、分页或 view: graph 混用");
    }
}

export function canvasNodeIndex(node: Node) {
    const metadata = record(node.metadata);
    const type = String(node.type || "");
    const generationMode = String(node.generationMode || metadata.generationMode || (type.includes("minimax") ? "video" : ""));
    return { id: String(node.id || ""), type, title: String(node.title || ""), ...(generationMode ? { generationMode } : {}) };
}

function canvasNodeGraph(node: Node) {
    const metadata = record(node.metadata);
    const position = record(node.position);
    return {
        ...canvasNodeIndex(node),
        position: { x: Number(position.x || 0), y: Number(position.y || 0) },
        ...(typeof node.width === "number" ? { width: node.width } : {}),
        ...(typeof node.height === "number" ? { height: node.height } : {}),
        ...(metadata.status ? { status: String(metadata.status) } : {}),
        ...(metadata.model ? { model: String(metadata.model) } : {}),
        ...(metadata.storageKey ? { storageKey: String(metadata.storageKey) } : {}),
    };
}

/** Backend MCP and the Agent compatibility route use the same read projection and pagination. */
export function summarizeCanvasState(project: Project, input: StateInput, maxBytes = 0) {
    validateCanvasStateInput(input);
    const nodes = Array.isArray(project.nodes) ? project.nodes as Node[] : [];
    const connections = Array.isArray(project.connections) ? project.connections as Node[] : [];
    const id = String(project.id || project.projectId || "");
    const revision = typeof project.revision === "number" ? project.revision : undefined;
    const totalNodes = typeof project.nodeCount === "number" ? project.nodeCount : nodes.length;
    const connectionCount = typeof project.connectionCount === "number" ? project.connectionCount : connections.length;
    const base = {
        id, title: String(project.title || ""), ...(revision !== undefined ? { revision } : {}),
        ...(project.projectId ? { projectId: String(project.projectId) } : {}),
        ...(project.updatedAt ? { updatedAt: project.updatedAt } : {}),
        nodeCount: totalNodes, connectionCount, totalNodes,
    };
    if (revision !== undefined && input.ifRevision === revision) return { ...base, unchanged: true };
    if (input.nodeIds) {
        const wanted = new Set(input.nodeIds);
        const selected = nodes.filter((node) => wanted.has(String(node.id || "")));
        const related = connections.filter((edge) => wanted.has(String(edge.fromNodeId)) || wanted.has(String(edge.toNodeId)));
        const full = { ...base, nodes: selected, connections: related, truncated: false };
        if (!maxBytes || bytes(full) <= maxBytes) return full;
        return { ...base, nodes: selected.map(canvasNodeGraph), connections: related, truncated: false, metadataTruncated: true,
            hint: "完整 metadata 超过输出上限；H3 内容请使用 h3_get_node 与 h3_get_clip 定向读取。" };
    }
    const graph = input.view === "graph";
    const offset = Math.min(totalNodes, Math.max(0, input.nodeOffset || 0));
    const limit = input.nodeLimit ?? totalNodes;
    const available = nodes.slice(offset, offset + limit).map(graph ? canvasNodeGraph : canvasNodeIndex);
    const page = (count: number) => {
        const chosen = available.slice(0, count);
        const nextNodeOffset = offset + count < totalNodes ? offset + count : undefined;
        const ids = new Set(chosen.map((node) => node.id));
        const pageConnections = graph ? (offset === 0 && nextNodeOffset === undefined ? connections
            : connections.filter((edge) => ids.has(String(edge.fromNodeId)) || ids.has(String(edge.toNodeId)))) : undefined;
        return { ...base, nodes: chosen, ...(graph ? { connections: pageConnections } : {}), nodeOffset: offset,
            truncated: nextNodeOffset !== undefined,
            ...(nextNodeOffset !== undefined ? { nextNodeOffset } : {}),
            ...(graph && pageConnections!.length < connectionCount ? { connectionsTruncated: true } : {}),
        };
    };
    if (!maxBytes || bytes(page(available.length)) <= maxBytes) return page(available.length);
    let low = 0; let high = available.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (bytes(page(middle)) <= maxBytes) low = middle;
        else high = middle - 1;
    }
    if (low) return page(low);
    if (graph) {
        const first = { ...page(1), connections: [], connectionsTruncated: true,
            hint: "该节点相关连线超过输出上限；使用 nextNodeOffset 继续读取节点。" };
        if (bytes(first) <= maxBytes) return first;
    }
    const first = page(1);
    throw new CanvasStateOverflowError(bytes(first), JSON.stringify(first).length);
}
