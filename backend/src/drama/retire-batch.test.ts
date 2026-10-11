import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { EpisodeProductionService } from "./production.js";

test("retirement releases only stopped batches, preserves submissions and is idempotent", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "retire-batch-"));
    const db = new BackendDatabase(path.join(directory, "db.sqlite"));
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    db.upsertCanvasFolder({ id: "drama", name: "Drama", createdAt: new Date().toISOString(), isDrama: true });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "" });
    const service = new EpisodeProductionService(db, undefined, directory, false, () => {});
    const submitted = [{ kind: "image", id: "s1", taskId: "task", projectId: "project", nodeId: "node", status: "succeeded" }];
    db.db.prepare("INSERT INTO episode_production_batches (run_id,episode_id,idempotency_key,request_hash,version,source_revision,status,targets_json,plan_json,engine_json,settings_json,submitted_json,pause_requested,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("run", "ep", "key", "hash", 1, 1, "awaiting_review", '["frame:s1"]', '{}', '{}', '{}', JSON.stringify(submitted), 0, "now", "now");
    db.getTask = (() => ({ status: "running" })) as unknown as typeof db.getTask;
    assert.throws(() => service.retireBatch("ep", "run", "用户跳过旧分镜批次"), /在途/);
    assert.equal(service.getBatch("ep", "run")!.status, "awaiting_review");
    db.getTask = (() => null) as typeof db.getTask;
    assert.throws(() => service.retireBatch("ep", "run", "用户跳过旧分镜批次"), /未知/);
    db.getTask = (() => ({ status: "succeeded" })) as unknown as typeof db.getTask;
    const closed = service.retireBatch("ep", "run", "用户跳过旧分镜批次");
    assert.equal(closed.status, "failed");
    assert.deepEqual(closed.submitted, submitted);
    assert.deepEqual(service.retireBatch("ep", "run", "用户跳过旧分镜批次"), closed);
    assert.throws(() => service.retireBatch("ep", "missing", "用户跳过旧分镜批次"), /找不到/);
});
