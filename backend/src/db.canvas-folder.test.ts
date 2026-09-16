import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendDatabase } from "./db.js";

test("v6 迁移保留既有画布剧目归属并同步摘要与删除结果", (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "infinite-canvas-folder-v6-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, "runtime.sqlite");
    const legacy = new DatabaseSync(file);
    legacy.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations (version, applied_at) VALUES (5, '2026-01-01');
        CREATE TABLE canvas_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE canvas_projects (id TEXT PRIMARY KEY, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
        INSERT INTO canvas_folders (id, name, created_at) VALUES ('folder-1', '剧目一', '2026-01-01');
        INSERT INTO canvas_projects (id, data_json, updated_at) VALUES (
            'project-1',
            '{"id":"project-1","title":"第一集","folderId":"folder-1","createdAt":"2026-01-01","updatedAt":"2026-01-02","nodes":[],"connections":[]}',
            '2026-01-02'
        );
    `);
    legacy.close();

    const db = new BackendDatabase(file);
    try {
        assert.equal(db.listCanvasProjects({ folderId: "folder-1" })[0]?.id, "project-1");
        const summary = db.listCanvasProjectSummaries({ id: "project-1" })[0];
        assert.equal(summary.folderId, "folder-1");
        assert.equal(summary.createdAt, "2026-01-01");

        db.deleteCanvasFolder("folder-1");

        assert.equal(db.getCanvasProject("project-1")?.folderId, undefined);
        assert.equal(db.listCanvasProjects({ folderId: null })[0]?.id, "project-1");
        assert.equal(db.listCanvasProjectSummaries({ id: "project-1" })[0]?.folderId, null);
    } finally {
        db.close();
    }
});
