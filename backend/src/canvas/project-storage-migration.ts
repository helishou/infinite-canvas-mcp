import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { readRawProject } from "../stores/canvas-project-storage.js";

export function createCanvasProjectStorageSchema(db: DatabaseSync) {
    const cols = new Set((db.prepare("PRAGMA table_info(canvas_projects)").all() as Array<{ name: string }>).map(row => row.name));
    if (!cols.has("node_count")) db.exec("ALTER TABLE canvas_projects ADD COLUMN node_count INTEGER NOT NULL DEFAULT 0");
    if (!cols.has("connection_count")) db.exec("ALTER TABLE canvas_projects ADD COLUMN connection_count INTEGER NOT NULL DEFAULT 0");
    if (!cols.has("nodes_present")) db.exec("ALTER TABLE canvas_projects ADD COLUMN nodes_present INTEGER NOT NULL DEFAULT 1");
    if (!cols.has("connections_present")) db.exec("ALTER TABLE canvas_projects ADD COLUMN connections_present INTEGER NOT NULL DEFAULT 1");
    db.exec(`CREATE TABLE IF NOT EXISTS canvas_nodes (
        project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL, ordinal INTEGER NOT NULL, node_json TEXT NOT NULL,
        PRIMARY KEY(project_id,node_id)
    );
    CREATE INDEX IF NOT EXISTS canvas_nodes_project_ordinal ON canvas_nodes(project_id,ordinal);
    CREATE TABLE IF NOT EXISTS canvas_connections (
        project_id TEXT NOT NULL REFERENCES canvas_projects(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, connection_json TEXT NOT NULL,
        PRIMARY KEY(project_id,ordinal)
    );`);
}

function decodeLegacy(id: string, json: string) {
    let value: unknown;
    try { value = JSON.parse(json); } catch { throw new Error(`画布 ${id} 存储 JSON 无效`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`画布 ${id} 存储对象无效`);
    const full = value as Record<string, unknown>;
    if (full.id !== id) throw new Error(`画布 ${id} 存储头 ID 不匹配`);
    if (Object.hasOwn(full, "nodes") && !Array.isArray(full.nodes)) throw new Error(`画布 ${id} 的 nodes 必须是数组`);
    if (Object.hasOwn(full, "connections") && !Array.isArray(full.connections)) throw new Error(`画布 ${id} 的 connections 必须是数组`);
    const ids = new Set<string>();
    for (const node of (full.nodes ?? []) as unknown[]) {
        const nodeId = node && typeof node === "object" && !Array.isArray(node) ? (node as Record<string, unknown>).id : undefined;
        if (typeof nodeId !== "string" || !nodeId.trim() || ids.has(nodeId)) throw new Error(`画布 ${id} 含无效或重复节点 ID`);
        ids.add(nodeId);
    }
    return full;
}

/** Caller owns the migration transaction. Projects are validated before any row is changed. */
export function migrateCanvasProjectStorage(db: DatabaseSync) {
    createCanvasProjectStorageSchema(db);
    const ids = db.prepare("SELECT id FROM canvas_projects ORDER BY id");
    const read = db.prepare("SELECT data_json FROM canvas_projects WHERE id=?");
    for (const row of db.prepare("SELECT id,data_json FROM canvas_projects ORDER BY id").iterate() as Iterable<{ id: string; data_json: string }>) decodeLegacy(row.id, row.data_json);

    const update = db.prepare("UPDATE canvas_projects SET data_json=?,node_count=?,connection_count=?,nodes_present=?,connections_present=? WHERE id=?");
    const addNode = db.prepare("INSERT INTO canvas_nodes(project_id,node_id,ordinal,node_json) VALUES(?,?,?,?)");
    const addConnection = db.prepare("INSERT INTO canvas_connections(project_id,ordinal,connection_json) VALUES(?,?,?)");
    for (const { id } of ids.iterate() as Iterable<{ id: string }>) {
        const data = read.get(id) as { data_json: string };
        const original = decodeLegacy(id, data.data_json);
        const nodeValues = Array.isArray(original.nodes) ? original.nodes : [];
        const connectionValues = Array.isArray(original.connections) ? original.connections : [];
        const header = { ...original };
        delete header.nodes; delete header.connections;
        update.run(JSON.stringify(header), nodeValues.length, connectionValues.length, Number(Object.hasOwn(original, "nodes")), Number(Object.hasOwn(original, "connections")), id);
        nodeValues.forEach((node: any, ordinal: number) => addNode.run(id, node.id, ordinal, JSON.stringify(node)));
        connectionValues.forEach((connection: unknown, ordinal: number) => addConnection.run(id, ordinal, JSON.stringify(connection)));
        if (!isDeepStrictEqual(readRawProject(db, id), original)) throw new Error(`画布 ${id} 存储迁移反拼校验失败`);
    }
}
