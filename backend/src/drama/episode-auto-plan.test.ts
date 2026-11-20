import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { dramaProductionPlanSchema } from "@basketikun/canvas-agent/drama/production-contract";
import { BackendDatabase, type PlannedEpisode } from "../db.js";
import { BackendEventBus } from "../events.js";
import { startServer } from "../server.js";
import { autoPlanAllBatches, registerDramaEpisodeGroupingRoutes } from "../server/drama-planning-routes.js";

const sourceText = () => {
    let text = "";
    for (let index = 1; index <= 14; index += 1) {
        text += `第${index}章\n${`这是第${index}章的正文，人物在这一章里展开行动与冲突。`.repeat(8)}\n\n`;
    }
    return text;
};

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "episode-auto-plan-"));
    const db = new BackendDatabase(path.join(directory, "db.sqlite"));
    const source = sourceText();
    const plan = dramaProductionPlanSchema.parse({ sourceScript: source, sourceSplit: { excluded: [], perEpisode: 1, maxChars: 3000 }, episodeMode: "auto" });
    db.upsertCanvasFolder({ id: "drama", name: "测试剧", isDrama: true, createdAt: "2026-01-01", updatedAt: "2026-01-01", productionPlan: plan });
    return { db, directory, plan, source };
}

/** 把 14 章一次建完，得到 plan_done=true 的剧目，用于手工加集锁测试。 */
function finishPlanning(db: BackendDatabase, plan: ReturnType<typeof dramaProductionPlanSchema.parse>) {
    const chapters = db.syncSourceChapters("drama", plan.sourceScript, { excluded: [], maxChars: 3000 }).chapters;
    const byIndex = new Map(chapters.map((chapter) => [chapter.chapterIndex, chapter]));
    const make = (index: number, number: number): PlannedEpisode => ({
        episodeNumber: number, title: `第 ${index} 集`, synopsis: `章 ${index}`, hook: "", cliffhanger: "",
        chapterIds: [byIndex.get(index)!.id], chapterIndices: [index],
    });
    db.applyPlanBatch({
        dramaId: "drama", expectedCursor: 0, lastChapterIndex: 14,
        groups: Array.from({ length: 14 }, (_, offset) => make(offset + 1, offset + 1)), planJson: plan,
    });
}

/** 每次按本批章序号一章一集，便于精确核对覆盖与游标；failOnCall 可注入中断。 */
/** DramaEpisode 只暴露 chapterIds，映射回稳定章节 ID 对应的章序号。 */
function coveredIndices(db: BackendDatabase, chapterIds: readonly string[]): number[] {
    const byId = new Map(db.listSourceChapters("drama").map((chapter) => [chapter.id, chapter.chapterIndex]));
    return chapterIds.map((id) => byId.get(id)!).sort((left, right) => left - right);
}

function proposer(failOnCall = 0) {
    let calls = 0;
    const propose = async (input: { chapters: readonly { index: number; title: string }[] }) => {
        calls += 1;
        if (calls === failOnCall) throw new Error("模拟文本模型中断");
        return {
            model: "fake-text-model",
            groups: input.chapters.map((chapter) => ({
                title: `第${chapter.index}集`, chapters: [chapter.index], synopsis: `梗概${chapter.index}`, hook: "", cliffhanger: "",
            })),
        };
    };
    return { propose, get calls() { return calls; } };
}

test("plan_done 后允许手工追加新集，规划未完成时被拒（409），重复编号与无 planning 记录保持原行为", async (t) => {
    const { db, directory, plan } = fixture();
    const config = { url: "http://127.0.0.1", token: "test", port: 0, origins: [] as string[] };
    const { app } = startServer(db, config);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(() => { server.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const postEpisode = async (dramaId: string, episodeNumber: number, title = "手工集") => {
        const res = await fetch(`${url}/drama/projects/${dramaId}/episodes`, {
            method: "POST", headers: { Authorization: "Bearer test", "content-type": "application/json" },
            body: JSON.stringify({ episodeNumber, title, synopsis: "", fullPlot: "" }),
        });
        return { status: res.status, data: await res.json() as Record<string, unknown> };
    };

    finishPlanning(db, plan);
    assert.equal(db.getEpisodePlanningState("drama")?.planDone, true);

    // 影策语义：plan_done=true 后允许逐集追加新集（repository_drama.go:140 / detail.tsx:821）。
    const appended = await postEpisode("drama", 15);
    assert.equal(appended.status, 201, JSON.stringify(appended.data));
    assert.ok(db.getDramaEpisodeByNumber("drama", 15));

    // 规划未完成（plan_done=false）时新增集号 → 409。
    db.upsertCanvasFolder({ id: "planning", name: "规划中", isDrama: true, createdAt: "2026-01-01", updatedAt: "2026-01-01", productionPlan: plan });
    const chapters = db.syncSourceChapters("planning", plan.sourceScript, { excluded: [], maxChars: 3000 }).chapters;
    const byIndex = new Map(chapters.map((c) => [c.chapterIndex, c]));
    // 只覆盖第 1 章，lastChapterIndex=14 → planDone 仍为 false。
    db.applyPlanBatch({
        dramaId: "planning", expectedCursor: 0, lastChapterIndex: 14, planJson: plan,
        groups: [{ episodeNumber: 1, title: "第 1 集", synopsis: "章 1", hook: "", cliffhanger: "", chapterIds: [byIndex.get(1)!.id], chapterIndices: [1] }],
    });
    assert.equal(db.getEpisodePlanningState("planning")?.planDone, false);
    const rejected = await postEpisode("planning", 2);
    assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
    assert.match(String(rejected.data.error), /规划尚未完成|plan_done|分集规划/);
    assert.equal(db.getDramaEpisodeByNumber("planning", 2), null);

    // 门禁只拦「新增集号」：既有集号走原来的重复编号校验，不改变既有行为。
    const duplicate = await postEpisode("drama", 1, "改过的标题");
    assert.equal(duplicate.status, 409);
    assert.match(String(duplicate.data.error), /分集编号已存在/);
    assert.doesNotThrow(() => db.assertDramaEpisodeCreationAllowed("drama", 1));

    // 没有 planning 记录的剧目保持原行为：新剧目首集照常建。
    db.upsertCanvasFolder({ id: "fresh", name: "新剧", isDrama: true, createdAt: "2026-01-01", updatedAt: "2026-01-01", productionPlan: plan });
    const fresh = await postEpisode("fresh", 1, "第一集");
    assert.equal(fresh.status, 201, JSON.stringify(fresh.data));
    assert.equal(db.getDramaEpisodeByNumber("fresh", 1)?.title, "第一集");
});

test("自动连跑：一次触发跨两批推进到 plan_done，完成后重复调用幂等", async (t) => {
    const { db, directory, plan } = fixture();
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const events = new BackendEventBus();
    const fake = proposer();
    const first = await autoPlanAllBatches(db, events, { settings: { get: () => ({ channels: [] }) } } as never, "drama", {}, fake.propose);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(first.batches.map((batch) => [batch.cursor, batch.nextCursor]), [[0, 13], [13, 15]]);
    assert.deepEqual([first.planCursor, first.planDone], [15, true]);
    assert.equal(db.listDramaEpisodes("drama").length, 14);
    assert.equal(db.getEpisodePlanningState("drama")?.planDone, true);
    assert.equal(db.listCanvasFolders("drama")[0].productionPlan?.episodeMode, "auto");
    assert.equal(db.listCanvasFolders("drama")[0].productionPlan?.modelEpisodeGroups.length, 14);
    const covered = coveredIndices(db, db.listDramaEpisodes("drama").flatMap((episode) => episode.chapterIds));
    assert.deepEqual(covered, Array.from({ length: 14 }, (_, index) => index + 1));

    const again = await autoPlanAllBatches(db, events, { settings: { get: () => ({ channels: [] }) } } as never, "drama", {}, fake.propose);
    assert.equal(again.ok, true);
    assert.equal(again.batches.length, 0);
    assert.equal(db.listDramaEpisodes("drama").length, 14);
    assert.equal(again.planCursor, 15);
    assert.equal(fake.calls, 2, "完成后不能再调用模型");
});

test("中断一致：中途 LLM 失败只保留已提交的完整批次，游标一致，再触发续跑到 done", async (t) => {
    const { db, directory, plan } = fixture();
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const events = new BackendEventBus();
    const stores = { settings: { get: () => ({ channels: [] }) } } as never;

    // 第 2 批（第 13–14 章）在 LLM 处中断：第 1 批已单事务提交，不能回滚成半套。
    const broken = proposer(2);
    const failed = await autoPlanAllBatches(db, events, stores, "drama", {}, broken.propose);
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 400);
    assert.match(String(failed.error), /第 2 批.*中断/);
    assert.deepEqual([failed.planCursor, failed.planDone], [13, false]);
    const episodes = db.listDramaEpisodes("drama");
    assert.equal(episodes.length, 12);
    assert.equal(coveredIndices(db, episodes.flatMap((episode) => episode.chapterIds)).includes(13), false);
    assert.equal(db.getEpisodePlanningState("drama")?.lastChapterIndex, 14);
    // 已提交的 12 集每一集都完整覆盖自己的章节，不存在半集。
    assert.ok(episodes.every((episode) => episode.chapterIds.length > 0));

    // 换新 proposer 从游标续跑：只补第 2 批，不重复第 1 批。
    const healthy = proposer();
    const resumed = await autoPlanAllBatches(db, events, stores, "drama", {}, healthy.propose);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.deepEqual(resumed.batches.map((batch) => batch.cursor), [13]);
    assert.deepEqual([resumed.planCursor, resumed.planDone], [15, true]);
    assert.equal(db.listDramaEpisodes("drama").length, 14);
    assert.deepEqual(coveredIndices(db, db.listDramaEpisodes("drama").flatMap((episode) => episode.chapterIds)), Array.from({ length: 14 }, (_, index) => index + 1));
});

test("自动规划端点接线：剧目不存在 404；未配置文本模型如实 400 且不建集", async (t) => {
    const { db, directory } = fixture();
    const config = { url: "http://127.0.0.1", token: "test", port: 0, origins: [] as string[] };
    const { app } = startServer(db, config);
    // startServer 本身不注册规划路由（index.ts 才注册），测试里显式挂上同一份路由。
    registerDramaEpisodeGroupingRoutes(app, db, { settings: { get: () => ({ channels: [] }) } } as never, new BackendEventBus());
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(() => { server.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (pathname: string) => {
        const res = await fetch(`${url}${pathname}`, { method: "POST", headers: { Authorization: "Bearer test", "content-type": "application/json" }, body: "{}" });
        return { status: res.status, data: await res.json() as Record<string, unknown> };
    };
    const missing = await post("/drama/nope/planning/episode-grouping-auto");
    assert.equal(missing.status, 404);
    const noModel = await post("/drama/drama/planning/episode-grouping-auto");
    assert.equal(noModel.status, 400);
    assert.match(String(noModel.data.error), /文本模型|模型/);
    assert.equal(db.listDramaEpisodes("drama").length, 0);
    assert.equal(db.getEpisodePlanningState("drama")?.planCursor, 0);
});
