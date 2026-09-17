import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendDatabase } from "./db.js";

test("v7 迁移：把 v6 的 folder_id 搬到 drama_episodes，并给所有 drama 建 episode 1", (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "infinite-canvas-folder-v7-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, "runtime.sqlite");
    // 模拟 v6 老库：canvas_projects.folder_id 存在，画布挂在 drama 下
    const legacy = new DatabaseSync(file);
    legacy.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations (version, applied_at) VALUES (6, '2026-01-01');
        CREATE TABLE canvas_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE canvas_projects (
            id TEXT PRIMARY KEY,
            data_json TEXT NOT NULL,
            folder_id TEXT REFERENCES canvas_folders(id) ON DELETE SET NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX canvas_projects_folder_id ON canvas_projects(folder_id);
        CREATE TABLE drama_projects (
            folder_id TEXT PRIMARY KEY REFERENCES canvas_folders(id) ON DELETE CASCADE,
            outline TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            cover_storage_key TEXT,
            tags_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL
        );
        INSERT INTO canvas_folders (id, name, created_at) VALUES
            ('folder-1', '剧目一', '2026-01-01'),
            ('folder-2', '剧目二无画布', '2026-01-01'),
            ('folder-3', '普通画布文件夹', '2026-01-01');
        INSERT INTO drama_projects (folder_id, outline, description, tags_json, updated_at) VALUES
            ('folder-1', '总纲一', 'desc', '[]', '2026-01-01'),
            ('folder-2', '总纲二', 'desc', '[]', '2026-01-01');
        INSERT INTO canvas_projects (id, data_json, folder_id, updated_at) VALUES
            ('project-1', '{"id":"project-1","title":"第一集","folderId":"folder-1","createdAt":"2026-01-01","updatedAt":"2026-01-02","nodes":[],"connections":[]}', 'folder-1', '2026-01-02'),
            ('project-2', '{"id":"project-2","title":"无画布","createdAt":"2026-01-01","updatedAt":"2026-01-01","nodes":[],"connections":[]}', NULL, '2026-01-01'),
            ('project-3', '{"id":"project-3","title":"普通文件夹画布","folderId":"folder-3","createdAt":"2026-01-01","updatedAt":"2026-01-01","nodes":[],"connections":[]}', 'folder-3', '2026-01-01');
    `);
    legacy.close();

    const db = new BackendDatabase(file);
    try {
        // 1. v7 表已建
        const tables = db["db"].prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='drama_episodes'").all() as Array<{ name: string }>;
        assert.equal(tables.length, 1, "drama_episodes 表应存在");

        // 2. canvas_projects.folder_id 已删
        const cols = db["db"].prepare("PRAGMA table_info(canvas_projects)").all() as Array<{ name: string }>;
        assert.ok(!cols.some((c) => c.name === "folder_id"), "canvas_projects.folder_id 应已删");

        // 3. drama_episodes 自动建好
        const eps1 = db.listDramaEpisodes("folder-1");
        assert.equal(eps1.length, 1, "folder-1 应有 1 个 episode");
        assert.equal(eps1[0].episodeNumber, 1);
        assert.equal(eps1[0].canvasId, "project-1", "v6 的 canvas 自动挂到 episode 1");
        assert.equal(Object.prototype.hasOwnProperty.call(db.getCanvasProject("project-1"), "folderId"), false, "旧 data_json.folderId 应清理");

        const eps2 = db.listDramaEpisodes("folder-2");
        assert.equal(eps2.length, 1, "folder-2 即使没画布也应有占位 episode");
        assert.equal(eps2[0].canvasId, null);
        assert.equal(db.listDramaEpisodes("folder-3").length, 0, "普通画布文件夹不应生成分集");

        // 4. 查画布归属走 episode.canvasId
        const epByCanvas = db.getDramaEpisodeByCanvasId("project-1");
        assert.equal(epByCanvas?.dramaId, "folder-1");

        // 5. listCanvasProjectsByDrama 返回 [{episode, canvas}]
        const items = db.listCanvasProjectsByDrama("folder-1");
        assert.equal(items.length, 1);
        assert.equal(items[0].episode.id, eps1[0].id);
        assert.equal(items[0].canvas?.id, "project-1");

        // 画布删除只解除绑定，不删除分集
        assert.equal(db.deleteCanvasProject("project-1"), 1);
        assert.equal(db.getDramaEpisode(eps1[0].id)?.canvasId, null);

        // 6. drama_episodes CRUD
        const newEp = db.upsertDramaEpisode({ dramaId: "folder-1", episodeNumber: 2, title: "第二集", synopsis: "她离开", fullPlot: "她离开王府后查明旧案。", canvasId: null });
        assert.equal(newEp.title, "第二集");
        assert.equal(newEp.fullPlot, "她离开王府后查明旧案。");
        assert.equal(db.listDramaEpisodes("folder-1").length, 2);
        assert.equal(db.deleteDramaEpisode(newEp.id), 1);
        assert.equal(db.listDramaEpisodes("folder-1").length, 1);

        // 7. 后续迁移同样完整执行
        const versions = db["db"].prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
        assert.deepEqual(versions.map((v) => v.version), [6, 7, 8, 9, 10]);
    } finally {
        db.close();
    }
});
