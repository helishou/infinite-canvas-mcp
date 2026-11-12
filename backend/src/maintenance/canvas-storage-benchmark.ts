import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createStoredProject, readStoredProjectRows, readProjectHeader, readOrderedNodes, readOrderedConnections, readRawProject, writeStoredProjectDelta } from "../stores/canvas-project-storage.js";
import { createCanvasProjectStorageSchema } from "../canvas/project-storage-migration.js";
import { reconstructCanvasHistory } from "../canvas/history-maintenance.js";
import { applyCanvasProjectOperations } from "../canvas/project-ops.js";

export type BenchmarkConfig = { sizes: number[]; warmups: number; samples: number; seed: number };
export const DEFAULT_BENCHMARK_CONFIG: BenchmarkConfig = { sizes: [200, 1000, 5000], warmups: 5, samples: 30, seed: 0x51c0ffee };
function random(seed: number) { let state = seed >>> 0; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000; }; }
function fixture(count: number, h3: boolean, seed: number) {
    const rand = random(seed);
    return { id: "p", revision: 1, title: "Synthetic benchmark", referenceCatalog: Array.from({ length: count }, (_, i) => ({ id: `asset-${i}`, sourceNodeId: `n${i}`, mediaId: `media-${i}` })), nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, type: h3 ? "minimax-h3:video" : "image", x: Math.round(rand() * 4000), y: Math.round(rand() * 3000), width: 260, height: 180, metadata: h3 ? { segments: Array.from({ length: 5 }, (_, segment) => ({ prompt: `Shot ${i}.${segment}: ${"A grounded cinematic take with coherent movement, stable identity, natural lighting, deliberate framing, clean sound continuity, and detailed environmental texture. ".repeat(3)}`, taskMode: "ref2va", references: Array.from({ length: 3 }, (_, j) => ({ id: `asset-${i}-${j}`, sourceNodeId: `n${(i + j + 1) % count}`, label: `ref-${j}`, role: "style" })), parameters: { duration: 6, resolution: "1080p", seed: i + segment } })) } : { label: `node ${i}`, color: "#718096" } })), connections: Array.from({ length: Math.max(0, count - 1) }, (_, i) => ({ fromNodeId: `n${i}`, toNodeId: `n${i + 1}` })) };
}
function schema(db: DatabaseSync, layout: "legacy" | "split") {
    const version = layout === "legacy" ? 50 : 51;
    db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(${version});`);
    db.exec("CREATE TABLE canvas_collaboration_checkpoints(project_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,data_json TEXT NOT NULL); CREATE TABLE canvas_operation_batches(operation_id TEXT PRIMARY KEY,project_id TEXT,base_revision INTEGER,revision INTEGER,operations_json TEXT,created_at TEXT);");
    if (layout === "legacy") db.exec("CREATE TABLE canvas_projects(id TEXT PRIMARY KEY,data_json TEXT NOT NULL,updated_at TEXT NOT NULL);");
    else { db.exec("CREATE TABLE canvas_projects(id TEXT PRIMARY KEY,data_json TEXT NOT NULL,updated_at TEXT NOT NULL);"); createCanvasProjectStorageSchema(db); }
}
function writeProject(db: DatabaseSync, project: ReturnType<typeof fixture>, layout: "legacy" | "split", revision: number, scenario: "single-edit" | "batch-16-edit" | "reorder") {
    let prior: ReturnType<typeof readStoredProjectRows> = null;
    let persisted: any = null;
    if (layout === "legacy") {
        const row = db.prepare("SELECT data_json FROM canvas_projects WHERE id='p'").get() as { data_json: string } | undefined;
        if (row) persisted = JSON.parse(row.data_json);
    } else {
        prior = readStoredProjectRows(db, "p");
        if (prior) {
            persisted = { ...prior.header };
            if (prior.nodesPresent) persisted.nodes = prior.nodes;
            if (prior.connectionsPresent) persisted.connections = prior.connections;
        }
    }
    const source = persisted ?? project;
    const changed = { ...source, revision, nodes: source.nodes.map((node: any, i: number) => (scenario === "single-edit" ? i === 0 : scenario === "batch-16-edit" ? i < 16 : false) ? { ...node, x: node.x + revision } : node) };
    if (scenario === "reorder") changed.nodes.reverse();
    db.exec("BEGIN");
    try {
    if (layout === "legacy") {
        const before = db.prepare("SELECT total_changes() AS n").get() as { n: number };
        db.prepare("INSERT INTO canvas_projects(id,data_json,updated_at) VALUES('p',?,'now') ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json").run(JSON.stringify(changed));
        const after = db.prepare("SELECT total_changes() AS n").get() as { n: number };
        const n = after.n - before.n, payloadBytes = Buffer.byteLength(JSON.stringify(changed)); db.exec("COMMIT"); return { rows: n, payloadBytes };
    }
    if (!prior) { createStoredProject(db, changed); db.exec("COMMIT"); return { rows: changed.nodes.length + changed.connections.length + 1, payloadBytes: 0 }; }
    const before = db.prepare("SELECT total_changes() AS n").get() as { n: number };
    writeStoredProjectDelta(db, prior, changed);
    const after = db.prepare("SELECT total_changes() AS n").get() as { n: number };
    const n = after.n - before.n;
    const changedCount = scenario === "single-edit" ? 1 : scenario === "batch-16-edit" ? Math.min(16, changed.nodes.length) : changed.nodes.length;
    const { nodes, connections: _connections, ...header } = changed;
    const payloadBytes = Buffer.byteLength(JSON.stringify(header)) + nodes.slice(0, changedCount).reduce((sum: number, node: unknown) => sum + Buffer.byteLength(JSON.stringify(node)), 0);
    db.exec("COMMIT"); return { rows: n, payloadBytes };
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
export function runCanvasStorageBenchmark(config: BenchmarkConfig = DEFAULT_BENCHMARK_CONFIG) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-storage-bench-"));
    try {
        const results: Array<Record<string, unknown>> = [];
        for (const size of config.sizes) for (const h3 of [false, true]) for (const layout of ["legacy", "split"] as const) {
            const file = path.join(root, `${size}-${h3}-${layout}.sqlite`), db = new DatabaseSync(file);
            try {
                schema(db, layout); const project = fixture(size, h3, config.seed + size + Number(h3));
                writeProject(db, project, layout, 1, "single-edit");
                db.prepare("INSERT INTO canvas_collaboration_checkpoints VALUES('p',1,?)").run(JSON.stringify(project));
                const historyOperations = Array.from({ length: 8 }, (_, i) => ({ type: "add_node", id: `history-${i}`, nodeType: "text", title: `history ${i}`, position: { x: 20000 + i * 320, y: 0 }, width: 300, height: 180, metadata: { content: `Synthetic history operation ${i}` } }));
                const historyFixture = structuredClone(project); applyCanvasProjectOperations(historyFixture, historyOperations as never, { committedReplay: true });
                if (historyFixture.nodes.length !== project.nodes.length + historyOperations.length) throw new Error("Synthetic history seed did not replay");
                db.prepare("INSERT INTO canvas_operation_batches VALUES('history-1','p',1,2,?, 'now')").run(JSON.stringify(historyOperations));
                db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
                const writeScenarios = ["single-edit", "batch-16-edit", "reorder"] as const;
                for (const scenario of writeScenarios) {
                    for (let i = 0; i < config.warmups; i++) writeProject(db, project, layout, i + 2, scenario);
                    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
                    const times: number[] = []; let rowWrites = 0, payloadBytes = 0, peakWalBytes = 0; const heapBefore = process.memoryUsage().heapUsed;
                    for (let i = 0; i < config.samples; i++) {
                        const start = performance.now(); const write = writeProject(db, project, layout, config.warmups + i + 2, scenario); times.push(performance.now() - start); rowWrites += write.rows; payloadBytes += write.payloadBytes;
                        const walPath = `${file}-wal`; if (fs.existsSync(walPath)) peakWalBytes = Math.max(peakWalBytes, fs.statSync(walPath).size);
                    }
                    const wal = `${file}-wal`;
                    results.push({ size, kind: h3 ? "h3" : "ordinary", layout, scenario, warmups: config.warmups, samples: config.samples,
                        medianMs: percentile(times, 0.5), p95Ms: percentile(times, 0.95), rowWrites, payloadBytes,
                        walBytes: fs.existsSync(wal) ? fs.statSync(wal).size : 0, peakWalBytes, heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore });
                }
                const selected = project.nodes.slice(0, Math.min(12, project.nodes.length)).map(node => node.id);
                const readScenarios = h3 ? ["selected-read", "full-read", "history-replay", "h3-context"] as const : ["selected-read", "full-read", "history-replay"] as const;
                for (const scenario of readScenarios) {
                    let selectedNodes = 0;
                    const runRead = () => {
                        const start = performance.now();
                        if (scenario === "selected-read") selectedNodes += layout === "split" ? readOrderedNodes(db, "p", selected).length : JSON.parse((db.prepare("SELECT data_json FROM canvas_projects WHERE id='p'").get() as any).data_json).nodes.filter((n: any) => selected.includes(n.id)).length;
                        else if (scenario === "full-read") {
                            const full = layout === "split" ? readRawProject(db, "p") : JSON.parse((db.prepare("SELECT data_json FROM canvas_projects WHERE id='p'").get() as any).data_json);
                            selectedNodes += (full?.nodes as unknown[]).length;
                        } else if (scenario === "history-replay") selectedNodes += (reconstructCanvasHistory(db, "p", 2).nodes as unknown[]).length;
                        else {
                            const target = `n${Math.floor(size / 2)}`;
                            if (layout === "split") {
                                const targetNode = readOrderedNodes(db, "p", [target])[0] as any;
                                const sourceIds = (targetNode?.metadata?.segments?.[0]?.references ?? []).map((ref: any) => ref.sourceNodeId).filter(Boolean);
                                const sources = readOrderedNodes(db, "p", sourceIds);
                                const related = readOrderedConnections(db, "p", [target, ...sourceIds]);
                                const header = readProjectHeader(db, "p");
                                selectedNodes += sources.length + related.length + Number(Boolean(header?.referenceCatalog));
                            } else {
                                const full = JSON.parse((db.prepare("SELECT data_json FROM canvas_projects WHERE id='p'").get() as any).data_json);
                                const targetNode = full.nodes.find((node: any) => node.id === target);
                                const sourceIds = (targetNode?.metadata?.segments?.[0]?.references ?? []).map((ref: any) => ref.sourceNodeId);
                                selectedNodes += full.nodes.filter((node: any) => sourceIds.includes(node.id)).length + full.connections.filter((edge: any) => [target, ...sourceIds].includes(edge.fromNodeId) || [target, ...sourceIds].includes(edge.toNodeId)).length + Number(Boolean(full.referenceCatalog));
                            }
                        }
                        return performance.now() - start;
                    };
                    for (let i = 0; i < config.warmups; i++) runRead();
                    const times: number[] = [], heapBefore = process.memoryUsage().heapUsed;
                    for (let i = 0; i < config.samples; i++) times.push(runRead());
                    results.push({ size, kind: h3 ? "h3" : "ordinary", layout, scenario, warmups: config.warmups, samples: config.samples,
                        medianMs: percentile(times, 0.5), p95Ms: percentile(times, 0.95), rowWrites: 0, payloadBytes: 0, walBytes: 0,
                        heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore, selectedNodes });
                }
            } finally { db.close(); }
        }
        return { seed: config.seed, results };
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) console.log(JSON.stringify(runCanvasStorageBenchmark(), null, 2));
