// Run from backend with: node --import tsx ../scripts/benchmark-mcp-v2.mjs
// Measures the former full-project/full-library query shape against the MCP v2 projections.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-v2-benchmark-"));
process.env.INFINITE_CANVAS_DATA_DIR = path.join(workDir, "data");
process.env.INFINITE_CANVAS_MEDIA_DIR = path.join(workDir, "media");
const output = path.join(root, "artifacts", `mcp-v2-performance-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const { BackendDatabase } = await import(pathToFileURL(path.join(root, "backend/src/db.ts")).href);
const { compileReferenceSubmission } = await import(pathToFileURL(path.join(root, "canvas-agent/src/canvas/reference-contract.ts")).href);
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const p95 = values => values.toSorted((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const summarizeH3 = project => {
    const node = project.nodes.find(item => item.type === "minimax-h3:video");
    return { id: node.id, type: node.type, title: node.title, segmentCount: node.metadata.segments.length, segments: node.metadata.segments.map((segment, index) => ({ id: String(segment.id || ""), index, title: String(segment.title || ""), sourceShotId: String(segment.sourceShotId || ""), status: String(segment.status || "idle"), hasResult: Boolean(segment.result || segment.resultStorageKey) })) };
};
const measure = (fn, repetitions = 24) => {
    const durations = [];
    let outputBytes = 0;
    fn(); // warm the SQLite statement/schema cache
    for (let i = 0; i < repetitions; i++) {
        const start = performance.now();
        const result = fn();
        durations.push(performance.now() - start);
        outputBytes = bytes(result);
    }
    return { medianMs: Number(median(durations).toFixed(3)), p95Ms: Number(p95(durations).toFixed(3)), outputBytes };
};
const samples = [];
const projectSizes = [200, 500, 1000];
for (const nodeCount of projectSizes) {
    const db = new BackendDatabase(":memory:");
    try {
        const nodes = Array.from({ length: nodeCount }, (_, index) => ({
            id: `n${index}`, type: index === 0 ? "minimax-h3:video" : "text", title: `Node ${index}`,
            position: { x: index * 20, y: index * 10 }, width: 400, height: 260,
            metadata: index === 0
                ? { segments: Array.from({ length: 24 }, (_, clip) => ({ id: `clip-${clip}`, title: `Clip ${clip}`, sourceShotId: `shot-${clip}`, status: clip ? "idle" : "success", resultStorageKey: clip ? undefined : "video:local-fixture", prompt: `Fixed local prompt ${clip} `.repeat(64), referenceBindings: [] })) }
                : { text: `Unrelated node ${index}; fixed local fixture `.repeat(24) },
        }));
        const connections = Array.from({ length: nodeCount - 1 }, (_, index) => ({ id: `edge-${index}`, fromNodeId: `n${index}`, toNodeId: `n${index + 1}`, role: "prompt", order: index }));
        db.createCanvasProject({ id: `node-project-${nodeCount}`, title: "MCP v2 fixture", nodes, connections, selectedNodeIds: ["n0"], revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        const id = `node-project-${nodeCount}`;
        const targetIds = ["n0"];
        const before = {
            selectedNode: measure(() => { const project = db.getCanvasProject(id); return { ...project, nodes: project.nodes.filter(node => targetIds.includes(node.id)), connections: project.connections.filter(edge => targetIds.includes(edge.fromNodeId) || targetIds.includes(edge.toNodeId)) }; }),
            h3Context: measure(() => db.getCanvasProject(id)),
            h3CompiledRead: measure(() => { const project = db.getCanvasProject(id); const node = project.nodes.find(item => item.id === "n0"); const segment = node.metadata.segments[0]; const compiled = compileReferenceSubmission(project, segment); return { projectId: project.id, revision: project.revision, referenceCount: compiled.references.length, promptChars: compiled.compiledPrompt.length }; }),
            h3Summary: measure(() => summarizeH3(db.getCanvasProject(id))),
        };
        const after = {
            selectedNode: measure(() => db.getCanvasProjectNodeSnapshot(id, targetIds)),
            h3Context: measure(() => db.getCanvasProjectH3Context(id, "n0")),
            h3CompiledRead: measure(() => { const project = db.getCanvasProjectH3Context(id, "n0", "clip-0"); const node = project.nodes.find(item => item.id === "n0"); const segment = node.metadata.segments[0]; const compiled = compileReferenceSubmission(project, segment); return { projectId: project.id, revision: project.revision, referenceCount: compiled.references.length, promptChars: compiled.compiledPrompt.length }; }),
            h3Summary: measure(() => summarizeH3(db.getCanvasH3NodeSummary(id, "n0"))),
            h3Context: measure(() => db.getCanvasProjectH3Context(id, "n0", "clip-0")),
        };
        samples.push({ nodes: nodeCount, before, after });
    } finally { db.close(); }
}

const assetSamples = [];
for (const assetCount of [100, 1000, 10000]) {
    const db = new BackendDatabase(":memory:");
    try {
        db.db.exec("BEGIN IMMEDIATE");
        const insert = db.db.prepare("INSERT INTO assets (id, kind, title, cover_url, tags_json, folder_id, drama_id, data_json, note, source, metadata_json, created_at, updated_at) VALUES (?, 'image', ?, ?, '[]', NULL, NULL, ?, NULL, NULL, '{}', ?, ?)");
        const stamp = "2026-01-01T00:00:00.000Z";
        const body = "fixed local asset description ".repeat(16);
        const cover = `data:image/jpeg;base64,${"A".repeat(1024)}`;
        for (let index = 0; index < assetCount; index++) {
            const title = `Asset ${index}${index % 10 === 0 ? " heroine-target" : ""}`;
            insert.run(`asset-${String(index).padStart(5, "0")}`, title, cover, JSON.stringify({ content: body, imageUrl: cover, storageKey: `image:fixture-${index}` }), stamp, stamp);
        }
        db.db.exec("COMMIT");
        const query = { keyword: "heroine-target", page: 1, pageSize: 20 };
        const before = measure(() => {
            const all = db.listAssets().filter(asset => `${asset.title} ${String(asset.data.description || "")} ${String(asset.data.content || "")}`.toLowerCase().includes(query.keyword));
            all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
            return { total: all.length, page: 1, pageSize: query.pageSize, items: all.slice(0, query.pageSize).map(asset => ({ id: asset.id, kind: asset.kind, title: asset.title, tags: asset.tags, folderId: asset.folderId, dramaId: asset.dramaId, updatedAt: asset.updatedAt, hasContent: Boolean(asset.data.content), contentChars: String(asset.data.content || "").length, hasCover: Boolean(asset.coverUrl), storageKey: asset.data.storageKey })) };
        }, 8);
        const after = measure(() => db.listAssetsPage(query), 8);
        assetSamples.push({ assets: assetCount, before, after });
    } finally { db.close(); }
}

const aggregate = (rows, fieldName) => {
    const dimensions = [...new Set(rows.map(row => row[fieldName]))];
    return dimensions.flatMap(value => {
        const selected = rows.filter(row => row[fieldName] === value);
        const direct = typeof selected[0].before?.medianMs === "number";
        const metrics = direct ? [null] : Object.keys(selected[0].before);
        return metrics.flatMap(metric => ["before", "after"].map(label => {
            const group = selected.map(row => direct ? row[label] : row[label][metric]);
            return { [fieldName]: value, ...(metric ? { metric } : {}), label, medianMs: Number(median(group.map(item => item.medianMs)).toFixed(3)), p95Ms: Number(median(group.map(item => item.p95Ms)).toFixed(3)), medianOutputBytes: median(group.map(item => item.outputBytes)) };
        }));
    });
};
const medians = { projects: aggregate(samples, "nodes"), assets: aggregate(assetSamples, "assets") };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ environment: { node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model }, scope: "In-memory SQLite projection, H3 reference-dependency reads, and asset summary paging; excludes HTTP/MCP transport and any model provider", repetitions: { projects: 24, assets: 8 }, samples, assetSamples, medians }, null, 2) + "\n");
fs.rmSync(workDir, { recursive: true, force: true });
console.log(JSON.stringify({ artifact: output, projects: samples.map(item => item.nodes), assets: assetSamples.map(item => item.assets) }));
