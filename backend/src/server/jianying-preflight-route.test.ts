import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { emptyEpisodeProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { BackendDatabase } from "../db.js";
import { directorHash, projectDirector } from "../drama/director.js";
import { EpisodeProductionService } from "../drama/production.js";
import type { DramaJianyingDraftPreview } from "../drama/jianying-preflight.js";
import { registerDramaProductionRoutes } from "./drama-production-routes.js";

/**
 * 端到端证明：后端确实能从 canvas-project-storage + H3 段 metadata 稳定解析当前
 * resultStorageKey / inputOutdated，而不是靠 notice 正则或伪造。
 */
test("POST /prod/jianying/preflight 用画布 H3 段真实结果做三分类，stale 是可用子集", async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "jianying-route-"));
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const db = new BackendDatabase(path.join(root, "fixture.sqlite"));
    db.upsertCanvasFolder({ id: "drama", name: "fixture", createdAt: new Date().toISOString(), isDrama: true });
    const service = new EpisodeProductionService(db, undefined, root);

    // 真实文件 + 真实 media_files 元数据。
    const videoPath = path.join(root, "clip.mp4");
    fs.writeFileSync(videoPath, "video-bytes");
    const videoBytes = fs.statSync(videoPath).size;
    const storageKey = "media/real-clip.mp4";
    db.upsertMediaFile({ storageKey, filePath: videoPath, mimeType: "video/mp4", bytes: videoBytes,
        width: 1280, height: 720, durationMs: 5000, createdAt: new Date().toISOString(), sha256: "sha-fixture" });

    // 画布 H3 段：seg1 有结果且 inputOutdated=true（旧版本），seg2 没有结果。
    db.createCanvasProject({ id: "canvas", title: "fixture", connections: [], nodes: [{
        id: "h3-node", type: "minimax-h3:video", title: "Clip", position: { x: 0, y: 0 }, width: 300, height: 200,
        metadata: {
            productionOwnerKind: "episode", productionOwnerId: "ep",
            segments: [
                { id: "runtime-seg-1", duration: 5, storageKey, resultStorageKey: storageKey, inputOutdated: true,
                    sourceShotId: "s1", productionClipProjection: { targetId: "seg1" } },
                { id: "runtime-seg-2", duration: 5, sourceShotId: "s2", productionClipProjection: { targetId: "seg2" } },
            ],
        },
    }] });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "", canvasId: "canvas" });

    const source = {
        version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1,
        style_policy: "waived", style_policy_reason: "fixture",
        subject_registry: [], character_registry: [], scene_registry: [{ id: "room", name: "Room" }],
        script_scenes: [{ id: "morning", scene_id: "room", scene_name: "Morning", text: "Fixture", beat_ids: [] }], asset_plan: [],
        shots: [
            { id: "s1", title: "镜头一", scene_id: "room", timeline_id: "main", story_order: 0, duration_frames: 120, visual: "v", camera: "static" },
            { id: "s2", title: "镜头二", scene_id: "room", timeline_id: "main", story_order: 1, duration_frames: 120, visual: "v", camera: "static" },
        ],
        segments: [
            { id: "seg1", timeline_id: "main", shot_ids: ["s1"], mode: "T2VA" },
            { id: "seg2", timeline_id: "main", shot_ids: ["s2"], mode: "T2VA" },
        ],
        ledger: { contract_version: 2, facts: [], timelines: [{ id: "main", start_frame: 0 }], initial: [], events: [], requirements: [], coverage: [] },
    };
    const director = {
        schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test-engine", version: "4.3.9" },
        source, sourceHash: directorHash(source), artifacts: [], assets: {}, modules: {},
        shotInputs: { s1: { keyframePolicy: "none" }, s2: { keyframePolicy: "none" } },
        boundaries: [], executionAuthorized: false, unresolved: [], workflow: { mediaProductionMode: "automatic" },
    };
    const draft = emptyEpisodeProduction();
    (draft as any).director = director;
    projectDirector(draft as any);
    draft.clipGroups = draft.clipGroups.map(group => group.id === "seg1"
        ? { ...group, nodeId: "h3-node", segmentId: "runtime-seg-1", inputOutdated: true }
        : { ...group, nodeId: "h3-node", segmentId: "runtime-seg-2" });
    db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("ep", 7, JSON.stringify(draft), null, 0, new Date().toISOString());
    const app = express();
    app.use(express.json());
    registerDramaProductionRoutes(app, service);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    const url = `http://127.0.0.1:${(server.address() as any).port}/drama/episodes/ep/production/jianying/preflight`;

    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftRoot: "C:/Jianying", captions: false }) });
    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean; preview: DramaJianyingDraftPreview };
    assert.equal(body.ok, true);
    const preview = body.preview;
    assert.equal(preview.totalSegments, 2);
    assert.equal(preview.availableSegments, 1, "seg1 有真实结果文件");
    assert.equal(preview.missingSegments, 1, "seg2 无结果");
    assert.equal(preview.staleSegments, 1, "seg1 的 inputOutdated 来自画布，不是 notice 正则");
    assert.equal(preview.segments[0].included, true);
    assert.equal(preview.segments[0].stale, true);
    assert.equal(preview.segments[0].durationMs, 5000, "用 media_files 的实测时长");
    assert.equal(preview.segments[0].durationEstimated, false);
    assert.equal(preview.segments[1].included, false);
    assert.equal(preview.segments[1].reason, "视频尚未就绪");
    assert.equal(preview.mediaBytes, videoBytes);
    assert.match(preview.revision, /^[0-9a-f]{64}$/);
    assert.ok(preview.warnings.some(w => w.includes("1 个剧情段将被跳过")));
});
