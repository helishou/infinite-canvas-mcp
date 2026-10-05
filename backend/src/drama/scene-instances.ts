import crypto from "node:crypto";
import { productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";
import type { BackendDatabase } from "../db.js";

type Source = Record<string, any>;
/** Mirrors productionSceneEntries(): one authored script occurrence, with the environment it merely references. */
type SceneEntry = { id: string; environmentId: string; title: string; text: string; shotIds: string[] };

export type SceneInstanceRow = {
    id: string; dramaId: string; episodeId: string | null; sourceSceneKey: string; environmentId: string | null;
    sceneOrder: number; title: string; sourceHash: string; status: "active" | "orphaned"; createdAt: string; updatedAt: string;
};

/** Identity is the authored occurrence key plus its own content, never its position in an array. */
function occurrenceHash(entry: SceneEntry, source: Source): string {
    return crypto.createHash("sha256").update(JSON.stringify({
        id: entry.id, environmentId: entry.environmentId, title: entry.title,
        text: entry.text, shotIds: entry.shotIds,
        shots: (Array.isArray(source.shots) ? source.shots : []).filter((shot: Source) => entry.shotIds.includes(String(shot.id)))
            .map((shot: Source) => ({ id: String(shot.id), scene_id: String(shot.scene_id || ""), source_scene_id: String(shot.source_scene_id || "") })),
    })).digest("hex");
}

function readRow(row: Record<string, any>): SceneInstanceRow {
    return {
        id: String(row.id), dramaId: String(row.drama_id), episodeId: row.episode_id ? String(row.episode_id) : null,
        sourceSceneKey: String(row.source_scene_key), environmentId: row.environment_id ? String(row.environment_id) : null,
        sceneOrder: Number(row.scene_order), title: String(row.title || ""), sourceHash: String(row.source_hash || ""),
        status: String(row.status || "active") as SceneInstanceRow["status"], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
}

export function listSceneInstances(db: BackendDatabase, filter: { dramaId?: string; episodeId?: string; includeOrphaned?: boolean } = {}): SceneInstanceRow[] {
    const where: string[] = [], params: string[] = [];
    if (filter.dramaId) { where.push("drama_id = ?"); params.push(filter.dramaId); }
    if (filter.episodeId) { where.push("episode_id = ?"); params.push(filter.episodeId); }
    if (!filter.includeOrphaned) where.push("status = 'active'");
    const rows = db.db.prepare(`SELECT * FROM drama_scene_instances ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY drama_id, scene_order, rowid`).all(...params) as Array<Record<string, any>>;
    return rows.map(readRow);
}

export function getSceneInstance(db: BackendDatabase, id: string): SceneInstanceRow | null {
    const row = db.db.prepare("SELECT * FROM drama_scene_instances WHERE id=?").get(id) as Record<string, any> | undefined;
    return row ? readRow(row) : null;
}

/**
 * A scene instance belongs to a drama, so a production owned by a plain canvas has no occurrence to record.
 * Returning null keeps the caller explicit instead of inventing a drama for an unowned canvas.
 */
export function syncSceneInstances(db: BackendDatabase, owner: { kind: "episode" | "scene" | "canvas"; id: string }, source: Source): { created: string[]; updated: string[]; renamed: string[]; reordered: string[]; unchanged: number; orphaned: string[] } {
    if (owner.kind !== "episode") return { created: [], updated: [], renamed: [], reordered: [], unchanged: 0, orphaned: [] };
    const episode = db.getDramaEpisode(owner.id);
    if (!episode?.dramaId) throw new Error("分集不属于任何剧目，无法登记制作场次");
    const entries = productionSceneEntries(source);
    const now = new Date().toISOString();
    const created: string[] = [], updated: string[] = [], renamed: string[] = [], reordered: string[] = [], orphaned: string[] = [];
    let unchanged = 0;
    const seen = new Set<string>();
    const insert = db.db.prepare(`INSERT OR IGNORE INTO drama_scene_instances
        (id, drama_id, episode_id, source_scene_key, environment_id, scene_order, title, source_hash, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`);
    const update = db.db.prepare("UPDATE drama_scene_instances SET environment_id=?, scene_order=?, title=?, source_hash=?, status='active', updated_at=? WHERE id=?");
    for (const [order, entry] of entries.entries()) {
        const hash = occurrenceHash(entry, source);
        seen.add(entry.id);
        // Read before writing: an INSERT OR IGNORE that just created the row would otherwise look pre-existing.
        const current = getSceneInstance(db, entry.id);
        if (!current) {
            insert.run(entry.id, episode.dramaId, episode.id, entry.id, entry.environmentId, order, entry.title, hash, now, now);
            created.push(entry.id);
            continue;
        }
        if (current.sourceHash === hash && current.sceneOrder === order && current.environmentId === entry.environmentId && current.status === "active") { unchanged++; continue; }
        // A rename never changes identity, canvas binding, or the environment it references.
        if (current.title !== entry.title) renamed.push(entry.id);
        if (current.sceneOrder !== order) reordered.push(entry.id);
        update.run(entry.environmentId, order, entry.title, hash, now, entry.id);
        updated.push(entry.id);
    }
    // A removed occurrence keeps its canvas, media and receipts; only its active status ends.
    for (const prior of listSceneInstances(db, { dramaId: episode.dramaId, episodeId: episode.id, includeOrphaned: true })) {
        if (seen.has(prior.id) || prior.status === "orphaned") continue;
        db.db.prepare("UPDATE drama_scene_instances SET status='orphaned', updated_at=? WHERE id=?").run(now, prior.id);
        orphaned.push(prior.id);
    }
    return { created, updated, renamed, reordered, unchanged, orphaned };
}

/** Seed every occurrence that existing episode productions already authored, without touching their canvases or media. */
export function backfillSceneInstances(db: BackendDatabase): { dramas: number; created: number; skipped: number } {
    const touched = new Set<string>();
    let created = 0, skipped = 0;
    const productions = db.db.prepare(`SELECT p.episode_id AS owner_id, p.draft_json AS draft_json FROM episode_productions p
        JOIN drama_episodes e ON e.id = p.episode_id WHERE e.drama_id IS NOT NULL`).all() as Array<{ owner_id: string; draft_json: string }>;
    db.db.exec("BEGIN IMMEDIATE");
    try {
        for (const row of productions) {
            const dramaId = db.getDramaEpisode(row.owner_id)?.dramaId || "";
            const source = (() => { try { return (JSON.parse(row.draft_json).director || {}).source || {}; } catch { return null; } })();
            if (!dramaId || !source || !Array.isArray(source.script_scenes) || !source.script_scenes.length) { skipped++; continue; }
            touched.add(dramaId);
            created += syncSceneInstances(db, { kind: "episode", id: row.owner_id }, source).created.length;
        }
        db.db.exec("COMMIT");
    } catch (error) { db.db.exec("ROLLBACK"); throw error; }
    return { dramas: touched.size, created, skipped };
}
