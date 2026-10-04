import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
    emptyEpisodeProduction,
    episodeProductionDataSchema,
    directorRunStartSchema,
    directorModules,
    productionEditSchema,
    productionPublishSchema,
    productionPreflightRequestSchema,
    productionContractVersion,
    directorPatchFields,
    type ProductionEdit,
    type DirectorRunStart,
    type ProductionPreflight,
    type EpisodeProductionData,
    type DirectorProduction,
    type ProductionOperation,
} from "@basketikun/canvas-agent/drama/production-contract";
import { BASE_H3_NODE_METADATA, isH3NodeType } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { resolveAchengEngine } from "@basketikun/canvas-agent/skills/acheng";
import { assertAchengSource, validateAchengSource } from "@basketikun/canvas-agent/skills/acheng";
import { schemaDiagnostics, ProductionValidationError, applyDirectorSourcePatch } from "@basketikun/canvas-agent/drama/production-validation";

import { directorHash, projectDirector, validateDirectorMedia, assertDirectorEngine } from "./director.js";
import { DATA_DIR } from "../config.js";
import { resolveCanvasImageReferenceNode } from "../canvas/image-references.js";
import type { BackendDatabase } from "../db.js";
import type { BackendEventBus } from "../events.js";
import { approvedSharedAsset, listApprovedSharedAssets, prepareSharedAssetProjection, registerApprovedSharedAsset, sharedAssetHistory, sharedProjectionNodeId, validateSharedAssetSource, type ApprovedSharedAsset } from "./shared-assets.js";
import { productionCanvasContext } from "./production-canvas.js";
import type { NativeProductionTarget } from "./native-generation.js";

type Row = { revision: number; draft_json: string; published_json: string | null; published_version: number; updated_at: string };
export type ProductionImpact = { changedSceneIds: string[]; affectedShotIds: string[]; imageShotIds: string[]; clipGroupIds: string[]; missingAssetNodeIds: string[]; assetIds?: string[] };
export type ProductionRecord = { episodeId: string; revision: number; draft: EpisodeProductionData; published: EpisodeProductionData | null; publishedVersion: number; updatedAt: string };
export type ProductionRun = { episodeId: string; version: number; runId?: string; targets?: string[]; engine?: Record<string, unknown> | null; settings?: Record<string, unknown>; status: string; plan: ProductionImpact; submitted: Array<{ kind: "image" | "h3"; id: string; taskId: string; projectId?: string; nodeId?: string; segmentId?: string; status?: "running" | "succeeded" | "failed" }>; error: string | null; updatedAt: string };
export type ProductionBatch = {
    runId: string; episodeId: string; version: number; sourceRevision: number; idempotencyKey: string; status: string;
    targets: string[]; plan: ProductionImpact; engine: Record<string, unknown> | null; settings: Record<string, unknown>;
    submitted: ProductionRun["submitted"]; error: string | null; pauseRequested: boolean; createdAt: string; updatedAt: string;
};
export type DirectorReadinessTarget = { id: string; targetId: string; kind: "asset" | "keyframe" | "segment"; title: string; status: "ready" | "blocked" | "needs_review" | "complete"; blockers: string[]; artifactId?: string; executionTargets?: string[]; notice?: string };
export type DirectorPresentation = {
    key: string; workId: string; owner: { kind: "canvas" | "episode"; id: string }; aliases?: string[]; workspace: "overview" | "story" | "assets" | "shots" | "production" | "advanced";
    action: "author" | "compile" | "produce" | "review" | "deliver" | "blocked"; targetKind?: string; targetId?: string; canvasId?: string;
    nodeId?: string; segmentId?: string; runId?: string; taskId?: string; status: "ready" | "working" | "needs_review" | "blocked" | "complete"; reason?: string;
};
export type DirectorReadiness = { revision: number; publishedVersion: number; source: "draft" | "published"; targets: DirectorReadinessTarget[]; modules: Record<string, unknown>; unresolved: string[]; nextAction: string; presentation?: DirectorPresentation };

const fingerprint = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const promptHashBytes = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export class ProductionConflictError extends Error {
    constructor(readonly current: ProductionRecord) { super("制作稿版本已变化，请核对当前版本后重试"); }
}

export class EpisodeProductionService {
    constructor(private readonly db: BackendDatabase, private readonly events?: BackendEventBus, private readonly legacyDataDir = DATA_DIR, private readonly projectScope = false, private readonly checkEngine = assertDirectorEngine) {}

    private linked(projectId: string): { service: EpisodeProductionService; id: string } | null {
        if (!this.projectScope) return null;
        const row = this.db.db.prepare("SELECT id FROM drama_episodes WHERE canvas_id=?").get(projectId) as { id: string } | undefined;
        if (!row) return null;
        const standalone = this.db.db.prepare("SELECT 1 FROM canvas_productions WHERE project_id=?").get(projectId);
        if (standalone) throw new Error("画布已有独立制作记录，请先显式处理分集绑定冲突，不能覆盖任何一份制作稿");
        return { service: new EpisodeProductionService(this.db, this.events, this.legacyDataDir, false, this.checkEngine), id: row.id };
    }

    private prepare(sql: string) {
        return this.db.db.prepare(this.projectScope ? sql.replaceAll("episode_production", "canvas_production").replaceAll("episode_id", "project_id") : sql);
    }

    episodeInfo(episodeId: string): { id: string; canvasId?: string | null; fullPlot?: string | null } { const linked = this.linked(episodeId); return linked ? linked.service.episodeInfo(linked.id) : this.episode(episodeId); }
    compilationRoot() { return path.join(this.legacyDataDir, "production-compilations"); }

    registerNativeTask(id: string, taskId: string, target: NativeProductionTarget): ProductionRecord {
        const linked = this.linked(id); if (linked) return linked.service.registerNativeTask(linked.id, taskId, target);
        const current = this.get(id);
        const task = this.db.getTask(taskId);
        if (!task || task.projectId !== target.projectId || task.nodeId !== target.nodeId) throw new Error("原生任务与正式节点绑定不一致");
        return this.commit(id, `native-task:${taskId}`, current.revision, fingerprint({ taskId, target }), record => {
            this.db.db.prepare(`INSERT OR IGNORE INTO production_task_bindings
                (task_id, owner_kind, owner_id, version, source_hash, target_kind, target_id, project_id, node_id, targets_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(taskId, target.owner.kind, target.owner.id, target.version, target.sourceHash, target.kind, target.targetId, target.projectId, target.nodeId, JSON.stringify(target.targets));
            const draft = structuredClone(record.draft);
            if (draft.director?.sourceHash === target.sourceHash) {
                const prior = draft.director.workflow.currentWork;
                draft.director.workflow.currentWork = { workId: prior?.workId || `legacy:${record.episodeId}`, module: target.kind === "segment" ? "model" : "assets",
                    action: "produce", targetKind: target.kind, targetId: target.targetId, inputRevision: record.revision + 1, sourceHash: target.sourceHash, taskId };
            }
            return { ...record, draft, revision: record.revision + 1, updatedAt: new Date().toISOString() };
        });
    }

    beginPreparation(id: string, operationId: string, request: unknown): { bindings?: Record<string, unknown>[]; receipt?: ProductionRecord } {
        const ownerKey = `${this.projectScope ? "canvas" : "episode"}:${id}`;
        const hash = fingerprint(request);
        const row = this.db.db.prepare("SELECT * FROM production_preparations WHERE operation_id=?").get(operationId) as Record<string, any> | undefined;
        if (row) {
            if (row.owner_key !== ownerKey || row.request_hash !== hash) throw new Error("operationId 已用于不同的节点准备请求");
            return { ...(row.bindings_json ? { bindings: JSON.parse(row.bindings_json) } : {}), ...(row.receipt_json ? { receipt: JSON.parse(row.receipt_json) } : {}) };
        }
        this.db.db.prepare("INSERT INTO production_preparations (operation_id, owner_key, request_hash) VALUES (?, ?, ?)").run(operationId, ownerKey, hash);
        return {};
    }
    commitPreparation(id: string, operationId: string, expectedRevision: number, bindings: Record<string, unknown>[]) {
        this.db.db.prepare("UPDATE production_preparations SET bindings_json=? WHERE operation_id=?").run(JSON.stringify(bindings), operationId);
        const result = bindings.length ? this.edit(id, { operationId, expectedRevision, ops: bindings }) : this.get(id);
        this.db.db.prepare("UPDATE production_preparations SET receipt_json=? WHERE operation_id=?").run(JSON.stringify(result), operationId);
        return result;
    }

    sharedAssets(id: string): { assets: ApprovedSharedAsset[]; versions: ApprovedSharedAsset[]; updates: Record<string, unknown>[] } {
        const linked = this.linked(id); if (linked) return linked.service.sharedAssets(linked.id);
        const canvasId = this.episodeInfo(id).canvasId;
        const context = canvasId ? productionCanvasContext(this.db, canvasId) : undefined;
        return { assets: context?.dramaId ? listApprovedSharedAssets(this.db, context.dramaId) : [], versions: context?.dramaId ? sharedAssetHistory(this.db, context.dramaId) : [], updates: this.projectScope ? [] : this.db.db.prepare("SELECT id, approved_id AS approvedId, target_asset_id AS assetId, status, error FROM drama_asset_adoptions WHERE episode_id=? ORDER BY rowid DESC").all(id) };
    }

    adoptSharedAsset(id: string, input: { assetId: string; approvedId: string; expectedRevision: number; operationId: string }): ProductionRecord & { replayed?: boolean; impact?: ProductionImpact } {
        const linked = this.linked(id); if (linked) return linked.service.adoptSharedAsset(linked.id, input);
        if (this.projectScope) throw new Error("共享资产只能采用到剧目分集");
        const request = { operationId: input.operationId, expectedRevision: input.expectedRevision,
            ops: [{ type: "adopt_shared_asset", assetId: input.assetId, approvedId: input.approvedId, nodeId: sharedProjectionNodeId(id, input.assetId) }] };
        if (this.prepare("SELECT 1 FROM episode_production_operations WHERE operation_id=?").get(input.operationId)) return this.edit(id, request);
        const current = this.get(id);
        if (current.revision !== input.expectedRevision) throw new ProductionConflictError(current);
        const approved = approvedSharedAsset(this.db, input.approvedId);
        if (listApprovedSharedAssets(this.db, approved.dramaId).find(asset => asset.assetId === approved.assetId)?.id !== approved.id) throw new Error("共享资产已有更新批准版本，请回读后采用");
        const episode = this.db.getDramaEpisode(id);
        if (episode?.dramaId !== approved.dramaId || !current.draft.director || !(Array.isArray(current.draft.director.source.asset_plan) ? current.draft.director.source.asset_plan : []).some((item: any) => String(item.asset_id || item.id) === input.assetId)) throw new Error("共享资产或目标不属于当前制作");
        this.validateSource(current.draft.director, "edit");
        this.validateGraph(current.draft);
        prepareSharedAssetProjection(this.db, id, input.assetId, input.approvedId);
        return this.edit(id, request);
    }

    retrySharedUpdate(id: string, adoptionId: string, expectedRevision: number): ReturnType<EpisodeProductionService["sharedAssets"]> {
        const linked = this.linked(id); if (linked) return linked.service.retrySharedUpdate(linked.id, adoptionId, expectedRevision);
        const current = this.get(id);
        if (current.revision !== expectedRevision) throw new ProductionConflictError(current);
        const job = this.db.db.prepare("SELECT * FROM drama_asset_adoptions WHERE id=? AND episode_id=? AND status='blocked'").get(adoptionId, id) as Record<string, any> | undefined;
        if (!job) throw new Error("没有可恢复的共享资产更新");
        const installed = current.draft.director?.assets[job.target_asset_id]?.sharedSource?.approvedId === job.approved_id;
        this.db.db.prepare("UPDATE drama_asset_adoptions SET status=?, expected_revision=?, error=NULL, updated_at=? WHERE id=?")
            .run(installed ? "compiling" : "pending", expectedRevision, new Date().toISOString(), adoptionId);
        this.events?.publish({ type: "drama-production.updated", entityId: id, payload: { sharedAssetUpdate: "pending" } });
        return this.sharedAssets(id);
    }

    verifyCompilationBindings(id: string, director: DirectorProduction) {
        const canvasId = this.episodeInfo(id).canvasId;
        const rawNodes = canvasId ? this.db.getCanvasProject(canvasId)?.nodes : undefined;
        if (!Array.isArray(rawNodes)) throw new Error("Production canvas does not exist");
        const nodes = rawNodes as Array<Record<string, any>>;
        for (const asset of Object.values(director.assets)) validateSharedAssetSource(this.db, canvasId!, asset);
        const bindings = [...Object.values(director.assets), ...director.artifacts.flatMap(a => a.references)];
        for (const binding of bindings) {
            if (!binding.storageKey) continue;
            const node = nodes.find(n => n.id === binding.nodeId);
            const meta = node?.metadata as Record<string, unknown> | undefined;
            const keys = node ? [...resolveCanvasImageReferenceNode(node).map(r => r.storageKey), (node as any).storageKey, meta?.storageKey, meta?.resultStorageKey] : [];
            if (!node || !keys.includes(binding.storageKey)) throw new Error(`Compilation media is not bound to the production canvas: ${binding.nodeId}`);
            const media = this.db.getMediaFile(binding.storageKey);
            if (!media || !fs.existsSync(media.filePath) || promptHashBytes(media.filePath) !== binding.sha256) throw new Error(`Compilation reference bytes changed: ${binding.storageKey}`);
        }
    }

    compilationReferenceFile(id: string, director: DirectorProduction, targetId: string, label: string) {
        this.verifyCompilationBindings(id, director);
        if (label === "asset") return this.db.getMediaFile(director.assets[targetId]?.storageKey || "")?.filePath;
        const ref = director.artifacts.find(a => a.targetId === targetId)?.references.find(r => r.label === label);
        return ref ? this.db.getMediaFile(ref.storageKey)?.filePath : undefined;
    }

    diagnoseBindings(id: string) {
        const current = this.get(id), draft = current.draft.director, published = current.published?.director;
        const canvasId = this.episodeInfo(id).canvasId;
        const rawNodes = canvasId ? this.db.getCanvasProject(canvasId)?.nodes : undefined;
        const nodes = (Array.isArray(rawNodes) ? rawNodes : []) as Array<Record<string, any>>;
        const plans = Array.isArray(draft?.source.asset_plan) ? draft.source.asset_plan as Array<Record<string, any>> : [];
        const assetIds = [...new Set([...plans.map(p => String(p.id || p.asset_id)), ...Object.keys(draft?.assets || {}), ...Object.keys(published?.assets || {})])];
        return { revision: current.revision, publishedVersion: current.publishedVersion, canvasId, sourceHash: draft?.sourceHash, currentWork: draft?.workflow.currentWork,
            assets: assetIds.map(assetId => {
                const plan = plans.find(p => (p.id || p.asset_id) === assetId), active = draft?.assets[assetId], old = published?.assets[assetId];
                const node = nodes.find(n => n.id === active?.nodeId);
                const activeMedia = node ? resolveCanvasImageReferenceNode(node).map(r => r.storageKey) : [];
                const media = active?.storageKey ? this.db.getMediaFile(active.storageKey) : undefined;
                const actualHash = media && fs.existsSync(media.filePath) ? promptHashBytes(media.filePath) : null;
                const issues: string[] = [];
                if (active?.nodeId && !node) issues.push("MISSING_NODE");
                if (plan?.version && active && plan.version !== active.version) issues.push("SOURCE_BINDING_VERSION_MISMATCH");
                if (active?.storageKey && !activeMedia.includes(active.storageKey)) issues.push("ACTIVE_MEDIA_MISMATCH");
                if (active?.sha256 && active.sha256 !== actualHash) issues.push("MEDIA_HASH_MISMATCH");
                if (old && active && (old.nodeId !== active.nodeId || old.storageKey !== active.storageKey || old.version !== active.version)) issues.push("PUBLISHED_BINDING_DIFFERS");
                return { assetId, sourceVersion: plan?.version, sourceStatus: plan?.status, draftBinding: active, publishedBinding: old, nodeTitle: node?.title, activeStorageKeys: activeMedia, actualSha256: actualHash, issues,
                    consumers: draft?.artifacts.filter(a => a.references.some(r => r.nodeId === active?.nodeId || r.nodeId === old?.nodeId)).map(a => ({ targetId: a.targetId, references: a.references.filter(r => r.nodeId === active?.nodeId || r.nodeId === old?.nodeId) })) || [] };
            }) };
    }

    validateExecution(episodeId: string, version: number, targetIds?: string[]): void {
        const record = this.get(episodeId);
        if (record.publishedVersion !== version || !record.published?.director) throw Object.assign(new Error("Acheng 发布版本已变化"), { code: Object.values(record.draft.director?.assets || {}).some(asset => asset.sharedSource) ? "SHARED_ASSET_UPDATE" : "VERSION_CHANGED" });
        this.checkEngine(record.published.director.engine);
        const canvasId = this.episodeInfo(episodeId).canvasId;
        if (!canvasId) throw new Error("制作稿未绑定画布");
        const selected = record.published.director.artifacts.filter(item => !targetIds || targetIds.includes(item.targetId));
        const referencedNodes = new Set(selected.flatMap(item => item.references.map(reference => reference.nodeId)));
        for (const asset of Object.values(record.published.director.assets)) if (!targetIds || referencedNodes.has(asset.nodeId || "")) validateSharedAssetSource(this.db, canvasId, asset, true);
        validateDirectorMedia(this.db, canvasId, record.published.director, targetIds);
    }

    bindDirectorAsset(episodeId: string, version: number, assetId: string, storageKey: string): void {
        const linked = this.linked(episodeId); if (linked) return linked.service.bindDirectorAsset(linked.id, version, assetId, storageKey);
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.get(episodeId);
            if (current.publishedVersion !== version) {
                const snapshot = structuredClone(this.version(episodeId, version).snapshot);
                const asset = snapshot.director?.assets[assetId];
                const media = this.db.getMediaFile(storageKey);
                if (!asset?.nodeId || !media || !fs.existsSync(media.filePath) || !JSON.stringify(this.canvasNode(episodeId, asset.nodeId)).includes(storageKey)) throw new Error("历史任务媒体与原节点绑定不一致");
                snapshot.director!.assets[assetId] = { ...asset, storageKey, sha256: promptHashBytes(media.filePath), status: "generated", inputOutdated: false };
                this.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?").run(JSON.stringify(snapshot), episodeId, version);
                this.db.db.exec("COMMIT");
                this.events?.publish({ type: "drama-production.updated", entityId: episodeId, payload: { publishedVersion: current.publishedVersion, historyVersion: version } });
                return;
            }
            const existing = current.published?.director?.assets[assetId];
            if (!current.published?.director || current.publishedVersion !== version) throw new Error("资产不属于当前发布版本");
            const media = this.db.getMediaFile(storageKey);
            if (!media || !fs.existsSync(media.filePath)) throw new Error("资产媒体未归档");
            const canvasId = this.episode(episodeId).canvasId;
            const project = canvasId ? this.db.getCanvasProject(canvasId) : null;
            const nodes = (project?.nodes as Array<Record<string, any>> | undefined) || [];
            const nodeId = existing?.nodeId || String(nodes.find(item => record(item.metadata).productionAssetId === assetId)?.id || "");
            if (!nodeId) throw new Error(`资产 ${assetId} 没有画布输出节点`);
            const node = this.canvasNode(episodeId, nodeId);
            if (!JSON.stringify(node).includes(storageKey)) throw new Error("资产本轮结果未回写目标节点");
            const planEntry = (Array.isArray(current.published!.director!.source.asset_plan) ? current.published!.director!.source.asset_plan : []).map(record).find(item => String(item.asset_id || item.id || "") === assetId);
            const updated = { ...(existing || { status: "planned" as const }), nodeId, version: String(existing?.version || planEntry?.version || `v${version}`), storageKey, sha256: crypto.createHash("sha256").update(fs.readFileSync(media.filePath)).digest("hex"), status: "generated" as const, inputOutdated: false };
            current.published!.director!.assets[assetId] = updated;
            if (current.draft.director?.sourceHash === current.published!.director!.sourceHash) current.draft.director.assets[assetId] = updated;
            const updatedAt = new Date().toISOString();
            this.prepare("UPDATE episode_productions SET revision=?, draft_json=?, published_json=?, updated_at=? WHERE episode_id=?").run(current.revision + 1, JSON.stringify(current.draft), JSON.stringify(current.published), updatedAt, episodeId);
            this.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?").run(JSON.stringify(current.published), episodeId, version);
            this.db.db.exec("COMMIT");
            this.events?.publish({ type: "drama-production.updated", entityId: episodeId, payload: { revision: current.revision + 1, publishedVersion: version } });
        } catch (error) { this.db.db.exec("ROLLBACK"); throw error; }
    }

    get(episodeId: string): ProductionRecord {
        const linked = this.linked(episodeId); if (linked) return linked.service.get(linked.id);
        this.episode(episodeId);
        const row = this.prepare("SELECT * FROM episode_productions WHERE episode_id = ?").get(episodeId) as Row | undefined;
        return row ? this.fromRow(episodeId, row) : { episodeId, revision: 0, draft: emptyEpisodeProduction(), published: null, publishedVersion: 0, updatedAt: "" };
    }

    preflight(episodeId: string, raw: unknown): ProductionPreflight {
        const linked = this.linked(episodeId); if (linked) return linked.service.preflight(linked.id, raw);
        const current = this.get(episodeId);
        const diagnostics = schemaDiagnostics(productionPreflightRequestSchema, raw);
        const result: ProductionPreflight = { valid: false, contractVersion: productionContractVersion, engine: current.draft.director?.engine || null, revision: current.revision, diagnostics, generationReady: false };
        if (diagnostics.length) return result;
        const input = productionPreflightRequestSchema.parse(raw);
        if (input.request.expectedRevision !== current.revision) diagnostics.push({ code: "REVISION_CONFLICT", path: "request.expectedRevision", message: `Current revision is ${current.revision}`, severity: "error" });
        if (diagnostics.length) return result;
        let candidate = current.draft;
        try {
            if (input.action === "edit") candidate = this.editedCandidate(episodeId, current, input.request).draft;
            else if (input.action === "publish") candidate = this.publishedCandidate(current, input.request.stage);
            else { this.batchCandidate(episodeId, current, input.request); candidate = current.published!; }
            result.engine = candidate.director?.engine || null;
            if (candidate.director && this.checkEngine === assertDirectorEngine) diagnostics.push(...validateAchengSource(candidate.director, input.action === "edit" ? "edit" : input.action === "publish" ? "publish" : "generate"));
        } catch (error) {
            if (error instanceof ProductionValidationError) diagnostics.push(...error.diagnostics);
            else diagnostics.push({ code: "PRODUCTION_BLOCKED", path: "request", message: error instanceof Error ? error.message : String(error), severity: "error" });
        }
        result.valid = !diagnostics.some(item => item.severity === "error");
        result.generationReady = input.action === "generate" && result.valid && !diagnostics.some(item => item.severity === "unverified");
        return result;
    }

    private validateSource(director: NonNullable<EpisodeProductionData["director"]>, stage: "edit" | "publish" | "generate") {
        // The existing injected engine checker is also used by temporary-data tests.
        // Production instances always verify the immutable runtime.
        this.checkEngine(director.engine);
        if (this.checkEngine === assertDirectorEngine) assertAchengSource(director, stage);
    }

    workflowReadiness(episodeId: string, source: "draft" | "published" = "draft", runId?: string): DirectorReadiness {
        const current = this.get(episodeId);
        const selectedData = source === "published" ? current.published || current.draft : current.draft;
        const fallbackSettings = current.published?.settings || selectedData.settings;
        const data = { ...selectedData, settings: {
            ...fallbackSettings, ...current.draft.settings,
            imageModel: current.draft.settings.imageModel || fallbackSettings.imageModel,
            h3Model: current.draft.settings.h3Model || fallbackSettings.h3Model,
            imageModels: { ...fallbackSettings.imageModels, ...current.draft.settings.imageModels },
            h3Models: { ...fallbackSettings.h3Models, ...current.draft.settings.h3Models },
        } };
        const director = data.director;
        if (!director) {
            const owner = { kind: this.projectScope ? "canvas" as const : "episode" as const, id: episodeId };
            const canvasId = this.episodeInfo(episodeId).canvasId || (this.projectScope ? episodeId : undefined);
            const aliases = [...new Set([current.episodeId, canvasId].filter((id): id is string => Boolean(id) && id !== owner.id))];
            const workId = `legacy:${current.episodeId}`;
            const reason = "尚未接入 Acheng 制作稿；可从当前需求开始，或先只读检查旧稿";
            const presentation: DirectorPresentation = {
                key: fingerprint({ workId, workspace: "overview", action: "blocked", reason }), workId, owner,
                ...(aliases.length ? { aliases } : {}), workspace: "overview", action: "blocked", status: "blocked", reason,
                ...(canvasId ? { canvasId } : {}),
            };
            return { revision: current.revision, publishedVersion: current.publishedVersion, source, targets: [], modules: {}, unresolved: ["尚未接入 Acheng 制作稿"], nextAction: "导入 Acheng 制作稿或让导演从当前需求开始", presentation };
        }
        const objectList = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
        const idList = (value: unknown) => Array.isArray(value) ? value.map(item => typeof item === "string" ? item : String(record(item).asset_id || record(item).id || "")).filter(Boolean) : [];
        const plan = objectList(director.source.asset_plan);
        const shots = objectList(director.source.shots);
        const segments = objectList(director.source.segments);
        const knownSegmentIds = new Set(segments.map(segment => String(segment.id || "")).filter(Boolean));
        const invalidBoundaryIssues = director.boundaries.filter(boundary => !knownSegmentIds.has(boundary.from) || !knownSegmentIds.has(boundary.to)).map(boundary => `连续性边界 ${boundary.from} → ${boundary.to} 引用了尚未登记的 Segment`);
        const planById = new Map(plan.map(item => [String(item.asset_id || item.id || ""), item]));
        const keyframeAssetIds = new Set(Object.values(director.shotInputs).map(input => input.keyframeAssetId).filter((id): id is string => Boolean(id)));
        let publicationWide = source === "draft" && !current.published?.director;
        const unpublishedTargets = new Set<string>();
        const publishedDirector = current.published?.director;
        const shotById = new Map(shots.map(shot => [String(shot.id || ""), shot]));
        const markAssetTargets = (assetId: string) => {
            const keyframeShots = Object.entries(director.shotInputs).filter(([, input]) => input.keyframeAssetId === assetId).map(([shotId]) => shotId);
            if (keyframeShots.length) keyframeShots.forEach(shotId => unpublishedTargets.add(`frame:${shotId}`));
            else unpublishedTargets.add(`asset:${assetId}`);
            for (const segment of segments) {
                const shotIds = Array.isArray(segment.shot_ids) ? segment.shot_ids.map(String) : [];
                if (shotIds.some(shotId => {
                    const shot = shotById.get(shotId);
                    return director.shotInputs[shotId]?.assetIds.includes(assetId) || idList(shot?.required_assets).includes(assetId);
                })) unpublishedTargets.add(`segment:${String(segment.id || "")}`);
            }
        };
        if (source === "draft" && publishedDirector) {
            if (director.sourceHash !== publishedDirector.sourceHash || fingerprint(director.engine) !== fingerprint(publishedDirector.engine)) publicationWide = true;
            const signature = (artifact: NonNullable<DirectorProduction["artifacts"][number]> | undefined) => artifact ? {
                prompt: artifact.sha256, status: artifact.status, sourceHash: artifact.sourceHash, receipt: artifact.receipt,
                references: artifact.references.map(ref => [ref.label, ref.nodeId, ref.storageKey, ref.sha256, ref.role]),
            } : null;
            const artifactKeys = [...new Set([...director.artifacts, ...publishedDirector.artifacts].map(item => `${item.kind}:${item.targetId}`))];
            for (const key of artifactKeys) {
                const [kind, targetId] = key.split(":", 2) as ["image" | "h3", string];
                const before = publishedDirector.artifacts.find(item => item.kind === kind && item.targetId === targetId);
                const after = director.artifacts.find(item => item.kind === kind && item.targetId === targetId);
                if (fingerprint(signature(before)) === fingerprint(signature(after))) continue;
                if (kind === "h3") unpublishedTargets.add(`segment:${targetId}`);
                else markAssetTargets(targetId);
            }
            for (const id of new Set([...Object.keys(director.assets), ...Object.keys(publishedDirector.assets)])) {
                const before = publishedDirector.assets[id], after = director.assets[id];
                if (fingerprint(before) !== fingerprint(after)) markAssetTargets(id);
            }
            for (const shotId of new Set([...Object.keys(director.shotInputs), ...Object.keys(publishedDirector.shotInputs)])) {
                if (fingerprint(director.shotInputs[shotId]) === fingerprint(publishedDirector.shotInputs[shotId])) continue;
                unpublishedTargets.add(`frame:${shotId}`);
                for (const segment of segments) if (Array.isArray(segment.shot_ids) && segment.shot_ids.map(String).includes(shotId)) unpublishedTargets.add(`segment:${String(segment.id || "")}`);
            }
            const boundaries = new Map(director.boundaries.map(item => [item.from, item]));
            const publishedBoundaries = new Map(publishedDirector.boundaries.map(item => [item.from, item]));
            for (const from of new Set([...boundaries.keys(), ...publishedBoundaries.keys()])) {
                if (fingerprint(boundaries.get(from)) === fingerprint(publishedBoundaries.get(from))) continue;
                unpublishedTargets.add(`segment:${from}`);
                const to = boundaries.get(from)?.to || publishedBoundaries.get(from)?.to;
                if (to) unpublishedTargets.add(`segment:${to}`);
            }
        }
        const canvasId = this.episodeInfo(episodeId).canvasId || "";
        const project = canvasId ? this.db.getCanvasProject(canvasId) : null;
        const nodes = project?.nodes as Array<Record<string, any>> | undefined;
        const moduleStates = Object.fromEntries(Object.entries(director.modules).map(([name, item]) => [name, { status: item.status, unresolved: item.unresolved, cursor: item.cursor }]));
        const groupedShotIds = new Set(segments.flatMap(segment => Array.isArray(segment.shot_ids) ? segment.shot_ids.map(String) : []));
        const ungroupedShotIssues = shots.filter(shot => shot.id && !groupedShotIds.has(String(shot.id))).map(shot => `Shot ${String(shot.id)} 尚未编入 Segment`);
        const targets: DirectorReadinessTarget[] = [];
        const addTarget = (input: Omit<DirectorReadinessTarget, "status"> & { status?: DirectorReadinessTarget["status"] }) => {
            const blockers = [...input.blockers];
            const unpublished = source === "draft" && (publicationWide || unpublishedTargets.has(input.id));
            if (unpublished) blockers.push("当前工作稿或引用映射尚未发布；先发布再生产。");
            const item = { ...input, blockers: [...new Set(blockers)], status: unpublished ? "blocked" as const : input.status || (blockers.length ? "blocked" as const : "ready" as const) };
            targets.push(item);
        };
        const artifactFor = (kind: "image" | "h3", id: string) => director.artifacts.find(item => item.kind === kind && item.targetId === id);
        const nodeModel = (nodeId: string | undefined) => {
            const node = nodeId ? nodes?.find(item => item.id === nodeId) : undefined;
            return String(record(node?.metadata).model || "");
        };
        const imageModelFor = (id: string, nodeId?: string) => data.settings.imageModels[id] || data.settings.imageModel || nodeModel(nodeId);
        const h3ModelFor = (id: string, nodeId?: string) => data.settings.h3Models[id] || data.settings.h3Model || nodeModel(nodeId);
        const compiled = (artifact: NonNullable<ReturnType<typeof artifactFor>> | undefined, id: string) => {
            const blockers: string[] = [];
            if (!artifact) blockers.push(`缺少 ${id} 的完整编译提示词`);
            else if (artifact.status !== "ready" || artifact.sourceHash !== director.sourceHash || artifact.receipt.sourceHash !== director.sourceHash || artifact.receipt.promptHash !== artifact.sha256) blockers.push(`提示词需要由固定 Acheng 引擎重新编译`);
            return blockers;
        };
        const dependencyBlockers = (ids: string[]) => [...new Set(ids)].flatMap(id => {
            const dep = director.assets[id];
            if (!dep || dep.status !== "approved" || !dep.evidence?.trim()) return [`依赖资产 ${id} 尚未审核批准`];
            return [];
        });
        const pushAsset = (id: string, title: string, blockers: string[]) => {
            const artifact = artifactFor("image", id);
            const asset = director.assets[id];
            const all = [...blockers, ...compiled(artifact, `资产 ${id}`)];
            if (!imageModelFor(id, asset?.nodeId)) all.push("缺少图片模型；请在现有模型设置中选择模型");
            if (artifact?.status === "ready" && canvasId) {
                try { validateDirectorMedia(this.db, canvasId, director, [id]); }
                catch (error) { all.push(error instanceof Error ? error.message : String(error)); }
            } else if (!canvasId) all.push("制作对象尚未关联画布");
            const status = asset?.status === "approved" ? (all.length ? "blocked" : "complete") : asset?.status === "generated" ? "needs_review" : all.length ? "blocked" : "ready";
            if (asset?.status === "generated") all.push("查看真实媒体并批准或退回后继续");
            addTarget({ id: `asset:${id}`, targetId: id, kind: "asset", title, status, blockers: [...new Set(all)], ...(artifact ? { artifactId: artifact.id } : {}) });
        };
        for (const id of [...new Set([...planById.keys(), ...Object.keys(director.assets)])]) {
            if (!id || keyframeAssetIds.has(id)) continue;
            const entry = planById.get(id);
            const deps = idList(entry?.depends_on);
            pushAsset(id, String(entry?.name || entry?.title || entry?.kind || id), dependencyBlockers(deps));
        }
        for (const shot of shots) {
            const shotId = String(shot.id || "");
            if (!shotId) continue;
            const input = director.shotInputs[shotId];
            if (!input || input.keyframePolicy === "none") continue;
            const assetId = input.keyframeAssetId || "";
            const artifact = assetId ? artifactFor("image", assetId) : undefined;
            const deps = [...(input.assetIds || []), ...idList(shot.required_assets)].filter(Boolean);
            const blockers = [...(assetId ? [] : ["关键帧未绑定 Acheng 图像资产"]), ...dependencyBlockers(deps), ...compiled(artifact, `镜头 ${shotId} 的关键帧`)];
            if (!imageModelFor(assetId || shotId, director.assets[assetId]?.nodeId || data.keyframes[shotId]?.nodeId)) blockers.push("缺少图片模型；请在现有模型设置中选择模型");
            if (!canvasId) blockers.push("制作对象尚未关联画布");
            if (artifact?.status === "ready" && canvasId) {
                try { validateDirectorMedia(this.db, canvasId, director, [assetId]); }
                catch (error) { blockers.push(error instanceof Error ? error.message : String(error)); }
            }
            const frame = data.keyframes[shotId];
            const review = data.keyframeReviews[shotId];
            const reviewed = Boolean(frame?.storageKey && review && ["approved", "auto-accepted"].includes(review.verdict) && review.sourceVersion === current.publishedVersion);
            if (input.keyframePolicy === "reuse" && !reviewed) blockers.push("复用关键帧尚未通过本版本审核");
            const rejected = Boolean(frame?.storageKey && review && ["rejected", "needs-redo"].includes(review.verdict));
            const status = reviewed ? "complete"
                : input.keyframePolicy === "reuse" ? (frame?.storageKey ? "needs_review" : "blocked")
                    : rejected ? "ready" : frame?.storageKey ? "needs_review" : blockers.length ? "blocked" : "ready";
            addTarget({ id: `frame:${shotId}`, targetId: shotId, kind: "keyframe", title: String(shot.title || shotId), status, blockers: [...new Set(blockers)], ...(rejected && input.keyframePolicy === "new" ? { notice: "关键帧已退回；再次生成会创建一个新的显式生产任务。" } : {}), ...(artifact ? { artifactId: artifact.id } : {}) });
        }
        const boundaryByFrom = new Map(director.boundaries.map(boundary => [boundary.from, boundary]));
        for (const [index, segment] of segments.entries()) {
            const segmentId = String(segment.id || "");
            if (!segmentId) continue;
            const shotIds = Array.isArray(segment.shot_ids) ? segment.shot_ids.map(String) : [];
            const artifact = artifactFor("h3", segmentId);
            const blockers = compiled(artifact, `Segment ${segmentId}`);
            const group = data.clipGroups.find(item => item.id === segmentId);
            if (!h3ModelFor(segmentId, group?.nodeId ?? undefined)) blockers.push("缺少 H3 模型；请在现有模型设置中选择模型");
            if (!shotIds.length) blockers.push("Segment 尚未编入 Shot");
            const fps = Number(director.source.fps_num || 24) / Number(director.source.fps_den || 1);
            const duration = (Number(segment.end_frame) - Number(segment.start_frame)) / fps;
            const declared = String(segment.generation_clip_duration || "").split("/").map(Number);
            const declaredSeconds = declared.length === 2 ? declared[0] / declared[1] : declared[0];
            if (!Number.isFinite(duration) || duration < 4 || duration > 15 || Math.abs(duration - declaredSeconds) > 1e-7) blockers.push("帧窗与秒数须一致，并在 4–15 秒内");
            const sourceShots = new Map(shots.map(shot => [String(shot.id), shot]));
            if (shotIds.some(id => !sourceShots.has(id))) blockers.push("Segment 引用了尚未登记的 Shot");
            const shotPositions = shotIds.map(id => shots.findIndex(shot => String(shot.id) === id));
            if (shotPositions.some(position => position < 0) || shotPositions.some((position, i) => i > 0 && position !== shotPositions[i - 1] + 1)) blockers.push("Segment 必须覆盖连续的相邻 Shot");
            const includedShots = shotIds.map(id => sourceShots.get(id)).filter((item): item is Record<string, any> => Boolean(item));
            if (includedShots.length === shotIds.length && includedShots.length && (includedShots[0].start_frame !== segment.start_frame || includedShots[includedShots.length - 1].end_frame !== segment.end_frame || includedShots.some((shot, i) => i > 0 && shot.start_frame !== includedShots[i - 1].end_frame))) blockers.push("Segment 帧窗未覆盖 Shot 的连续边界");
            const requiredAssets = shotIds.flatMap(id => {
                const shot = sourceShots.get(id);
                const input = director.shotInputs[id];
                return [...(input?.assetIds || []), ...idList(shot?.required_assets)].filter(Boolean);
            });
            blockers.push(...dependencyBlockers(requiredAssets));
            for (const shotId of shotIds) {
                const input = director.shotInputs[shotId];
                if (!input) blockers.push(`Shot ${shotId} 缺少参考与关键帧映射`);
                else if (input.keyframePolicy !== "none") {
                    const frame = data.keyframes[shotId];
                    const review = data.keyframeReviews[shotId];
                    if (!frame?.storageKey) blockers.push(`Shot ${shotId} 的关键帧尚未生成或绑定`);
                    else if (!review || !["approved", "auto-accepted"].includes(review.verdict) || review.sourceVersion !== current.publishedVersion) blockers.push(`Shot ${shotId} 的关键帧尚未通过本版本审核`);
                }
            }
            const outgoingBoundaries = director.boundaries.filter(boundary => boundary.from === segmentId);
            const outgoingBoundary = boundaryByFrom.get(segmentId);
            if (index < segments.length - 1 && !outgoingBoundaries.length) blockers.push(`缺少 ${segmentId} → ${String(segments[index + 1].id)} 的连续性决定`);
            else if (index < segments.length - 1 && outgoingBoundaries.length > 1) blockers.push(`Segment ${segmentId} 有重复连续性边界；请合并为一个决定`);
            else if (index < segments.length - 1 && outgoingBoundary?.to !== String(segments[index + 1].id)) blockers.push(`已有边界 ${segmentId} → ${outgoingBoundary?.to} 不再连接相邻 Segment；请重新决定连续性`);
            else if (index < segments.length - 1 && !outgoingBoundary?.reason.trim()) blockers.push(`边界 ${segmentId} → ${String(segments[index + 1].id)} 缺少理由`);
            else if (index === segments.length - 1 && outgoingBoundaries.length) blockers.push(`最后一个 Segment ${segmentId} 仍有多余连续性边界；请重新决定`);
            if (!canvasId) blockers.push("制作对象尚未关联画布");
            if (artifact?.status === "ready" && canvasId) {
                try { validateDirectorMedia(this.db, canvasId, director, [segmentId]); }
                catch (error) { blockers.push(error instanceof Error ? error.message : String(error)); }
            }
            let chainStart = index, chainEnd = index;
            while (chainStart > 0 && boundaryByFrom.get(String(segments[chainStart - 1].id))?.motionContext) chainStart--;
            while (chainEnd < segments.length - 1 && boundaryByFrom.get(String(segments[chainEnd].id))?.motionContext) chainEnd++;
            const executionTargets = segments.slice(chainStart, chainEnd + 1).map(item => `segment:${String(item.id)}`);
            const hasMotionChain = chainEnd > chainStart;
            addTarget({ id: `segment:${segmentId}`, targetId: segmentId, kind: "segment", title: segmentId, status: blockers.length ? "blocked" : "ready", blockers: [...new Set(blockers)],
                ...(artifact ? { artifactId: artifact.id } : {}), ...(hasMotionChain ? { executionTargets, notice: `Motion Context 使用同一连续组运行；本次范围从 ${String(segments[chainStart].id)} 到 ${String(segments[chainEnd].id)}。如果没有可复用 latent，将从组首段重新运行。` } : {}) });
        }
        let engineError = "";
        for (const item of targets) {
            const assetId = item.kind === "keyframe" ? director.shotInputs[item.targetId]?.keyframeAssetId : item.targetId;
            const asset = assetId ? director.assets[assetId] : undefined;
            if (asset?.inputOutdated && ["approved", "generated"].includes(asset.status)) { item.status = "needs_review"; item.notice = "已有媒体来自旧共享输入；保留原结果，明确批准或返修后继续"; }
            if (item.kind === "segment" && data.clipGroups.find(group => group.id === item.targetId)?.inputOutdated) item.notice = "已有成片对应旧共享输入；更新引用不会自动重新生成";
        }
        try { this.checkEngine(director.engine); } catch (error) { engineError = error instanceof Error ? error.message : String(error); }
        if (engineError) for (const item of targets.filter(target => target.status === "ready")) { item.status = "blocked"; item.blockers.push(engineError); }
        const blockedModules = Object.values(director.modules).flatMap(item => item.unresolved);
        const next = targets.find(item => item.status === "ready") || targets.find(item => item.status === "needs_review") || targets.find(item => item.status === "blocked");
        const nextAction = next ? next.status === "ready" ? `可以推进：${next.title}` : next.status === "needs_review" ? `待审核：${next.title}` : `先补齐：${next.blockers[0]}` : blockedModules[0] || "等待 Acheng 继续完善制作稿";
        const presentation = this.directorPresentation(episodeId, current, current.draft.director || director, targets, runId);
        return { revision: current.revision, publishedVersion: current.publishedVersion, source, targets, modules: moduleStates, unresolved: [...new Set([...director.unresolved, ...blockedModules, ...ungroupedShotIssues, ...invalidBoundaryIssues])], nextAction, ...(presentation ? { presentation } : {}) };
    }

    private directorPresentation(episodeId: string, current: ProductionRecord, director: DirectorProduction, targets: DirectorReadinessTarget[], requestedRunId?: string): DirectorPresentation | undefined {
        const owner = { kind: this.projectScope ? "canvas" as const : "episode" as const, id: episodeId };
        const canvasId = this.episodeInfo(episodeId).canvasId || undefined;
        const canonicalId = current.episodeId;
        const aliases = [...new Set([canonicalId, canvasId].filter((id): id is string => Boolean(id) && id !== owner.id))];
        const declaredWork = director.workflow.currentWork;
        let inferredReason = "";
        let work = declaredWork;
        if (!work) {
            const runs = this.listBatches(episodeId);
            const activeRun = runs.find(item => ["pending", "running", "paused", "awaiting_review"].includes(item.status));
            const incompleteModule = directorModules.find(module => {
                const state = director.modules[module];
                return state && state.status !== "committed";
            });
            const pendingDecision = director.workflow.pendingDecisions?.find(item => item.status === "pending");
            const needsReview = targets.find(item => item.status === "needs_review");
            const readyTarget = targets.find(item => item.status === "ready");
            const blockedTarget = targets.find(item => item.status === "blocked");
            const allTargetsComplete = targets.length > 0 && targets.every(item => item.status === "complete");
            const run = requestedRunId ? this.getBatch(episodeId, requestedRunId)
                : activeRun || (!incompleteModule && allTargetsComplete ? runs[0] : undefined);
            const runTarget = run?.targets.map(id => targets.find(item => item.id === id)).find((item): item is DirectorReadinessTarget => Boolean(item));
            const focusedTarget = pendingDecision ? undefined : runTarget || needsReview || readyTarget || blockedTarget;
            const targetModule = (target?: DirectorReadinessTarget): typeof directorModules[number] => target?.kind === "asset" || target?.kind === "keyframe" ? "assets" : target?.kind === "segment" ? "model" : "story";
            const module: typeof directorModules[number] = pendingDecision?.module || (run ? targetModule(runTarget) : needsReview ? targetModule(needsReview) : incompleteModule || (readyTarget ? targetModule(readyTarget) : blockedTarget ? targetModule(blockedTarget) : "story"));
            let action: NonNullable<DirectorProduction["workflow"]["currentWork"]>["action"];
            if (pendingDecision) action = "author";
            else if (run?.status === "succeeded") action = "deliver";
            else if (run?.status === "awaiting_review" || needsReview) action = "review";
            else if (run) action = "produce";
            else if (incompleteModule) {
                const state = director.modules[incompleteModule];
                action = state?.status === "blocked" ? "blocked" : "author";
                inferredReason = state?.unresolved[0] || "继续完成当前未完成的 Acheng 模块";
            } else if (readyTarget) action = "produce";
            else if (allTargetsComplete) action = "deliver";
            else action = "blocked";
            if (action === "blocked" && blockedTarget) inferredReason = blockedTarget.blockers[0] || "当前目标尚未就绪";
            const targetKind = pendingDecision?.targetKind || (focusedTarget?.kind === "asset" ? "asset" : focusedTarget?.kind === "keyframe" ? "keyframe" : focusedTarget?.kind === "segment" ? "segment" : undefined);
            const targetId = pendingDecision?.targetId || focusedTarget?.targetId;
            work = {
                workId: pendingDecision?.workId || `legacy:${current.episodeId}`, module, action,
                ...(targetKind ? { targetKind } : {}), ...(targetId ? { targetId } : {}),
                inputRevision: pendingDecision?.sourceRevision ?? current.revision, sourceHash: pendingDecision?.sourceHash || director.sourceHash,
                ...(requestedRunId || run?.runId ? { runId: requestedRunId || run!.runId } : {}),
            };
        }
        const targetKey = (kind?: string, id?: string) => {
            if (!id) return undefined;
            if (id.includes(":")) return id;
            const prefix = kind === "keyframe" ? "frame" : kind;
            return ["asset", "frame", "segment"].includes(prefix || "") ? `${prefix}:${id}` : undefined;
        };
        const keyForWork = targetKey(work.targetKind, work.targetId);
        const target = keyForWork ? targets.find(item => item.id === keyForWork) : undefined;
        let workspace: DirectorPresentation["workspace"] = work.module === "story" ? "story"
            : work.module === "assets" ? "assets"
                : ["shots", "performance", "effects"].includes(work.module) ? "shots"
                    : ["model", "continuity"].includes(work.module) ? "production" : "overview";
        let action = work.action;
        let status: DirectorPresentation["status"] = action === "blocked" ? "blocked" : "ready";
        let reason = inferredReason;
        let run = requestedRunId ? this.getBatch(episodeId, requestedRunId) : work.runId ? this.getBatch(episodeId, work.runId) : null;
        if ((requestedRunId || work.runId) && !run) { status = "blocked"; action = "blocked"; reason = "指定的生产运行不属于当前制作对象或已不存在"; }
        if (!run && (action === "produce" || action === "review")) {
            const active = this.listBatches(episodeId).filter(item => ["pending", "running", "paused", "awaiting_review"].includes(item.status));
            const matching = keyForWork ? active.filter(item => item.targets.includes(keyForWork)) : active;
            if (matching.length === 1) run = matching[0];
        }
        if (work.inputRevision > current.revision || (work.sourceHash && work.sourceHash !== director.sourceHash)) {
            status = "blocked"; action = "blocked"; reason = "制作源稿已变化；请让固定 Acheng 引擎重新检查当前目标";
        } else if (keyForWork && ["asset", "frame", "segment"].includes(keyForWork.split(":", 1)[0]) && !target) {
            status = "blocked"; action = "blocked"; reason = `目标 ${keyForWork} 已不存在于当前正式制作稿`;
        }
        let targetKind = work.targetKind;
        let targetId = work.targetId;
        let nodeId: string | undefined;
        let segmentId: string | undefined;
        let taskId: string | undefined;
        const matchesWork = (item: ProductionRun["submitted"][number]) => !declaredWork?.targetId || item.id === declaredWork.targetId || `${item.kind === "h3" ? "segment" : "asset"}:${item.id}` === keyForWork || `frame:${item.id}` === keyForWork;
        if (target?.status === "needs_review") { workspace = target.kind === "segment" ? "production" : "assets"; action = "review"; status = "needs_review"; reason = target.blockers[0] || target.notice || "查看真实媒体并完成审核"; }
        if (run && status !== "blocked") {
            if (run.status === "awaiting_review") {
                const reviewTarget = run.targets.map(id => targets.find(item => item.id === id)).find(item => item?.status === "needs_review" && (!declaredWork?.targetId || item.id === keyForWork));
                const imageTask = [...run.submitted].reverse().find(item => item.kind === "image" && matchesWork(item) && (!reviewTarget || item.id === reviewTarget.targetId));
                if (reviewTarget || imageTask) {
                    workspace = "assets"; action = "review"; status = "needs_review";
                    targetKind = reviewTarget?.kind === "keyframe" ? "keyframe" : "asset";
                    targetId = reviewTarget?.targetId || imageTask?.id;
                    nodeId = imageTask?.nodeId || (targetKind === "keyframe" ? current.draft.keyframes[targetId || ""]?.nodeId : director.assets[targetId || ""]?.nodeId);
                    taskId = imageTask?.taskId;
                    reason = run.error || reviewTarget?.blockers[0] || "生成的图片等待查看与批准";
                } else { workspace = "production"; action = "compile"; status = "blocked"; reason = run.error || "运行等待制作源稿继续编译"; }
            } else if (run.status === "succeeded") {
                const completed = [...run.submitted].reverse().find(item => item.kind === "h3" && matchesWork(item));
                workspace = "production"; action = "deliver"; status = "complete"; targetKind = completed ? "segment" : targetKind;
                targetId = completed?.id || targetId; nodeId = completed?.nodeId; segmentId = completed?.segmentId;
                taskId = completed?.taskId;
                reason = "生产运行已完成；查看归档媒体和任务回执";
            } else if (run.status === "failed" || run.status === "paused") {
                workspace = run.targets.some(id => id.startsWith("asset:") || id.startsWith("frame:")) ? "assets" : "production";
                action = "blocked"; status = "blocked"; reason = run.error || (run.status === "paused" ? "生产已暂停，可恢复原 runId" : "生产运行失败，可检查原因并明确重试");
            } else {
                const runningTask = run.submitted.find(item => item.status === "running" && matchesWork(item));
                const mostRecentTaskId = run.submitted.at(-1)?.taskId;
                const currentContinuityGroup = mostRecentTaskId ? run.submitted.find(item => item.taskId === mostRecentTaskId) : undefined;
                const activeTask = runningTask || (declaredWork?.targetId ? run.submitted.find(matchesWork) : currentContinuityGroup || run.submitted.at(-1));
                action = "produce"; status = "working"; reason = "正在生产已授权目标";
                if (activeTask?.projectId && activeTask.nodeId) {
                    workspace = "production"; targetId = activeTask.id; targetKind = activeTask.kind === "h3" ? "segment" : targets.find(item => item.targetId === activeTask.id)?.kind === "keyframe" ? "keyframe" : "asset";
                    nodeId = activeTask.nodeId; segmentId = activeTask.segmentId;
                    taskId = activeTask.taskId;
                } else workspace = "production";
            }
        }
        if (!nodeId && targetId) {
            if (targetKind === "asset") nodeId = director.assets[targetId]?.nodeId;
            if (targetKind === "keyframe" || targetKind === "shot") nodeId = current.draft.keyframes[targetId]?.nodeId || director.assets[director.shotInputs[targetId]?.keyframeAssetId || ""]?.nodeId;
            const group = current.draft.clipGroups.find(item => targetKind === "segment" ? item.id === targetId : targetKind === "shot" && item.shotIds.includes(targetId!));
            if (!nodeId && group) { nodeId = group.nodeId || undefined; segmentId = group.segmentId || undefined; }
        }
        if (work.taskId && work.action === "produce" && status !== "blocked" && !director.workflow.pendingDecisions?.some(decision => decision.workId === work.workId && decision.status === "pending")) {
            const native = this.db.db.prepare("SELECT * FROM production_task_bindings WHERE task_id=? AND owner_kind=? AND owner_id=?").get(work.taskId, this.projectScope ? "canvas" : "episode", episodeId) as Record<string, any> | undefined;
            const task = native && this.db.getTask(work.taskId);
            if (native && task) {
                taskId = task.id; nodeId = native.node_id;
                targetKind = native.target_kind; targetId = native.target_id;
                const nativeTargets = JSON.parse(native.targets_json) as Array<{ targetId: string; segmentId?: string }>;
                segmentId = nativeTargets.find(item => item.targetId === native.target_id)?.segmentId;
                if (native.target_kind === "segment") {
                    const node = (this.db.getCanvasProject(native.project_id)?.nodes as Record<string, any>[] || []).find(node => node.id === native.node_id);
                    const active = (node?.metadata?.segments as Record<string, any>[] || []).find(clip => (clip.parentTaskId === task.id || clip.runtimeTaskId === task.id) && ["loading", "running"].includes(String(clip.status)));
                    const activeTarget = active && nativeTargets.find(target => target.segmentId === active.id);
                    if (activeTarget) { targetId = activeTarget.targetId; segmentId = activeTarget.segmentId; }
                }
                workspace = native.target_kind === "segment" ? "production" : "assets";
                if (native.status === "failed" || native.status === "superseded" || ["failed", "cancelled"].includes(task.status)) { status = "blocked"; action = "blocked"; reason = native.error || task.error || "原生任务已停止，原媒体与回执保留"; }
                else if (task.status === "succeeded" && native.status === "bound") {
                    status = native.target_kind === "segment" ? "complete" : targets.find(target => target.targetId === native.target_id)?.status === "complete" ? "complete" : "needs_review";
                    action = status === "needs_review" ? "review" : "deliver"; reason = status === "needs_review" ? "原生图片已归档并绑定，等待查看与批准" : "查看本轮任务的真实归档结果";
                } else { status = "working"; action = "produce"; reason = "正在生产已授权的原生节点目标"; }
            }
        }
        const key = fingerprint({ workId: work.workId, action, workspace, targetKind, targetId, runId: run?.runId, nodeId, segmentId, taskId, status });
        return { key, workId: work.workId, owner, ...(aliases.length ? { aliases } : {}), workspace, action, ...(targetKind ? { targetKind } : {}), ...(targetId ? { targetId } : {}), ...(canvasId ? { canvasId } : {}), ...(nodeId ? { nodeId } : {}), ...(segmentId ? { segmentId } : {}), ...(taskId ? { taskId } : {}), ...(run?.runId ? { runId: run.runId } : {}), status, ...(reason ? { reason } : {}) };
    }

    private batchCandidate(episodeId: string, current: ProductionRecord, input: DirectorRunStart) {
            if (current.revision !== input.expectedRevision) throw new ProductionConflictError(current);
            if (current.publishedVersion !== input.version || !current.published?.director) throw new Error("请先发布当前 Acheng 制作稿");
            const currentWork = current.draft.director?.workflow.currentWork;
            if (input.workId && currentWork?.workId !== input.workId) throw new Error("runId 必须关联当前正式 currentWork");
            const executionSignature = (value: NonNullable<EpisodeProductionData["director"]>) => ({
                sourceHash: value.sourceHash, engine: value.engine, artifacts: value.artifacts,
                assets: Object.fromEntries(Object.entries(value.assets).map(([id, item]) => [id, { nodeId: item.nodeId, storageKey: item.storageKey, sha256: item.sha256, version: item.version, status: item.status }])),
                shotInputs: value.shotInputs, boundaries: value.boundaries,
            });
            if (!current.draft.director || fingerprint(executionSignature(current.draft.director)) !== fingerprint(executionSignature(current.published.director))) throw new Error("制作源稿、参考映射或编译回执已变化；请先由固定 Acheng 引擎重新验证、编译并发布");
            const workflow = current.draft.director.workflow;
            const mediaMode = workflow.mediaProductionMode || "per_item";
            if (mediaMode === "prompt_only") throw new Error("当前设置为仅提示词，切换媒体生产模式后才能提交生成");
            if (mediaMode === "per_item" && input.targets.length !== 1) throw new Error("逐项生成模式每批只能选择一个生产对象");
            const ready = this.workflowReadiness(episodeId, "published");
            const targets = new Map(ready.targets.map(item => [item.id, item]));
            const expandedTargets = new Set(input.targets);
            const segmentItems = Array.isArray(current.published.director.source.segments) ? current.published.director.source.segments.map(record) : [];
            const boundaryMap = new Map(current.published.director.boundaries.map(item => [item.from, item]));
            for (const id of input.targets) {
                if (!id.startsWith("segment:")) continue;
                const segmentId = id.slice("segment:".length);
                let index = segmentItems.findIndex(item => String(item.id || "") === segmentId);
                if (index < 0) continue;
                let start = index, end = index;
                while (start > 0 && boundaryMap.get(String(segmentItems[start - 1].id))?.motionContext) start--;
                while (end < segmentItems.length - 1 && boundaryMap.get(String(segmentItems[end].id))?.motionContext) end++;
                for (const segment of segmentItems.slice(start, end + 1)) expandedTargets.add(`segment:${String(segment.id)}`);
            }
            const selectedTargets = [...expandedTargets];
            const missing = selectedTargets.filter(id => !targets.has(id));
            if (missing.length) throw new Error(`生产目标不存在：${missing.join(", ")}`);
            const selectedTargetSet = new Set(selectedTargets);
            const activeBatches = this.prepare("SELECT run_id, targets_json FROM episode_production_batches WHERE episode_id=? AND status IN ('pending','running','paused','awaiting_review')").all(episodeId) as Array<{ run_id: string; targets_json: string }>;
            const overlappingBatch = activeBatches.find(batch => JSON.parse(batch.targets_json).some((id: string) => selectedTargetSet.has(id)));
            if (overlappingBatch) throw new Error(`所选生产目标已由运行 ${overlappingBatch.run_id} 占用；请恢复或结束该运行后再启动`);
            const blocked = selectedTargets.map(id => targets.get(id)!).filter(item => item.status !== "ready");
            if (blocked.length) throw new Error(blocked.flatMap(item => item.blockers.map(blocker => `${item.title}：${blocker}`)).join("；"));
            const director = current.published.director;
            const plan: ProductionImpact = { changedSceneIds: [], affectedShotIds: [], imageShotIds: [], clipGroupIds: [], missingAssetNodeIds: [] };
            for (const id of selectedTargets) {
                const item = targets.get(id)!;
                if (item.kind === "keyframe") plan.imageShotIds.push(item.targetId);
                if (item.kind === "segment") plan.clipGroupIds.push(item.targetId);
            }
            const canvasId = this.episodeInfo(episodeId).canvasId;
            if (!canvasId) throw new Error("制作对象尚未关联画布");
            const artifactTargets = selectedTargets.flatMap(id => {
                const target = targets.get(id)!;
                if (target.kind === "keyframe") return director.shotInputs[target.targetId]?.keyframeAssetId ? [director.shotInputs[target.targetId].keyframeAssetId!] : [];
                return [target.targetId];
            });
            this.validateSource(director, "generate");
            validateDirectorMedia(this.db, canvasId, director, artifactTargets);
            const runSettings = {
                ...current.published.settings, ...current.draft.settings,
                imageModel: current.draft.settings.imageModel || current.published.settings.imageModel,
                h3Model: current.draft.settings.h3Model || current.published.settings.h3Model,
                imageModels: { ...current.published.settings.imageModels, ...current.draft.settings.imageModels },
                h3Models: { ...current.published.settings.h3Models, ...current.draft.settings.h3Models },
            };
            let nextDraft: EpisodeProductionData | undefined;
            if (input.workId) {
                nextDraft = structuredClone(current.draft);
                const activeWork = nextDraft.director!.workflow.currentWork!;
                const workTarget = !activeWork.targetId ? "" : activeWork.targetId.includes(":") ? activeWork.targetId
                    : activeWork.targetKind ? `${activeWork.targetKind === "keyframe" ? "frame" : activeWork.targetKind}:${activeWork.targetId}` : "";
                if (workTarget && !selectedTargetSet.has(workTarget)) throw new Error("当前 currentWork 目标不在授权 run 范围内");
                nextDraft.director!.workflow.currentWork = { ...activeWork, inputRevision: current.revision + 1, sourceHash: nextDraft.director!.sourceHash, runId: input.runId };
            }
            return { selectedTargets, plan, workflow, runSettings, nextDraft, director };
    }

    startBatch(episodeId: string, raw: unknown): ProductionBatch {
        const linked = this.linked(episodeId); if (linked) return linked.service.startBatch(linked.id, raw);
        const input = directorRunStartSchema.parse(raw);
        const requestHash = fingerprint({ idempotencyKey: input.idempotencyKey, workId: input.workId, expectedRevision: input.expectedRevision, version: input.version, targets: input.targets, scope: input.scope });
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const prior = this.prepare("SELECT * FROM episode_production_batches WHERE episode_id=? AND idempotency_key=?").get(episodeId, input.idempotencyKey) as Record<string, any> | undefined;
            if (prior) {
                if (prior.request_hash !== requestHash) throw new Error("idempotencyKey 已用于不同生产范围");
                this.db.db.exec("COMMIT");
                return this.batchFromRow(prior);
            }
            const current = this.get(episodeId);
            this.finishRejectedBatches(episodeId, current.published);
            const { selectedTargets, plan, workflow, runSettings, nextDraft, director } = this.batchCandidate(episodeId, current, input);
            const now = new Date().toISOString();
            const productionRevision = nextDraft ? current.revision + 1 : current.revision;
            if (nextDraft) this.prepare("UPDATE episode_productions SET revision=?, draft_json=?, updated_at=? WHERE episode_id=?")
                .run(productionRevision, JSON.stringify(nextDraft), now, episodeId);
            this.prepare("INSERT INTO episode_production_batches (run_id, episode_id, idempotency_key, request_hash, version, source_revision, status, targets_json, plan_json, engine_json, settings_json, submitted_json, error, pause_requested, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, '[]', NULL, 0, ?, ?)")
                .run(input.runId, episodeId, input.idempotencyKey, requestHash, input.version, current.revision, JSON.stringify(selectedTargets), JSON.stringify(plan), JSON.stringify(director.engine), JSON.stringify({ ...runSettings, workflow: { ...workflow, runScope: input.scope, currentWorkId: input.workId } }), now, now);
            const created = this.getBatch(episodeId, input.runId);
            if (!created) throw new Error("生产批次未被当前制作对象持久化");
            this.db.db.exec("COMMIT");
            this.events?.publish({ type: "drama-production.updated", entityId: episodeId, payload: { revision: productionRevision, publishedVersion: input.version, runId: input.runId, status: created!.status } });
            return created!;
        } catch (error) { try { this.db.db.exec("ROLLBACK"); } catch { /* Preserve the original failure after a completed transaction. */ } throw error; }
    }

    getBatch(episodeId: string, runId: string): ProductionBatch | null {
        const linked = this.linked(episodeId); if (linked) return linked.service.getBatch(linked.id, runId);
        this.episode(episodeId);
        const row = this.prepare("SELECT * FROM episode_production_batches WHERE episode_id=? AND run_id=?").get(episodeId, runId) as Record<string, any> | undefined;
        return row ? this.batchFromRow(row) : null;
    }

    listBatches(episodeId: string): ProductionBatch[] {
        const linked = this.linked(episodeId); if (linked) return linked.service.listBatches(linked.id);
        this.episode(episodeId);
        return (this.prepare("SELECT * FROM episode_production_batches WHERE episode_id=? ORDER BY created_at DESC").all(episodeId) as Array<Record<string, any>>).map(row => this.batchFromRow(row));
    }

    batchForRun(episodeId: string, runId: string): ProductionRun | null {
        const batch = this.getBatch(episodeId, runId);
        return batch ? { episodeId, version: batch.version, runId, targets: batch.targets, engine: batch.engine, settings: batch.settings, status: batch.status, plan: batch.plan, submitted: batch.submitted, error: batch.error, updatedAt: batch.updatedAt } : null;
    }

    updateBatch(run: ProductionRun, patch: Partial<Pick<ProductionBatch, "status" | "error" | "pauseRequested">> = {}): void {
        const linked = this.linked(run.episodeId); if (linked) return linked.service.updateBatch({ ...run, episodeId: linked.id }, patch);
        if (!run.runId) return this.updateRun(run);
        const batch = this.getBatch(run.episodeId, run.runId);
        if (!batch) throw new Error(`找不到生产运行 ${run.runId}`);
        const status = patch.status || run.status;
        this.prepare("UPDATE episode_production_batches SET status=?, submitted_json=?, error=?, pause_requested=?, updated_at=? WHERE episode_id=? AND run_id=?")
            .run(status, JSON.stringify(run.submitted), patch.error === undefined ? run.error : patch.error, patch.pauseRequested === undefined ? Number(batch.pauseRequested) : Number(patch.pauseRequested), new Date().toISOString(), run.episodeId, run.runId);
        this.events?.publish({ type: "drama-production.updated", entityId: run.episodeId, payload: { revision: batch.sourceRevision, publishedVersion: batch.version, runId: run.runId, status } });
    }

    batchPauseRequested(episodeId: string, runId: string): boolean {
        const batch = this.getBatch(episodeId, runId);
        return !batch || batch.pauseRequested || batch.status === "paused";
    }

    pauseBatch(episodeId: string, runId: string): ProductionBatch {
        const linked = this.linked(episodeId); if (linked) return linked.service.pauseBatch(linked.id, runId);
        const batch = this.getBatch(episodeId, runId);
        if (!batch) throw new Error(`找不到生产运行 ${runId}`);
        if (["succeeded", "failed"].includes(batch.status)) throw new Error(`生产运行已结束：${batch.status}`);
        const pending = batch.status === "pending";
        this.prepare("UPDATE episode_production_batches SET status=?, pause_requested=?, updated_at=? WHERE episode_id=? AND run_id=?")
            .run(pending ? "paused" : batch.status, pending ? 0 : 1, new Date().toISOString(), episodeId, runId);
        return this.getBatch(episodeId, runId)!;
    }

    resumeBatch(episodeId: string, runId: string): ProductionBatch {
        const linked = this.linked(episodeId); if (linked) return linked.service.resumeBatch(linked.id, runId);
        const batch = this.getBatch(episodeId, runId);
        if (!batch) throw new Error(`找不到生产运行 ${runId}`);
        if (!["paused", "pending", "awaiting_review"].includes(batch.status)) throw new Error(`该生产运行不能继续：${batch.status}`);
        const currentProduction = this.get(episodeId);
        const currentDirector = currentProduction.published?.director;
        const returned = currentDirector && batch.targets.find(id => {
            if (id.startsWith("asset:")) return currentDirector.assets[id.slice("asset:".length)]?.status === "rejected";
            if (id.startsWith("frame:")) return ["rejected", "needs-redo"].includes(currentProduction.published?.keyframeReviews[id.slice("frame:".length)]?.verdict || "");
            return false;
        });
        if (returned) throw new Error(`目标 ${returned} 已被退回；请显式新建 runId 重新生成`);
        let targets = [...batch.targets];
        let plan = { ...batch.plan, imageShotIds: [...batch.plan.imageShotIds], clipGroupIds: [...batch.plan.clipGroupIds], assetIds: [...(batch.plan.assetIds || [])] };
        const workflow = record(batch.settings.workflow);
        if (workflow.runScope === "all_ready" && workflow.mediaProductionMode === "automatic") {
            const readiness = this.workflowReadiness(episodeId, "published");
            const targetMap = new Map(readiness.targets.map(item => [item.id, item]));
            const selected = new Set(targets);
            for (const item of readiness.targets) if (item.status === "ready") selected.add(item.id);
            const current = this.get(episodeId);
            const segments = Array.isArray(current.published?.director?.source.segments) ? current.published.director.source.segments.map(record) : [];
            const boundaries = new Map((current.published?.director?.boundaries || []).map(item => [item.from, item]));
            for (const id of [...selected]) {
                if (!id.startsWith("segment:")) continue;
                const index = segments.findIndex(segment => String(segment.id || "") === id.slice("segment:".length));
                if (index < 0) continue;
                let start = index, end = index;
                while (start > 0 && boundaries.get(String(segments[start - 1].id))?.motionContext) start--;
                while (end < segments.length - 1 && boundaries.get(String(segments[end].id))?.motionContext) end++;
                for (const segment of segments.slice(start, end + 1)) selected.add(`segment:${String(segment.id)}`);
            }
            targets = [...selected];
            const targetSet = new Set(targets);
            const activeBatches = this.prepare("SELECT run_id, targets_json FROM episode_production_batches WHERE episode_id=? AND run_id<>? AND status IN ('pending','running','paused','awaiting_review')").all(episodeId, runId) as Array<{ run_id: string; targets_json: string }>;
            const overlappingBatch = activeBatches.find(active => JSON.parse(active.targets_json).some((id: string) => targetSet.has(id)));
            if (overlappingBatch) throw new Error(`自动运行需要的目标已由运行 ${overlappingBatch.run_id} 占用；该批次保持待恢复状态`);
            for (const id of targets) {
                const item = targetMap.get(id);
                if (!item) continue;
                if (item.kind === "keyframe" && !plan.imageShotIds.includes(item.targetId)) plan.imageShotIds.push(item.targetId);
                if (item.kind === "segment" && !plan.clipGroupIds.includes(item.targetId)) plan.clipGroupIds.push(item.targetId);
                if (item.kind === "asset" && !plan.assetIds?.includes(item.targetId)) plan.assetIds?.push(item.targetId);
            }
        }
        this.prepare("UPDATE episode_production_batches SET status='pending', version=?, targets_json=?, plan_json=?, pause_requested=0, error=NULL, updated_at=? WHERE episode_id=? AND run_id=?")
            .run(currentProduction.publishedVersion, JSON.stringify(targets), JSON.stringify(plan), new Date().toISOString(), episodeId, runId);
        return this.getBatch(episodeId, runId)!;
    }

    pendingBatches() {
        return this.prepare("SELECT episode_id AS owner_id, run_id FROM episode_production_batches WHERE status IN ('pending','running') ORDER BY updated_at").all()
              .flatMap(row => { const item = row as { owner_id: string; run_id: string }; if (this.linked(item.owner_id)) return []; const batch = this.getBatch(item.owner_id, item.run_id); return batch ? [batch] : []; });
    }

    versions(episodeId: string): Array<{ version: number; stage: string; impact: ProductionImpact; createdAt: string }> {
        const linked = this.linked(episodeId); if (linked) return linked.service.versions(linked.id);
        this.episode(episodeId);
        return this.prepare("SELECT version, stage, impact_json, created_at FROM episode_production_versions WHERE episode_id = ? ORDER BY version DESC").all(episodeId)
            .map((row) => { const item = row as { version: number; stage: string; impact_json: string; created_at: string }; return { version: item.version, stage: item.stage, impact: JSON.parse(item.impact_json) as ProductionImpact, createdAt: item.created_at }; });
    }

    version(episodeId: string, version: number): { version: number; stage: string; snapshot: EpisodeProductionData; impact: ProductionImpact; createdAt: string } {
        const linked = this.linked(episodeId); if (linked) return linked.service.version(linked.id, version);
        this.episode(episodeId);
        const row = this.prepare("SELECT * FROM episode_production_versions WHERE episode_id = ? AND version = ?").get(episodeId, version) as { version: number; stage: string; snapshot_json: string; impact_json: string; created_at: string } | undefined;
        if (!row) throw new Error("找不到制作稿版本");
        return { version: row.version, stage: row.stage, snapshot: episodeProductionDataSchema.parse(JSON.parse(row.snapshot_json)), impact: JSON.parse(row.impact_json) as ProductionImpact, createdAt: row.created_at };
    }

    exportMarkdown(episodeId: string, stage: "script" | "shots" | "director", version?: number) {
        const current = this.get(episodeId);
        const targetVersion = version ?? current.publishedVersion;
        if (!targetVersion) throw new Error("尚无可导出的发布版本");
        const snapshot = this.version(episodeId, targetVersion).snapshot;
        if (stage === "director") return { fileName: `${episodeId}-director-v${targetVersion}.json`, markdown: JSON.stringify(snapshot.director, null, 2) };
        const lines = [`# ${stage === "script" ? "分场剧本" : "镜头表"}`, ``, `分集：${episodeId} · 制作稿 v${targetVersion}`, ``];
        if (stage === "script") snapshot.scenes.forEach((scene, index) => {
            lines.push(`## 场 ${index + 1} · ${scene.heading || scene.id}`, ``, `场次 ID：${scene.id} · ${scene.location} · ${scene.timeOfDay}`, ``);
            for (const block of scene.blocks) lines.push(block.kind === "dialogue" ? `**${block.speaker || "人物"}**（${block.id}）` : `动作（${block.id}）`, ``, block.text, ``);
        });
        else snapshot.shots.forEach((shot, index) => {
            const group = snapshot.clipGroups.find((item) => item.shotIds.includes(shot.id));
            lines.push(`## 镜 ${index + 1} · ${shot.title || shot.id}`, ``, `镜头 ID：${shot.id} · 场次 ID：${shot.sceneId} · ${shot.duration}s`, ``, `画面：${shot.visual}`, ``, `机位：${shot.camera}`, ``, `起始：${shot.openingState}`, ``, `结束：${shot.endingState}`, ``, `声音：${shot.sound}`, ``, `资产节点：${shot.assetNodeIds.join(", ") || "无"}`, ``, `关键帧策略：${shot.keyframePolicy} · 节点：${snapshot.keyframes[shot.id]?.nodeId || "未绑定"}`, ``, `Clip：${group?.nodeId || "未绑定"}/${group?.segmentId || "未绑定"}`, ``);
        });
        return { fileName: `${episodeId.replace(/[^A-Za-z0-9_-]/g, "_")}-${stage}-v${targetVersion}.md`, markdown: lines.join("\n") };
    }

    legacy(episodeId: string) {
        const episode = this.episode(episodeId);
        return (["fullPlot", "script.md", "storyboard.md"] as const).flatMap((source) => {
            const text = this.legacyText(episode, source);
            return text ? [{ source, sha256: crypto.createHash("sha256").update(text).digest("hex"), text }] : [];
        });
    }

    private editedCandidate(episodeId: string, record: ProductionRecord, input: ProductionEdit) {
            const draft = structuredClone(record.draft);
            const published = record.published ? structuredClone(record.published) : null;
            for (const [index, operation] of input.ops.entries()) {
                try {
                if (operation.type === "review_director_asset") {
                    if (!published) throw new Error("尚无可审核的发布版本");
                    this.applyDirectorAssetReview(episodeId, draft, published, operation, record.publishedVersion);
                } else this.apply(episodeId, draft, operation, record.publishedVersion);
                } catch (error) {
                    if (error instanceof ProductionValidationError) throw error;
                    throw new ProductionValidationError([{ code: "INVALID_OPERATION", path: `request.ops.${index}`, targetId: "id" in operation ? String(operation.id) : undefined, message: error instanceof Error ? error.message : String(error), severity: "error" }]);
                }
            }
            for (const operation of input.ops) if (operation.type === "set_director_workflow") {
                const director = draft.director;
                if (!director) continue;
                if (operation.patch.currentWork) {
                    if (operation.patch.currentWork.inputRevision > record.revision + 1) throw new Error("currentWork 输入 revision 晚于正式制作稿");
                    if (operation.patch.currentWork.sourceHash && operation.patch.currentWork.sourceHash !== director.sourceHash) throw new Error("currentWork 源哈希已过期；请回读正式制作稿");
                    if (operation.patch.currentWork.runId) {
                        const batch = this.getBatch(episodeId, operation.patch.currentWork.runId);
                        if (!batch) throw new Error("currentWork 绑定的 runId 不属于当前制作对象");
                        const kind = operation.patch.currentWork.targetKind === "keyframe" ? "frame" : operation.patch.currentWork.targetKind;
                        const targetId = operation.patch.currentWork.targetId || "";
                        const targetKey = targetId.includes(":") ? targetId : targetId && kind ? `${kind}:${targetId}` : "";
                        if (targetKey && !batch.targets.includes(targetKey)) throw new Error("currentWork 目标不属于所绑定的生产 runId");
                    }
                    if (operation.patch.currentWork.taskId) {
                        const binding = this.db.db.prepare("SELECT owner_kind, owner_id FROM production_task_bindings WHERE task_id=?").get(operation.patch.currentWork.taskId);
                        if (!binding || binding.owner_id !== episodeId || binding.owner_kind !== (this.projectScope ? "canvas" : "episode")) throw new Error("工作游标中的原生任务不属于当前制作对象");
                    }
                }
                if (operation.patch.pendingDecisions) for (const decision of operation.patch.pendingDecisions) {
                    if (decision.sourceHash !== director.sourceHash) throw new Error("待决定事项必须绑定当前制作源哈希");
                    if (decision.workId !== director.workflow.currentWork?.workId) throw new Error("待决定事项必须属于当前正式 workId");
                    if (decision.targetId && decision.targetKind) {
                        const collection = ({ scene: "script_scenes", asset: "asset_plan", shot: "shots", segment: "segments", keyframe: "shots", story: "script_scenes" } as const)[decision.targetKind];
                        const items = Array.isArray(director.source[collection]) ? director.source[collection] as Array<Record<string, unknown>> : [];
                        const found = items.some(item => String(item.id || item.scene_id || item.asset_id || "") === decision.targetId);
                        if (!found) throw new Error(`待决定事项目标 ${decision.targetId} 不属于当前正式制作稿`);
                    }
                }
            }
            this.validateGraph(draft);
            for (const operation of input.ops) if (operation.type === "review_keyframe") {
                const link = published?.keyframes[operation.shotId];
                if (!link || link.sourceVersion !== record.publishedVersion || fingerprint(link) !== fingerprint(draft.keyframes[operation.shotId])) throw new Error("关键帧已不是当前发布版本的媒体，不能自动通过");
                published!.keyframeReviews[operation.shotId] = draft.keyframeReviews[operation.shotId];
            }
            if (draft.director) {
                this.validateSource(draft.director, "edit");
                const projectId = this.episodeInfo(episodeId).canvasId;
                if (projectId) for (const asset of Object.values(draft.director.assets)) validateSharedAssetSource(this.db, projectId, asset);
            }
            return { draft, published };
    }

    edit(episodeId: string, raw: unknown): ProductionRecord & { replayed?: boolean; impact?: ProductionImpact } {
        const linked = this.linked(episodeId); if (linked) return linked.service.edit(linked.id, raw);
        const input = productionEditSchema.parse(raw);
        return this.commit(episodeId, input.operationId, input.expectedRevision, fingerprint(input), (record) => {
            const { draft, published } = this.editedCandidate(episodeId, record, input);
            if (this.projectScope && published?.director) for (const operation of input.ops) {
                if (operation.type === "review_director_asset" && operation.verdict === "approved") registerApprovedSharedAsset(this.db, episodeId, record.publishedVersion, operation.assetId, published.director);
            }
            for (const operation of input.ops) if (operation.type === "adopt_shared_asset") {
                this.db.db.prepare(`INSERT OR IGNORE INTO drama_asset_adoptions (id, approved_id, episode_id, target_asset_id, expected_revision, status, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'compiling', ?)`).run(input.operationId, operation.approvedId, episodeId, operation.assetId, record.revision + 1, new Date().toISOString());
                this.db.db.prepare("UPDATE drama_asset_adoptions SET status='compiling', expected_revision=?, updated_at=? WHERE id=? AND status='pending'")
                    .run(record.revision + 1, new Date().toISOString(), input.operationId);
            }
            if (published && input.ops.some(operation => operation.type === "review_director_asset" || operation.type === "review_keyframe")) this.finishRejectedBatches(episodeId, published);
            if (published && input.ops.some((operation) => operation.type === "review_keyframe" || operation.type === "review_director_asset")) this.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?").run(JSON.stringify(published), episodeId, record.publishedVersion);
            return { ...record, revision: record.revision + 1, draft, published, updatedAt: new Date().toISOString() };
        });
    }

    /** A returned result requires a new run, so a settled old run must release its targets. */
    private finishRejectedBatches(episodeId: string, published: EpisodeProductionData | null) {
        if (!published) return;
        for (const batch of this.listBatches(episodeId)) {
            if (batch.status !== "awaiting_review" || batch.submitted.some(item => !["succeeded", "failed"].includes(item.status || ""))) continue;
            const returned = batch.targets.find(target => {
                const entry = batch.submitted.find(item => target === `asset:${item.id}` || target === `frame:${item.id}`);
                if (!entry) return false;
                if (target.startsWith("asset:")) return published.director?.assets[target.slice(6)]?.status === "rejected";
                if (target.startsWith("frame:")) return ["rejected", "needs-redo"].includes(published.keyframeReviews[target.slice(6)]?.verdict || "");
                return false;
            });
            if (!returned) continue;
            this.prepare("UPDATE episode_production_batches SET status='failed', pause_requested=0, error=?, updated_at=? WHERE episode_id=? AND run_id=? AND status='awaiting_review'")
                .run(`目标 ${returned} 已被退回；旧运行已结束，请新建 runId 重新生成`, new Date().toISOString(), episodeId, batch.runId);
        }
    }

    previewImpact(episodeId: string, stage: "script" | "shots" | "director"): ProductionImpact {
        const linked = this.linked(episodeId); if (linked) return linked.service.previewImpact(linked.id, stage);
        const current = this.get(episodeId);
        return this.publicationImpact(current, this.publishedCandidate(current, stage), episodeId, stage);
    }

    publish(episodeId: string, raw: unknown): ProductionRecord & { replayed?: boolean; impact?: ProductionImpact } {
        const linked = this.linked(episodeId); if (linked) return linked.service.publish(linked.id, raw);
        const input = productionPublishSchema.parse(raw);
        return this.commit(episodeId, input.operationId, input.expectedRevision, fingerprint(input), (record) => {
            const candidate = this.publishedCandidate(record, input.stage);
            const impact = this.publicationImpact(record, candidate, episodeId, input.stage);
            const publishedVersion = record.publishedVersion + 1;
            if (input.stage === "director" && record.published?.director && candidate.director) {
                for (const [shotId, review] of Object.entries(candidate.keyframeReviews)) {
                    if (!["approved", "auto-accepted"].includes(review.verdict)) continue;
                    const priorInput = record.published.director.shotInputs[shotId];
                    const nextInput: DirectorProduction["shotInputs"][string] | undefined = candidate.director.shotInputs[shotId];
                    const assetId = nextInput?.keyframeAssetId;
                    const priorArtifact = record.published.director.artifacts.find(item => item.targetId === priorInput?.keyframeAssetId);
                    const nextArtifact = candidate.director.artifacts.find(item => item.targetId === assetId);
                    if (assetId && priorArtifact && nextArtifact && !candidate.director.assets[assetId]?.inputOutdated && priorArtifact.sha256 === nextArtifact.sha256 && fingerprint(priorArtifact.references) === fingerprint(nextArtifact.references) &&
                        fingerprint(record.published.keyframes[shotId]) === fingerprint(candidate.keyframes[shotId])) review.sourceVersion = publishedVersion;
                }
            }
            const updatedAt = new Date().toISOString();
            this.prepare("INSERT INTO episode_production_versions (episode_id, version, stage, snapshot_json, impact_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
                .run(episodeId, publishedVersion, input.stage, JSON.stringify(candidate), JSON.stringify(impact), updatedAt);
            const draft = structuredClone(record.draft);
            if (input.stage === "director") draft.keyframeReviews = structuredClone(candidate.keyframeReviews);
            if (input.stage !== "script") draft.clipGroups = candidate.clipGroups;
            return { ...record, revision: record.revision + 1, draft, published: candidate, publishedVersion, updatedAt, impact };
        });
    }

    /** Runtime outcome binding; source content stays at the published version. */
    bindRuntime(episodeId: string, version: number, input: { shotId?: string; groupId?: string; nodeId: string; segmentId?: string; storageKey?: string; completed?: boolean }): ProductionRecord {
        const linked = this.linked(episodeId); if (linked) return linked.service.bindRuntime(linked.id, version, input);
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.get(episodeId);
            if (!current.published) throw new Error("缺少发布版本");
            const historical = current.publishedVersion !== version;
            const node = this.canvasNode(episodeId, input.nodeId);
            if (input.shotId && node.type !== "image" && !(node.type === "config" && record(node.metadata).generationMode === "image")) throw new Error("运行关键帧绑定不是当前分集的图片节点");
            if (input.groupId) {
                const segments = record(node.metadata).segments;
                if (!isH3NodeType(node.type) || !Array.isArray(segments) || !segments.some((segment) => record(segment).id === input.segmentId)) throw new Error("运行 Clip 绑定不是当前分集的 H3 片段");
            }
            const snapshot = structuredClone(historical ? this.version(episodeId, version).snapshot : current.published);
            const draft = structuredClone(current.draft);
            if (input.shotId) {
                if (!snapshot.shots.some((shot) => shot.id === input.shotId)) throw new Error("镜头不在发布版本中");
                const link = { nodeId: input.nodeId, storageKey: input.storageKey || "", sourceVersion: version };
                snapshot.keyframes[input.shotId] = link;
                const assetId = snapshot.director?.shotInputs[input.shotId]?.keyframeAssetId;
                const media = input.storageKey && this.db.getMediaFile(input.storageKey);
                if (assetId && snapshot.director && media && fs.existsSync(media.filePath)) {
                    const asset = { ...snapshot.director.assets[assetId], nodeId: input.nodeId, version: snapshot.director.assets[assetId]?.version || `v${version}`, storageKey: input.storageKey!, sha256: promptHashBytes(media.filePath), status: "generated" as const, inputOutdated: false };
                    snapshot.director.assets[assetId] = asset;
                    if (!historical && draft.director) draft.director.assets[assetId] = structuredClone(asset);
                }
                if (!historical && fingerprint(draft.shots.find((shot) => shot.id === input.shotId)) === fingerprint(snapshot.shots.find((shot) => shot.id === input.shotId))) draft.keyframes[input.shotId] = link;
            }
            if (input.groupId) {
                const group = snapshot.clipGroups.find((item) => item.id === input.groupId);
                if (!group || !input.segmentId) throw new Error("Clip 映射不在发布版本中");
                group.nodeId = input.nodeId; group.segmentId = input.segmentId; group.sourceVersion = version;
                if (input.completed) group.inputOutdated = false;
                const draftGroup = draft.clipGroups.find((item) => item.id === input.groupId);
                if (!historical && draftGroup && fingerprint(draftGroup.shotIds) === fingerprint(group.shotIds)) Object.assign(draftGroup, { nodeId: input.nodeId, segmentId: input.segmentId, sourceVersion: version, ...(input.completed ? { inputOutdated: false } : {}) });
            }
            if (historical) {
                this.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?").run(JSON.stringify(snapshot), episodeId, version);
                this.db.db.exec("COMMIT");
                this.events?.publish({ type: "drama-production.updated", entityId: episodeId, payload: { publishedVersion: current.publishedVersion, historyVersion: version } });
                return current;
            }
            if (fingerprint(snapshot) === fingerprint(current.published) && fingerprint(draft) === fingerprint(current.draft)) { this.db.db.exec("COMMIT"); return current; }
            const revision = current.revision + 1;
            const updatedAt = new Date().toISOString();
            this.prepare("UPDATE episode_productions SET revision=?, draft_json=?, published_json=?, updated_at=? WHERE episode_id=?")
                .run(revision, JSON.stringify(draft), JSON.stringify(snapshot), updatedAt, episodeId);
            this.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?")
                .run(JSON.stringify(snapshot), episodeId, version);
            this.db.db.exec("COMMIT");
            this.events?.publish({ type: "drama-production.updated", entityId: episodeId, payload: { revision, publishedVersion: version } });
            return { ...current, revision, draft, published: snapshot, updatedAt };
        } catch (error) { this.db.db.exec("ROLLBACK"); throw error; }
    }

    restore(episodeId: string, version: number, operationId: string, expectedRevision: number): ProductionRecord & { replayed?: boolean } {
        const linked = this.linked(episodeId); if (linked) return linked.service.restore(linked.id, version, operationId, expectedRevision);
        return this.commit(episodeId, operationId, expectedRevision, fingerprint({ version, operationId, expectedRevision }), (record) => ({
            ...record, revision: record.revision + 1, draft: structuredClone(this.version(episodeId, version).snapshot), updatedAt: new Date().toISOString(),
        }));
    }

    private patchDirectorSource(director: NonNullable<EpisodeProductionData["director"]>, entity: keyof typeof directorPatchFields, id: string | undefined, patch: Record<string, unknown>) {
        applyDirectorSourcePatch(director, entity, id, patch);
    }

    private initializeDirector(data: EpisodeProductionData, brief: string) {
        const runtime = resolveAchengEngine();
        const source = { brief, fps_num: 24, fps_den: 1, script_scenes: [], shots: [], asset_plan: [], segments: [] };
        data.director = {
            schemaVersion: 1,
            engine: { commit: runtime.commit, patchVersion: runtime.patchVersion, runtimeId: runtime.runtimeId, version: runtime.version },
            source,
            sourceHash: directorHash(source),
            modules: Object.fromEntries(directorModules.map(module => [module, { status: "planned" as const, evidence: [], unresolved: [] }])),
            artifacts: [], assets: {}, shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [],
            workflow: { contentDeliveryMode: "auto_file_batch", mediaProductionMode: "per_item" },
        };
    }

    private regroupDirectorSegment(director: NonNullable<EpisodeProductionData["director"]>, segmentId: string, shotIds: string[], removeSegmentIds: string[]) {
        const shots = Array.isArray(director.source.shots) ? director.source.shots.map(record) : [];
        const segments = Array.isArray(director.source.segments) ? director.source.segments.map(record) : [];
        const target = segments.find(item => String(item.id || "") === segmentId);
        if (!target) throw new Error(`Segment 不存在：${segmentId}`);
        if (new Set(shotIds).size !== shotIds.length) throw new Error("Shot 编组中不能重复 ID");
        const selected = new Set(shotIds);
        const ordered = shots.filter(item => selected.has(String(item.id || "")));
        if (ordered.length !== shotIds.length) throw new Error("Shot 编组引用了尚未登记的对象");
        const positions = ordered.map(item => shots.findIndex(shot => String(shot.id || "") === String(item.id || "")));
        if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) throw new Error("Segment 必须由原镜头顺序中的相邻 Shot 组成");
        if (ordered.some((item, index) => index > 0 && Number(item.start_frame) !== Number(ordered[index - 1].end_frame))) throw new Error("Shot 帧窗不连续；请让 Acheng 重新规划边界");
        const fps = Number(director.source.fps_num || 24) / Number(director.source.fps_den || 1);
        const startFrame = Number(ordered[0].start_frame), endFrame = Number(ordered[ordered.length - 1].end_frame);
        const seconds = (endFrame - startFrame) / fps;
        if (!Number.isFinite(seconds) || seconds < 4 || seconds > 15) throw new Error("新的 Segment 必须位于 4–15 秒生成窗；不会压缩对白或动作");
        const removals = new Set(removeSegmentIds);
        if (removals.has(segmentId)) throw new Error("不能移除正在编辑的目标 Segment");
        for (const id of removals) if (!segments.some(item => String(item.id || "") === id)) throw new Error(`待合并 Segment 不存在：${id}`);
        for (const segment of segments) {
            const id = String(segment.id || "");
            if (id === segmentId || removals.has(id)) continue;
            const overlap = (Array.isArray(segment.shot_ids) ? segment.shot_ids : []).map(String).filter(id => selected.has(id));
            if (overlap.length) throw new Error(`Shot 已属于 Segment ${id}；合并时须明确移除该完整 Segment`);
        }
        for (const id of removals) {
            const removed = segments.find(item => String(item.id || "") === id)!;
            const members = (Array.isArray(removed.shot_ids) ? removed.shot_ids : []).map(String);
            if (members.some(member => !selected.has(member))) throw new Error(`Segment ${id} 仍包含未选中的 Shot；不能静默丢弃镜头`);
        }
        this.patchDirectorSource(director, "segment", segmentId, {
            shot_ids: ordered.map(item => String(item.id)), start_frame: startFrame, end_frame: endFrame,
            generation_clip_duration: seconds, execution_gate: "Reconfirm mode, references and sound after regrouping",
        });
        director.source.segments = segments.filter(item => !removals.has(String(item.id || "")));
        director.boundaries = director.boundaries.filter(item => item.from !== segmentId && item.to !== segmentId && !removals.has(item.from) && !removals.has(item.to));
        director.sourceHash = directorHash(director.source);
        director.artifacts = director.artifacts.map(artifact => ({ ...artifact, status: "stale" as const }));
        director.executionAuthorized = false;
    }

    run(episodeId: string, version: number): ProductionRun | null {
        const linked = this.linked(episodeId); if (linked) return linked.service.run(linked.id, version);
        const row = this.prepare("SELECT * FROM episode_production_runs WHERE episode_id = ? AND version = ?").get(episodeId, version) as { status: string; plan_json: string; submitted_json: string; error: string | null; updated_at: string } | undefined;
        return row ? { episodeId, version, status: row.status, plan: JSON.parse(row.plan_json) as ProductionImpact, submitted: JSON.parse(row.submitted_json) as ProductionRun["submitted"], error: row.error, updatedAt: row.updated_at } : null;
    }

    updateRun(run: ProductionRun): void {
        if (run.runId) return this.updateBatch(run);
        if (this.projectScope && this.db.getDramaEpisode(run.episodeId)) return new EpisodeProductionService(this.db, this.events, this.legacyDataDir, false, this.checkEngine).updateRun(run);
        this.prepare("UPDATE episode_production_runs SET status = ?, submitted_json = ?, error = ?, updated_at = ? WHERE episode_id = ? AND version = ?")
            .run(run.status, JSON.stringify(run.submitted), run.error, new Date().toISOString(), run.episodeId, run.version);
        this.events?.publish({ type: "drama-production.updated", entityId: run.episodeId, payload: { version: run.version, runId: run.runId, status: run.status } });
    }

    pendingRuns() {
        return this.prepare("SELECT episode_id AS owner_id, version FROM episode_production_runs WHERE status IN ('pending','running','awaiting_review') ORDER BY updated_at").all()
            .flatMap((row) => { const item = row as { owner_id: string; version: number }; const run = this.run(item.owner_id, item.version); return run ? [run] : []; });
    }

    private commit(episodeId: string, operationId: string, expectedRevision: number, requestHash: string, mutate: (record: ProductionRecord) => ProductionRecord & { impact?: ProductionImpact }) {
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const prior = this.prepare("SELECT episode_id AS owner_id, request_hash, receipt_json FROM episode_production_operations WHERE operation_id = ?").get(operationId) as { owner_id: string; request_hash: string; receipt_json: string } | undefined;
            if (prior) {
                if (prior.owner_id !== episodeId || prior.request_hash !== requestHash) throw new Error("operationId 已用于不同制作稿操作");
                this.db.db.exec("COMMIT");
                return { ...JSON.parse(prior.receipt_json) as ProductionRecord & { impact?: ProductionImpact }, replayed: true };
            }
            const current = this.get(episodeId);
            if (current.revision !== expectedRevision) throw new ProductionConflictError(current);
            const next = mutate(current);
            this.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(episode_id) DO UPDATE SET revision = excluded.revision, draft_json = excluded.draft_json, published_json = excluded.published_json, published_version = excluded.published_version, updated_at = excluded.updated_at")
                .run(episodeId, next.revision, JSON.stringify(next.draft), next.published ? JSON.stringify(next.published) : null, next.publishedVersion, next.updatedAt);
            this.prepare("INSERT INTO episode_production_operations (operation_id, episode_id, request_hash, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)")
                .run(operationId, episodeId, requestHash, JSON.stringify(next), next.updatedAt);
            this.db.db.exec("COMMIT");
            this.events?.publish({ type: "drama-production.updated", entityId: episodeId, payload: { revision: next.revision, publishedVersion: next.publishedVersion } });
            return { ...next, replayed: false };
        } catch (error) { this.db.db.exec("ROLLBACK"); throw error; }
    }

    private batchFromRow(row: Record<string, any>): ProductionBatch {
        return {
            runId: String(row.run_id), episodeId: String(row.episode_id || row.project_id), version: Number(row.version),
            sourceRevision: Number(row.source_revision), idempotencyKey: String(row.idempotency_key), status: String(row.status),
            targets: JSON.parse(String(row.targets_json)) as string[], plan: JSON.parse(String(row.plan_json)) as ProductionImpact,
            engine: row.engine_json ? JSON.parse(String(row.engine_json)) as Record<string, unknown> : null,
            settings: JSON.parse(String(row.settings_json)) as Record<string, unknown>,
            submitted: JSON.parse(String(row.submitted_json)) as ProductionRun["submitted"], error: row.error === null ? null : String(row.error),
            pauseRequested: Boolean(row.pause_requested), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
        };
    }

    private fromRow(episodeId: string, row: Row): ProductionRecord {
        return { episodeId, revision: row.revision, draft: episodeProductionDataSchema.parse(JSON.parse(row.draft_json)), published: row.published_json ? episodeProductionDataSchema.parse(JSON.parse(row.published_json)) : null, publishedVersion: row.published_version, updatedAt: row.updated_at };
    }

    private episode(episodeId: string) {
        const episode = this.projectScope
            ? (this.db.getCanvasProject(episodeId) ? { id: episodeId, canvasId: episodeId, fullPlot: "", title: "", dramaId: "", episodeNumber: 0, synopsis: "" } : null)
            : this.db.getDramaEpisode(episodeId);
        if (!episode) throw new Error("分集不存在");
        return episode;
    }

    private legacyText(episode: { canvasId?: string | null; fullPlot?: string | null }, source: "fullPlot" | "script.md" | "storyboard.md") {
        if (source === "fullPlot") return episode.fullPlot || "";
        if (!episode.canvasId) return "";
        const base = path.resolve(this.legacyDataDir, "productions");
        const directory = path.resolve(base, episode.canvasId);
        if (!directory.startsWith(`${base}${path.sep}`)) throw new Error("制作目录路径无效");
        const file = path.join(directory, source);
        return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : "";
    }

    private applyDirectorAssetReview(episodeId: string, draft: EpisodeProductionData, published: EpisodeProductionData, op: Extract<ProductionOperation, { type: "review_director_asset" }>, version: number) {
        const production = published.director;
        if (!production || version !== op.version || production.sourceHash !== op.sourceHash) throw new Error("审核目标不属于当前发布版本");
        const asset = production.assets[op.assetId];
        const frameShotId = Object.entries(production.shotInputs).find(([, input]) => input.keyframeAssetId === op.assetId)?.[0];
        const frame = frameShotId ? published.keyframes[frameShotId] : undefined;
        const expectedNodeId = frame?.nodeId || asset?.nodeId;
        const expectedStorageKey = frame?.storageKey || asset?.storageKey;
        if (!expectedNodeId || !expectedStorageKey || expectedNodeId !== op.nodeId || expectedStorageKey !== op.storageKey) throw new Error("审核媒体与该资产当前绑定版本不一致");
        const media = this.db.getMediaFile(op.storageKey);
        if (!media || !fs.existsSync(media.filePath)) throw new Error("审核媒体未归档或不可访问");
        const actualHash = crypto.createHash("sha256").update(fs.readFileSync(media.filePath)).digest("hex");
        if (actualHash !== op.sha256) throw new Error("审核媒体摘要与归档文件不一致");
        const node = this.canvasNode(episodeId, op.nodeId);
        const metadata = record(node.metadata);
        if (!["image", "character", "scene"].includes(String(node.type)) && !(node.type === "config" && metadata.generationMode === "image")) throw new Error("资产审核目标必须含有图片媒体");
        if (!JSON.stringify(node).includes(op.storageKey)) throw new Error("目标节点没有绑定待审核媒体");
        const plannedAsset = (Array.isArray(production.source.asset_plan) ? production.source.asset_plan : []).map(record).find(item => String(item.asset_id || item.id || "") === op.assetId);
        const updatedAsset = { ...(asset || { version: String(plannedAsset?.version || `v${version}`), status: "generated" as const }), nodeId: op.nodeId, storageKey: op.storageKey, sha256: actualHash, status: op.verdict, evidence: op.evidence, inputOutdated: false };
        production.assets[op.assetId] = updatedAsset;
        if (frameShotId) published.keyframeReviews[frameShotId] = { verdict: op.verdict === "approved" ? "approved" : "rejected", evidence: op.evidence, sourceVersion: version };
        if (draft.director?.sourceHash === production.sourceHash) {
            draft.director.assets[op.assetId] = structuredClone(updatedAsset);
            if (frameShotId) draft.keyframeReviews[frameShotId] = { verdict: op.verdict === "approved" ? "approved" : "rejected", evidence: op.evidence, sourceVersion: version };
        }
    }

    private apply(episodeId: string, draft: EpisodeProductionData, op: ProductionOperation, sourceVersion: number) {
        if (op.type === "adopt_shared_asset") {
            if (!draft.director) throw new Error("缺少 Acheng 制作稿");
            const approved = approvedSharedAsset(this.db, op.approvedId);
            const episode = this.db.getDramaEpisode(episodeId);
            if (this.projectScope || episode?.dramaId !== approved.dramaId) throw new Error("共享资产必须属于当前集的剧目");
            const entry = (Array.isArray(draft.director.source.asset_plan) ? draft.director.source.asset_plan : []).map(record).find(item => String(item.asset_id || item.id || "") === op.assetId);
            if (!entry) throw new Error("共享资产目标未登记到制作源稿");
            const prior = draft.director.assets[op.assetId];
            const next = { nodeId: op.nodeId, version: String(entry.version || prior?.version || approved.snapshot.version), storageKey: approved.storageKey, sha256: approved.sha256,
                status: "approved" as const, evidence: approved.evidence, sharedSource: { dramaId: approved.dramaId, assetId: approved.assetId, approvedId: approved.id, sourceProjectId: approved.sourceProjectId, sourceNodeId: approved.sourceNodeId } };
            validateSharedAssetSource(this.db, episode!.canvasId!, next);
            draft.director.assets[op.assetId] = next;
            const plans = (Array.isArray(draft.director.source.asset_plan) ? draft.director.source.asset_plan : []).map(record);
            const dependsOn = (id: string, seen = new Set<string>()): boolean => {
                if (id === op.assetId) return true;
                if (seen.has(id)) return false;
                seen.add(id);
                const plan = plans.find(item => String(item.asset_id || item.id) === id);
                return (Array.isArray(plan?.depends_on) ? plan.depends_on : []).some((dependency: unknown) => dependsOn(String(dependency), seen));
            };
            for (const [id, asset] of Object.entries(draft.director.assets)) if (id !== op.assetId && asset.storageKey && dependsOn(id)) asset.inputOutdated = true;
            for (const group of draft.clipGroups) if (group.shotIds.some(id => draft.director!.shotInputs[id]?.assetIds.some(assetId => dependsOn(assetId)))) {
                const node = (this.db.getCanvasProject(episode!.canvasId!)?.nodes as Record<string, any>[] || []).find(node => node.id === group.nodeId);
                if ((record(node?.metadata).segments as Record<string, any>[] || []).some(segment => segment.id === group.segmentId && segment.resultStorageKey)) group.inputOutdated = true;
            }
            draft.director.artifacts = draft.director.artifacts.map(item => {
                const references = item.references.map(ref => ref.nodeId === prior?.nodeId ? { ...ref, nodeId: op.nodeId, storageKey: approved.storageKey, sha256: approved.sha256 } : ref);
                const plan = (Array.isArray(draft.director!.source.asset_plan) ? draft.director!.source.asset_plan : []).map(record).find(asset => String(asset.asset_id || asset.id) === item.targetId);
                const affected = references.some(ref => ref.nodeId === op.nodeId) || (Array.isArray(plan?.depends_on) && plan.depends_on.includes(op.assetId)) ||
                    (item.kind === "h3" && draft.clipGroups.find(group => group.id === item.targetId)?.shotIds.some(id => draft.director!.shotInputs[id]?.assetIds.includes(op.assetId)));
                return affected ? { ...item, references, status: "stale" as const } : item;
            });
            return;
        }
        if (op.type === "bind_director_segment") {
            const group = draft.clipGroups.find(item => item.id === op.targetId);
            const node = this.canvasNode(episodeId, op.nodeId);
            if (!group || !isH3NodeType(String(node.type))) throw new Error("Segment 或 H3 节点不属于当前制作");
            if (!(record(node.metadata).segments as Record<string, any>[] || []).some(item => item.id === op.segmentId)) throw new Error("Clip 不属于目标 H3 节点");
            group.nodeId = op.nodeId; group.segmentId = op.segmentId;
            return;
        }
        if (op.type === "set_director_brief") {
            if (draft.director) this.patchDirectorSource(draft.director, "brief", undefined, { value: op.brief });
            else this.initializeDirector(draft, op.brief);
            projectDirector(draft);
            return;
        }
        if (op.type === "set_director_production") {
            draft.director = op.director;
            projectDirector(draft);
            return;
        }
        if (op.type === "patch_director_source") {
            if (!draft.director) throw new Error("缺少 Acheng 制作稿");
            this.patchDirectorSource(draft.director, op.entity, op.id, op.patch);
            projectDirector(draft);
            return;
        }
        if (op.type === "set_director_workflow") {
            if (!draft.director) throw new Error("缺少 Acheng 制作稿");
            draft.director.workflow = { ...draft.director.workflow, ...op.patch };
            return;
        }
        if (op.type === "bind_director_asset") {
            if (!draft.director) throw new Error("缺少 Acheng 制作稿");
            const planned = (Array.isArray(draft.director.source.asset_plan) ? draft.director.source.asset_plan : []).map(record).some(item => String(item.asset_id || item.id || "") === op.assetId);
            const isKeyframe = Object.values(draft.director.shotInputs).some(input => input.keyframeAssetId === op.assetId);
            if (!planned && !isKeyframe) throw new Error(`资产 ${op.assetId} 不属于当前 Acheng 制作稿`);
            const node = this.canvasNode(episodeId, op.nodeId);
            const metadata = record(node.metadata);
            if (!["image", "character", "scene"].includes(String(node.type)) && !(node.type === "config" && metadata.generationMode === "image")) throw new Error("资产只能绑定图片、角色或场景节点");
            const prior = draft.director.assets[op.assetId];
            if (prior?.nodeId === op.nodeId) return;
            const entry = (Array.isArray(draft.director.source.asset_plan) ? draft.director.source.asset_plan : []).map(record).find(item => String(item.asset_id || item.id || "") === op.assetId);
            const storageKey = resolveCanvasImageReferenceNode(node)[0]?.storageKey;
            const media = storageKey && this.db.getMediaFile(storageKey);
            draft.director.assets[op.assetId] = { nodeId: op.nodeId, version: String(entry?.version || prior?.version || `v${sourceVersion + 1}`), status: media ? "generated" : "planned",
                ...(media && fs.existsSync(media.filePath) ? { storageKey: storageKey!, sha256: promptHashBytes(media.filePath) } : {}) };
            return;
        }
        if (op.type === "set_director_boundary") {
            if (!draft.director) throw new Error("缺少 Acheng 制作稿");
            const segments = Array.isArray(draft.director.source.segments) ? draft.director.source.segments.map(record) : [];
            const index = segments.findIndex(item => String(item.id || "") === op.boundary.from);
            if (index < 0 || String(segments[index + 1]?.id || "") !== op.boundary.to) throw new Error("连续性边界必须连接相邻 Segment");
            draft.director.boundaries = [...draft.director.boundaries.filter(item => item.from !== op.boundary.from), op.boundary];
            draft.director.executionAuthorized = false;
            draft.director.artifacts = draft.director.artifacts.map(artifact => artifact.kind === "h3" && artifact.targetId === op.boundary.from ? { ...artifact, status: "stale" as const } : artifact);
            return;
        }
        if (op.type === "set_director_segment_group") {
            if (!draft.director) throw new Error("缺少 Acheng 制作稿");
            this.regroupDirectorSegment(draft.director, op.segmentId, op.shotIds, op.removeSegmentIds);
            projectDirector(draft);
            return;
        }
        if (op.type === "review_director_asset") throw new Error("资产审核必须经过版本和媒体绑定校验");
        if (draft.director && !["set_settings", "set_keyframe", "review_keyframe"].includes(op.type)) {
            throw new Error("Acheng 制作稿是正式源；请通过 set_director_production 修改对应源字段并重新编译，不能单独修改投影");
        }
        const shot = (id: string) => { const value = draft.shots.find((item) => item.id === id); if (!value) throw new Error(`镜头不存在：${id}`); return value; };
        if (op.type === "upsert_scene") {
            const index = draft.scenes.findIndex((item) => item.id === op.scene.id);
            if (index < 0) draft.scenes.push(op.scene); else draft.scenes[index] = op.scene;
        } else if (op.type === "delete_scene") {
            if (draft.shots.some((item) => item.sceneId === op.id)) throw new Error("场次仍有镜头，请先处理镜头");
            draft.scenes = draft.scenes.filter((item) => item.id !== op.id);
        } else if (op.type === "reorder_scenes") {
            draft.scenes = reorder(draft.scenes, op.ids);
            draft.shots = orderShotsByScene(draft);
        } else if (op.type === "upsert_script_block" || op.type === "delete_script_block" || op.type === "reorder_script_blocks") {
            const scene = draft.scenes.find((item) => item.id === op.sceneId);
            if (!scene) throw new Error("剧本块所属场次不存在");
            if (op.type === "upsert_script_block") {
                const index = scene.blocks.findIndex((item) => item.id === op.block.id);
                if (index >= 0) scene.blocks[index] = op.block;
                else if (op.beforeBlockId) {
                    const before = scene.blocks.findIndex((item) => item.id === op.beforeBlockId);
                    if (before < 0) throw new Error("插入位置的剧本块不存在");
                    scene.blocks.splice(before, 0, op.block);
                } else scene.blocks.push(op.block);
            } else if (op.type === "delete_script_block") scene.blocks = scene.blocks.filter((item) => item.id !== op.id);
            else scene.blocks = reorder(scene.blocks, op.ids);
        } else if (op.type === "upsert_shot") {
            if (!draft.scenes.some((item) => item.id === op.shot.sceneId)) throw new Error("镜头所属场次不存在");
            const index = draft.shots.findIndex((item) => item.id === op.shot.id);
            if (index < 0) draft.shots.push(op.shot); else draft.shots[index] = op.shot;
            draft.shots = orderShotsByScene(draft);
        } else if (op.type === "delete_shot") {
            draft.shots = draft.shots.filter((item) => item.id !== op.id);
            delete draft.keyframes[op.id]; delete draft.keyframeReviews[op.id];
            draft.clipGroups = draft.clipGroups.map((group) => ({ ...group, shotIds: group.shotIds.filter((id) => id !== op.id) })).filter((group) => group.shotIds.length);
        } else if (op.type === "reorder_shots") {
            const selected = draft.shots.filter((item) => item.sceneId === op.sceneId);
            const reordered = reorder(selected, op.ids);
            let cursor = 0;
            draft.shots = draft.shots.map((item) => item.sceneId === op.sceneId ? reordered[cursor++] : item);
            draft.shots = orderShotsByScene(draft);
        } else if (op.type === "set_keyframe") {
            shot(op.shotId);
            if (!op.nodeId) { delete draft.keyframes[op.shotId]; delete draft.keyframeReviews[op.shotId]; }
            else {
                const node = this.canvasNode(episodeId, op.nodeId);
                const metadata = record(node.metadata);
                if (node.type !== "image" && !(node.type === "config" && metadata.generationMode === "image")) throw new Error("关键帧必须引用图片或智能图片节点");
                const images = Array.isArray(metadata.images) ? metadata.images.map(record) : [];
                const active = images.find((item) => item.id === metadata.primaryImageId) || images.find((item) => item.storageKey);
                draft.keyframes[op.shotId] = { nodeId: op.nodeId, storageKey: String(active?.storageKey || metadata.storageKey || ""), sourceVersion };
            }
        } else if (op.type === "set_clip_group") {
            for (const id of op.group.shotIds) shot(id);
            const indices = op.group.shotIds.map((id) => draft.shots.findIndex((item) => item.id === id));
            if (indices.some((index, i) => i && index !== indices[i - 1] + 1)) throw new Error("合并 Clip 只能选择相邻镜头");
            if (op.group.nodeId && op.group.segmentId) {
                const node = this.canvasNode(episodeId, op.group.nodeId);
                const segments = Array.isArray(record(node.metadata).segments) ? record(node.metadata).segments as Array<Record<string, unknown>> : [];
                if (!isH3NodeType(node.type) || !segments.some((item) => item.id === op.group.segmentId)) throw new Error("H3 Clip 绑定不存在");
            }
            const index = draft.clipGroups.findIndex((item) => item.id === op.group.id);
            if (index < 0) draft.clipGroups.push(op.group); else draft.clipGroups[index] = op.group;
        } else if (op.type === "delete_clip_group") {
            draft.clipGroups = draft.clipGroups.filter((item) => item.id !== op.id);
        } else if (op.type === "set_settings") {
            draft.settings = { ...draft.settings, ...op.patch };
        } else if (op.type === "review_keyframe") {
            if (!draft.keyframes[op.shotId]?.storageKey) throw new Error("关键帧没有可访问媒体");
            draft.keyframeReviews[op.shotId] = { verdict: op.verdict, evidence: op.evidence, sourceVersion };
        } else if (op.type === "import_legacy") {
            const episode = this.episode(episodeId);
            const text = this.legacyText(episode, op.source);
            if (!text.trim()) throw new Error("导入来源为空");
            const sha256 = crypto.createHash("sha256").update(text).digest("hex");
            draft.legacyImports = [...draft.legacyImports.filter((item) => item.source !== op.source), { source: op.source, sha256, text, importedAt: new Date().toISOString() }];
            if (op.source !== "storyboard.md" && !draft.scenes.length) draft.scenes.push({ id: crypto.randomUUID(), heading: "导入草稿", location: "", timeOfDay: "", blocks: [{ id: crypto.randomUUID(), kind: "action", text }] });
            if (op.source === "storyboard.md" && !draft.shots.length) {
                if (!draft.scenes.length) draft.scenes.push({ id: crypto.randomUUID(), heading: "待拆场", location: "", timeOfDay: "", blocks: [] });
                draft.shots.push({ id: crypto.randomUUID(), sceneId: draft.scenes[0].id, title: "导入分镜草稿", duration: 0, visual: text, camera: "", openingState: "", endingState: "", sound: "", assetNodeIds: [], keyframePolicy: "none" });
            }
        }
    }

    private validateGraph(draft: EpisodeProductionData) {
        const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) throw new Error(`${label} ID 重复`); };
        unique(draft.scenes.map((item) => item.id), "场次");
        unique(draft.shots.map((item) => item.id), "镜头");
        unique(draft.scenes.flatMap((item) => item.blocks.map((block) => block.id)), "剧本块");
        unique(draft.clipGroups.map((item) => item.id), "Clip 映射");
        const scenes = new Set(draft.scenes.map((item) => item.id));
        for (const shot of draft.shots) if (!scenes.has(shot.sceneId)) throw new Error(`镜头 ${shot.id} 所属场次不存在`);
        const shotIds = new Set(draft.shots.map((item) => item.id));
        for (const id of Object.keys(draft.keyframes)) if (!shotIds.has(id)) throw new Error(`关键帧镜头不存在：${id}`);
        if (!draft.director) {
            unique(draft.clipGroups.flatMap((group) => group.shotIds), "Clip 所属镜头");
            for (const group of draft.clipGroups) {
                const positions = group.shotIds.map((id) => draft.shots.findIndex((shot) => shot.id === id));
                if (positions.some((position) => position < 0)) throw new Error(`Clip ${group.id} 引用了不存在的镜头`);
                if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) throw new Error(`Clip ${group.id} 的镜头已不相邻，请先重编组`);
            }
        }
    }

    private publishedCandidate(record: ProductionRecord, stage: "script" | "shots" | "director") {
        const candidate = structuredClone(record.published || emptyEpisodeProduction());
        if (stage === "director") {
            if (!record.draft.director) throw new Error("缺少 Acheng 制作稿");
            const directorCandidate = structuredClone(record.draft);
            projectDirector(directorCandidate);
            this.validateSource(directorCandidate.director!, "publish");
            this.validateGraph(directorCandidate);
            this.lockModels(record.episodeId, directorCandidate);
            return directorCandidate;
        }
        if (record.draft.director) throw new Error("Acheng 制作稿请使用 director 发布阶段");
        if (stage === "script") {
            if (!record.draft.scenes.length || record.draft.scenes.some((scene) => !scene.blocks.length)) throw new Error("剧本至少需要一个含内容的场次");
            candidate.scenes = structuredClone(record.draft.scenes);
            const validScenes = new Set(candidate.scenes.map((scene) => scene.id));
            const validShots = new Set(candidate.shots.filter((shot) => validScenes.has(shot.sceneId)).map((shot) => shot.id));
            candidate.shots = candidate.shots.filter((shot) => validShots.has(shot.id));
            candidate.clipGroups = candidate.clipGroups.map((group) => ({ ...group, shotIds: group.shotIds.filter((id) => validShots.has(id)) })).filter((group) => group.shotIds.length);
            candidate.keyframes = Object.fromEntries(Object.entries(candidate.keyframes).filter(([id]) => validShots.has(id)));
            candidate.keyframeReviews = Object.fromEntries(Object.entries(candidate.keyframeReviews).filter(([id]) => validShots.has(id)));
        } else {
            if (!record.published?.scenes.length) throw new Error("请先发布剧本");
            if (fingerprint(record.draft.scenes) !== fingerprint(record.published.scenes)) throw new Error("剧本草稿尚未发布，请先发布剧本");
            if (!record.draft.shots.length || record.draft.shots.some((shot) => shot.duration <= 0 || !shot.visual.trim())) throw new Error("镜头须有画面描述和正时长");
            candidate.shots = structuredClone(record.draft.shots);
            candidate.keyframes = structuredClone(record.draft.keyframes);
            candidate.keyframeReviews = structuredClone(record.draft.keyframeReviews);
            candidate.clipGroups = structuredClone(record.draft.clipGroups);
        }
        candidate.settings = structuredClone(record.draft.settings);
        if (stage === "shots") this.lockModels(record.episodeId, candidate);
        candidate.legacyImports = structuredClone(record.draft.legacyImports);
        return candidate;
    }

    /** Freeze the existing node/config choices for this publication, without a second settings form. */
    private lockModels(episodeId: string, candidate: EpisodeProductionData) {
        const canvasId = this.episode(episodeId).canvasId;
        const nodes = (canvasId ? this.db.getCanvasProject(canvasId)?.nodes || [] : []) as Array<Record<string, unknown>>;
        const ai = record(this.db.getSetting("ai.config"));
        const h3 = record(this.db.getSetting("plugin:minimax-h3:defaults:v1"));
        const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
        const settings = candidate.settings;
        settings.imageModels = Object.fromEntries(candidate.shots.map((shot) => {
            const target = nodes.find((node) => node.id === candidate.keyframes[shot.id]?.nodeId);
            const source = nodes.find((node) => node.type === "config" && record(node.metadata).productionShotId === shot.id);
            return [shot.id, text(settings.imageModel) || text(record(source?.metadata).model) || text(record(target?.metadata).model) || text(ai.imageModel) || text(ai.model)];
        }));
        settings.h3Models = Object.fromEntries(candidate.clipGroups.map((group) => {
            const node = nodes.find((item) => item.id === group.nodeId);
            const metadata = record(node?.metadata);
            const segment = Array.isArray(metadata.segments) ? metadata.segments.find((item) => record(item).id === group.segmentId) : null;
            return [group.id, text(settings.h3Model) || text(record(segment).modelName) || text(metadata.modelName) || text(h3.modelName) || text(BASE_H3_NODE_METADATA.modelName)];
        }));
    }

    private publicationImpact(record: ProductionRecord, candidate: EpisodeProductionData, episodeId: string, stage: "script" | "shots" | "director") {
        if (stage === "director") {
            return this.directorImpact(record.published, candidate, episodeId);
        }
        const impact = this.impact(record.published, candidate, episodeId);
        if (stage !== "shots") return impact;
        const lastShots = this.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM episode_production_versions WHERE episode_id=? AND stage='shots'").get(episodeId) as { version: number };
        const scriptImpacts = this.prepare("SELECT impact_json FROM episode_production_versions WHERE episode_id=? AND stage='script' AND version>?").all(episodeId, lastShots.version) as Array<{ impact_json: string }>;
        const scriptScenes = new Set(scriptImpacts.flatMap((item) => (JSON.parse(item.impact_json) as ProductionImpact).changedSceneIds));
        for (const shot of candidate.shots) if (scriptScenes.has(shot.sceneId) && !impact.affectedShotIds.includes(shot.id)) impact.affectedShotIds.push(shot.id);
        impact.imageShotIds = [...new Set([...impact.imageShotIds, ...candidate.shots.filter((shot) => scriptScenes.has(shot.sceneId) && shot.keyframePolicy === "new").map((shot) => shot.id)])];
        impact.clipGroupIds = candidate.clipGroups.filter((group) => group.shotIds.some((id) => impact.affectedShotIds.includes(id))).map((group) => group.id);
        impact.missingAssetNodeIds = this.missingAssets(episodeId, candidate, new Set(impact.affectedShotIds));
        return impact;
    }

    private impact(previous: EpisodeProductionData | null, next: EpisodeProductionData, episodeId: string): ProductionImpact {
        const before = previous || emptyEpisodeProduction();
        const oldScenes = new Map(before.scenes.map((scene) => [scene.id, scene]));
        const newScenes = new Map(next.scenes.map((scene) => [scene.id, scene]));
        const changedSceneIds = [...new Set([...oldScenes.keys(), ...newScenes.keys()])].filter((id) => fingerprint(oldScenes.get(id)) !== fingerprint(newScenes.get(id)));
        const oldSceneOrder = before.scenes.map((scene) => scene.id);
        next.scenes.forEach((scene, index) => { if (oldSceneOrder.indexOf(scene.id) !== index && !changedSceneIds.includes(scene.id)) changedSceneIds.push(scene.id); });
        const oldShots = new Map(before.shots.map((shot) => [shot.id, shot]));
        const affected = new Set([...new Set([...oldShots.keys(), ...next.shots.map((shot) => shot.id)])].filter((id) => {
            const shot = next.shots.find((item) => item.id === id);
            return fingerprint(oldShots.get(id)) !== fingerprint(shot) || (shot && changedSceneIds.includes(shot.sceneId));
        }));
        next.shots.forEach((shot, index) => { if (oldShots.get(shot.id)?.endingState !== shot.endingState && next.shots[index + 1]) affected.add(next.shots[index + 1].id); });
        const oldOrder = before.shots.map((shot) => shot.id);
        const newOrder = next.shots.map((shot) => shot.id);
        if (fingerprint(oldOrder) !== fingerprint(newOrder)) {
            next.shots.forEach((shot, index) => {
                if (oldOrder.indexOf(shot.id) !== index) {
                    affected.add(shot.id);
                    if (next.shots[index + 1]) affected.add(next.shots[index + 1].id);
                }
            });
        }
        const imageAffected = new Set(affected);
        const groupContent = (group: EpisodeProductionData["clipGroups"][number]) => ({ id: group.id, shotIds: group.shotIds, continuityReason: group.continuityReason || "" });
        const oldGroups = new Map(before.clipGroups.map((group) => [group.id, groupContent(group)]));
        const changedGroups = next.clipGroups.filter((group) => fingerprint(oldGroups.get(group.id)) !== fingerprint(groupContent(group)));
        for (const group of changedGroups) for (const id of group.shotIds) affected.add(id);
        return {
            changedSceneIds,
            affectedShotIds: [...affected],
            imageShotIds: next.shots.filter((shot) => imageAffected.has(shot.id) && shot.keyframePolicy === "new").map((shot) => shot.id),
            clipGroupIds: next.clipGroups.filter((group) => changedGroups.includes(group) || group.shotIds.some((id) => affected.has(id))).map((group) => group.id),
            missingAssetNodeIds: this.missingAssets(episodeId, next, affected),
            assetIds: [],
        };
    }

    private directorImpact(previous: EpisodeProductionData | null, next: EpisodeProductionData, episodeId: string): ProductionImpact {
        const before = previous?.director;
        const after = next.director;
        if (!after) return { changedSceneIds: [], affectedShotIds: [], imageShotIds: [], clipGroupIds: [], missingAssetNodeIds: [], assetIds: [] };
        const list = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
        const keyed = (value: unknown, key: (item: Record<string, any>) => string) => new Map<string, Record<string, any>>(
            list(value).flatMap(item => { const id = key(item); return id ? [[id, item] as [string, Record<string, any>]] : []; }),
        );
        const scenesBefore = keyed(before?.source.script_scenes, item => String(item.scene_id || item.id || ""));
        const scenesAfter = keyed(after.source.script_scenes, item => String(item.scene_id || item.id || ""));
        const changedSceneIds = [...new Set([...scenesBefore.keys(), ...scenesAfter.keys()])].filter(id => fingerprint(scenesBefore.get(id)) !== fingerprint(scenesAfter.get(id)));
        const assetId = (item: Record<string, any>) => String(item.asset_id || item.id || "");
        const assetBefore = keyed(before?.source.asset_plan, assetId);
        const assetAfter = keyed(after.source.asset_plan, assetId);
        const assetInputSignature = (item: Record<string, any> | undefined) => item ? Object.fromEntries(["kind", "asset_type", "description", "prompt", "depends_on", "role", "version", "reference_role"].map(field => [field, item[field]])) : null;
        const assetBinding = (director: NonNullable<EpisodeProductionData["director"]> | undefined, id: string) => {
            const item = director?.assets[id];
            return item ? { nodeId: item.nodeId, storageKey: item.storageKey, sha256: item.sha256, version: item.version } : null;
        };
        const shotBefore = keyed(before?.source.shots, item => String(item.id || ""));
        const shotAfter = keyed(after.source.shots, item => String(item.id || ""));
        const signature = (director: NonNullable<EpisodeProductionData["director"]> | undefined, kind: "image" | "h3", id: string) => {
            const artifact = director?.artifacts.find(item => item.kind === kind && item.targetId === id);
            return artifact ? { prompt: artifact.sha256, references: artifact.references.map(ref => [ref.label, ref.nodeId, ref.storageKey, ref.sha256, ref.role]) } : null;
        };
        const changedAssets = [...new Set([...assetBefore.keys(), ...assetAfter.keys(), ...Object.keys(before?.assets || {}), ...Object.keys(after.assets)])]
            .filter(id => fingerprint(assetInputSignature(assetBefore.get(id))) !== fingerprint(assetInputSignature(assetAfter.get(id)))
                || fingerprint(assetBinding(before, id)) !== fingerprint(assetBinding(after, id))
                || fingerprint(signature(before, "image", id)) !== fingerprint(signature(after, "image", id)));
        const oldShotInputs = before?.shotInputs || {};
        const changedShots = [...new Set([...shotBefore.keys(), ...shotAfter.keys()])].filter(id =>
            fingerprint(shotBefore.get(id)) !== fingerprint(shotAfter.get(id)) || fingerprint(oldShotInputs[id]) !== fingerprint(after.shotInputs[id]));
        const h3ShotFields = ["scene_id", "visual", "camera", "start_frame", "end_frame", "state_in", "state_out", "dialogues", "audio", "required_assets"];
        const changedH3Shots = [...new Set([...shotBefore.keys(), ...shotAfter.keys()])].filter(id => {
            const previousShot = shotBefore.get(id), nextShot = shotAfter.get(id);
            return h3ShotFields.some(field => fingerprint(previousShot?.[field]) !== fingerprint(nextShot?.[field]));
        });
        const frameFields = ["scene_id", "visual", "camera", "start_frame", "end_frame", "state_in", "state_out"];
        const changedFrameShots = [...new Set([...shotBefore.keys(), ...shotAfter.keys()])].filter(id => {
            const previousShot = shotBefore.get(id), nextShot = shotAfter.get(id);
            const visualInputChanged = frameFields.some(field => fingerprint(previousShot?.[field]) !== fingerprint(nextShot?.[field]));
            const previousInput = oldShotInputs[id], nextInput = after.shotInputs[id];
            const inputChanged = fingerprint(previousInput?.assetIds) !== fingerprint(nextInput?.assetIds) || fingerprint(previousInput?.keyframeAssetId) !== fingerprint(nextInput?.keyframeAssetId);
            const keyframeId = nextInput?.keyframeAssetId || previousInput?.keyframeAssetId;
            const compiledImageChanged = Boolean(keyframeId && fingerprint(signature(before, "image", keyframeId)) !== fingerprint(signature(after, "image", keyframeId)));
            return visualInputChanged || inputChanged || compiledImageChanged;
        });
        const segmentsBefore = keyed(before?.source.segments, item => String(item.id || ""));
        const segmentsAfter = keyed(after.source.segments, item => String(item.id || ""));
        const segmentSignature = (segment: Record<string, any> | undefined) => segment ? Object.fromEntries(["shot_ids", "start_frame", "end_frame", "generation_clip_duration", "mode", "audio", "sound", "overall_soundscape", "non_diegetic_music"].map(field => [field, segment[field]])) : null;
        const boundarySignature = (director: NonNullable<EpisodeProductionData["director"]> | undefined, id: string) => {
            const edge = director?.boundaries.find(item => item.from === id);
            return edge ? { to: edge.to, tailFrame: edge.tailFrame, motionContext: edge.motionContext } : null;
        };
        const changedSegments = [...new Set([...segmentsBefore.keys(), ...segmentsAfter.keys()])].filter(id =>
            fingerprint(segmentSignature(segmentsBefore.get(id))) !== fingerprint(segmentSignature(segmentsAfter.get(id)))
            || fingerprint(signature(before, "h3", id)) !== fingerprint(signature(after, "h3", id))
            || fingerprint(boundarySignature(before, id)) !== fingerprint(boundarySignature(after, id)));
        const affectedShotIds = [...new Set([...changedShots, ...changedSegments.flatMap(id => [
            ...(segmentsBefore.get(id)?.shot_ids || []).map(String), ...(segmentsAfter.get(id)?.shot_ids || []).map(String),
        ])])];
        const imageShotIds = [...new Set([...changedFrameShots, ...list(after.source.shots).filter(shot => {
            const input = after.shotInputs[String(shot.id)];
            return input?.keyframeAssetId && changedAssets.includes(input.keyframeAssetId);
        }).map(shot => String(shot.id))])].filter(id => after.shotInputs[id]?.keyframePolicy === "new");
        const clipGroupIds = [...new Set([...changedSegments, ...next.clipGroups.filter(group => group.shotIds.some(id => changedH3Shots.includes(id))).map(group => group.id)])];
        const affected = new Set(affectedShotIds);
        return { changedSceneIds, affectedShotIds, imageShotIds, clipGroupIds, missingAssetNodeIds: this.missingAssets(episodeId, next, affected), assetIds: changedAssets };
    }

    private missingAssets(episodeId: string, data: EpisodeProductionData, affected: Set<string>) {
        const canvasId = this.episode(episodeId).canvasId;
        const nodes = canvasId ? ((this.db.getCanvasProject(canvasId)?.nodes || []) as Array<Record<string, unknown>>) : [];
        const nodeIds = new Set(nodes.map((node) => String(node.id || "")));
        return [...new Set(data.shots.filter((shot) => affected.has(shot.id)).flatMap((shot) => shot.assetNodeIds))].filter((id) => !nodeIds.has(id));
    }

    private canvasNode(episodeId: string, nodeId: string) {
        const canvasId = this.episode(episodeId).canvasId;
        const project = canvasId ? this.db.getCanvasProject(canvasId) : null;
        const node = (project?.nodes as Array<Record<string, unknown>> | undefined)?.find((item) => item.id === nodeId);
        if (!node) throw new Error(`分集画布中找不到节点：${nodeId}`);
        return node;
    }
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function reorder<T extends { id: string }>(items: T[], ids: string[]) {
    if (ids.length !== items.length || new Set(ids).size !== ids.length || ids.some((id) => !items.some((item) => item.id === id))) throw new Error("排序列表必须恰好包含当前全部 ID");
    return ids.map((id) => items.find((item) => item.id === id)!);
}
function orderShotsByScene(draft: EpisodeProductionData) {
    return draft.scenes.flatMap((scene) => draft.shots.filter((shot) => shot.sceneId === scene.id));
}
