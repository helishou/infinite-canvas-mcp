// Compare only the two removed whole-project operations, with identical schema/ops logic.
// Run from backend: node --import tsx ../scripts/benchmark-canvas-ops.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = path.join(root, ".tmp");
fs.mkdirSync(tempRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(tempRoot, "canvas-ops-benchmark-"));
const output = path.join(root, "artifacts", "canvas-ops-performance.json");
process.env.INFINITE_CANVAS_DATA_DIR = path.join(directory, "data");
process.env.INFINITE_CANVAS_MEDIA_DIR = path.join(directory, "media");
const sourceUrl = pathToFileURL(path.join(root, "backend/src/db.ts"));
const current = fs.readFileSync(sourceUrl, "utf8");
const optimizedCheckpoint = /if \(!this\.db\.prepare\("SELECT 1 FROM canvas_collaboration_checkpoints WHERE project_id = \?"\)\.get\(id\)\) \{\s*this\.db\.prepare\("INSERT INTO canvas_collaboration_checkpoints \(project_id, revision, data_json\) VALUES \(\?, \?, \?\)"\)\.run\(id, currentRevision, JSON\.stringify\(current\)\);\s*\}/;
if (!optimizedCheckpoint.test(current) || !current.includes("const project = current as Record<string, unknown>;")) throw new Error("Benchmark source changed; review the baseline transformation before running");
const baseline = current.replace("const project = current as Record<string, unknown>;", "const project = structuredClone(current) as Record<string, unknown>;")
    .replace(optimizedCheckpoint, 'this.db.prepare("INSERT OR IGNORE INTO canvas_collaboration_checkpoints (project_id, revision, data_json) VALUES (?, ?, ?)").run(id, currentRevision, JSON.stringify(current));');
fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
const baselineFile = path.join(directory, "baseline.ts");
fs.writeFileSync(baselineFile, baseline.replace(/from "(\.\.?\/[^\"]+)"/g, (_match, specifier) => `from ${JSON.stringify(new URL(specifier, sourceUrl).href)}`));
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const samples = [];
try {
    const constructors = { before: (await import(pathToFileURL(baselineFile).href)).BackendDatabase, after: (await import(sourceUrl.href)).BackendDatabase };
    for (const count of [200, 500, 1000]) for (let run = 0; run < 3; run++) {
        // Alternate order to reduce warm-up bias.
        for (const label of run % 2 ? ["after", "before"] : ["before", "after"]) {
            const db = new constructors[label](":memory:");
            try {
                db.createCanvasProject({ id: "benchmark", title: "fixture", nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, type: "image", title: `Node ${i}`, position: { x: i * 10, y: 0 }, width: 280, height: 190, metadata: { prompt: "fixed prompt ".repeat(80), storageKey: `image:${i}` } })), connections: [], revision: 0, updatedAt: new Date().toISOString() });
                const durations = [];
                for (let edit = 0; edit < 40; edit++) {
                    const start = performance.now();
                    db.applyCanvasProjectOperations("benchmark", undefined, [{ type: "update_node", id: "n1", patch: { title: `Edit ${edit}` } }]);
                    if (edit >= 10) durations.push(performance.now() - start);
                }
                const ordered = durations.toSorted((a, b) => a - b);
                samples.push({ count, run: run + 1, label, medianMs: median(durations), p95Ms: ordered[Math.floor(ordered.length * .95)] });
            } finally { db.close(); }
        }
    }
    const medians = [200, 500, 1000].flatMap((count) => ["before", "after"].map((label) => {
        const rows = samples.filter((row) => row.count === count && row.label === label);
        return { count, label, medianMs: median(rows.map((row) => row.medianMs)), p95Ms: median(rows.map((row) => row.p95Ms)) };
    }));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ environment: { node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model }, scope: "In-memory SQLite transaction CPU; before restores clone and redundant checkpoint serialization only", samples, medians }, null, 2));
    console.log(JSON.stringify({ output, medians }));
} finally {
    if (!path.resolve(directory).startsWith(path.resolve(tempRoot) + path.sep)) throw new Error("Invalid cleanup path");
    fs.rmSync(directory, { recursive: true, force: true });
}
