import crypto from "node:crypto";
import express, { type Router } from "express";
import { ZodError } from "zod";

import { EpisodeProductionService, ProductionConflictError } from "../drama/production.js";
import { JianyingRevisionConflictError, JianyingZipWriter, writeJianyingExport, type SubtitleCalibration } from "../drama/jianying-export.js";
import { resolveProductionTarget } from "@basketikun/canvas-agent/drama/production-contract";
import type { EpisodeProductionRunner } from "../drama/production-runner.js";
import { getProductionContract } from "@basketikun/canvas-agent/skills/acheng";
import { productionWorkspaceSchemas, productionContractQuerySchema, validateProductionContractQuery } from "@basketikun/canvas-agent/drama/production-contract";
import { ProductionValidationError } from "@basketikun/canvas-agent/drama/production-validation";
import { productionCompileSchema, productionCompileSubmissionSchema, productionApplyCompilationSchema, productionReadSchema, projectProductionRead, projectProductionVersion, validateProductionSourceFields } from "@basketikun/canvas-agent/drama/production-contract";
import { compilationArtifactFreshness } from "@basketikun/canvas-agent/drama/compilation-scope";
import { withSegmentState, type SegmentStateRuntime } from "../drama/segment-state.js";
import { findReprocessableVideo, VideoReprocessFailure, type VideoReprocessDeps } from "../drama/video-reprocess.js";
import { ProductionCompilationService } from "../drama/compilation.js";
import { ClipRefreshCoordinator } from "../drama/clip-refresh.js";
import { clipRefreshReceipt } from "../drama/clip-refresh.js";
import { z } from "zod";
import { SceneWorkCoordinator } from "../drama/scene-work.js";
import type { BackendEventBus } from "../events.js";
import { directorHash, publicProductionRecord } from "../drama/director.js";
import type { ProductionAgentPool } from "@basketikun/canvas-agent/agent/production";
import { createLogger } from "../logger.js";

const sceneCoordinators = new Map<string, SceneWorkCoordinator>();
const logger = createLogger("drama-production-routes");

function batchReceipt(batch: ReturnType<EpisodeProductionService["getBatch"]>) {
    if (!batch?.executionSnapshot) return batch;
    const snapshot = batch.executionSnapshot;
    return { ...batch, executionSnapshot: { schemaVersion: snapshot.schemaVersion, inputBasis: snapshot.inputBasis, canvasId: snapshot.canvasId,
        canvasRevision: snapshot.canvasRevision, planHash: snapshot.planHash, targets: snapshot.targets.map(({ id, nodeId, segmentId, inputHash, dependencies }) => ({ id, nodeId, segmentId, inputHash, dependencies })), blockedTargets: snapshot.blockedTargets, warnings: snapshot.warnings } };
}

/**
 * 段状态的运行态真值：
 * - 等待原因/上游阶段：只读 drama_pipeline_jobs（前端 pipeline.jobs 同源）与 episode_production_runs。
 * - custom：画布 Clip 的 productionClipProjection.targetId → promptCustom（用户手动改写提示词的真值）。
 * - videoReprocessable：复用 findReprocessableVideo 对每段做只读判定（已生成视频但后处理失败）。
 * 任何读取失败（旧库无表、无画布、无剧集）都退化为不带该真值，绝不编造。
 * 后者按段逐条查询（N+1，段数即 Clip 数，量级小、只读；与重处理预览端点同一真值源，保持口径一致）。
 */
export function readSegmentStateRuntime(service: EpisodeProductionService, episodeId: string): SegmentStateRuntime | undefined {
    try {
        const backend = service.storageDatabase();
        const db = backend?.db;
        if (!backend || typeof db?.prepare !== "function" || !episodeId) return undefined;
        const jobs = (db.prepare("SELECT episode_id, stage, status, error FROM drama_pipeline_jobs WHERE episode_id=? ORDER BY priority DESC, created_at ASC")
            .all(episodeId) as Array<{ episode_id: string; stage: string; status: string; error: string | null }>)
            .map(row => ({ episodeId: row.episode_id, stage: row.stage, status: row.status, error: row.error }));
        const runs = (db.prepare("SELECT episode_id, status, error FROM episode_production_runs WHERE episode_id=? ORDER BY version DESC")
            .all(episodeId) as Array<{ episode_id: string; status: string; error: string | null }>)
            .map(row => ({ episodeId: row.episode_id, status: row.status, error: row.error }));
        const runtime: SegmentStateRuntime = { jobs, runs };

        try {
            const canvasId = String(service.episodeInfo(episodeId)?.canvasId || "");
            const project = canvasId ? backend.getCanvasProject(canvasId) : undefined;
            if (!project) return runtime;
            const segments = Array.isArray(project.nodes)
                ? project.nodes.flatMap((node: any) => Array.isArray(node?.metadata?.segments) ? node.metadata.segments : [])
                : [];
            const customSegments: Record<string, boolean> = {};
            const reprocessablePairs: Array<{ targetId: string; clipId: string }> = [];
            for (const segment of segments) {
                const targetId = String(segment?.productionClipProjection?.targetId || "");
                if (!targetId) continue;
                if (typeof segment?.promptCustom === "boolean") customSegments[targetId] = segment.promptCustom;
                const clipId = String(segment?.id || "");
                if (clipId) reprocessablePairs.push({ targetId, clipId });
            }
            if (Object.keys(customSegments).length) runtime.customSegments = customSegments;

            if (reprocessablePairs.length) {
                // findReprocessableVideo 只用到 deps.db（stores/events 仅在真正重跑时用到），预览判定是纯只读。
                const deps = { db: backend } as unknown as VideoReprocessDeps;
                const reprocessableSegments: Record<string, boolean> = {};
                for (const { targetId, clipId } of reprocessablePairs) {
                    try {
                        const candidate = findReprocessableVideo(deps, episodeId, clipId);
                        reprocessableSegments[targetId] = !candidate.alreadyReady;
                    } catch (error) {
                        if (!(error instanceof VideoReprocessFailure)) continue; // 未知异常静默跳过，不编造。
                        // 结构性错误（无剧集/无画布/Clip 不存在）视为无真值；业务拒绝（无视频/运行中/已就绪/非后处理失败）=不可重处理。
                        if (["EPISODE_NOT_FOUND", "EPISODE_CANVAS_MISSING", "CANVAS_MISSING", "SEGMENT_NOT_FOUND"].includes(error.code)) continue;
                        reprocessableSegments[targetId] = false;
                    }
                }
                if (Object.keys(reprocessableSegments).length) runtime.reprocessableSegments = reprocessableSegments;
            }
        } catch {
            // 画布读取失败 → custom / videoReprocessable 留 undefined，不影响 jobs/runs。
        }
        return runtime;
    } catch {
        return undefined;
    }
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
        if (event.type !== "drama-production.updated" || !event.entityId) return;
        queueMicrotask(() => {
            refreshes.wake(event.entityId!);
            if (service.sceneWorkOwners().includes(event.entityId!)) scenes.wake(event.entityId!);
        });
    });
    for (const id of service.sceneWorkOwners()) {
        try { scenes.recover(id); }
        catch (error) {
            if (error instanceof ProductionValidationError && error.diagnostics.some(item => item.code === "UNSUPPORTED_PRODUCTION_FORMAT")) {
                logger.warn("Skipped recovery for an unsupported legacy production format; use the explicit maintenance command", { ownerId: id });
                continue;
            }
            if (!(error instanceof ZodError) || !error.issues.some(issue => issue.message.startsWith("UNSUPPORTED_PRODUCTION_FORMAT:"))) throw error;
            logger.warn("Skipped recovery for a production record with an unsupported source format; the stored record was left untouched", { ownerId: id });
        }
    }
    refreshes.recover();
    service.recoverCompiledPromptTranslations();
    const handle = (res: { status: (code: number) => { json: (body: unknown) => void } }, error: unknown) => {
        if (error instanceof ProductionValidationError) return res.status(400).json({ ok: false, code: error.diagnostics[0]?.code || "PRODUCTION_BLOCKED", error: error.message, diagnostics: error.diagnostics, nextActions: error.diagnostics.flatMap(item => item.nextAction ? [item.nextAction] : []) });
        if (error instanceof ZodError) {
            const diagnostics = error.issues.map(issue => ({ code: issue.message.startsWith("UNSUPPORTED_PRODUCTION_FORMAT:") ? "UNSUPPORTED_PRODUCTION_FORMAT" : "INVALID_SCHEMA", path: issue.path.join("."), message: issue.message, severity: "error" }));
            const unsupported = diagnostics.find(item => item.code === "UNSUPPORTED_PRODUCTION_FORMAT");
            if (unsupported) return res.status(422).json({ ok: false, code: "UNSUPPORTED_PRODUCTION_FORMAT", error: unsupported.message, diagnostics });
            return res.status(400).json({ ok: false, error: error.message, diagnostics });
        }
        if (error instanceof ProductionConflictError) return res.status(409).json({ ok: false, code: "REVISION_CONFLICT", error: error.message, current: error.current, diagnostics: [{ code: "REVISION_CONFLICT", path: "request.expectedRevision", message: error.message, severity: "error" }], nextActions: [{ action: "refresh", message: "回读当前制作对象并核对 revision 后继续；不要重复原写入请求。" }] });
        // 领域错误可以携带 code/details/nextActions（启用开关、可用场次目录等）。
        // 只带上错误自身声明的字段，普通 Error 的返回体保持原形状。
        const structured = error as { code?: unknown; details?: unknown; nextActions?: unknown };
        const code = typeof structured?.code === "string" ? structured.code : undefined;
        const details = structured?.details && typeof structured.details === "object" && !Array.isArray(structured.details) ? structured.details : undefined;
        const nextActions = Array.isArray(structured?.nextActions) ? structured.nextActions : undefined;
        return res.status(error instanceof ZodError ? 400 : /不存在|找不到/.test(String(error)) ? 404 : 400)
            .json({ ok: false, error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}), ...(details ? { details } : {}), ...(nextActions ? { nextActions } : {}) });
    };
    router.post<Record<string, string>>(`${base}/compile`, (req, res) => {
        try {
            const input = productionCompileSubmissionSchema.parse(req.body);
            res.json({ ok: true, compilation: compilations.enqueue(req.params.episodeId, base, input.operationId, input.expectedRevision, undefined, input.scope, input.apply === true) });
        } catch (error) { handle(res, error); }
    });
    for (const action of ["start", "resume", "pause", "review"] as const) router.post<Record<string, string>>(`${base}/scene-work/${action}`, async (req, res) => {
        try {
            const tool = `production_${action}_scene_work` as "production_start_scene_work" | "production_resume_scene_work" | "production_pause_scene_work" | "production_review_scene_work";
            const input = productionWorkspaceSchemas[tool].parse({ ...req.body, kind: base.startsWith("/canvas") ? "canvas" : "episode", id: req.params.episodeId });
            const current = service.get(req.params.episodeId);
            const { id, coordinator } = sceneOwner(req.params.episodeId);
            const prior = coordinator.commandReceipt(id, input.operationId, { action, input: { ...input, id, kind: current.episodeId !== req.params.episodeId ? "episode" : input.kind } });
            if (prior) return void res.json({ ok: true, production: publicProductionRecord(prior), replayed: true });
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
            res.json(action === "start" ? { ok: true, ...publicProductionRecord(production as any) } : { ok: true, production: publicProductionRecord(production as any) });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/scene-work/shared-review`, (req, res) => {
        try {
            const input = productionWorkspaceSchemas.production_start_shared_review.parse({ ...req.body, kind: base.startsWith("/canvas") ? "canvas" : "episode", id: req.params.episodeId });
            const { id, coordinator } = sceneOwner(req.params.episodeId);
            const prior = coordinator.commandReceipt(id, input.operationId, { action: "shared-review", input: { ...input, id, kind: id !== req.params.episodeId ? "episode" : input.kind } });
            if (prior) return void res.json({ ok: true, production: publicProductionRecord(prior), replayed: true });
            res.json({ ok: true, production: publicProductionRecord(coordinator.startSharedReview(id, input) as any) });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/scene-work`, (req, res) => {
        try {
            const view = z.enum(["summary", "full"]).default("summary").parse(queryWithoutToken(req.query).view);
            const { id, coordinator } = sceneOwner(req.params.episodeId);
            res.json({ ok: true, state: coordinator.inspect(id, view) });
        }
        catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/compilations/:operationId`, (req, res) => {
        try {
            const query = z.object({ view: z.enum(["status", "targets", "diagnostics"]).default("status"), offset: z.coerce.number().int().nonnegative().default(0), pageSize: z.coerce.number().int().positive().optional() }).strict().parse(queryWithoutToken(req.query));
            res.json({ ok: true, compilation: refreshes.inspect(req.params.episodeId, req.params.operationId, query.view, query.offset, query.pageSize) || compilations.getCompilation(req.params.episodeId, base, req.params.operationId, query.view, query.offset, query.pageSize) });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/translate-compiled-prompts`, async (req, res) => {
        try {
            const input = z.object({ expectedRevision: z.number().int().nonnegative(), operationId: z.string().min(1), targetIds: z.array(z.string().min(1)).min(1) }).strict().parse(req.body);
            res.json({ ok: true, receipt: await service.translateCompiledPrompts(req.params.episodeId, input) });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/apply-compilation`, async (req, res) => {
        try {
            const input = productionApplyCompilationSchema.parse(req.body);
            res.json({ ok: true, receipt: await compilations.apply(req.params.episodeId, base, input.preparedId) });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/bindings`, (req, res) => {
        try {
            const bindings = service.diagnoseBindings(req.params.episodeId);
            if (req.query.pageSize === undefined) return void res.json({ ok: true, bindings });
            const pageSize = z.coerce.number().int().positive().max(50).default(20).parse(req.query.pageSize);
            const assets = Array.isArray(bindings.assets) ? bindings.assets : [];
            const selection = JSON.stringify({ owner: req.params.episodeId, revision: bindings.revision, sourceHash: bindings.sourceHash, pageSize });
            let offset = 0;
            if (typeof req.query.cursor === "string") {
                let cursor: Record<string, unknown>;
                try { cursor = JSON.parse(decodeURIComponent(req.query.cursor)); } catch { throw Object.assign(new Error("INVALID_CURSOR"), { code: "INVALID_CURSOR" }); }
                if (cursor.selection !== selection) throw Object.assign(new Error("READ_CURSOR_EXPIRED: 绑定诊断状态已变化，请重新读取"), { code: "READ_CURSOR_EXPIRED" });
                offset = z.number().int().nonnegative().parse(cursor.offset);
            }
            const page = assets.slice(offset, offset + pageSize), nextOffset = offset + page.length;
            const nextCursor = nextOffset < assets.length ? encodeURIComponent(JSON.stringify({ selection, offset: nextOffset })) : null;
            res.json({ ok: true, bindings: { ...bindings, assets: page, totalAssets: assets.length, assetOffset: offset, pageSize, nextCursor } });
        }
        catch (error) { handle(res, error); }
    });
    // Web 端 request() 会在 query 上追加 ?token= 鉴权键；strict schema 不认它，先剥掉。
    const queryWithoutToken = (query: unknown) => { const { token: _token, ...rest } = (query || {}) as Record<string, unknown>; return rest; };
    router.get<Record<string, string>>(`${base}/continuity`, (req, res) => {
        try { res.json({ ok: true, continuity: service.getContinuity(req.params.episodeId, queryWithoutToken(req.query)) }); }
        catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/continuity/check`, async (req, res) => {
        try { res.json({ ok: true, check: await service.checkContinuity(req.params.episodeId, req.body) }); }
        catch (error) { handle(res, error); }
    });
    if (base === "/drama/episodes/:episodeId/production") router.post("/canvas/production/hash", (req, res) => {
        try {
            const { source } = productionWorkspaceSchemas.production_hash_source.parse(req.body);
            res.json({ ok: true, hash: directorHash(source) });
        } catch (error) { handle(res, error); }
    });
    if (base === "/drama/episodes/:episodeId/production") router.get("/production/contract", (req, res) => {
        try {
            const input = productionContractQuerySchema.parse({ ...queryWithoutToken(req.query),
                includeRequests: req.query.includeRequests === "true", includePatchFields: req.query.includePatchFields === "true", includeSourceContract: req.query.includeSourceContract === "true" });
            validateProductionContractQuery(input);
            res.json({ ok: true, contract: getProductionContract(input.runtimeId, input.operationType, input.moduleId, { requests: input.includeRequests, patchFields: input.includePatchFields, sourceContract: input.includeSourceContract, moduleFile: input.moduleFile, chunkBytes: input.chunkBytes, cursor: input.cursor }) });
        }
        catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/preflight`, async (req, res) => {
        try {
            if (req.body?.action === "compile") {
                const input = productionCompileSchema.parse(req.body.request);
                res.json({ ok: true, preflight: await compilations.preflight(req.params.episodeId, input.expectedRevision, input.director, input.scope) });
            } else res.json({ ok: true, preflight: await service.preflight(req.params.episodeId, req.body) });
        }
        catch (error) { handle(res, error); }
    });
    if (base === "/drama/episodes/:episodeId/production" || base === "/canvas/projects/:episodeId/production") router.post<Record<string, string>>(`${base}/sync-scenes`, (req, res) => {
        try {
            const input = z.object({ expectedRevision: z.number().int().nonnegative(), operationId: z.string().trim().min(1) }).strict().parse(req.body);
            const result = service.syncSceneDirectory(req.params.episodeId, input.expectedRevision, input.operationId);
            res.json({ ok: true, ...result, mediaSubmitted: false });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/prepare-targets`, async (req, res) => {
        try {
            const input = productionWorkspaceSchemas.production_prepare_targets.omit({ kind: true, id: true }).parse(req.body);
            if (!runner) throw new Error("制作执行器不可用");
            const prepared: Awaited<ReturnType<EpisodeProductionRunner["prepareTargets"]>> = await runner.prepareTargets(req.params.episodeId, input.expectedRevision, input.targets, input.operationId);
            const { layoutReceipt, ...production } = prepared;
            res.json({ ok: true, production: publicProductionRecord(production), ...(layoutReceipt ? { layoutReceipt } : {}), mediaSubmitted: false });
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
    router.post<Record<string, string>>(`${base}/arrange-scene`, async (req, res) => {
        try {
            const input = z.object({ expectedRevision: z.number().int().nonnegative(), operationId: z.string().min(1), sceneId: z.string().min(1) }).parse(req.body);
            if (!runner) throw new Error("制作执行器不可用");
            res.json({ ok: true, production: publicProductionRecord(await runner.arrangeScene(req.params.episodeId, input.sceneId, input.expectedRevision, input.operationId)), mediaSubmitted: false });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}`, (req, res) => {
        try {
            const query = productionReadSchema.parse({ ...req.query, view: req.query.view || "full", targetIds: typeof req.query.targetIds === "string" ? req.query.targetIds.split(",") : req.query.targetIds,
                sourceSections: typeof req.query.sourceSections === "string" && req.query.sourceSections ? req.query.sourceSections.split(",") : req.query.sourceSections });
            validateProductionSourceFields(query);
            if (query.clipNumber !== undefined || query.shotNumber !== undefined || query.shotInClip !== undefined) {
                if (query.targetIds?.length) throw new Error("TARGET_SELECTOR_CONFLICT: 稳定 ID 与展示编号只能选一种定位方式");
                const current = service.getForRead(req.params.episodeId);
                query.targetIds = [resolveProductionTarget(current[query.snapshot]?.director?.source || {}, query.view, query)];
            }
            let production: any;
            // Canonical reads use the saved source directly; legacy runtime projections are opt-in for execution paths.
            if (query.view === "clip_workbench") {
                if (query.targetIds?.length !== 1) throw new Error("CLIP_WORKBENCH_TARGET: select exactly one Segment");
                production = service.clipWorkbench(req.params.episodeId, query.targetIds[0], query.snapshot);
            } else if (query.view === "subject_workbench") {
                if (query.targetIds?.length !== 1) throw new Error("SUBJECT_WORKBENCH_TARGET: select exactly one Subject");
                production = service.subjectWorkbench(req.params.episodeId, query.targetIds[0], query.snapshot);
            } else if (query.view === "shot_workbench") {
                if (query.targetIds?.length !== 1) throw new Error("SHOT_WORKBENCH_TARGET: select exactly one Shot");
                production = service.shotWorkbench(req.params.episodeId, query.targetIds[0], query.snapshot);
            } else production = service.getForRead(req.params.episodeId);
            const owner = base.startsWith("/canvas") ? { projectId: req.params.episodeId } : base.startsWith("/drama/scenes") ? { sceneId: req.params.episodeId } : {};
            const director = production[query.snapshot]?.director;
            const staleReason = (artifact: any) => {
                if (!director) return "receipt_missing";
                const freshness = compilationArtifactFreshness(director, artifact);
                return freshness.current ? "marked_stale" : freshness.staleReason;
            };
            const selected = projectProductionRead(query.view === "full" ? production : { ...production, ...owner }, query,
                value => crypto.createHash("sha256").update(value).digest("hex"), undefined, staleReason);
            if (!query.fields) {
                const activeClipRefreshes = service.clipRefreshStore(req.params.episodeId).currentBySegment()
                    .filter(job => job.status !== "succeeded").map(clipRefreshReceipt);
                if (activeClipRefreshes.length && selected && typeof selected === "object") (selected as any).clipRefreshes = activeClipRefreshes;
                if (!(selected as any).unchanged && query.targetIds?.length && !query.sourceSections?.length && !["summary", "clip_workbench", "shot_workbench", "subject_workbench"].includes(query.view) && !query.chunkBytes) { (selected as any).targetStatus = service.targetOccupancy(req.params.episodeId, query.targetIds); (selected as any).canvasInputs = service.canvasEditorialState(req.params.episodeId, query.targetIds); }
            }
            // 段状态只在返回副本上派生：draft_json 被多处 UPDATE 重写，写入 state 会被 wiping。
            const runtime = base.startsWith("/drama/episodes") ? readSegmentStateRuntime(service, req.params.episodeId) : undefined;
            res.json({ ok: true, production: withSegmentState(selected, runtime, req.params.episodeId) });
        } catch (error) { handle(res, error); }
    });
    // 真预检：对齐影策 POST /dramas/:id/episodes/:episodeId/jianying-draft/preview。
    // 只读制作稿 + 画布 Clip + media_files + 首字节；不生成 ZIP、不写用户本机路径。
    router.post<Record<string, string>>(`${base}/jianying/preflight`, (req, res) => {
        try {
            const input = z.object({ draftRoot: z.string().max(4096).optional(), captions: z.boolean().optional() })
                .strict().parse(req.body ?? {});
            res.json({ ok: true, preview: service.previewJianyingDraft(req.params.episodeId, input) });
        } catch (error) { handle(res, error); }
    });
    // 真导出：对齐影策 POST /dramas/:id/episodes/:episodeId/jianying-draft。
    // 本机草稿目录走 POST body（表单或 JSON），不走 GET query 以避免访问日志记录本机路径。
    // 现场重跑预检 + revision 复核（不一致 409）+ allowIncomplete/allowStale 放行后流式写 ZIP。
    const jianyingBool = z.preprocess(value => typeof value === "string" ? value === "true" || value === "1" : value, z.boolean().optional());
    router.post<Record<string, string>>(
        `${base}/jianying/export`,
        express.urlencoded({ extended: false }),
        async (req, res) => {
            try {
                const input = z.object({
                    draftRoot: z.string().max(4096).optional(),
                    captions: jianyingBool,
                    revision: z.string().max(128).optional(),
                    allowIncomplete: jianyingBool,
                    allowStale: jianyingBool,
                    width: z.coerce.number().int().min(16).max(7680).optional(),
                    height: z.coerce.number().int().min(16).max(7680).optional(),
                    calibration: z.any().optional(),
                }).strict().parse(req.body ?? {});
                // 准备阶段（含 409 / 放行判定）先完成，失败时还能返回 JSON；之后再设置 ZIP 响应头。
                const plan = service.prepareJianyingExport(req.params.episodeId, {
                    ...input,
                    calibration: (input.calibration as SubtitleCalibration | undefined) ?? null,
                });
                res.status(200);
                res.setHeader("Content-Type", "application/zip");
                res.setHeader("Content-Disposition", `attachment; filename="jianying-draft.zip"; filename*=UTF-8''${encodeURIComponent(plan.fileName)}`);
                res.setHeader("Cache-Control", "no-store");
                const writer = new JianyingZipWriter(chunk => res.write(chunk));
                res.on("drain", () => writer.resume());
                await writeJianyingExport(plan, writer);
                res.end();
            } catch (error) {
                if (error instanceof JianyingRevisionConflictError && !res.headersSent) {
                    return void res.status(409).json({ ok: false, code: error.code, error: error.message,
                        expected: error.expected, current: error.current });
                }
                if (!res.headersSent) return handle(res, error);
                res.destroy();
            }
        },
    );
    router.get<Record<string, string>>(`${base}/readiness`, (req, res) => {
        try {
            const source = z.enum(["draft", "published"]).default("draft").parse(req.query.source);
            const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
            const view = z.enum(["full", "summary", "targets"]).default("full").parse(req.query.view);
            const pageSize = z.coerce.number().int().positive().max(50).default(20).parse(req.query.pageSize);
            const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
            // 条件请求短路：输入戳（制作稿修订 + SQLite data_version）未变 ⇒ 结果必然一致，
            // 直接 304，跳过 1.2s 的全量 readiness 计算（前端轮询/浏览器 revalidate 实测 2000+ 次）。
            const stamp = service.readinessInputStamp(req.params.episodeId, source, runId);
            if (stamp) {
                const etag = `"rd-${stamp}"`;
                const incoming = String(req.headers["if-none-match"] || "");
                if (incoming.split(",").some(candidate => candidate.trim().replace(/^W\//, "") === etag)) { res.status(304).end(); return; }
                res.setHeader("ETag", etag);
            }
            const readiness = service.workflowReadiness(req.params.episodeId, source, runId);
            if (view === "full") return void res.json({ ok: true, readiness });
            const targets = Array.isArray(readiness.targets) ? readiness.targets : [];
            const selection = JSON.stringify({ owner: req.params.episodeId, revision: readiness.revision, source, view, pageSize });
            let offset = 0;
            if (cursor) {
                let decoded: Record<string, unknown>;
                try { decoded = JSON.parse(decodeURIComponent(cursor)); } catch { throw Object.assign(new Error("INVALID_CURSOR"), { code: "INVALID_CURSOR" }); }
                if (decoded.selection !== selection) throw Object.assign(new Error("READ_CURSOR_EXPIRED: 制作就绪状态已变化，请重新读取摘要"), { code: "READ_CURSOR_EXPIRED" });
                offset = z.number().int().nonnegative().parse(decoded.offset);
            }
            const counts = Object.fromEntries(["ready", "blocked", "needs_review", "complete"].map(status => [status, targets.filter(target => target.status === status).length]));
            if (view === "summary") {
                const modules = Object.fromEntries(Object.entries(readiness.modules || {}).map(([name, value]) => {
                    const module = value && typeof value === "object" ? value as Record<string, unknown> : {};
                    return [name, { ...(typeof module.status === "string" ? { status: module.status } : {}), unresolvedCount: Array.isArray(module.unresolved) ? module.unresolved.length : 0 }];
                }));
                const { targets: _targets, modules: _modules, unresolved, sceneWorks, ...rest } = readiness;
                return void res.json({ ok: true, readiness: {
                    ...rest, view, targetCount: targets.length, targetCounts: counts,
                    modules, unresolvedCount: Array.isArray(unresolved) ? unresolved.length : 0,
                    unresolvedPreview: Array.isArray(unresolved) ? unresolved.slice(0, 10) : [],
                    sceneWorkCount: sceneWorks && typeof sceneWorks === "object" ? Object.keys(sceneWorks).length : 0,
                    nextRead: { tool: "production_get_readiness", input: { kind: base.startsWith("/canvas") ? "canvas" : "episode", id: req.params.episodeId, source, view: "targets", pageSize } },
                } });
            }
            const page = targets.slice(offset, offset + pageSize), nextOffset = offset + page.length;
            const nextCursor = nextOffset < targets.length ? encodeURIComponent(JSON.stringify({ selection, offset: nextOffset })) : null;
            const { targets: _targets, ...rest } = readiness;
            res.json({ ok: true, readiness: { ...rest, view, targetCount: targets.length, targetCounts: counts, targets: page, targetOffset: offset, pageSize, nextCursor } });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/scene-archives`, (req, res) => {
        try { res.json({ ok: true, archives: service.listArchivedScenes(req.params.episodeId) }); } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/versions`, (req, res) => {
        try { res.json({ ok: true, versions: service.versions(req.params.episodeId) }); } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/versions/:version`, (req, res) => {
        try {
            const version = service.version(req.params.episodeId, Number(req.params.version));
            const owner = { episodeId: req.params.episodeId, ...(base.startsWith("/canvas") ? { projectId: req.params.episodeId } : base.startsWith("/drama/scenes") ? { sceneId: req.params.episodeId } : {}) };
            const query = { ...req.query, targetIds: typeof req.query.targetIds === "string" ? req.query.targetIds.split(",") : req.query.targetIds };
            if (req.query.fields !== undefined) validateProductionSourceFields(productionReadSchema.parse(query));
            res.json({ ok: true, version: req.query.view ? projectProductionVersion(owner, version, query, value => crypto.createHash("sha256").update(value).digest("hex")) : version });
        } catch (error) { handle(res, error); }
    });
    // 版本对比：列表含 snapshot 真派生摘要；对比结果全部由两份 snapshot_json 结构化 diff 得出。
    router.get<Record<string, string>>(`${base}/version-compare/versions`, (req, res) => {
        try { res.json({ ok: true, versions: service.versionCompareList(req.params.episodeId) }); } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/version-compare/:v1/:v2`, (req, res) => {
        try { res.json({ ok: true, comparison: service.versionCompare(req.params.episodeId, Number(req.params.v1), Number(req.params.v2)) }); } catch (error) { handle(res, error); }
    });
    // 逐clip成片真值链：当前画布实时段结果（可与版本记录做诚实对比）；版本记录来自 clip_video_versions。
    router.get<Record<string, string>>(`${base}/clip-videos/current`, (req, res) => {
        try { res.json({ ok: true, clipVideos: service.currentClipVideos(req.params.episodeId) }); } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/clip-videos/:version`, (req, res) => {
        try { res.json({ ok: true, clipVideos: service.clipVideosAtVersion(req.params.episodeId, Number(req.params.version)) }); } catch (error) { handle(res, error); }
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
    router.get<Record<string, string>>(`${base}/impact`, async (req, res) => {
        try {
            const stage = req.query.stage;
            if (stage !== "script" && stage !== "shots" && stage !== "director") throw new Error("stage 必须为 script 或 shots");
            res.json({ ok: true, impact: await service.previewImpact(req.params.episodeId, stage) });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/ops`, async (req, res) => {
        const startedAt = performance.now();
        let serviceMs: number | undefined;
        const stages: Record<string, number> = {};
        res.once("finish", () => logger.info("Production edit timing", {
            route: "ops", status: res.statusCode,
            totalMs: Math.round(performance.now() - startedAt),
            ...(serviceMs === undefined ? {} : { serviceMs }),
            responseBytes: Number(res.getHeader("content-length") || 0),
            stages,
        }));
        try {
            const serviceStartedAt = performance.now();
            let production = await service.edit(req.params.episodeId, req.body, undefined, false, undefined, (name, durationMs) => { stages[name] = (stages[name] || 0) + durationMs; });
            // A Clip repartition changes the formal canvas layout as well as the
            // source. Materialize the affected Segment nodes before returning so a
            // newly added Segment never remains without its H3 Clip node.
            const repartitions = Array.isArray(req.body?.ops)
                ? req.body.ops.filter((operation: Record<string, unknown>) => operation?.type === "repartition_director_clips")
                : [];
            if (runner && repartitions.length && !service.isSharedAssetCanvas(req.params.episodeId)) {
                const affectedShots = new Set(repartitions.flatMap((operation: Record<string, any>) => Array.isArray(operation.shotIds) ? operation.shotIds.map(String) : []));
                const targetIds = [...new Set(production.draft.clipGroups
                    .filter(group => group.shotIds.some(shotId => affectedShots.has(shotId)) && (!group.nodeId || !group.segmentId))
                    .map(group => group.id))];
                if (targetIds.length) {
                    // Reuse the edit identity so a replay after an unknown response
                    // resumes the same idempotent layout preparation.
                    const operationId = `clip-layout-${crypto.createHash("sha256")
                        .update(`${req.params.episodeId}\0${String(req.body?.operationId || "")}\0${targetIds.slice().sort().join("\0")}`)
                        .digest("hex").slice(0, 24)}`;
                    const current = service.get(req.params.episodeId);
                    production = await runner.prepareTargets(req.params.episodeId, current.revision,
                        targetIds.map(targetId => `segment:${targetId}`), operationId);
                }
            }
            serviceMs = Math.round(performance.now() - serviceStartedAt);
            res.json({ ok: true, production: publicProductionRecord(production) });
            if (!events) queueMicrotask(() => refreshes.wake(req.params.episodeId));
        } catch (error) {
            serviceMs = Math.round(performance.now() - startedAt);
            handle(res, error);
        }
    });
    router.get<Record<string, string>>(`${base}/operations/:operationId/receipt`, (req, res) => {
        try {
            const production = service.operationReceipt(req.params.episodeId, req.params.operationId);
            res.json(production ? { ok: true, found: true, production: publicProductionRecord(production) } : { ok: true, found: false });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/publish`, async (req, res) => {
        try {
            const production = await service.publish(req.params.episodeId, req.body);
            res.json({ ok: true, production: publicProductionRecord(production) });
        } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/restore`, async (req, res) => {
        try {
            const { version, operationId, expectedRevision } = req.body || {};
            if (!Number.isInteger(version) || !Number.isInteger(expectedRevision) || typeof operationId !== "string" || !operationId) throw new Error("缺少有效版本、operationId 或 expectedRevision");
            res.json({ ok: true, production: publicProductionRecord(await service.restore(req.params.episodeId, version, operationId, expectedRevision)) });
        } catch (error) { handle(res, error); }
    });
    router.get<Record<string, string>>(`${base}/runs/:version`, (req, res) => {
        try { res.json({ ok: true, run: service.run(req.params.episodeId, Number(req.params.version)) }); } catch (error) { handle(res, error); }
    });
    router.post<Record<string, string>>(`${base}/runs`, async (req, res) => {
        try {
            const run = await service.startBatch(req.params.episodeId, req.body);
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
