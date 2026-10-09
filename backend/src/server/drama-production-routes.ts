import crypto from "node:crypto";
import type { Router } from "express";
import { ZodError } from "zod";

import { EpisodeProductionService, ProductionConflictError } from "../drama/production.js";
import type { EpisodeProductionRunner } from "../drama/production-runner.js";
import { getProductionContract } from "@basketikun/canvas-agent/skills/acheng";
import { productionWorkspaceSchemas, productionContractQuerySchema } from "@basketikun/canvas-agent/drama/production-contract";
import { ProductionValidationError } from "@basketikun/canvas-agent/drama/production-validation";
import { productionCompileSchema, productionApplyCompilationSchema, productionReadSchema, projectProductionRead, projectProductionVersion } from "@basketikun/canvas-agent/drama/production-contract";
import { ProductionCompilationService } from "../drama/compilation.js";
import { ClipRefreshCoordinator } from "../drama/clip-refresh.js";
import { clipRefreshReceipt } from "../drama/clip-refresh.js";
import { z } from "zod";
import { SceneWorkCoordinator } from "../drama/scene-work.js";
import type { BackendEventBus } from "../events.js";
import { directorHash } from "../drama/director.js";
import type { ProductionAgentPool } from "@basketikun/canvas-agent/agent/production";

const sceneCoordinators = new Map<string, SceneWorkCoordinator>();

function batchReceipt(batch: ReturnType<EpisodeProductionService["getBatch"]>) {
    if (!batch?.executionSnapshot) return batch;
    const snapshot = batch.executionSnapshot;
    return { ...batch, executionSnapshot: { schemaVersion: snapshot.schemaVersion, inputBasis: snapshot.inputBasis, canvasId: snapshot.canvasId,
        canvasRevision: snapshot.canvasRevision, planHash: snapshot.planHash, targets: snapshot.targets.map(({ id, nodeId, segmentId, inputHash, dependencies }) => ({ id, nodeId, segmentId, inputHash, dependencies })), blockedTargets: snapshot.blockedTargets, warnings: snapshot.warnings } };
}

export function registerDramaProductionRoutes(router: Router, service: EpisodeProductionService, runner?: EpisodeProductionRunner, base = "/drama/episodes/:episodeId/production", events?: BackendEventBus, agents?: Pick<ProductionAgentPool, "run">) {
    const compilations = new ProductionCompilationService(service, service.compilationRoot());
    compilations.recover(base);
    const refreshes = new ClipRefreshCoordinator(service, compilations, base);
    const scenes = new SceneWorkCoordinator(service, compilations, runner, base, agents);
    sceneCoordinators.set(`${service.compilationRoot()}:${base}`, scenes);
    const sceneOwner = (id: string) => {
        const canonical = service.get(id).episodeId;
        const coordinator = canonical !== id ? sceneCoordinators.get(`${service.compilationRoot()}:/drama/episodes/:episodeId/production`) : scenes;
        if (!coordinator) throw new Error("场次协调服务尚未就绪");
        return { id: canonical, coordinator };
    };
    compilations.onSettled = id => { queueMicrotask(() => { scenes.wake(id); refreshes.wake(id); }); };
    events?.subscribe(event => {
        if (event.type === "drama-production.updated" && service.sceneWorkOwners().includes(event.entityId || "")) queueMicrotask(() => scenes.wake(event.entityId!));
        if (event.type === "canvas.updated" && event.entityId) {
            const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, any> : {};
            const operations = Array.isArray(payload.operations) ? payload.operations as Array<Record<string, any>> : [];
            const sourceNodeIds = [...new Set(operations.flatMap(operation => {
                if (operation.type === "update_node") return [String(operation.id || "")];
                if (operation.type === "add_node") return [String(operation.id || "")];
                return [];
            }).filter(Boolean))];
            if (sourceNodeIds.length) queueMicrotask(() => refreshes.wakeSourceCanvas(event.entityId!, sourceNodeIds, Number(event.revision || 0), event.id));
        }
    });
    for (const id of service.sceneWorkOwners()) scenes.recover(id);
    refreshes.recover();
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
            if (input.scope && !input.operationId) throw new Error("按范围编译必须提供稳定 operationId");
            res.json({ ok: true, compilation: input.operationId ? compilations.enqueue(req.params.episodeId, base, input.operationId, input.expectedRevision, input.director, input.scope) : compilations.prepare(req.params.episodeId, base, input.expectedRevision, input.director) });
        } catch (error) { handle(res, error); }
    });
    for (const action of ["start", "resume", "pause", "review"] as const) router.post<Record<string, string>>(`${base}/scene-work/${action}`, async (req, res) => {
        try {
            const tool = `production_${action}_scene_work` as "production_start_scene_work" | "production_resume_scene_work" | "production_pause_scene_work" | "production_review_scene_work";
            const input = productionWorkspaceSchemas[tool].parse({ ...req.body, kind: base.startsWith("/canvas") ? "canvas" : "episode", id: req.params.episodeId });
            const current = service.get(req.params.episodeId);
            const { id, coordinator } = sceneOwner(req.params.episodeId);
            const prior = coordinator.commandReceipt(id, input.operationId, { action, input: { ...input, id, kind: current.episodeId !== req.params.episodeId ? "episode" : input.kind } });
            if (prior) return void res.json({ ok: true, production: prior, replayed: true });
            // Reviews independently recheck their frozen source/media digest in the coordinator.
            // resume/pause are pure state transitions: the coordinator re-reads the current
            // record inside its own transaction and re-validates every precondition, and the
            // operationId receipt already deduplicates replays. Background auto-publish bumps
            // the revision between client reads, so requiring an exact match there only turns
            // harmless races into retry storms. Source-editing actions keep the exact lock.
            if (input.expectedRevision > current.revision || (!["review", "resume", "pause"].includes(action) && current.revision !== input.expectedRevision)) throw new ProductionConflictError(current);
            const production = action === "start" ? coordinator.start(id, input as Parameters<SceneWorkCoordinator["start"]>[1])
                : action === "review" ? await coordinator.review(id, input as Parameters<SceneWorkCoordinator["review"]>[1])
                : action === "pause" ? coordinator.pause(id, (input as { workId: string }).workId, input.operationId)
                : coordinator.resume(id, (input as { workId: string }).workId, input.operationId);
            res.json(action === "start" ? { ok: true, ...production as ReturnType<SceneWorkCoordinator["start"]> } : { ok: true, production });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/scene-work/shared-review`, (req, res) => {
        try {
            const input = productionWorkspaceSchemas.production_start_shared_review.parse({ ...req.body, kind: base.startsWith("/canvas") ? "canvas" : "episode", id: req.params.episodeId });
            const { id, coordinator } = sceneOwner(req.params.episodeId);
            const prior = coordinator.commandReceipt(id, input.operationId, { action: "shared-review", input: { ...input, id, kind: id !== req.params.episodeId ? "episode" : input.kind } });
            if (prior) return void res.json({ ok: true, production: prior, replayed: true });
            res.json({ ok: true, production: coordinator.startSharedReview(id, input) });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/scene-work`, (req, res) => {
        try { const { id, coordinator } = sceneOwner(req.params.episodeId); res.json({ ok: true, state: coordinator.inspect(id) }); }
        catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/compilations/:operationId`, (req, res) => {
        try {
            const query = z.object({ view: z.enum(["status", "targets", "diagnostics"]).default("status"), offset: z.coerce.number().int().nonnegative().default(0), pageSize: z.coerce.number().int().positive().optional() }).strict().parse(queryWithoutToken(req.query));
            res.json({ ok: true, compilation: refreshes.inspect(req.params.episodeId, req.params.operationId, query.view, query.offset, query.pageSize) || compilations.getCompilation(req.params.episodeId, base, req.params.operationId, query.view, query.offset, query.pageSize) });
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
    // Web 端 request() 会在 query 上追加 ?token= 鉴权键；strict schema 不认它，先剥掉。
    const queryWithoutToken = (query: unknown) => { const { token: _token, ...rest } = (query || {}) as Record<string, unknown>; return rest; };
    router.get<Record<string, string>>(`${base}/continuity`, (req, res) => {
        try { res.json({ ok: true, continuity: service.getContinuity(req.params.episodeId, queryWithoutToken(req.query)) }); }
        catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/continuity/check`, (req, res) => {
        try { res.json({ ok: true, check: service.checkContinuity(req.params.episodeId, req.body) }); }
        catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/continuity/upgrade-preview`, (req, res) => {
        try { res.json({ ok: true, preview: service.previewContinuityUpgrade(req.params.episodeId, req.body) }); }
        catch (error) { handle(res, error); }
    });
    if (base === "/drama/episodes/:episodeId/production") router.post("/canvas/production/hash", (req, res) => {
        try {
            const { source } = productionWorkspaceSchemas.production_hash_source.parse(req.body);
            res.json({ ok: true, hash: directorHash(source) });
        } catch (error) { handle(res, error); }
    });
    if (base === "/drama/episodes/:episodeId/production") router.get("/production/contract", (req, res) => {
        try { const input = productionContractQuerySchema.parse(queryWithoutToken(req.query)); res.json({ ok: true, contract: getProductionContract(input.runtimeId, input.operationType, input.moduleId) }); }
        catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/preflight`, async (req, res) => {
        try {
            if (req.body?.action === "compile") {
                const input = productionCompileSchema.parse(req.body.request);
                res.json({ ok: true, preflight: await compilations.preflight(req.params.episodeId, input.expectedRevision, input.director, input.scope) });
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
    router.post<Record<string, string>>(`${base}/shared-assets/adopt-batch`, (req, res) => {
        try {
            const input = z.object({ assets: z.array(z.object({ assetId: z.string().min(1), approvedId: z.string().min(1) }).strict()).min(1), expectedRevision: z.number().int().nonnegative(), operationId: z.string().min(1) }).parse(req.body);
            res.json({ ok: true, production: service.adoptSharedAssets(req.params.episodeId, input), mediaSubmitted: false });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/shared-assets/updates/:adoptionId/retry`, (req, res) => {
        try { const input = z.object({ expectedRevision: z.number().int().nonnegative() }).parse(req.body); res.json({ ok: true, ...service.retrySharedUpdate(req.params.episodeId, req.params.adoptionId, input.expectedRevision) }); }
        catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}`, (req, res) => {
        try {
            let production: any = service.get(req.params.episodeId);
            // Existing Web consumers still receive the full record unless selecting a view.
            const query = productionReadSchema.parse({ ...req.query, view: req.query.view || "full", targetIds: typeof req.query.targetIds === "string" ? req.query.targetIds.split(",") : req.query.targetIds });
            if (query.view === "clip_workbench") {
                if (query.targetIds?.length !== 1) throw new Error("CLIP_WORKBENCH_TARGET: select exactly one Segment");
                production = service.clipWorkbench(req.params.episodeId, query.targetIds[0], query.snapshot);
            } else if (query.view === "subject_workbench") {
                if (query.targetIds?.length !== 1) throw new Error("SUBJECT_WORKBENCH_TARGET: select exactly one Subject");
                production = service.subjectWorkbench(req.params.episodeId, query.targetIds[0], query.snapshot);
            } else if (query.view === "shot_workbench") {
                if (query.targetIds?.length !== 1) throw new Error("SHOT_WORKBENCH_TARGET: select exactly one Shot");
                production = service.shotWorkbench(req.params.episodeId, query.targetIds[0], query.snapshot);
            }
            const owner = base.startsWith("/canvas") ? { projectId: req.params.episodeId } : base.startsWith("/drama/scenes") ? { sceneId: req.params.episodeId } : {};
            const selected = projectProductionRead(query.view === "full" ? production : { ...production, ...owner }, query, value => crypto.createHash("sha256").update(value).digest("hex"));
            const activeClipRefreshes = service.clipRefreshStore(req.params.episodeId).currentBySegment()
                .filter(job => job.status !== "succeeded").map(clipRefreshReceipt);
            if (activeClipRefreshes.length && selected && typeof selected === "object") (selected as any).clipRefreshes = activeClipRefreshes;
            if (!(selected as any).unchanged && query.targetIds?.length && !["summary", "clip_workbench", "shot_workbench", "subject_workbench"].includes(query.view) && !query.chunkBytes) { (selected as any).targetStatus = service.targetOccupancy(req.params.episodeId, query.targetIds); (selected as any).canvasInputs = service.canvasEditorialState(req.params.episodeId, query.targetIds); }
            res.json({ ok: true, production: selected });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/readiness`, (req, res) => {
        try {
            const source = z.enum(["draft", "published"]).default("draft").parse(req.query.source);
            const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
            res.json({ ok: true, readiness: service.workflowReadiness(req.params.episodeId, source, runId) });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/legacy`, (req, res) => {
        try { res.json({ ok: true, sources: service.legacy(req.params.episodeId) }); } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/versions`, (req, res) => {
        try { res.json({ ok: true, versions: service.versions(req.params.episodeId) }); } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/versions/:version`, (req, res) => {
        try {
            const version = service.version(req.params.episodeId, Number(req.params.version));
            const owner = { episodeId: req.params.episodeId, ...(base.startsWith("/canvas") ? { projectId: req.params.episodeId } : base.startsWith("/drama/scenes") ? { sceneId: req.params.episodeId } : {}) };
            const query = { ...req.query, targetIds: typeof req.query.targetIds === "string" ? req.query.targetIds.split(",") : req.query.targetIds };
            res.json({ ok: true, version: req.query.view ? projectProductionVersion(owner, version, query, value => crypto.createHash("sha256").update(value).digest("hex")) : version });
        } catch (error) { handle(res, error); }
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
            queueMicrotask(() => refreshes.wake(req.params.episodeId));
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
            res.json({ ok: true, run: batchReceipt(run) });
            if (run.status === "pending") void runner?.runBatch(req.params.episodeId, run.runId);
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/batches`, (req, res) => {
        try { res.json({ ok: true, runs: service.listBatches(req.params.episodeId).map(batchReceipt) }); } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/batches/:runId`, (req, res) => {
        try { res.json({ ok: true, run: req.query.view === "inputs" ? service.getBatch(req.params.episodeId, req.params.runId) : batchReceipt(service.getBatch(req.params.episodeId, req.params.runId)) }); } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/batches/:runId/retire`, (req, res) => {
        try {
            const input = z.object({ reason: z.string().trim().min(8) }).strict().parse(req.body);
            res.json({ ok: true, run: batchReceipt(service.retireBatch(req.params.episodeId, req.params.runId, input.reason)), mediaSubmitted: false });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/batches/:runId/pause`, (req, res) => {
        try { res.json({ ok: true, run: batchReceipt(service.pauseBatch(req.params.episodeId, req.params.runId)) }); } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/batches/:runId/resume`, (req, res) => {
        try {
            const run = service.resumeBatch(req.params.episodeId, req.params.runId);
            res.json({ ok: true, run: batchReceipt(run) });
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
