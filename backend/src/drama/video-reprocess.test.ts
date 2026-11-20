import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { registerDramaVideoReprocessRoutes } from "../server/drama-video-reprocess-routes.js";
import { findReprocessableVideo, reprocessSegmentVideo, VideoReprocessFailure } from "./video-reprocess.js";

type Fixture = ReturnType<typeof fixture>;

function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.upsertCanvasFolder({ id: "drama", name: "Drama", isDrama: true, createdAt: new Date().toISOString() });
    db.createCanvasProject({
        id: "canvas",
        nodes: [{ id: "h3", type: "minimax-h3", metadata: { segments: [{ id: "clip-1", prompt: "a video", results: [{ url: "/media/old", storageKey: "video:old", mimeType: "video/mp4" }] }] } }],
        connections: [],
    });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "E", synopsis: "", canvasId: "canvas" });
    const stores = createStores(db);
    const media = stores.media.store(Buffer.from("video-bytes"), { name: "v.mp4", mimeType: "video/mp4", category: "output" });
    // 已生成但后处理失败：日志 failed 但 outputs 里保留已归档视频。
    const log = db.createGenerationLog({
        projectId: "canvas", nodeId: "h3", segmentId: "clip-1", status: "failed", platform: "h3", model: "fixture",
        runtimeTaskId: "task-1", references: [], inputCounts: {}, startedAt: new Date().toISOString(), durationMs: 0,
        outputs: [{ url: `/media/${media.storageKey}`, storageKey: media.storageKey, mimeType: "video/mp4" }],
        params: {}, error: "媒体尺寸不符合规格",
    });
    db.applyCanvasProjectOperations("canvas", undefined, [{
        type: "update_h3_segment", nodeId: "h3", segmentId: "clip-1",
        patch: { status: "error", errorDetails: "媒体尺寸不符合规格", resultStorageKey: "" },
    }], { runtimeWrite: true });
    return { db, stores, media, log, deps: { db, stores } };
}

function segmentOf(f: Fixture) {
    const project = f.db.getCanvasProject("canvas")!;
    const node = (project.nodes as Array<Record<string, unknown>>)[0];
    return ((node.metadata as Record<string, unknown>).segments as Array<Record<string, unknown>>)[0];
}

test("视频已生成但后处理失败：重跑只回写同一 media，不新建任务、不调模型", async (t) => {
    const f = fixture(t);
    const logsBefore = f.db.listGenerationLogs({ projectId: "canvas" }).length;
    const tasksBefore = f.stores.tasks.list({ limit: 500 }).length;

    const candidate = findReprocessableVideo(f.deps, "ep", "clip-1");
    assert.equal(candidate.storageKey, f.media.storageKey);
    assert.equal(candidate.alreadyReady, false);

    const result = await reprocessSegmentVideo(f.deps, "ep", "clip-1");
    assert.equal(result.ok, true);
    assert.equal((result as { reprocessed?: boolean }).reprocessed, true);
    assert.equal(result.storageKey, f.media.storageKey);
    assert.equal(f.db.getGenerationLog(f.log.id)!.status, "success");
    const segment = segmentOf(f);
    assert.equal(segment.resultStorageKey, f.media.storageKey);
    assert.equal(segment.status, "success");
    assert.equal((segment.results as Array<Record<string, unknown>>).length, 2, "重处理不能抹掉历史产物");
    assert.equal(f.db.listGenerationLogs({ projectId: "canvas" }).length, logsBefore, "重处理不得新建生成日志");
    assert.equal(f.stores.tasks.list({ limit: 500 }).length, tasksBefore, "重处理不得提交新任务/扣费");
});

test("重复重处理幂等：已经绑定当前结果就直接返回 ALREADY_READY", async (t) => {
    const f = fixture(t);
    await reprocessSegmentVideo(f.deps, "ep", "clip-1");
    const again = await reprocessSegmentVideo(f.deps, "ep", "clip-1");
    assert.equal(again.ok, true);
    assert.equal(again.code, "ALREADY_READY");
    assert.equal(segmentOf(f).resultStorageKey, f.media.storageKey);
});

test("没有已归档视频时明确拒绝，不返回伪造成功", async (t) => {
    const f = fixture(t);
    f.stores.logs.update(f.log.id, { outputs: [] });
    await assert.rejects(
        () => reprocessSegmentVideo(f.deps, "ep", "clip-1"),
        (error: unknown) => error instanceof VideoReprocessFailure && error.code === "NO_GENERATED_VIDEO",
    );
    assert.equal(segmentOf(f).resultStorageKey, "");
});

test("媒体不可核验时不回写 Clip，日志保持 failed", async (t) => {
    const f = fixture(t);
    // 有规格门槛 + 假视频字节：ffprobe 无法核验，必须拒绝而不是当成成功。
    f.stores.logs.update(f.log.id, { params: { h3ExecutionContract: {} } });
    await assert.rejects(
        () => reprocessSegmentVideo(f.deps, "ep", "clip-1"),
        (error: unknown) => error instanceof VideoReprocessFailure && error.code === "MEDIA_UNVERIFIABLE",
    );
    assert.equal(f.db.getGenerationLog(f.log.id)!.status, "failed");
    assert.equal(segmentOf(f).resultStorageKey, "");
});

test("规格仍不符时明确拒绝，不把不合规媒体回写成当前结果", async (t) => {
    const f = fixture(t);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "reprocess-spec-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const file = path.join(temp, "small.mp4");
    const encoded = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", file], { stdio: "ignore" });
    if (encoded.status !== 0) { t.skip("ffmpeg 不可用，跳过真实规格核验场景"); return; }
    const media = f.stores.media.store(fs.readFileSync(file), { name: "small.mp4", mimeType: "video/mp4", category: "output" });
    f.stores.logs.update(f.log.id, {
        outputs: [{ url: `/media/${media.storageKey}`, storageKey: media.storageKey, mimeType: "video/mp4" }],
        params: { h3ExecutionContract: {}, aspectRatio: "9:16", megapixels: 0.6 },
    });
    await assert.rejects(
        () => reprocessSegmentVideo(f.deps, "ep", "clip-1"),
        (error: unknown) => error instanceof VideoReprocessFailure && error.code === "SPEC_STILL_MISMATCH",
    );
    assert.equal(f.db.getGenerationLog(f.log.id)!.status, "failed", "核验失败不能把日志改成成功");
    assert.equal(segmentOf(f).resultStorageKey, "", "核验失败不能回写不合规媒体");
});

test("HTTP 端点接线：POST /drama/episodes/:id/segments/:segId/reprocess-video", async (t) => {
    const f = fixture(t);
    const app = express();
    app.use(express.json());
    registerDramaVideoReprocessRoutes(app, f.db, f.stores);
    const server = app.listen(0);
    t.after(() => server.close());
    const port = (server.address() as { port: number }).port;
    const preview = await fetch(`http://127.0.0.1:${port}/drama/episodes/ep/segments/clip-1/reprocess-video`);
    assert.equal((await preview.json() as Record<string, unknown>).reprocessable, true);
    const response = await fetch(`http://127.0.0.1:${port}/drama/episodes/ep/segments/clip-1/reprocess-video`, { method: "POST" });
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.code, "REPROCESSED");
    assert.equal(body.storageKey, f.media.storageKey);

    const missing = await fetch(`http://127.0.0.1:${port}/drama/episodes/ep/segments/nope/reprocess-video`, { method: "POST" });
    assert.equal(missing.status, 409);
    assert.equal((await missing.json() as Record<string, unknown>).code, "NO_GENERATED_VIDEO");
});
