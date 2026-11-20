import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import express from "express";

import { BackendDatabase } from "../db.js";
import { EpisodeProductionService } from "../drama/production.js";
import { emptyEpisodeProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { captureCanvasClipVideos, recordClipVideoVersions } from "../drama/clip-video-versions.js";
import { registerDramaProductionRoutes } from "./drama-production-routes.js";

type FixtureClip = { clipId: string; segmentId: string; title: string; storageKey: string; durationMs: number | null; fileSize: number | null; mimeType: string | null; generationLogId: string | null; status: string | null };
type FixtureVersion = { version: number; stage: string; createdAt: string; snapshotJson: string; impactJson: string };
const fixture = JSON.parse(readFileSync(new URL("./fixtures/clip-video-versions-real.json", import.meta.url), "utf8")) as {
    episodeId: string; dramaId: string; canvasId: string; nodeId: string; episodeTitle: string;
    versions: FixtureVersion[]; clips: FixtureClip[];
    mediaFiles: Array<{ storage_key: string; file_path: string; mime_type: string; file_size: number; width: number | null; height: number | null; duration_ms: number | null; created_at: string; sha256: string | null }>;
};

function seeded() {
    const directory = mkdtempSync(path.join(tmpdir(), "clip-video-compare-"));
    const db = new BackendDatabase(path.join(directory, "runtime.sqlite"));
    const now = new Date().toISOString();
    db.upsertCanvasFolder({ id: fixture.dramaId, name: "逐clip成片真值", isDrama: true, createdAt: now });
    const segments = fixture.clips.map((clip) => ({
        id: clip.segmentId,
        title: clip.title,
        status: clip.status,
        productionClipProjection: { targetId: clip.clipId },
        resultStorageKey: clip.storageKey,
        results: [{ storageKey: clip.storageKey, generationLogId: clip.generationLogId, mimeType: "video/mp4" }],
    }));
    db.createCanvasProject({ id: fixture.canvasId, title: fixture.episodeTitle, revision: 1,
        nodes: [{ id: fixture.nodeId, type: "minimax-h3:video", title: "H3", position: { x: 0, y: 0 }, width: 400, height: 300, metadata: { segments } }],
        connections: [] });
    db.upsertDramaEpisode({ id: fixture.episodeId, dramaId: fixture.dramaId, episodeNumber: 2, title: fixture.episodeTitle, synopsis: "", canvasId: fixture.canvasId, createdAt: now, updatedAt: now });
    for (const media of fixture.mediaFiles) {
        db.upsertMediaFile({ storageKey: media.storage_key, filePath: media.file_path, mimeType: media.mime_type,
            bytes: media.file_size, width: media.width ?? null, height: media.height ?? null, durationMs: media.duration_ms,
            createdAt: media.created_at ?? now, sha256: media.sha256 });
    }
    for (const item of fixture.versions) {
        db.db.prepare("INSERT INTO episode_production_versions (episode_id, version, stage, snapshot_json, impact_json, created_at) VALUES (?,?,?,?,?,?)")
            .run(fixture.episodeId, item.version, item.stage, item.snapshotJson, item.impactJson, item.createdAt);
    }
    // v3/v4 是测试剧目在本真数据副本上新发布的版本（快照沿用 v2 真快照，逐clip成片另由真值表记录）。
    const baseVersion = fixture.versions[fixture.versions.length - 1];
    for (const version of [3, 4]) {
        db.db.prepare("INSERT INTO episode_production_versions (episode_id, version, stage, snapshot_json, impact_json, created_at) VALUES (?,?,?,?,?,?)")
            .run(fixture.episodeId, version, baseVersion.stage, baseVersion.snapshotJson, baseVersion.impactJson, `2026-11-20T0${version - 2}:00:00.000Z`);
    }
    return { directory, db };
}

test("逐clip成片真值链：真数据副本捕获 15 段成片 + 版本记录 + 两版本逐clip对比", async (t) => {
    const { directory, db } = seeded();
    const app = express();
    app.use(express.json());
    registerDramaProductionRoutes(app, new EpisodeProductionService(db, undefined, directory));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
        rmSync(directory, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/drama/episodes/${fixture.episodeId}/production`;
    const get = async (url: string) => {
        const response = await fetch(base + url);
        return { status: response.status, body: await response.json() as Record<string, any> };
    };

    // ① 当前画布真值：15 段成片全部来自 resultStorageKey，时长来自 media_files（真数据）。
    const captured = captureCanvasClipVideos(db, fixture.episodeId);
    assert.equal(captured.length, 15);
    assert.deepEqual(new Set(captured.map((item) => item.storageKey)), new Set(fixture.clips.map((clip) => clip.storageKey)));
    assert.deepEqual(new Set(captured.map((item) => item.durationMs)), new Set([3750, 5875, 6583]));
    assert.ok(captured.every((item) => item.generationLogId && item.clipId && item.segmentId));
    const current = await get("/clip-videos/current");
    assert.equal(current.status, 200);
    assert.equal(current.body.ok, true);
    assert.equal(current.body.clipVideos.length, 15);

    // ② 旧版本没有逐clip记录时如实为空，不按当前画布回填。
    const oldVersion = await get("/clip-videos/1");
    assert.equal(oldVersion.status, 200);
    assert.deepEqual(oldVersion.body.clipVideos, []);

    // ③ 发布 v3 时用同一捕获函数落真值表，列表与版本记录都可见。
    recordClipVideoVersions(db, fixture.episodeId, 3, captured, "2026-11-20T10:00:00.000Z");
    const recorded = await get("/clip-videos/3");
    assert.equal(recorded.body.clipVideos.length, 15);
    const list = await get("/version-compare/versions");
    assert.equal(list.status, 200);
    assert.equal(list.body.versions.find((v: { version: number }) => v.version === 1).clipVideoCount, 0);
    assert.equal(list.body.versions.find((v: { version: number }) => v.version === 3).clipVideoCount, 15);
    // summary 内也必须带同一真计数（父代理实测曾 missing）：v3 = 15，v1 = 0。
    assert.equal(list.body.versions.find((v: { version: number }) => v.version === 1).summary.clipVideoCount, 0);
    assert.equal(list.body.versions.find((v: { version: number }) => v.version === 3).summary.clipVideoCount, 15);

    // ④ 真数据副本上两版本逐clip对比：旧版无记录 → 15 段「新增成片」并带真实时长。
    const added = await get("/version-compare/1/3");
    assert.equal(added.status, 200);
    const addedDiff = added.body.comparison.clipVideos;
    assert.equal(addedDiff.recordedFrom, false);
    assert.equal(addedDiff.recordedTo, true);
    assert.equal(addedDiff.fromCount, 0);
    assert.equal(addedDiff.toCount, 15);
    assert.equal(addedDiff.added.length, 15);
    assert.deepEqual(addedDiff.removed, []);
    assert.deepEqual(addedDiff.changed, []);

    // ⑤ 同一版本对比：逐clip成片无变化，不被判为「成片更换」。
    const same = await get("/version-compare/3/3");
    assert.deepEqual(same.body.comparison.clipVideos.added, []);
    assert.deepEqual(same.body.comparison.clipVideos.changed, []);

    // ⑥ 换一个真实 storageKey 再发布 v4：只有那一段被判「成片更换」，旧/新 key 都是真实 key。
    const mutatedClip = fixture.clips[0];
    const replacement = fixture.clips[1];
    const row = db.db.prepare("SELECT node_json FROM canvas_nodes WHERE project_id=? AND node_id=?").get(fixture.canvasId, fixture.nodeId) as { node_json: string };
    const node = JSON.parse(row.node_json) as { metadata: { segments: Array<Record<string, unknown>> } };
    const target = node.metadata.segments.find((segment) => segment.id === mutatedClip.segmentId)!;
    target.resultStorageKey = replacement.storageKey;
    db.db.prepare("UPDATE canvas_nodes SET node_json=? WHERE project_id=? AND node_id=?").run(JSON.stringify(node), fixture.canvasId, fixture.nodeId);
    recordClipVideoVersions(db, fixture.episodeId, 4, captureCanvasClipVideos(db, fixture.episodeId), "2026-11-20T11:00:00.000Z");
    const changed = await get("/version-compare/3/4");
    assert.equal(changed.status, 200);
    const changedDiff = changed.body.comparison.clipVideos;
    assert.equal(changedDiff.added.length, 0);
    assert.equal(changedDiff.removed.length, 0);
    assert.equal(changedDiff.changed.length, 1, "恰好一段成片被更换");
    const only = changedDiff.changed[0];
    assert.equal(only.clipId, mutatedClip.clipId);
    assert.equal(only.state, "storageKeyChanged");
    assert.equal(only.storageKeyChanged, true);
    assert.equal(only.from.storageKey, mutatedClip.storageKey);
    assert.equal(only.to.storageKey, replacement.storageKey);
    assert.equal(only.from.durationMs, mutatedClip.durationMs);
    assert.equal(only.to.durationMs, replacement.durationMs);
});

test("发布版本时真链路落库：publish() 自动把当前画布 15 段成片写入新版本", async (t) => {
    const { directory, db } = seeded();
    const service = new EpisodeProductionService(db, undefined, directory);
    t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
    // 让发布从 v5 起：副本已有 v1–v4 版本行，published_version 对齐到 4。
    db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?,?,?,?,?,?)")
        .run(fixture.episodeId, 0, JSON.stringify(emptyEpisodeProduction()), JSON.stringify(emptyEpisodeProduction()), 4, new Date().toISOString());
    const before = service.get(fixture.episodeId);
    const scene = { id: "scene-truth", heading: "内景", location: "山洞", timeOfDay: "夜", blocks: [{ id: "action-truth", kind: "action" as const, text: "二人入洞。" }] };
    const edited = await service.edit(fixture.episodeId, { operationId: "clip-truth-scene", expectedRevision: before.revision, ops: [{ type: "upsert_scene", scene }] });
    const published = await service.publish(fixture.episodeId, { operationId: "clip-truth-publish", expectedRevision: edited.revision, stage: "script" });
    assert.ok(published.publishedVersion >= 5);
    const recorded = service.clipVideosAtVersion(fixture.episodeId, published.publishedVersion);
    assert.equal(recorded.length, 15, "发布动作把画布逐clip成片真值按版本打包落库");
    assert.deepEqual(new Set(recorded.map((item) => item.storageKey)), new Set(fixture.clips.map((clip) => clip.storageKey)));
    assert.ok(recorded.every((item) => typeof item.durationMs === "number"));
});
