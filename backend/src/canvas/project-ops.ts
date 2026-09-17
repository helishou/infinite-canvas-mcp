import crypto from "node:crypto";

export type CanvasOperation = Record<string, unknown> & { type: string };

export type CanvasOperationResult = {
    type: string;
    ok: boolean;
    createdNodeIds?: string[];
    deletedNodeIds?: string[];
    createdConnectionIds?: string[];
    deletedConnectionIds?: string[];
    deletedCount?: number;
    createdSegmentIds?: string[];
    updatedSegmentIds?: string[];
    deletedSegmentIds?: string[];
    skipped?: boolean;
};

// H3 节点类型前缀（与前端 isH3Node / node-definition.ts 保持一致）
const H3_NODE_TYPE_PATTERN = /^minimax|^smart-minimax/;

/** 识别 H3 节点（含历史 smart-minimax 变体）。 */
export function isH3CanvasNode(node: Record<string, unknown> | null | undefined): boolean {
    if (!node) return false;
    return H3_NODE_TYPE_PATTERN.test(String(node.type || ""));
}

/** 从节点 metadata 中拿到 segments 数组（不修改原对象）。 */
function segmentsOf(node: Record<string, unknown>): Array<Record<string, unknown>> {
    const metadata = recordOf(node.metadata);
    const segments = metadata.segments;
    return Array.isArray(segments) ? segments.map((item) => (item && typeof item === "object" ? { ...(item as Record<string, unknown>) } : {})) : [];
}

/** 在 segments 中按 id 查找；找不到返回 -1。 */
function findSegmentIndex(segments: Array<Record<string, unknown>>, segmentId: string): number {
    return segments.findIndex((segment) => String(segment.id || "") === segmentId);
}

/**
 * 校验 update_node.metadata.segments 是否为「完整替换」：
 * 长度相同 + id 集合相同。任何不满足都直接抛错，强制所有写路径要么走 update_h3_segment 等细粒度 op，要么用 replace_h3_segments 显式做完整替换。
 *
 * 注意：节点首次构造 segments 必须走 add_node 携带完整 metadata，不能先 add_node(metadata:{}) 再 update_node.metadata.segments。
 */
function assertFullSegmentsReplacement(node: Record<string, unknown>, incomingSegments: Array<Record<string, unknown>>): void {
    const previousSegments = segmentsOf(node);
    const previousIds = new Set(previousSegments.map((segment) => String(segment.id || "")));
    const incomingIds = new Set(incomingSegments.map((segment) => String(segment.id || "")));
    if (previousIds.size !== incomingIds.size) {
        throw new Error(
            `metadata.segments 必须为完整数组（id 集合不同：旧 ${previousIds.size} 项 vs 新 ${incomingIds.size} 项）；请改用 update_h3_segment / add_h3_segment / delete_h3_segment 细粒度 op`,
        );
    }
    for (const id of previousIds) {
        if (!incomingIds.has(id)) {
            throw new Error(
                `metadata.segments 必须为完整数组（id ${id} 缺失）；请改用 update_h3_segment / add_h3_segment / delete_h3_segment 细粒度 op`,
            );
        }
    }
}

export function applyCanvasProjectOperations(project: Record<string, unknown>, operations: CanvasOperation[]) {
    const nodes = nodesOf(project);
    const connections = connectionsOf(project);
    const results: CanvasOperationResult[] = [];

    for (const operation of operations) {
        const result: CanvasOperationResult = { type: operation.type, ok: true };
        if (!operation.type) throw new Error("画布操作缺少 type");

        if (operation.type === "text_suggestion") {
            // 候选存在独立表；日志重放只推进 revision，不污染画布节点快照。
        } else if (operation.type === "add_node") {
            const id = String(operation.id || `${String(operation.nodeType || "node")}-${crypto.randomUUID()}`);
            operation.id = id;
            if (nodes.some((node) => String(node.id) === id)) throw new Error(`节点已存在：${id}`);
            nodes.push({
                id,
                type: String(operation.nodeType || "text"),
                title: String(operation.title || ""),
                position: operation.position || { x: Number(operation.x || 0), y: Number(operation.y || 0) },
                width: Number(operation.width || 320),
                height: Number(operation.height || 240),
                metadata: operation.metadata || {},
            });
            result.createdNodeIds = [id];
        } else if (operation.type === "update_node") {
            const id = String(operation.id || "");
            const node = nodes.find((item) => String(item.id) === id);
            if (!node) throw new Error(`找不到节点：${id}`);
            Object.assign(node, operation.patch || {});
            if (operation.metadata && typeof operation.metadata === "object" && !Array.isArray(operation.metadata)) {
                const metadata = recordOf(node.metadata);
                let metadataPatch = operation.metadata as Record<string, unknown>;
                // metadata.segments 在 update_node 中必须是「完整替换」（同长同 id 集合）。
                // 部分替换会冲突 MCP / 任务回写等并发写路径，强制改用 update_h3_segment 等细粒度 op。
                if (Object.prototype.hasOwnProperty.call(metadataPatch, "segments")) {
                    if (!isH3CanvasNode(node)) {
                        throw new Error("只有 H3 节点的 metadata.segments 允许在 update_node 中出现");
                    }
                    const incomingSegments = Array.isArray(metadataPatch.segments) ? metadataPatch.segments as Array<Record<string, unknown>> : [];
                    assertFullSegmentsReplacement(node, incomingSegments);
                    metadataPatch = { ...metadataPatch, segments: incomingSegments };
                }
                node.metadata = { ...metadata, ...metadataPatch };
            }
            if (Array.isArray(operation.metadataDelete)) {
                const metadata = recordOf(node.metadata);
                for (const key of operation.metadataDelete.map(String)) delete metadata[key];
                node.metadata = metadata;
            }
        } else if (operation.type === "update_h3_segment") {
            const nodeId = String(operation.nodeId || "");
            const segmentId = String(operation.segmentId || "");
            const patch = recordOf(operation.patch);
            if (!nodeId) throw new Error("update_h3_segment 缺少 nodeId");
            if (!segmentId) throw new Error("update_h3_segment 缺少 segmentId");
            const node = nodes.find((item) => String(item.id) === nodeId);
            if (!node) throw new Error(`找不到节点：${nodeId}`);
            if (!isH3CanvasNode(node)) throw new Error(`节点 ${nodeId} 不是 H3 节点，不能使用 update_h3_segment`);
            const segments = segmentsOf(node);
            const index = findSegmentIndex(segments, segmentId);
            if (index < 0) throw new Error(`节点 ${nodeId} 上找不到 segment ${segmentId}`);
            // CAS：expectedFields 中的每一个字段都必须与当前值匹配，否则抛错（用于任务回写防止被新任务接管后被覆盖）。
            if (operation.expectedFields && typeof operation.expectedFields === "object") {
                for (const [field, expected] of Object.entries(operation.expectedFields as Record<string, unknown>)) {
                    if (!sameValue(segments[index][field], expected)) {
                        throw new Error(`update_h3_segment CAS 失败：${nodeId}/${segmentId}.${field} 已不是期望值`);
                    }
                }
            }
            // id 不可改；其他字段 Object.assign 直接覆盖（patch 已是字段级差异，不传相同值进来）
            delete (patch as Record<string, unknown>).id;
            const nextSegment: Record<string, unknown> = { ...segments[index], ...patch };
            if (Array.isArray(operation.patchDelete)) {
                for (const key of (operation.patchDelete as unknown[]).map(String)) delete nextSegment[key];
            }
            segments[index] = nextSegment;
            const metadata = recordOf(node.metadata);
            metadata.segments = segments;
            node.metadata = metadata;
            result.updatedSegmentIds = [segmentId];
        } else if (operation.type === "add_h3_segment") {
            const nodeId = String(operation.nodeId || "");
            const incoming = recordOf(operation.segment);
            if (!nodeId) throw new Error("add_h3_segment 缺少 nodeId");
            if (!incoming.id) throw new Error("add_h3_segment.segment.id 必填");
            const node = nodes.find((item) => String(item.id) === nodeId);
            if (!node) throw new Error(`找不到节点：${nodeId}`);
            if (!isH3CanvasNode(node)) throw new Error(`节点 ${nodeId} 不是 H3 节点，不能使用 add_h3_segment`);
            const segments = segmentsOf(node);
            if (findSegmentIndex(segments, String(incoming.id)) >= 0) {
                throw new Error(`segment id ${String(incoming.id)} 已存在`);
            }
            segments.push(incoming);
            const metadata = recordOf(node.metadata);
            metadata.segments = segments;
            node.metadata = metadata;
            result.createdSegmentIds = [String(incoming.id)];
        } else if (operation.type === "replace_h3_segments") {
            // 完全替换 segments（plan 重排等场景）。显式 op 走细粒度通道，绕过 update_node.metadata.segments 的「同 id 集合」严格校验。
            const nodeId = String(operation.nodeId || "");
            const incoming = Array.isArray(operation.segments) ? operation.segments as Array<Record<string, unknown>> : [];
            if (!nodeId) throw new Error("replace_h3_segments 缺少 nodeId");
            const node = nodes.find((item) => String(item.id) === nodeId);
            if (!node) throw new Error(`找不到节点：${nodeId}`);
            if (!isH3CanvasNode(node)) throw new Error(`节点 ${nodeId} 不是 H3 节点，不能使用 replace_h3_segments`);
            const seen = new Set<string>();
            for (const segment of incoming) {
                if (!segment.id) throw new Error("replace_h3_segments.segments[].id 必填");
                const id = String(segment.id);
                if (seen.has(id)) throw new Error(`replace_h3_segments.segments 包含重复 id: ${id}`);
                seen.add(id);
            }
            const previousSegments = segmentsOf(node);
            const previousIds = previousSegments.map((segment) => String(segment.id || ""));
            const incomingIds = incoming.map((segment) => String(segment.id || ""));
            result.deletedSegmentIds = previousIds.filter((id) => !incomingIds.includes(id));
            result.createdSegmentIds = incomingIds.filter((id) => !previousIds.includes(id));
            const metadata = recordOf(node.metadata);
            metadata.segments = incoming.map((segment) => ({ ...segment }));
            node.metadata = metadata;
        } else if (operation.type === "delete_h3_segment") {
            const nodeId = String(operation.nodeId || "");
            const segmentId = String(operation.segmentId || "");
            if (!nodeId) throw new Error("delete_h3_segment 缺少 nodeId");
            if (!segmentId) throw new Error("delete_h3_segment 缺少 segmentId");
            const node = nodes.find((item) => String(item.id) === nodeId);
            if (!node) throw new Error(`找不到节点：${nodeId}`);
            if (!isH3CanvasNode(node)) throw new Error(`节点 ${nodeId} 不是 H3 节点，不能使用 delete_h3_segment`);
            const segments = segmentsOf(node);
            const index = findSegmentIndex(segments, segmentId);
            if (index < 0) {
                result.skipped = true;
            } else {
                segments.splice(index, 1);
                const metadata = recordOf(node.metadata);
                metadata.segments = segments;
                node.metadata = metadata;
                result.deletedSegmentIds = [segmentId];
            }
        } else if (operation.type === "delete_node") {
            const ids = new Set(Array.isArray(operation.ids) ? operation.ids.map(String) : [String(operation.id || "")]);
            if (!ids.size || ids.has("")) throw new Error("delete_node 需要提供 id 或 ids");
            const deletedNodeIds = nodes.filter((node) => ids.has(String(node.id))).map((node) => String(node.id));
            for (let index = nodes.length - 1; index >= 0; index--) if (ids.has(String(nodes[index].id))) nodes.splice(index, 1);
            for (let index = connections.length - 1; index >= 0; index--) {
                if (ids.has(String(connections[index].fromNodeId)) || ids.has(String(connections[index].toNodeId))) connections.splice(index, 1);
            }
            result.deletedNodeIds = deletedNodeIds;
            if (!deletedNodeIds.length) result.skipped = true;
        } else if (operation.type === "delete_connections") {
            const ids = new Set(Array.isArray(operation.ids) ? operation.ids.map(String) : operation.id ? [String(operation.id)] : []);
            if (!operation.all && !ids.size) throw new Error("delete_connections 需要提供 id、ids 或 all=true");
            const deleted = operation.all
                ? connections.splice(0, connections.length)
                : connections.filter((connection) => ids.has(String(connection.id)));
            if (!operation.all) for (let index = connections.length - 1; index >= 0; index--) if (ids.has(String(connections[index].id))) connections.splice(index, 1);
            result.deletedConnectionIds = deleted.map((connection) => String(connection.id));
            result.deletedCount = result.deletedConnectionIds.length;
            if (!result.deletedCount) result.skipped = true;
        } else if (operation.type === "connect_nodes") {
            const fromNodeId = String(operation.fromNodeId || "");
            const toNodeId = String(operation.toNodeId || "");
            if (!nodes.some((node) => String(node.id) === fromNodeId)) throw new Error(`找不到连线起点：${fromNodeId}`);
            if (!nodes.some((node) => String(node.id) === toNodeId)) throw new Error(`找不到连线终点：${toNodeId}`);
            const role = operation.role ? String(operation.role) : "";
            const duplicate = connections.find((connection) => String(connection.fromNodeId) === fromNodeId
                && String(connection.toNodeId) === toNodeId
                && String(connection.role || "") === role);
            if (duplicate) {
                result.skipped = true;
            } else {
                const id = String(operation.id || `connection-${crypto.randomUUID()}`);
                operation.id = id;
                connections.push({ id, fromNodeId, toNodeId, ...(role ? { role } : {}), ...(operation.order !== undefined ? { order: Number(operation.order) } : {}) });
                result.createdConnectionIds = [id];
            }
        } else if (operation.type === "select_nodes") {
            const ids = Array.isArray(operation.ids) ? operation.ids.map(String) : [];
            const missingNodeIds = ids.filter((id) => !nodes.some((node) => String(node.id) === id));
            if (missingNodeIds.length) throw new Error(`找不到节点：${missingNodeIds.join(",")}`);
            project.selectedNodeIds = ids;
        } else if (operation.type === "run_generation") {
            const id = String(operation.nodeId || "");
            if (!nodes.some((node) => String(node.id) === id)) throw new Error(`找不到生成节点：${id}`);
        } else if (operation.type === "upsert_reference_asset") {
            const asset = recordOf(operation.asset);
            const id = String(asset.id || "");
            if (!id) throw new Error("upsert_reference_asset.asset.id 必填");
            const catalog = Array.isArray(project.referenceCatalog) ? project.referenceCatalog as Array<Record<string, unknown>> : [];
            const index = catalog.findIndex((item) => String(item.id || "") === id);
            const next = { ...(index >= 0 ? catalog[index] : {}), ...asset, id };
            if (index >= 0) catalog[index] = next;
            else catalog.push(next);
            project.referenceCatalog = catalog;
        } else if (operation.type === "delete_reference_asset") {
            const id = String(operation.assetId || "");
            if (!id) throw new Error("delete_reference_asset.assetId 必填");
            const catalog = Array.isArray(project.referenceCatalog) ? project.referenceCatalog as Array<Record<string, unknown>> : [];
            const index = catalog.findIndex((item) => String(item.id || "") === id);
            if (index < 0) result.skipped = true;
            else catalog.splice(index, 1);
            project.referenceCatalog = catalog;
        } else if (operation.type === "update_project") {
            const patch = recordOf(operation.patch);
            const allowed = ["title", "chatSessions", "activeChatId", "backgroundMode", "showImageInfo", "globalPrompt"];
            for (const key of allowed) if (key in patch) project[key] = patch[key];
        } else {
            throw new Error(`未知画布操作：${operation.type}`);
        }
        results.push(result);
    }

    project.nodes = nodes;
    project.connections = connections;
    return results;
}

function nodesOf(project: Record<string, unknown>) {
    if (!Array.isArray(project.nodes)) project.nodes = [];
    return project.nodes as Array<Record<string, unknown>>;
}

function connectionsOf(project: Record<string, unknown>) {
    if (!Array.isArray(project.connections)) project.connections = [];
    return project.connections as Array<Record<string, unknown>>;
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sameValue(left: unknown, right: unknown) {
    if (Object.is(left, right)) return true;
    if ((left && typeof left === "object") || (right && typeof right === "object")) {
        try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
    }
    return String(left ?? "") === String(right ?? "");
}
