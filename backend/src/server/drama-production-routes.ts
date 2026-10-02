import type { Router } from "express";
import { ZodError } from "zod";

import { EpisodeProductionService, ProductionConflictError } from "../drama/production.js";
import type { EpisodeProductionRunner } from "../drama/production-runner.js";

export function registerDramaProductionRoutes(router: Router, service: EpisodeProductionService, runner?: EpisodeProductionRunner) {
    const handle = (res: { status: (code: number) => { json: (body: unknown) => void } }, error: unknown) => {
        if (error instanceof ProductionConflictError) return res.status(409).json({ ok: false, error: error.message, current: error.current });
        return res.status(error instanceof ZodError ? 400 : /不存在|找不到/.test(String(error)) ? 404 : 400)
            .json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    };
    router.get("/drama/episodes/:episodeId/production", (req, res) => {
        try { res.json({ ok: true, production: service.get(req.params.episodeId) }); } catch (error) { handle(res, error); }
    });
    router.get("/drama/episodes/:episodeId/production/legacy", (req, res) => {
        try { res.json({ ok: true, sources: service.legacy(req.params.episodeId) }); } catch (error) { handle(res, error); }
    });
    router.get("/drama/episodes/:episodeId/production/versions", (req, res) => {
        try { res.json({ ok: true, versions: service.versions(req.params.episodeId) }); } catch (error) { handle(res, error); }
    });
    router.get("/drama/episodes/:episodeId/production/versions/:version", (req, res) => {
        try { res.json({ ok: true, version: service.version(req.params.episodeId, Number(req.params.version)) }); } catch (error) { handle(res, error); }
    });
    router.get("/drama/episodes/:episodeId/production/export", (req, res) => {
        try {
            const stage = req.query.stage;
            if (stage !== "script" && stage !== "shots") throw new Error("stage 必须为 script 或 shots");
            const version = req.query.version === undefined ? undefined : Number(req.query.version);
            if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new Error("version 必须为已发布正整数");
            res.json({ ok: true, ...service.exportMarkdown(req.params.episodeId, stage, version) });
        } catch (error) { handle(res, error); }
    });
    router.get("/drama/episodes/:episodeId/production/impact", (req, res) => {
        try {
            const stage = req.query.stage;
            if (stage !== "script" && stage !== "shots") throw new Error("stage 必须为 script 或 shots");
            res.json({ ok: true, impact: service.previewImpact(req.params.episodeId, stage) });
        } catch (error) { handle(res, error); }
    });
    router.post("/drama/episodes/:episodeId/production/ops", (req, res) => {
        try {
            const production = service.edit(req.params.episodeId, req.body);
            res.json({ ok: true, production });
            if (!production.replayed && Array.isArray(req.body?.ops) && req.body.ops.some((op: { type?: string }) => op.type === "review_keyframe")) void runner?.run(req.params.episodeId, production.publishedVersion);
        } catch (error) { handle(res, error); }
    });
    router.post("/drama/episodes/:episodeId/production/publish", (req, res) => {
        try {
            const production = service.publish(req.params.episodeId, req.body);
            res.json({ ok: true, production });
            if (!production.replayed) void runner?.run(req.params.episodeId, production.publishedVersion);
        } catch (error) { handle(res, error); }
    });
    router.post("/drama/episodes/:episodeId/production/restore", (req, res) => {
        try {
            const { version, operationId, expectedRevision } = req.body || {};
            if (!Number.isInteger(version) || !Number.isInteger(expectedRevision) || typeof operationId !== "string" || !operationId) throw new Error("缺少有效版本、operationId 或 expectedRevision");
            res.json({ ok: true, production: service.restore(req.params.episodeId, version, operationId, expectedRevision) });
        } catch (error) { handle(res, error); }
    });
    router.get("/drama/episodes/:episodeId/production/runs/:version", (req, res) => {
        try { res.json({ ok: true, run: service.run(req.params.episodeId, Number(req.params.version)) }); } catch (error) { handle(res, error); }
    });
    router.post("/drama/episodes/:episodeId/production/sync-clips", async (req, res) => {
        try {
            if (!runner) throw new Error("Clip 同步执行器不可用");
            const version = service.get(req.params.episodeId).publishedVersion;
            const production = await runner.syncClips(req.params.episodeId, version);
            res.json({ ok: true, production });
        } catch (error) { handle(res, error); }
    });
}
