import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { ProductionAgentPool, type ProductionAgentRequest } from "@basketikun/canvas-agent/agent/production";
import { compilationHash, compilationScopeInput, currentCompilationArtifact, productionReviewHash } from "@basketikun/canvas-agent/drama/compilation-scope";
import { directorProductionSchema, directorSceneWorkSchema, directorSharedReviewWorkSchema, productionSceneEntries, type DirectorProduction, type ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { getProductionContract, resolveAchengEngine } from "@basketikun/canvas-agent/skills/acheng";
import { EpisodeProductionService, ProductionConflictError } from "./production.js";
import { ProductionCompilationService } from "./compilation.js";
import type { EpisodeProductionRunner } from "./production-runner.js";

type SceneWork = z.infer<typeof directorSceneWorkSchema>;
type SharedWork = z.infer<typeof directorSharedReviewWorkSchema>;
const rows = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value : [];
const objectId = (value: Record<string, any>) => String(value.asset_id || value.id || "");
const requiredSceneAssets = (projected: DirectorProduction, skipFrames: boolean) => {
    const frameIds = new Set(Object.values(projected.shotInputs).map(input => input.keyframeAssetId).filter(Boolean));
    return rows(projected.source.asset_plan).filter(item => !(skipFrames && (item.kind === "keyframe" || frameIds.has(objectId(item))))).map(objectId);
};
const workers = new ProductionAgentPool();
process.once("exit", () => workers.stop());
const responseSchema = z.object({ status: z.enum(["complete", "partial", "needs_human"]), sourceJson: z.string(), shotInputsJson: z.string(), boundariesJson: z.string(), evidence: z.array(z.string()), unresolved: z.array(z.string()), cursor: z.string() }).strict();
const outputSchema = { type: "object", additionalProperties: false, properties: { status: { type: "string", enum: ["complete", "partial", "needs_human"] }, sourceJson: { type: "string" }, shotInputsJson: { type: "string" }, boundariesJson: { type: "string" }, evidence: { type: "array", items: { type: "string" } }, unresolved: { type: "array", items: { type: "string" } }, cursor: { type: "string" } }, required: ["status", "sourceJson", "shotInputsJson", "boundariesJson", "evidence", "unresolved", "cursor"] };
const reviewSchema = z.object({ verdict: z.enum(["approved", "rejected", "needs_human"]), evidence: z.string().trim().min(1), inspectedMedia: z.array(z.string()), unresolved: z.array(z.string()) }).strict();
const reviewOutputSchema = { type: "object", additionalProperties: false, properties: { verdict: { type: "string", enum: ["approved", "rejected", "needs_human"] }, evidence: { type: "string" }, inspectedMedia: { type: "array", items: { type: "string" } }, unresolved: { type: "array", items: { type: "string" } } }, required: ["verdict", "evidence", "inspectedMedia", "unresolved"] };

/** Only declared scene arrays can change. Shared facts and other scene IDs are immutable. */
export function mergeSceneSource(current: DirectorProduction, work: SceneWork, raw: unknown) {
    const result = responseSchema.parse(raw);
    if (result.status !== "complete" || result.unresolved.length) return { result };
    const baseline = compilationScopeInput({ ...current, engine: current.workflow.sceneWorks?.[work.workId]?.inputEngine || work.inputEngine || current.engine }, { sceneId: work.sceneId });
    if (baseline.inputHash !== work.inputHash && baseline.legacyInputHash !== work.inputHash) throw new Error("SCENE_INPUT_CHANGED: 场次或共同输入已变化，保留回包并回读后处理");
    const source = JSON.parse(result.sourceJson) as Record<string, any>;
    const mutable = new Set(["shots", "segments", "asset_plan", "asset_cards", "ledger"]);
    for (const key of new Set([...Object.keys(source), ...Object.keys(baseline.director.source)])) if (!mutable.has(key) && compilationHash(source[key] ?? null) !== compilationHash(baseline.director.source[key] ?? null)) throw new Error(`SCENE_WRITE_OUTSIDE_SCOPE: ${key}`);
    const sharedIds = new Set(rows(current.source.asset_plan).filter(item => item.canvas_scope === "shared").map(objectId));
    const shots = rows(source.shots), shotIds = new Set(shots.map(objectId));
    if (shotIds.size !== shots.length || shots.some(shot => String(shot.source_scene_id || "") !== work.sceneId)) throw new Error("SCENE_WRITE_OUTSIDE_SCOPE: 镜头须显式属于当前正式场次");
    const otherShots = new Set(rows(current.source.shots).filter(shot => !rows(baseline.director.source.shots).some(item => objectId(item) === objectId(shot))).map(objectId));
    if ([...shotIds].some(id => otherShots.has(id))) throw new Error("SCENE_WRITE_OUTSIDE_SCOPE: 镜头 ID 属于其他场次");
    const segments = rows(source.segments), segmentIds = new Set(segments.map(objectId));
    if (segments.some(segment => !segment.shot_ids?.length || segment.shot_ids.some((id: string) => !shotIds.has(id)))) throw new Error("SCENE_WRITE_OUTSIDE_SCOPE: Segment 引用了其他场次");
    const newPlans = rows(source.asset_plan);
    for (const plan of newPlans) {
        const id = objectId(plan);
        if (sharedIds.has(id)) {
            if (compilationHash(plan) !== compilationHash(rows(current.source.asset_plan).find(item => objectId(item) === id))) throw new Error("SCENE_WRITE_OUTSIDE_SCOPE: 共同资产不能修改");
        } else if (plan.canvas_scope !== "episode" || !plan.shot_ids?.length || plan.shot_ids.some((id: string) => !shotIds.has(id))) throw new Error("SCENE_WRITE_OUTSIDE_SCOPE: 专用资产须绑定本场镜头");
    }
    const priorIds = new Set(baseline.targetIds);
    const existingSegments = rows(current.source.segments).filter(item => !priorIds.has(objectId(item)));
    if (existingSegments.some(item => segmentIds.has(objectId(item)))) throw new Error("SCENE_WRITE_OUTSIDE_SCOPE: Segment ID 已被其他场次使用");
    const localAssets = new Set(newPlans.filter(item => !sharedIds.has(objectId(item))).map(objectId));
    if (rows(current.source.asset_plan).some(item => !priorIds.has(objectId(item)) && localAssets.has(objectId(item)))) throw new Error("SCENE_WRITE_OUTSIDE_SCOPE: 资产 ID 已被其他场次使用");
    for (const card of rows(source.asset_cards)) if (sharedIds.has(objectId(card))) {
        if (compilationHash(card) !== compilationHash(rows(current.source.asset_cards).find(item => objectId(item) === objectId(card)))) throw new Error("SCENE_WRITE_OUTSIDE_SCOPE: 共同资产卡不能修改");
    } else if (!localAssets.has(objectId(card))) throw new Error("SCENE_WRITE_OUTSIDE_SCOPE: 资产卡无本场资产");
    const next = structuredClone(current);
    next.source.shots = [...rows(current.source.shots).filter(item => otherShots.has(objectId(item))), ...shots];
    next.source.segments = [...existingSegments, ...segments];
    const order = productionSceneEntries(next.source);
    const rank = (shotId: string) => order.findIndex(scene => scene.shotIds.includes(shotId));
    next.source.shots = rows(next.source.shots).sort((a, b) => rank(objectId(a)) - rank(objectId(b)));
    next.source.segments = rows(next.source.segments).sort((a, b) => rank(String(a.shot_ids?.[0])) - rank(String(b.shot_ids?.[0])));
    for (const field of ["asset_plan", "asset_cards"]) next.source[field] = [...rows(current.source[field]).filter(item => sharedIds.has(objectId(item)) || !priorIds.has(objectId(item))), ...rows(source[field]).filter(item => !sharedIds.has(objectId(item)))];
    const inputs = JSON.parse(result.shotInputsJson) as DirectorProduction["shotInputs"];
    if (Object.keys(inputs).some(id => !shotIds.has(id))) throw new Error("SCENE_WRITE_OUTSIDE_SCOPE: 镜头输入越界");
    next.shotInputs = { ...Object.fromEntries(Object.entries(current.shotInputs).filter(([id]) => otherShots.has(id))), ...inputs };
    const boundaries = JSON.parse(result.boundariesJson) as DirectorProduction["boundaries"];
    if (boundaries.some(item => !segmentIds.has(item.from) || !segmentIds.has(item.to))) throw new Error("SCENE_WRITE_OUTSIDE_SCOPE: 承接边界越界");
    next.boundaries = [...current.boundaries.filter(item => !(priorIds.has(item.from) && priorIds.has(item.to))), ...boundaries];
    const orderedSegments = rows(next.source.segments);
    const shotScene = new Map(rows(next.source.shots).map(shot => [objectId(shot), String(shot.source_scene_id)]));
    for (let index = 0; index < orderedSegments.length - 1; index++) {
        const from = orderedSegments[index], to = orderedSegments[index + 1];
        if (shotScene.get(String(from.shot_ids?.[0])) !== shotScene.get(String(to.shot_ids?.[0])) && !next.boundaries.some(item => item.from === objectId(from))) next.boundaries.push({ from: objectId(from), to: objectId(to), tailFrame: false, motionContext: false, reason: "场次切换，独立切镜" });
    }
    if (current.source.ledger) {
        const before = current.source.ledger as Record<string, any>, projected = baseline.director.source.ledger as Record<string, any>;
        const proposed = source.ledger as Record<string, any>;
        if (!proposed || before.contract_version !== 2) throw new Error("SCENE_WRITE_OUTSIDE_SCOPE: 连续性合同缺失或需显式升级");
        const blocks = new Set(rows(baseline.director.source.script_scenes).flatMap(item => rows(item.blocks).map(block => objectId(block))));
        const allowed = new Set(["events", "requirements", "coverage"]);
        for (const key of new Set([...Object.keys(projected), ...Object.keys(proposed)])) if (!allowed.has(key) && compilationHash(projected[key] ?? null) !== compilationHash(proposed[key] ?? null)) throw new Error(`SCENE_WRITE_OUTSIDE_SCOPE: ledger.${key} 是共同基础`);
        const ledger = structuredClone(before);
        for (const field of allowed) {
            const belongs = (item: Record<string, any>) => field === "coverage" ? blocks.has(String(item.source_anchor?.block_id || item.block_id)) : shotIds.has(String(item.shot_id));
            if (rows(proposed[field]).some(item => !belongs(item))) throw new Error(`SCENE_WRITE_OUTSIDE_SCOPE: ledger.${field}`);
            const ownedBefore = (item: Record<string, any>) => belongs(item) || (field !== "coverage" && rows(baseline.director.source.shots).some(shot => objectId(shot) === item.shot_id));
            ledger[field] = [...rows(before[field]).filter(item => !ownedBefore(item)), ...rows(proposed[field])];
        }
        next.source.ledger = ledger;
    }
    for (const id of localAssets) next.assets[id] ||= { status: "planned", version: String(newPlans.find(item => objectId(item) === id)?.version || "v1") };
    const changedAssets = new Set([...localAssets].filter(id => ["asset_plan", "asset_cards"].some(field => compilationHash(rows(current.source[field]).find(item => objectId(item) === id) || null) !== compilationHash(rows(next.source[field]).find(item => objectId(item) === id) || null))));
    for (const id of localAssets) if (newPlans.find(item => objectId(item) === id)?.kind === "keyframe" || Object.values(next.shotInputs).some(input => input.keyframeAssetId === id)) {
        const associated = new Set(newPlans.find(item => objectId(item) === id)?.shot_ids || []);
        for (const [shotId, input] of Object.entries(next.shotInputs)) if (input.keyframeAssetId === id) associated.add(shotId);
        if (compilationHash(rows(current.source.shots).filter(item => associated.has(objectId(item)))) !== compilationHash(rows(next.source.shots).filter(item => associated.has(objectId(item))))) changedAssets.add(id);
    }
    let grew = true;
    while (grew) { grew = false; for (const id of localAssets) {
        const plan = rows(next.source.asset_plan).find(item => objectId(item) === id), card = rows(next.source.asset_cards).find(item => objectId(item) === id);
        if (!changedAssets.has(id) && [...(plan?.depends_on || []), ...rows(card?.references).map(item => item.asset_id)].some(dep => changedAssets.has(String(dep)))) { changedAssets.add(id); grew = true; }
    } }
    for (const id of changedAssets) if (current.assets[id]?.storageKey) next.assets[id].inputOutdated = true;
    next.sourceHash = compilationHash(next.source);
    next.artifacts = next.artifacts.map(item => currentCompilationArtifact(next, item) ? item : { ...item, status: "stale" });
    next.executionAuthorized = false;
    return { result, director: directorProductionSchema.parse(next) };
}

export class SceneWorkCoordinator {
    private active = new Set<string>();
    private root: string;
    constructor(private service: EpisodeProductionService, private compilations: ProductionCompilationService, private runner: EpisodeProductionRunner | undefined, private owner: string, private agent: Pick<ProductionAgentPool, "run"> = workers) {
        this.root = path.join(service.compilationRoot(), "scene-work");
    }
    private save(id: string, work: SceneWork, operationId = `scene-state:${work.workId}:${compilationHash(work)}`) {
        const current = this.service.get(id);
        const sceneWorks = { ...current.draft.director!.workflow.sceneWorks, [work.workId]: directorSceneWorkSchema.parse(work) };
        return this.service.edit(id, { operationId, expectedRevision: current.revision, ops: [{ type: "set_director_workflow", patch: { sceneWorks } }] }, undefined, true);
    }
    private update(id: string, workId: string, patch: Partial<SceneWork>, resume = false, operationId?: string) {
        const current = this.service.get(id), work = current.draft.director?.workflow.sceneWorks?.[workId];
        if (!work) throw new Error("场次工作不存在");
        if (work.status === "paused" && patch.status !== "paused" && !resume) return current;
        if (!operationId && Object.entries(patch).every(([key, value]) => compilationHash((work as any)[key] ?? null) === compilationHash(value ?? null))) return current;
        return this.save(id, { ...work, ...patch, updatedAt: new Date().toISOString() }, operationId);
    }
    private file(workId: string, cursor?: string) { return path.join(this.root, `${compilationHash({ workId, cursor: cursor || "" })}.json`); }
    commandReceipt(id: string, operationId: string, request: unknown) {
        const file = path.join(this.root, `command-${compilationHash({ owner: this.owner, id, operationId })}.json`);
        const requestHash = compilationHash(request), prior = this.service.operationReceipt(id, operationId);
        if (fs.existsSync(file)) {
            if (JSON.parse(fs.readFileSync(file, "utf8")).requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT: operationId 已用于不同场次操作");
        } else {
            if (prior) throw new Error("IDEMPOTENCY_CONFLICT: operationId 已属于其他制作操作");
            fs.mkdirSync(this.root, { recursive: true });
            const temporary = `${file}.${randomUUID()}.pending`;
            fs.writeFileSync(temporary, JSON.stringify({ requestHash }), { flag: "wx" }); fs.renameSync(temporary, file);
        }
        return prior;
    }
    inspect(id: string) {
        const current = this.service.get(id), director = current.draft.director;
        if (!director) return { revision: current.revision, works: [], shared: null };
        let shared: Record<string, unknown>;
        try { const selection = this.sharedSelection(id), value = this.shared(id, true, selection); shared = { reviewAssetIds: selection, reviewCurrent: !selection && director.workflow.sharedReview?.inputHash === value.inputHash && director.workflow.sharedReview?.verdict === "approved", reviews: director.workflow.sharedAssetReviews, continuation: director.workflow.sharedReviewContinuation, reviewWorks: Object.values(director.workflow.sharedReviewWorks || {}), inputHash: value.inputHash, review: director.workflow.sharedReview, source: director.source, media: value.media.map(({ filePath: _file, ...item }) => item) }; }
        catch (error) { shared = { continuation: director.workflow.sharedReviewContinuation, reviewWorks: Object.values(director.workflow.sharedReviewWorks || {}), error: error instanceof Error ? error.message : String(error) }; }
        const works = Object.values(director.workflow.sceneWorks || {}).map(work => {
            try {
                const projection = compilationScopeInput({ ...director, engine: work.inputEngine || director.engine }, { sceneId: work.sceneId });
                const media = this.service.sceneReviewMedia(id, projection.targetIds.filter(targetId => director.assets[targetId]?.storageKey));
                const missing = requiredSceneAssets(projection.director, current.draft.settings.storyboardImageMode === "skip").some(id => !director.assets[id]?.storageKey);
                const reviewAssetIds = missing ? media.filter(item => director.assets[item.targetId]?.status === "generated").map(item => item.targetId) : undefined;
                return { ...work, reviewInputHash: productionReviewHash(projection.inputHash, media), inputChanged: projection.inputHash !== work.inputHash && projection.legacyInputHash !== work.inputHash, reviewAssetIds, source: projection.director.source, media: media.map(({ filePath: _file, ...item }) => item) };
            } catch (error) { return { ...work, error: error instanceof Error ? error.message : String(error) }; }
        });
        return { revision: current.revision, works, shared };
    }
    private sharedIds(id: string) {
        const director = this.service.get(id).draft.director!;
        return rows(director.source.asset_plan).filter(item => item.canvas_scope === "shared" || director.assets[objectId(item)]?.sharedSource).map(objectId);
    }
    private sharedSelection(id: string) {
        const director = this.service.get(id).draft.director!, ids = this.sharedIds(id);
        if (ids.every(assetId => ["generated", "approved"].includes(director.assets[assetId]?.status || "") && director.assets[assetId]?.storageKey && !director.assets[assetId]?.inputOutdated)) return undefined;
        const ready = ids.filter(assetId => director.assets[assetId]?.status === "generated" && director.assets[assetId]?.storageKey && !director.assets[assetId]?.inputOutdated);
        if (!ready.length) throw new Error("SHARED_ASSET_MEDIA_REQUIRED: 共同素材尚未就绪，请先生成或处理被退回的素材");
        return ready;
    }
    private shared(id: string, allowGenerated = false, assetIds?: string[]) {
        const director = this.service.get(id).draft.director!, ids = this.sharedIds(id);
        const selected = assetIds || ids;
        if (assetIds && (!assetIds.length || assetIds.some(assetId => !ids.includes(assetId)))) throw new Error("审核素材不属于共同基础");
        const closure = new Set(selected), plans = rows(director.source.asset_plan), cards = rows(director.source.asset_cards);
        const visit = (assetId: string) => {
            const plan = plans.find(item => objectId(item) === assetId), card = cards.find(item => objectId(item) === assetId);
            for (const dep of [...(plan?.depends_on || []), ...rows(card?.references).map(item => item.asset_id)].filter(Boolean)) if (!closure.has(String(dep))) { closure.add(String(dep)); visit(String(dep)); }
        };
        selected.forEach(visit);
        if ([...closure].some(assetId => !director.assets[assetId]?.storageKey || director.assets[assetId]?.inputOutdated || !(allowGenerated ? ["generated", "approved"] : ["approved"]).includes(director.assets[assetId]?.status || ""))) throw new Error("SHARED_ASSET_REVIEW_REQUIRED: 共同资产或依赖尚未准备好");
        const media = this.service.sceneReviewMedia(id, [...closure]);
        const ledger = director.source.ledger as Record<string, unknown> | undefined;
        const inputHash = compilationHash({ brief: director.source.brief, story: director.source.story, scripts: director.source.script_scenes, style: director.source.style_lock, characters: director.source.character_registry, scenes: director.source.scene_registry,
            plans: plans.filter(item => closure.has(objectId(item))), cards: cards.filter(item => closure.has(objectId(item))),
            ledger: ledger && { contract_version: ledger.contract_version, facts: ledger.facts, timelines: ledger.timelines, initial: ledger.initial },
            assets: [...closure].sort().map(assetId => { const asset = director.assets[assetId]; return { assetId, nodeId: asset.nodeId, version: asset.version, storageKey: asset.storageKey, sha256: asset.sha256, sharedSource: asset.sharedSource }; }), media: media.map(({ filePath: _file, ...item }) => item) });
        return { director, media, inputHash };
    }
    private saveSharedWork(id: string, work: SharedWork, operationId = `shared-review-state:${work.workId}:${compilationHash(work)}`) {
        const current = this.service.get(id);
        return this.service.edit(id, { operationId, expectedRevision: current.revision, ops: [{ type: "set_director_workflow", patch: { sharedReviewWorks: { ...current.draft.director!.workflow.sharedReviewWorks, [work.workId]: directorSharedReviewWorkSchema.parse(work) } } }] }, undefined, true);
    }
    private updateSharedWork(id: string, workId: string, patch: Partial<SharedWork>) {
        const current = this.service.get(id).draft.director!.workflow.sharedReviewWorks![workId];
        return this.saveSharedWork(id, { ...current, ...patch, updatedAt: new Date().toISOString() });
    }
    private sharedContextHash(id: string) {
        const source = this.service.get(id).draft.director!.source, ids = new Set(this.sharedIds(id)), ledger = source.ledger as Record<string, unknown> | undefined;
        return compilationHash({ brief: source.brief, story: source.story, scripts: source.script_scenes, style: source.style_lock, characters: source.character_registry, scenes: source.scene_registry, plans: rows(source.asset_plan).filter(item => ids.has(objectId(item))), cards: rows(source.asset_cards).filter(item => ids.has(objectId(item))), ledger: ledger && { contract_version: ledger.contract_version, facts: ledger.facts, timelines: ledger.timelines, initial: ledger.initial } });
    }
    private saveSharedContinuation(id: string, patch: Partial<NonNullable<DirectorProduction["workflow"]["sharedReviewContinuation"]>>, operationId?: string) {
        const current = this.service.get(id), value = { ...current.draft.director!.workflow.sharedReviewContinuation!, ...patch, updatedAt: new Date().toISOString() };
        return this.service.edit(id, { operationId: operationId || `shared-continuation:${compilationHash(value)}`, expectedRevision: current.revision, ops: [{ type: "set_director_workflow", patch: { sharedReviewContinuation: value } }] }, undefined, true);
    }
    startSharedReview(id: string, input: { operationId: string; expectedRevision: number; model?: string; effort?: string }) {
        const prior = this.service.operationReceipt(id, input.operationId); if (prior) return prior;
        const current = this.service.get(id), settings = current.draft.settings;
        if (current.revision !== input.expectedRevision) throw new ProductionConflictError(current);
        if (!current.draft.director || !settings.parallelScenes || settings.reviewPolicy?.shared !== "automatic") throw new Error("SHARED_AUTO_REVIEW_NOT_ENABLED: 请在开局选择共同基础自动审核");
        const existing = Object.values(current.draft.director.workflow.sharedReviewWorks || {}).find(work => ["pending", "running"].includes(work.status));
        if (existing) throw new Error("共同基础审核已在运行，请查看原工作回执");
        const result = this.saveSharedContinuation(id, { authorizationId: input.operationId, contextHash: this.sharedContextHash(id), status: "active", policy: structuredClone(settings.reviewPolicy), model: input.model, effort: input.effort, error: null }, input.operationId);
        this.wake(id); return result;
    }
    private continueSharedReview(id: string) {
        const current = this.service.get(id), director = current.draft.director!, continuation = director.workflow.sharedReviewContinuation;
        if (!continuation || continuation.status !== "active") return;
        if (continuation.contextHash !== this.sharedContextHash(id)) { this.saveSharedContinuation(id, { status: "paused", error: "共同源稿或资产范围已变化，请核对后明确重新启动审核" }); return; }
        const works = Object.values(director.workflow.sharedReviewWorks || {});
        if (works.some(work => ["pending", "running"].includes(work.status))) return;
        let assetIds: string[] | undefined, shared: ReturnType<SceneWorkCoordinator["shared"]>;
        try { assetIds = this.sharedSelection(id); shared = this.shared(id, true, assetIds); }
        catch { return; } // Media is not ready; the next persisted production event wakes this continuation.
        if (!assetIds && director.workflow.sharedReview?.inputHash === shared.inputHash && director.workflow.sharedReview.verdict === "approved") { this.saveSharedContinuation(id, { status: "complete", error: null }); return; }
        const prior = works.find(work => work.inputHash === shared.inputHash && compilationHash(work.assetIds || null) === compilationHash(assetIds || null));
        if (prior?.status === "paused") { this.saveSharedWork(id, { ...prior, status: "pending", error: null }); void this.advanceSharedReview(id, prior.workId); return; }
        if (prior && prior.status !== "succeeded") { this.saveSharedContinuation(id, { status: "awaiting_review", error: prior.error || "原审核需要人工决定，不自动重跑" }); return; }
        if (prior?.status === "succeeded") return;
        const workId = `shared-review:${compilationHash({ id, authorizationId: continuation.authorizationId, inputHash: shared.inputHash, assetIds }).slice(0, 24)}`;
        const work: SharedWork = { workId, assetIds, sourceHash: shared.director.sourceHash, inputHash: shared.inputHash, inputRevision: current.revision + 1, status: "pending", policy: structuredClone(continuation.policy), model: continuation.model, effort: continuation.effort, updatedAt: new Date().toISOString() };
        this.saveSharedWork(id, work); void this.advanceSharedReview(id, workId);
    }
    private async advanceSharedReview(id: string, workId: string) {
        const key = `shared:${id}:${workId}`; if (this.active.has(key)) return; this.active.add(key);
        try {
            const work = this.service.get(id).draft.director!.workflow.sharedReviewWorks![workId];
            if (!["pending", "running"].includes(work.status)) return;
            const shared = this.shared(id, true, work.assetIds);
            if (shared.inputHash !== work.inputHash) throw new Error("审核源稿或媒体已变化，请查看新版本后人工审核");
            if (shared.media.some(item => !item.mimeType.startsWith("image/"))) throw new Error("自动审核缺少此媒体类型的分析能力");
            this.updateSharedWork(id, workId, { status: "running" });
            const file = this.file(workId);
            let raw: unknown;
            if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, "utf8"));
            else {
                raw = (await this.agent.run({ workId, review: true, threadId: work.agentThreadId, turnId: work.agentTurnId, recoverOutput: work.recoveryPending, model: work.model, effort: work.effort as ProductionAgentRequest["effort"], cwd: process.cwd(), schema: reviewOutputSchema,
                    images: shared.media.map(item => `data:${item.mimeType};base64,${fs.readFileSync(item.filePath).toString("base64")}`),
                    prompt: `审核${work.assetIds ? "当前就绪的一批共同资产，不批准完整共同基础" : "完整共同基础"}。实际查看每张图片，检查身份、画风、构图、跨资产一致性、共同叙事事实与连续性。缺少图片分析能力、证据不足或需要创作选择必须 needs_human，不以文件存在当作通过。inspectedMedia 填实际查看的 storageKey。\n${JSON.stringify({ source: shared.director.source, assetIds: work.assetIds, media: shared.media.map(({ filePath: _path, ...item }) => item) })}`,
                    onThread: agentThreadId => { this.updateSharedWork(id, workId, { agentThreadId }); }, onTurn: agentTurnId => { this.updateSharedWork(id, workId, { agentTurnId }); },
                })).output;
                fs.mkdirSync(this.root, { recursive: true }); const temporary = `${file}.${randomUUID()}.pending`; fs.writeFileSync(temporary, JSON.stringify(raw), { flag: "wx" }); fs.renameSync(temporary, file);
            }
            const latest = this.service.get(id).draft.director!.workflow.sharedReviewWorks![workId]; if (latest.status !== "running") return;
            const output = reviewSchema.parse(raw);
            if (output.verdict === "needs_human" || output.unresolved.length || shared.media.some(item => !output.inspectedMedia.includes(item.storageKey))) throw new Error(output.evidence);
            await this.review(id, { assetIds: work.assetIds, inputHash: work.inputHash, verdict: output.verdict, evidence: output.evidence }, "automatic");
        } catch (error) { const message = error instanceof Error ? error.message : String(error); this.updateSharedWork(id, workId, { status: "awaiting_review", error: message }); if (this.service.get(id).draft.director!.workflow.sharedReviewContinuation) this.saveSharedContinuation(id, { status: "awaiting_review", error: message }); }
        finally { this.active.delete(key); queueMicrotask(() => this.wake(id)); }
    }
    start(id: string, input: { operationId: string; expectedRevision: number; sceneIds: string[]; generateMedia: boolean; model?: string; effort?: string }) {
        const prior = this.service.operationReceipt(id, input.operationId);
        if (prior) return { production: prior, replayed: true };
        const current = this.service.get(id), director = current.draft.director;
        if (current.revision !== input.expectedRevision) throw new ProductionConflictError(current);
        if (!director || !current.draft.settings.parallelScenes || !current.draft.settings.reviewPolicy) throw new Error("SCENE_SETTINGS_REQUIRED: 请在剧目开局明确启用并行制作并选择审核模式");
        const shared = this.shared(id);
        const known = new Set(productionSceneEntries(director.source).map(scene => scene.id));
        const sceneWorks = { ...director.workflow.sceneWorks };
        for (const sceneId of [...new Set(input.sceneIds)]) {
            if (!known.has(sceneId)) throw new Error(`正式场次不存在：${sceneId}`);
            const existing = Object.values(sceneWorks).find(work => work.sceneId === sceneId && !["failed", "succeeded"].includes(work.status));
            if (existing) {
                if (input.generateMedia && !existing.generationAuthorized && existing.stage !== "create" && existing.status === "awaiting_review") {
                    sceneWorks[existing.workId] = { ...existing, generationAuthorized: true, status: "pending", inputRevision: current.revision + 1, error: null, updatedAt: new Date().toISOString() };
                    continue;
                }
                throw new Error(`场次 ${sceneId} 已有工作；请恢复原 workId`);
            }
            const workId = `scene:${compilationHash({ id, operationId: input.operationId, sceneId }).slice(0, 24)}`;
            sceneWorks[workId] = { workId, sceneId, inputRevision: current.revision + 1, sourceHash: director.sourceHash, inputHash: compilationScopeInput(director, { sceneId }).inputHash,
                status: director.workflow.sharedReview?.inputHash === shared.inputHash && director.workflow.sharedReview.verdict === "approved" ? "pending" : "awaiting_review", stage: "create", runIds: [], artifactIds: [], generationAuthorized: input.generateMedia,
                policy: structuredClone(current.draft.settings.reviewPolicy), model: input.model, effort: input.effort, updatedAt: new Date().toISOString() };
        }
        const production = this.service.edit(id, { operationId: input.operationId, expectedRevision: input.expectedRevision, ops: [{ type: "set_director_workflow", patch: { sceneWorks } }] }, undefined, true);
        for (const work of Object.values(sceneWorks).filter(work => work.inputRevision === current.revision + 1)) void this.advance(id, work.workId);
        return { production, sharedReview: { inputHash: shared.inputHash, media: shared.media.map(({ filePath: _file, ...item }) => item) }, mediaAuthorized: input.generateMedia };
    }
    pause(id: string, workId: string, operationId?: string) {
        const existing = this.service.get(id).draft.director?.workflow.sceneWorks?.[workId];
        if (!existing || ["succeeded", "failed"].includes(existing.status)) throw new Error("场次工作不存在或已结束");
        this.update(id, workId, { status: "paused" }, false, operationId);
        const work = this.service.get(id).draft.director!.workflow.sceneWorks![workId];
        for (const runId of work.runIds) if (["pending", "running", "awaiting_review"].includes(this.service.getBatch(id, runId)?.status || "")) this.service.pauseBatch(id, runId);
        return this.service.get(id);
    }
    resume(id: string, workId: string, operationId?: string) {
        const work = this.service.get(id).draft.director?.workflow.sceneWorks?.[workId];
        if (!work || ["succeeded", "failed"].includes(work.status)) throw new Error("场次工作不存在或已结束；退回或失败请明确新建返修工作");
        if (work.runIds.some(runId => this.service.getBatch(id, runId)?.status === "failed")) throw new Error("媒体运行已失败；请明确返修并新建生成运行，不自动重提交");
        for (const runId of work.runIds) if (this.service.getBatch(id, runId)?.status === "paused" || this.service.getBatch(id, runId)?.pauseRequested) {
            this.service.resumeBatch(id, runId); if (this.runner) void this.runner.runBatch(id, runId);
        }
        this.update(id, workId, { status: "pending", error: null }, true, operationId); void this.advance(id, workId);
        return this.service.get(id);
    }
    async review(id: string, input: { operationId?: string; workId?: string; assetIds?: string[]; inputHash: string; verdict: "approved" | "rejected"; evidence: string }, mode: "manual" | "automatic" = "manual") {
        const current = this.service.get(id), director = current.draft.director!;
        const work = input.workId ? director.workflow.sceneWorks?.[input.workId] : undefined;
        if (input.workId && !work) throw new Error("场次审核工作不存在");
        if (work && (work.stage !== "review" || !["awaiting_review", "paused"].includes(work.status))) throw new Error("SCENE_REVIEW_NOT_READY: 本场源稿或媒体尚未进入审核阶段");
        const projection = work ? compilationScopeInput(director, { sceneId: work.sceneId }) : undefined;
        if (work && input.assetIds && input.assetIds.some(assetId => !projection!.targetIds.includes(assetId))) throw new Error("审核素材不属于当前场次");
        const allMedia = work ? this.service.sceneReviewMedia(id, projection!.targetIds.filter(assetId => director.assets[assetId]?.storageKey)) : this.shared(id, true, input.assetIds).media;
        const media = input.assetIds ? allMedia.filter(item => input.assetIds!.includes(item.targetId)) : allMedia;
        if (input.assetIds && (!input.assetIds.length || input.assetIds.some(assetId => !media.some(item => item.targetId === assetId)))) throw new Error("审核缺少真实素材");
        const inputHash = projection?.inputHash || this.shared(id, true, input.assetIds).inputHash;
        const mediaInputHash = work ? productionReviewHash(inputHash, allMedia) : inputHash;
        if (mediaInputHash !== input.inputHash) throw new Error("REVIEW_INPUT_CHANGED: 审核输入或媒体版本已变化");
        if (work && input.verdict === "approved") {
            const missing = requiredSceneAssets(projection!.director, current.draft.settings.storyboardImageMode === "skip").filter(assetId => !director.assets[assetId]?.storageKey);
            if (!input.assetIds && missing.length) throw new Error(`审核缺少真实素材：${missing.join(", ")}`);
        }
        const checkedAt = new Date().toISOString();
        const review = { sourceHash: director.sourceHash, inputHash, mediaInputHash, verdict: input.verdict, mode, evidence: input.evidence, media: media.map(({ targetId, storageKey, sha256 }) => ({ targetId, storageKey, sha256 })), checkedAt };
        const ops: ProductionOperation[] = [];
        for (const item of media) if (director.assets[item.targetId]?.status !== input.verdict || director.assets[item.targetId]?.inputOutdated) {
            if (!current.published?.director) throw new Error("审核素材尚未发布");
            ops.push({ type: "review_director_asset", assetId: item.targetId, version: current.publishedVersion, sourceHash: current.published.director.sourceHash, nodeId: item.nodeId, storageKey: item.storageKey, sha256: item.sha256, verdict: input.verdict, evidence: input.evidence });
        }
        if (work) {
            const next = { ...work, status: work.status === "paused" ? "paused" as const : input.verdict === "approved" ? "pending" as const : "failed" as const, error: input.verdict === "approved" ? null : input.evidence, updatedAt: checkedAt,
                ...(input.assetIds ? { stage: "assets" as const, compilationId: undefined, assetReviews: [...(work.assetReviews || []), review] } : { review, stage: input.verdict === "approved" ? "compile" as const : "review" as const }) };
            ops.push({ type: "set_director_workflow", patch: { sceneWorks: { ...director.workflow.sceneWorks, [work.workId]: next } } });
        } else {
            const sharedReviewWorks = { ...director.workflow.sharedReviewWorks };
            for (const [key, audit] of Object.entries(sharedReviewWorks)) if (audit.inputHash === inputHash && !["succeeded", "failed"].includes(audit.status)) sharedReviewWorks[key] = { ...audit, review, status: input.verdict === "approved" ? "succeeded" : "failed", error: input.verdict === "approved" ? null : input.evidence, updatedAt: checkedAt };
            ops.push({ type: "set_director_workflow", patch: { sharedReviewWorks, ...(director.workflow.sharedReviewContinuation ? { sharedReviewContinuation: { ...director.workflow.sharedReviewContinuation, status: input.verdict === "approved" ? input.assetIds ? "active" as const : "complete" as const : "awaiting_review" as const, error: input.verdict === "approved" ? null : input.evidence, updatedAt: checkedAt } } : {}), ...(input.assetIds ? { sharedAssetReviews: [...(director.workflow.sharedAssetReviews || []), review] } : { sharedReview: review }) } });
        }
        const operationId = input.operationId || `scene-review:${compilationHash({ workId: work?.workId, inputHash: mediaInputHash, assetIds: input.assetIds, verdict: input.verdict, evidence: input.evidence, mode })}`;
        this.service.edit(id, { operationId, expectedRevision: current.revision, ops }, undefined, true);
        for (const item of Object.values(this.service.get(id).draft.director!.workflow.sceneWorks || {})) if (input.verdict === "approved" && (!work || item.workId === work.workId) && item.status !== "paused") void this.advance(id, item.workId);
        if (!work && input.verdict === "approved") queueMicrotask(() => this.wake(id));
        return this.service.get(id);
    }
    private async automaticReview(id: string, work: SceneWork, shared = false, assetIds?: string[]) {
        if (!shared) this.update(id, work.workId, { status: "awaiting_review" });
        const state = shared ? this.shared(id) : undefined;
        const director = this.service.get(id).draft.director!;
        const projection = compilationScopeInput(director, { sceneId: work.sceneId });
        const allMedia = state?.media || this.service.sceneReviewMedia(id, projection.targetIds.filter(targetId => director.assets[targetId]?.storageKey));
        const media = assetIds ? allMedia.filter(item => assetIds.includes(item.targetId)) : allMedia;
        const inputHash = state?.inputHash || productionReviewHash(projection.inputHash, allMedia);
        if (media.some(item => !String(item.mimeType).startsWith("image/"))) return this.update(id, work.workId, { status: "awaiting_review", error: "自动审核缺少此媒体类型的分析能力，请人工核对" });
        let result: z.infer<typeof reviewSchema>;
        try { result = reviewSchema.parse((await this.agent.run({ workId: `review:${shared ? id : work.workId}:${inputHash}`, review: true, cwd: process.cwd(), model: work.model, effort: work.effort as ProductionAgentRequest["effort"], schema: reviewOutputSchema,
            images: media.map(item => `data:${item.mimeType};base64,${fs.readFileSync(item.filePath).toString("base64")}`),
            prompt: `审核${shared ? "共同基础" : assetIds ? "本场当前就绪的前置素材；其他未生成图片不属于这次审核，不批准整个场次开拍" : "当前场次开拍条件"}。逐一查看实际图片，检查剧情、表演设计、身份、画风、构图与连续性。没有充分证据必须 needs_human；不能以文件存在代替视觉通过。inspectedMedia 填实际查看的 storageKey。\n${JSON.stringify({ source: state ? director.source : projection.director.source, media: media.map(({ filePath: _file, ...item }) => item) })}`,
            onThread: () => undefined })).output); }
        catch (error) { return this.update(id, work.workId, { status: "awaiting_review", error: `自动审核不可用，请人工核对：${error instanceof Error ? error.message : String(error)}` }); }
        const latestWork = this.service.get(id).draft.director?.workflow.sceneWorks?.[work.workId];
        if (!latestWork || latestWork.status === "paused" || (!shared && (latestWork.stage !== "review" || latestWork.status !== "awaiting_review"))) return;
        if (result.verdict === "needs_human" || result.unresolved.length || media.some(item => !result.inspectedMedia.includes(item.storageKey))) return this.update(id, work.workId, { status: "awaiting_review", error: result.evidence });
        try { return await this.review(id, { workId: shared ? undefined : work.workId, assetIds, inputHash, verdict: result.verdict, evidence: result.evidence }, "automatic"); }
        catch (error) {
            if (String(error).includes("REVIEW_INPUT_CHANGED")) return this.update(id, work.workId, { status: "awaiting_review", error: "审核期间源稿或图片已变化，请查看最新版本重新审核" });
            throw error;
        }
    }
    async advance(id: string, workId: string) {
        const activeId = `${id}:${workId}`; if (this.active.has(activeId)) return;
        this.active.add(activeId);
        try {
            let current = this.service.get(id), work = current.draft.director!.workflow.sceneWorks![workId];
            if (!work || ["paused", "succeeded", "failed", "blocked"].includes(work.status)) return;
            const shared = this.shared(id);
            if (current.draft.director!.workflow.sharedReview?.inputHash !== shared.inputHash || current.draft.director!.workflow.sharedReview?.verdict !== "approved") {
                if (work.policy.shared === "automatic") await this.automaticReview(id, work, true);
                else this.update(id, workId, { status: "awaiting_review", error: "等待共同基础导演审核" });
                current = this.service.get(id); work = current.draft.director!.workflow.sceneWorks![workId];
                if (current.draft.director!.workflow.sharedReview?.verdict !== "approved") return;
            }
            if (work.stage === "create") {
                this.update(id, workId, { status: "running" });
                const projection = compilationScopeInput({ ...current.draft.director!, engine: work.inputEngine || current.draft.director!.engine }, { sceneId: work.sceneId });
                if (projection.inputHash !== work.inputHash && projection.legacyInputHash !== work.inputHash) throw new Error("SCENE_INPUT_CHANGED: 工作输入已变化");
                let raw: unknown;
                const resultFile = this.file(workId, work.cursor);
                if (fs.existsSync(resultFile)) raw = JSON.parse(fs.readFileSync(resultFile, "utf8"));
                else {
                    const contract = getProductionContract();
                    const runtime = resolveAchengEngine();
                    raw = (await this.agent.run({ workId, cwd: process.cwd(), readRoots: [path.dirname(runtime.skillPath)], threadId: work.agentThreadId, recoverOutput: work.recoveryPending, turnId: work.agentTurnId, onTurn: agentTurnId => { this.update(id, workId, { agentTurnId }); }, model: work.model, effort: work.effort as ProductionAgentRequest["effort"], schema: outputSchema,
                        prompt: `读取 ${runtime.skillPath} 与当前需要的专业模块。根据当前激活 Acheng 合同完成当前场次的详细分镜、表演、动作、资产卡和 Segment 源稿。不得改变剧本、共同事实或其他场次。若有 priorFeedback，按退回意见定位本场源字段并返修，不提交媒体或自动重生成。所有镜头 source_scene_id 必须为 ${work.sceneId}；专用资产 canvas_scope=episode 并写 shot_ids。返回完整输入源稿的 JSON 字符串 sourceJson，镜头映射 shotInputsJson 与本场相邻边界 boundariesJson。只有 shots/segments/asset_plan/asset_cards 和本场 ledger.events/requirements/coverage 可改；事实、时间线、初态及其他字段逐字保留。若缺共同连续性骨架，返回 needs_human，不新建或猜测事实。每镜写 timeline_id/story_order，本场剧本块登记真实覆盖，保持完整详细度。续写游标：${work.cursor || "首次"}。\n${JSON.stringify({ source: projection.director.source, priorFeedback: Object.values(current.draft.director!.workflow.sceneWorks || {}).filter(item => item.sceneId === work.sceneId && item.workId !== workId).map(item => ({ workId: item.workId, review: item.review, error: item.error })), approvedAssets: current.draft.director!.assets, settings: current.draft.settings, engine: contract.engine, contract: contract.sourceContract })}`,
                        onThread: threadId => { this.update(id, workId, { agentThreadId: threadId }); } })).output;
                    fs.mkdirSync(this.root, { recursive: true }); const temporary = `${resultFile}.${randomUUID()}.pending`; fs.writeFileSync(temporary, JSON.stringify(raw), { flag: "wx" }); fs.renameSync(temporary, resultFile);
                }
                const latest = this.service.get(id), merged = mergeSceneSource(latest.draft.director!, work, raw);
                if (latest.draft.director?.workflow.sceneWorks?.[workId]?.status === "paused") return;
                if (!merged.director) { this.update(id, workId, { status: "awaiting_review", cursor: merged.result.cursor, agentTurnId: undefined, recoveryPending: false, error: merged.result.unresolved.join("；") || "源稿尚未完成" }); return; }
                this.service.edit(id, { operationId: `scene-merge:${workId}:${compilationHash(raw)}`, expectedRevision: latest.revision, ops: [{ type: "set_director_production", director: merged.director }] });
                const fresh = this.service.get(id);
                if (this.runner) {
                    const projection = compilationScopeInput(fresh.draft.director!, { sceneId: work.sceneId });
                    const targets = [
                        ...rows(projection.director.source.asset_plan).filter(item => item.canvas_scope !== "shared").map(item => `asset:${objectId(item)}`),
                        ...rows(projection.director.source.segments).map(item => `segment:${objectId(item)}`),
                    ];
                    if (targets.length) this.runner.prepareTargets(id, fresh.revision, targets, `scene-layout:${workId}:${fresh.draft.director!.sourceHash}`);
                }
                const prepared = this.service.get(id);
                this.update(id, workId, { stage: "assets", status: "pending", recoveryPending: false, sourceHash: prepared.draft.director!.sourceHash, inputHash: compilationScopeInput(prepared.draft.director!, { sceneId: work.sceneId }).inputHash });
            }
            await this.continueProduction(id, workId);
        } catch (error) {
            const state = this.service.get(id).draft.director?.workflow.sceneWorks?.[workId];
            const failedMedia = state?.runIds.some(runId => this.service.getBatch(id, runId)?.status === "failed");
            this.update(id, workId, { status: failedMedia ? "failed" : "blocked", error: error instanceof Error ? error.message : String(error) });
        }
        finally {
            this.active.delete(activeId);
            if (this.service.get(id).draft.director?.workflow.sceneWorks?.[workId]?.status === "pending") queueMicrotask(() => { void this.advance(id, workId); });
        }
    }
    private async continueProduction(id: string, workId: string) {
        let current = this.service.get(id), work = current.draft.director!.workflow.sceneWorks![workId];
        if (work.status === "paused") return;
        if (work.stage === "assets" || work.stage === "compile") {
            const operationId = `scene-compile:${workId}:${work.stage}:${compilationScopeInput(current.draft.director!, { sceneId: work.sceneId }).inputHash}`;
            if (work.compilationId !== operationId) {
                const segmentIds = rows(compilationScopeInput(current.draft.director!, { sceneId: work.sceneId }).director.source.segments).map(objectId);
                if ((current.draft.director!.source.ledger as any)?.contract_version === 2 && segmentIds.length) {
                    this.service.checkContinuity(id, { operationId: `scene-continuity:${workId}:${current.draft.director!.sourceHash}`, expectedRevision: current.revision, targetIds: segmentIds, snapshot: "draft" });
                    current = this.service.get(id);
                }
                this.compilations.enqueue(id, this.owner, operationId, current.revision, undefined, { sceneId: work.sceneId });
                this.update(id, workId, { compilationId: operationId, status: "awaiting_media" });
            }
            const job = this.compilations.getCompilation(id, this.owner, operationId);
            if (["queued", "running"].includes(job.status)) return;
            if (job.status !== "succeeded" || !job.preparedId) throw new Error(`编译 ${job.status}，请按诊断修改源稿`);
            this.compilations.apply(id, this.owner, job.preparedId);
            current = this.service.get(id); work = current.draft.director!.workflow.sceneWorks![workId];
            this.service.publish(id, { operationId: `scene-publish:${operationId}`, expectedRevision: current.revision, stage: "director", scope: { sceneId: work.sceneId } });
            this.update(id, workId, { stage: work.stage === "assets" ? "review" : "produce", status: "pending", artifactIds: this.service.get(id).draft.director!.artifacts.filter(item => compilationScopeInput(this.service.get(id).draft.director!, { sceneId: work.sceneId }).targetIds.includes(item.targetId)).map(item => item.id) });
        }
        current = this.service.get(id); work = current.draft.director!.workflow.sceneWorks![workId];
        const projection = compilationScopeInput(current.draft.director!, { sceneId: work.sceneId });
        const allowed = new Set(projection.targetIds);
        const shotIds = new Set(rows(projection.director.source.shots).map(objectId));
        const ready = this.service.workflowReadiness(id, "published");
        const targets = ready.targets.filter(item => item.status === "ready" && (work.stage === "produce" ? item.kind === "segment" && allowed.has(item.targetId) : item.kind !== "segment" && (allowed.has(item.targetId) || shotIds.has(item.targetId))));
        if (targets.length && work.generationAuthorized && this.runner) {
            const runIds = [...work.runIds];
            const claimed = new Set(runIds.flatMap(runId => this.service.getBatch(id, runId)?.targets || []));
            for (const target of targets) {
                if (this.service.get(id).draft.director?.workflow.sceneWorks?.[workId]?.status === "paused") return;
                if (claimed.has(target.id)) continue;
                if (target.kind === "segment") {
                    const predecessor = current.draft.director!.boundaries.find(item => item.to === target.targetId && item.tailFrame && !item.motionContext);
                    if (predecessor && ready.targets.find(item => item.id === `segment:${predecessor.from}`)?.status !== "complete") continue;
                }
                const runId = `scene-run:${workId}:${compilationHash({ target: target.id, hash: compilationScopeInput(current.published!.director!, { targetIds: [target.targetId] }).inputHash }).slice(0, 24)}`;
                if (runIds.includes(runId)) continue;
                const fresh = this.service.get(id);
                this.runner.prepareTargets(id, fresh.revision, [target.id], `scene-prepare:${runId}`);
                const prepared = this.service.get(id);
                const batch = this.service.startBatch(id, { runId, idempotencyKey: runId, expectedRevision: prepared.revision, version: prepared.publishedVersion, targets: [target.id], scope: "selected" });
                for (const targetId of batch.targets) claimed.add(targetId);
                runIds.push(runId); this.update(id, workId, { runIds, status: "awaiting_media" });
                void this.runner.runBatch(id, runId);
            }
            if (runIds.length > work.runIds.length) return;
        }
        const batches = work.runIds.map(runId => this.service.getBatch(id, runId)).filter(Boolean);
        if (batches.some(batch => batch!.status === "failed")) throw new Error("场次媒体任务失败；保留其他成果，须显式返修");
        if (batches.some(batch => ["pending", "running"].includes(batch!.status))) { this.update(id, workId, { status: "awaiting_media" }); return; }
        if (work.stage === "review") {
            const missing = requiredSceneAssets(projection.director, current.draft.settings.storyboardImageMode === "skip").filter(assetId => !current.draft.director!.assets[assetId]?.storageKey);
            if (missing.length) {
                const generated = projection.targetIds.filter(assetId => current.draft.director!.assets[assetId]?.status === "generated");
                if (generated.length && work.policy.scene === "automatic") await this.automaticReview(id, work, false, generated);
                else this.update(id, workId, { status: generated.length ? "awaiting_review" : work.generationAuthorized ? "awaiting_media" : "awaiting_review", error: generated.length ? "请先审核当前前置素材，批准后生成其下游" : work.generationAuthorized ? "本场素材依赖尚未就绪" : "源稿已完成；本次未授权生成媒体" });
                return;
            }
            if (work.policy.scene === "automatic") await this.automaticReview(id, work);
            else this.update(id, workId, { status: "awaiting_review", error: "等待本场开拍审核" });
        } else if (work.stage === "produce") {
            const segmentTargets = ready.targets.filter(item => item.kind === "segment" && allowed.has(item.targetId));
            if (segmentTargets.length && segmentTargets.every(item => item.status === "complete")) this.update(id, workId, { stage: "complete", status: "succeeded", inputHash: compilationScopeInput(this.service.get(id).draft.director!, { sceneId: work.sceneId }).inputHash, sourceHash: this.service.get(id).draft.director!.sourceHash, error: null });
            else this.update(id, workId, { status: "awaiting_review", error: work.generationAuthorized ? segmentTargets.flatMap(item => item.blockers).join("；") || "等待 H3 技术收口" : "H3 提示词已编译；本次未授权生成" });
        }
    }
    wake(id: string) { this.continueSharedReview(id); for (const audit of Object.values(this.service.get(id).draft.director?.workflow.sharedReviewWorks || {})) if (audit.status === "pending") void this.advanceSharedReview(id, audit.workId); for (const work of Object.values(this.service.get(id).draft.director?.workflow.sceneWorks || {})) if (["pending", "awaiting_media"].includes(work.status)) void this.advance(id, work.workId); }
    recover(id: string) {
        for (const audit of Object.values(this.service.get(id).draft.director?.workflow.sharedReviewWorks || {})) if (audit.status === "running") {
            if (fs.existsSync(this.file(audit.workId))) this.updateSharedWork(id, audit.workId, { status: "pending", recoveryPending: false });
            else {
                this.updateSharedWork(id, audit.workId, { status: "paused", recoveryPending: true, error: "共同审核回合被中断；恢复时回读原线程，不自动重跑" });
                if (this.service.get(id).draft.director!.workflow.sharedReviewContinuation) this.saveSharedContinuation(id, { status: "paused", error: "共同审核回合被中断，请核对原线程后明确恢复" });
            }
        }
        for (const work of Object.values(this.service.get(id).draft.director?.workflow.sceneWorks || {})) {
            if (work.stage === "create" && work.status === "running" && fs.existsSync(this.file(work.workId, work.cursor))) this.update(id, work.workId, { status: "pending", recoveryPending: false });
            else if (work.stage === "create" && ["running", "paused"].includes(work.status) && !fs.existsSync(this.file(work.workId, work.cursor))) this.update(id, work.workId, { status: "paused", recoveryPending: true, error: "代理回合被中断；请核对原线程后恢复，未自动重跑" });
        }
        this.wake(id);
    }
}
