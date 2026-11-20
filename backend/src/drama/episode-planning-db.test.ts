import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { dramaProductionPlanSchema } from "@basketikun/canvas-agent/drama/production-contract";
import { BackendDatabase, type PlannedEpisode } from "../db.js";
import { CURRENT_DATABASE_SCHEMA } from "../database-schema.js";

const sourceText = () => {
    let text = "";
    for (let index = 1; index <= 14; index += 1) {
        text += `第${index}章\n${`这是第${index}章的正文，人物在这一章里展开行动与冲突。`.repeat(8)}\n\n`;
    }
    return text;
};

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "episode-planning-db-"));
    const db = new BackendDatabase(path.join(directory, "db.sqlite"));
    const source = sourceText();
    const plan = dramaProductionPlanSchema.parse({ sourceScript: source, sourceSplit: { excluded: [], perEpisode: 1, maxChars: 3000 }, episodeMode: "auto" });
    db.upsertCanvasFolder({ id: "drama", name: "测试剧", isDrama: true, createdAt: "2026-01-01", updatedAt: "2026-01-01", productionPlan: plan });
    return { db, directory, plan, source };
}

function planned(index: number, id: string, number: number): PlannedEpisode {
    return {
        episodeNumber: number, title: `第 ${index} 集`, synopsis: `章 ${index} 原文`, hook: "", cliffhanger: "",
        chapterIds: [id], chapterIndices: [index],
    };
}

test("现有 v53 运行库直接补表补列，不升 schema version、不要求迁移", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "episode-planning-migrate-"));
    const file = path.join(directory, "db.sqlite");
    const raw = new DatabaseSync(file);
    try {
        raw.exec(CURRENT_DATABASE_SCHEMA);
        raw.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(53, new Date().toISOString());
    } finally { raw.close(); }
    const db = new BackendDatabase(file);
    try {
        assert.ok(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_chapters'").get());
        assert.ok(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='drama_episode_planning_state'").get());
        const columns = db.db.prepare("PRAGMA table_info(drama_episodes)").all() as Array<{ name: string }>;
        assert.ok(columns.some((column) => column.name === "chapter_ids_json"));
        assert.equal((db.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, 53);
    } finally {
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("稳定章节 ID：首次切章落库，重复调用原样复用；正文变了 ID 不变", () => {
    const { db, directory, plan, source } = fixture();
    try {
        const first = db.syncSourceChapters("drama", source, { excluded: [], maxChars: 3000 });
        assert.equal(first.chapters.length, 14);
        assert.equal(first.reused, false);
        assert.deepEqual(first.chapters.map((chapter) => chapter.chapterIndex), Array.from({ length: 14 }, (_, index) => index + 1));
        assert.equal(new Set(first.chapters.map((chapter) => chapter.id)).size, 14);
        assert.equal(db.getEpisodePlanningState("drama")?.planCursor, 0);

        const again = db.syncSourceChapters("drama", source, { excluded: [], maxChars: 3000 });
        assert.equal(again.reused, true);
        assert.deepEqual(again.chapters.map((chapter) => chapter.id), first.chapters.map((chapter) => chapter.id));

        const edited = source.replace("这是第3章的正文", "这是第3章改写后的正文");
        const changed = db.syncSourceChapters("drama", edited, { excluded: [], maxChars: 3000 });
        assert.equal(changed.reused, false);
        assert.deepEqual(changed.chapters.map((chapter) => chapter.id), first.chapters.map((chapter) => chapter.id));
        assert.notEqual(changed.chapters[2].bodyHash, first.chapters[2].bodyHash);
    } finally {
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("游标推进 + 单事务批量建集 + 完成锁定 + CAS 幂等重放", () => {
    const { db, directory, plan } = fixture();
    try {
        const chapters = db.syncSourceChapters("drama", plan.sourceScript, { excluded: [], maxChars: 3000 }).chapters;
        const byIndex = new Map(chapters.map((chapter) => [chapter.chapterIndex, chapter]));
        const state = db.getEpisodePlanningState("drama")!;
        assert.deepEqual([state.planCursor, state.planDone, state.lastChapterIndex], [0, false, 14]);

        // 第一批 1–12 章，单事务建 12 集，游标推进到 13，未完成。
        const batch1 = Array.from({ length: 12 }, (_, offset) => planned(offset + 1, byIndex.get(offset + 1)!.id, offset + 1));
        const first = db.applyPlanBatch({ dramaId: "drama", expectedCursor: 0, lastChapterIndex: 14, groups: batch1, planJson: plan });
        assert.deepEqual([first.nextCursor, first.planDone, first.replayed], [13, false, false]);
        assert.equal(db.listDramaEpisodes("drama").length, 12);
        assert.deepEqual(db.listDramaEpisodes("drama")[0].chapterIds, [byIndex.get(1)!.id]);
        assert.equal(db.getEpisodePlanningState("drama")?.planCursor, 13);

        // 同批重放（游标已推进）→ 原样返回，不追加集、不推进游标。
        const replay = db.applyPlanBatch({ dramaId: "drama", expectedCursor: 0, lastChapterIndex: 14, groups: batch1, planJson: plan });
        assert.equal(replay.replayed, true);
        assert.equal(replay.nextCursor, 13);
        assert.equal(db.listDramaEpisodes("drama").length, 12);

        // 游标不匹配且不是重放 → CAS 拒绝。
        const bogus = [planned(13, byIndex.get(13)!.id, 13)];
        assert.throws(() => db.applyPlanBatch({ dramaId: "drama", expectedCursor: 0, lastChapterIndex: 14, groups: bogus, planJson: plan }), /游标已变化/);

        // 第二批 13–14 章，游标推进到 15 > 14 → 完成锁定。
        const batch2 = [planned(13, byIndex.get(13)!.id, 13), planned(14, byIndex.get(14)!.id, 14)];
        const second = db.applyPlanBatch({ dramaId: "drama", expectedCursor: 13, lastChapterIndex: 14, groups: batch2, planJson: plan });
        assert.deepEqual([second.nextCursor, second.planDone], [15, true]);
        assert.equal(db.listDramaEpisodes("drama").length, 14);
        assert.equal(db.getEpisodePlanningState("drama")?.planDone, true);

        // 完成后任何新增剧本/改分集方式都被拒。
        assert.throws(() => db.applyPlanBatch({ dramaId: "drama", expectedCursor: 15, lastChapterIndex: 14, groups: [planned(14, byIndex.get(14)!.id, 15)], planJson: plan }), /已完成/);
        assert.throws(() => db.setEpisodePlanningMode("drama", "chapter"), /已完成/);
        assert.equal(db.listDramaEpisodes("drama").length, 14);
    } finally {
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("章序号真值链：建集写入的 chapterIds 能还原成升序章序号，老剧目空列表回退空", () => {
    const { db, directory, plan } = fixture();
    try {
        const chapters = db.syncSourceChapters("drama", plan.sourceScript, { excluded: [], maxChars: 3000 }).chapters;
        const byIndex = new Map(chapters.map((chapter) => [chapter.chapterIndex, chapter]));
        // 一集多章且传入乱序：先按章序号排序再写 chapter_ids_json。
        const multi = { ...planned(1, byIndex.get(1)!.id, 1), chapterIds: [byIndex.get(3)!.id, byIndex.get(1)!.id, byIndex.get(2)!.id], chapterIndices: [3, 1, 2] };
        const result = db.applyPlanBatch({ dramaId: "drama", expectedCursor: 0, lastChapterIndex: 14, groups: [multi], planJson: plan });
        const episode = result.episodes[0]!;
        assert.deepEqual(db.resolveEpisodeChapterNumbers(episode.id), [1, 2, 3]);
        // 没走新规划的集：chapter_ids_json 为空 → 空章列表，造型选图回退主图。
        const legacy = db.upsertDramaEpisode({ dramaId: "drama", episodeNumber: 2, title: "老集", synopsis: "【章】旧数据" });
        assert.deepEqual(db.resolveEpisodeChapterNumbers(legacy.id), []);
    } finally {
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
