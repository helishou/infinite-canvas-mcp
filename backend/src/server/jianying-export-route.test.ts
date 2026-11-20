import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";

import { emptyEpisodeProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { BackendDatabase } from "../db.js";
import { directorHash, projectDirector } from "../drama/director.js";
import { EpisodeProductionService } from "../drama/production.js";
import type { DramaJianyingDraftPreview } from "../drama/jianying-preflight.js";
import { registerDramaProductionRoutes } from "./drama-production-routes.js";

/**
 * 端到端证明：真导出路由在现场重跑预检后复核 revision（409 防篡改）、按 allow 放行、
 * 并在服务端生成草稿文件 + 台词字幕 + ZIP 流（不再依赖浏览器 fflate 打包）。
 */
test("POST /prod/jianying/export：409 防篡改 / allow 放行 / ZIP 含草稿与字幕 / 表单 POST", async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "jianying-export-route-"));
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const db = new BackendDatabase(path.join(root, "fixture.sqlite"));
    db.upsertCanvasFolder({ id: "drama", name: "fixture", createdAt: new Date().toISOString(), isDrama: true });
    const service = new EpisodeProductionService(db, undefined, root);

    const videoPath = path.join(root, "clip.mp4");
    const video = Buffer.from("real-video-bytes");
    fs.writeFileSync(videoPath, video);
    const storageKey = "media/real-clip.mp4";
    db.upsertMediaFile({ storageKey, filePath: videoPath, mimeType: "video/mp4", bytes: video.length,
        width: 1280, height: 720, durationMs: 5000, createdAt: new Date().toISOString(), sha256: "sha-fixture" });

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
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "第 1 集", synopsis: "", canvasId: "canvas" });

    const source = {
        version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1,
        style_policy: "waived", style_policy_reason: "fixture",
        subject_registry: [], character_registry: [], scene_registry: [{ id: "room", name: "Room" }],
        script_scenes: [{ id: "morning", scene_id: "room", scene_name: "Morning", text: "Fixture", beat_ids: [] }], asset_plan: [],
        utterances: [{ id: "u1", text: "你好世界台词", speakerName: "甲" }],
        shots: [
            { id: "s1", title: "镜头一", scene_id: "room", timeline_id: "main", story_order: 0, duration_frames: 120, visual: "v", camera: "static",
                utterance_refs: [{ utteranceId: "u1", textStart: 0, textEnd: 6, localStartFrame: 0, localEndFrame: 48, role: "speaker" }] },
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
    const base = `http://127.0.0.1:${(server.address() as any).port}/drama/episodes/ep/production/jianying`;

    const preRes = await fetch(`${base}/preflight`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftRoot: "C:/Jianying", captions: true }) });
    assert.equal(preRes.status, 200);
    const { preview } = await preRes.json() as { preview: DramaJianyingDraftPreview };
    assert.equal(preview.availableSegments, 1);
    assert.equal(preview.missingSegments, 1, "seg2 无结果");
    assert.equal(preview.staleSegments, 1, "seg1 旧版本");
    assert.equal(preview.captionCount, 1);

    const post = (body: unknown, form = false) => fetch(`${base}/export`, {
        method: "POST",
        headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
        body: form ? String(body) : JSON.stringify(body),
    });

    // 1) revision 不一致 ⇒ 409 防篡改，且返回体带 expected/current，不写 ZIP 头。
    const conflict = await post({ draftRoot: "C:/Jianying", captions: true, revision: "tampered" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.headers.get("content-type")?.includes("application/zip"), false);
    const conflictBody = await conflict.json() as { code: string; expected: string; current: string };
    assert.equal(conflictBody.code, "JIANYING_REVISION_CONFLICT");
    assert.equal(conflictBody.current, preview.revision);

    // 2) revision 正确但未放行 ⇒ 400，不静默跳过不可导出/旧版本段。
    const blocked = await post({ draftRoot: "C:/Jianying", captions: true, revision: preview.revision });
    assert.equal(blocked.status, 400);
    const blockedBody = await blocked.json() as { code: string };
    assert.equal(blockedBody.code, "JIANYING_INCOMPLETE_BLOCKED");

    // 3) 放行后真导出 ⇒ application/zip，草稿文件 + 台词字幕 + 字幕轨 + 媒体都在包里。
    const exported = await post({ draftRoot: "C:/Jianying", captions: true, revision: preview.revision,
        allowIncomplete: true, allowStale: true });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type") || "", /application\/zip/);
    assert.match(exported.headers.get("content-disposition") || "", /attachment/);
    const entries = unzipSync(Uint8Array.from(Buffer.from(await exported.arrayBuffer())));
    const names = Object.keys(entries);
    const folder = names.find(name => name.startsWith("jianying/") && name.endsWith("/draft_content.json"));
    assert.ok(folder, "ZIP 内应有草稿目录");
    const draftDir = folder!.slice(0, -"draft_content.json".length);
    for (const file of ["draft_content.json", "draft_info.json", "draft_meta_info.json", "台词字幕.srt", "apply-draft-root.mjs"]) {
        assert.ok(names.includes(draftDir + file), `ZIP 缺少 ${file}`);
    }
    const content = JSON.parse(new TextDecoder().decode(entries[draftDir + "draft_content.json"]));
    assert.equal(content.materials.videos.length, 1, "只导出可用的 seg1");
    assert.match(content.materials.videos[0].path, /^C:\\Jianying\\/, "草稿目录路径替换为本机绝对路径");
    assert.equal(content.tracks.length, 2, "视频轨 + 台词字幕轨");
    const srt = new TextDecoder().decode(entries[draftDir + "台词字幕.srt"]);
    assert.match(srt, /你好世界台词/);
    assert.match(srt, /00:00:00,000 --> 00:00:02,000/);
    assert.ok(names.includes("subtitles/main.srt"), "字幕轨 SRT 真实入包");
    assert.ok(names.some(name => name.startsWith("outputs/video/")), "可用媒体真实入包");
    const mediaName = names.find(name => name.startsWith("outputs/video/"))!;
    assert.deepEqual(entries[mediaName], Uint8Array.from(video));
    const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
    assert.equal(manifest.contract, "jianying-export-v1");
    assert.equal(manifest.revision, preview.revision);
    assert.equal(manifest.preview.availableSegments, 1);
    assert.equal(manifest.subtitles.captionCount, 1);

    // 4) 本机路径走表单 POST（不走 GET query，避免访问日志记录本机路径）。
    const formRes = await post(new URLSearchParams({ draftRoot: "C:/Jianying", captions: "true", revision: preview.revision,
        allowIncomplete: "true", allowStale: "true" }).toString(), true);
    assert.equal(formRes.status, 200);
    assert.match(formRes.headers.get("content-type") || "", /application\/zip/);
});


/**
 * 8GB 上限：对齐影策 dramaArchiveMaxBytes，可用媒体总量超限直接拒绝导出，
 * 不静默产出超大 ZIP。用稀疏文件构造 8GB+ 视频（NTFS sparse，磁盘占用极小）。
 */
test("POST /prod/jianying/export：媒体总量超 8GB ⇒ JIANYING_ARCHIVE_TOO_LARGE 拒绝", async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "jianying-8gb-"));
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const db = new BackendDatabase(path.join(root, "fixture.sqlite"));
    db.upsertCanvasFolder({ id: "drama", name: "fixture", createdAt: new Date().toISOString(), isDrama: true });
    const service = new EpisodeProductionService(db, undefined, root);

    const over8gb = 8 * 1024 * 1024 * 1024 + 1;
    const videoPath = path.join(root, "huge.mp4");
    const fd = fs.openSync(videoPath, "w");
    fs.writeSync(fd, Buffer.from("v"), 0, 1, 0); // 首字节可读
    fs.ftruncateSync(fd, over8gb); // 稀疏拉伸到 8GB+，stat.size 与 expectedBytes 一致
    fs.closeSync(fd);
    const storageKey = "media/huge.mp4";
    db.upsertMediaFile({ storageKey, filePath: videoPath, mimeType: "video/mp4", bytes: over8gb,
        width: 1280, height: 720, durationMs: 5000, createdAt: new Date().toISOString(), sha256: "sha-huge" });

    db.createCanvasProject({ id: "canvas", title: "fixture", connections: [], nodes: [{
        id: "h3-node", type: "minimax-h3:video", title: "Clip", position: { x: 0, y: 0 }, width: 300, height: 200,
        metadata: { productionOwnerKind: "episode", productionOwnerId: "ep", segments: [
            { id: "runtime-seg-1", duration: 5, storageKey, resultStorageKey: storageKey,
                sourceShotId: "s1", productionClipProjection: { targetId: "seg1" } },
        ] },
    }] });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "第 1 集", synopsis: "", canvasId: "canvas" });
    const source = {
        version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1,
        style_policy: "waived", style_policy_reason: "fixture",
        subject_registry: [], character_registry: [], scene_registry: [{ id: "room", name: "Room" }],
        script_scenes: [{ id: "morning", scene_id: "room", scene_name: "Morning", text: "Fixture", beat_ids: [] }], asset_plan: [],
        utterances: [], shots: [{ id: "s1", title: "镜头一", scene_id: "room", timeline_id: "main", story_order: 0, duration_frames: 120, visual: "v", camera: "static" }],
        segments: [{ id: "seg1", timeline_id: "main", shot_ids: ["s1"], mode: "T2VA" }],
        ledger: { contract_version: 2, facts: [], timelines: [{ id: "main", start_frame: 0 }], initial: [], events: [], requirements: [], coverage: [] },
    };
    const director = {
        schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test-engine", version: "4.3.9" },
        source, sourceHash: directorHash(source), artifacts: [], assets: {}, modules: {},
        shotInputs: { s1: { keyframePolicy: "none" } }, boundaries: [], executionAuthorized: false, unresolved: [],
        workflow: { mediaProductionMode: "automatic" },
    };
    const draft = emptyEpisodeProduction();
    (draft as any).director = director;
    projectDirector(draft as any);
    draft.clipGroups = draft.clipGroups.map(group => group.id === "seg1"
        ? { ...group, nodeId: "h3-node", segmentId: "runtime-seg-1" } : group);
    db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("ep", 7, JSON.stringify(draft), null, 0, new Date().toISOString());

    const app = express();
    app.use(express.json());
    registerDramaProductionRoutes(app, service);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as any).port}/drama/episodes/ep/production/jianying`;

    const preRes = await fetch(`${base}/preflight`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftRoot: "C:/Jianying", captions: false }) });
    assert.equal(preRes.status, 200);
    const { preview } = await preRes.json() as { preview: DramaJianyingDraftPreview };
    assert.ok(preview.mediaBytes > 8 * 1024 * 1024 * 1024, "预检媒体总量应超 8GB");
    assert.ok(preview.warnings.some(w => w.includes("8GB")), "预检应警告超限");

    const expRes = await fetch(`${base}/export`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftRoot: "C:/Jianying", captions: false, revision: preview.revision }) });
    assert.equal(expRes.status, 400, "超 8GB 导出应被拒绝");
    const body = await expRes.json() as { code: string };
    assert.equal(body.code, "JIANYING_ARCHIVE_TOO_LARGE");
});
