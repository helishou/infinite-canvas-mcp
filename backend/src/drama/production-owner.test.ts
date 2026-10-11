import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { EpisodeProductionService } from "./production.js";
import { emptyEpisodeProduction } from "@basketikun/canvas-agent/drama/production-contract";

const EMPTY_PRODUCTION = JSON.stringify(emptyEpisodeProduction());

function fixture(t: test.TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "production-owner-"));
    const db = new BackendDatabase(path.join(directory, "db.sqlite"));
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    db.upsertCanvasFolder({ id: "drama", name: "Drama", createdAt: new Date().toISOString(), isDrama: true });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "" });
    const episode = new EpisodeProductionService(db, undefined, directory, false, () => {});
    const canvas = new EpisodeProductionService(db, undefined, directory, true, () => {});
    return { db, episode, canvas };
}

/** A fresh draft has no director, which is exactly what the production record layer stores and reads back. */
function seed(t: test.TestContext) {
    const f = fixture(t);
    f.db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES ('ep', 1, ?, NULL, 0, '2026-01-01')").run(EMPTY_PRODUCTION);
    return f;
}

test("an episode production record reads and writes only the episode table", t => {
    const f = seed(t);
    assert.equal(f.episode.get("ep").revision, 1);
    const edited = f.episode.edit("ep", { operationId: "owner-row", expectedRevision: 1, ops: [{ type: "set_director_brief", brief: "Only this episode" }] });
    assert.equal(edited.revision, 2);
    assert.equal(f.db.db.prepare("SELECT revision FROM episode_productions WHERE episode_id='ep'").get()!.revision, 2);
});

test("continuity upgrade preview sees in-flight native media tasks for its exact owner", t => {
    const f = fixture(t);
    const now = new Date().toISOString();
    f.db.db.prepare(`INSERT INTO tasks (id, kind, status, progress, input_json, params_json, created_at, updated_at)
        VALUES (?, 'canvas-h3-run', 'awaiting_confirmation', 0, '{}', '{}', ?, ?)`).run("native-active", now, now);
    f.db.db.prepare(`INSERT INTO production_task_bindings
        (task_id, owner_kind, owner_id, version, source_hash, target_kind, target_id, project_id, node_id, targets_json, status)
        VALUES (?, 'episode', 'ep', 1, ?, 'segment', 'SEG01', 'canvas', 'h3-node', ?, 'submitted')`).run("native-active", "a".repeat(64), JSON.stringify([{ targetId: "SEG01", segmentId: "clip-1" }]));
    f.db.db.prepare(`INSERT INTO tasks (id, kind, status, progress, input_json, params_json, created_at, updated_at)
        VALUES (?, 'canvas-h3-run', 'running', 0, '{}', '{}', ?, ?)`).run("other-owner-active", now, now);
    f.db.db.prepare(`INSERT INTO production_task_bindings
        (task_id, owner_kind, owner_id, version, source_hash, target_kind, target_id, project_id, node_id, targets_json, status)
        VALUES (?, 'episode', 'elsewhere', 1, ?, 'segment', 'SEG99', 'other', 'h3-node', ?, 'submitted')`).run("other-owner-active", "b".repeat(64), JSON.stringify([{ targetId: "SEG99", segmentId: "clip-99" }]));
    assert.deepEqual(f.episode.continuityUpgradeActiveRuns("ep"), [{ runId: "native-active", status: "awaiting_confirmation", targets: [{ targetId: "SEG01", segmentId: "clip-1" }] }]);
});

test("the canvas owner keeps its own project-keyed table", t => {
    const f = fixture(t);
    f.db.upsertDramaEpisode({ id: "plain", dramaId: "drama", episodeNumber: 2, title: "Plain Episode", synopsis: "" });
    f.db.createCanvasProject({ id: "plain", title: "Plain", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 } });
    f.db.db.prepare("INSERT INTO canvas_productions (project_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, 5, ?, NULL, 2, ?)").run("plain", EMPTY_PRODUCTION, "2026-01-01");
    assert.equal(f.canvas.get("plain").revision, 5);
    assert.equal(f.canvas.get("plain").publishedVersion, 2);
    assert.equal(f.episode.get("plain").revision, 0);
});

test("an unmapped table name is refused instead of silently querying the wrong table", t => {
    const f = fixture(t);
    const prepare = (f.canvas as unknown as { prepare: (sql: string) => unknown }).prepare.bind(f.canvas);
    // A production-worded table that is not any owner's formal table is refused before SQLite sees it.
    assert.throws(() => prepare("SELECT * FROM episode_widgets"), /制作存储映射不包含表 episode_widgets/);
    assert.throws(() => prepare("SELECT 1 FROM scene_drafts"), /制作存储映射不包含表 scene_drafts/);
    // The owner's own table resolves, including its key column.
    assert.doesNotThrow(() => prepare("SELECT 1 FROM episode_productions WHERE episode_id=?"));
    for (const table of ["episode_productions", "episode_production_operations", "episode_production_versions", "episode_production_runs", "episode_production_batches"]) {
        assert.doesNotThrow(() => prepare(`SELECT 1 FROM ${table} WHERE episode_id=?`));
    }
});
