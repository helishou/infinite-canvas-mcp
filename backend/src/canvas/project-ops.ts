import crypto from "node:crypto";
import { referenceBindingsOf } from "@basketikun/canvas-agent/reference-contract";

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
    insertedSegmentIndex?: number;
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

export function applyCanvasProjectOperations(project: Record<string, unknown>, operations: CanvasOperation[], options: { committedReplay?: boolean } = {}) {
    const nodes = nodesOf(project);
    const connections = connectionsOf(project);
    const results: CanvasOperationResult[] = [];
    const previousH3Segments = new Map<string, Map<string, Record<string, unknown>>>();
    for (const operation of operations) {
        const touchesReferences = operation.type === "update_h3_segment" && Object.hasOwn(recordOf(operation.patch), "referenceBindings")
            || ["add_h3_segment", "replace_h3_segments"].includes(operation.type);
        const nodeId = operation.type === "update_node" && Object.hasOwn(recordOf(operation.metadata), "segments")
            ? String(operation.id || "")
            : touchesReferences ? String(operation.nodeId || "") : "";
        if (!nodeId || previousH3Segments.has(nodeId)) continue;
        const node = nodes.find((item) => String(item.id) === nodeId);
        if (isH3CanvasNode(node)) previousH3Segments.set(nodeId, new Map(segmentsOf(node!).map((segment) => [String(segment.id || ""), segment])));
    }

    for (const operation of operations) {
        const result: CanvasOperationResult = { type: operation.type, ok: true };
        if (!operation.type) throw new Error("画布操作缺少 type");

        if (operation.type === "text_suggestion") {
            // 候选存在独立表；日志重放只推进 revision，不污染画布节点快照。
        } else if (operation.type === "add_node") {
            const id = String(operation.id || `${String(operation.nodeType || "node")}-${crypto.randomUUID()}`);
            operation.id = id;
            if (nodes.some((node) => String(node.id) === id)) throw new Error(`节点已存在：${id}`);
            const width = Number(operation.width || 320);
            const height = Number(operation.height || 240);
            const hasExplicitPosition = operation.position !== undefined || operation.x !== undefined || operation.y !== undefined;
            const position = hasExplicitPosition
                ? operation.position || { x: Number(operation.x || 0), y: Number(operation.y || 0) }
                : nextUntakenNodePosition(nodes);
            nodes.push({
                id,
                type: String(operation.nodeType || "text"),
                title: String(operation.title || ""),
                position,
                width,
                height,
                metadata: operation.metadata || {},
            });
            syncOrderedGroupMembership(nodes, id);
            const createdNode = nodes.find((node) => String(node.id) === id);
            if (createdNode?.metadata && orderedGroupForMember(nodes, createdNode)) {
                operation.position = createdNode.position;
                operation.width = Number(createdNode.width);
                operation.height = Number(createdNode.height);
            }
            result.createdNodeIds = [id];
        } else if (operation.type === "update_node") {
            const id = String(operation.id || "");
            const node = nodes.find((item) => String(item.id) === id);
            if (!node) throw new Error(`找不到节点：${id}`);
            const previousGroupId = String(recordOf(node.metadata).groupId || "");
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
            const nextGroupId = String(recordOf(node.metadata).groupId || "");
            if (previousGroupId !== nextGroupId) {
                syncOrderedGroupMembership(nodes, id, previousGroupId || undefined, Boolean((operation.patch as Record<string, unknown> | undefined)?.position));
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
            const beforeSegmentId = String(operation.beforeSegmentId || "").trim();
            const afterSegmentId = String(operation.afterSegmentId || "").trim();
            if (beforeSegmentId && afterSegmentId) {
                throw new Error("add_h3_segment 不能同时指定 beforeSegmentId 和 afterSegmentId");
            }
            let insertIndex = segments.length;
            if (beforeSegmentId) {
                insertIndex = findSegmentIndex(segments, beforeSegmentId);
                if (insertIndex < 0) throw new Error(`beforeSegmentId 不存在：${beforeSegmentId}`);
            } else if (afterSegmentId) {
                const afterIndex = findSegmentIndex(segments, afterSegmentId);
                if (afterIndex < 0) throw new Error(`afterSegmentId 不存在：${afterSegmentId}`);
                insertIndex = afterIndex + 1;
            }
            segments.splice(insertIndex, 0, incoming);
            const metadata = recordOf(node.metadata);
            metadata.segments = segments;
            node.metadata = metadata;
            result.createdSegmentIds = [String(incoming.id)];
            result.insertedSegmentIndex = insertIndex;
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
            const previousById = new Map(previousSegments.map((segment) => [String(segment.id || ""), segment]));
            // replace_h3_segments 替换段数组的顺序和成员；同 ID 段按字段合并，省略字段继承旧值，
            // 只有调用方明确传入字段（例如 []）时才覆盖旧值。
            metadata.segments = incoming.map((segment) => ({ ...(previousById.get(String(segment.id || "")) || {}), ...segment }));
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
        } else if (operation.type === "move_h3_segment") {
            const nodeId = String(operation.nodeId || "");
            const segmentId = String(operation.segmentId || "");
            const beforeSegmentId = String(operation.beforeSegmentId || "").trim();
            const afterSegmentId = String(operation.afterSegmentId || "").trim();
            if (!nodeId) throw new Error("move_h3_segment 缺少 nodeId");
            if (!segmentId) throw new Error("move_h3_segment 缺少 segmentId");
            if (beforeSegmentId && afterSegmentId) throw new Error("move_h3_segment 不能同时指定 beforeSegmentId 和 afterSegmentId");
            if (segmentId === beforeSegmentId || segmentId === afterSegmentId) throw new Error("不能将 Clip 移动到自身相邻位置");
            const node = nodes.find((item) => String(item.id) === nodeId);
            if (!node) throw new Error(`找不到节点：${nodeId}`);
            if (!isH3CanvasNode(node)) throw new Error(`节点 ${nodeId} 不是 H3 节点，不能使用 move_h3_segment`);
            const segments = segmentsOf(node);
            const fromIndex = findSegmentIndex(segments, segmentId);
            if (fromIndex < 0) throw new Error(`节点 ${nodeId} 上找不到 segment ${segmentId}`);
            const [segment] = segments.splice(fromIndex, 1);
            let toIndex = segments.length;
            if (beforeSegmentId) {
                toIndex = findSegmentIndex(segments, beforeSegmentId);
                if (toIndex < 0) throw new Error(`beforeSegmentId 不存在：${beforeSegmentId}`);
            } else if (afterSegmentId) {
                const afterIndex = findSegmentIndex(segments, afterSegmentId);
                if (afterIndex < 0) throw new Error(`afterSegmentId 不存在：${afterSegmentId}`);
                toIndex = afterIndex + 1;
            }
            if (toIndex === fromIndex) {
                result.skipped = true;
            } else {
                segments.splice(toIndex, 0, segment);
                const metadata = recordOf(node.metadata);
                metadata.segments = segments;
                node.metadata = metadata;
                result.updatedSegmentIds = [segmentId];
                result.insertedSegmentIndex = toIndex;
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

    // 绑定是用户意图；仅在素材第一次进入项目时登记媒体，不把 Clip 职责反写到共享资产。
    const referenceNodes = new Set<string>();
    for (const operation of operations) {
        if (operation.type === "update_h3_segment" && Object.hasOwn(recordOf(operation.patch), "referenceBindings")) referenceNodes.add(String(operation.nodeId || ""));
        if (["add_h3_segment", "replace_h3_segments"].includes(operation.type)) referenceNodes.add(String(operation.nodeId || ""));
        if (operation.type === "add_node") referenceNodes.add(String(operation.id || ""));
        if (operation.type === "update_node" && Object.hasOwn(recordOf(operation.metadata), "segments")) referenceNodes.add(String(operation.id || ""));
    }
    for (const nodeId of referenceNodes) {
        const node = nodes.find((item) => String(item.id) === nodeId);
        if (isH3CanvasNode(node)) {
            canonicalizeH3References(node!, undefined, previousH3Segments.get(nodeId), options.committedReplay === true);
            registerH3ReferenceAssets(project, node!);
        }
    }
    project.nodes = nodes;
    project.connections = connections;
    return results;
}

function legacyMirrorsBindings(refs: Array<Record<string, unknown>>, bindings: Array<Record<string, unknown>>) {
    if (refs.length !== bindings.length) return false;
    const remaining = [...bindings];
    for (const ref of refs) {
        const refId = String(ref.bindingId || "");
        const refMedia = [ref.storageKey, ref.url].filter(Boolean).map(String);
        const match = remaining.findIndex((binding) => {
            if (refId && refId !== String(binding.id || "")) return false;
            const bindingMedia = [binding.storageKey, binding.url].filter(Boolean).map(String);
            return refMedia.some((media) => bindingMedia.includes(media)) || Boolean(refId && !refMedia.length && !bindingMedia.length);
        });
        if (match < 0) return false;
        remaining.splice(match, 1);
    }
    return true;
}

export function canonicalizeH3References(node: Record<string, unknown>, archiveLegacy?: (segment: Record<string, unknown>, index: number) => void, previousSegments?: Map<string, Record<string, unknown>>, committedReplay = false) {
    const metadata = recordOf(node.metadata);
    const segments = segmentsOf(node);
    for (const [index, segment] of segments.entries()) {
        const buckets = recordOf(segment.refs);
        const legacyRefs = Array.isArray(segment.refItems) && segment.refItems.length
            ? segment.refItems.map(recordOf)
            : ["image", "video", "audio"].flatMap((type) => Array.isArray(buckets[type]) ? (buckets[type] as unknown[]).map(recordOf) : buckets[type] ? [recordOf(buckets[type])] : []);
        const hasBindings = Array.isArray(segment.referenceBindings);
        const currentBindings = hasBindings ? segment.referenceBindings as Array<Record<string, unknown>> : [];
        const previous = previousSegments?.get(String(segment.id || ""));
        if (legacyRefs.length) archiveLegacy?.(segment, index);
        if (hasBindings && legacyRefs.length && !archiveLegacy && !committedReplay && (currentBindings.length || previous)) {
            const previousBindings = Array.isArray(previous?.referenceBindings) ? previous.referenceBindings.map(recordOf) : [];
            const previousBuckets = recordOf(previous?.refs);
            const previousHadLegacy = Boolean((Array.isArray(previous?.refItems) && previous.refItems.length)
                || ["image", "video", "audio"].some((type) => Array.isArray(previousBuckets[type]) ? previousBuckets[type].length : previousBuckets[type]));
            const bucketRefs = ["image", "video", "audio"].flatMap((type) => Array.isArray(buckets[type]) ? (buckets[type] as unknown[]).map(recordOf) : buckets[type] ? [recordOf(buckets[type])] : []);
            const mirrorsPrevious = previous && !previousHadLegacy && previousBindings.length > 0
                && legacyMirrorsBindings(legacyRefs, previousBindings)
                && (!bucketRefs.length || legacyMirrorsBindings(bucketRefs, previousBindings));
            const mirrorsCurrent = currentBindings.length > 0 && legacyMirrorsBindings(legacyRefs, currentBindings)
                && (!bucketRefs.length || legacyMirrorsBindings(bucketRefs, currentBindings));
            const unchangedExisting = previousHadLegacy && JSON.stringify(previousBindings) === JSON.stringify(currentBindings)
                && currentBindings.length === legacyRefs.length
                && legacyRefs.every((ref) => !ref.bindingId || currentBindings.some((binding) => String(binding.id || "") === String(ref.bindingId)));
            // 旧字段是绑定的历史镜像，不是一次独立意图。只有在「上一版本来就是干净的绑定」
            // 时，本批夹带的旧字段才必然是过期残留（关掉服装/声线后前端仍会重发它）：
            // 此时没有绑定被丢弃，按当前绑定放行。上一版仍带旧字段说明真在迁移或扩充，
            // 继续按原有规则校验。
            const legacyIsStaleSubset = !previousHadLegacy
                && legacyRefs.every((ref) => !ref.bindingId || currentBindings.some((binding) => String(binding.id || "") === String(ref.bindingId)))
                && bucketRefs.every((ref) => !ref.bindingId || currentBindings.some((binding) => String(binding.id || "") === String(ref.bindingId)));
            if (!mirrorsPrevious && !mirrorsCurrent && !unchangedExisting && !legacyIsStaleSubset) {
                throw new Error(`H3 Clip ${String(segment.id || "")} 的绑定与旧参考不一致，拒绝丢弃原数据`);
            }
        }
        if (!hasBindings || !currentBindings.length && (archiveLegacy || !previous || committedReplay)) {
            const legacy = { ...segment };
            delete legacy.referenceBindings;
            const converted = referenceBindingsOf(legacy).bindings;
            if (legacyRefs.length && converted.length !== legacyRefs.length) throw new Error(`H3 Clip ${String(segment.id || "")} 的旧参考无法完整迁移，原数据已保留`);
            if (converted.length) segment.referenceBindings = converted;
        }
        delete segment.refItems;
        delete segment.refs;
    }
    metadata.segments = segments;
    metadata.h3DataVersion = 2;
    node.metadata = metadata;
}

export function registerH3ReferenceAssets(project: Record<string, unknown>, node: Record<string, unknown>) {
    const catalog = Array.isArray(project.referenceCatalog) ? project.referenceCatalog as Array<Record<string, unknown>> : [];
    const byId = new Map(catalog.map((asset) => [String(asset.id || ""), asset]));
    const conflicts = (asset: Record<string, unknown>, binding: Record<string, unknown>) => {
        const assetSource = String(asset.sourceNodeId || "");
        const bindingSource = String(binding.sourceNodeId || "");
        if (assetSource && !bindingSource) return false; // 旧绑定可只有媒体快照；项目资产仍保有动态来源。
        if (assetSource && bindingSource) return assetSource !== bindingSource;
        const assetMedia = String(asset.storageKey || asset.url || "");
        const bindingMedia = String(binding.storageKey || binding.url || "");
        return Boolean(assetMedia && bindingMedia && assetMedia !== bindingMedia);
    };
    const segments = segmentsOf(node);
    let changed = false;
    for (const segment of segments) {
        const bindings = Array.isArray(segment.referenceBindings) ? segment.referenceBindings as Array<Record<string, unknown>> : [];
        for (const binding of bindings) {
            const originalId = String(binding.assetId || "");
            if (!originalId) continue;
            const identity = String(binding.sourceNodeId ? `node:${binding.sourceNodeId}` : binding.storageKey || binding.url || "");
            let id = originalId;
            const existing = byId.get(id);
            if (existing && conflicts(existing, binding)) {
                id = `${originalId}-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 10)}`;
                binding.assetId = id;
                changed = true;
            }
            const resolved = byId.get(id);
            if (resolved) {
                if (conflicts(resolved, binding)) throw new Error(`参考资产 ID 冲突：${id}`);
                for (const field of ["storageKey", "url", "mimeType", "sourceNodeId", "mediaType"]) {
                    if (!resolved[field] && binding[field]) { resolved[field] = binding[field]; changed = true; }
                }
                continue;
            }
            const asset = {
                id,
                label: String(binding.label || id),
                mediaType: String(binding.mediaType || "image"),
                role: "other",
                tags: [],
                ...(binding.url ? { url: binding.url } : {}),
                ...(binding.storageKey ? { storageKey: binding.storageKey } : {}),
                ...(binding.mimeType ? { mimeType: binding.mimeType } : {}),
                ...(binding.sourceNodeId ? { sourceNodeId: binding.sourceNodeId } : {}),
            };
            catalog.push(asset);
            byId.set(id, asset);
            changed = true;
        }
    }
    if (changed) {
        project.referenceCatalog = catalog;
        recordOf(node.metadata).segments = segments;
    }
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

function orderedGroupForMember(nodes: Array<Record<string, unknown>>, member: Record<string, unknown>) {
    const groupId = String(recordOf(member.metadata).groupId || "");
    return nodes.find((node) => String(node.id) === groupId && recordOf(node.metadata).orderedGroup === true);
}

/** MCP/协作新增或转入节点时同步有序组槽位；已有槽位顺序和调用方明确给出的位置优先。 */
function syncOrderedGroupMembership(nodes: Array<Record<string, unknown>>, nodeId: string, previousGroupId?: string, preservePosition = false) {
    const member = nodes.find((node) => String(node.id) === nodeId);
    if (!member || String(member.type || "") === "group") return;
    const nextGroupId = String(recordOf(member.metadata).groupId || "");
    const groupIds = new Set([previousGroupId || "", nextGroupId].filter(Boolean));
    groupIds.forEach((groupId) => {
        const group = nodes.find((node) => String(node.id) === groupId && recordOf(node.metadata).orderedGroup === true);
        if (!group) return;
        const metadata = recordOf(group.metadata);
        const knownIds = new Set(nodes.filter((node) => String(node.id) !== String(group.id) && String(node.type || "") !== "group").map((node) => String(node.id)));
        const legacyMemberIds = nodes.filter((node) => String(recordOf(node.metadata).groupId || "") === groupId && knownIds.has(String(node.id))).map((node) => String(node.id));
        const rawSlots = Array.isArray(metadata.groupSlots) ? metadata.groupSlots.map(String) : [];
        const slots = rawSlots.length ? rawSlots.filter((id, index, all) => knownIds.has(id) && all.indexOf(id) === index) : legacyMemberIds;
        const nextSlots = nextGroupId === groupId ? (slots.includes(nodeId) ? slots : [...slots, nodeId]) : slots.filter((id) => id !== nodeId);
        // 明确的槽位顺序已随本批操作提交时，成员归属更新不能再重排整组并覆盖显式布局。
        if (rawSlots.length && nextSlots.length === rawSlots.length && nextSlots.every((id, index) => id === rawSlots[index])) return;
        metadata.groupSlots = nextSlots;
        group.metadata = metadata;
        if (!nextSlots.length) return;

        const columns = Math.max(1, Math.min(12, Math.round(Number(metadata.orderedGroupColumns)) || 4));
        const displayCount = nextSlots.length % columns === 0 ? nextSlots.length + columns : nextSlots.length + (columns - nextSlots.length % columns);
        const groupPosition = recordOf(group.position);
        const groupWidth = Number(group.width || 0);
        const groupHeight = Number(group.height || 0);
        const gap = 14;
        const padding = { left: 24, right: 24, top: 52, bottom: 24 };
        const rows = Math.ceil(Math.max(displayCount, 1) / columns);
        const availableWidth = Math.max(0, groupWidth - padding.left - padding.right);
        const availableHeight = Math.max(0, groupHeight - padding.top - padding.bottom);
        const gapX = columns > 1 ? Math.min(gap, Math.max(0, (availableWidth - columns) / (columns - 1))) : 0;
        const gapY = rows > 1 ? Math.min(gap, Math.max(0, (availableHeight - rows) / (rows - 1))) : 0;
        const cellWidth = Math.max(0, (availableWidth - gapX * (columns - 1)) / columns);
        const cellHeight = Math.max(0, (availableHeight - gapY * (rows - 1)) / rows);
        nextSlots.forEach((memberId, slotIndex) => {
            if (preservePosition && memberId === nodeId) return;
            const slotMember = nodes.find((node) => String(node.id) === memberId);
            if (!slotMember) return;
            const originalWidth = Number(slotMember.width || 0);
            const originalHeight = Number(slotMember.height || 0);
            const scale = Math.min(1, cellWidth / Math.max(originalWidth, 1), cellHeight / Math.max(originalHeight, 1));
            const width = originalWidth * scale;
            const height = originalHeight * scale;
            slotMember.position = {
                x: Number(groupPosition.x || 0) + padding.left + (slotIndex % columns) * (cellWidth + gapX) + (cellWidth - width) / 2,
                y: Number(groupPosition.y || 0) + padding.top + Math.floor(slotIndex / columns) * (cellHeight + gapY) + (cellHeight - height) / 2,
            };
            slotMember.width = width;
            slotMember.height = height;
        });
    });
}

function sameValue(left: unknown, right: unknown) {
    if (Object.is(left, right)) return true;
    if ((left && typeof left === "object") || (right && typeof right === "object")) {
        try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
    }
    return String(left ?? "") === String(right ?? "");
}

/**
 * Raw canvas_apply_ops callers may omit position. Never put several such nodes
 * at (0,0): the operation list is applied sequentially, so a rightward slot
 * chosen from the current nodes also spaces nodes created in the same batch.
 */
function nextUntakenNodePosition(nodes: Array<Record<string, unknown>>) {
    const gap = 96;
    const validNodes = nodes.filter((node) => node.position && typeof node.position === "object");
    if (!validNodes.length) return { x: 0, y: 0 };
    const right = Math.max(...validNodes.map((node) => {
        const position = recordOf(node.position);
        return Number(position.x || 0) + Number(node.width || 320);
    }));
    return { x: right + gap, y: 0 };
}
