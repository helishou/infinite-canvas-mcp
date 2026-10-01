// Isolated development replay only: reads recorded local corpus; never calls a live Canvas service.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { pluginMcp } from "../../canvas-agent/dist/plugins/minimax-h3/mcp.js";
import { PreparedH3UpdateFiles } from "../dist/canvas/prepared-h3-update-files.js";
import { BackendDatabase } from "../dist/db.js";

const [snapshotPath, firstPart, secondPart, characterContextPath] = process.argv.slice(2);
if (!snapshotPath || !firstPart || !secondPart) throw new Error("Usage: node scripts/h3-prepared-corpus-smoke.mjs <saved-node-snapshot> <part1.json> <part2.json>");
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const items = [...JSON.parse(await readFile(firstPart, "utf8")).items, ...JSON.parse(await readFile(secondPart, "utf8")).items];
assert.equal(items.length, 10); assert.equal(new Set(items.map((item) => item.segmentId)).size, 10);
const dir = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "h3-recorded-corpus-"));
const root = path.join(dir, "source"), archive = path.join(dir, "plans"); await mkdir(root);
const files = new PreparedH3UpdateFiles(root, archive), db = new BackendDatabase(":memory:");
try {
    const project = structuredClone(snapshot); project.id = "isolated-recorded-corpus"; project.revision = 0;
    const node = project.nodes[0];
    if (characterContextPath) {
        const context = JSON.parse(await readFile(characterContextPath, "utf8"));
        const known = new Set(project.nodes.map((value) => value.id));
        project.nodes.push(...context.nodes.filter((value) => !known.has(value.id)));
    }
    // Reconstruct the recorded child's source as an isolated fixture, not as the current production baseline.
    for (const item of items) Object.assign(node.metadata.segments.find((s) => s.id === item.segmentId), item.before);
    db.createCanvasProject(project);
    const original = structuredClone(db.getCanvasProject(project.id));
    let commits = 0; db.onCanvasCommit(() => commits++);
    const context = { backend: { preparedH3Updates: files, applyCanvasOperations: async (id, operations, revision, operationId) => db.applyCanvasProjectOperations(id, revision, operations, { operationId }) }, getCanvasProject: async (id) => db.getCanvasProject(id) };
    const handlers = pluginMcp.createHandler(context);
    const source = { formatVersion: 1, projectId: project.id, nodeId: node.id, expectedRevision: 0, items: items.map((item) => ({ segmentId: item.segmentId, before: item.before, update: item.update })) };
    const text = JSON.stringify(source), filePath = path.join(root, "recorded.json"), fileSha256 = createHash("sha256").update(text).digest("hex"); await writeFile(filePath, text);
    const started = performance.now();
    const plan = await handlers.h3_prepare_clip_updates({ projectId: project.id, nodeId: node.id, filePath, fileSha256 }, context);
    assert.equal(commits, 0); assert.equal(plan.count, 10);
    const result = await handlers.h3_update_clips({ projectId: project.id, nodeId: node.id, preparedId: plan.preparedId }, context);
    assert.equal(result.count, 10); assert.equal(result.revision, 1); assert.equal(commits, 1);
    const actual = db.getCanvasProject(project.id).nodes[0].metadata.segments;
    for (const item of items) {
        const expected = structuredClone(item.before);
        for (const edit of item.update.edits) {
            const pairs = edit.field.startsWith("timeline[].") ? expected.timeline.map((row) => [row, edit.field.split(".").at(-1)]) : [[expected, edit.field]];
            const selected = pairs.filter(([object, key]) => typeof object[key] === "string");
            assert.equal(selected.reduce((count, [object, key]) => count + object[key].split(edit.find).length - 1, 0), edit.expectedMatches);
            for (const [object, key] of selected) object[key] = object[key].split(edit.find).join(edit.replace);
        }
        const segment = actual.find((s) => s.id === item.segmentId);
        for (const [field, value] of Object.entries(expected)) assert.deepEqual(segment[field], value);
        const old = original.nodes[0].metadata.segments.find((s) => s.id === item.segmentId);
        for (const [key, value] of Object.entries(old)) if (!(key in expected)) assert.deepEqual(segment[key], value);
    }
    await handlers.h3_discard_clip_updates({ projectId: project.id, nodeId: node.id, preparedId: plan.preparedId }, context);
    console.log(JSON.stringify({ boundary: "recorded real ten-Clip corpus -> local handler -> memory Backend transaction; not native live acceptance or model latency", targets: items.length, editOperations: items.reduce((n, item) => n + item.update.edits.length, 0), originalUpdateBytes: plan.originalUpdateBytes, selectedUpdateBytes: plan.selectedUpdateBytes, handleArgumentsChars: JSON.stringify({ projectId: project.id, nodeId: node.id, preparedId: plan.preparedId }).length, planReceiptBytes: Buffer.byteLength(JSON.stringify(plan)), commitReceiptBytes: Buffer.byteLength(JSON.stringify(result)), localPipelineMs: performance.now() - started, commits, allRecordedChangesMatch: true, cleanup: "PASS" }));
} finally { db.close(); await rm(dir, { recursive: true, force: true }); }
