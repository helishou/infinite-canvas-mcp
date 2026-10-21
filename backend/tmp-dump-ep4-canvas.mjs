import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const rootConfig = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".infinite-canvas-root.json"), "utf8")); } catch { return {}; } })();
const dataDir = process.env.INFINITE_CANVAS_DATA_DIR ? path.resolve(process.env.INFINITE_CANVAS_DATA_DIR) : rootConfig.dataDir ? path.resolve(rootConfig.dataDir) : path.join(os.homedir(), ".infinite-canvas");
const db = new DatabaseSync(path.join(dataDir, "runtime.sqlite"), { readOnly: true });
const canvasId = "production-episode-9e06c187c046b6e43b3a81a9";
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
const projTable = tables.includes("canvas_projects") ? "canvas_projects" : tables.find(t => t.includes("project"));
const row = db.prepare(`SELECT * FROM ${projTable} WHERE id = ?`).get(canvasId);
if (!row) { console.log("no project", projTable, tables.filter(t=>t.includes("project"))); process.exit(0); }
const project = JSON.parse(row.data_json || row.json || row.project_json || "{}");
const nodes = project.nodes || [];
console.log("revision:", row.revision, "nodes:", nodes.length);
for (const n of nodes) {
  const m = n.metadata || {};
  console.log(JSON.stringify({
    id: n.id, type: n.type, title: n.title,
    ownerKind: m.productionOwnerKind, ownerId: m.productionOwnerId,
    sceneId: m.productionSceneId, assetId: m.productionAssetId, shotId: m.productionShotId,
    segments: Array.isArray(m.segments) ? m.segments.map(s => ({ id: s.id, target: s.productionClipProjection?.targetId })) : undefined,
  }));
}
db.close();
