import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { BackendDatabase } from "../db.js";
import { schema52Database } from "../test-helpers/schema52-database.js";
import { createStoredProject } from "../stores/canvas-project-storage.js";
import { readRawProject } from "../stores/canvas-project-storage.js";

test("ops update only the changed node, journal failures roll back children and receipts", t => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", title: "project", pluginField: { value: false }, nodes: [
        { id: "a", type: "text", position: { x: 0, y: 0 }, metadata: { content: "a" } },
        { id: "b", type: "text", position: { x: 10, y: 0 }, metadata: { content: "b" } },
    ], connections: [] });
    db.db.exec(`CREATE TEMP TABLE updated_nodes (id TEXT);
        CREATE TEMP TRIGGER record_node_update AFTER UPDATE ON canvas_nodes
        BEGIN INSERT INTO updated_nodes VALUES (NEW.node_id); END;`);
    db.applyCanvasProjectOperations("p", 0, [{ type: "update_node", id: "a", patch: { x: 20 } }], { operationId: "move" });
    assert.deepEqual(db.db.prepare("SELECT id FROM updated_nodes").all().map(row => row.id), ["a"]);
    const header = JSON.parse(String(db.db.prepare("SELECT data_json FROM canvas_projects WHERE id='p'").get()!.data_json));
    assert.equal(Object.hasOwn(header, "nodes"), false);
    assert.deepEqual(header.pluginField, { value: false });
    const before = readRawProject(db.db, "p");
    db.db.exec(`CREATE TRIGGER reject_journal BEFORE INSERT ON canvas_operation_batches
        WHEN NEW.operation_id='reject' BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END;`);
    assert.throws(() => db.applyCanvasProjectOperations("p", 1, [{ type: "update_node", id: "a", patch: { x: 99 } }], { operationId: "reject" }), /injected journal failure/);
    assert.deepEqual(readRawProject(db.db, "p"), before);
    assert.equal(db.getCanvasOperationReceipt("p", "reject").committed, false);
    db.db.exec("BEGIN IMMEDIATE");
    db.applyCanvasProjectOperations("p", 1, [{ type: "update_node", id: "b", patch: { y: 55 } }], { withinTransaction: true, operationId: "nested", deferredCommits: [] });
    db.db.exec("ROLLBACK");
    assert.deepEqual(readRawProject(db.db, "p"), before);
    assert.equal(db.getCanvasOperationReceipt("p", "nested").committed, false);
});

test("index, selection and H3 context use split rows without full-project hydration", t => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [
        { id: "source", type: "text", title: "Source", metadata: { content: "body" } },
        { id: "h3", type: "minimax-h3:video", title: "H3", metadata: { segments: [{ id: "clip", prompt: "hello", referenceBindings: [] }] } },
    ], connections: [{ id: "edge", fromNodeId: "source", toNodeId: "h3" }] });
    t.mock.method(db, "getCanvasProject", () => { throw new Error("full hydration must not run"); });
    assert.equal(db.listCanvasProjectSummaries()[0].nodeCount, 2);
    assert.deepEqual((db.getCanvasProjectIndex("p")!.nodes as any[]).map(node => node.id), ["source", "h3"]);
    assert.equal(db.getCanvasProjectIndex("p", 0)!.unchanged, true);
    const selection = db.getCanvasProjectNodeSnapshot("p", ["h3"]);
    assert.deepEqual((selection!.nodes as any[]).map(node => node.id), ["h3"]);
    assert.equal((selection!.connections as any[]).length, 1);
    assert.equal(((db.getCanvasH3NodeSummary("p", "h3")!.nodes as any[])[0].metadata.segments as any[])[0].id, "clip");
    const context = db.getCanvasProjectH3Context("p", "h3", "clip", { sourceNodeIds: ["source"] });
    assert.deepEqual((context!.nodes as any[]).map(node => node.id), ["h3", "source"]);
});

test("real v52 file upgrades with verified old backup and retains edits across reopening", t => {
    const directory = mkdtempSync(path.join(tmpdir(), "canvas-v51-upgrade-"));
    const file = path.join(directory, "runtime.sqlite");
    let db: BackendDatabase | undefined;
    t.after(() => { db?.close(); rmSync(directory, { recursive: true, force: true }); });
    const legacy = schema52Database(file);
    const original = { id: "p", revision: 0, custom: { nested: [0, false, null] }, nodes: [{ id: "n", type: "text", position: { x: 2, y: 0 }, metadata: { content: "中文" } }], connections: [] };
    legacy.exec("BEGIN"); createStoredProject(legacy, original); legacy.exec("COMMIT");
    legacy.close();
    db = new BackendDatabase(file);
    assert.deepEqual(readRawProject(db.db, "p"), original);
    assert.equal(db.db.prepare("SELECT MAX(version) v FROM schema_migrations").get()!.v, DATABASE_SCHEMA_VERSION);
    const backups = readdirSync(directory).filter(name => name.includes(`pre-schema-v52-to-v${DATABASE_SCHEMA_VERSION}`));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(path.join(directory, backups[0]), { readOnly: true });
    try {
        assert.deepEqual(readRawProject(backup, "p"), original);
        assert.equal(backup.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
    } finally { backup.close(); }
    db.applyCanvasProjectOperations("p", 0, [{ type: "update_node", id: "n", patch: { x: 77 } }], { operationId: "after-migration" });
    db.close(); db = undefined;
    db = new BackendDatabase(file);
    assert.equal((db.getCanvasProject("p")!.nodes as any[])[0].position.x, 77);
    assert.deepEqual(db.getCanvasProject("p")!.custom, original.custom);
    assert.equal(readdirSync(directory).filter(name => name.includes(`pre-schema-v52-to-v${DATABASE_SCHEMA_VERSION}`)).length, 1);
    assert.equal(db.applyCanvasProjectOperations("p", 0, [{ type: "update_node", id: "n", patch: { x: 77 } }], { operationId: "after-migration" }).duplicated, true);
});


test("database views stay detached without cloning freshly decoded graphs", t => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "read-owned", nodes: [{ id: "n", type: "text", metadata: { content: "persisted", nested: { value: 1 } } }], connections: [] });
    const clone = globalThis.structuredClone;
    let cloneCalls = 0;
    t.mock.method(globalThis, "structuredClone", ((...args: Parameters<typeof clone>) => { cloneCalls++; return clone(...args); }) as typeof clone);
    const first = db.getCanvasProject("read-owned")!;
    ((first.nodes as any[])[0].metadata.nested).value = 99;
    (first.nodes as any[]).push({ id: "local-only" });
    const second = db.getCanvasProject("read-owned")!;
    assert.equal((second.nodes as any[]).length, 1);
    assert.equal((second.nodes as any[])[0].metadata.nested.value, 1);
    assert.equal(cloneCalls, 0);
});

test("ops reuse the decoded before-image and still persist exactly the changed node", t => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "reuse", nodes: [
        { id: "a", type: "text", position: { x: 0, y: 0 }, metadata: { content: "a" } },
        { id: "b", type: "text", position: { x: 1, y: 0 }, metadata: { content: "b" } },
    ], connections: [] });
    const prepare = db.db.prepare;
    let fullNodeReads = 0;
    t.mock.method(db.db, "prepare", function(this: typeof db.db, sql: string) {
        if (sql.includes("FROM canvas_nodes WHERE project_id=? ORDER BY ordinal")) fullNodeReads++;
        return prepare.call(this, sql);
    });
    const result = db.applyCanvasProjectOperations("reuse", 0, [{ type: "update_node", id: "a", patch: { position: { x: 55, y: 0 } } }], { operationId: "reuse-position" });
    assert.equal((result.project.nodes as any[])[0].position.x, 55);
    assert.equal((result.project.nodes as any[])[1].position.x, 1);
    assert.equal(fullNodeReads, 2, "one before-image read and one confirmed readback, without a third full read");
    assert.equal(db.getCanvasOperationReceipt("reuse", "reuse-position").committed, true);
});
