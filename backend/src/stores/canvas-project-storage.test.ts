import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createCanvasProjectStorageSchema } from "../canvas/project-storage-migration.js";
import { createStoredProject, deleteStoredProject, iterateRawProjects, readOrderedConnections, readOrderedNodes, readProjectHeader, readRawProject, readStoredProjectRows, writeStoredProjectDelta } from "./canvas-project-storage.js";

function db() {
    const value = new DatabaseSync(":memory:");
    value.exec("CREATE TABLE canvas_projects(id TEXT PRIMARY KEY,data_json TEXT NOT NULL,updated_at TEXT NOT NULL)");
    createCanvasProjectStorageSchema(value); return value;
}
function create(database: DatabaseSync, project: Record<string, unknown>) { database.exec("BEGIN"); try { createStoredProject(database, project); database.exec("COMMIT"); } catch (error) { database.exec("ROLLBACK"); throw error; } }

test("split project preserves absent versus empty arrays and unknown header fields", () => {
    const database = db();
    create(database, { id: "a", title: "A", extra: { keep: true } });
    create(database, { id: "b", nodes: [], connections: [], extra: 7 });
    assert.deepStrictEqual(readRawProject(database, "a"), { id: "a", title: "A", extra: { keep: true } });
    assert.deepStrictEqual(readRawProject(database, "b"), { id: "b", nodes: [], connections: [], extra: 7 });
    assert.equal(readStoredProjectRows(database, "a")?.nodesPresent, false);
    assert.equal(readStoredProjectRows(database, "b")?.nodesPresent, true);
    assert.deepStrictEqual(readProjectHeader(database, "b"), { id: "b", extra: 7 });
    assert.deepStrictEqual([...iterateRawProjects(database)], [readRawProject(database, "a"), readRawProject(database, "b")]);
    assert.throws(() => createStoredProject(database, { id: "outside-transaction" }), /caller-owned transaction/);
    database.close();
});

test("delta retains ordinals, avoids unchanged row writes, and ordered reads filter", () => {
    const database = db();
    const initial = { id: "a", nodes: [{ id: "n1", x: 1 }, { id: "n2", x: 2 }], connections: [{ fromNodeId: "n1", toNodeId: "n2" }] };
    create(database, initial);
    database.exec("CREATE TABLE node_updates(n INTEGER); CREATE TRIGGER count_node_update AFTER UPDATE ON canvas_nodes BEGIN INSERT INTO node_updates VALUES(1); END");
    const prior = readStoredProjectRows(database, "a")!;
    database.exec("CREATE TABLE connection_updates(n INTEGER); CREATE TRIGGER count_connection_update AFTER UPDATE ON canvas_connections BEGIN INSERT INTO connection_updates VALUES(1); END");
    database.exec("BEGIN");
    writeStoredProjectDelta(database, prior, { ...initial, nodes: [{ id: "n2", x: 2 }, { id: "n1", x: 3 }] });
    database.exec("COMMIT");
    assert.equal((database.prepare("SELECT COUNT(*) n FROM node_updates").get() as any).n, 2);
    assert.equal((database.prepare("SELECT COUNT(*) n FROM connection_updates").get() as any).n, 0);
    assert.deepStrictEqual(readOrderedNodes(database, "a", ["n1"]).map(n => n.id), ["n1"]);
    assert.deepStrictEqual(readOrderedConnections(database, "a", ["n2"]), [{ fromNodeId: "n1", toNodeId: "n2" }]);
    assert.deepStrictEqual(readRawProject(database, "a"), { id: "a", nodes: [{ id: "n2", x: 2 }, { id: "n1", x: 3 }], connections: [{ fromNodeId: "n1", toNodeId: "n2" }] });
    const after = readStoredProjectRows(database, "a")!;
    database.exec("BEGIN");
    writeStoredProjectDelta(database, after, { id: "a", nodes: [{ id: "n2", x: 2 }, { id: "n1", x: 3 }], connections: [{ fromNodeId: "n2", toNodeId: "n1" }] });
    database.exec("COMMIT");
    assert.equal((database.prepare("SELECT COUNT(*) n FROM connection_updates").get() as any).n, 1);
    assert.deepStrictEqual(readOrderedConnections(database, "a"), [{ fromNodeId: "n2", toNodeId: "n1" }]);
    database.close();
});

test("invalid and duplicate node IDs are rejected; delete cascades", () => {
    const database = db();
    assert.throws(() => create(database, { id: "bad", nodes: [{ id: "" }] }));
    assert.throws(() => create(database, { id: "bad", nodes: [{ id: "n" }, { id: "n" }] }));
    create(database, { id: "ok", nodes: [{ id: "n" }], connections: [{}] });
    database.exec("BEGIN");
    assert.equal(deleteStoredProject(database, "ok"), 1);
    database.exec("COMMIT");
    assert.equal((database.prepare("SELECT COUNT(*) n FROM canvas_nodes").get() as any).n, 0);
    database.close();
});

test("streaming iterator closes only the read transaction it owns on early return", () => {
    const database = db();
    create(database, { id: "a" }); create(database, { id: "b" });
    const ownIterator = iterateRawProjects(database);
    assert.equal(ownIterator.next().value?.id, "a");
    ownIterator.return(undefined);
    assert.equal(database.isTransaction, false);
    database.exec("BEGIN");
    const callerIterator = iterateRawProjects(database);
    assert.equal(callerIterator.next().value?.id, "a");
    callerIterator.return(undefined);
    assert.equal(database.isTransaction, true);
    database.exec("ROLLBACK");
    database.close();
});

test("corrupt child JSON is reported without embedding stored contents", () => {
    const database = db(); create(database, { id: "private-project", nodes: [{ id: "n" }] });
    database.prepare("UPDATE canvas_nodes SET node_json=? WHERE project_id=?").run("{secret payload", "private-project");
    assert.throws(() => readStoredProjectRows(database, "private-project"), error => error instanceof Error && error.message.includes("private-project") && !error.message.includes("secret payload"));
    database.close();
});

test("current writer rejects an old whole-project layout without creating fallback rows", () => {
    const database = new DatabaseSync(":memory:");
    try {
        database.exec("CREATE TABLE canvas_projects(id TEXT PRIMARY KEY,data_json TEXT NOT NULL,updated_at TEXT NOT NULL); BEGIN");
        assert.throws(() => createStoredProject(database, { id: "old", nodes: [{ id: "n" }] }), /no column named node_count/);
        database.exec("ROLLBACK");
        assert.equal(database.prepare("SELECT COUNT(*) n FROM canvas_projects").get()!.n, 0);
    } finally { database.close(); }
});

test("partial split layouts fail instead of omitting persisted graph fields", () => {
    const database = new DatabaseSync(":memory:");
    try {
        database.exec("CREATE TABLE canvas_projects(id TEXT PRIMARY KEY,data_json TEXT,updated_at TEXT,nodes_present INTEGER); CREATE TABLE canvas_nodes(project_id TEXT,node_id TEXT,ordinal INTEGER,node_json TEXT); INSERT INTO canvas_projects VALUES('p','{\"id\":\"p\"}','now',1)");
        assert.throws(() => readRawProject(database, "p"), /no such column/);
        assert.equal(database.isTransaction, false);
    } finally { database.close(); }
});
