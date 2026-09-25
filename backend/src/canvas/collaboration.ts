import { createHash } from "node:crypto";
import type { CanvasOperation, CanvasOperationResult } from "./project-ops.js";

export type CanvasCommandContext = {
    /** 仅限进程内任务执行器传入；HTTP/MCP 入参不得透传此权限。 */
    runtimeWrite?: boolean;
    operationId?: string;
    source?: Record<string, unknown>;
    /** 与旧 expectedRevision 的整图 CAS 分离：新协议按写入字段检查并发。 */
    baseRevision?: number;
};

export type CanvasCommit = {
    projectId: string;
    operationId: string;
    baseRevision: number;
    revision: number;
    operations: CanvasOperation[];
    operationResults: CanvasOperationResult[];
    source: Record<string, unknown>;
    updatedAt: string;
};

export function commandFingerprint(value: unknown): string {
    const canonical = (item: unknown): unknown => {
        if (Array.isArray(item)) return item.map(canonical);
        if (!item || typeof item !== "object") return item;
        return Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]));
    };
    return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function collaborationError(code: string, message: string) {
    return Object.assign(new Error(message), { code });
}

/** IDs/字段各自编码，避免带点或斜线的 ID 误命中其他实体。 */
function paths(operation: CanvasOperation): string[][] {
    const node = ["nodes", String(operation.id || operation.nodeId || "")];
    const fields = (base: string[], value: unknown, deleted: unknown = []) => [
        ...Object.keys(value && typeof value === "object" ? value : {}),
        ...(Array.isArray(deleted) ? deleted.map(String) : []),
    ].map((field) => [...base, field]);
    switch (operation.type) {
        case "text_suggestion": return [];
        case "update_node": return [...fields(node, operation.patch), ...fields([...node, "metadata"], operation.metadata, operation.metadataDelete)];
        case "update_h3_segment": return fields([...node, "metadata", "segments", String(operation.segmentId)], operation.patch, operation.patchDelete);
        case "restore_h3_output": return [[...node, "metadata", "segments", String(operation.segmentId)]];
        case "add_h3_segment": return [[...node, "metadata", "segments", String((operation.segment as Record<string, unknown>)?.id)]];
        case "delete_h3_segment": return [[...node, "metadata", "segments", String(operation.segmentId)]];
        case "replace_h3_segments": return [[...node, "metadata", "segments"]];
        case "add_node": return [node];
        case "delete_node": return (Array.isArray(operation.ids) ? operation.ids : [operation.id]).map((id) => ["nodes", String(id)]);
        case "update_project": return fields(["project"], operation.patch);
        case "connect_nodes": return [["connections", String(operation.id || `${operation.fromNodeId}:${operation.toNodeId}:${operation.role || ""}`)]];
        case "delete_connections": return operation.all ? [["connections"]] : (Array.isArray(operation.ids) ? operation.ids : [operation.id]).map((id) => ["connections", String(id)]);
        case "upsert_reference_asset": return [["references", String((operation.asset as Record<string, unknown>)?.id)]];
        case "delete_reference_asset": return [["references", String(operation.assetId)]];
        default: return [["exclusive"]];
    }
}

export function concurrentCommandConflicts(incoming: CanvasOperation[], committed: CanvasOperation[]): string[] {
    const remote = committed.flatMap(paths);
    return incoming.flatMap((operation) => {
        if (["text_update", "text_replace", "save_text_suggestion", "resolve_text_suggestion"].includes(operation.type)) return [];
        // 删除是幂等命令；不因他人曾修改目标而拒绝删除。
        if (["delete_node", "delete_connections", "delete_h3_segment", "delete_reference_asset"].includes(operation.type)) return [];
        return paths(operation).filter((path) => remote.some((other) => {
            if (path[0] === "exclusive" || other[0] === "exclusive") return true;
            const matches = path.slice(0, Math.min(path.length, other.length)).every((part, index) => part === other[index]);
            // 布局与布局按提交顺序处理；删除/替换整个节点仍然冲突。
            const layout = path.length === 3 && other.length === 3 && ["position", "width", "height"].includes(path[2]);
            return matches && !layout;
        })).map((path) => path.join("/"));
    });
}
