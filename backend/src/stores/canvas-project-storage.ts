import type { DatabaseSync } from "node:sqlite";

export type StoredNodeRow = { nodeId: string; ordinal: number; nodeJson: string };
export type StoredConnectionRow = { ordinal: number; connectionJson: string };
export type StoredProjectRows = {
    id: string; header: Record<string, unknown>; nodes: Record<string, unknown>[]; connections: unknown[];
    nodeRows: StoredNodeRow[]; connectionRows: StoredConnectionRow[];
    nodeCount: number; connectionCount: number; nodesPresent: boolean; connectionsPresent: boolean;
};

type ProjectDb = DatabaseSync;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function splitProject(project: Record<string, unknown>) {
    const id = project.id;
    if (typeof id !== "string" || !id.trim()) throw new Error("project.id 必填");
    const nodesPresent = Object.hasOwn(project, "nodes"), connectionsPresent = Object.hasOwn(project, "connections");
    const nodes = project.nodes === undefined ? [] : project.nodes;
    const connections = project.connections === undefined ? [] : project.connections;
    if (!Array.isArray(nodes)) throw new Error("画布 nodes 必须是数组");
    if (!Array.isArray(connections)) throw new Error("画布 connections 必须是数组");
    const seen = new Set<string>();
    for (const node of nodes) {
        const nodeId = record(node).id;
        if (typeof nodeId !== "string" || !nodeId.trim()) throw new Error("画布节点 id 必须是非空字符串");
        if (seen.has(nodeId)) throw new Error(`画布节点 id 重复: ${nodeId}`);
        seen.add(nodeId);
    }
    const header = { ...project };
    delete header.nodes; delete header.connections;
    return { id, header, nodes: nodes as Record<string, unknown>[], connections, nodesPresent, connectionsPresent };
}

function transaction<T>(db: ProjectDb, fn: () => T): T {
    const owned = !db.isTransaction;
    if (owned) db.exec("BEGIN");
    try { const result = fn(); if (owned) db.exec("COMMIT"); return result; }
    catch (error) { if (owned && db.isTransaction) db.exec("ROLLBACK"); throw error; }
}
function requireTransaction(db: ProjectDb) { if (!db.isTransaction) throw new Error("canvas project storage writes require a caller-owned transaction"); }
function parseHeader(json: string, id: string) {
    let value: unknown;
    try { value = JSON.parse(json); } catch { throw new Error(`画布 ${id} 存储数据无效`); }
    const header = record(value);
    if (typeof value !== "object" || value === null || Array.isArray(value) || header.id !== id) throw new Error(`画布 ${id} 存储头无效`);
    return header;
}
function parseChild(json: string, id: string, kind: "node" | "connection") {
    try { return JSON.parse(json) as unknown; } catch { throw new Error(`画布 ${id} 的 ${kind} 存储 JSON 无效`); }
}
function parseNode(json: string, projectId: string, nodeId: string) {
    const value = parseChild(json, projectId, "node");
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).id !== nodeId) throw new Error(`画布 ${projectId} 的节点存储记录无效`);
    return value as Record<string, unknown>;
}

export function readStoredProjectRows(db: ProjectDb, id: string): StoredProjectRows | null {
    return transaction(db, () => {
        const p = db.prepare("SELECT id,data_json,updated_at,node_count,connection_count,nodes_present,connections_present FROM canvas_projects WHERE id=?").get(id) as any;
        if (!p) return null;
        const nodeRows = db.prepare("SELECT node_id AS nodeId,ordinal,node_json AS nodeJson FROM canvas_nodes WHERE project_id=? ORDER BY ordinal").all(id) as StoredNodeRow[];
        const connectionRows = db.prepare("SELECT ordinal,connection_json AS connectionJson FROM canvas_connections WHERE project_id=? ORDER BY ordinal").all(id) as StoredConnectionRow[];
        const header = parseHeader(p.data_json, id);
        return { id, header, nodes: nodeRows.map(row => parseNode(row.nodeJson, id, row.nodeId)), connections: connectionRows.map(row => parseChild(row.connectionJson, id, "connection")), nodeRows, connectionRows, nodeCount: Number(p.node_count), connectionCount: Number(p.connection_count), nodesPresent: Boolean(p.nodes_present), connectionsPresent: Boolean(p.connections_present) };
    });
}

export function readRawProject(db: ProjectDb, id: string) { const rows = readStoredProjectRows(db, id); return rows ? rawProjectFromStoredRows(rows) : null; }
/** Materialize a caller-owned snapshot; raw before-image strings remain separate. */
export function rawProjectFromStoredRows(rows: StoredProjectRows) {
    const project = { ...rows.header };
    if (rows.nodesPresent) project.nodes = rows.nodes;
    if (rows.connectionsPresent) project.connections = rows.connections;
    return project;
}
export function* iterateRawProjects(db: ProjectDb): Generator<Record<string, unknown>> {
    const owned = !db.isTransaction;
    if (owned) db.exec("BEGIN");
    try {
        for (const row of db.prepare("SELECT id FROM canvas_projects ORDER BY id").iterate() as Iterable<{ id: string }>) {
            const rows = readStoredProjectRows(db, row.id);
            if (rows) yield rawProjectFromStoredRows(rows);
        }
        if (owned) db.exec("COMMIT");
    } catch (error) { if (owned && db.isTransaction) db.exec("ROLLBACK"); throw error; }
    finally { if (owned && db.isTransaction) db.exec("ROLLBACK"); }
}
export function readProjectHeader(db: ProjectDb, id: string) {
    const p = db.prepare("SELECT data_json FROM canvas_projects WHERE id=?").get(id) as { data_json: string } | undefined;
    if (!p) return null;
    return parseHeader(p.data_json, id);
}
export function readOrderedNodes(db: ProjectDb, id: string, nodeIds?: readonly string[]) {
    const result = nodeIds ? db.prepare("SELECT node_id,node_json FROM canvas_nodes WHERE project_id=? AND node_id IN (SELECT value FROM json_each(?)) ORDER BY ordinal").all(id, JSON.stringify(nodeIds)) : db.prepare("SELECT node_id,node_json FROM canvas_nodes WHERE project_id=? ORDER BY ordinal").all(id);
    return (result as Array<{ node_id: string; node_json: string }>).map(row => parseNode(row.node_json, id, row.node_id));
}
export function readOrderedConnections(db: ProjectDb, id: string, relatedNodeIds?: readonly string[]) {
    const sql = relatedNodeIds ? "SELECT connection_json FROM canvas_connections WHERE project_id=? AND (json_extract(connection_json,'$.fromNodeId') IN (SELECT value FROM json_each(?)) OR json_extract(connection_json,'$.toNodeId') IN (SELECT value FROM json_each(?))) ORDER BY ordinal" : "SELECT connection_json FROM canvas_connections WHERE project_id=? ORDER BY ordinal";
    const encoded = relatedNodeIds ? JSON.stringify(relatedNodeIds) : undefined;
    const result = relatedNodeIds ? db.prepare(sql).all(id, encoded!, encoded!) : db.prepare(sql).all(id);
    return (result as Array<{ connection_json: string }>).map(row => parseChild(row.connection_json, id, "connection"));
}

function insertChildren(db: ProjectDb, id: string, nodes: Record<string, unknown>[], connections: unknown[]) {
    const node = db.prepare("INSERT INTO canvas_nodes(project_id,node_id,ordinal,node_json) VALUES(?,?,?,?)");
    nodes.forEach((value, ordinal) => node.run(id, String(value.id), ordinal, JSON.stringify(value)));
    const connection = db.prepare("INSERT INTO canvas_connections(project_id,ordinal,connection_json) VALUES(?,?,?)");
    connections.forEach((value, ordinal) => connection.run(id, ordinal, JSON.stringify(value)));
}
export function createStoredProject(db: ProjectDb, project: Record<string, unknown>) {
    requireTransaction(db);
    const s = splitProject(project);
    db.prepare("INSERT INTO canvas_projects(id,data_json,updated_at,node_count,connection_count,nodes_present,connections_present) VALUES(?,?,?,?,?,?,?)")
        .run(s.id, JSON.stringify(s.header), String(s.header.updatedAt ?? new Date().toISOString()), s.nodes.length, s.connections.length, Number(s.nodesPresent), Number(s.connectionsPresent));
    insertChildren(db, s.id, s.nodes, s.connections);
}
export function writeStoredProjectDelta(db: ProjectDb, previousRows: StoredProjectRows, nextProject: Record<string, unknown>) {
    requireTransaction(db);
    const s = splitProject(nextProject);
    if (s.id !== previousRows.id) throw new Error("项目 ID 不可变");
    const oldNodes = new Map(previousRows.nodeRows.map(row => [row.nodeId, row]));
    const nextNodes = new Set(s.nodes.map(node => String(node.id)));
    const removeNode = db.prepare("DELETE FROM canvas_nodes WHERE project_id=? AND node_id=?");
    for (const id of oldNodes.keys()) if (!nextNodes.has(id)) removeNode.run(s.id, id);
    const updateNode = db.prepare("UPDATE canvas_nodes SET ordinal=?,node_json=? WHERE project_id=? AND node_id=?");
    const insertNode = db.prepare("INSERT INTO canvas_nodes(project_id,node_id,ordinal,node_json) VALUES(?,?,?,?)");
    s.nodes.forEach((node, ordinal) => {
        const id = String(node.id), prior = oldNodes.get(id), json = JSON.stringify(node);
        if (!prior) insertNode.run(s.id, id, ordinal, json);
        else if (prior.ordinal !== ordinal || prior.nodeJson !== json) updateNode.run(ordinal, json, s.id, id);
    });
    const oldConnections = previousRows.connectionRows;
    const oldConnectionsByOrdinal = new Map(oldConnections.map(row => [row.ordinal, row]));
    const nextConnections = s.connections.map(value => JSON.stringify(value));
    const deleteConnection = db.prepare("DELETE FROM canvas_connections WHERE project_id=? AND ordinal=?");
    const updateConnection = db.prepare("UPDATE canvas_connections SET connection_json=? WHERE project_id=? AND ordinal=?");
    const insertConnection = db.prepare("INSERT INTO canvas_connections(project_id,ordinal,connection_json) VALUES(?,?,?)");
    oldConnections.forEach(row => { if (row.ordinal >= nextConnections.length) deleteConnection.run(s.id, row.ordinal); });
    nextConnections.forEach((json, ordinal) => {
        const old = oldConnectionsByOrdinal.get(ordinal);
        if (!old) insertConnection.run(s.id, ordinal, json);
        else if (old.connectionJson !== json) updateConnection.run(json, s.id, ordinal);
    });
    db.prepare("UPDATE canvas_projects SET data_json=?,updated_at=?,node_count=?,connection_count=?,nodes_present=?,connections_present=? WHERE id=?")
        .run(JSON.stringify(s.header), String(s.header.updatedAt ?? new Date().toISOString()), s.nodes.length, s.connections.length, Number(s.nodesPresent), Number(s.connectionsPresent), s.id);
}
export function deleteStoredProject(db: ProjectDb, id: string) { requireTransaction(db); return Number(db.prepare("DELETE FROM canvas_projects WHERE id=?").run(id).changes); }
