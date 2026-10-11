import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { DB_FILE } from "../config.js";

// Manual only. Default is read-only:
//   npm run purge-scene-productions                 # 预览全部场次
//   npm run purge-scene-productions -- --apply      # 执行
//   npm run purge-scene-productions -- --drama <id> --apply
//
// Removes scene-production data and the scene canvas that belongs to it. The episode canvas,
// episode production records, shared-asset canvas and every unrelated feature are untouched.
const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith("--"));
const apply = flags.includes("--apply");
const dramaAt = args.indexOf("--drama");
const dramaId = dramaAt >= 0 ? args[dramaAt + 1] : undefined;
if (flags.some((flag) => flag !== "--apply" && flag !== "--drama")) throw new Error("Usage: purge-scene-productions [--drama <dramaId>] [--apply]");
if (dramaAt >= 0 && (!dramaId || dramaId.startsWith("--"))) throw new Error("--drama 需要一个剧目 ID");
if (!fs.existsSync(DB_FILE)) throw new Error("数据库不存在，拒绝创建空库进行维护");

const db = new DatabaseSync(DB_FILE, { readOnly: !apply });
const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(",");
const scalar = (sql: string, ...params: string[]) => Number((db.prepare(sql).get(...params) as { n: number } | undefined)?.n ?? 0);

try {
    db.exec("PRAGMA foreign_keys = ON");
    const where = dramaId ? "WHERE drama_id = ?" : "";
    const params: string[] = dramaId ? [dramaId] : [];
    const instances = db.prepare(`SELECT id, drama_id, title, status FROM drama_scene_instances ${where} ORDER BY drama_id, scene_order`).all(...params) as Array<Record<string, unknown>>;
    const sceneIds = instances.map((row) => String(row.id));

    const bound = sceneIds.length
        ? db.prepare(`SELECT scene_id, canvas_id FROM drama_scene_canvases WHERE scene_id IN (${placeholders(sceneIds.length)})`).all(...sceneIds) as Array<Record<string, unknown>>
        : [];
    const boundCanvasIds = new Set(bound.map((row) => String(row.canvas_id)));
    // A scene canvas that lost its binding is still this feature's artifact and must not survive.
    const orphanCanvases = (db.prepare("SELECT id FROM canvas_projects WHERE id LIKE 'production-scene-%'").all() as Array<Record<string, unknown>>)
        .map((row) => String(row.id)).filter((id) => !boundCanvasIds.has(id) && !(db.prepare("SELECT 1 FROM drama_scene_canvases WHERE canvas_id = ?").get(id)));
    const canvasIds = [...new Set([...boundCanvasIds, ...orphanCanvases])];

    const held = canvasIds.filter((id) => db.prepare("SELECT 1 FROM drama_episodes WHERE canvas_id = ?").get(id)
        || db.prepare("SELECT 1 FROM drama_projects WHERE shared_asset_canvas_id = ?").get(id));
    const removable = canvasIds.filter((id) => !held.includes(id));

    const inventory = sceneIds.length ? {
        sceneProductions: scalar(`SELECT COUNT(*) AS n FROM scene_productions WHERE scene_id IN (${placeholders(sceneIds.length)})`, ...sceneIds),
        sceneCanvases: scalar(`SELECT COUNT(*) AS n FROM drama_scene_canvases WHERE scene_id IN (${placeholders(sceneIds.length)})`, ...sceneIds),
        versions: scalar(`SELECT COUNT(*) AS n FROM scene_production_versions WHERE scene_id IN (${placeholders(sceneIds.length)})`, ...sceneIds),
        runs: scalar(`SELECT COUNT(*) AS n FROM scene_production_runs WHERE scene_id IN (${placeholders(sceneIds.length)})`, ...sceneIds),
        batches: scalar(`SELECT COUNT(*) AS n FROM scene_production_batches WHERE scene_id IN (${placeholders(sceneIds.length)})`, ...sceneIds),
        operations: scalar(`SELECT COUNT(*) AS n FROM scene_production_operations WHERE scene_id IN (${placeholders(sceneIds.length)})`, ...sceneIds),
    } : { sceneProductions: 0, sceneCanvases: 0, versions: 0, runs: 0, batches: 0, operations: 0 };

    const plan = {
        ok: held.length === 0, dryRun: !apply, dramaId: dramaId ?? null,
        scenes: instances.map((row) => ({ id: String(row.id), dramaId: String(row.drama_id), title: String(row.title || ""), status: String(row.status || "") })),
        canvases: removable, heldCanvases: held, ...inventory,
        episodeCanvasIntact: (db.prepare("SELECT COUNT(*) AS n FROM canvas_projects WHERE id LIKE 'production-episode-%'").get() as { n: number }).n,
    };

    if (!apply) {
        console.log(JSON.stringify(plan));
        if (held.length) process.exitCode = 1;
    } else {
        db.exec("BEGIN IMMEDIATE");
        try {
            // Scene tables cascade from the instance row; the canvas binding is released with it.
            const removedScenes = db.prepare(`DELETE FROM drama_scene_instances ${where}`).run(...params).changes;
            const removedCanvases = removable.length
                ? db.prepare(`DELETE FROM canvas_projects WHERE id IN (${placeholders(removable.length)})`).run(...removable).changes
                : 0;
            // These tables carry a project id without a foreign key, so they need an explicit sweep.
            for (const id of removable) for (const table of ["production_task_bindings", "generation_logs", "mcp_observability_events"]) db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id);
            db.exec("COMMIT");
            console.log(JSON.stringify({ ...plan, dryRun: false, removedScenes, removedCanvases, removedOperations: db.prepare(`SELECT COUNT(*) AS n FROM scene_production_operations`).get() }));
        } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
} finally { db.close(); }
