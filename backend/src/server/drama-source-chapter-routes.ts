import type { Router } from "express";
import { z } from "zod";
import { SourceChapterWriteError, type BackendDatabase, type SourceChapter } from "../db.js";

/**
 * 章节级原文真读写链（对应影策 GET/PATCH /dramas/:id/chapters/:chapterId）。
 * 真值在 source_chapters.body；稳定章 ID 在分集时写进 drama_episodes.chapter_ids_json。
 * 与剧目级 planning PATCH 的区别：这里只改一章正文/标题/素材类型，不改章节数、稳定 ID、
 * 不改分集结果，plan_done 后依然允许写（影策 UpdateDramaChapter 无完成锁），
 * 已写好的剧本保持不变，由前端按 needsRescript 提示「保存后重新改编」。
 */

const chapterPatchSchema = z.object({
    body: z.string().min(1).max(400000).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    sourceFormat: z.enum(["novel", "script", "storyboard"]).optional(),
    expectedRevision: z.number().int().min(0).optional(),
    expectedUpdatedAt: z.string().trim().min(1).optional(),
}).strict();

function chapterView(chapter: SourceChapter, includeBody = true) {
    return {
        id: chapter.id,
        dramaId: chapter.dramaId,
        chapterIndex: chapter.chapterIndex,
        title: chapter.title,
        chars: chapter.chars,
        bodyHash: chapter.bodyHash,
        sourceFormat: chapter.sourceFormat,
        revision: chapter.revision,
        updatedAt: chapter.updatedAt,
        ...(includeBody ? { body: chapter.body } : {}),
    };
}

export function registerDramaSourceChapterRoutes(router: Router, db: BackendDatabase) {
    /** 章列表（默认含正文；?include=meta 只要元信息）。供按章编辑的目录/下拉。 */
    router.get<Record<string, string>>("/drama/:dramaId/planning/chapters", (req, res) => {
        const folder = db.listCanvasFolders(String(req.params.dramaId))[0];
        if (!folder) return void res.status(404).json({ ok: false, error: "剧目不存在" });
        const planning = db.getEpisodePlanningState(folder.id);
        const includeBody = !String(req.query.include || "").split(",").includes("meta");
        res.json({
            ok: true,
            dramaId: folder.id,
            planCursor: planning?.planCursor ?? 0,
            planDone: planning?.planDone ?? false,
            lastChapterIndex: planning?.lastChapterIndex ?? 0,
            chapters: db.listSourceChapters(folder.id).map((chapter) => chapterView(chapter, includeBody)),
        });
    });

    /** 单章原文（含正文）；?dramaId= 可选，用于校验章节归属，防串剧目。 */
    router.get("/drama/chapters/:chapterId", (req, res) => {
        const dramaId = typeof req.query.dramaId === "string" ? req.query.dramaId : undefined;
        const chapter = db.getSourceChapter(String(req.params.chapterId), dramaId);
        if (!chapter) return void res.status(404).json({ ok: false, error: "章节不存在" });
        const planning = db.getEpisodePlanningState(chapter.dramaId);
        res.json({ ok: true, chapter: chapterView(chapter), planDone: planning?.planDone ?? false });
    });

    /**
     * 按章保存原文：写 source_chapters.body 并重算 hash/chars。
     * 幂等（同值重放不改版本）；expectedRevision / expectedUpdatedAt 乐观锁（冲突 409）。
     * plan_done 不拦截：返回 needsRescript + planDone，让前端提示「保存后重新改编」。
     */
    router.patch("/drama/chapters/:chapterId", (req, res) => {
        const parsed = chapterPatchSchema.safeParse(req.body || {});
        if (!parsed.success) return void res.status(400).json({
            ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "),
        });
        const patch = parsed.data;
        try {
            const result = db.updateSourceChapter({
                chapterId: String(req.params.chapterId),
                ...(patch.body === undefined ? {} : { body: patch.body }),
                ...(patch.title === undefined ? {} : { title: patch.title }),
                ...(patch.sourceFormat === undefined ? {} : { sourceFormat: patch.sourceFormat }),
                ...(patch.expectedRevision === undefined ? {} : { expectedRevision: patch.expectedRevision }),
                ...(patch.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: patch.expectedUpdatedAt }),
            });
            const planning = db.getEpisodePlanningState(result.chapter.dramaId);
            res.json({
                ok: true,
                chapter: chapterView(result.chapter),
                changed: result.changed,
                needsRescript: result.changed,
                planDone: planning?.planDone ?? false,
                planCursor: planning?.planCursor ?? 0,
                affectedEpisodeIds: result.affectedEpisodeIds,
                message: result.changed
                    ? "原文已保存；已写好的剧本保持不变，点“重新改编”后按新原文重写"
                    : "原文未变化，无需保存",
            });
        } catch (error) {
            if (error instanceof SourceChapterWriteError) {
                const status = error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400;
                return void res.status(status).json({ ok: false, error: error.message, code: error.code });
            }
            res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    /** 集级视角：按 episodeId 取该集覆盖的章节（含正文），供前端按章编辑替代改全文。 */
    router.get("/drama/episodes/:episodeId/chapters", (req, res) => {
        const episode = db.getDramaEpisode(String(req.params.episodeId));
        if (!episode) return void res.status(404).json({ ok: false, error: "分集不存在" });
        const planning = db.getEpisodePlanningState(episode.dramaId);
        const includeBody = !String(req.query.include || "").split(",").includes("meta");
        res.json({
            ok: true,
            episodeId: episode.id,
            dramaId: episode.dramaId,
            episodeNumber: episode.episodeNumber,
            episodeTitle: episode.title,
            sourceFormat: episode.sourceFormat,
            planDone: planning?.planDone ?? false,
            chapterIds: episode.chapterIds,
            chapters: db.listEpisodeChapters(episode.id).map((chapter) => chapterView(chapter, includeBody)),
        });
    });
}
