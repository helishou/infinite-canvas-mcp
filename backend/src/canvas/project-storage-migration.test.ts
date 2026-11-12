import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateCanvasProjectStorage } from "./project-storage-migration.js";
import { readRawProject } from "../stores/canvas-project-storage.js";

function legacy() {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE canvas_projects(id TEXT PRIMARY KEY,data_json TEXT NOT NULL,updated_at TEXT NOT NULL)");
    db.prepare("INSERT INTO canvas_projects VALUES(?,?,?)").run("p1", JSON.stringify({ id: "p1", title: "unknown fields retained", nodes: [{ id: "n1", arbitrary: { x: 2 } }], connections: [{ source: "n1", custom: true }] }), "now");
    db.prepare("INSERT INTO canvas_projects VALUES(?,?,?)").run("p2", JSON.stringify({ id: "p2", title: "empty", nodes: [], connections: [] }), "now");
    db.prepare("INSERT INTO canvas_projects VALUES(?,?,?)").run("p3", JSON.stringify({ id: "p3", title: "legacy arrays absent", custom: [1, 2] }), "now");
    return db;
}

test("migration splits legacy data and proves exact reassembly", () => {
    const db = legacy();
    const expected = ["p1", "p2", "p3"].map(id => JSON.parse((db.prepare("SELECT data_json FROM canvas_projects WHERE id=?").get(id) as any).data_json));
    db.exec("BEGIN IMMEDIATE");
    migrateCanvasProjectStorage(db);
    db.exec("COMMIT");
    assert.deepStrictEqual(readRawProject(db, "p1"), expected[0]);
    assert.deepStrictEqual(readRawProject(db, "p2"), expected[1]);
    assert.deepStrictEqual(readRawProject(db, "p3"), expected[2]);
    const p3Flags = db.prepare("SELECT nodes_present,connections_present FROM canvas_projects WHERE id='p3'").get() as any;
    assert.deepStrictEqual([p3Flags.nodes_present, p3Flags.connections_present], [0, 0]);
    assert.equal((db.prepare("SELECT node_count FROM canvas_projects WHERE id='p1'").get() as any).node_count, 1);
    db.close();
});

test("migration failure can be rolled back by caller transaction", () => {
    const db = legacy();
    db.prepare("UPDATE canvas_projects SET data_json=? WHERE id='p1'").run(JSON.stringify({ id: "p1", nodes: [{ id: "dup" }, { id: "dup" }] }));
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => migrateCanvasProjectStorage(db));
    db.exec("ROLLBACK");
    assert.equal((db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='canvas_nodes'").get() as any).n, 0);
    assert.equal((db.prepare("SELECT data_json FROM canvas_projects WHERE id='p1'").get() as any).data_json, JSON.stringify({ id: "p1", nodes: [{ id: "dup" }, { id: "dup" }] }));
    db.close();
});

test("migration rejects malformed data and a late invalid project before rewriting any project", () => {
    const db = legacy();
    db.prepare("UPDATE canvas_projects SET data_json=? WHERE id='p3'").run(JSON.stringify({ id: "wrong-id", nodes: [] }));
    const before = db.prepare("SELECT id,data_json FROM canvas_projects ORDER BY id").all();
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => migrateCanvasProjectStorage(db), /p3.*ID/);
    db.exec("ROLLBACK");
    assert.deepStrictEqual(db.prepare("SELECT id,data_json FROM canvas_projects ORDER BY id").all(), before);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='canvas_nodes'").get() as any).n, 0);
    db.prepare("UPDATE canvas_projects SET data_json='null' WHERE id='p3'").run();
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => migrateCanvasProjectStorage(db), /p3.*对象/);
    db.exec("ROLLBACK");
    db.prepare("UPDATE canvas_projects SET data_json='{' WHERE id='p3'").run();
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => migrateCanvasProjectStorage(db), /p3.*JSON/);
    db.exec("ROLLBACK");
    db.close();
});
