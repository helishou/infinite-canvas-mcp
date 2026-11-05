import assert from "node:assert/strict";
import test from "node:test";
import { BackendDatabase } from "./db.js";
import { gzipSync } from "node:zlib";

test("task summaries preserve parent linkage without returning the large params payload", () => {
    const db = new BackendDatabase(":memory:");
    try {
        db.createTask("canvas-h3-run", { projectId: "project", nodeId: "node", segmentId: "clip" }, {
            parentTaskId: "parent-task",
            prompt: "P".repeat(50_000),
        });
        const summaries = db.listTaskSummaries({ projectId: "project", nodeIds: ["node"] });
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0].parentTaskId, "parent-task");
        assert.equal(summaries[0].nodeId, "node");
        assert.deepEqual(summaries[0].params, {});
        assert.ok(Buffer.byteLength(JSON.stringify(summaries)) < 2_048);
    } finally {
        db.close();
    }
});

test("task routing projection preserves legacy TEXT, compressed inputs and malformed-input behavior", () => {
    const db = new BackendDatabase(":memory:");
    try {
        const update = db.db.prepare("UPDATE tasks SET input_json=? WHERE id=?");
        for (const [id, input] of [
            ["text", JSON.stringify({ projectId: "p", scope: "canvas", workflow: "x".repeat(20_000) })],
            ["gzip", gzipSync(JSON.stringify({ projectId: "p", scope: "canvas", workflow: "x".repeat(20_000) }))],
            ["invalid-text", "invalid JSON"],
            ["non-strings", JSON.stringify({ projectId: false, scope: { nested: "canvas" } })],
        ] as const) {
            db.createTask(id, "canvas-image", {}, {});
            update.run(input, id);
        }
        const rows = new Map(db.listTaskSummaries().map(row => [row.id, row]));
        assert.deepEqual(rows.get("text")?.input, { projectId: "p", scope: "canvas" });
        assert.deepEqual(rows.get("gzip")?.input, { projectId: "p", scope: "canvas" });
        assert.equal(rows.get("gzip")?.projectId, "p");
        assert.deepEqual(rows.get("invalid-text")?.input, {});
        assert.deepEqual(rows.get("non-strings")?.input, {});
        db.db.prepare("UPDATE tasks SET created_at=? WHERE id='text'").run("2099-01-01T00:00:00.000Z");
        update.run(gzipSync("invalid JSON"), "gzip");
        assert.equal(db.listTaskSummaries({ limit: 1 })[0].id, "text", "decode only the requested page");
        assert.throws(() => db.listTaskSummaries());
        update.run(Buffer.from("corrupt gzip"), "gzip");
        assert.throws(() => db.listTaskSummaries());
    } finally { db.close(); }
});
