import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { BackendDatabase } from "./db.js";
import { decodeStoredJson, encodeStoredJson, storedJsonText } from "./json-storage.js";
import { reconstructCanvasHistory, previewCanvasHistoryPrune } from "./canvas/history-maintenance.js";
import { computeRebalanceFingerprint } from "./maintenance/rebalance-canvas-history.js";

function fixture(t: TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-compression-"));
    const file = path.join(directory, "test.sqlite");
    let db = new BackendDatabase(file);
    t.after(() => {
        db.close();
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid cleanup path");
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { file, get db() { return db; }, reopen() { db.close(); db = new BackendDatabase(file); } };
}

const prompt = "保存完整中文提示词、参考素材身份与工作流快照。\n".repeat(1500);

test("JSON encoding preserves legacy TEXT, Unicode and arbitrary strings; corrupt BLOBs fail", () => {
    const data = { prompt, nested: [null, false, "😀", { storageKey: "image:original" }] };
    const stored = encodeStoredJson(data);
    assert.ok(stored instanceof Uint8Array);
    assert.ok(stored.byteLength < Buffer.byteLength(JSON.stringify(data)) / 5);
    assert.deepEqual(decodeStoredJson(stored), data);
    assert.deepEqual(decodeStoredJson(JSON.stringify(data)), data);
    assert.equal(encodeStoredJson({ title: "small" }), '{"title":"small"}');
    const random = randomBytes(4096).toString("base64");
    assert.equal(decodeStoredJson(encodeStoredJson(random)), random);
    assert.throws(() => decodeStoredJson(Buffer.from("unknown format")));
    assert.throws(() => decodeStoredJson(stored.subarray(0, stored.length - 4)));
});

test("compressed task inputs survive restart, SQL filters, summaries, usage, retry and redaction", t => {
    const f = fixture(t);
    const input = { projectId: "p", nodeId: "node", parentThreadId: "thread", channelId: "channel", prompt };
    const task = f.db.createTask("task", "canvas-image", input, { model: "image-model" });
    assert.equal(f.db.db.prepare("SELECT typeof(input_json) AS type FROM tasks WHERE id='task'").get()?.type, "blob");
    const legacy = f.db.createTask("legacy", "canvas-image", { ...input, parentThreadId: "other" }, { model: "image-model" });
    f.db.db.prepare("UPDATE tasks SET input_json=? WHERE id=?").run(JSON.stringify(legacy.input), legacy.id);
    f.db.updateTask(task.id, { status: "succeeded", result: { images: [{ storageKey: "image:result" }] } });
    f.reopen();
    assert.deepEqual(f.db.getTask(task.id)?.input, input);
    assert.deepEqual(f.db.getTask(legacy.id)?.input, legacy.input);
    assert.deepEqual(f.db.listTasks({ parentThreadId: "thread" }).map(row => row.id), [task.id]);
    const summaries = f.db.listTaskSummaries({ parentThreadId: "thread" });
    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries[0].input, { projectId: "p" });
    assert.deepEqual(summaries[0].outputs, [{ storageKey: "image:result" }]);
    assert.deepEqual(f.db.listCanvasTaskModelUsage().map(row => ({ ...row })), [{ model: "image-model", channelId: "channel", count: 2 }]);
    assert.deepEqual(f.db.createTask("task", "canvas-image", { prompt: "retry" }, {}).input, input);
    const before = f.db.db.prepare("SELECT input_json FROM tasks WHERE id='task'").get()?.input_json;
    f.db.db.prepare("UPDATE tasks SET params_json=? WHERE id='task'").run(JSON.stringify({ image: "data:image/png;base64,AAAA" }));
    f.db.redactLegacyInlineMedia();
    assert.deepEqual(f.db.db.prepare("SELECT input_json FROM tasks WHERE id='task'").get()?.input_json, before);
    f.db.createTask("inline", "canvas-image", { ...input, image: "data:image/png;base64,AAAA" }, {});
    assert.equal(f.db.redactLegacyInlineMedia().tasks, 1);
    assert.equal(f.db.getTask("inline")?.input.prompt, prompt);
    assert.equal(f.db.db.prepare("SELECT typeof(input_json) AS type FROM tasks WHERE id='inline'").get()?.type, "blob");
    f.db.db.prepare("UPDATE tasks SET input_json=? WHERE id='inline'").run(Buffer.from("corrupt"));
    assert.throws(() => f.db.getTask("inline"));
});

test("mixed compressed and TEXT canvas history preserves delta replay, idempotency and maintenance fingerprints", t => {
    const f = fixture(t);
    f.db.createCanvasProject({ id: "p", title: "canvas", revision: 0, nodes: [], connections: [], updatedAt: "2026-01-01T00:00:00.000Z" });
    const operations = Array.from({ length: 24 }, (_, index) => ({ type: "add_node", id: index ? `extra-${index}` : "text", nodeType: "text", metadata: { content: index ? "extra" : prompt } }));
    const first = f.db.applyCanvasProjectOperations("p", undefined, operations, { operationId: "large" });
    assert.equal(f.db.db.prepare("SELECT typeof(operations_json) AS type FROM canvas_operation_batches WHERE operation_id='large'").get()?.type, "blob");
    assert.equal(f.db.db.prepare("SELECT typeof(results_json) AS type FROM canvas_operation_batches WHERE operation_id='large'").get()?.type, "blob");
    const fingerprint = computeRebalanceFingerprint(f.db.db, "p").fingerprint;
    const batch = f.db.db.prepare("SELECT operations_json, results_json FROM canvas_operation_batches WHERE operation_id='large'").get()!;
    f.db.db.prepare("UPDATE canvas_operation_batches SET operations_json=?, results_json=? WHERE operation_id='large'")
        .run(storedJsonText(batch.operations_json), storedJsonText(batch.results_json));
    assert.equal(computeRebalanceFingerprint(f.db.db, "p").fingerprint, fingerprint);
    assert.deepEqual(f.db.applyCanvasProjectOperations("p", undefined, operations, { operationId: "large" }).project, first.project);
    f.db.db.prepare("UPDATE canvas_operation_batches SET operations_json=?, results_json=? WHERE operation_id='large'")
        .run(batch.operations_json, batch.results_json);
    f.db.applyCanvasProjectOperations("p", undefined, [{ type: "update_node", id: "text", patch: { title: "later" } }], { operationId: "small" });
    f.reopen();
    const changes = f.db.readCanvasChanges("p", 0);
    assert.equal(changes.reset, false);
    assert.equal(changes.commits.length, 2);
    assert.deepEqual(changes.commits[0].operations, first.operations);
    assert.deepEqual(changes.commits[0].operationResults, first.operationResults);
    assert.deepEqual(reconstructCanvasHistory(f.db.db, "p", 1), first.project);
    const retry = f.db.applyCanvasProjectOperations("p", undefined, operations, { operationId: "large" });
    assert.equal(retry.duplicated, true);
    assert.deepEqual(retry.project, first.project);
    assert.deepEqual(retry.operationResults, first.operationResults);
    assert.equal(previewCanvasHistoryPrune(f.db.db, "2099-01-01T00:00:00.000Z")[0].blockedReason, undefined);
    assert.throws(() => f.db.applyCanvasProjectOperations("p", undefined, [{ type: "update_project", patch: { title: "different" } }], { operationId: "large" }), { code: "OPERATION_ID_REUSED" });
    f.db.db.prepare("UPDATE canvas_operation_batches SET operations_json=? WHERE operation_id='large'").run(Buffer.from("corrupt"));
    assert.throws(() => f.db.readCanvasChanges("p", 0));
    assert.throws(() => reconstructCanvasHistory(f.db.db, "p", 1));
    assert.ok(previewCanvasHistoryPrune(f.db.db, "2099-01-01T00:00:00.000Z")[0].blockedReason);
});

test("format upgrade backs up v49 and leaves existing task inputs as TEXT", t => {
    const f = fixture(t);
    const input = { projectId: "p", prompt };
    f.db.createTask("old", "canvas-image", input, {});
    f.db.db.prepare("UPDATE tasks SET input_json=? WHERE id='old'").run(JSON.stringify(input));
    f.db.db.exec("DELETE FROM schema_migrations WHERE version=50");
    f.reopen();
    assert.deepEqual(f.db.getTask("old")?.input, input);
    assert.equal(f.db.db.prepare("SELECT typeof(input_json) AS type FROM tasks WHERE id='old'").get()?.type, "text");
    const backups = fs.readdirSync(path.dirname(f.file)).filter(name => name.includes("pre-schema-v49-to-v50"));
    assert.equal(backups.length, 1);
});
