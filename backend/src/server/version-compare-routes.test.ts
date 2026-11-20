import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import express from "express";

import { BackendDatabase } from "../db.js";
import { EpisodeProductionService } from "../drama/production.js";
import { registerDramaProductionRoutes } from "./drama-production-routes.js";

type FixtureVersion = { version: number; stage: string; createdAt: string; snapshotJson: string; impactJson: string };
const fixture = JSON.parse(readFileSync(new URL("./fixtures/version-compare-real.json", import.meta.url), "utf8")) as {
    episodeId: string;
    versions: FixtureVersion[];
};

test("版本对比 HTTP API：真数据副本上列表/正确 diff/相同版本空 diff/不存在版本 404", async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "version-compare-http-"));
    const db = new BackendDatabase(path.join(directory, "runtime.sqlite"));
    db.upsertCanvasFolder({ id: "drama-vc", name: "版本对比真数据", isDrama: true, createdAt: new Date().toISOString() });
    db.upsertDramaEpisode({ id: fixture.episodeId, dramaId: "drama-vc", episodeNumber: 1, title: "真数据副本", synopsis: "" });
    for (const item of fixture.versions) {
        db.db.prepare("INSERT INTO episode_production_versions (episode_id, version, stage, snapshot_json, impact_json, created_at) VALUES (?,?,?,?,?,?)")
            .run(fixture.episodeId, item.version, item.stage, item.snapshotJson, item.impactJson, item.createdAt);
    }
    // 真库实测：v3 的 finalResource.storageKey 在 media_files 里 duration_ms=26375（26.375 秒）。
    db.upsertMediaFile({
        storageKey: "video:721ddc9f-0ee0-487c-ace6-a62540119a65",
        filePath: path.join(directory, "final.mp4"), mimeType: "video/mp4", bytes: 4467551,
        width: null, height: null, durationMs: 26375, createdAt: new Date().toISOString(), sha256: null,
    });
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

    const legacy = await get("/versions");
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.versions.length, 3, "既有版本列表 API 继续可用");

    const list = await get("/version-compare/versions");
    assert.equal(list.status, 200);
    assert.equal(list.body.ok, true);
    assert.equal(list.body.versions.length, 3);
    assert.deepEqual(list.body.versions.map((v: { version: number }) => v.version), [3, 2, 1]);
    assert.equal(list.body.versions.find((v: { version: number }) => v.version === 3).summary.finalStorageKey, "video:721ddc9f-0ee0-487c-ace6-a62540119a65");
    // 时长真值：无成片的 v1/v2 用 shots 帧数汇总 27 秒；v3 有成片，取 media_files.duration_ms=26.375 秒。
    const byVersion = (n: number) => list.body.versions.find((v: { version: number }) => v.version === n).summary;
    assert.deepEqual([byVersion(2).durationSec, byVersion(2).durationSource, byVersion(2).shotsDurationSec], [27, "shots-frames", 27]);
    assert.deepEqual([byVersion(3).durationSec, byVersion(3).durationSource, byVersion(3).shotsDurationSec], [26.375, "media-file", 27]);

    const v12 = await get("/version-compare/1/2");
    assert.equal(v12.status, 200);
    const c12 = v12.body.comparison;
    assert.equal(c12.changed, true);
    assert.deepEqual([c12.dimensions.h3Clips.from, c12.dimensions.h3Clips.to, c12.dimensions.h3Clips.delta], [0, 4, 4]);
    assert.equal(c12.prompts.added.length, 4);
    assert.equal(c12.from.version, 1);
    assert.equal(c12.to.version, 2);

    const v23 = await get("/version-compare/2/3");
    assert.equal(v23.status, 200);
    const c23 = v23.body.comparison;
    assert.equal(c23.dimensions.segments.delta, -1);
    assert.equal(c23.dimensions.finalStorageKey.to, "video:721ddc9f-0ee0-487c-ace6-a62540119a65");
    assert.deepEqual(c23.segments.added, ["clip-13py4o7f6f2s", "clip-1c02blfa11th", "clip-1sud71iaowbj"]);
    assert.deepEqual([c23.dimensions.durationSec.from, c23.dimensions.durationSec.to, c23.dimensions.durationSec.delta], [27, 26.375, -0.625]);

    const same = await get("/version-compare/2/2");
    assert.equal(same.status, 200);
    assert.equal(same.body.comparison.changed, false);
    for (const dimension of Object.values(same.body.comparison.dimensions)) assert.equal((dimension as { changed: boolean }).changed, false);
    assert.deepEqual(same.body.comparison.shots, { added: [], removed: [], changed: [] });

    const missing = await get("/version-compare/1/99");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.ok, false);
    assert.match(String(missing.body.error), /找不到制作稿版本 v99/);

    const badVersion = await get("/version-compare/1/abc");
    assert.equal(badVersion.status, 400);
});
