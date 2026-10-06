import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { backfillSceneInstances, getSceneInstance, listSceneInstances, syncSceneInstances } from "./scene-instances.js";

function fixture(t: { after: (fn: () => void) => void }) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scene-instances-"));
    const db = new BackendDatabase(path.join(directory, "runtime.sqlite"));
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    db.db.exec(`INSERT INTO canvas_folders (id, name, created_at) VALUES ('drama', 'Drama', '2026-01-01');
        INSERT INTO drama_projects (folder_id, outline, description, cover_storage_key, tags_json, updated_at)
            VALUES ('drama', '', '', NULL, '[]', '2026-01-01');
        INSERT INTO drama_episodes (id, drama_id, episode_number, title, synopsis, full_plot, canvas_id, created_at, updated_at)
            VALUES ('ep', 'drama', 1, 'Ep', '', '', NULL, '2026-01-01', '2026-01-01');`);
    return db;
}

/** The authored shape that used to lose every shot: occurrences SC01..SC03 while shots reference ENV_* registry ids. */
function source(overrides: Record<string, any> = {}) {
    return {
        script_scenes: [
            { id: "SC01", scene_id: "LOC1", scene_name: "第一场", kind: "action", beat_ids: ["b1"], text: "A" },
            { id: "SC02", scene_id: "LOC2", scene_name: "第二场", kind: "action", beat_ids: ["b2"], text: "B" },
            { id: "SC03", scene_id: "LOC3", scene_name: "第三场", kind: "action", beat_ids: ["b3"], text: "C" },
        ],
        scene_registry: [{ id: "ENV_YARD", name: "院子" }, { id: "ENV_ROOM", name: "堂屋" }],
        shots: [
            { id: "SH1", scene_id: "ENV_YARD", source_scene_id: "SC01" },
            { id: "SH2", scene_id: "ENV_ROOM", source_scene_id: "SC03" },
        ],
        ...overrides,
    };
}

test("one instance per script occurrence, keeping the environment as a reference", t => {
    const db = fixture(t);
    const result = syncSceneInstances(db, { kind: "episode", id: "ep" }, source());
    assert.deepEqual(result.created, ["SC01", "SC02", "SC03"]);
    const rows = listSceneInstances(db, { dramaId: "drama" });
    assert.deepEqual(rows.map(row => row.id), ["SC01", "SC02", "SC03"]);
    assert.deepEqual(rows.map(row => row.sceneOrder), [0, 1, 2]);
    // The occurrence keeps its own identity; the environment is only what it points at.
    assert.deepEqual(rows.map(row => row.environmentId), ["LOC1", "LOC2", "LOC3"]);
    assert.ok(rows.every(row => row.episodeId === "ep" && row.status === "active" && row.sourceHash));
});

test("reordering keeps identity and only moves order; renaming never changes the bound environment", t => {
    const db = fixture(t);
    syncSceneInstances(db, { kind: "episode", id: "ep" }, source());
    const before = new Map(listSceneInstances(db, { dramaId: "drama" }).map(row => [row.id, row]));
    const reordered = source();
    reordered.script_scenes = [reordered.script_scenes[2], reordered.script_scenes[0], reordered.script_scenes[1]];
    const result = syncSceneInstances(db, { kind: "episode", id: "ep" }, reordered);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.reordered.sort(), ["SC01", "SC02", "SC03"]);
    const after = new Map(listSceneInstances(db, { dramaId: "drama" }).map(row => [row.id, row]));
    assert.deepEqual(after.get("SC01")!.environmentId, before.get("SC01")!.environmentId);
    assert.equal(after.get("SC01")!.createdAt, before.get("SC01")!.createdAt, "identity survives a reorder");
    assert.equal(after.get("SC03")!.sceneOrder, 0);

    const renamed = source();
    renamed.script_scenes[0].scene_name = "第一场（改）";
    const renameResult = syncSceneInstances(db, { kind: "episode", id: "ep" }, renamed);
    assert.ok(renameResult.renamed.includes("SC01"));
    assert.equal(getSceneInstance(db, "SC01")!.title, "第一场（改）");
    assert.equal(getSceneInstance(db, "SC01")!.environmentId, "LOC1");
});

test("an unchanged script produces no writes, and a removed occurrence is orphaned rather than deleted", t => {
    const db = fixture(t);
    syncSceneInstances(db, { kind: "episode", id: "ep" }, source());
    const repeat = syncSceneInstances(db, { kind: "episode", id: "ep" }, source());
    assert.deepEqual(repeat.created, []);
    assert.deepEqual(repeat.updated, []);
    assert.equal(repeat.unchanged, 3);

    const shortened = source();
    shortened.script_scenes = shortened.script_scenes.slice(0, 2);
    const result = syncSceneInstances(db, { kind: "episode", id: "ep" }, shortened);
    assert.deepEqual(result.orphaned, ["SC03"]);
    // The row survives so its canvas, media and receipts keep their owner.
    assert.equal(getSceneInstance(db, "SC03")!.status, "orphaned");
    assert.equal(listSceneInstances(db, { dramaId: "drama" }).length, 2);
    assert.equal(listSceneInstances(db, { dramaId: "drama", includeOrphaned: true }).length, 3);
    // Re-adding the occurrence revives the same row instead of creating a second one.
    assert.deepEqual(syncSceneInstances(db, { kind: "episode", id: "ep" }, source()).created, []);
    assert.equal(getSceneInstance(db, "SC03")!.status, "active");
});

test("shot edits change the instance content hash without touching identity", t => {
    const db = fixture(t);
    syncSceneInstances(db, { kind: "episode", id: "ep" }, source());
    const before = getSceneInstance(db, "SC01")!;
    const moved = source();
    moved.shots = [{ id: "SH1", scene_id: "ENV_YARD", source_scene_id: "SC02" }, { id: "SH2", scene_id: "ENV_ROOM", source_scene_id: "SC03" }];
    const result = syncSceneInstances(db, { kind: "episode", id: "ep" }, moved);
    assert.ok(result.updated.includes("SC01"));
    const after = getSceneInstance(db, "SC01")!;
    assert.equal(after.id, before.id);
    assert.notEqual(after.sourceHash, before.sourceHash, "content change is visible to downstream");
});

test("backfill can be scoped to one drama without seeding sibling dramas", t => {
    const db = fixture(t);
    db.db.exec(`INSERT INTO canvas_folders (id, name, created_at) VALUES ('drama-2', 'Drama 2', '2026-01-01');
        INSERT INTO drama_projects (folder_id, outline, description, cover_storage_key, tags_json, updated_at)
            VALUES ('drama-2', '', '', NULL, '[]', '2026-01-01');
        INSERT INTO drama_episodes (id, drama_id, episode_number, title, synopsis, full_plot, canvas_id, created_at, updated_at)
            VALUES ('ep-2', 'drama-2', 1, 'Ep 2', '', '', NULL, '2026-01-01', '2026-01-01');`);
    const first = JSON.stringify({ director: { source: source() } });
    const secondSource = source();
    secondSource.script_scenes = secondSource.script_scenes.map((scene, index) => ({ ...scene, id: `SC1${index}` }));
    secondSource.shots = secondSource.shots.map((shot, index) => ({ ...shot, source_scene_id: `SC1${index === 0 ? 0 : 2}` }));
    const second = JSON.stringify({ director: { source: secondSource } });
    const insert = db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, 1, ?, NULL, 0, '2026-01-01')");
    insert.run("ep", first);
    insert.run("ep-2", second);

    assert.deepEqual(backfillSceneInstances(db, "drama"), { dramas: 1, created: 3, skipped: 0 });
    assert.equal(listSceneInstances(db, { dramaId: "drama" }).length, 3);
    assert.equal(listSceneInstances(db, { dramaId: "drama-2" }).length, 0);
    assert.deepEqual(backfillSceneInstances(db, "drama-2"), { dramas: 1, created: 3, skipped: 0 });
    assert.equal(listSceneInstances(db, { dramaId: "drama-2" }).length, 3);
});

test("environment registry entries do not become production scenes without authored occurrences", t => {
    const db = fixture(t);
    const result = syncSceneInstances(db, { kind: "episode", id: "ep" }, {
        script_scenes: [], scene_registry: [{ id: "ENV_ROOM", name: "A room" }],
        shots: [{ id: "SH1", scene_id: "ENV_ROOM" }],
    });
    assert.deepEqual(result.created, []);
    assert.equal(listSceneInstances(db, { dramaId: "drama" }).length, 0);
});

test("a canvas owner has no drama, so nothing is invented for it", t => {
    const db = fixture(t);
    const result = syncSceneInstances(db, { kind: "canvas", id: "some-canvas" }, source());
    assert.deepEqual(result.created, []);
    assert.equal(listSceneInstances(db, {}).length, 0);
    assert.throws(() => syncSceneInstances(db, { kind: "episode", id: "missing" }, source()), /无法登记制作场次/);
});

test("backfill seeds existing productions once and stays idempotent", t => {
    const db = fixture(t);
    const production = JSON.stringify({ director: { source: source() } });
    db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES ('ep', 1, ?, NULL, 0, '2026-01-01')").run(production);
    const first = backfillSceneInstances(db);
    assert.deepEqual(first, { dramas: 1, created: 3, skipped: 0 });
    const second = backfillSceneInstances(db);
    assert.deepEqual(second, { dramas: 1, created: 0, skipped: 0 });
    assert.equal(listSceneInstances(db, { dramaId: "drama" }).length, 3);
    // Backfill records occurrences only; it never prepares a canvas.
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM drama_scene_canvases").get()!.n, 0);
});
