import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { dramaProductionPlanSchema } from "@basketikun/canvas-agent/drama/production-contract";
import { BackendDatabase, type PlannedEpisode } from "../db.js";
import { registerDramaSourceChapterRoutes } from "../server/drama-source-chapter-routes.js";
import { registerDramaPlanningStateRoutes } from "../server/drama-planning-routes.js";

const chapterText = (numeral: string, tail: string) => `第${numeral}章\n${tail.repeat(12)}\n\n`;
const source = [
    chapterText("一", "甲在雨夜回到旧城，发现母亲留下的信。"),
    chapterText("二", "乙遵守约定守住码头，却被陌生人跟踪。"),
    chapterText("三", "真相揭开，甲乙在灯塔前作出最后选择。"),
].join("");

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "source-chapter-crud-"));
    const db = new BackendDatabase(path.join(directory, "db.sqlite"));
    const plan = dramaProductionPlanSchema.parse({ sourceScript: source, sourceSplit: { excluded: [], perEpisode: 1, maxChars: 3000 } });
    db.upsertCanvasFolder({ id: "drama", name: "测试剧", isDrama: true, createdAt: "2026-01-01", updatedAt: "2026-01-01", productionPlan: plan });
    const chapters = db.syncSourceChapters("drama", source, { excluded: [], maxChars: 3000 }).chapters;
    const groups: PlannedEpisode[] = [{
        episodeNumber: 1, title: "第一集", synopsis: "甲乙旧城重逢", hook: "", cliffhanger: "",
        chapterIds: chapters.map((chapter) => chapter.id), chapterIndices: chapters.map((chapter) => chapter.chapterIndex),
    }];
    const applied = db.applyPlanBatch({ dramaId: "drama", expectedCursor: 0, lastChapterIndex: chapters.length, groups, planJson: plan });
    return { db, directory, chapters, applied, cleanup: () => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

async function httpFixture(t: { after: (fn: () => void) => void }) {
    const f = fixture();
    const app = express();
    app.use(express.json());
    registerDramaSourceChapterRoutes(app, f.db);
    registerDramaPlanningStateRoutes(app, f.db);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(() => { server.close(); f.cleanup(); });
    const port = (server.address() as AddressInfo).port;
    const call = async (method: string, url: string, body?: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}${url}`, {
            method,
            ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        return { status: res.status, data: await res.json() as Record<string, any> };
    };
    return { ...f, call };
}

test("单章读写 + hash/chars 重算 + 同值幂等 + revision/updatedAt 乐观锁（DB 层）", () => {
    const f = fixture();
    try {
        const target = f.chapters[0]!;
        const fingerprintBefore = f.db.getEpisodePlanningState("drama")!.sourceFingerprint;
        assert.equal(dbHash(f.db, target.id), target.bodyHash);

        const first = f.db.updateSourceChapter({ chapterId: target.id, body: "改写后的第一章正文，甲乙在雨夜重逢。" });
        assert.equal(first.changed, true);
        assert.equal(first.chapter.body, "改写后的第一章正文，甲乙在雨夜重逢。");
        assert.equal(first.chapter.chars, first.chapter.body.length);
        assert.equal(first.chapter.bodyHash, createHash("sha256").update(first.chapter.body).digest("hex"));
        assert.equal(first.chapter.revision, target.revision + 1);
        assert.ok(first.chapter.updatedAt);
        assert.equal(dbHash(f.db, target.id), first.chapter.bodyHash);
        // 正文变了但稳定 ID、章序号、章数、分集 chapterIds 全部不变。
        assert.equal(f.db.getSourceChapter(target.id)?.chapterIndex, target.chapterIndex);
        assert.equal(f.db.getSourceChapter(target.id)?.id, target.id);
        assert.equal(f.db.listSourceChapters("drama").length, f.chapters.length);
        assert.deepEqual(f.db.getDramaEpisode(f.applied.episodes[0]!.id)?.chapterIds, f.chapters.map((c) => c.id));
        // 切章指纹不能因单章编辑而变：否则下次 syncSourceChapters 会按旧全文重切并覆盖已编辑的章正文。
        assert.equal(f.db.getEpisodePlanningState("drama")?.sourceFingerprint, fingerprintBefore);
        const resync = f.db.syncSourceChapters("drama", source, { excluded: [], maxChars: 3000 });
        assert.equal(resync.reused, true);
        assert.equal(f.db.getSourceChapter(target.id)?.body, first.chapter.body);

        // 同值重放（用旧 revision）→ 幂等，不改库、不自增 revision。
        const replay = f.db.updateSourceChapter({ chapterId: target.id, body: first.chapter.body, expectedRevision: target.revision });
        assert.equal(replay.changed, false);
        assert.equal(replay.chapter.revision, first.chapter.revision);
        assert.equal(replay.chapter.bodyHash, first.chapter.bodyHash);

        // 真冲突：不同正文 + 过期 revision → 409 类错误。
        assert.throws(
            () => f.db.updateSourceChapter({ chapterId: target.id, body: "另一种写法", expectedRevision: target.revision }),
            /已被其他窗口修改/,
        );
        assert.throws(
            () => f.db.updateSourceChapter({ chapterId: target.id, body: "另一种写法", expectedUpdatedAt: "stale" }),
            /已被其他窗口修改/,
        );
        // 用当前 revision 写入 → 成功。
        const second = f.db.updateSourceChapter({ chapterId: target.id, body: "第二种写法", expectedRevision: first.chapter.revision });
        assert.equal(second.changed, true);
        assert.equal(second.chapter.revision, first.chapter.revision + 1);
        // 目标不存在 / 校验失败。
        assert.throws(() => f.db.updateSourceChapter({ chapterId: "not-exist", body: "x" }), /章节不存在/);
        assert.throws(() => f.db.updateSourceChapter({ chapterId: target.id, body: "   " }), /原文不能为空/);
        assert.throws(() => f.db.updateSourceChapter({ chapterId: target.id, sourceFormat: "bad" }), /素材类型无效/);
    } finally { f.cleanup(); }
});

function dbHash(db: BackendDatabase, id: string): string {
    return String((db.db.prepare("SELECT body_hash FROM source_chapters WHERE id=?").get(id) as { body_hash: string }).body_hash);
}

test("集→章反查：chapter_ids_json 稳定 ID 还原成覆盖章（含正文、章序升序）", () => {
    const f = fixture();
    try {
        const episode = f.applied.episodes[0]!;
        const chapters = f.db.listEpisodeChapters(episode.id);
        assert.deepEqual(chapters.map((chapter) => chapter.chapterIndex), [1, 2, 3]);
        assert.deepEqual(chapters.map((chapter) => chapter.id), f.chapters.map((chapter) => chapter.id));
        assert.ok(chapters.every((chapter) => chapter.body.length > 0));
        // 乱序的 chapterIds 也按章序号排序返回。
        const shuffled = { ...episode, chapterIds: [f.chapters[2]!.id, f.chapters[0]!.id, f.chapters[1]!.id] };
        f.db.db.prepare("UPDATE drama_episodes SET chapter_ids_json=? WHERE id=?").run(JSON.stringify(shuffled.chapterIds), episode.id);
        assert.deepEqual(f.db.listEpisodeChapters(episode.id).map((chapter) => chapter.chapterIndex), [1, 2, 3]);
        // 老剧目无 chapterIds → 空。
        const legacy = f.db.upsertDramaEpisode({ dramaId: "drama", episodeNumber: 9, title: "老集", synopsis: "【章】旧数据" });
        assert.deepEqual(f.db.listEpisodeChapters(legacy.id), []);
    } finally { f.cleanup(); }
});

test("HTTP 契约：GET 列表/单章含正文、PATCH 重算并提示重新改编、校验与冲突状态", async (t) => {
    const f = await httpFixture(t);
    const target = f.chapters[0]!;
    const episodeId = f.applied.episodes[0]!.id;

    const list = await f.call("GET", "/drama/drama/planning/chapters");
    assert.equal(list.status, 200);
    assert.equal(list.data.chapters.length, 3);
    assert.ok(list.data.chapters[0].body.length > 0);
    assert.equal(list.data.planDone, true);
    const brief = await f.call("GET", "/drama/drama/planning/chapters?include=meta");
    assert.equal(brief.data.chapters[0].body, undefined);

    const single = await f.call("GET", `/drama/chapters/${target.id}?dramaId=drama`);
    assert.equal(single.status, 200);
    assert.equal(single.data.chapter.body, target.body);
    assert.equal(single.data.chapter.revision, target.revision);
    const wrongDrama = await f.call("GET", `/drama/chapters/${target.id}?dramaId=other`);
    assert.equal(wrongDrama.status, 404);

    const episodeChapters = await f.call("GET", `/drama/episodes/${episodeId}/chapters`);
    assert.equal(episodeChapters.status, 200);
    assert.deepEqual(episodeChapters.data.chapters.map((c: any) => c.chapterIndex), [1, 2, 3]);
    assert.ok(episodeChapters.data.chapters.every((c: any) => c.body.length > 0));

    const patched = await f.call("PATCH", `/drama/chapters/${target.id}`, {
        body: "通过 HTTP 保存的第一章正文。", expectedRevision: target.revision,
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.data));
    assert.equal(patched.data.changed, true);
    assert.equal(patched.data.needsRescript, true);
    assert.equal(patched.data.planDone, true);
    assert.match(String(patched.data.message), /重新改编/);
    assert.equal(patched.data.chapter.chars, patched.data.chapter.body.length);

    const replay = await f.call("PATCH", `/drama/chapters/${target.id}`, { body: "通过 HTTP 保存的第一章正文。" });
    assert.equal(replay.data.changed, false);
    assert.equal(replay.data.needsRescript, false);

    const conflict = await f.call("PATCH", `/drama/chapters/${target.id}`, { body: "不同正文", expectedRevision: target.revision });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.code, "CONFLICT");
    assert.equal((await f.call("PATCH", `/drama/chapters/${target.id}`, { body: "" })).status, 400);
    assert.equal((await f.call("PATCH", `/drama/chapters/${target.id}`, { sourceFormat: "bad" })).status, 400);
    assert.equal((await f.call("PATCH", "/drama/chapters/not-exist", { body: "x" })).status, 404);

    const format = await f.call("PATCH", `/drama/chapters/${target.id}`, { sourceFormat: "script" });
    assert.equal(format.status, 200);
    assert.equal(format.data.chapter.sourceFormat, "script");
    assert.deepEqual(format.data.affectedEpisodeIds, [episodeId]);
    assert.equal(f.db.getDramaEpisode(episodeId)?.sourceFormat, "script");
});

test("planDone 分支：章正文仍可改并提示重新改编；剧目级 sourceScript 仍被锁拒绝", async (t) => {
    const f = await httpFixture(t);
    assert.equal(f.db.getEpisodePlanningState("drama")?.planDone, true);
    const target = f.chapters[1]!;

    const patched = await f.call("PATCH", `/drama/chapters/${target.id}`, { body: "plan_done 后仍可改的第二章正文。" });
    assert.equal(patched.status, 200, JSON.stringify(patched.data));
    assert.equal(patched.data.planDone, true);
    assert.equal(patched.data.needsRescript, true);
    assert.equal(f.db.getSourceChapter(target.id)?.body, "plan_done 后仍可改的第二章正文。");

    // 分集结果未变：章数/集数/chapterIds 全不变。
    assert.equal(f.db.listSourceChapters("drama").length, 3);
    assert.equal(f.db.listDramaEpisodes("drama").length, 1);
    assert.deepEqual(f.db.getDramaEpisode(f.applied.episodes[0]!.id)?.chapterIds, f.chapters.map((c) => c.id));

    // 对照：剧目级整份原剧本替换仍被 planDone 锁拒绝（会漂移稳定章 ID）。
    const locked = await f.call("PATCH", "/drama/drama/planning", { sourceScript: source + "\n追加" });
    assert.equal(locked.status, 409);
    assert.match(String(locked.data.error), /分集已完成|不能修改原剧本/);
});
