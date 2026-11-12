import assert from "node:assert/strict";
import test from "node:test";
import { BackendDatabase } from "./db.js";
import { compressStoredJsonText, decodeStoredJson } from "./json-storage.js";

test("large generation-log parameters stay lossless across Brotli writes, legacy ID dedup and updates", t => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const params = { legacyLogId: "legacy-source-id", workflowSnapshot: "完整输入\n".repeat(9000), flags: [false, 0, null] };
    const input = { projectId: "p", nodeId: "n", status: "running" as const, platform: "test", references: [], inputCounts: {}, outputs: [], params };
    const log = db.createGenerationLog(input);
    const stored = db.db.prepare("SELECT params_json AS value FROM generation_logs WHERE id=?").get(log.id)!.value;
    assert.ok(stored instanceof Uint8Array);
    assert.deepEqual(decodeStoredJson(stored), params);
    assert.deepEqual(db.getGenerationLog(log.id)!.params, params);
    assert.equal(db.createGenerationLog(input).id, log.id);
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM generation_logs").get()!.n, 1);
    db.db.prepare("UPDATE generation_logs SET params_json=? WHERE id=?").run(compressStoredJsonText(JSON.stringify(params)), log.id);
    assert.equal(db.createGenerationLog(input).id, log.id);
    const changed = { ...params, workflowSnapshot: params.workflowSnapshot + "下一次输入" };
    assert.deepEqual(db.updateGenerationLog(log.id, { params: changed }).params, changed);
    const value = db.db.prepare("SELECT params_json AS value FROM generation_logs WHERE id=?").get(log.id)!.value;
    assert.ok(value instanceof Uint8Array);
    assert.deepEqual(db.listGenerationLogs({ projectId: "p" })[0].params, changed);
    db.db.prepare("UPDATE generation_logs SET params_json=? WHERE id=?").run(compressStoredJsonText(JSON.stringify(params)), log.id);
    assert.equal(db.createGenerationLog(input).id, log.id);
});
