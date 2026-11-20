import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";

test("drama episode REST：剧目、分集、画布三层关系可读写", async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "infinite-canvas-episodes-http-"));
    const file = path.join(directory, "runtime.sqlite");
    const db = new BackendDatabase(file);
    const { app } = startServer(db, { url: "http://127.0.0.1", token: "test-token", port: 0, origins: [] });
    const server = app.listen(0);
    context.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
        rmSync(directory, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const request = async (method: string, requestPath: string, body?: unknown) => {
        const response = await fetch(`${base}${requestPath}${requestPath.includes("?") ? "&" : "?"}token=test-token`, {
            method,
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
    };

    const drama = await request("POST", "/canvas/folders", { id: "drama-1", name: "剧目一", description: "简介正文".repeat(100), outline: "大纲正文".repeat(200), createdAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(drama.status, 201);
    const plannedDrama = await request("GET", "/drama/projects/drama-1");
    assert.equal(plannedDrama.status, 200);
    assert.equal((plannedDrama.body.drama as Record<string, unknown>).name, "剧目一");
    const dramaSummary = (await request("GET", "/drama/projects/drama-1?view=summary")).body.drama as Record<string, unknown>;
    assert.equal(dramaSummary.descriptionLength, "简介正文".repeat(100).length);
    assert.equal(dramaSummary.outlineLength, "大纲正文".repeat(200).length);
    assert.equal(String(dramaSummary.outlinePreview).length, 360);
    assert.equal("outline" in dramaSummary, false);
    assert.equal((await request("GET", "/drama/projects/missing")).status, 404);
    assert.deepEqual((await request("GET", "/drama/projects/drama-1/episodes")).body.episodes, []);

    const canvas1 = await request("POST", "/canvas/projects", { id: "canvas-1", title: "第一集画布", folderId: "drama-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], connections: [] });
    assert.equal(canvas1.status, 201);
    assert.equal(Object.prototype.hasOwnProperty.call(canvas1.body.project, "folderId"), false);
    const canvas2 = await request("POST", "/canvas/projects", { id: "canvas-2", title: "第二集画布", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], connections: [] });
    assert.equal(canvas2.status, 201);

    const created = await request("POST", "/drama/projects/drama-1/episodes", { episodeNumber: 1, title: "第一集", synopsis: "退婚夜", fullPlot: "沈昭宁退婚后潜入书房，找到密令。", canvasId: "canvas-1" });
    assert.equal(created.status, 201);
    const episode = created.body.episode as Record<string, unknown>;
    assert.equal(episode.dramaId, "drama-1");
    assert.equal(episode.canvasId, "canvas-1");
    assert.equal(episode.fullPlot, "沈昭宁退婚后潜入书房，找到密令。");
    const canvasDrama = await request("GET", "/canvas/projects/canvas-1/drama");
    assert.equal(canvasDrama.status, 200);
    assert.equal((canvasDrama.body.episode as Record<string, unknown>).dramaId, "drama-1");
    assert.equal((canvasDrama.body.drama as Record<string, unknown>).name, "剧目一");

    const secondEpisode = await request("POST", "/drama/projects/drama-1/episodes", { episodeNumber: 2, title: "第二集", synopsis: "追查密令", fullPlot: "旧版冗长剧情".repeat(100) });
    assert.equal(secondEpisode.status, 201);

    const listed = await request("GET", "/drama/projects/drama-1/episodes");
    assert.equal(listed.status, 200);
    assert.deepEqual((listed.body.episodes as Array<Record<string, unknown>>).map((item) => item.episodeNumber), [1, 2]);
    assert.ok("fullPlot" in (listed.body.episodes as Array<Record<string, unknown>>)[1], "legacy REST response remains complete");
    const pageOne = await request("GET", "/drama/projects/drama-1/episodes?view=summary&page=1&pageSize=1");
    const pageTwo = await request("GET", "/drama/projects/drama-1/episodes?view=summary&page=2&pageSize=1");
    assert.equal(pageOne.body.total, 2);
    assert.equal(pageOne.body.pageSize, 1);
    assert.deepEqual((pageOne.body.episodes as Array<Record<string, unknown>>).map((item) => item.episodeNumber), [1]);
    assert.deepEqual((pageTwo.body.episodes as Array<Record<string, unknown>>).map((item) => item.episodeNumber), [2]);
    assert.equal("fullPlot" in (pageTwo.body.episodes as Array<Record<string, unknown>>)[0], false);

    const read = await request("GET", `/drama/episodes/${episode.id}`);
    assert.equal(read.status, 200);
    assert.equal((read.body.canvas as Record<string, unknown>).id, "canvas-1");

    const rebound = await request("PATCH", `/drama/episodes/${episode.id}`, { canvasId: "canvas-2" });
    assert.equal(rebound.status, 409);
    assert.equal(db.getDramaEpisodeByCanvasId("canvas-1")?.id, episode.id);
    const unbound = await request("PATCH", `/drama/episodes/${episode.id}`, { canvasId: null });
    assert.equal(unbound.status, 409);
    const updated = await request("PATCH", `/drama/episodes/${episode.id}`, { synopsis: "退婚夜与实名求见", fullPlot: "沈昭宁与谢临渊在南茶楼达成合作。" });
    assert.equal(updated.status, 200);
    assert.equal((updated.body.episode as Record<string, unknown>).canvasId, "canvas-1");
    assert.equal((updated.body.episode as Record<string, unknown>).fullPlot, "沈昭宁与谢临渊在南茶楼达成合作。");

    const deleted = await request("DELETE", `/drama/episodes/${episode.id}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, 1);
    assert.equal((await request("GET", "/canvas/projects/canvas-2")).status, 200, "删分集不应删画布");
    assert.equal((await request("GET", `/drama/episodes/${episode.id}`)).status, 404);

    // 确认测试库没有留下错误的旧直属列
    const columns = db.db.prepare("PRAGMA table_info(canvas_projects)").all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "folder_id"), false);

    const protectedDelete = await request("DELETE", "/canvas/folders/drama-1");
    assert.equal(protectedDelete.status, 409, "画布文件夹入口不应删除短剧项目");
    assert.equal((await request("GET", "/drama/projects/drama-1/episodes")).status, 200);

    const canvasFolder = await request("POST", "/canvas/folders", { id: "canvas-folder-1", name: "普通画布文件夹", isDrama: false, createdAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(canvasFolder.status, 201);
    assert.equal((canvasFolder.body.folder as Record<string, unknown>).isDrama, false);
    const canvasFolderDeleted = await request("DELETE", "/canvas/folders/canvas-folder-1");
    assert.equal(canvasFolderDeleted.status, 200);

    const dramaDeleted = await request("DELETE", "/drama/projects/drama-1");
    assert.equal(dramaDeleted.status, 200);
    assert.equal((await request("GET", "/canvas/projects/canvas-2")).status, 200, "删除剧目仍应保留场景画布");
});

async function episodeCapabilityHarness(context: { after(fn: () => Promise<void> | void): void }) {
    const directory = mkdtempSync(path.join(tmpdir(), "infinite-canvas-episode-caps-"));
    const file = path.join(directory, "runtime.sqlite");
    const db = new BackendDatabase(file);
    const { app } = startServer(db, { url: "http://127.0.0.1", token: "test-token", port: 0, origins: [] });
    const server = app.listen(0);
    context.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
        rmSync(directory, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const request = async (method: string, requestPath: string, body?: unknown) => {
        const response = await fetch(`${base}${requestPath}${requestPath.includes("?") ? "&" : "?"}token=test-token`, {
            method,
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const createDrama = async (id: string) => {
        const drama = await request("POST", "/canvas/folders", { id, name: id, createdAt: "2026-01-01T00:00:00.000Z" });
        assert.equal(drama.status, 201);
    };
    return { db, request, createDrama };
}

test("建集原文：sourceFormat/sourceText 真值落库并读取，字数上限与格式归一生效", async (context) => {
    const { db, request, createDrama } = await episodeCapabilityHarness(context);
    await createDrama("drama-source");

    const created = await request("POST", "/drama/projects/drama-source/episodes", {
        episodeNumber: 1, title: "第一集", sourceFormat: "script", sourceText: "沈昭宁退婚夜\r\n潜入书房找密令",
    });
    assert.equal(created.status, 201);
    const episode = created.body.episode as Record<string, unknown>;
    assert.equal(episode.sourceFormat, "script");
    assert.equal(episode.sourceText, "沈昭宁退婚夜\n潜入书房找密令");
    assert.equal(episode.fullPlot, episode.sourceText, "未显式 fullPlot 时用原文初始化，下游拆解才用得上");
    const row = db.db.prepare("SELECT source_format, source_text FROM drama_episodes WHERE id=?").get(episode.id) as { source_format: string; source_text: string };
    assert.equal(row.source_format, "script");
    assert.equal(row.source_text, "沈昭宁退婚夜\n潜入书房找密令", "真值在 drama_episodes 本行，没有第二份副本");

    const listed = await request("GET", "/drama/projects/drama-source/episodes");
    assert.equal((listed.body.episodes as Array<Record<string, unknown>>)[0].sourceFormat, "script");
    const read = await request("GET", `/drama/episodes/${episode.id}`);
    assert.equal((read.body.episode as Record<string, unknown>).sourceText, episode.sourceText);

    const unknownFormat = await request("POST", "/drama/projects/drama-source/episodes", { episodeNumber: 2, sourceText: "  乙集原文  ", sourceFormat: "unknown-kind" });
    assert.equal(unknownFormat.status, 201);
    assert.equal((unknownFormat.body.episode as Record<string, unknown>).sourceFormat, "novel", "未知素材类型归一为 novel");

    const tooLong = await request("POST", "/drama/projects/drama-source/episodes", { episodeNumber: 3, sourceText: "字".repeat(40001) });
    assert.equal(tooLong.status, 400, "单集原文上限 40000 字必须在服务端拒绝");
    assert.equal(await request("GET", "/drama/projects/drama-source/episodes?view=summary").then((r) => r.body.total), 2, "被拒请求不落库");

    const rename = await request("PATCH", `/drama/episodes/${episode.id}`, { title: "改名不抹原文" });
    assert.equal(rename.status, 200);
    assert.equal((rename.body.episode as Record<string, unknown>).sourceText, episode.sourceText);
    const edited = await request("PATCH", `/drama/episodes/${episode.id}`, { sourceFormat: "storyboard", sourceText: "新原文" });
    assert.equal((edited.body.episode as Record<string, unknown>).sourceFormat, "storyboard");
    assert.equal((edited.body.episode as Record<string, unknown>).sourceText, "新原文");
});

test("删集服务端确认协议：无视频直删；有视频/历史版本时 409，正确确认才真删", async (context) => {
    const { db, request, createDrama } = await episodeCapabilityHarness(context);
    await createDrama("drama-delete");

    const plain = await request("POST", "/drama/projects/drama-delete/episodes", { episodeNumber: 1, title: "普通集" });
    const plainDelete = await request("DELETE", `/drama/episodes/${(plain.body.episode as Record<string, unknown>).id}`);
    assert.equal(plainDelete.status, 200);
    assert.equal(plainDelete.body.deleted, 1, "没有视频/成片/历史版本的集不要求输入确认");

    const guarded = await request("POST", "/drama/projects/drama-delete/episodes", { episodeNumber: 2, title: "做过视频" });
    const episodeId = String((guarded.body.episode as Record<string, unknown>).id);
    const now = new Date().toISOString();
    db.db.prepare("INSERT INTO drama_pipeline_jobs (id, drama_id, episode_id, kind, stage, status, dedupe_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run("job-video-1", "drama-delete", episodeId, "video", "video", "succeeded", "delete-guard-1", now, now);
    const guard = db.dramaEpisodeDeleteGuard(db.getDramaEpisode(episodeId)!);
    assert.equal(guard.required, true);
    assert.equal(guard.confirmText, "第 2 集");
    assert.ok(guard.reasons.some((reason) => reason.includes("分镜视频")));

    const missing = await request("DELETE", `/drama/episodes/${episodeId}`);
    assert.equal(missing.status, 409);
    assert.equal(missing.body.code, "EPISODE_CONFIRM_REQUIRED");
    assert.equal(missing.body.reason, "episodeConfirmRequired");
    assert.equal(missing.body.confirmText, "第 2 集");
    const details = missing.body.details as Record<string, unknown>;
    assert.equal(details.confirmText, "第 2 集");
    assert.ok((details.reasons as string[]).some((reason) => reason.includes("分镜视频")));
    assert.ok(String(missing.body.error).includes("第 2 集"));
    assert.ok(db.getDramaEpisode(episodeId), "409 时一字节都不能删");

    const wrong = await request("DELETE", `/drama/episodes/${episodeId}`, { confirmText: "第 3 集" });
    assert.equal(wrong.status, 409);
    assert.ok(db.getDramaEpisode(episodeId), "确认文本不匹配仍然不删");

    const confirmed = await request("DELETE", `/drama/episodes/${episodeId}`, { confirmText: " 第2集 " });
    assert.equal(confirmed.status, 200, "确认文本去空白后匹配");
    assert.equal(confirmed.body.deleted, 1);
    assert.equal(db.getDramaEpisode(episodeId), null);

    // 只有历史版本也要确认：不依赖视频作业表即可触发服务端权威判定。
    const history = await request("POST", "/drama/projects/drama-delete/episodes", { episodeNumber: 3, title: "只有历史版本" });
    const historyId = String((history.body.episode as Record<string, unknown>).id);
    db.db.prepare("INSERT INTO episode_production_versions (episode_id, version, stage, snapshot_json, impact_json, created_at) VALUES (?,?,?,?,?,?)")
        .run(historyId, 1, "script", "{}", "{}", now);
    const historyDelete = await request("DELETE", `/drama/episodes/${historyId}`);
    assert.equal(historyDelete.status, 409);
    assert.equal(historyDelete.body.confirmText, "第 3 集");
    assert.ok(((historyDelete.body.details as Record<string, unknown>).reasons as string[]).some((reason) => reason.includes("历史版本")));
    const historyConfirmed = await request("DELETE", `/drama/episodes/${historyId}`, { confirmText: "第 3 集" });
    assert.equal(historyConfirmed.status, 200);
});

