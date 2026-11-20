import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { emptyEpisodeProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { BackendDatabase } from "../db.js";
import { directorHash, projectDirector } from "../drama/director.js";
import { EpisodeProductionService } from "../drama/production.js";
import { registerDramaProductionRoutes } from "./drama-production-routes.js";

/** 制作台真实调用的 GET /drama/episodes/:id/production：state 必须出现在返回副本，且绝不写回 draft_json。 */
test("GET production detail 给每段挂 state（ready/stale + 真实 job stage/wait），draft_json 不变", async t => {
    const root = mkdtempSync(join(tmpdir(), "segment-state-route-"));
    const db = new BackendDatabase(join(root, "fixture.sqlite"));
    t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
    db.upsertCanvasFolder({ id: "drama", name: "fixture", createdAt: new Date().toISOString(), isDrama: true });
    db.createCanvasProject({ id: "canvas", title: "fixture", connections: [], nodes: [] });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "第 1 集", synopsis: "", canvasId: "canvas" });
    const service = new EpisodeProductionService(db, undefined, root);

    const source = {
        version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1,
        subject_registry: [], character_registry: [], scene_registry: [], script_scenes: [], asset_plan: [], utterances: [],
        shots: [{ id: "s1", scene_id: "room", timeline_id: "main", story_order: 0, duration_frames: 120 }, { id: "s2", scene_id: "room", timeline_id: "main", story_order: 1, duration_frames: 120 }],
        segments: [{ id: "seg-ready", shot_ids: ["s1"], mode: "Ref2VA" }, { id: "seg-stale", shot_ids: ["s2"], mode: "T2VA" }],
        ledger: { contract_version: 2, facts: [], timelines: [{ id: "main", start_frame: 0 }], initial: [], events: [], requirements: [], coverage: [] },
    };
    const sourceHash = directorHash(source);
    const prompt = "<Picture 1> is the approved frame.";
    const promptSha = crypto.createHash("sha256").update(prompt).digest("hex");
    const receipt = (sourceHashValue: string, accepted: boolean) => ({
        sourceHash: sourceHashValue, promptHash: promptSha, engineRuntimeId: "runtime-1", validator: "h3_schema",
        diagnostics: { englishWords: 2700, detailPolicy: { profile: "strict" }, blockers: [], formatPass: "PASSED", accepted },
    });
    const artifact = (targetId: string, sourceHashValue: string, status: "ready" | "stale") => ({
        id: `h3-${targetId}`, kind: "h3", targetId, prompt, sha256: promptSha,
        sourceHash: sourceHashValue, status,
        references: [{ label: "<Picture 1>", nodeId: "n1", storageKey: "image:abc", sha256: "d".repeat(64), role: "keyframe" }],
        receipt: receipt(sourceHashValue, true),
    });
    const director = {
        schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test-engine", version: "4.3.9" },
        source, sourceHash,
        artifacts: [artifact("seg-ready", sourceHash, "ready"), artifact("seg-stale", "e".repeat(64), "stale")], // 后者 sourceHash 不匹配 → stale
        assets: {}, modules: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {},
    };
    const draft = emptyEpisodeProduction();
    (draft as any).director = director;
    projectDirector(draft as any, false); // 夹具聚焦状态派生；跳过正文词数校验（不影响读取链）
    const draftJson = JSON.stringify(draft);
    db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("ep", 7, draftJson, null, 0, new Date().toISOString());
    db.db.prepare("INSERT INTO drama_pipeline_jobs (id, drama_id, episode_id, kind, stage, status, priority, attempt, dedupe_key, label, payload_json, attempts_json, error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("job-1", "drama", "ep", "prompts", "prompts", "blocked", 3, 0, "job-1", "第1集 · prompts", "{}", "[]", "等待 assets 阶段完成", new Date().toISOString(), new Date().toISOString());

    const app = express();
    app.use(express.json());
    registerDramaProductionRoutes(app, service);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    const url = `http://127.0.0.1:${(server.address() as any).port}/drama/episodes/ep/production`;

    const res = await fetch(url);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    const segments = body.production.draft.director.source.segments;
    assert.equal(segments.length, 2);
    assert.equal(segments[0].state.promptStatus, "ready");
    assert.equal(segments[0].state.references[0].sent, true);
    assert.equal(segments[1].state.promptStatus, "stale");
    assert.equal(segments[1].state.upstreamStage, "prompts");
    assert.equal(segments[1].state.waitReason, "等待 assets 阶段完成");

    const stored = db.db.prepare("SELECT draft_json FROM episode_productions WHERE episode_id=?").get("ep") as { draft_json: string };
    assert.equal(stored.draft_json, draftJson, "draft_json 不得被写入 state");
    assert.equal(JSON.parse(stored.draft_json).director.source.segments[0].state, undefined);
});
