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
    skipped?: boolean;
};

export function applyCanvasProjectOperations(project: Record<string, unknown>, operations: CanvasOperation[]) {
    const nodes = nodesOf(project);
    const connections = connectionsOf(project);
    const results: CanvasOperationResult[] = [];

    for (const operation of operations) {
        const result: CanvasOperationResult = { type: operation.type, ok: true };
        if (!operation.type) throw new Error("画布操作缺少 type");

        if (operation.type === "add_node") {
            const id = String(operation.id || `${String(operation.nodeType || "node")}-${crypto.randomUUID()}`);
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
                node.metadata = { ...recordOf(node.metadata), ...(operation.metadata as Record<string, unknown>) };
            }
        } else if (operation.type === "delete_node") {
            const ids = new Set(Array.isArray(operation.ids) ? operation.ids.map(String) : [String(operation.id || "")]);
            const deletedNodeIds = nodes.filter((node) => ids.has(String(node.id))).map((node) => String(node.id));
            const missingNodeIds = [...ids].filter((id) => id && !deletedNodeIds.includes(id));
            if (!ids.size || ids.has("") || missingNodeIds.length) throw new Error(`找不到节点：${missingNodeIds.join(",") || ""}`);
            for (let index = nodes.length - 1; index >= 0; index--) if (ids.has(String(nodes[index].id))) nodes.splice(index, 1);
            for (let index = connections.length - 1; index >= 0; index--) {
                if (ids.has(String(connections[index].fromNodeId)) || ids.has(String(connections[index].toNodeId))) connections.splice(index, 1);
            }
            result.deletedNodeIds = deletedNodeIds;
        } else if (operation.type === "delete_connections") {
            const ids = new Set(Array.isArray(operation.ids) ? operation.ids.map(String) : operation.id ? [String(operation.id)] : []);
            if (!operation.all && !ids.size) throw new Error("delete_connections 需要提供 id、ids 或 all=true");
            if (!operation.all) {
                const knownIds = new Set(connections.map((connection) => String(connection.id)));
                const missingConnectionIds = [...ids].filter((id) => !knownIds.has(id));
                if (missingConnectionIds.length) throw new Error(`找不到连线：${missingConnectionIds.join(",")}`);
            }
            const deleted = operation.all
                ? connections.splice(0, connections.length)
                : connections.filter((connection) => ids.has(String(connection.id)));
            if (!operation.all) for (let index = connections.length - 1; index >= 0; index--) if (ids.has(String(connections[index].id))) connections.splice(index, 1);
            result.deletedConnectionIds = deleted.map((connection) => String(connection.id));
            result.deletedCount = result.deletedConnectionIds.length;
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
                connections.push({ id, fromNodeId, toNodeId, ...(role ? { role } : {}), ...(operation.order !== undefined ? { order: Number(operation.order) } : {}) });
                result.createdConnectionIds = [id];
            }
        } else if (operation.type === "select_nodes") {
            const ids = Array.isArray(operation.ids) ? operation.ids.map(String) : [];
            const missingNodeIds = ids.filter((id) => !nodes.some((node) => String(node.id) === id));
            if (missingNodeIds.length) throw new Error(`找不到节点：${missingNodeIds.join(",")}`);
            project.selectedNodeIds = ids;
        } else if (operation.type === "set_viewport") {
            if (!operation.viewport || typeof operation.viewport !== "object") throw new Error("set_viewport 缺少 viewport");
            project.viewport = operation.viewport;
        } else if (operation.type === "run_generation") {
            const id = String(operation.nodeId || "");
            if (!nodes.some((node) => String(node.id) === id)) throw new Error(`找不到生成节点：${id}`);
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
