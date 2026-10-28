import { normalizeEntityPrimaryMedia } from "./shared-asset-reference.js";

type Node = Record<string, unknown>;
type Project = Record<string, unknown>;
export type StateInput = { view?: "index" | "graph"; nodeIds?: string[]; nodeOffset?: number; nodeLimit?: number; ifRevision?: number; projectId?: string; projection?: "summary" | "media" | "generation" | "full"; includeConnections?: boolean };

function record(value: unknown): Node {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Node : {};
}

function bytes(value: unknown) {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export class CanvasStateOverflowError extends Error {
    constructor(readonly bytes: number, readonly chars: number) {
        super("画布读取超过 MCP 输出上限，请缩小 nodeIds 或使用轻量 projection；完整正文使用专用分块读取或 canvas_export_snapshot");
    }
}

export function validateCanvasStateInput(input: StateInput) {
    if ((input.projection !== undefined || input.includeConnections !== undefined) && !Array.isArray(input.nodeIds)) {
        throw new Error("projection/includeConnections 仅支持 nodeIds 定向读取");
    }
    if (input.projection !== undefined && !["summary", "media", "generation", "full"].includes(input.projection)) throw new Error("projection 必须为 summary/media/generation/full");
    if (input.includeConnections !== undefined && typeof input.includeConnections !== "boolean") throw new Error("includeConnections 必须为 boolean");
    if (input.ifRevision !== undefined && (!input.projectId || input.nodeIds !== undefined || input.nodeOffset !== undefined || input.nodeLimit !== undefined || input.view === "graph")) {
        throw new Error("ifRevision 只适用于指定 projectId 的完整默认节点目录，不可与 nodeIds、分页或 view: graph 混用");
    }
}

/** Explicit allowlists keep prompts, references and history out of lightweight reads. */
function projectNode(node: Node, projection: NonNullable<StateInput["projection"]>): Node {
    if (projection === "full") return node;
    const metadata = record(node.metadata);
    const summary = { ...canvasNodeIndex(node), ...(typeof metadata.status === "string" ? { status: metadata.status } : {}) };
    if (projection === "summary") return summary;
    if (projection === "media") {
        const type = String(node.type || "");
        if (!["image", "video", "audio", "character", "scene", "prop"].includes(type)) return { ...summary, unsupportedProjection: "media" };
        const media = normalizeEntityPrimaryMedia(type, metadata, type === "character" ? "gallery" : "nested");
        const keys = ["storageKey", "mimeType", "naturalWidth", "naturalHeight", "bytes", "durationMs"];
        const current = Object.fromEntries(keys.filter(key => typeof media[key] === "string" || typeof media[key] === "number").map(key => [key, media[key]]));
        const source = record(metadata.sharedAssetReference);
        const sourceIdentity = Object.fromEntries(["dramaId", "assetId", "sourceProjectId", "sourceNodeId"].filter(key => typeof source[key] === "string").map(key => [key, source[key]]));
        return { ...summary, media: current, ...(Object.keys(sourceIdentity).length ? { source: sourceIdentity } : {}), ...(typeof current.storageKey === "string" && current.storageKey ? {} : { missingFields: ["storageKey"] }) };
    }
    const generationMode = summary.generationMode;
    if (!generationMode && node.type !== "config") return { ...summary, unsupportedProjection: "generation" };
    const keys = ["model", "modelName", "taskMode", "quality", "size", "width", "height", "seconds", "resolution", "count", "generateAudio", "watermark", "seed"];
    const generation = Object.fromEntries(keys.filter(key => ["string", "number", "boolean"].includes(typeof metadata[key])).map(key => [key, metadata[key]]));
    return { ...summary, generation };
}

export function canvasNodeIndex(node: Node) {
    const metadata = record(node.metadata);
    const type = String(node.type || "");
    const generationMode = String(node.generationMode || metadata.generationMode || (type.includes("minimax") ? "video" : ""));
    const title = String(node.title || "");
    return { id: String(node.id || ""), type, title: title.length > 240 ? `${title.slice(0, 239)}…` : title,
        ...(title.length > 240 ? { titleTruncated: true, titleLength: title.length } : {}), ...(generationMode ? { generationMode } : {}) };
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
    const projectTitle = String(project.title || "");
    const base = {
        id, title: projectTitle.length > 240 ? `${projectTitle.slice(0, 239)}…` : projectTitle,
        ...(projectTitle.length > 240 ? { titleTruncated: true, titleLength: projectTitle.length } : {}), ...(revision !== undefined ? { revision } : {}),
        ...(project.projectId ? { projectId: String(project.projectId) } : {}),
        ...(project.updatedAt ? { updatedAt: project.updatedAt } : {}),
        nodeCount: totalNodes, connectionCount, totalNodes,
    };
    if (revision !== undefined && input.ifRevision === revision) return { ...base, unchanged: true };
    if (input.nodeIds) {
        const wanted = new Set(input.nodeIds);
        const selected = nodes.filter((node) => wanted.has(String(node.id || "")));
        const includeConnections = input.includeConnections ?? input.projection === undefined;
        const related = includeConnections ? connections.filter((edge) => wanted.has(String(edge.fromNodeId)) || wanted.has(String(edge.toNodeId))) : [];
        if (input.projection !== undefined || input.includeConnections !== undefined) {
            const projection = input.projection || "full";
            const found = new Set(selected.map(node => String(node.id)));
            const result = { ...base, projection, requestedCount: wanted.size, returnedCount: selected.length,
                missingNodeIds: [...wanted].filter(id => !found.has(id)), nodes: selected.map(node => projectNode(node, projection)),
                ...(includeConnections ? { connections: related } : {}), truncated: false };
            if (maxBytes && bytes(result) > maxBytes) throw new CanvasStateOverflowError(bytes(result), JSON.stringify(result).length);
            return result;
        }
        const full = { ...base, nodes: selected, connections: related, truncated: false };
        if (!maxBytes || bytes(full) <= maxBytes) return full;
        return { ...base, nodes: selected.map(canvasNodeGraph), connections: related, truncated: false, metadataTruncated: true,
            hint: "完整 metadata 超过输出上限；H3 内容请使用 h3_get_node 与 h3_get_clip 定向读取。" };
    }
    const graph = input.view === "graph";
    const offset = Math.min(totalNodes, Math.max(0, input.nodeOffset || 0));
    const limit = input.nodeLimit ?? Math.min(100, totalNodes);
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
