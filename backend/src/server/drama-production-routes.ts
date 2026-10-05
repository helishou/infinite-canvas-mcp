import crypto from "node:crypto";
import type { Router } from "express";
import { ZodError } from "zod";

import { EpisodeProductionService, ProductionConflictError } from "../drama/production.js";
import type { EpisodeProductionRunner } from "../drama/production-runner.js";
import { getProductionContract } from "@basketikun/canvas-agent/skills/acheng";
import { productionWorkspaceSchemas, productionContractQuerySchema } from "@basketikun/canvas-agent/drama/production-contract";
import { ProductionValidationError } from "@basketikun/canvas-agent/drama/production-validation";
import { productionCompileSchema, productionApplyCompilationSchema, productionReadSchema, projectProductionRead } from "@basketikun/canvas-agent/drama/production-contract";
import { ProductionCompilationService } from "../drama/compilation.js";
import { DATA_DIR } from "../config.js";
import path from "node:path";
import { z } from "zod";

export function registerDramaProductionRoutes(router: Router, service: EpisodeProductionService, runner?: EpisodeProductionRunner, base = "/drama/episodes/:episodeId/production") {
    const compilations = new ProductionCompilationService(service, path.join(DATA_DIR, "production-compilations"));
    compilations.recover(base);
    const handle = (res: { status: (code: number) => { json: (body: unknown) => void } }, error: unknown) => {
        if (error instanceof ProductionValidationError) return res.status(400).json({ ok: false, code: error.diagnostics[0]?.code || "PRODUCTION_BLOCKED", error: error.message, diagnostics: error.diagnostics, nextActions: error.diagnostics.flatMap(item => item.nextAction ? [item.nextAction] : []) });
        if (error instanceof ZodError) return res.status(400).json({ ok: false, error: error.message, diagnostics: error.issues.map(issue => ({ code: "INVALID_SCHEMA", path: issue.path.join("."), message: issue.message, severity: "error" })) });
        if (error instanceof ProductionConflictError) return res.status(409).json({ ok: false, code: "REVISION_CONFLICT", error: error.message, current: error.current, diagnostics: [{ code: "REVISION_CONFLICT", path: "request.expectedRevision", message: error.message, severity: "error" }], nextActions: [{ action: "refresh", message: "回读当前制作对象并核对 revision 后继续；不要重复原写入请求。" }] });
        return res.status(error instanceof ZodError ? 400 : /不存在|找不到/.test(String(error)) ? 404 : 400)
            .json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    };
    router.post<Record<string, string>>(`${base}/compile`, (req, res) => {
        try {
            const input = productionCompileSchema.extend({ operationId: z.string().min(1).optional() }).parse(req.body);
            res.json({ ok: true, compilation: input.operationId ? compilations.enqueue(req.params.episodeId, base, input.operationId, input.expectedRevision, input.director) : compilations.prepare(req.params.episodeId, base, input.expectedRevision, input.director) });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/compilations/:operationId`, (req, res) => {
        try {
            const query = z.object({ view: z.enum(["status", "targets", "diagnostics"]).default("status"), offset: z.coerce.number().int().nonnegative().default(0), pageSize: z.coerce.number().int().positive().optional() }).strict().parse(req.query);
            res.json({ ok: true, compilation: compilations.getCompilation(req.params.episodeId, base, req.params.operationId, query.view, query.offset, query.pageSize) });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/apply-compilation`, (req, res) => {
        try {
            const input = productionApplyCompilationSchema.parse(req.body);
            res.json({ ok: true, receipt: compilations.apply(req.params.episodeId, base, input.preparedId) });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/bindings`, (req, res) => {
        try { res.json({ ok: true, bindings: service.diagnoseBindings(req.params.episodeId) }); }
        catch (error) { handle(res, error); }
    });
    if (base === "/drama/episodes/:episodeId/production") router.get("/production/contract", (req, res) => {
        try { const input = productionContractQuerySchema.parse(req.query); res.json({ ok: true, contract: getProductionContract(input.runtimeId, input.operationType) }); }
        catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/preflight`, async (req, res) => {
        try {
            if (req.body?.action === "compile") {
                const input = productionCompileSchema.parse(req.body.request);
                res.json({ ok: true, preflight: await compilations.preflight(req.params.episodeId, input.expectedRevision, input.director) });
            } else res.json({ ok: true, preflight: service.preflight(req.params.episodeId, req.body) });
        }
        catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/prepare-targets`, (req, res) => {
        try {
            const input = productionWorkspaceSchemas.production_prepare_targets.omit({ kind: true, id: true }).parse(req.body);
            if (!runner) throw new Error("制作执行器不可用");
            const prepared: ReturnType<EpisodeProductionRunner["prepareTargets"]> = runner.prepareTargets(req.params.episodeId, input.expectedRevision, input.targets, input.operationId);
            const { layoutReceipt, ...production } = prepared;
            res.json({ ok: true, production, ...(layoutReceipt ? { layoutReceipt } : {}), mediaSubmitted: false });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/shared-assets`, (req, res) => {
        try { res.json({ ok: true, ...service.sharedAssets(req.params.episodeId) }); } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/shared-assets/promotions/preview`, (req, res) => {
        try {
            const input = z.object({ assetId: z.string().min(1), expectedRevision: z.number().int().nonnegative() }).parse(req.body);
            res.json({ ok: true, preview: service.previewSharedAssetPromotion(req.params.episodeId, input.assetId, input.expectedRevision), mediaSubmitted: false });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/shared-assets/promotions`, (req, res) => {
        try {
            const input = z.object({ assetId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), expectedSourceCanvasRevision: z.number().int().nonnegative(),
                expectedSharedCanvasRevision: z.number().int().nonnegative().nullable(), operationId: z.string().min(1) }).parse(req.body);
            res.json({ ok: true, promotion: service.promoteExistingSharedAsset(req.params.episodeId, input), mediaSubmitted: false });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/arrange-scene`, (req, res) => {
        try {
            const input = z.object({ expectedRevision: z.number().int().nonnegative(), operationId: z.string().min(1), sceneId: z.string().min(1) }).parse(req.body);
            if (!runner) throw new Error("制作执行器不可用");
            res.json({ ok: true, production: runner.arrangeScene(req.params.episodeId, input.sceneId, input.expectedRevision, input.operationId), mediaSubmitted: false });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/shared-assets/adopt`, (req, res) => {
        try {
            const input = z.object({ assetId: z.string().min(1), approvedId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), operationId: z.string().min(1) }).parse(req.body);
            res.json({ ok: true, production: service.adoptSharedAsset(req.params.episodeId, input), mediaSubmitted: false });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/shared-assets/updates/:adoptionId/retry`, (req, res) => {
        try { const input = z.object({ expectedRevision: z.number().int().nonnegative() }).parse(req.body); res.json({ ok: true, ...service.retrySharedUpdate(req.params.episodeId, req.params.adoptionId, input.expectedRevision) }); }
        catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}`, (req, res) => {
        try {
            const production = service.get(req.params.episodeId);
            // Existing Web consumers still receive the full record unless selecting a view.
            const query = productionReadSchema.parse({ ...req.query, view: req.query.view || "full", targetIds: typeof req.query.targetIds === "string" ? req.query.targetIds.split(",") : req.query.targetIds });
            res.json({ ok: true, production: projectProductionRead(production, query, value => crypto.createHash("sha256").update(value).digest("hex")) });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/readiness`, (req, res) => {
        try {
            const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
            res.json({ ok: true, readiness: service.workflowReadiness(req.params.episodeId, "draft", runId) });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/legacy`, (req, res) => {
        try { res.json({ ok: true, sources: service.legacy(req.params.episodeId) }); } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/versions`, (req, res) => {
        try { res.json({ ok: true, versions: service.versions(req.params.episodeId) }); } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/versions/:version`, (req, res) => {
        try { res.json({ ok: true, version: service.version(req.params.episodeId, Number(req.params.version)) }); } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/export`, (req, res) => {
        try {
            const stage = req.query.stage;
            if (stage !== "script" && stage !== "shots" && stage !== "director") throw new Error("stage 必须为 script 或 shots");
            const version = req.query.version === undefined ? undefined : Number(req.query.version);
            if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new Error("version 必须为已发布正整数");
            res.json({ ok: true, ...service.exportMarkdown(req.params.episodeId, stage, version) });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/impact`, (req, res) => {
        try {
            const stage = req.query.stage;
            if (stage !== "script" && stage !== "shots" && stage !== "director") throw new Error("stage 必须为 script 或 shots");
            res.json({ ok: true, impact: service.previewImpact(req.params.episodeId, stage) });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/ops`, (req, res) => {
        try {
            const production = service.edit(req.params.episodeId, req.body);
            res.json({ ok: true, production });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/publish`, (req, res) => {
        try {
            const production = service.publish(req.params.episodeId, req.body);
            res.json({ ok: true, production });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/restore`, (req, res) => {
        try {
            const { version, operationId, expectedRevision } = req.body || {};
            if (!Number.isInteger(version) || !Number.isInteger(expectedRevision) || typeof operationId !== "string" || !operationId) throw new Error("缺少有效版本、operationId 或 expectedRevision");
            res.json({ ok: true, production: service.restore(req.params.episodeId, version, operationId, expectedRevision) });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/runs/:version`, (req, res) => {
        try { res.json({ ok: true, run: service.run(req.params.episodeId, Number(req.params.version)) }); } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/runs`, (req, res) => {
        try {
            const run = service.startBatch(req.params.episodeId, req.body);
            res.json({ ok: true, run });
            if (run.status === "pending") void runner?.runBatch(req.params.episodeId, run.runId);
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/batches`, (req, res) => {
        try { res.json({ ok: true, runs: service.listBatches(req.params.episodeId) }); } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/batches/:runId`, (req, res) => {
        try { res.json({ ok: true, run: service.getBatch(req.params.episodeId, req.params.runId) }); } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/batches/:runId/pause`, (req, res) => {
        try { res.json({ ok: true, run: service.pauseBatch(req.params.episodeId, req.params.runId) }); } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/batches/:runId/resume`, (req, res) => {
        try {
            const run = service.resumeBatch(req.params.episodeId, req.params.runId);
            res.json({ ok: true, run });
            if (run.status === "pending") void runner?.runBatch(req.params.episodeId, run.runId);
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/sync-clips`, async (req, res) => {
        try {
            if (!runner) throw new Error("Clip 同步执行器不可用");
            const version = service.get(req.params.episodeId).publishedVersion;
            const production = await runner.syncClips(req.params.episodeId, version);
            res.json({ ok: true, production });
        } catch (error) { handle(res, error); }
    });
}
