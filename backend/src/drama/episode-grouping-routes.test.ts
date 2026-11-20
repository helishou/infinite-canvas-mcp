import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { dramaProductionPlanSchema } from "@basketikun/canvas-agent/drama/production-contract";
import { analyzeNovelChapters } from "@basketikun/canvas-agent/drama/novel-chapters";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { registerDramaEpisodeGroupingRoutes, registerDramaPlanningStateRoutes } from "../server/drama-planning-routes.js";

const chapterText = (numeral: string, tail: string) => `第${numeral}章\n${tail.repeat(12)}\n\n`;
const source = [
    chapterText("一", "甲在雨夜回到旧城，发现母亲留下的信。"),
    chapterText("二", "乙遵守约定守住码头，却被陌生人跟踪。"),
    chapterText("三", "真相揭开，甲乙在灯塔前作出最后选择。"),
].join("");

test("分集路由：模型缺失如实报错；漏章拒绝；apply 单事务建集+稳定章ID；重放幂等；完成锁定", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "episode-grouping-routes-"));
    const db = new BackendDatabase(path.join(directory, "db.sqlite"));
    const app = express();
    app.use(express.json());
    registerDramaEpisodeGroupingRoutes(app, db, { settings: { get: () => ({ channels: [] }) } } as never, new BackendEventBus());
    registerDramaPlanningStateRoutes(app, db);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(() => {
        server.close();
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const port = (server.address() as AddressInfo).port;
    const post = async (url: string, body: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: res.status, data: await res.json() as Record<string, unknown> };
    };
    const patch = async (url: string, body: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}${url}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: res.status, data: await res.json() as Record<string, unknown> };
    };

    const get = async (url: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${url}`);
        return { status: res.status, data: await res.json() as Record<string, unknown> };
    };

    const plan = dramaProductionPlanSchema.parse({ sourceScript: source, sourceSplit: { excluded: [], perEpisode: 1, maxChars: 3000 } });
    const folder = db.upsertCanvasFolder({ id: "drama", name: "测试剧", isDrama: true, createdAt: "2026-01-01", updatedAt: "2026-01-01", productionPlan: plan });
    const indices = analyzeNovelChapters(source, { maxChars: 3000, minChars: 200 }).chapters.map((chapter) => chapter.index);
    assert.equal(indices.length, 3);

    // 没有配置文本模型：预览必须如实报错，不能返回凭空分组，也不能改库。
    const preview = await post("/drama/drama/planning/episode-grouping-preview", {});
    assert.equal(preview.status, 400);
    assert.match(String(preview.data.error), /文本模型/);
    assert.equal(db.listDramaEpisodes("drama").length, 0);
    assert.equal(db.listCanvasFolders("drama")[0].productionPlan?.episodeMode, undefined);

    // 首次切章已落稳定章节 ID，重复调用复用同一批 ID。
    const chapters = db.syncSourceChapters("drama", source, { excluded: [], maxChars: 3000 });
    const again = db.syncSourceChapters("drama", source, { excluded: [], maxChars: 3000 });
    assert.equal(again.reused, true);
    assert.deepEqual(again.chapters.map((chapter) => chapter.id), chapters.chapters.map((chapter) => chapter.id));

    // 设置页切换模式走既有 planning PATCH，真值写进 productionPlan + 游标状态。
    const savedMode = await patch("/drama/drama/planning", { episodeMode: "auto", expectedUpdatedAt: folder.updatedAt });
    assert.equal(savedMode.status, 200, JSON.stringify(savedMode.data));
    assert.equal(db.listCanvasFolders("drama")[0].productionPlan?.episodeMode, "auto");
    assert.equal(db.getEpisodePlanningState("drama")?.episodeMode, "auto");

    // 用户确认后的分组：合并 1+2、单章 3，覆盖全部章。
    const groups = [
        { title: "雨夜旧城", chapters: [indices[0], indices[1]], synopsis: "甲乙在旧城重逢。", hook: "雨夜来信", cliffhanger: "码头跟踪者" },
        { title: "灯塔抉择", chapters: [indices[2]], synopsis: "真相揭开。", hook: "灯塔", cliffhanger: "最后选择" },
    ];

    // 漏章确认被拒绝：游标仍为 0、不建集。
    const rejected = await post("/drama/drama/planning/episode-grouping-apply", {
        groups: [groups[0]], expectedUpdatedAt: String(savedMode.data.updatedAt),
    });
    assert.equal(rejected.status, 400);
    assert.match(String(rejected.data.error), /没有覆盖当前批次章节/);
    assert.equal(db.listDramaEpisodes("drama").length, 0);
    assert.equal(db.getEpisodePlanningState("drama")?.planCursor, 0);

    // 完整确认：单事务建 2 集，章 ID 落每集，游标推进到 4、plan_done=true。
    const applied = await post("/drama/drama/planning/episode-grouping-apply", { groups, expectedUpdatedAt: String(savedMode.data.updatedAt) });
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    const episodes = db.listDramaEpisodes("drama");
    assert.deepEqual(episodes.map((episode) => episode.episodeNumber), [1, 2]);
    assert.deepEqual(episodes.map((episode) => episode.title), ["雨夜旧城", "灯塔抉择"]);
    assert.match(episodes[0].synopsis, /^【章】/);
    assert.deepEqual(episodes[0].chapterIds, [chapters.chapters[0].id, chapters.chapters[1].id]);
    assert.equal(applied.data.planCursor, 4);
    assert.equal(applied.data.planDone, true);
    assert.equal(db.getEpisodePlanningState("drama")?.planDone, true);
    assert.equal(db.listCanvasFolders("drama")[0].productionPlan?.episodeMode, "auto");
    assert.equal(db.listCanvasFolders("drama")[0].productionPlan?.modelEpisodeGroups.length, 2);
    const updatedAt = String(applied.data.updatedAt);

    // GET planning 把游标状态给前端用于完成锁定。
    const stateRes = await get("/drama/drama/planning");
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.data.planDone, true);
    assert.equal(stateRes.data.planCursor, 4);

    // 同一份确认重放：不追加集、不推进游标（幂等）。
    const replay = await post("/drama/drama/planning/episode-grouping-apply", { groups, expectedUpdatedAt: updatedAt });
    assert.equal(replay.status, 200, JSON.stringify(replay.data));
    assert.equal(replay.data.replayed, true);
    assert.equal(db.listDramaEpisodes("drama").length, 2);

    // 完成后拒绝改分集方式。
    const lockedMode = await patch("/drama/drama/planning", { episodeMode: "chapter", expectedUpdatedAt: updatedAt });
    assert.equal(lockedMode.status, 409);
    assert.match(String(lockedMode.data.error), /已完成/);

    // 完成后拒绝改分集结果（改标题避开重放判定）。
    const lockedApply = await post("/drama/drama/planning/episode-grouping-apply", {
        groups: [{ ...groups[0], title: "改写后的集" }, groups[1]], expectedUpdatedAt: updatedAt,
    });
    assert.equal(lockedApply.status, 409);
    assert.match(String(lockedApply.data.error), /已完成/);
    assert.equal(db.listDramaEpisodes("drama").length, 2);

    // 完成后预览直接返回完成态，不再重算原文（fingerprint 不变）；改原剧本也被拒。
    const fingerprintBefore = db.getEpisodePlanningState("drama")!.sourceFingerprint;
    const lockedPreview = await post("/drama/drama/planning/episode-grouping-preview", {});
    assert.equal(lockedPreview.status, 200);
    assert.equal(lockedPreview.data.done, true);
    assert.equal(db.getEpisodePlanningState("drama")!.sourceFingerprint, fingerprintBefore);
    const lockedSource = await patch("/drama/drama/planning", { sourceScript: "换掉的原文", expectedUpdatedAt: updatedAt });
    assert.equal(lockedSource.status, 409);
});
