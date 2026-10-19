import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BackendDatabase } from "../db.js";
import { CONFIG_FILE, DB_FILE, DEFAULT_PORT } from "../config.js";
import { createDatabaseSnapshot } from "../database-snapshots.js";
import { reconcileSharedAssetConsumers } from "../canvas/drama-asset-library.js";

type SharedSourceRow = { sourceProjectId: string; sourceNodeId: string; assetId: string; dramaId: string };
type EpisodePlan = { episodeId: string; canvasId: string; pictureBindings: number; h3Segments: number; unresolvedBindings: string[] };

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const projectFlag = args.indexOf("--project");
if (args.some(arg => !["--apply", "--project"].includes(arg) && args[args.indexOf(arg) - 1] !== "--project")
    || projectFlag >= 0 && (!args[projectFlag + 1] || args[projectFlag + 1].startsWith("--"))
    || args.filter(arg => arg === "--project").length > 1) {
    throw new Error("Usage: reconcile-shared-asset-consumers [--project <sharedCanvasId>] [--apply]");
}
const selectedProjectId = projectFlag >= 0 ? args[projectFlag + 1] : undefined;
if (!fs.existsSync(DB_FILE)) throw new Error(`数据库不存在，拒绝创建空库进行修复：${DB_FILE}`);

function parse(value: string | null | undefined) {
    try { return value ? JSON.parse(value) as Record<string, any> : {}; } catch { return {}; }
}
function rows(value: unknown) { return Array.isArray(value) ? value.filter(item => item && typeof item === "object") as Array<Record<string, any>> : []; }
function sourcesFor(db: DatabaseSync): SharedSourceRow[] {
    const records = db.prepare(`SELECT id, metadata_json FROM assets
        WHERE json_extract(metadata_json, '$.sharedAssetSource.sourceProjectId') IS NOT NULL`).all() as Array<{ id: string; metadata_json: string }>;
    const unique = new Map<string, SharedSourceRow>();
    for (const record of records) {
        const source = parse(record.metadata_json).sharedAssetSource;
        if (!source?.sourceProjectId || !source?.sourceNodeId || !source?.dramaId) continue;
        const key = `${source.sourceProjectId}\0${source.sourceNodeId}`;
        unique.set(key, { sourceProjectId: String(source.sourceProjectId), sourceNodeId: String(source.sourceNodeId), assetId: String(source.assetId || record.id), dramaId: String(source.dramaId) });
    }
    return [...unique.values()].filter(source => !selectedProjectId || source.sourceProjectId === selectedProjectId);
}
function inspect(db: DatabaseSync, source: SharedSourceRow): EpisodePlan[] {
    const episodes = db.prepare(`SELECT e.id AS episodeId, e.canvas_id AS canvasId, p.draft_json AS draft
        FROM drama_episodes e JOIN episode_productions p ON p.episode_id=e.id WHERE e.drama_id=?`).all(source.dramaId) as Array<{ episodeId: string; canvasId: string | null; draft: string }>;
    const result: EpisodePlan[] = [];
    for (const episode of episodes) {
        const draft = parse(episode.draft), director = draft.director;
        const plans = rows(director?.source?.asset_plan);
        const matchedPlans = plans.filter(plan => plan.sharedSource?.sourceProjectId === source.sourceProjectId && plan.sharedSource?.sourceNodeId === source.sourceNodeId);
        if (!matchedPlans.length) continue;
        const projectRow = episode.canvasId ? db.prepare("SELECT data_json FROM canvas_projects WHERE id=?").get(episode.canvasId) as { data_json?: string } | undefined : undefined;
        const nodes = rows(parse(projectRow?.data_json).nodes);
        const linkedNodeIds = new Set(nodes.filter(node => {
            const reference = node.metadata?.sharedAssetReference, origin = node.metadata?.sharedAssetOrigin;
            return reference?.sourceProjectId === source.sourceProjectId && reference?.sourceNodeId === source.sourceNodeId
                || origin?.sourceProjectId === source.sourceProjectId && origin?.sourceNodeId === source.sourceNodeId;
        }).map(node => String(node.id || "")));
        const subjects = rows(director.source?.subject_registry);
        const pictureBindings = subjects.reduce((count, subject) => count + rows(subject.pictureBindings)
            .filter(binding => binding.sourceNode?.projectId === episode.canvasId && linkedNodeIds.has(String(binding.sourceNode?.nodeId || ""))).length, 0);
        const unresolvedBindings = matchedPlans.flatMap(plan => subjects.flatMap(subject => rows(subject.pictureBindings)
            .filter(binding => String(binding.assetId || "") === String(plan.id || plan.entity_id || "")
                && (binding.sourceNode?.projectId !== episode.canvasId || !linkedNodeIds.has(String(binding.sourceNode?.nodeId || ""))))
            .map(binding => `subject:${String(subject.id || "unknown")}/binding:${String(binding.id || "unknown")}`)));
        const h3Segments = nodes.filter(node => String(node.type || "").startsWith("minimax-h3:"))
            .flatMap(node => rows(node.metadata?.segments)).filter(segment => rows(segment.referenceBindings)
                .some(binding => linkedNodeIds.has(String(binding.sourceNodeId || "")))).length;
        result.push({ episodeId: episode.episodeId, canvasId: String(episode.canvasId || ""), pictureBindings, h3Segments, unresolvedBindings });
    }
    return result;
}
async function assertBackendStopped() {
    let port = DEFAULT_PORT;
    try { port = Number(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).port) || DEFAULT_PORT; } catch { /* use configured default */ }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
        throw new Error(`Backend 正在监听 127.0.0.1:${port}；批量修复需在服务停止时运行，避免绕过其事务事件广播`);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("Backend 正在监听")) throw error;
        const cause = (error as NodeJS.ErrnoException).cause as NodeJS.ErrnoException | undefined;
        const code = typeof cause?.code === "string" ? cause.code : undefined;
        if (controller.signal.aborted || !code || !["ECONNREFUSED", "ECONNRESET", "ENOTFOUND"].includes(code)) {
            throw new Error("无法确认 Backend 已停止，拒绝离线批量修复");
        }
    } finally { clearTimeout(timer); }
}

const reader = new DatabaseSync(DB_FILE, { readOnly: true });
let sources: SharedSourceRow[];
let report: Array<{ source: SharedSourceRow; episodes: EpisodePlan[] }>;
try {
    sources = sourcesFor(reader);
    report = sources.map(source => ({ source, episodes: inspect(reader, source) }));
} finally { reader.close(); }
const summary = { sharedSources: sources.length, affectedEpisodes: report.reduce((n, item) => n + item.episodes.length, 0),
    pictureBindings: report.reduce((n, item) => n + item.episodes.reduce((m, episode) => m + episode.pictureBindings, 0), 0),
    h3Segments: report.reduce((n, item) => n + item.episodes.reduce((m, episode) => m + episode.h3Segments, 0), 0),
    unresolvedBindings: report.reduce((n, item) => n + item.episodes.reduce((m, episode) => m + episode.unresolvedBindings.length, 0), 0) };
if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, summary, sources: report }, null, 2));
    process.exit(0);
}

await assertBackendStopped();
const db = new BackendDatabase(DB_FILE);
try {
    const backup = createDatabaseSnapshot(db.db, DB_FILE, "pre-shared-asset-rebind");
    const check = new DatabaseSync(backup, { readOnly: true });
    try {
        if (check.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("共享素材重绑前备份完整性检查失败，未开始修复");
    } finally { check.close(); }
    const results = report.map(item => reconcileSharedAssetConsumers(db, item.source.sourceProjectId));
    console.log(JSON.stringify({ ok: true, dryRun: false, backup, summary, results }, null, 2));
} finally { db.close(); }
