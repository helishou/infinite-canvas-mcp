import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { auditCanvasStorage } from "./audit-canvas-storage.js";

function makeDb(version: number, split: boolean) {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(" + version + ");");
    if (split) db.exec(`CREATE TABLE canvas_projects(id TEXT PRIMARY KEY,data_json TEXT,updated_at TEXT,node_count INTEGER,connection_count INTEGER,nodes_present INTEGER,connections_present INTEGER);
        CREATE TABLE canvas_nodes(project_id TEXT,node_id TEXT,ordinal INTEGER,node_json TEXT,PRIMARY KEY(project_id,node_id));
        CREATE TABLE canvas_connections(project_id TEXT,ordinal INTEGER,connection_json TEXT);`);
    else db.exec("CREATE TABLE canvas_projects(id TEXT PRIMARY KEY,data_json TEXT,updated_at TEXT);");
    return db;
}

test("audit reads legacy schema 50 projects", () => {
    const db = makeDb(50, false);
    try {
        db.prepare("INSERT INTO canvas_projects VALUES(?,?,?)").run("p", JSON.stringify({ id: "p", nodes: [{ id: "n" }], connections: [] }), "now");
        const report = auditCanvasStorage(db);
        assert.equal(report.layout, "legacy");
        assert.equal(report.nodeRows, 1);
        assert.deepEqual(report.issues, []);
    } finally { db.close(); }
});

test("audit validates schema 51 counts and ordered rows", () => {
    const db = makeDb(51, true);
    try {
        db.prepare("INSERT INTO canvas_projects VALUES(?,?,?,?,?,?,?)").run("p", JSON.stringify({ id: "p" }), "now", 2, 0, 1, 1);
        db.prepare("INSERT INTO canvas_nodes VALUES(?,?,?,?)").run("p", "n", 0, JSON.stringify({ id: "n" }));
        const report = auditCanvasStorage(db);
        assert.equal(report.layout, "split");
        assert.equal(report.nodeRows, 1);
        assert.ok(report.issues.some(issue => issue.code === "NODE_COUNT_MISMATCH"));
    } finally { db.close(); }
});

test("audit reads split canvas storage for schemas 52 and current", () => {
    for (const version of [52, DATABASE_SCHEMA_VERSION]) {
        const db = makeDb(version, true);
        try {
            db.prepare("INSERT INTO canvas_projects VALUES(?,?,?,?,?,?,?)").run("p", JSON.stringify({ id: "p" }), "now", 1, 0, 1, 1);
            db.prepare("INSERT INTO canvas_nodes VALUES(?,?,?,?)").run("p", "n", 0, JSON.stringify({ id: "n" }));
            const report = auditCanvasStorage(db);
            assert.equal(report.schemaVersion, version);
            assert.equal(report.layout, "split");
            assert.equal(report.nodeRows, 1);
            assert.deepEqual(report.issues, []);
        } finally { db.close(); }
    }
});

test("audit refuses unknown schema", () => {
    const db = makeDb(DATABASE_SCHEMA_VERSION + 1, true);
    try { assert.throws(() => auditCanvasStorage(db), /Unsupported canvas storage schema/); } finally { db.close(); }
});

test("file audit is read-only, reports UTF8 payload bytes and storage metrics", (t: TestContext) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-storage-audit-")), file = path.join(dir, "audit.sqlite");
    t.after(() => { if (path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(dir, { recursive: true, force: true }); });
    const writer = new DatabaseSync(file);
    writer.exec("CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(50); CREATE TABLE canvas_projects(id TEXT PRIMARY KEY,data_json TEXT,updated_at TEXT);");
    const project = { id: "p", title: "山海画布", nodes: [{ id: "n", title: "角色甲" }], connections: [] };
    writer.prepare("INSERT INTO canvas_projects VALUES('p',?,'now')").run(JSON.stringify(project)); writer.close();
    const before = fs.readFileSync(file);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const report = auditCanvasStorage(db, file);
        assert.equal(report.logicalBytes.projectHeaders, Buffer.byteLength(JSON.stringify({ id: "p", title: "山海画布" })));
        assert.equal(report.logicalBytes.nodes, Buffer.byteLength(JSON.stringify(project.nodes[0])));
        assert.ok(report.pages.pageCount > 0);
        assert.equal(report.fileBytes, before.length);
        assert.throws(() => db.prepare("DELETE FROM canvas_projects").run(), /readonly|read-only/i);
    } finally { db.close(); }
    assert.deepEqual(fs.readFileSync(file), before);
});

test("audit safely reports malformed legacy JSON", () => {
    const db = makeDb(50, false);
    try {
        db.prepare("INSERT INTO canvas_projects VALUES(?,?,?)").run("bad", "{\"privatePrompt\": \"do not expose\"", "now");
        const report = auditCanvasStorage(db);
        assert.equal(report.issues[0]?.code, "PROJECT_READ_FAILED");
        assert.equal(report.issues[0]?.detail, "project rows could not be read");
        assert.ok(!JSON.stringify(report).includes("privatePrompt"));
    } finally { db.close(); }
});
