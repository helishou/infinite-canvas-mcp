import assert from "node:assert/strict";
import test from "node:test";
import { BackendDatabase } from "./db.js";

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
