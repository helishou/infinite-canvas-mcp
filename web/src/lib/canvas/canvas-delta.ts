import { characterReferenceUpdates } from "@basketikun/canvas-agent/reference-contract";
import { canvasNodeDefaultSize } from "@basketikun/canvas-agent/canvas/node-sizes";
import { compactH3SegmentStarts } from "@basketikun/canvas-agent/runtime-fields";

import { syncOrderedGroupMembership } from "@/lib/canvas/ordered-group";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

/**
 * 画布 delta 回放所需的最小项目形状。Backend 广播、未确认命令投影和本地意图投影
 * 都用这一份实现；调用方传入的项目类型原样返回。
 */
export type CanvasDeltaProject = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    revision?: number;
    updatedAt?: string;
    referenceCatalog?: Array<Record<string, unknown>>;
};

export function isH3NodeType(type: string): boolean {
    return /^minimax|^smart-minimax/.test(type);
}

/**
 * 在本地回放 Backend 画布 op。权威结果由 Backend 事务产生；这里只负责让当前窗口
 * 在回执到达前看到同一份 op 的效果，因此语义必须与 Backend 的 ops 实现一致。
 */
export function applyBackendCanvasDelta<T extends CanvasDeltaProject>(base: T, operations: Array<Record<string, unknown>>, revision: number, updatedAt?: string): T {
    const changedIds = new Set(operations.filter((operation) => operation.type === "update_node" || String(operation.type).includes("h3_segment")).map((operation) => String(operation.nodeId || operation.id || "")));
    let nodes = base.nodes.map((node) => changedIds.has(node.id) ? { ...node, metadata: node.metadata ? { ...node.metadata } : node.metadata } : node);
    const connections = [...base.connections];
    const projectPatch: Record<string, unknown> = {};
    for (const operation of operations) {
        const type = String(operation.type || "");
        if (type === "add_node") {
            const id = String(operation.id || "");
            if (!id || nodes.some((node) => node.id === id)) continue;
            const defaultSize = canvasNodeDefaultSize(operation.nodeType);
            const added: CanvasNodeData = {
                id,
                type: String(operation.nodeType || "text") as CanvasNodeData["type"],
                title: String(operation.title || ""),
                position: (operation.position && typeof operation.position === "object" ? operation.position : { x: Number(operation.x || 0), y: Number(operation.y || 0) }) as CanvasNodeData["position"],
                width: Number(operation.width || defaultSize.width),
                height: Number(operation.height || defaultSize.height),
                metadata: (operation.metadata && typeof operation.metadata === "object" ? operation.metadata : {}) as CanvasNodeData["metadata"],
            };
            // 数组顺序即渲染层级：组垫在成员下面时需要显式插入位置。
            const requestedIndex = Number(operation.index);
            if (Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < nodes.length) nodes.splice(requestedIndex, 0, added);
            else nodes.push(added);
            nodes = syncOrderedGroupMembership(nodes, id);
        } else if (type === "update_node") {
            const node = nodes.find((item) => item.id === String(operation.id || ""));
            if (!node) continue;
            const previousNode = { ...node, metadata: node.metadata };
            const previousGroupId = node.metadata?.groupId;
            Object.assign(node, operation.patch || {});
            if (operation.metadata && typeof operation.metadata === "object" && !Array.isArray(operation.metadata)) node.metadata = { ...((node.metadata || {}) as Record<string, unknown>), ...(operation.metadata as Record<string, unknown>) } as CanvasNodeData["metadata"];
            if (Array.isArray(operation.metadataDelete)) {
                const metadata = { ...((node.metadata || {}) as Record<string, unknown>) };
                for (const key of operation.metadataDelete.map(String)) delete metadata[key];
                node.metadata = metadata as CanvasNodeData["metadata"];
            }
            for (const update of characterReferenceUpdates(previousNode, node, nodes)) {
                nodes = nodes.map((target) => target.id === update.id ? { ...target, metadata: { ...target.metadata, ...update.metadata } } : target);
            }
            // 成员位置/尺寸的显式回放（含撤销、重做）必须保持原值；只有归属变化才自动整理槽位。
            if (previousGroupId !== node.metadata?.groupId) nodes = syncOrderedGroupMembership(nodes, node.id, previousGroupId);
        } else if (type === "delete_node") {
            const ids = new Set((Array.isArray(operation.ids) ? operation.ids : [operation.id]).filter(Boolean).map(String));
            for (let index = nodes.length - 1; index >= 0; index--) if (ids.has(nodes[index].id)) nodes.splice(index, 1);
            for (let index = connections.length - 1; index >= 0; index--) if (ids.has(connections[index].fromNodeId) || ids.has(connections[index].toNodeId)) connections.splice(index, 1);
        } else if (type === "delete_connections") {
            if (operation.all) connections.splice(0, connections.length);
            else {
                const ids = new Set((Array.isArray(operation.ids) ? operation.ids : [operation.id]).filter(Boolean).map(String));
                for (let index = connections.length - 1; index >= 0; index--) if (ids.has(connections[index].id)) connections.splice(index, 1);
            }
        } else if (type === "connect_nodes") {
            const id = String(operation.id || "");
            if (id && !connections.some((connection) => connection.id === id)) connections.push({ id, fromNodeId: String(operation.fromNodeId || ""), toNodeId: String(operation.toNodeId || ""), ...(operation.role ? { role: String(operation.role) } : {}), ...(operation.order === undefined ? {} : { order: Number(operation.order) }) });
        } else if (type === "update_h3_segment" || type === "add_h3_segment" || type === "delete_h3_segment" || type === "replace_h3_segments" || type === "move_h3_segment") {
            const node = nodes.find((item) => item.id === String(operation.nodeId || ""));
            if (!node) continue;
            const metadata = { ...((node.metadata || {}) as Record<string, unknown>) };
            const segments = Array.isArray(metadata.segments) ? metadata.segments.map((segment) => ({ ...segment })) as Array<Record<string, unknown>> : [];
            if (type === "replace_h3_segments") {
                const incoming = Array.isArray(operation.segments) ? operation.segments as Array<Record<string, unknown>> : [];
                const previousById = new Map(segments.map((segment) => [String(segment.id || ""), segment]));
                metadata.segments = incoming.map((segment) => ({ ...(previousById.get(String(segment.id || "")) || {}), ...segment }));
            }
            else if (type === "add_h3_segment" && operation.segment && typeof operation.segment === "object") {
                const incoming = { ...(operation.segment as Record<string, unknown>) };
                if (segments.some((segment) => String(segment.id || "") === String(incoming.id || ""))) {
                    metadata.segments = segments;
                    node.metadata = metadata as CanvasNodeData["metadata"];
                    continue;
                }
                const beforeId = String(operation.beforeSegmentId || "");
                const afterId = String(operation.afterSegmentId || "");
                const index = beforeId ? segments.findIndex((segment) => String(segment.id || "") === beforeId)
                    : afterId ? segments.findIndex((segment) => String(segment.id || "") === afterId) + 1
                        : segments.length;
                segments.splice(index < 0 ? segments.length : index, 0, incoming);
                metadata.segments = segments;
            }
            else if (type === "move_h3_segment") {
                const from = segments.findIndex((segment) => String(segment.id) === String(operation.segmentId));
                if (from >= 0) {
                    const [segment] = segments.splice(from, 1);
                    const anchor = String(operation.beforeSegmentId || operation.afterSegmentId || "");
                    const anchorIndex = anchor ? segments.findIndex((item) => String(item.id) === anchor) : segments.length;
                    if (anchorIndex < 0) segments.splice(from, 0, segment);
                    else segments.splice(anchorIndex + (operation.afterSegmentId ? 1 : 0), 0, segment);
                }
                metadata.segments = segments;
            }
            else if (type === "delete_h3_segment") metadata.segments = segments.filter((segment) => String(segment.id || "") !== String(operation.segmentId || ""));
            else if (type === "update_h3_segment") {
                const segment = segments.find((item) => String(item.id || "") === String(operation.segmentId || ""));
                if (segment) {
                    Object.assign(segment, operation.patch || {});
                    for (const key of Array.isArray(operation.patchDelete) ? operation.patchDelete.map(String) : []) delete segment[key];
                }
                metadata.segments = segments;
            }
            node.metadata = metadata as CanvasNodeData["metadata"];
        } else if (type === "update_project" && operation.patch && typeof operation.patch === "object") {
            Object.assign(projectPatch, operation.patch);
        } else if (type === "upsert_reference_asset" && operation.asset && typeof operation.asset === "object") {
            const catalog = Array.isArray(projectPatch.referenceCatalog) ? [...projectPatch.referenceCatalog as Array<Record<string, unknown>>] : [...(base.referenceCatalog || [])];
            const asset = operation.asset as Record<string, unknown>;
            const index = catalog.findIndex((item) => String(item.id || "") === String(asset.id || ""));
            if (index >= 0) catalog[index] = { ...catalog[index], ...asset };
            else catalog.push({ ...asset });
            projectPatch.referenceCatalog = catalog;
        } else if (type === "delete_reference_asset") {
            projectPatch.referenceCatalog = (Array.isArray(projectPatch.referenceCatalog) ? projectPatch.referenceCatalog as Array<Record<string, unknown>> : base.referenceCatalog || []).filter((item) => String(item.id || "") !== String(operation.assetId || ""));
        }
    }
    const timelineNodeIds = new Set(operations.map((operation) => String(operation.nodeId || operation.id || "")));
    for (const node of nodes) {
        if (!timelineNodeIds.has(node.id) || !isH3NodeType(String(node.type))) continue;
        const metadata = node.metadata as Record<string, unknown> | undefined;
        if (Array.isArray(metadata?.segments)) node.metadata = { ...metadata, segments: compactH3SegmentStarts(metadata.segments, metadata.duration) } as CanvasNodeData["metadata"];
    }
    return { ...base, ...projectPatch, nodes, connections, revision, ...(updatedAt ? { updatedAt } : {}) } as T;
}
