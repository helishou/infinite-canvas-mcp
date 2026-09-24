// 用法: cd web && node scripts/measure-conflict-baseline.mjs [projectId]
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const db = new DatabaseSync(join(homedir(), ".infinite-canvas", "runtime.sqlite"), { readOnly: true });
const projectId = process.argv[2] || "fQiJ4cR16K8tLsCB_iWV2";
const project = JSON.parse(db.prepare("SELECT data_json FROM canvas_projects WHERE id = ?").get(projectId).data_json);
const nodes = new Map(project.nodes.map((n) => [n.id, n]));
const fullSize = JSON.stringify(project).length;

const scope = (ops) => {
    const nodeIds = new Set(), connIds = new Set(), projectKeys = new Set();
    for (const op of ops) {
        if (op.id) nodeIds.add(String(op.id));
        if (op.nodeId) nodeIds.add(String(op.nodeId));
        if (Array.isArray(op.ids)) for (const x of op.ids) connIds.add(String(x));
        if (op.type === "update_project") for (const k of Object.keys(op.patch || {})) projectKeys.add(k);
    }
    const out = {
        v: 1, id: project.id, title: project.title, revision: Number(project.revision || 0),
        nodes: [...nodeIds].map((id) => nodes.get(id)).filter(Boolean),
        connections: (project.connections || []).filter((c) => connIds.has(String(c.id))),
    };
    for (const k of projectKeys) out[k] = project[k];
    return out;
};

const rows = db.prepare("SELECT operations_json FROM canvas_operation_batches WHERE project_id = ? ORDER BY rowid DESC LIMIT 300").all(projectId);
const sizes = [];
for (const row of rows) {
    let ops;
    try { ops = JSON.parse(row.operations_json); } catch { continue; }
    if (!Array.isArray(ops) || !ops.length) continue;
    sizes.push(JSON.stringify(scope(ops)).length);
}
if (!sizes.length) { console.error("没有可用样本（该画布无 operations_json 批次）"); process.exit(1); }
sizes.sort((a, b) => a - b);
const pick = (p) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))];
const mean = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
console.log(`样本 ${sizes.length} | 完整画布 ${fullSize.toLocaleString()} bytes`);
console.log(`p50 ${pick(0.5).toLocaleString()} (${(fullSize / pick(0.5)).toFixed(0)}x)  p90 ${pick(0.9).toLocaleString()}  mean ${mean.toLocaleString()}  max ${sizes.at(-1).toLocaleString()}`);
db.close();
