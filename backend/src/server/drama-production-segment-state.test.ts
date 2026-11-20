import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test, { type TestContext } from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { EpisodeProductionService } from "../drama/production.js";
import { withSegmentState } from "../drama/segment-state.js";
import { readSegmentStateRuntime, registerDramaProductionRoutes } from "../server/drama-production-routes.js";
import { emptyEpisodeProduction } from "@basketikun/canvas-agent/drama/production-contract";

/** 真值 fixture：剧集绑定画布，两个 H3 Clip 分别对应两个 draft 段。 */
function fixture(t: TestContext) {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.upsertCanvasFolder({ id: "drama", name: "Drama", isDrama: true, createdAt: new Date().toISOString() });
    db.createCanvasProject({
        id: "canvas",
        nodes: [{ id: "h3", type: "minimax-h3", metadata: { segments: [
            { id: "clip-1", prompt: "手写提示词", promptCustom: true, productionClipProjection: { targetId: "E01-SEG01" }, status: "error", resultStorageKey: "" },
            { id: "clip-2", prompt: "LLM 提示词", promptCustom: false, productionClipProjection: { targetId: "E01-SEG02" }, status: "success", resultStorageKey: "" },
        ] } }],
        connections: [],
    });
    db.upsertDramaEpisode({ id: "ep", dramaId: "drama", episodeNumber: 1, title: "E", synopsis: "", canvasId: "canvas" });
    const stores = createStores(db);
    const media1 = stores.media.store(Buffer.from("video-bytes-1"), { name: "v1.mp4", mimeType: "video/mp4", category: "output" });
    const media2 = stores.media.store(Buffer.from("video-bytes-2"), { name: "v2.mp4", mimeType: "video/mp4", category: "output" });
    const now = new Date().toISOString();
    // clip-1：已归档视频 + 日志 failed → 后处理失败，可重跑。
    db.createGenerationLog({
        projectId: "canvas", nodeId: "h3", segmentId: "clip-1", status: "failed", platform: "h3", model: "fixture",
        runtimeTaskId: "task-1", references: [], inputCounts: {}, startedAt: now, durationMs: 0,
        outputs: [{ url: `/media/${media1.storageKey}`, storageKey: media1.storageKey, mimeType: "video/mp4" }],
        params: {}, error: "尾帧回写失败",
    });
    // clip-2：日志 success 且结果已绑定 → alreadyReady，不可重跑。
    db.createGenerationLog({
        projectId: "canvas", nodeId: "h3", segmentId: "clip-2", status: "success", platform: "h3", model: "fixture",
        runtimeTaskId: "task-2", references: [], inputCounts: {}, startedAt: now, durationMs: 0,
        outputs: [{ url: `/media/${media2.storageKey}`, storageKey: media2.storageKey, mimeType: "video/mp4" }],
        params: {}, error: "",
    });
    db.applyCanvasProjectOperations("canvas", undefined, [{
        type: "update_h3_segment", nodeId: "h3", segmentId: "clip-2",
        patch: { status: "success", resultStorageKey: media2.storageKey },
    }], { runtimeWrite: true });
    const service = {
        storageDatabase: () => db,
        episodeInfo: (id: string) => ({ id, canvasId: id === "ep" ? "canvas" : null }),
    } as unknown as EpisodeProductionService;
    return { db, stores, media1, media2, service };
}

const clipOf = (db: BackendDatabase, id: string) =>
    ((db.getCanvasProject("canvas")!.nodes as Array<Record<string, any>>)[0].metadata.segments as Array<Record<string, any>>)
        .find(seg => seg.id === id)!;

test("promptCustom 实测：applyCanvasProjectOperations 写入并回读（含白名单/类型校验）", (t) => {
    const { db } = fixture(t);
    assert.equal(clipOf(db, "clip-1").promptCustom, true, "fixture 初始真值");

    // 与前端 saveSegmentPrompt(..., custom) 完全同一条写入路径：客户端来源 + update_h3_segment patch。
    const result = db.applyCanvasProjectOperations("canvas", undefined, [{
        type: "update_h3_segment", nodeId: "h3", segmentId: "clip-1", patch: { promptCustom: false },
    }], { operationId: "pc-write", source: { kind: "user" } });
    assert.equal(((result.project.nodes as Array<Record<string, any>>)[0].metadata.segments as Array<Record<string, any>>)[0].promptCustom, false);
    assert.equal(clipOf(db, "clip-1").promptCustom, false, "回读必须是写入值");

    // LLM 路：同一路径写回 false，再切回 true，验证两个方向都真实落库。
    db.applyCanvasProjectOperations("canvas", undefined, [{
        type: "update_h3_segment", nodeId: "h3", segmentId: "clip-2", patch: { promptCustom: true },
    }], { operationId: "pc-write-2", source: { kind: "user" } });
    assert.equal(clipOf(db, "clip-2").promptCustom, true, "手写改写应落 true");

    // 非 boolean 被 validateH3Edit 拦下，且整批无部分写入。
    assert.throws(() => db.applyCanvasProjectOperations("canvas", undefined, [{
        type: "update_h3_segment", nodeId: "h3", segmentId: "clip-1", patch: { promptCustom: "yes" },
    }], { operationId: "pc-bad" }), /promptCustom 必须为 boolean/);
    assert.equal(clipOf(db, "clip-1").promptCustom, false, "非法写入不得改动库");
});

test("readSegmentStateRuntime 从画布与生成日志派生 custom/videoReprocessable 真值", (t) => {
    const { service } = fixture(t);
    const runtime = readSegmentStateRuntime(service, "ep");
    assert.ok(runtime, "真库场景必须拿到运行态");
    assert.deepEqual(runtime.customSegments, { "E01-SEG01": true, "E01-SEG02": false });
    assert.deepEqual(runtime.reprocessableSegments, { "E01-SEG01": true, "E01-SEG02": false });

    // 无画布/无剧集 → 派生成 undefined，不抛错、不编造。
    const missing = {
        storageDatabase: () => service.storageDatabase(),
        episodeInfo: () => ({ id: "ep", canvasId: null }),
    } as unknown as EpisodeProductionService;
    const bare = readSegmentStateRuntime(missing, "ep");
    assert.equal(bare?.customSegments, undefined);
    assert.equal(bare?.reprocessableSegments, undefined);
});

test("route 派生 runtime 经 withSegmentState 下发到每段 state", (t) => {
    const { service } = fixture(t);
    const runtime = readSegmentStateRuntime(service, "ep");
    const production = {
        episodeId: "ep", revision: 1,
        draft: { director: { source: { segments: [{ id: "E01-SEG01" }, { id: "E01-SEG02" }] }, artifacts: [] } },
    };
    const out = withSegmentState(production, runtime, "ep");
    const segs = out.draft.director.source.segments as Array<Record<string, any>>;
    assert.equal(segs[0].state.custom, true, "手写提示词段下发 custom=true");
    assert.equal(segs[0].state.videoReprocessable, true, "后处理失败段下发 videoReprocessable=true");
    assert.equal(segs[1].state.custom, false, "LLM 段下发 custom=false");
    assert.equal(segs[1].state.videoReprocessable, false, "已就绪段下发 videoReprocessable=false");
    assert.equal((production.draft.director.source.segments as Array<Record<string, any>>)[0].state, undefined, "输入不被 mutate");
});

test("HTTP 端到端：GET 制作稿的每段 state 带 custom/videoReprocessable 真值", async (t) => {
    const { db } = fixture(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "segment-state-route-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const director = {
        schemaVersion: 1,
        engine: { commit: "a".repeat(40), patchVersion: "p", runtimeId: "r", version: "4.3.9" },
        source: {
            version: 2, prompt_assembly: { version: 2 }, ledger: { contract_version: 2 },
            segments: [{ id: "E01-SEG01", shot_ids: ["S1"], mode: "Ref2VA" }, { id: "E01-SEG02", shot_ids: ["S2"], mode: "T2VA" }],
        },
        sourceHash: "f".repeat(64), artifacts: [], assets: {}, modules: {}, boundaries: [], shotInputs: {},
        executionAuthorized: false, unresolved: [], workflow: {},
    };
    const draft = { ...emptyEpisodeProduction(), director };
    const now = new Date().toISOString();
    db.db.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?,?,?,?,?,?)")
        .run("ep", 1, JSON.stringify(draft), JSON.stringify(draft), 1, now);

    const app = express();
    app.use(express.json());
    registerDramaProductionRoutes(app, new EpisodeProductionService(db, undefined, dir));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;

    const response = await fetch(`http://127.0.0.1:${port}/drama/episodes/ep/production`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, any>;
    assert.equal(body.ok, true);
    const segs = body.production.draft.director.source.segments as Array<Record<string, any>>;
    assert.deepEqual(segs.map((s) => ({ id: s.id, custom: s.state?.custom, videoReprocessable: s.state?.videoReprocessable })), [
        { id: "E01-SEG01", custom: true, videoReprocessable: true },
        { id: "E01-SEG02", custom: false, videoReprocessable: false },
    ], "GET 响应必须把两门控真值下发到每段 state");
});
