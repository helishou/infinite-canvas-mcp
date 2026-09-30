// Isolated DEVELOPMENT protocol smoke test, not a production Canvas client.
// Starts only its own MCP stdio child; creates/deletes its own fixture; never generates media.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(backendDir, "dist/index.js"), "mcp"], cwd: backendDir, stderr: "pipe" });
const client = new Client({ name: "isolated-h3-batch-smoke", version: "1" });
const title = `h3-batch-native-smoke-${Date.now()}`;
let projectId;
let nodeId;
let report = { title, generatedMedia: false, runs: [], cleanup: false };
const sanitize = (value) => String(value).replace(/([?&]token=)[^&\s]+/g, "$1[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");

async function tool(name, arguments_) {
    const result = await client.callTool({ name, arguments: arguments_ });
    const text = result.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "";
    if (result.isError) throw new Error(`${name}: ${sanitize(text)}`);
    const value = JSON.parse(text);
    if (value.ok === false || value.error) throw new Error(`${name}: ${sanitize(JSON.stringify(value.error))}`);
    return value;
}

async function readClips(ids) {
    return Promise.all(ids.map((segmentId) => tool("h3_get_clip", { projectId, nodeId, segmentId })));
}

try {
    let timer;
    try {
        await Promise.race([client.connect(transport), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("MCP initialization timed out")), 30000); })]);
    } finally { clearTimeout(timer); }
    const catalog = await client.listTools();
    const descriptor = catalog.tools.find((entry) => entry.name === "h3_update_clips");
    assert.ok(descriptor, "fresh native MCP stdio must expose h3_update_clips");
    assert.ok(descriptor.inputSchema.required.includes("updates"));
    report.registered = true;
    const created = await tool("canvas_create_project", { title });
    projectId = created.id;
    assert.equal(typeof projectId, "string");
    report.projectId = projectId;
    const node = await tool("canvas_create_node", { projectId, nodeType: "minimax-h3:video", title: "Isolated scalar config only", x: 0, y: 0, width: 400, height: 300, metadata: {} });
    assert.deepEqual(node.directTasks, []);
    const createdIds = node.operationResults.flatMap((entry) => entry.createdNodeIds || []);
    assert.equal(createdIds.length, 1);
    nodeId = createdIds[0];
    report.nodeId = nodeId;
    const segments = Array.from({ length: 6 }, (_, i) => ({ id: `smoke-${i + 1}`, sourceShotId: `smoke-shot-${i + 1}`, title: `initial-${i + 1}`, duration: 6, taskMode: "t2va", subjects: [], references: [], openingState: "Empty room", endingState: "Empty room", timeline: [{ start: 0, end: 6, action: "Observe an empty room", camera: "Static" }] }));
    await tool("h3_apply_video_plan", { projectId, nodeId, replaceSegments: true, language: "zh-CN", segments });
    const directory = await tool("h3_get_node", { projectId, nodeId });
    assert.equal(directory.segmentCount, 6);
    const ids = directory.segments.map((entry) => entry.id);
    assert.deepEqual(ids, segments.map((entry) => entry.id));
    for (let run = 1; run <= 3; run++) {
        const singleStart = performance.now();
        for (let i = 0; i < ids.length; i++) await tool("h3_update_clip", { projectId, nodeId, segmentId: ids[i], patch: { title: `serial-${run}-${i + 1}`, duration: 7 } });
        const singleMilliseconds = performance.now() - singleStart;
        const singleReads = await readClips(ids);
        assert.ok(singleReads.every((entry, i) => entry.segment.title === `serial-${run}-${i + 1}` && entry.segment.duration === 7));
        const before = await tool("canvas_get_state", { projectId });
        const updates = ids.map((segmentId, i) => ({ segmentId, patch: { title: `batch-${run}-${i + 1}`, duration: 8 } }));
        const batchStart = performance.now();
        const receipt = await tool("h3_update_clips", { projectId, nodeId, expectedRevision: before.revision, updates });
        const batchMilliseconds = performance.now() - batchStart;
        assert.equal(receipt.atomic, true);
        assert.equal(receipt.count, 6);
        assert.equal(receipt.revision - before.revision, 1);
        assert.deepEqual(receipt.items.map((entry) => entry.segmentId), ids);
        const actual = await readClips(ids);
        for (let i = 0; i < actual.length; i++) {
            assert.equal(actual[i].segment.title, `batch-${run}-${i + 1}`);
            assert.equal(actual[i].segment.duration, 8);
            assert.equal(actual[i].segment.status, "idle");
            assert.equal(actual[i].segment.hasResult, false);
            assert.equal(actual[i].referenceCount, 0);
            assert.equal(receipt.items[i].values.title, actual[i].segment.title);
            assert.equal(receipt.items[i].values.duration, actual[i].segment.duration);
        }
        const after = await tool("canvas_get_state", { projectId });
        assert.equal(after.revision, receipt.revision);
        report.runs.push({ run, singleRpcCalls: 6, batchRpcCalls: 1, revisionDelta: 1, singleMilliseconds, batchMilliseconds, receiptBytes: Buffer.byteLength(JSON.stringify(receipt)), valueReadback: "PASS" });
    }
    const beforeError = await tool("canvas_get_state", { projectId });
    const invalid = ids.map((segmentId, i) => ({ segmentId, patch: { title: `must-not-write-${i}` } }));
    invalid[5].patch = { prompt: "The actor from <Picture 999>." };
    await assert.rejects(() => tool("h3_update_clips", { projectId, nodeId, updates: invalid }));
    const afterError = await tool("canvas_get_state", { projectId });
    assert.equal(afterError.revision, beforeError.revision);
    assert.equal((await readClips(ids))[0].segment.title, "batch-3-1");
    report.invalidBatchRollback = "PASS";
    await assert.rejects(() => tool("h3_update_clips", { projectId, nodeId, expectedRevision: beforeError.revision - 1, updates: [{ segmentId: ids[0], patch: { title: "must-not-write" } }] }));
    assert.equal((await tool("canvas_get_state", { projectId })).revision, beforeError.revision);
    report.staleRevisionRejected = "PASS";
} finally {
    try {
        if (projectId) {
            await tool("canvas_delete_project", { id: projectId });
            const remaining = await tool("canvas_list_projects", { keyword: title, page: 1, pageSize: 10 });
            assert.equal(remaining.total, 0);
            assert.deepEqual(remaining.projects, []);
            report.cleanup = true;
        }
    } finally {
        try { await client.close(); }
        finally { await transport.close(); }
    }
}
console.log(`H3_BATCH_SMOKE=${JSON.stringify(report)}`);
