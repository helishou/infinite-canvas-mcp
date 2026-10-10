import { captureCanvasInputs, effectiveTargetInput, inputHash, type CanvasExecutionSnapshot } from "./canvas-inputs.js";
import { replaceDirectorSceneStoryboard } from "./scene-storyboard.js";
import { replaceDirectorClipStoryboard, repartitionDirectorClips, assertClipEdit, clipShots, rows as clipRows } from "./clip-storyboard.js";
import { ClipRefreshStore, clipRefreshReceipt, clipRefreshScope } from "./clip-refresh.js";
import { reverseSyncPromptEdit, type PromptSourceMap } from "./prompt-reverse-sync.js";
import { subjectShotWindows, subjectStateProjection } from "@basketikun/canvas-agent/drama/subject-assembly";
import { adoptedDirectorFields } from "./input-merge.js";
import crypto from "node:crypto";
import { assertDirectorWorkScope, directorArtifact, directorAdoption, directorWorkInput, type DirectorWorkPackage } from "@basketikun/canvas-agent/agent/work-package";
import { DIRECTOR_SUBAGENT_KIND } from "@basketikun/canvas-agent/agent/delegation";
import { currentCompilationArtifact, compilationScopeInput, preserveCompilationProvenance, scopedCompilerInput, productionReviewHash } from "@basketikun/canvas-agent/drama/compilation-scope";
import fs from "node:fs";
import path from "node:path";

import {
    emptyEpisodeProduction,
    canonicalProduction,
    productionImageModel,
    productionSceneEntries,
    productionScriptGroups,
    episodeProductionDataSchema,
    directorRunStartSchema,
    directorModules,
    directorProductionSchema,
    productionEditSchema,
    productionPublishSchema,
    productionPreflightRequestSchema,
    productionContinuityReadSchema,
    productionContinuityCheckSchema,
    productionContinuityUpgradePreviewSchema,
    productionContractVersion,
    isSubjectPromptAssembly,
    resolveSubjectPictureBindingIds,
    promptSourceMapSchema,
    type ProductionLayoutPlan,
    type ProductionLayoutReceipt,
    type ProductionLayoutUnit,
    directorPatchFields,
    type ProductionEdit,
    type DirectorRunStart,
    type ProductionPreflight,
    type ProductionDiagnostic,
    type EpisodeProductionData,
    type DirectorProduction,
    type ProductionOperation,
} from "@basketikun/canvas-agent/drama/production-contract";
import { BASE_H3_NODE_METADATA, createH3NodeMetadata, isH3NodeType } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { H3_DEFAULTS_KEY } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { H3_RUNTIME_NODE_FIELDS, H3_RUNTIME_SEGMENT_FIELDS } from "@basketikun/canvas-agent/runtime-fields";
import { resolveAchengEngine, resolveAchengRuntime } from "@basketikun/canvas-agent/skills/acheng";
import { assertAchengSource, auditAchengContinuity, validateAchengSource, preflightCompilationDirector } from "@basketikun/canvas-agent/skills/acheng";
import { schemaDiagnostics, ProductionValidationError, applyDirectorSourcePatch } from "@basketikun/canvas-agent/drama/production-validation";
import { selectSmartImageResult } from "@basketikun/canvas-agent/reference-contract";

import { directorHash, projectDirector, validateDirectorMedia, assertDirectorEngine } from "./director.js";
import { DATA_DIR } from "../config.js";
import { resolveCanvasImageReferenceNode } from "../canvas/image-references.js";
import type { BackendDatabase } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { CanvasCommit } from "../canvas/collaboration.js";
import type { CanvasOperation } from "../canvas/project-ops.js";
import { approvedSharedAsset, listApprovedSharedAssets, prepareSharedAssetProjection, registerApprovedSharedAsset, sharedAssetHistory, sharedProjectionNodeId, validateSharedAssetSource, type ApprovedSharedAsset } from "./shared-assets.js";
import { ensureProductionCanvas, productionCanvasContext } from "./production-canvas.js";
import { scriptNodeOperations } from "./script-nodes.js";
import { compileProductionLayout, productionAssetPosition, productionSceneIdsForShots } from "./production-layout.js";
import { productionLayoutStableId, productionNodePosition } from "./production-layout-geometry.js";
import { compiledImageInput, assertImageReferenceCoverage, imageInputOperations, verifyImageInput } from "./image-inputs.js";
import { buildPublishedProductionClip, clipInputHash, clipInputOperations, productionClipProjection, type ReferenceSync } from "./clip-inputs.js";
import { productionSceneCreationOperations } from "./production-scene-nodes.js";
import { archiveDirectorScene, deleteDirectorClip, listArchivedDirectorScenes, restoreDirectorScene } from "./production-scene-archive.js";
import { continuityTargetBlockers, ProductionContinuityReports } from "./continuity-reports.js";
import { dedupReceipt, resolveReceiptDedup, assertPublicReceipt } from "./receipt-dedup.js";
import type { NativeProductionTarget } from "./native-generation.js";

type Row = { revision: number; draft_json: string; published_json: string | null; published_version: number; updated_at: string };
export type ProductionImpact = { changedSceneIds: string[]; affectedShotIds: string[]; imageShotIds: string[]; clipGroupIds: string[]; missingAssetNodeIds: string[]; assetIds?: string[] };
export type ProductionRecord = { episodeId: string; revision: number; draft: EpisodeProductionData; published: EpisodeProductionData | null; publishedVersion: number; updatedAt: string; referenceSync?: ReferenceSync[] };
export type ProductionTargetOccupancy = { targetId: string; status: string; runId?: string; taskIds: string[]; tasks: Array<{ taskId: string; status: string }>; nextAction: NonNullable<ProductionDiagnostic["nextAction"]> };
export type ProductionRun = { episodeId: string; version: number; runId?: string; targets?: string[]; engine?: Record<string, unknown> | null; settings?: Record<string, unknown>; executionSnapshot?: CanvasExecutionSnapshot | null; status: string; plan: ProductionImpact; submitted: Array<{ kind: "image" | "h3"; id: string; taskId: string; projectId?: string; nodeId?: string; segmentId?: string; status?: "running" | "succeeded" | "failed" }>; error: string | null; updatedAt: string };
export type ProductionBatch = {
    runId: string; episodeId: string; version: number; sourceRevision: number; idempotencyKey: string; status: string;
    targets: string[]; plan: ProductionImpact; engine: Record<string, unknown> | null; settings: Record<string, unknown>;
    executionSnapshot?: CanvasExecutionSnapshot | null; submitted: ProductionRun["submitted"]; error: string | null; pauseRequested: boolean; createdAt: string; updatedAt: string;
};
export type DirectorReadinessTarget = { id: string; targetId: string; kind: "asset" | "keyframe" | "segment"; title: string; status: "ready" | "blocked" | "needs_review" | "complete"; blockers: string[]; artifactId?: string; executionTargets?: string[]; notice?: string };
export type DirectorPresentation = {
    key: string; workId: string; owner: { kind: "canvas" | "episode" | "scene"; id: string }; aliases?: string[]; workspace: "overview" | "story" | "assets" | "shots" | "continuity" | "production" | "advanced";
    action: "author" | "compile" | "produce" | "review" | "deliver" | "blocked"; targetKind?: string; targetId?: string; canvasId?: string;
    nodeId?: string; segmentId?: string; runId?: string; taskId?: string; status: "ready" | "working" | "needs_review" | "blocked" | "complete"; reason?: string;
};
export type DirectorReadiness = { revision: number; publishedVersion: number; source: "draft" | "published"; targets: DirectorReadinessTarget[]; modules: Record<string, unknown>; unresolved: string[]; nextAction: string; presentation?: DirectorPresentation; sceneWorks?: DirectorProduction["workflow"]["sceneWorks"] };

const fingerprint = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const batchRequestHash = (input: DirectorRunStart) => fingerprint({ idempotencyKey: input.idempotencyKey, workId: input.workId, expectedRevision: input.expectedRevision, version: input.version, targets: input.targets, scope: input.scope, inputBasis: input.inputBasis, expectedCanvasRevision: input.expectedCanvasRevision, expectedPlanHash: input.expectedPlanHash });
const promptHashBytes = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export class ProductionConflictError extends Error {
    constructor(readonly current: ProductionRecord) { super("制作稿版本已变化，请核对当前版本后重试"); }
}

/**
 * Formal production storage per owner kind. The SQL in this class is written in episode wording, so the
 * mapping is explicit rather than a string rewrite: a scene table is a third word shape, not a synonym.
 */
const PRODUCTION_TABLES = {
    episode: { productions: "episode_productions", operations: "episode_production_operations", versions: "episode_production_versions", runs: "episode_production_runs", batches: "episode_production_batches", key: "episode_id" },
    canvas: { productions: "canvas_productions", operations: "canvas_production_operations", versions: "canvas_production_versions", runs: "canvas_production_runs", batches: "canvas_production_batches", key: "project_id" },
} as const;

export class EpisodeProductionService {
    private subjectDependencyIndexReady = false;
    constructor(private readonly db: BackendDatabase, private readonly events?: BackendEventBus, private readonly legacyDataDir = DATA_DIR, private readonly projectScope = false, private readonly checkEngine = assertDirectorEngine) {}

    private get ownerKind(): keyof typeof PRODUCTION_TABLES { return this.projectScope ? "canvas" : "episode"; }
    private get ownerKey() { return PRODUCTION_TABLES[this.ownerKind].key; }

    isSharedAssetCanvas(id: string) {
        return this.projectScope && productionCanvasContext(this.db, id).role === "shared-assets";
    }

    private linked(projectId: string): { service: EpisodeProductionService; id: string } | null {
        if (!this.projectScope) return null;
        const row = this.db.db.prepare("SELECT id FROM drama_episodes WHERE canvas_id=?").get(projectId) as { id: string } | undefined;
        if (!row) return null;
        const standalone = this.db.db.prepare("SELECT 1 FROM canvas_productions WHERE project_id=?").get(projectId);
        if (standalone) throw new Error("画布已有独立制作记录，请先显式处理分集绑定冲突，不能覆盖任何一份制作稿");
        return { service: new EpisodeProductionService(this.db, this.events, this.legacyDataDir, false, this.checkEngine), id: row.id };
    }

    /** Rewrites the episode wording of one statement to the active owner's tables; only known production tables are allowed. */
    private prepare(sql: string) {
        if (this.ownerKind === "episode") return this.db.db.prepare(sql);
        const tables = PRODUCTION_TABLES[this.ownerKind];
        // Any production-worded table outside every known owner set is refused before it reaches SQLite.
        const known = new Set<string>(Object.values(PRODUCTION_TABLES).flatMap(entry => Object.values(entry)));
        for (const match of sql.matchAll(/\b(episode_[a-z_]+|canvas_[a-z_]+|scene_[a-z_]+)\b/g)) if (!known.has(match[1])) throw new Error(`制作存储映射不包含表 ${match[1]}`);
        const rewritten = sql
            .replaceAll("episode_production_batches", tables.batches)
            .replaceAll("episode_production_operations", tables.operations)
            .replaceAll("episode_production_versions", tables.versions)
            .replaceAll("episode_production_runs", tables.runs)
            .replaceAll("episode_productions", tables.productions)
            .replaceAll("episode_id", tables.key);
        if (/episode_production|episode_id/.test(rewritten)) throw new Error(`制作存储映射不完整：${sql}`);
        return this.db.db.prepare(rewritten);
    }

    episodeInfo(episodeId: string): { id: string; canvasId?: string | null; fullPlot?: string | null } { const linked = this.linked(episodeId); return linked ? linked.service.episodeInfo(linked.id) : this.episode(episodeId); }
    ownerIdentity(id: string): { kind: "episode" | "canvas"; id: string } {
        const linked = this.linked(id);
        if (linked) return linked.service.ownerIdentity(linked.id);
        this.episode(id);
        return { kind: this.ownerKind, id };
    }
    /** Check before accepting a preparation; create only after all targets are validated. */
    preparationCanvas(id: string, create = false): string | null {
        const linked = this.linked(id); if (linked) return linked.service.preparationCanvas(linked.id, create);
        const owner = this.episode(id);
        if (owner.canvasId) {
            if (!this.db.getCanvasProject(owner.canvasId)) throw new Error("固定绑定的画布不存在，请恢复原画布");
            return owner.canvasId;
        }
        if (this.projectScope) throw new Error("制作画布不存在");
        return create ? ensureProductionCanvas(this.db, "episode", id, this.events).project.id : null;
    }
    compilationRoot() { return path.join(this.legacyDataDir, "production-compilations"); }
    resolveSubjectPictureInputs(id: string, input: DirectorProduction, targetIds?: string[], forCompilation = false): DirectorProduction {
        const linked = this.linked(id);
        if (linked) return linked.service.resolveSubjectPictureInputs(linked.id, input, targetIds, forCompilation);
        if (!isSubjectPromptAssembly(input.source)) return structuredClone(input);
        const director = structuredClone(input), productionCanvasId = this.episodeInfo(id).canvasId;
        this.validateSubjectEntityOwnership(id, director);
        if (!productionCanvasId) throw new Error("SUBJECT_IMAGE_PRODUCTION_CANVAS_MISSING: 制作对象尚未绑定画布");
        const assetPlans = clipRows(director.source.asset_plan), subjects = clipRows(director.source.subject_registry);
        const bindings = subjects.flatMap(subject => clipRows(subject.pictureBindings).map(binding => ({ subjectId: String(subject.id), binding })));
        const subjectById = new Map(subjects.map(subject => [String(subject.id), subject]));
        const selectedShotIds = targetIds !== undefined
            ? new Set(clipRows(director.source.segments).filter(segment => targetIds.includes(String(segment.id))).flatMap(segment => (segment.shot_ids || []).map(String)))
            : undefined;
        const subjectReferenceShotIds = forCompilation ? new Set(clipRows(director.source.segments).filter(segment => String(segment.mode) === "Ref2VA"
            && (!targetIds || targetIds.includes(String(segment.id)))).flatMap(segment => (segment.shot_ids || []).map(String))) : undefined;
        const shots = clipRows(director.source.shots).filter(shot => !selectedShotIds || selectedShotIds.has(String(shot.id))), usedBindings = new Set<string>();
        const taskOrderCache = new Map<string, ReturnType<BackendDatabase["getTask"]>>();
        for (const shot of shots) {
            if (!subjectReferenceShotIds || subjectReferenceShotIds.has(String(shot.id))) for (const usage of clipRows(shot.subject_usages)) for (const bindingId of resolveSubjectPictureBindingIds(subjectById.get(String(usage.subjectId)), usage).bindingIds) usedBindings.add(String(bindingId));
            for (const frame of clipRows(shot.keyframes)) if (frame.requiredForSubmission) usedBindings.add(String(frame.id));
        }
        for (const shot of shots) for (const frame of clipRows(shot.keyframes).filter(item => item.requiredForSubmission)) bindings.push({
            subjectId: String(frame.subjectIds?.[0] || `keyframe:${shot.id}`),
            binding: { id: String(frame.id), assetId: String(frame.assetId || frame.id), sourceNode: frame.sourceNode, selection: frame.selection },
        });
        for (const { subjectId, binding } of bindings) {
            const bindingId = String(binding.id || ""), assetId = String(binding.assetId || bindingId);
            if (!usedBindings.has(bindingId)) continue;
            const plan = assetPlans.find(asset => String(asset.asset_id || asset.id) === assetId);
            const ref = binding.sourceNode && typeof binding.sourceNode === "object" ? binding.sourceNode as Record<string, any> : {};
            const projectId = String(ref.projectId || ""), nodeId = String(ref.nodeId || "");
            const project = projectId ? this.db.getCanvasProject(projectId) : null, node = (project?.nodes as Array<Record<string, any>> | undefined)?.find(item => item.id === nodeId);
            if (!project || !node || node.type !== "config" || node.metadata?.smart !== true || (node.metadata?.generationMode || "image") !== "image") throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_NODE_INVALID", path: `subject_registry.${subjectId}.pictureBindings.${bindingId}.sourceNode`, targetId: bindingId, message: "Subject 图片必须绑定有效的智能图片节点", severity: "error" }]);
            let authorized = projectId === productionCanvasId;
            if (!authorized) {
                const consumer = productionCanvasContext(this.db, productionCanvasId), source = productionCanvasContext(this.db, projectId), adopted = director.assets[assetId];
                if (consumer.dramaId && consumer.dramaId === source.dramaId && source.role === "shared-assets" && adopted?.sharedSource?.sourceProjectId === projectId) {
                    validateSharedAssetSource(this.db, productionCanvasId, adopted);
                    authorized = true;
                }
            }
            if (!authorized) throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_NODE_OWNER", path: `subject_registry.${subjectId}.pictureBindings.${bindingId}.sourceNode.projectId`, targetId: bindingId, message: "跨画布 Subject 图片必须来自当前剧目的已采用共享资产", severity: "error" }]);
            const images = Array.isArray(node.metadata?.images) ? node.metadata.images as Array<Record<string, any>> : [];
            const taskOutputIndices = new Map<string, number>();
            const orderedImages = images.map((image, index) => {
                const taskId = String(image.generationTaskId || "");
                const task = taskId ? taskOrderCache.get(taskId) || this.db.getTask(taskId) : null;
                if (taskId && !taskOrderCache.has(taskId)) taskOrderCache.set(taskId, task);
                const outputIndex = Number.isSafeInteger(Number(image.generationOutputIndex))
                    ? Number(image.generationOutputIndex)
                    : (taskOutputIndices.get(taskId) ?? 0);
                taskOutputIndices.set(taskId, outputIndex + 1);
                return { ...image, ...(image.generationTaskSequence === undefined && taskId ? { generationTaskSequence: this.db.getTaskSequence(taskId) } : {}),
                    ...(image.generationTaskCreatedAt === undefined && task?.createdAt ? { generationTaskCreatedAt: task.createdAt } : {}),
                    ...(image.generationOutputIndex === undefined ? { generationOutputIndex: outputIndex } : {}), __slotOrder: index };
            }).sort((a, b) => {
                const leftSequence = Number.isSafeInteger(Number(a.generationTaskSequence)) ? Number(a.generationTaskSequence) : undefined;
                const rightSequence = Number.isSafeInteger(Number(b.generationTaskSequence)) ? Number(b.generationTaskSequence) : undefined;
                if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) return leftSequence - rightSequence;
                const leftTime = String(a.generationTaskCreatedAt || ""), rightTime = String(b.generationTaskCreatedAt || "");
                return leftTime.localeCompare(rightTime) || Number(a.generationOutputIndex) - Number(b.generationOutputIndex) || a.__slotOrder - b.__slotOrder;
            }).map(({ __slotOrder: _slotOrder, ...image }) => image);
            const resolved = selectSmartImageResult({ ...node.metadata, images: orderedImages }, binding.selection as any);
            if (resolved.error || !resolved.image) throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_RESULT_MISSING", path: `subject_registry.${subjectId}.pictureBindings.${bindingId}.selection`, targetId: bindingId, message: resolved.error || "智能节点没有有效结果", severity: "error" }]);
            const slot = resolved.image as Record<string, any>, storageKey = String(slot.storageKey || ""), generationTaskId = String(slot.generationTaskId || "");
            const media = storageKey && this.db.getMediaFile(storageKey);
            if (!media || !fs.existsSync(media.filePath)) throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_NOT_ARCHIVED", path: `subject_registry.${subjectId}.pictureBindings.${bindingId}.selection`, targetId: bindingId, message: "智能节点结果尚未归档，不能作为模型参考", severity: "error" }]);
            const digest = crypto.createHash("sha256").update(fs.readFileSync(media.filePath)).digest("hex");
            if (generationTaskId) {
                const task = this.db.getTask(generationTaskId);
                const outputs = [...(task?.outputs || []), ...(Array.isArray(task?.result?.media) ? task.result.media as Array<Record<string, any>> : [])];
                if (!task || task.status !== "succeeded" || task.projectId !== projectId || task.nodeId !== nodeId || !outputs.some(output => output.storageKey === storageKey)) throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_PROVENANCE_INVALID", path: `subject_registry.${subjectId}.pictureBindings.${bindingId}.selection`, targetId: bindingId, message: "节点图片缺少对应的成功任务和归档结果记录", severity: "error" }]);
            }
            const old = director.assets[assetId];
            director.assets[assetId] = { ...(old || { version: String(plan?.version || `node:${nodeId}`), status: "planned" as const }), nodeId, storageKey,
                generationTaskId: generationTaskId || undefined, sha256: digest, status: old?.status === "approved" && old.sha256 === digest ? "approved" : "generated",
                ...(old?.evidence && old.sha256 === digest ? { evidence: old.evidence } : {}), selectedResult: { imageId: String(slot.id || ""), taskId: generationTaskId || undefined, storageKey, sha256: digest, projectId, nodeId } };
        }
        return director;
    }
    private validateSubjectEntityOwnership(id: string, director: DirectorProduction) {
        const episode = this.ownerKind === "episode" ? this.db.getDramaEpisode(id) : null;
        const canvasId = this.episodeInfo(id).canvasId || (this.projectScope ? id : undefined);
        const dramaId = episode?.dramaId || productionCanvasContext(this.db, canvasId || id).dramaId;
        for (const subject of clipRows(director.source.subject_registry)) {
            const reference = subject.entityRef || {};
            const ownerMatches = reference.ownerKind === "episode" ? this.ownerKind === "episode" && reference.ownerId === id
                : reference.ownerKind === "canvas" ? Boolean(canvasId && reference.ownerId === canvasId)
                : reference.ownerKind === "drama" ? Boolean(dramaId && reference.ownerId === dramaId)
                : false;
            if (!ownerMatches) throw new ProductionValidationError([{ code: "SUBJECT_ENTITY_OWNER_MISMATCH", path: "subject_registry." + subject.id + ".entityRef", targetId: String(subject.id), message: "Subject 实体引用不属于当前分集、剧目或制作画布", severity: "error" }]);
        }
    }
    clipRefreshStore(id: string): ClipRefreshStore {
        const linked = id && this.linked(id);
        return linked ? linked.service.clipRefreshStore(linked.id) : new ClipRefreshStore(this.db.db, { kind: this.ownerKind, id });
    }
    subjectClipConsumers(sourceProjectId: string, nodeIds?: string[]) {
        this.ensureSubjectDependencyIndex();
        const clauses = ["source_project_id=?", "owner_kind=?"];
        const params: Array<string> = [sourceProjectId, this.ownerKind];
        if (nodeIds?.length) { clauses.push(`source_node_id IN (${nodeIds.map(() => "?").join(",")})`); params.push(...nodeIds); }
        return this.db.db.prepare(`SELECT owner_id, segment_id FROM production_clip_source_dependencies WHERE ${clauses.join(" AND ")} ORDER BY owner_id, segment_id`).all(...params) as Array<{ owner_id: string; segment_id: string }>;
    }
    private ensureSubjectDependencyIndex() {
        if (this.subjectDependencyIndexReady) return;
        const tables = PRODUCTION_TABLES[this.ownerKind], table = tables.productions, ownerColumn = tables.key;
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const rows = this.db.db.prepare("SELECT " + ownerColumn + " AS owner_id,draft_json FROM " + table).all() as Array<{ owner_id: string; draft_json: string }>;
            for (const row of rows) {
                const draft = JSON.parse(row.draft_json) as EpisodeProductionData;
                this.syncSubjectClipDependencies(row.owner_id, draft.director);
            }
            this.db.db.exec("COMMIT");
            this.subjectDependencyIndexReady = true;
        } catch (error) {
            this.db.db.exec("ROLLBACK");
            throw error;
        }
    }
    private syncSubjectClipDependencies(episodeId: string, director?: DirectorProduction) {
        this.db.db.prepare("DELETE FROM production_clip_source_dependencies WHERE owner_kind=? AND owner_id=?").run(this.ownerKind, episodeId);
        if (!director || !isSubjectPromptAssembly(director.source)) return;
        const subjects = new Map(clipRows(director.source.subject_registry).map(subject => [String(subject.id), subject]));
        const shots = new Map(clipRows(director.source.shots).map(shot => [String(shot.id), shot]));
        const insert = this.db.db.prepare(`INSERT OR IGNORE INTO production_clip_source_dependencies(owner_kind,owner_id,segment_id,source_project_id,source_node_id,binding_id,asset_id,subject_id,role)
            VALUES(?,?,?,?,?,?,?,?,?)`);
        for (const segment of clipRows(director.source.segments)) for (const shotId of segment.shot_ids || []) {
            const shot = shots.get(String(shotId)); if (!shot) continue;
            for (const usage of clipRows(shot.subject_usages)) {
                const subject = subjects.get(String(usage.subjectId)); if (!subject) continue;
                const selectedBindings = new Set(resolveSubjectPictureBindingIds(subject, usage).bindingIds);
                for (const binding of clipRows(subject.pictureBindings)) if (selectedBindings.has(String(binding.id))) insert.run(this.ownerKind, episodeId, String(segment.id), String(binding.sourceNode?.projectId || ""), String(binding.sourceNode?.nodeId || ""), String(binding.id), String(binding.assetId), String(subject.id), "subject");
            }
            for (const frame of clipRows(shot.keyframes).filter(item => item.requiredForSubmission)) insert.run(this.ownerKind, episodeId, String(segment.id), String(frame.sourceNode?.projectId || ""), String(frame.sourceNode?.nodeId || ""), String(frame.id), String(frame.assetId || frame.id), String((frame.subjectIds || [])[0] || ""), "keyframe");
        }
    }
    clipWorkbench(id: string, segmentId: string, snapshot: "draft" | "published" = "draft") {
        const started = performance.now(), production = this.get(id), d = production[snapshot]?.director;
        if (!d) throw new Error("CLIP_WORKBENCH_SOURCE: 缺少导演源稿");
        if (isSubjectPromptAssembly(d.source)) {
            let resolved = d, resolutionDiagnostics: Array<Record<string, unknown>> = [];
            if (snapshot === "draft") try { resolved = this.resolveSubjectPictureInputs(id, d, [segmentId]); } catch (error) { resolutionDiagnostics = (error as any)?.diagnostics || [{ code: "SUBJECT_IMAGE_RESOLUTION", message: error instanceof Error ? error.message : String(error) }]; }
            const { segment, shots } = clipShots(d, segmentId), shotIds = new Set(shots.map(s => String(s.id)));
            const usages = shots.flatMap(s => clipRows(s.subject_usages).map(usage => ({ shotId: String(s.id), ...usage })));
            const subjectIds = new Set(usages.map(usage => String((usage as any).subjectId)));
            const subjects = clipRows(d.source.subject_registry).filter(subject => subjectIds.has(String(subject.id)));
            const ledger = d.source.ledger as Record<string, any> | undefined, projection = subjectStateProjection(d.source), windows = subjectShotWindows(d.source);
            const states = Object.fromEntries(shots.map(shot => [shot.id, projection[shot.id] || { start: [], end: [], unresolved: [] }]));
            const relatedFacts = new Set(usages.flatMap(usage => (((usage as any).continuityFactIds || []) as string[]).map(String)));
            for (const fact of clipRows(ledger?.facts)) if (subjects.some(subject => subject.entityRef?.kind === fact.object_kind && subject.entityRef?.id === fact.object_id)) relatedFacts.add(String(fact.id));
            const workbench = { owner: this.ownerIdentity(id), sourceVersion: "subject-prompt-v2", segmentId, sourceHash: d.sourceHash,
                inputHash: compilationScopeInput(resolved, clipRefreshScope(segmentId)).inputHash,
                segment: { id: segment.id, shot_ids: segment.shot_ids, mode: segment.mode, duration_frames: shots.reduce((n, shot) => n + Number(shot.duration_frames), 0) },
                shots: shots.map(shot => ({ ...shot, timelineWindow: windows.get(String(shot.id)), continuity: states[shot.id] })),
                subjects: subjects.map(subject => ({ ...subject, assets: clipRows(subject.pictureBindings).map(binding => ({ ...binding, resolved: resolved.assets[String(binding.assetId)] || null })) })),
                utterances: clipRows(d.source.utterances).filter(u => shots.some(shot => (shot.utterance_refs || []).some((ref: any) => ref.utteranceId === u.id))),
                continuity: { status: ledger?.contract_version === 2 ? "available" : "unavailable", facts: clipRows(ledger?.facts).filter(fact => relatedFacts.has(String(fact.id))),
                    events: clipRows(ledger?.events).filter(event => shotIds.has(String(event.shot_id))), requirements: clipRows(ledger?.requirements).filter(req => shotIds.has(String(req.shot_id))),
                    coverage: clipRows(ledger?.coverage).filter(item => (item.shot_ids || []).some((shotId: string) => shotIds.has(shotId))) },
                targetStatus: this.targetOccupancy(id, [segmentId]),
                directorArtifacts: d.artifacts.filter(a => a.targetId === segmentId).map(a => ({ id: a.id, status: a.status, current: currentCompilationArtifact(resolved, a), sha256: a.sha256, promptBytes: Buffer.byteLength(a.prompt), references: a.references })),
                canvasInputs: this.canvasEditorialState(id, [segmentId]), boundaries: d.boundaries.filter(b => b.from === segmentId || b.to === segmentId),
                resolutionDiagnostics, workbenchBuildMs: performance.now() - started };
            return { ...production, clipWorkbench: workbench, workbenchVersion: directorHash(workbench) };
        }
        const { segment, shots } = clipShots(d, segmentId), projection = compilationScopeInput(d, clipRefreshScope(segmentId));
        const shotIds = new Set(shots.map(s => s.id)), assetIds = new Set(Object.keys(projection.director.assets));
        const subjects = new Set(shots.flatMap(s => [...(s.characters || []).map((c: any) => typeof c === "string" ? c : c.id || c.character_id), ...(s.camera?.attention_subject_ids || [])]));
        const ledger = d.source.ledger as any;
        const related = (r: any) => shotIds.has(r.shot_id) || (r.shot_ids || []).some((s: string) => shotIds.has(s));
        const continuity = this.continuityForDirector(id, d, snapshot);
        const report: any = continuity.report;
        const workbench = { owner: this.ownerIdentity(id), segmentId, sourceHash: d.sourceHash, inputHash: projection.inputHash, engine: d.engine,
            segment, shots, shotInputs: Object.fromEntries(shots.map(s => [s.id, d.shotInputs[s.id]])),
            characterRegistry: clipRows(d.source.character_registry).filter(c => subjects.has(c.id)),
            sceneRegistry: clipRows(d.source.scene_registry).filter(c => shots.some(s => s.scene_id === c.id)),
            assetPlan: clipRows(projection.director.source.asset_plan), assetCards: clipRows(projection.director.source.asset_cards), assets: Object.fromEntries(Object.entries(d.assets).filter(([key]) => assetIds.has(key))),
            directorReferences: { authored: segment.references || [], compiled: d.artifacts.filter(a => a.targetId === segmentId).map(a => ({ id: a.id, status: a.status, current: currentCompilationArtifact(d, a), sha256: a.sha256, references: a.references })) },
            canvasInputs: this.canvasEditorialState(id, [segmentId]), targetStatus: this.targetOccupancy(id, [segmentId]),
            continuity: { status: continuity.status, stale: report?.stale ?? true, sourceHash: report?.sourceHash, runtimeId: report?.runtimeId,
                trajectories: Object.fromEntries(Object.entries(report?.trajectories || {}).filter(([s]) => shotIds.has(s))),
                diagnostics: (report?.diagnostics || []).filter((i: any) => !i.affectedTargets?.length || i.affectedTargets.includes(segmentId)),
                events: clipRows(ledger?.events).filter(related), requirements: clipRows(ledger?.requirements).filter(related), coverage: clipRows(ledger?.coverage).filter(related), facts: ledger?.facts || [], initial: ledger?.initial || [] },
            boundaries: d.boundaries.filter(b => b.from === segmentId || b.to === segmentId) };
        return { ...production, clipWorkbench: workbench, workbenchVersion: directorHash(workbench), workbenchBuildMs: performance.now() - started };
    }
    subjectWorkbench(id: string, subjectId: string, snapshot: "draft" | "published" = "draft") {
        const production = this.get(id), authored = production[snapshot]?.director;
        if (!authored || !isSubjectPromptAssembly(authored.source)) throw new Error("SUBJECT_WORKBENCH_SOURCE_VERSION: 所选制作稿尚未采用 Subject Prompt v2");
        let director = authored, resolutionDiagnostics: Array<Record<string, unknown>> = [];
        const consumerSegments = clipRows(authored.source.segments).filter(clip => clipRows(authored.source.shots).some(shot => shot.subject_usages?.some((usage: any) => usage.subjectId === subjectId) && (clip.shot_ids || []).includes(shot.id))).map(clip => String(clip.id));
        if (snapshot === "draft") try { director = this.resolveSubjectPictureInputs(id, authored, consumerSegments); } catch (error) { resolutionDiagnostics = (error as any)?.diagnostics || [{ code: "SUBJECT_IMAGE_RESOLUTION", message: error instanceof Error ? error.message : String(error) }]; }
        const subject = clipRows(director.source.subject_registry).find(item => item.id === subjectId);
        if (!subject) throw new Error(`Subject ${subjectId} 不存在`);
        const ledger = director.source.ledger as Record<string, any> | undefined;
        const facts = clipRows(ledger?.facts).filter(fact => fact.object_kind === subject.entityRef?.kind && fact.object_id === subject.entityRef?.id);
        const factIds = new Set(facts.map(fact => String(fact.id))), state = subjectStateProjection(director.source);
        const usages = clipRows(director.source.shots).flatMap(shot => clipRows(shot.subject_usages).filter(usage => usage.subjectId === subjectId).map(usage => ({
            shotId: String(shot.id), clipIds: clipRows(director.source.segments).filter(clip => (clip.shot_ids || []).includes(shot.id)).map(clip => String(clip.id)),
            usage, state: state[String(shot.id)],
        })));
        const workbench = { subject, pictureBindings: clipRows(subject.pictureBindings).map(binding => ({ ...binding, resolved: director.assets[String(binding.assetId)] || null })),
            facts, timelines: clipRows(ledger?.timelines), initial: clipRows(ledger?.initial).filter(item => factIds.has(String(item.fact_id))),
            events: clipRows(ledger?.events).filter(item => factIds.has(String(item.fact_id))),
            requirements: clipRows(ledger?.requirements).filter(item => factIds.has(String(item.fact_id))), usages, resolutionDiagnostics };
        return { ...production, subjectWorkbench: workbench, workbenchVersion: directorHash({ revision: production.revision, sourceHash: director.sourceHash, workbench }) };
    }
    shotWorkbench(id: string, shotId: string, snapshot: "draft" | "published" = "draft") {
        const production = this.get(id), authored = production[snapshot]?.director;
        if (!authored || !isSubjectPromptAssembly(authored.source)) throw new Error("SHOT_WORKBENCH_SOURCE_VERSION: 所选制作稿尚未采用 Subject Prompt v2");
        let director = authored, resolutionDiagnostics: Array<Record<string, unknown>> = [];
        const segmentId = String(clipRows(director.source.segments).find(clip => (clip.shot_ids || []).includes(shotId))?.id || "");
        if (snapshot === "draft") try { director = this.resolveSubjectPictureInputs(id, authored, segmentId ? [segmentId] : []); } catch (error) { resolutionDiagnostics = (error as any)?.diagnostics || [{ code: "SUBJECT_IMAGE_RESOLUTION", message: error instanceof Error ? error.message : String(error) }]; }
        const shot = clipRows(director.source.shots).find(item => item.id === shotId);
        if (!shot) throw new Error(`Shot ${shotId} 不存在`);
        const subjectIds = new Set(clipRows(shot.subject_usages).map(usage => String(usage.subjectId))), states = subjectStateProjection(director.source);
        const usages = clipRows(shot.subject_usages).map(usage => {
            const subject = clipRows(director.source.subject_registry).find(item => item.id === usage.subjectId);
            const bindingIds = new Set(resolveSubjectPictureBindingIds(subject, usage).bindingIds);
            return { ...usage, subject, pictureBindings: clipRows(subject?.pictureBindings).filter(binding => bindingIds.has(String(binding.id))).map(binding => ({ ...binding, resolved: director.assets[String(binding.assetId)] || null })) };
        });
        const clipId = String(clipRows(director.source.segments).find(clip => (clip.shot_ids || []).includes(shotId))?.id || "");
        // Preview bindings can include design-only images that this model mode does not consume.
        let compilationInput: DirectorProduction | undefined = director;
        if (resolutionDiagnostics.length) {
            try { compilationInput = this.resolveSubjectPictureInputs(id, authored, clipId ? [clipId] : [], true); }
            catch { compilationInput = undefined; }
        }
        const workbench = { shot, timelineWindow: subjectShotWindows(director.source).get(shotId), continuity: states[shotId], subjectUsages: usages,
            subjectRegistry: clipRows(director.source.subject_registry).filter(subject => subjectIds.has(String(subject.id))),
            keyframes: clipRows(shot.keyframes).map(frame => {
                let resolved: DirectorProduction["assets"][string] | null = director.assets[String(frame.assetId || frame.id)] || null;
                if (snapshot === "draft" && !frame.requiredForSubmission) {
                    try {
                        const preview = structuredClone(authored);
                        preview.source.shots = [{ ...shot, subject_usages: [], keyframes: [{ ...frame, requiredForSubmission: true }] }];
                        preview.source.segments = clipRows(authored.source.segments).filter(segment => segment.id === clipId).map(segment => ({ ...segment, shot_ids: [shotId] }));
                        resolved = this.resolveSubjectPictureInputs(id, preview, clipId ? [clipId] : [], true).assets[String(frame.assetId || frame.id)] || null;
                    } catch { resolved = null; }
                }
                return { ...frame, resolved };
            }),
            utterances: clipRows(director.source.utterances).filter(u => (shot.utterance_refs || []).some((ref: any) => ref.utteranceId === u.id)), clipId,
            directorArtifacts: director.artifacts.filter(artifact => artifact.kind === "h3" && artifact.targetId === clipId).map(artifact => ({
                id: artifact.id, status: artifact.status, sha256: artifact.sha256,
                current: Boolean(compilationInput && currentCompilationArtifact(compilationInput, artifact)),
            })),
            targetStatus: clipId ? this.targetOccupancy(id, [clipId]) : [], resolutionDiagnostics };
        return { ...production, shotWorkbench: workbench, workbenchVersion: directorHash({ revision: production.revision, sourceHash: director.sourceHash, workbench }) };
    }
    private continuityReports() { return new ProductionContinuityReports(path.join(this.compilationRoot(), "continuity")); }

    getContinuity(id: string, raw: unknown = {}): Record<string, any> {
        const linked = this.linked(id); if (linked) return linked.service.getContinuity(linked.id, raw);
        const query = productionContinuityReadSchema.parse(raw);
        const current = this.get(id);
        const selected = query.snapshot === "published" ? current.published : current.draft;
        const director = selected?.director;
        const legacy = Boolean(director?.source.ledger && (director.source.ledger as any).contract_version !== 2);
        if (!director) return { owner: { kind: this.ownerKind, id }, snapshot: query.snapshot, revision: current.revision, publishedVersion: current.publishedVersion,
            status: "missing", coverageStatus: "unchecked", semanticDiscovery: "not_performed", checkedAt: null, diagnostics: { total: 1, blocked: 1, unresolved: 1 }, items: [], total: 0, nextCursor: null };
        const reports = this.continuityReports();
        let projected = reports.get({ kind: this.ownerKind, id }, query.snapshot,
            { sourceHash: director.sourceHash, snapshotVersion: current.publishedVersion }, query.view, query.targetId, query.objectId, query.pageSize, query.cursor);
        if (query.snapshot === "published" && !projected.report && director.source.ledger && (director.source.ledger as any).contract_version === 2) {
            const draftReport = reports.get({ kind: this.ownerKind, id }, "draft", { sourceHash: director.sourceHash }, query.view, query.targetId, query.objectId, query.pageSize, query.cursor);
            if (draftReport.report && draftReport.status !== "stale") projected = { ...draftReport, report: { ...draftReport.report, snapshot: "published", snapshotVersion: current.publishedVersion } };
        }
        const items = projected.items as any[];
        const allSegments = ((director.source.segments || []) as any[]).map(item => String(item.id || ""));
        const checkedTargets = projected.report?.selectedTargets as string[] | undefined;
        const effectiveStatus = projected.status === "passed" && checkedTargets?.length && allSegments.some(target => !checkedTargets.includes(target)) ? "partial" : projected.status;
        const legacyIssue = legacy && !projected.report ? [{ code: "LEGACY_CONTINUITY_UNCHECKED", message: "旧版草稿尚未运行只读诊断；诊断结果不会授权新门禁。" }] : [];
        return { owner: { kind: this.ownerKind, id }, snapshot: query.snapshot, revision: current.revision, publishedVersion: current.publishedVersion,
            sourceHash: director.sourceHash, runtime: projected.report?.engine || { ...director.engine, runtimeId: projected.report?.runtimeId || director.engine.runtimeId }, status: legacy ? "diagnosticOnly" : effectiveStatus,
            coverageStatus: projected.report?.coverageStatus || "unchecked", semanticDiscovery: "not_performed", checkedAt: projected.report?.checkedAt || null,
            diagnostics: { total: (projected.report?.diagnostics?.length || 0) + legacyIssue.length, blocked: legacy ? 0 : (projected.report?.diagnostics || []).filter((item: any) => item.severity !== "warning").length,
                unresolved: (projected.report?.diagnostics || []).filter((item: any) => /UNKNOWN|UNRESOLVED|MISSING/.test(String(item.code))).length },
            items: [...legacyIssue, ...items], total: projected.total + legacyIssue.length, nextCursor: projected.nextCursor, ...(projected.report ? { report: projected.report } : {}) };
    }

    continuityForDirector(id: string, director: NonNullable<EpisodeProductionData["director"]>, snapshot: "draft" | "published" = "draft") {
        const current = this.get(id);
        const formal = snapshot === "published" ? current.published?.director : current.draft.director;
        if (!formal || formal.sourceHash !== director.sourceHash) {
            return { status: "stale", sourceHash: director.sourceHash, runtime: director.engine, report: null };
        }
        return this.getContinuity(id, { snapshot, view: "summary" });
    }

    continuityUpgradeActiveRuns(id: string) {
        const batches = this.listBatches(id).filter(batch => ["pending", "running", "paused", "awaiting_review"].includes(batch.status))
            .map(batch => ({ runId: batch.runId, status: batch.status, targets: batch.targets }));
        const legacyRuns = this.pendingRuns().filter(run => run.episodeId === id)
            .map(run => ({ runId: run.runId || `legacy-v${run.version}`, status: run.status, targets: run.targets || run.plan.clipGroupIds }));
        const nativeTasks = this.db.db.prepare(`SELECT b.task_id, b.targets_json, t.status FROM production_task_bindings b
            JOIN tasks t ON t.id=b.task_id WHERE b.owner_kind=? AND b.owner_id=? AND b.status='submitted'
            AND t.status IN ('queued','running','awaiting_confirmation')`).all(this.ownerKind, id) as Array<{ task_id: string; targets_json: string; status: string }>;
        const active = [...batches, ...legacyRuns, ...nativeTasks.map(task => ({ runId: task.task_id, status: task.status, targets: JSON.parse(task.targets_json) }))];
        return active.filter((run, index) => active.findIndex(item => item.runId === run.runId) === index);
    }

    checkContinuity(id: string, raw: unknown): Record<string, any> {
        const linked = this.linked(id); if (linked) return linked.service.checkContinuity(linked.id, raw);
        const input = productionContinuityCheckSchema.parse(raw);
        const owner = { kind: this.ownerKind, id };
        const requestHash = fingerprint({ owner, snapshot: input.snapshot, targetIds: input.targetIds || [] });
        const reports = this.continuityReports();
        const prior = reports.operation(owner, input.operationId);
        if (prior) {
            if (prior.requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT: operationId 已用于不同连续性检查");
            return { ...prior.result, replayed: true };
        }
        const current = this.get(id);
        if (current.revision !== input.expectedRevision) throw new ProductionConflictError(current);
        const selected = input.snapshot === "published" ? current.published : current.draft;
        const director = selected?.director;
        if (!director) throw new Error("CONTINUITY_SOURCE_MISSING: 缺少正式 Acheng 制作稿");
        const legacy = director.source.ledger && (director.source.ledger as any).contract_version !== 2;
        const segments = new Set(((director.source.segments || []) as any[]).map(item => String(item.id || "")));
        if ((input.targetIds || []).some(target => !segments.has(target))) throw new Error("连续性检查目标必须属于当前制作稿 Segment");
        const engineReport = auditAchengContinuity(director, input.targetIds, Boolean(legacy));
        const report = { ...engineReport, verdict: legacy ? "diagnosticOnly" : engineReport.status, owner, snapshot: input.snapshot, snapshotVersion: current.publishedVersion, sourceHash: director.sourceHash,
            runtimeId: engineReport.validatorRuntimeId, engine: engineReport.validatorEngine, revision: current.revision, checkedAt: new Date().toISOString(), operationId: input.operationId,
            selectedTargets: input.targetIds || (segments.size ? [...segments] : []) };
        const persisted = reports.persist(owner, input.operationId, requestHash, report);
        this.events?.publish({ type: "drama-production.updated", entityId: id, payload: { revision: current.revision, continuitySourceHash: director.sourceHash, continuitySnapshot: input.snapshot } });
        return { ...persisted, revision: current.revision };
    }

    previewContinuityUpgrade(id: string, raw: unknown): Record<string, any> {
        const linked = this.linked(id); if (linked) return linked.service.previewContinuityUpgrade(linked.id, raw);
        const input = productionContinuityUpgradePreviewSchema.parse(raw);
        const current = this.get(id);
        if (current.revision !== input.expectedRevision) throw new ProductionConflictError(current);
        const director = current.draft.director;
        if (!director) throw new Error("CONTINUITY_SOURCE_MISSING: 缺少正式 Acheng 制作稿");
        if (director.sourceHash !== input.fromSourceHash) throw new Error("CONTINUITY_UPGRADE_PREVIEW_STALE: 回读当前源稿后重新预览");
        if ((director.source.ledger as any)?.contract_version === 2) throw new Error("连续性账本已经升级到 v2");
        if (input.ledger.contract_version !== 2) throw new Error("升级预览必须明确声明 contract_version: 2");
        const target = resolveAchengEngine();
        const targetEngine = { commit: target.commit, patchVersion: target.patchVersion, runtimeId: target.runtimeId, version: target.version };
        const candidate = structuredClone(director);
        candidate.source = { ...candidate.source, legacyContinuityProjection: candidate.source.ledger ?? null, ledger: structuredClone(input.ledger) };
        candidate.engine = targetEngine;
        candidate.sourceHash = directorHash(candidate.source);
        const report = auditAchengContinuity(candidate);
        const previewHash = fingerprint({ owner: { kind: this.ownerKind, id }, expectedRevision: current.revision,
            fromSourceHash: director.sourceHash, targetRuntimeId: target.runtimeId, ledger: input.ledger });
        const activeRuns = this.continuityUpgradeActiveRuns(id);
        const affectedTargets = Array.isArray(director.source.segments) ? director.source.segments.map((item: any) => String(item.id || "")) : [];
        return { owner: { kind: this.ownerKind, id }, revision: current.revision, fromSourceHash: director.sourceHash,
            fromRuntime: director.engine, targetRuntime: targetEngine, previewHash, candidateSourceHash: candidate.sourceHash,
            migrationClass: "retained_legacy_projection",
            changeClassification: { equivalentConversions: [], historicalProjection: director.source.ledger ? ["legacyContinuityProjection"] : [],
                semanticGaps: report.diagnostics || [], speculativeSuggestions: [] },
            report, affectedTargets,
            activeRuns };
    }

    bindCanvasTaskResult(id: string, taskId: string, target: { projectId: string; nodeId: string; kind: string; targets: Array<{ targetId: string; segmentId?: string; inputHash?: string; controlHash?: string }> }): ProductionRecord {
        const linked = this.linked(id); if (linked) return linked.service.bindCanvasTaskResult(linked.id, taskId, target);
        const task = this.db.getTask(taskId), current = this.get(id), project = this.db.getCanvasProject(target.projectId);
        if (!task || task.status !== "succeeded" || !project || this.episodeInfo(id).canvasId !== project.id) throw new Error("任务归属或状态无效");
        if (task.projectId !== target.projectId || task.nodeId !== target.nodeId) throw new Error("任务与目标节点归属不一致");
        const actualOutputs = [...task.outputs, ...(Array.isArray(task.result?.media) ? task.result.media as any[] : []), ...(task.result?.storageKey ? [{ storageKey: task.result.storageKey }] : [])];
        if (!actualOutputs.some(output => {
            const media = output.storageKey && this.db.getMediaFile(String(output.storageKey));
            return media && fs.existsSync(media.filePath) && fs.statSync(media.filePath).size > 0 && media.mimeType.startsWith(target.kind === "segment" ? "video/" : "image/");
        })) throw new Error("成功任务缺少对应类型的真实归档媒体");
        const defaults = this.db.canvasEditorDefaults(target.projectId);
        return this.commit(id, `canvas-result:${taskId}`, current.revision, fingerprint({ taskId, target }), record => {
            const draft = structuredClone(record.draft), node = (project.nodes as any[]).find(node => node.id === target.nodeId);
            const outputs = [...task.outputs, ...(Array.isArray(task.result?.media) ? task.result.media as any[] : [])];
            for (const item of target.targets) {
                let outdated = true;
                try { outdated = (item.controlHash || item.inputHash) !== inputHash(effectiveTargetInput(project, target.nodeId, item.segmentId, defaults)); } catch { /* Deleted target retains task history. */ }
                if (item.segmentId) {
                    const group = draft.clipGroups.find(group => group.id === item.targetId);
                    if (group) group.inputOutdated = outdated;
                } else {
                    const assetId = target.kind === "keyframe" ? draft.director?.shotInputs[item.targetId]?.keyframeAssetId : item.targetId;
                    const key = String(outputs.find(output => output.storageKey)?.storageKey || task.result?.storageKey || "");
                    const media = key && this.db.getMediaFile(key);
                    if (assetId && draft.director?.assets[assetId] && media) {
                        Object.assign(draft.director.assets[assetId], { inputOutdated: outdated });
                        if (!outdated) Object.assign(draft.director.assets[assetId], { storageKey: key, sha256: promptHashBytes(media.filePath), status: "generated", evidence: "", generationTaskId: taskId });
                    }
                }
            }
            return { ...record, draft, revision: record.revision + 1, updatedAt: new Date().toISOString() };
        });
    }

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

    layoutPlan(id: string): ProductionLayoutPlan | null {
        const linked = this.linked(id); if (linked) return linked.service.layoutPlan(linked.id);
        const canvasId = this.episodeInfo(id).canvasId;
        return canvasId ? this.db.getProductionLayoutPlan(canvasId) : null;
    }

    preparationLayout(operationId: string): ReturnType<BackendDatabase["getProductionPreparationLayout"]> { return this.db.getProductionPreparationLayout(operationId); }

    ensureLayoutPlan(id: string, production = this.get(id), project = this.db.getCanvasProject(this.episodeInfo(id).canvasId || "")): ProductionLayoutPlan {
        const linked = this.linked(id); if (linked) return linked.service.ensureLayoutPlan(linked.id, production, project);
        if (!production.draft.director || !project) throw new Error("布局编译缺少正式制作稿或画布快照");
        const canvasId = this.episodeInfo(id).canvasId;
        if (!canvasId) throw new Error("制作对象尚未关联画布");
        const owner = { kind: this.ownerKind, id };
        const plan = compileProductionLayout({ h3Defaults: record(this.db.getSetting("plugin:minimax-h3:defaults:v1")), canvasId, owner, production: production.draft, project, previous: this.db.getProductionLayoutPlan(canvasId) });
        this.db.saveProductionLayoutPlan(canvasId, plan);
        return plan;
    }

    freezePreparationLayout(id: string, operationId: string, projectRevision: number, plan: ProductionLayoutPlan, receipt: ProductionLayoutReceipt): ReturnType<BackendDatabase["freezeProductionPreparationLayout"]> {
        const linked = this.linked(id); if (linked) return linked.service.freezePreparationLayout(linked.id, operationId, projectRevision, plan, receipt);
        const canvasId = this.episodeInfo(id).canvasId;
        if (!canvasId) throw new Error("制作对象尚未关联画布");
        return this.db.freezeProductionPreparationLayout(operationId, projectRevision, plan, receipt);
    }

    beginPreparation(id: string, operationId: string, request: unknown, validateFresh?: () => void): { bindings?: Record<string, unknown>[]; receipt?: ProductionRecord & { layoutReceipt?: ProductionLayoutReceipt } } {
        const ownerKey = `${this.ownerKind}:${id}`;
        const hash = fingerprint(request);
        const row = this.db.db.prepare("SELECT * FROM production_preparations WHERE operation_id=?").get(operationId) as Record<string, any> | undefined;
        if (row) {
            if (row.owner_key !== ownerKey || row.request_hash !== hash) throw new Error("operationId 已用于不同的节点准备请求");
            return { ...(row.bindings_json ? { bindings: JSON.parse(row.bindings_json) } : {}), ...(row.receipt_json ? { receipt: JSON.parse(row.receipt_json) } : {}) };
        }
        validateFresh?.();
        this.db.db.prepare("INSERT INTO production_preparations (operation_id, owner_key, request_hash) VALUES (?, ?, ?)").run(operationId, ownerKey, hash);
        return {};
    }
    commitPreparation(id: string, operationId: string, expectedRevision: number, bindings: Record<string, unknown>[], layoutReceipt?: ProductionLayoutReceipt, layoutPlan?: ProductionLayoutPlan, canvasPreparation?: { projectId: string; expectedCanvasRevision: number; operationId: string; operations: CanvasOperation[] }, referenceSync?: ReferenceSync[]): ProductionRecord & { replayed?: boolean; layoutReceipt?: ProductionLayoutReceipt } {
        this.db.db.prepare("UPDATE production_preparations SET bindings_json=? WHERE operation_id=?").run(JSON.stringify(bindings), operationId);
        const frozen = layoutReceipt || this.db.getProductionPreparationLayout(operationId)?.receipt as ProductionLayoutReceipt | undefined;
        const frozenPlan = layoutPlan || this.db.getProductionPreparationLayout(operationId)?.plan;
        const canvasId = this.episodeInfo(id).canvasId;
        let completedResponse: ProductionRecord & { replayed?: boolean; layoutReceipt?: ProductionLayoutReceipt } | undefined;
        const finishReceipt = (record: ProductionRecord & { replayed?: boolean }) => {
            const completed = frozen && canvasId ? { ...frozen, canvasRevision: this.db.getCanvasProjectRevision(canvasId) || frozen.canvasRevision } : frozen;
            const response = { ...record, ...(completed ? { layoutReceipt: completed } : {}), ...(referenceSync ? { referenceSync } : {}) };
            this.db.db.prepare("UPDATE production_preparations SET receipt_json=? WHERE operation_id=?").run(JSON.stringify(response), operationId);
            completedResponse = response;
            return response;
        };
        const result = bindings.length ? this.edit(id, { operationId, expectedRevision, ops: bindings }, canvasPreparation, false, finishReceipt) : this.get(id);
        const projectionLayout = frozenPlan || (result.draft.director ? this.ensureLayoutPlan(id, result) : undefined);
        if (!bindings.length && canvasPreparation) {
            const canvasCommits: CanvasCommit[] = [];
            this.db.db.exec("BEGIN IMMEDIATE");
            try {
                const latestProject = this.db.getCanvasProject(canvasPreparation.projectId);
                if (!latestProject) throw new Error("布局准备画布不存在");
                if (this.db.getCanvasProjectRevision(canvasPreparation.projectId) !== canvasPreparation.expectedCanvasRevision) throw new Error("画布版本已变化，按同一 operationId 回读并恢复布局准备");
                if (canvasPreparation.operations.length) this.db.applyCanvasProjectOperations(canvasPreparation.projectId, canvasPreparation.expectedCanvasRevision, canvasPreparation.operations,
                    { operationId: canvasPreparation.operationId, runtimeWrite: true, withinTransaction: true, deferredCommits: canvasCommits, source: { kind: "system", clientId: "production:layout", label: "准备制作布局" } });
                const projectedProject = this.db.getCanvasProject(canvasPreparation.projectId)!;
                const scriptOps = [...scriptNodeOperations(projectedProject, result.draft, { kind: this.ownerKind, id }, result.draft, frozenPlan), ...(projectionLayout ? imageInputOperations(projectedProject, result.draft, id, result.draft, projectionLayout) : [])];
                if (scriptOps.length) this.db.applyCanvasProjectOperations(canvasPreparation.projectId, Number(projectedProject.revision || 0), scriptOps,
                    { operationId: `${operationId}:scripts`, runtimeWrite: true, withinTransaction: true, deferredCommits: canvasCommits, source: { kind: "system", clientId: "production:scripts", label: "准备剧本文本节点" } });
                const updatedProject = this.db.getCanvasProject(canvasPreparation.projectId)!;
                if (result.draft.director) this.db.saveProductionLayoutPlan(canvasPreparation.projectId, compileProductionLayout({ h3Defaults: record(this.db.getSetting("plugin:minimax-h3:defaults:v1")), canvasId: canvasPreparation.projectId, owner: { kind: this.ownerKind, id }, production: result.draft, project: updatedProject, previous: frozenPlan || null }));
                finishReceipt(result);
                this.db.db.exec("COMMIT");
                canvasCommits.forEach(commit => this.db.notifyCanvasCommit(commit));
            } catch (error) { this.db.db.exec("ROLLBACK"); throw error; }
        } else if (!bindings.length) {
            if (result.revision !== expectedRevision) throw new ProductionConflictError(result);
            const canvas = canvasId && this.db.getCanvasProject(canvasId);
            if (canvas) {
                const operations = [...scriptNodeOperations(canvas, result.draft, { kind: this.ownerKind, id }, result.draft, frozenPlan), ...(projectionLayout ? imageInputOperations(canvas, result.draft, id, result.draft, projectionLayout) : [])];
                if (operations.length) this.db.applyCanvasProjectOperations(canvasId!, Number(canvas.revision || 0), operations, { operationId: `${operationId}:scripts`, runtimeWrite: true, source: { kind: "system", clientId: "production:scripts", label: "准备剧本文本节点" } });
            }
        }
        return completedResponse || finishReceipt(result);
    }

    previewSharedAssetPromotion(id: string, assetId: string, expectedRevision: number) {
        if (this.ownerKind !== "episode") throw new Error("当前仅支持从分集预览已有素材的共享接入");
        const episode = this.db.getDramaEpisode(id);
        if (!episode?.canvasId || !episode.dramaId) throw new Error("分集尚未绑定剧目画布");
        const current = this.get(id);
        if (current.revision !== expectedRevision) throw new ProductionConflictError(current);
        const published = current.published;
        const director = published?.director;
        if (!director || current.publishedVersion < 1) throw new Error("接入共享画布前须先发布包含该资产的分集制作稿");
        const plan = (Array.isArray(director.source.asset_plan) ? director.source.asset_plan : []).map(record).find(item => String(item.asset_id || item.id || "") === assetId);
        if (!plan) throw new Error(`资产 ${assetId} 未登记到正式源稿`);
        if (String(plan.canvas_scope || "episode") !== "shared") throw new Error(`资产 ${assetId} 尚未标记为剧目共享`);
        if (Object.values(director.shotInputs).some(input => input.keyframeAssetId === assetId)) throw new Error("镜头关键帧属于本集，不能接入剧目共享资产");
        const asset = director.assets[assetId];
        if (!asset || asset.status !== "approved" || !asset.evidence?.trim() || asset.inputOutdated) throw new Error("只有当前发布版本中已审核、输入有效的资产可以接入共享画布");
        const sourceProject = this.db.getCanvasProject(episode.canvasId);
        const sourceNode = (sourceProject?.nodes as Record<string, any>[] | undefined)?.find(node => node.id === asset.nodeId);
        const meta = record(sourceNode?.metadata);
        const storageKey = String(asset.storageKey || resolveCanvasImageReferenceNode(sourceNode || {})[0]?.storageKey || meta.storageKey || meta.resultStorageKey || sourceNode?.content || "");
        if (!sourceNode || !storageKey || !JSON.stringify(sourceNode).includes(storageKey)) throw new Error("原分集节点未绑定待接入媒体");
        if (!["image", "character", "scene"].includes(String(sourceNode.type)) && !(sourceNode.type === "config" && meta.generationMode === "image")) throw new Error("只有正式图片、角色或场景资产可以接入共享画布");
        const media = this.db.getMediaFile(storageKey);
        if (!media || !fs.existsSync(media.filePath)) throw new Error("原归档媒体不存在或不可访问");
        const sha256 = promptHashBytes(media.filePath);
        if (sha256 !== asset.sha256) throw new Error("原归档媒体摘要与已审核版本不一致");
        const drama = this.db.listCanvasFolders().find(item => item.id === episode.dramaId && item.isDrama);
        if (!drama) throw new Error("剧目不存在");
        const approved = listApprovedSharedAssets(this.db, episode.dramaId).find(item => item.assetId === assetId);
        if (approved && (approved.storageKey !== storageKey || approved.sha256 !== sha256)) throw new Error("共享画布已存在其他媒体版本；先处理当前批准版本，再接入新来源");
        const sharedCanvasId = drama.sharedAssetCanvasId || null;
        const sharedProject = sharedCanvasId ? this.db.getCanvasProject(sharedCanvasId) : null;
        if (sharedCanvasId && !sharedProject) throw new Error("固定共享资产画布不存在，请恢复原画布");
        const targetNodeId = `shared-import-${crypto.createHash("sha256").update([episode.dramaId, assetId, storageKey, sha256].join("\0")).digest("hex").slice(0, 24)}`;
        return {
            episodeId: id, episodeRevision: current.revision, publishedVersion: current.publishedVersion, sourceHash: director.sourceHash,
            sourceCanvasId: episode.canvasId, sourceCanvasRevision: Number(sourceProject?.revision || 0), sourceNodeId: String(sourceNode!.id), assetId,
            assetName: String(plan.asset_name || plan.name || plan.title || sourceNode!.title || assetId), storageKey, sha256,
            evidence: asset.evidence, sourceGenerationTaskId: String(record(asset.selectedResult).taskId || meta.runtimeTaskId || ""),
            dramaId: episode.dramaId, sharedCanvasId, sharedCanvasRevision: sharedProject ? Number(sharedProject.revision || 0) : null,
            targetNodeId, approvedId: approved?.id || null, eligible: true as const,
        };
    }

    promoteExistingSharedAsset(id: string, input: { assetId: string; expectedRevision: number; expectedSourceCanvasRevision: number; expectedSharedCanvasRevision: number | null; operationId: string }) {
        if (this.ownerKind !== "episode") throw new Error("当前仅支持从分集接入已有共享素材");
        if (!input.operationId.trim()) throw new Error("共享接入缺少稳定 operationId");
        const preview = this.previewSharedAssetPromotion(id, input.assetId, input.expectedRevision);
        if (preview.sourceCanvasRevision !== input.expectedSourceCanvasRevision) throw new Error("分集画布已变化，请重新预览接入来源");
        if (preview.approvedId) return { approvedId: preview.approvedId, canvasId: preview.sharedCanvasId, nodeId: preview.targetNodeId, replayed: true };
        const ensured = ensureProductionCanvas(this.db, "shared-assets", preview.dramaId, this.events);
        if (preview.sharedCanvasId ? ensured.project.id !== preview.sharedCanvasId : !ensured.created) throw new Error("共享资产画布状态已变化，请重新预览接入目标");
        const sharedCanvasId = ensured.project.id;
        const expectedSharedRevision = preview.sharedCanvasRevision ?? 0;
        if (preview.sharedCanvasRevision !== null && input.expectedSharedCanvasRevision !== preview.sharedCanvasRevision || preview.sharedCanvasRevision === null && input.expectedSharedCanvasRevision !== null) {
            throw new Error("共享资产画布版本已变化，请重新预览接入目标");
        }
        const canvasCommits: CanvasCommit[] = [];
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.get(id);
            if (current.revision !== input.expectedRevision || current.publishedVersion !== preview.publishedVersion || current.published?.director?.sourceHash !== preview.sourceHash) throw new ProductionConflictError(current);
            if (this.db.getCanvasProjectRevision(preview.sourceCanvasId) !== preview.sourceCanvasRevision) throw new Error("分集画布已变化，请重新预览接入来源");
            if (this.db.getCanvasProjectRevision(sharedCanvasId) !== expectedSharedRevision) throw new Error("共享资产画布版本已变化，请重新预览接入目标");
            const latest = listApprovedSharedAssets(this.db, preview.dramaId).find(item => item.assetId === input.assetId);
            if (latest && (latest.storageKey !== preview.storageKey || latest.sha256 !== preview.sha256)) throw new Error("共享画布已批准更新版本，拒绝接入旧媒体；请重新读取并采用当前版本");
            const episode = this.db.getDramaEpisode(id)!;
            const director = current.published!.director!;
            const asset = director.assets[input.assetId]!;
            const sourceNode = (this.db.getCanvasProject(preview.sourceCanvasId)!.nodes as Record<string, any>[]).find(node => node.id === preview.sourceNodeId)!;
            const targetProject = this.db.getCanvasProject(sharedCanvasId)!;
            const prior = (targetProject.nodes as Record<string, any>[]).find(node => node.id === preview.targetNodeId);
            const priorOrigin = record(record(prior?.metadata).sharedPromotionOrigin);
            if (prior && (priorOrigin.episodeId !== id || priorOrigin.assetId !== input.assetId || priorOrigin.storageKey !== preview.storageKey || priorOrigin.sha256 !== preview.sha256)) throw new Error("共享画布已有身份冲突节点，拒绝覆盖");
            const sourceMeta = record(sourceNode.metadata);
            const importedEvidence = `沿用已审核分集素材；来源分集 ${id} v${preview.publishedVersion}，原节点 ${preview.sourceNodeId}，原媒体 ${preview.storageKey}，SHA-256 ${preview.sha256}${preview.sourceGenerationTaskId ? `，原任务 ${preview.sourceGenerationTaskId}` : ""}。原审核：${asset.evidence}`;
            const sharedPromotionOrigin = { episodeId: id, sourceCanvasId: preview.sourceCanvasId, sourceNodeId: preview.sourceNodeId, sourceVersion: preview.publishedVersion,
                sourceGenerationTaskId: preview.sourceGenerationTaskId, sourceStorageKey: preview.storageKey, sourceSha256: preview.sha256 };
            const metadata = {
                ...(sourceNode.type === "character" ? {
                    characterName: sourceMeta.characterName || sourceNode.title || preview.assetName,
                    characterDescription: sourceMeta.characterDescription || "",
                    characterEnglishName: sourceMeta.characterEnglishName || "",
                    characterImages: (Array.isArray(sourceMeta.characterImages) ? sourceMeta.characterImages : []).filter((image: any) => image?.storageKey === preview.storageKey),
                    characterPrimaryIndex: 0,
                } : sourceNode.type === "scene" ? {
                    sceneDescription: sourceMeta.sceneDescription || sourceMeta.description || "",
                } : {}),
                storageKey: preview.storageKey, naturalWidth: this.db.getMediaFile(preview.storageKey)?.width || 0, naturalHeight: this.db.getMediaFile(preview.storageKey)?.height || 0,
                mimeType: this.db.getMediaFile(preview.storageKey)?.mimeType || "image/png", productionAssetId: input.assetId, sharedPromotionOrigin,
            };
            const operations = prior ? [] : [{ type: "add_node", id: preview.targetNodeId, nodeType: sourceNode.type === "config" ? "image" : sourceNode.type, title: preview.assetName,
                position: productionAssetPosition(targetProject.nodes as Record<string, any>[], [input.assetId], input.assetId), width: Number(sourceNode.width || 340), height: Number(sourceNode.height || 260),
                content: preview.storageKey, metadata } as CanvasOperation];
            const result = operations.length ? this.db.applyCanvasProjectOperations(sharedCanvasId, expectedSharedRevision, operations, { operationId: input.operationId, runtimeWrite: true, withinTransaction: true, deferredCommits: canvasCommits,
                source: { kind: "system", clientId: "production:shared-promotion", label: "接入已审核的共享资产" } }) : { duplicated: false };
            const promotedDirector = structuredClone(director);
            promotedDirector.assets[input.assetId] = { ...asset, nodeId: preview.targetNodeId, storageKey: preview.storageKey, sha256: preview.sha256,
                version: String((Array.isArray(director.source.asset_plan) ? director.source.asset_plan : []).map(record).find(item => String(item.asset_id || item.id) === input.assetId)?.version || asset.version),
                status: "approved", evidence: importedEvidence, inputOutdated: false };
            registerApprovedSharedAsset(this.db, sharedCanvasId, Math.max(1, preview.publishedVersion), input.assetId, promotedDirector);
            this.db.db.exec("COMMIT");
            canvasCommits.forEach(commit => this.db.notifyCanvasCommit(commit));
            this.events?.publish({ type: "drama-production.updated", entityId: id, payload: { sharedAssetPromotion: input.assetId } });
            return { approvedId: listApprovedSharedAssets(this.db, episode.dramaId).find(item => item.assetId === input.assetId)?.id || "", canvasId: sharedCanvasId,
                nodeId: preview.targetNodeId, replayed: Boolean(result.duplicated), mediaSubmitted: false };
        } catch (error) { try { this.db.db.exec("ROLLBACK"); } catch { /* Preserve the original failure after a completed transaction. */ } throw error; }
    }

    /** 归属切到剧目共享后自动迁移：发布版本里 scope=shared 且素材已审核时直接接入共享画布，失败只广播不阻断触发动作。 */
    private autoPromoteSharedAssets(episodeId: string, assetIds?: string[]) {
        if (this.ownerKind !== "episode" || this.projectScope) return;
        const current = this.get(episodeId);
        const director = current.published?.director;
        if (!director) return;
        const plans = (Array.isArray(director.source.asset_plan) ? director.source.asset_plan : []).map(record);
        const wanted = new Set(assetIds?.length ? assetIds : plans.map(item => String(item.asset_id || item.id || "")));
        for (const assetId of wanted) {
            if (!assetId) continue;
            const plan = plans.find(item => String(item.asset_id || item.id || "") === assetId);
            if (!plan || String(plan.canvas_scope || "episode") !== "shared") continue;
            if (director.assets[assetId]?.sharedSource) continue;
            try {
                const preview = this.previewSharedAssetPromotion(episodeId, assetId, current.revision);
                if (preview.approvedId) continue;
                this.promoteExistingSharedAsset(episodeId, { assetId, expectedRevision: preview.episodeRevision,
                    expectedSourceCanvasRevision: preview.sourceCanvasRevision, expectedSharedCanvasRevision: preview.sharedCanvasRevision,
                    operationId: `shared-auto-promote:${crypto.createHash("sha256").update([episodeId, assetId, preview.sha256].join("\0")).digest("hex").slice(0, 24)}` });
            } catch (error) {
                this.events?.publish({ type: "drama-production.updated", entityId: episodeId,
                    payload: { sharedAssetAutoPromote: { assetId, error: error instanceof Error ? error.message : String(error) } } });
            }
        }
    }

    sharedAssets(id: string): { assets: ApprovedSharedAsset[]; versions: ApprovedSharedAsset[]; updates: Record<string, unknown>[] } {
        const linked = this.linked(id); if (linked) return linked.service.sharedAssets(linked.id);
        const canvasId = this.episodeInfo(id).canvasId;
        const context = canvasId ? productionCanvasContext(this.db, canvasId) : undefined;
        const updates = this.ownerKind === "canvas" ? []
            : this.db.db.prepare("SELECT id, approved_id AS approvedId, target_asset_id AS assetId, status, error FROM drama_asset_adoptions WHERE episode_id=? ORDER BY rowid DESC").all(id);
        return { assets: context?.dramaId ? listApprovedSharedAssets(this.db, context.dramaId) : [], versions: context?.dramaId ? sharedAssetHistory(this.db, context.dramaId) : [], updates };
    }

    adoptSharedAsset(id: string, input: { assetId: string; approvedId: string; expectedRevision: number; operationId: string }): ProductionRecord & { replayed?: boolean; impact?: ProductionImpact } {
        const linked = this.linked(id); if (linked) return linked.service.adoptSharedAsset(linked.id, input);
        if (this.ownerKind !== "episode") throw new Error("共享资产采用目前仅支持剧目分集，场次级采用链尚未启用");
        const prior = this.prepare("SELECT receipt_json FROM episode_production_operations WHERE operation_id=?").get(input.operationId) as { receipt_json: string } | undefined;
        if (prior) {
            const priorRecord = JSON.parse(prior.receipt_json) as ProductionRecord;
            const nodeId = priorRecord.draft.director?.assets[input.assetId]?.nodeId || sharedProjectionNodeId(id, input.assetId);
            return this.edit(id, { operationId: input.operationId, expectedRevision: input.expectedRevision,
                ops: [{ type: "adopt_shared_asset", assetId: input.assetId, approvedId: input.approvedId, nodeId }] });
        }
        const current = this.get(id);
        if (current.revision !== input.expectedRevision) throw new ProductionConflictError(current);
        const previousLayout = this.ensureLayoutPlan(id, current);
        const episodeCanvasId = this.episodeInfo(id).canvasId;
        const canvas = episodeCanvasId && this.db.getCanvasProject(episodeCanvasId);
        if (!canvas || !current.draft.director) throw new Error("共享资产采用缺少正式制作画布或源稿");
        const planned = structuredClone(current.draft);
        const targetPlan = (Array.isArray(planned.director!.source.asset_plan) ? planned.director!.source.asset_plan : []).find((item: any) => String(item.asset_id || item.id) === input.assetId) as Record<string, any> | undefined;
        if (!targetPlan) throw new Error(`正式资产计划中不存在 ${input.assetId}`);
        targetPlan.canvas_scope = "shared";
        const layout = compileProductionLayout({ h3Defaults: record(this.db.getSetting("plugin:minimax-h3:defaults:v1")), canvasId: episodeCanvasId!, owner: { kind: "episode", id }, production: planned, project: canvas, previous: previousLayout });
        const layoutUnit = layout.units.find(unit => unit.targets.includes(`asset:${input.assetId}`) && unit.members.some(member => member.role === "asset"));
        const layoutNodeId = layoutUnit?.members.find(member => member.role === "asset")?.nodeId;
        if (!layoutUnit || !layoutNodeId) throw new Error(`共享资产 ${input.assetId} 缺少正式布局预留`);
        const request = { operationId: input.operationId, expectedRevision: input.expectedRevision,
            ops: [{ type: "adopt_shared_asset", assetId: input.assetId, approvedId: input.approvedId, nodeId: layoutNodeId }] };
        if (this.prepare("SELECT 1 FROM episode_production_operations WHERE operation_id=?").get(input.operationId)) return this.edit(id, request);
        const approved = approvedSharedAsset(this.db, input.approvedId);
        if (listApprovedSharedAssets(this.db, approved.dramaId).find(asset => asset.assetId === approved.assetId)?.id !== approved.id) throw new Error("共享资产已有更新批准版本，请回读后采用");
        const episode = this.db.getDramaEpisode(id);
        if (episode?.dramaId !== approved.dramaId || !current.draft.director || !(Array.isArray(current.draft.director.source.asset_plan) ? current.draft.director.source.asset_plan : []).some((item: any) => String(item.asset_id || item.id) === input.assetId)) throw new Error("共享资产或目标不属于当前制作");
        this.validateSource(current.draft.director, "edit");
        this.validateGraph(current.draft);
        prepareSharedAssetProjection(this.db, id, input.assetId, input.approvedId, layout);
        return this.edit(id, request);
    }

    adoptSharedAssets(id: string, input: { assets: Array<{ assetId: string; approvedId: string }>; expectedRevision: number; operationId: string }): ProductionRecord & { replayed?: boolean; impact?: ProductionImpact } {
        const linked = this.linked(id); if (linked) return linked.service.adoptSharedAssets(linked.id, input);
        if (this.ownerKind !== "episode") throw new Error("共享资产采用目前仅支持剧目分集，场次级采用链尚未启用");
        if (!input.assets.length) throw new Error("批量采用至少需要一个资产");
        if (new Set(input.assets.map(item => item.assetId)).size !== input.assets.length) throw new Error("批量采用资产 ID 不能重复");
        const prior = this.prepare("SELECT receipt_json FROM episode_production_operations WHERE operation_id=?").get(input.operationId) as { receipt_json: string } | undefined;
        if (prior) {
            const priorRecord = JSON.parse(prior.receipt_json) as ProductionRecord;
            const ops = input.assets.map(item => ({ type: "adopt_shared_asset" as const, assetId: item.assetId, approvedId: item.approvedId,
                nodeId: priorRecord.draft.director?.assets[item.assetId]?.nodeId || sharedProjectionNodeId(id, item.assetId) }));
            return this.edit(id, { operationId: input.operationId, expectedRevision: input.expectedRevision, ops });
        }
        const current = this.get(id);
        if (current.revision !== input.expectedRevision) throw new ProductionConflictError(current);
        const previousLayout = this.ensureLayoutPlan(id, current);
        const episodeCanvasId = this.episodeInfo(id).canvasId;
        const canvas = episodeCanvasId && this.db.getCanvasProject(episodeCanvasId);
        if (!canvas || !current.draft.director) throw new Error("共享资产采用缺少正式制作画布或源稿");
        const planned = structuredClone(current.draft);
        const plans = (Array.isArray(planned.director!.source.asset_plan) ? planned.director!.source.asset_plan : []) as Record<string, any>[];
        for (const item of input.assets) {
            const targetPlan = plans.find(entry => String(entry.asset_id || entry.id) === item.assetId);
            if (!targetPlan) throw new Error(`正式资产计划中不存在 ${item.assetId}`);
            targetPlan.canvas_scope = "shared";
        }
        const layout = compileProductionLayout({ h3Defaults: record(this.db.getSetting("plugin:minimax-h3:defaults:v1")), canvasId: episodeCanvasId!, owner: { kind: "episode", id }, production: planned, project: canvas, previous: previousLayout });
        const ops = input.assets.map(item => {
            const layoutUnit = layout.units.find(unit => unit.targets.includes(`asset:${item.assetId}`) && unit.members.some(member => member.role === "asset"));
            const layoutNodeId = layoutUnit?.members.find(member => member.role === "asset")?.nodeId;
            if (!layoutUnit || !layoutNodeId) throw new Error(`共享资产 ${item.assetId} 缺少正式布局预留`);
            return { type: "adopt_shared_asset" as const, assetId: item.assetId, approvedId: item.approvedId, nodeId: layoutNodeId };
        });
        if (this.prepare("SELECT 1 FROM episode_production_operations WHERE operation_id=?").get(input.operationId)) return this.edit(id, { operationId: input.operationId, expectedRevision: input.expectedRevision, ops });
        const episode = this.db.getDramaEpisode(id);
        for (const item of input.assets) {
            const approved = approvedSharedAsset(this.db, item.approvedId);
            if (listApprovedSharedAssets(this.db, approved.dramaId).find(asset => asset.assetId === approved.assetId)?.id !== approved.id) throw new Error(`共享资产 ${item.assetId} 已有更新批准版本，请回读后采用`);
            if (episode?.dramaId !== approved.dramaId || !(Array.isArray(current.draft.director.source.asset_plan) ? current.draft.director.source.asset_plan : []).some((entry: any) => String(entry.asset_id || entry.id) === item.assetId)) throw new Error("共享资产或目标不属于当前制作");
        }
        this.validateSource(current.draft.director, "edit");
        this.validateGraph(current.draft);
        for (const item of input.assets) prepareSharedAssetProjection(this.db, id, item.assetId, item.approvedId, layout);
        return this.edit(id, { operationId: input.operationId, expectedRevision: input.expectedRevision, ops });
    }

    retrySharedUpdate(id: string, adoptionId: string, expectedRevision: number): ReturnType<EpisodeProductionService["sharedAssets"]> {
        const linked = this.linked(id); if (linked) return linked.service.retrySharedUpdate(linked.id, adoptionId, expectedRevision);
        if (this.ownerKind !== "episode") throw new Error("共享资产更新恢复目前仅支持剧目分集，场次级采用链尚未启用");
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

    listArchivedScenes(episodeId: string) {
        const linked = this.linked(episodeId); if (linked) return linked.service.listArchivedScenes(linked.id);
        this.episode(episodeId);
        return listArchivedDirectorScenes(this.db, { kind: this.ownerKind, id: episodeId });
    }

    operationReceipt(id: string, operationId: string): ProductionRecord | undefined {
        const linked = this.linked(id); if (linked) return linked.service.operationReceipt(linked.id, operationId);
        const row = this.prepare("SELECT receipt_json FROM episode_production_operations WHERE episode_id=? AND operation_id=?").get(id, operationId) as { receipt_json: string } | undefined;
        if (!row) return undefined;
        const record = resolveReceiptDedup(JSON.parse(row.receipt_json) as ProductionRecord);
        assertPublicReceipt(record);
        return record;
    }

    validateClipMedia(id: string, director: DirectorProduction, targetId: string): void {
        const linked = this.linked(id); if (linked) return linked.service.validateClipMedia(linked.id, director, targetId);
        const canvasId = this.episodeInfo(id).canvasId;
        if (!canvasId) throw new Error("缺少固定制作画布");
        validateDirectorMedia(this.db, canvasId, director, [targetId]);
    }

    verifyCompilationBindings(id: string, director: DirectorProduction) {
        for (const artifact of director.artifacts) if (artifact.kind === "image" && artifact.status === "ready" && artifact.sourceHash === director.sourceHash) assertImageReferenceCoverage(director, artifact);
        const canvasId = this.episodeInfo(id).canvasId;
        const rawNodes = canvasId ? this.db.getCanvasProject(canvasId)?.nodes : undefined;
        if (!Array.isArray(rawNodes)) throw new Error("Production canvas does not exist");
        const nodes = rawNodes as Array<Record<string, any>>;
        for (const asset of Object.values(director.assets)) validateSharedAssetSource(this.db, canvasId!, asset);
        const bindings = [...Object.values(director.assets), ...director.artifacts.flatMap(a => a.references)];
        const mediaDigests = new Map<string, string>();
        for (const binding of bindings) {
            if (!binding.storageKey) continue;
            const node = nodes.find(n => n.id === binding.nodeId);
            const meta = node?.metadata as Record<string, unknown> | undefined;
            const keys = node ? [...resolveCanvasImageReferenceNode(node).map(r => r.storageKey), (node as any).storageKey, meta?.storageKey, meta?.resultStorageKey] : [];
            if (!node || !keys.includes(binding.storageKey)) throw new Error(`Compilation media is not bound to the production canvas: ${binding.nodeId}`);
            const media = this.db.getMediaFile(binding.storageKey);
            if (!media || !fs.existsSync(media.filePath)) throw new Error(`Compilation reference bytes changed: ${binding.storageKey}`);
            const digest = mediaDigests.get(binding.storageKey) || promptHashBytes(media.filePath);
            mediaDigests.set(binding.storageKey, digest);
            if (digest !== binding.sha256) throw new Error(`Compilation reference bytes changed: ${binding.storageKey}`);
        }
    }

    compilationReferenceFiles(id: string, director: DirectorProduction) {
        this.verifyCompilationBindings(id, director);
        const files: Record<string, string> = {};
        for (const [assetId, asset] of Object.entries(director.assets)) {
            const file = this.db.getMediaFile(asset.storageKey || "")?.filePath;
            if (file) files[`${assetId}\0asset`] = file;
        }
        for (const artifact of director.artifacts) for (const ref of artifact.references) {
            const file = this.db.getMediaFile(ref.storageKey)?.filePath;
            if (file) files[`${artifact.targetId}\0${ref.label}`] = file;
        }
        return files;
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
        const current = this.get(episodeId);
        let record = current;
        if (current.publishedVersion !== version) {
            const frozen = this.version(episodeId, version).snapshot;
            if (!frozen.settings.parallelScenes || !frozen.director || !current.published?.director || !targetIds?.length) throw Object.assign(new Error("Acheng 发布版本已变化"), { code: "VERSION_CHANGED" });
            const scope = { targetIds };
            if (compilationScopeInput(frozen.director, scope).inputHash !== compilationScopeInput(current.published.director, scope).inputHash) throw Object.assign(new Error("当前目标的源稿或引用版本已变化"), { code: "SHARED_ASSET_UPDATE" });
            record = { ...current, published: frozen, publishedVersion: version };
        }
        if (!record.published?.director) throw new Error("缺少正式发布导演稿");
        this.checkEngine(record.published.director.engine);
        const canvasId = this.episodeInfo(episodeId).canvasId;
        if (!canvasId) throw new Error("制作稿未绑定画布");
        const selected = record.published.director.artifacts.filter(item => !targetIds || targetIds.includes(item.targetId));
        const referencedNodes = new Set(selected.flatMap(item => item.references.map(reference => reference.nodeId)));
        for (const asset of Object.values(record.published.director.assets)) if (!targetIds || referencedNodes.has(asset.nodeId || "")) validateSharedAssetSource(this.db, canvasId, asset, true);
        validateDirectorMedia(this.db, canvasId, record.published.director, targetIds);
        const project = this.db.getCanvasProject(canvasId)!;
        for (const artifact of selected) if (artifact.kind === "image" && artifact.status === "ready") {
            const nodeId = record.published.director.assets[artifact.targetId]?.nodeId;
            if (!nodeId) throw new Error(`图像 ${artifact.targetId} 尚未准备正式画布节点`);
            verifyImageInput(project, record.published.director, artifact, nodeId);
        }
    }

    sceneReviewMedia(episodeId: string, targetIds: string[]) {
        const current = this.get(episodeId), director = current.draft.director;
        if (!director) throw new Error("缺少导演源稿");
        return targetIds.map(targetId => {
            const asset = director.assets[targetId];
            if (!asset?.nodeId || !asset.storageKey) throw new Error(`素材 ${targetId} 尚未绑定媒体`);
            const media = this.db.getMediaFile(asset.storageKey);
            if (!media || !fs.existsSync(media.filePath) || !JSON.stringify(this.canvasNode(episodeId, asset.nodeId)).includes(asset.storageKey)) throw new Error(`素材 ${targetId} 的实际归档或节点绑定不一致`);
            const sha256 = promptHashBytes(media.filePath);
            if (sha256 !== asset.sha256) throw new Error(`素材 ${targetId} 的媒体版本已变化`);
            return { targetId, nodeId: asset.nodeId, storageKey: asset.storageKey, sha256, filePath: media.filePath, mimeType: media.mimeType };
        });
    }

    sceneWorkOwners(): string[] {
        return (this.prepare("SELECT episode_id AS owner_id FROM episode_productions WHERE json_extract(draft_json, '$.director.workflow.sceneWorks') IS NOT NULL OR json_extract(draft_json, '$.director.workflow.sharedReviewWorks') IS NOT NULL OR json_extract(draft_json, '$.director.workflow.sharedReviewContinuation') IS NOT NULL").all() as Array<{ owner_id: string }>).map(row => row.owner_id);
    }

    bindDirectorAsset(episodeId: string, version: number, assetId: string, storageKey: string): void {
        const linked = this.linked(episodeId); if (linked) return linked.service.bindDirectorAsset(linked.id, version, assetId, storageKey);
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.get(episodeId);
            if (current.publishedVersion !== version) {
                const baseline = this.version(episodeId, version).snapshot;
                const snapshot = structuredClone(baseline);
                const asset = snapshot.director?.assets[assetId];
                const media = this.db.getMediaFile(storageKey);
                if (!asset?.nodeId || !media || !fs.existsSync(media.filePath) || !JSON.stringify(this.canvasNode(episodeId, asset.nodeId)).includes(storageKey)) throw new Error("历史任务媒体与原节点绑定不一致");
                snapshot.director!.assets[assetId] = { ...asset, storageKey, sha256: promptHashBytes(media.filePath), status: "generated", inputOutdated: false };
                this.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?").run(JSON.stringify(snapshot), episodeId, version);
                this.projectEquivalentHistoricalResult(episodeId, current, baseline, snapshot, version, { assetId, nodeId: asset.nodeId!, storageKey });
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

    /** Opt-in parallel runs may project an unchanged target; origin version and task history remain intact. */
    private projectEquivalentHistoricalResult(id: string, current: ProductionRecord, baseline: EpisodeProductionData, result: EpisodeProductionData, version: number,
        target: { assetId?: string; shotId?: string; groupId?: string; nodeId: string; segmentId?: string; storageKey?: string }) {
        if (!baseline.settings.parallelScenes || !current.published?.settings.parallelScenes || !baseline.director || !current.published.director || !current.draft.director) return;
        const assetId = target.assetId || (target.shotId ? baseline.director.shotInputs[target.shotId]?.keyframeAssetId : undefined);
        const targetId = target.groupId || assetId;
        if (!targetId) return;
        const scope = { targetIds: [targetId] };
        const originHash = compilationScopeInput(baseline.director, scope).inputHash;
        if (compilationScopeInput(current.published.director, scope).inputHash !== originHash || compilationScopeInput(current.draft.director, scope).inputHash !== originHash) return;
        const node = this.canvasNode(id, target.nodeId);
        const segment = target.groupId ? (record(node.metadata).segments as Record<string, any>[] || []).find(item => item.id === target.segmentId) : undefined;
        const activeKey = target.groupId ? String(segment?.resultStorageKey || "") : String(resolveCanvasImageReferenceNode(node)[0]?.storageKey || record(node.metadata).storageKey || "");
        if (target.storageKey && activeKey !== target.storageKey) return;
        const published = structuredClone(current.published), draft = structuredClone(current.draft);
        if (assetId && result.director?.assets[assetId]) {
            const asset = { ...result.director.assets[assetId], resultSourceVersion: version };
            published.director!.assets[assetId] = asset; draft.director!.assets[assetId] = structuredClone(asset);
        }
        if (target.shotId && result.keyframes[target.shotId]) {
            published.keyframes[target.shotId] = result.keyframes[target.shotId]; draft.keyframes[target.shotId] = structuredClone(result.keyframes[target.shotId]);
        }
        if (target.groupId) {
            const original = result.clipGroups.find(item => item.id === target.groupId);
            const fresh = published.clipGroups.find(item => item.id === target.groupId), freshDraft = draft.clipGroups.find(item => item.id === target.groupId);
            if (!original || !fresh || !freshDraft || fresh.nodeId !== original.nodeId || fresh.segmentId !== original.segmentId) return;
            Object.assign(fresh, { sourceVersion: version, inputOutdated: false }); Object.assign(freshDraft, { sourceVersion: version, inputOutdated: false });
        }
        const updatedAt = new Date().toISOString();
        this.prepare("UPDATE episode_productions SET revision=?, draft_json=?, published_json=?, updated_at=? WHERE episode_id=?").run(current.revision + 1, JSON.stringify(draft), JSON.stringify(published), updatedAt, id);
        this.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?").run(JSON.stringify(published), id, current.publishedVersion);
    }

    get(episodeId: string): ProductionRecord {
        const linked = this.linked(episodeId); if (linked) return linked.service.get(linked.id);
        this.episode(episodeId);
        const row = this.prepare("SELECT * FROM episode_productions WHERE episode_id = ?").get(episodeId) as Row | undefined;
        if (row) return this.fromRow(episodeId, row);
        const draft = emptyEpisodeProduction();
        const dramaId = this.projectScope ? undefined : this.db.getDramaEpisode(episodeId)?.dramaId;
        const drama = this.db.listCanvasFolders().find(folder => this.projectScope ? folder.sharedAssetCanvasId === episodeId : folder.id === dramaId);
        const plan = drama?.productionPlan;
        if (plan?.confirmedAt && plan.confirmedOutline === drama?.outline) Object.assign(draft.settings, {
            ...(plan.parallelScenes !== undefined ? { parallelScenes: plan.parallelScenes } : {}),
            ...(plan.reviewPolicy ? { reviewPolicy: structuredClone(plan.reviewPolicy) } : {}),
            imageModel: plan.imageModel, imageModelsByKind: structuredClone(plan.imageModelsByKind), h3Model: plan.h3Model,
            ...(plan.storyboardImageMode ? { storyboardImageMode: plan.storyboardImageMode } : {}),
            ...(plan.videoAspectRatio !== undefined ? { videoAspectRatio: plan.videoAspectRatio, videoAspectRatioConfirmed: true } : {}),
        });
        return { episodeId, revision: 0, draft, published: null, publishedVersion: 0, updatedAt: "" };
    }

    /** Exact live blockers for a directed read, also enforced before committing edits. */
    targetOccupancy(id: string, targetIds: string[]): ProductionTargetOccupancy[] {
        const linked = this.linked(id); if (linked) return linked.service.targetOccupancy(linked.id, targetIds);
        const current = this.get(id);
        const segmentIds = new Set((current.draft.director?.source.segments as any[] || []).map(segment => String(segment.id)));
        const wanted = new Set(targetIds.map(target => target.includes(":") ? target : segmentIds.has(target) ? `segment:${target}` : target));
        const occupied: ProductionTargetOccupancy[] = [];
        for (const batch of this.listBatches(id).filter(batch => ["pending", "running", "paused", "awaiting_review"].includes(batch.status) && !this.rejectedBatchTarget(batch, current.published))) {
            for (const targetId of batch.targets.filter(target => wanted.has(target))) {
                const tasks = batch.submitted.filter(task => `${task.kind === "h3" ? "segment" : "frame"}:${task.id}` === targetId || batch.targets.length === 1).map(task => ({ taskId: task.taskId, status: this.db.getTask(task.taskId)?.status || "unknown" }));
                occupied.push({ targetId, status: batch.status, runId: batch.runId, taskIds: tasks.map(task => task.taskId), tasks,
                    nextAction: { action: batch.status === "awaiting_review" ? "review" : "read_run", message: batch.status === "awaiting_review" ? "读取旧结果并完成审核或按用户决定退回；暂停不会释放目标。" : "读取原运行及精确任务状态，等待在途任务结束；不要换 runId 重提。", tool: "production_get_batch", input: { kind: this.projectScope ? "canvas" : "episode", id: id, runId: batch.runId } } });
            }
        }
        const bindings = this.db.db.prepare(`SELECT b.task_id, b.target_kind, b.targets_json, t.status FROM production_task_bindings b JOIN tasks t ON t.id=b.task_id WHERE b.owner_kind=? AND b.owner_id=? AND b.status='submitted' AND t.status IN ('queued','running','awaiting_confirmation')`).all(this.ownerKind, id);
        for (const binding of bindings) for (const target of JSON.parse(String(binding.targets_json))) {
            const targetId = `${binding.target_kind === "keyframe" ? "frame" : binding.target_kind}:${target.targetId}`;
            const taskId = String(binding.task_id), status = String(binding.status);
            if (wanted.has(targetId) && !occupied.some(item => item.targetId === targetId && item.taskIds.includes(taskId))) occupied.push({ targetId, status, taskIds: [taskId], tasks: [{ taskId, status }], nextAction: { action: "wait", message: "读取精确任务，等待结束或处理原任务的确认请求；不重复提交。", tool: "h3_get_task", input: { taskId } } });
        }
        for (const run of this.pendingRuns().filter(run => run.episodeId === id)) {
            for (const targetId of (run.targets || run.plan.clipGroupIds.map(groupId => `segment:${groupId}`)).filter(target => wanted.has(target))) {
                if (occupied.some(item => item.targetId === targetId && item.runId === run.runId)) continue;
                const tasks = run.submitted.map(task => ({ taskId: task.taskId, status: this.db.getTask(task.taskId)?.status || "unknown" }));
                occupied.push({ targetId, status: run.status, runId: run.runId, taskIds: tasks.map(task => task.taskId), tasks, nextAction: { action: "read_run", message: "读取原版本运行并等待其结束，保留当前输入和媒体。", tool: "production_get_run", input: { kind: this.projectScope ? "canvas" : "episode", id: id, version: run.version } } });
            }
        }
        const canvasId = this.episodeInfo(id).canvasId;
        const nodes = canvasId ? this.db.getCanvasProject(canvasId)?.nodes as any[] || [] : [];
        for (const group of current.draft.clipGroups.filter(group => wanted.has(`segment:${group.id}`))) {
            const nodeClips = record(nodes.find(node => node.id === group.nodeId)?.metadata).segments;
            const clip = (Array.isArray(nodeClips) ? nodeClips : []).find((clip: any) => clip.id === group.segmentId);
            const taskId = String(clip?.runtimeTaskId || ""), task = taskId ? this.db.getTask(taskId) : null;
            const status = task?.status || (clip && ["queued", "running", "loading", "generating", "awaiting_confirmation"].includes(clip.status) ? "unknown" : "");
            if (!["queued", "running", "awaiting_confirmation", "unknown"].includes(status) || occupied.some(item => item.targetId === `segment:${group.id}`)) continue;
            occupied.push({ targetId: `segment:${group.id}`, status, taskIds: taskId ? [taskId] : [], tasks: taskId ? [{ taskId, status }] : [], nextAction: { action: "wait", message: "核对 Clip 与原任务运行态，确认结束后再修改；未知状态不能当作空闲。", tool: "h3_get_clip_runtime", input: { projectId: canvasId, nodeId: group.nodeId, segmentId: group.segmentId } } });
        }
        return occupied;
    }

    preflight(episodeId: string, raw: unknown, compilationRuntimeId?: string): ProductionPreflight {
        const linked = this.linked(episodeId); if (linked) return linked.service.preflight(linked.id, raw, compilationRuntimeId);
        const current = this.get(episodeId);
        const diagnostics = schemaDiagnostics(productionPreflightRequestSchema, raw);
        const result: ProductionPreflight = { valid: false, contractVersion: productionContractVersion, engine: current.draft.director?.engine || null, revision: current.revision, diagnostics, generationReady: false };
        if (diagnostics.length) { result.nextActions = [{ action: "correct_source", message: "按诊断路径修正请求字段后重新预检。" }]; return result; }
        const input = productionPreflightRequestSchema.parse(raw);
        if (input.action === "generate") {
            const prior = this.prepare("SELECT run_id, request_hash FROM episode_production_batches WHERE episode_id=? AND idempotency_key=?").get(episodeId, input.request.idempotencyKey) as { run_id: string; request_hash: string } | undefined;
            if (prior) {
                if (prior.request_hash === batchRequestHash(input.request)) return { ...result, valid: true, generationReady: false, replayed: true, nextActions: [] };
                result.diagnostics.push({ code: "IDEMPOTENCY_CONFLICT", path: "request.idempotencyKey", message: "idempotencyKey 已用于不同生产请求，请读取原运行并核对范围，不能原样重提。", severity: "error", nextAction: { action: "read_run", message: "读取原运行并核对幂等请求。", tool: "production_get_batch", input: { kind: this.projectScope ? "canvas" : "episode", id: episodeId, runId: prior.run_id } } });
                result.nextActions = result.diagnostics.flatMap(item => item.nextAction ? [item.nextAction] : []);
                return result;
            }
        }
        if (input.request.expectedRevision !== current.revision) diagnostics.push({ code: "REVISION_CONFLICT", path: "request.expectedRevision", message: `Current revision is ${current.revision}`, severity: "error", nextAction: { action: "refresh", message: "回读制作对象并核对新 revision 后再提交。", tool: this.projectScope ? "production_get" : "production_get", input: { [this.projectScope ? "projectId" : "episodeId"]: episodeId } } });
        if (input.action === "edit" && input.request.ops.some(operation => operation.type === "restore_archived_scene_results") && input.request.ops.length !== 1) diagnostics.push({ code: "ARCHIVED_RESULT_RESTORE_MIXED", path: "request.ops", message: "归档视频恢复必须单独提交，不能与其他制作编辑混批", severity: "error" });
        if (diagnostics.length) { result.nextActions = diagnostics.flatMap(item => item.nextAction ? [item.nextAction] : []); return result; }
        let candidate = current.draft;
        try {
            if (input.action === "edit") candidate = this.editedCandidate(episodeId, current, input.request).draft;
            else if (input.action === "publish") candidate = this.publishedCandidate(current, input.request.stage, input.request.scope);
            else if (input.action === "compile") {
                if (!current.draft.director) throw new ProductionValidationError([{ code: "COMPILE_STAGE_NOT_READY", path: "director", message: "请先保存正式导演源稿，再准备编译。", severity: "error" }]);
                const director = directorProductionSchema.parse(structuredClone(input.request.director || current.draft.director));
                const referenceFiles = this.compilationReferenceFiles(episodeId, director);
                if (this.checkEngine === assertDirectorEngine) {
                    const checked = preflightCompilationDirector(director, (targetId, label) => referenceFiles[`${targetId}\0${label}`], compilationRuntimeId);
                    if (checked.engine) director.engine = checked.engine;
                    diagnostics.push(...checked.diagnostics.filter(item => item.code !== "ONLINE_CONTEXT_UNVERIFIED"));
                } else if (!(Array.isArray(director.source.asset_cards) && director.source.asset_cards.length) && !(Array.isArray(director.source.segments) && director.source.segments.length)) {
                    diagnostics.push({ code: "COMPILE_STAGE_NOT_READY", path: "director.source.asset_cards", message: "当前只有剧情规划，尚无资产提示词卡或视频段落可编译。", severity: "error" });
                }
                if ((director.source.ledger as any)?.contract_version === 2) {
                    const continuity = this.continuityForDirector(episodeId, director);
                    const targetIds = [...new Set([
                        ...(Array.isArray(director.source.segments) ? director.source.segments.map((segment: any) => String(segment.id || "")) : []),
                        ...director.artifacts.filter(artifact => artifact.kind === "h3").map(artifact => artifact.targetId),
                    ].filter(Boolean))];
                    for (const targetId of targetIds) for (const blocker of continuityTargetBlockers(continuity, [targetId])) diagnostics.push({
                        code: blocker.code, path: `director.segments.${targetId}.continuity`, targetId, message: blocker.message, severity: "warning",
                        nextAction: { action: "correct_source", message: "在连续性工作区补齐覆盖证据或解决本片段问题，再重新检查。" },
                    });
                }
                candidate = { ...current.draft, director };
             } else {
                const checked = this.batchCandidate(episodeId, current, input.request);
                if (checked.executionSnapshot) {
                    const snapshot = checked.executionSnapshot;
                    return { ...result, valid: true, generationReady: true, engine: null, readyTargets: snapshot.targets.map(target => target.id), blockedTargets: snapshot.blockedTargets, warnings: snapshot.warnings, planHash: snapshot.planHash, canvasRevision: snapshot.canvasRevision };
                }
                candidate = current.published!;
            }
            result.engine = candidate.director?.engine || null;
            if (input.action !== "compile" && candidate.director && this.checkEngine === assertDirectorEngine) diagnostics.push(...validateAchengSource(candidate.director, input.action === "edit" ? "edit" : input.action === "publish" ? "publish" : "generate"));
        } catch (error) {
            if (error instanceof ProductionValidationError) diagnostics.push(...error.diagnostics);
            else diagnostics.push({ code: "PRODUCTION_BLOCKED", path: "request", message: error instanceof Error ? error.message : String(error), severity: "error" });
        }
        result.valid = !diagnostics.some(item => item.severity === "error");
        result.generationReady = input.action === "generate" && result.valid && !diagnostics.some(item => item.severity === "unverified");
        result.compileReady = input.action === "compile" && result.valid;
        result.nextActions = diagnostics.filter(item => item.severity === "error").map(item => item.nextAction || { action: item.code === "REVISION_CONFLICT" ? "refresh" : "correct_source", message: item.message,
            tool: "production_get", input: { kind: this.projectScope ? "canvas" : "episode", id: episodeId, view: "source" } });
        return result;
    }

    private validateSource(director: NonNullable<EpisodeProductionData["director"]>, stage: "edit" | "publish" | "generate") {
        // The existing injected engine checker is also used by temporary-data tests.
        // Production instances always verify the immutable runtime.
        this.checkEngine(director.engine);
        if (this.checkEngine === assertDirectorEngine) {
            const candidate = stage === "edit" && isSubjectPromptAssembly(director.source) ? { ...director, artifacts: [] } : director;
            assertAchengSource(candidate, stage);
        }
    }

    workflowReadiness(episodeId: string, source: "draft" | "published" = "draft", runId?: string): DirectorReadiness {
        const baseline = this.formalWorkflowReadiness(episodeId, source, runId);
        if (source === "published") return baseline;
        const data = this.get(episodeId).draft;
        if (!data.director) return baseline;
        const keyframeIds = new Set(Object.values(data.director.shotInputs).map(input => input.keyframeAssetId).filter(Boolean));
        const ids = [...Object.keys(data.director.assets).filter(id => !keyframeIds.has(id)).map(id => `asset:${id}`), ...Object.keys(data.director.shotInputs).filter(id => data.director!.shotInputs[id].keyframeAssetId).map(id => `frame:${id}`), ...data.clipGroups.map(group => `segment:${group.id}`)];
        try {
            const checked = this.canvasExecution(episodeId, ids);
            const ready = new Set(checked.targets.map(target => target.id));
            const dependencyBlocked = new Map(checked.targets.filter(target => target.dependencies.length && data.director!.workflow.mediaProductionMode !== "automatic").map(target => [target.id, target.dependencies.map(dependency => dependency.targetId)]));
            return { ...baseline, targets: ids.map(id => {
                const previous = baseline.targets.find(target => target.id === id);
                return { ...(previous || { id, targetId: id.slice(id.indexOf(":") + 1), kind: id.startsWith("segment:") ? "segment" as const : id.startsWith("frame:") ? "keyframe" as const : "asset" as const, title: id }),
                    status: ready.has(id) && !dependencyBlocked.has(id) ? "ready" as const : "blocked" as const, blockers: [...checked.blockedTargets.filter(target => target.targetId === id).map(target => target.message), ...(dependencyBlocked.has(id) ? [`请先生成前置目标：${dependencyBlocked.get(id)!.join(", ")}`] : [])], notice: "使用当前已保存内容" };
            }) };
        } catch { return baseline; }
    }

    private formalWorkflowReadiness(episodeId: string, source: "draft" | "published" = "draft", runId?: string): DirectorReadiness {
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
            const owner = { kind: this.ownerKind, id: episodeId };
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
        const skipStoryboardImages = data.settings.storyboardImageMode === "skip";
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
        const canvasRole = canvasId ? productionCanvasContext(this.db, canvasId).role : "ordinary";
        const nodes = project?.nodes as Array<Record<string, any>> | undefined;
        const continuityReport = this.getContinuity(episodeId, { snapshot: source, view: "summary" });
        const hasContinuityV2 = (director.source.ledger as any)?.contract_version === 2;
        const moduleStates = Object.fromEntries(Object.entries(director.modules).map(([name, item]) => [name, {
            status: item.status, declaredStatus: item.status,
                verifiedStatus: name === "continuity" ? (hasContinuityV2 ? continuityReport.status : "diagnosticOnly") : (item.evidence.length ? "evidence_incomplete" : "unchecked"),
            unresolved: item.unresolved, cursor: item.cursor,
        }]));
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
        const imageModelFor = (id: string, nodeId?: string) => productionImageModel(data.settings, director.source, id, Object.values(director.shotInputs).some(input => input.keyframeAssetId === id) ? "keyframe" : undefined) || nodeModel(nodeId);
        const h3ModelFor = (id: string, nodeId?: string) => data.settings.h3Models[id] || data.settings.h3Model || nodeModel(nodeId);
        const assetScope = (id: string) => String(planById.get(id)?.canvas_scope || (director.assets[id]?.sharedSource || canvasRole === "shared-assets" ? "shared" : "episode"));
        const assetScopeBlockers = (id: string) => {
            const scope = assetScope(id);
            if (!["shared", "episode"].includes(scope)) return [`资产 ${id} 的画布归属无效：${scope}`];
            if (canvasRole === "shared-assets" && scope !== "shared") return [`资产 ${id} 标记为本集专用，不能在剧目共享资产画布生产`];
            if (canvasRole !== "shared-assets" && scope === "shared" && !director.assets[id]?.sharedSource) return [`共享资产 ${id} 尚未采用同剧目已批准版本；请先在共享资产画布制作并审核，再回到分集采用`];
            return [];
        };
        const compiled = (artifact: NonNullable<ReturnType<typeof artifactFor>> | undefined, id: string) => {
            const blockers: string[] = [];
            if (!artifact) blockers.push(`缺少 ${id} 的完整编译提示词`);
            else if (artifact.status !== "ready" || !currentCompilationArtifact(director, artifact) || artifact.receipt.promptHash !== artifact.sha256) blockers.push(`提示词需要由当前激活 Acheng 引擎重新编译`);
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
            const all = [...blockers, ...assetScopeBlockers(id), ...compiled(artifact, `资产 ${id}`)];
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
            const entry = planById.get(id);
            const planKind = String(entry?.kind || entry?.asset_type || "").toLowerCase();
            if (!id || keyframeAssetIds.has(id) || skipStoryboardImages && ["keyframe", "storyboard", "frame"].includes(planKind)) continue;
            const deps = idList(entry?.depends_on);
            pushAsset(id, String(entry?.name || entry?.title || entry?.kind || id), dependencyBlockers(deps));
        }
        for (const shot of shots) {
            const shotId = String(shot.id || "");
            if (!shotId) continue;
            const input = director.shotInputs[shotId];
            if (skipStoryboardImages || !input || input.keyframePolicy === "none") continue;
            const assetId = input.keyframeAssetId || "";
            const artifact = assetId ? artifactFor("image", assetId) : undefined;
            const deps = [...(input.assetIds || []), ...idList(shot.required_assets)].filter(Boolean);
            const blockers = [...(canvasRole === "shared-assets" ? ["剧目共享资产画布只生产可复用资产；关键帧应在分集画布生成"] : []), ...(assetId ? assetScopeBlockers(assetId) : ["关键帧未绑定 Acheng 图像资产"]), ...dependencyBlockers(deps), ...compiled(artifact, `镜头 ${shotId} 的关键帧`)];
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
        const completionBatches = this.listBatches(episodeId);
        for (const [index, segment] of segments.entries()) {
            const segmentId = String(segment.id || "");
            if (!segmentId) continue;
            const shotIds = Array.isArray(segment.shot_ids) ? segment.shot_ids.map(String) : [];
            const artifact = artifactFor("h3", segmentId);
            const blockers = [...(canvasRole === "shared-assets" ? ["剧目共享资产画布不能生产分集视频 Clip"] : []), ...compiled(artifact, `Segment ${segmentId}`)];
            if (hasContinuityV2) {
                blockers.push(...continuityTargetBlockers(continuityReport, [segmentId]).map(item => `${item.code}: ${item.message}`));
            }
            const group = data.clipGroups.find(item => item.id === segmentId);
            const sceneIds = productionSceneIdsForShots(productionSceneEntries(director.source), shotIds);
            if (!group?.nodeId && sceneIds.length !== 1) blockers.push(sceneIds.length ? "Segment 跨越多个正式场次；先按场次拆分" : "Segment 未映射到唯一正式场次；无法分配场次 H3 节点");
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
                if (!input && !skipStoryboardImages) blockers.push(`Shot ${shotId} 缺少参考与关键帧映射`);
                else if (input && input.keyframePolicy !== "none" && !skipStoryboardImages) {
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
            const completed = !blockers.length && this.completedSegment(episodeId, data, segmentId, completionBatches);
            addTarget({ id: `segment:${segmentId}`, targetId: segmentId, kind: "segment", title: segmentId, status: blockers.length ? "blocked" : completed ? "complete" : "ready", blockers: [...new Set(blockers)],
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
        return { revision: current.revision, publishedVersion: current.publishedVersion, source, targets, modules: moduleStates, unresolved: [...new Set([...director.unresolved, ...blockedModules, ...ungroupedShotIssues, ...invalidBoundaryIssues])], nextAction, ...(presentation ? { presentation } : {}), sceneWorks: current.draft.director?.workflow.sceneWorks };
    }

    private completedSegment(id: string, data: EpisodeProductionData, segmentId: string, batches: ProductionBatch[]) {
        const group = data.clipGroups.find(item => item.id === segmentId);
        if (!data.director || !group?.nodeId || !group.segmentId || group.inputOutdated) return false;
        const node = this.canvasNode(id, group.nodeId);
        const clip = (record(node.metadata).segments as Record<string, unknown>[] || []).find(item => item.id === group.segmentId);
        const storageKey = String(clip?.resultStorageKey || "");
        const media = storageKey && this.db.getMediaFile(storageKey);
        if (!media || !fs.existsSync(media.filePath)) return false;
        return batches.some(batch => {
            // A failed batch may contain successfully archived independent Clips.
            if (!["succeeded", "failed", "cancelled"].includes(batch.status)) return false;
            const submitted = batch.submitted.find(item => item.kind === "h3" && [segmentId, `segment:${segmentId}`].includes(item.id) && item.nodeId === group.nodeId && item.segmentId === group.segmentId && item.status === "succeeded");
            const task = submitted && this.db.getTask(submitted.taskId);
            if (!task || task.status !== "succeeded" || task.projectId !== this.episodeInfo(id).canvasId || task.nodeId !== group.nodeId) return false;
            const resultMedia = Array.isArray(task.result?.media) ? task.result.media as Record<string, unknown>[] : [];
            if (![...task.outputs, ...resultMedia].some(item => item.storageKey === storageKey)) return false;
            try {
                const frozen = batch.executionSnapshot?.targets.find(target => target.id === `segment:${segmentId}` && target.nodeId === group.nodeId && target.segmentId === group.segmentId);
                if (batch.executionSnapshot) {
                    const project = this.db.getCanvasProject(this.episodeInfo(id).canvasId!);
                    if (!frozen || !project || frozen.inputHash !== inputHash(effectiveTargetInput(project, group.nodeId!, group.segmentId!, record(this.db.getSetting(H3_DEFAULTS_KEY))))) return false;
                }
                const original = this.version(id, batch.version).snapshot.director;
                const scope = { targetIds: [segmentId] };
                return Boolean(original && compilationScopeInput(original, scope).inputHash === compilationScopeInput(data.director!, scope).inputHash);
            } catch { return false; }
        });
    }

    private directorPresentation(episodeId: string, current: ProductionRecord, director: DirectorProduction, targets: DirectorReadinessTarget[], requestedRunId?: string): DirectorPresentation | undefined {
        const owner = { kind: this.ownerKind, id: episodeId };
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
        const pendingDecision = director.workflow.pendingDecisions?.find(decision => decision.workId === work!.workId && decision.status === "pending");
        if (pendingDecision) work = { ...work, module: pendingDecision.module, action: "author", targetKind: pendingDecision.targetKind, targetId: pendingDecision.targetId };
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
            : work.module === "continuity" ? "continuity"
                : work.module === "model" ? "production" : "overview";
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
            status = "blocked"; action = "blocked"; reason = "制作源稿已变化；请用当前激活的 Acheng 引擎重新检查当前目标";
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
        if (run && status !== "blocked" && !pendingDecision && (work.action !== "author" || !declaredWork)) {
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
            if (targetKind === "scene" && canvasId) nodeId = (this.db.getCanvasProject(canvasId)?.nodes as Record<string, any>[] || []).find(node => node.type === "text" && (node.metadata?.productionScriptSceneId === targetId || node.metadata?.productionScriptId === targetId))?.id;
            if (targetKind === "asset") nodeId = director.assets[targetId]?.nodeId;
            if (targetKind === "keyframe" || targetKind === "shot") nodeId = current.draft.keyframes[targetId]?.nodeId || director.assets[director.shotInputs[targetId]?.keyframeAssetId || ""]?.nodeId;
            const group = current.draft.clipGroups.find(item => targetKind === "segment" ? item.id === targetId : targetKind === "shot" && item.shotIds.includes(targetId!));
            if (!nodeId && group) { nodeId = group.nodeId || undefined; segmentId = group.segmentId || undefined; }
        }
        if (work.taskId && work.action === "produce" && status !== "blocked" && !director.workflow.pendingDecisions?.some(decision => decision.workId === work.workId && decision.status === "pending")) {
            const native = this.db.db.prepare("SELECT * FROM production_task_bindings WHERE task_id=? AND owner_kind=? AND owner_id=?").get(work.taskId, this.ownerKind, episodeId) as Record<string, any> | undefined;
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

    canvasEditorialState(id: string, targetIds: string[]) {
        const current = this.get(id), canvasId = this.episodeInfo(id).canvasId, project = canvasId && this.db.getCanvasProject(canvasId);
        if (!project) return [];
        return targetIds.flatMap(requestedId => {
            const targetId = requestedId.replace(/^(asset|frame|segment):/, "");
            const group = current.draft.clipGroups.find(group => group.id === targetId);
            const assetId = current.draft.director?.shotInputs[targetId]?.keyframeAssetId || targetId;
            const nodeId = group?.nodeId || current.draft.director?.assets[assetId]?.nodeId;
            const node = (project.nodes as any[]).find(node => node.id === nodeId);
            const input = group ? node?.metadata?.segments?.find((clip: any) => clip.id === group.segmentId) : node?.metadata;
            const projection = group ? input?.productionClipProjection : input?.productionImageProjection;
            if (!input) return [];
            const fields = group ? ["prompt", "referenceBindings", "storyboardShots", "duration", "styleTemplateId", "motionContextEnabled", "tailFrameContinuation"] : ["prompt", "model", "comfyParams", "size", "quality", "count"];
            return [{ targetId, nodeId, segmentId: group?.segmentId, canvasRevision: project.revision, current: Object.fromEntries(fields.map(field => [field, input[field]])),
                directorBaseline: projection?.nextValues || {}, manualFields: fields.filter(field => projection?.fieldHashes?.[field] && projection.fieldHashes[field] !== inputHash(input[field])), directorChanges: (projection?.conflicts || []).filter((field: string) => !fields.includes(field) || !projection?.fieldHashes?.[field] || projection.fieldHashes[field] !== inputHash(input[field])), inputOutdated: input.inputOutdated || false }];
        });
    }

    canvasExecution(id: string, targets: string[], expectedCanvasRevision?: number): CanvasExecutionSnapshot {
        const linked = this.linked(id); if (linked) return linked.service.canvasExecution(linked.id, targets, expectedCanvasRevision);
        const current = this.get(id), canvasId = this.episodeInfo(id).canvasId;
        const project = canvasId && this.db.getCanvasProject(canvasId);
        if (!project) throw new Error("制作对象未关联可用画布");
        if (expectedCanvasRevision !== undefined && expectedCanvasRevision !== Number(project.revision)) throw new Error("画布版本已变化，请刷新生成预检");
        return captureCanvasInputs(project, current.draft, targets, record(this.db.getSetting(H3_DEFAULTS_KEY)), key => this.db.getMediaFile(key));
    }

    private canvasBatchCandidate(id: string, current: ProductionRecord, input: DirectorRunStart) {
        if (current.revision !== input.expectedRevision) throw new ProductionConflictError(current);
        const director = current.draft.director;
        if (!director) throw new Error("生产对象缺少导演登记信息");
        const executionSnapshot = this.canvasExecution(id, input.targets, input.expectedCanvasRevision);
        if (input.expectedPlanHash && input.expectedPlanHash !== executionSnapshot.planHash) throw new Error("生成预检已过期，请刷新当前输入");
        for (const batch of this.listBatches(id)) if (["pending", "running", "paused", "awaiting_review"].includes(batch.status) && batch.targets.some(target => input.targets.includes(target))) {
            throw new ProductionValidationError([{ code: "TARGET_OCCUPIED", path: "targets", message: `目标已由运行 ${batch.runId} 占用`, severity: "error", blockingRun: { runId: batch.runId, status: batch.status, taskIds: batch.submitted.map(item => item.taskId) } }]);
        }
        if (!executionSnapshot.targets.length) throw new ProductionValidationError(executionSnapshot.blockedTargets.map(item => ({ ...item, path: "targets", severity: "error" as const })));
        const selectedTargets = executionSnapshot.targets.map(target => target.id);
        const plan: ProductionImpact = { changedSceneIds: [], affectedShotIds: [], imageShotIds: [], clipGroupIds: [], missingAssetNodeIds: [], assetIds: [] };
        for (const target of selectedTargets) {
            if (target.startsWith("segment:")) plan.clipGroupIds.push(target.slice(8));
            else if (target.startsWith("frame:")) plan.imageShotIds.push(target.slice(6));
            else plan.assetIds!.push(target.slice(6));
        }
        let nextDraft: EpisodeProductionData | undefined;
        if (input.workId) {
            if (director.workflow.currentWork?.workId !== input.workId) throw new Error("workId 不属于当前制作游标");
            nextDraft = structuredClone(current.draft);
            nextDraft.director!.workflow.currentWork = { ...director.workflow.currentWork!, runId: input.runId, inputRevision: current.revision + 1 };
        }
        return { selectedTargets, plan, workflow: director.workflow, runSettings: current.draft.settings, nextDraft, director, executionSnapshot };
    }

    private batchCandidate(episodeId: string, current: ProductionRecord, input: DirectorRunStart) {
            if (input.inputBasis === "canvas") return this.canvasBatchCandidate(episodeId, current, input);
            if (current.revision !== input.expectedRevision) throw new ProductionConflictError(current);
            if (current.publishedVersion !== input.version || !current.published?.director) throw new Error("请先发布当前 Acheng 制作稿");
            const currentWork = current.draft.director?.workflow.currentWork;
            if (input.workId && currentWork?.workId !== input.workId) throw new Error("runId 必须关联当前正式 currentWork");
            const executionSignature = (value: NonNullable<EpisodeProductionData["director"]>) => ({
                sourceHash: value.sourceHash, engine: value.engine, artifacts: value.artifacts,
                assets: Object.fromEntries(Object.entries(value.assets).map(([id, item]) => [id, { nodeId: item.nodeId, storageKey: item.storageKey, sha256: item.sha256, version: item.version, status: item.status }])),
                shotInputs: value.shotInputs, boundaries: value.boundaries,
            });
            const diagnostics: ProductionDiagnostic[] = [];
            if (!current.draft.director) throw new ProductionValidationError([{ code: "DIRECTOR_SOURCE_MISSING", path: "director", message: "缺少正式导演源稿。", severity: "error" }]);
            let changedExecution = fingerprint(executionSignature(current.draft.director)) !== fingerprint(executionSignature(current.published.director));
            if (changedExecution && current.draft.settings.parallelScenes) {
                const targetIds = input.targets.map(target => target.slice(target.indexOf(":") + 1));
                try { changedExecution = compilationScopeInput(current.draft.director, { targetIds }).inputHash !== compilationScopeInput(current.published.director, { targetIds }).inputHash; }
                catch { changedExecution = true; }
            }
            if (changedExecution) diagnostics.push({ code: "COMPILATION_STALE", path: "director", message: "当前目标的制作输入或引用已变化；请先编译并发布。", severity: "error" });
            const workflow = current.draft.director.workflow;
            const mediaMode = workflow.mediaProductionMode || "per_item";
            if (mediaMode === "prompt_only") diagnostics.push({ code: "MEDIA_MODE_PROMPT_ONLY", path: "director.workflow.mediaProductionMode", message: "当前设置为仅提示词，切换媒体生产模式后才能提交生成。", severity: "error", nextAction: { action: "configure", message: "根据用户生成意图确认并保存媒体生产模式；不要直接重试。" } });
            if (mediaMode === "per_item" && input.targets.length !== 1) diagnostics.push({ code: "TARGET_SCOPE_INVALID", path: "request.targets", message: "逐项生成模式每批只能选择一个生产对象。", severity: "error" });
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
            if (current.draft.settings.parallelScenes && !current.draft.settings.reviewPolicy) diagnostics.push({ code: "REVIEW_POLICY_REQUIRED", path: "settings.reviewPolicy", message: "请在剧目开局选择审核模式。", severity: "error" });
            if (current.draft.settings.parallelScenes) for (const target of selectedTargets.filter(id => id.startsWith("segment:"))) {
                const segment = segmentItems.find(item => String(item.id) === target.slice("segment:".length));
                const ids = Array.isArray(segment?.shot_ids) ? segment.shot_ids as string[] : [];
                const scene = productionSceneEntries(current.published.director.source).find(item => ids.length > 0 && ids.every(shotId => item.shotIds.includes(shotId)));
                const work = Object.values(current.draft.director?.workflow.sceneWorks || {}).reverse().find(item => item.sceneId === scene?.id && item.status !== "failed" && item.review?.verdict === "approved");
                if (!work || work.review!.inputHash !== compilationScopeInput(current.published.director, { sceneId: work.sceneId }).inputHash) diagnostics.push({ code: "SCENE_REVIEW_REQUIRED", path: "workflow.sceneWorks", targetId: target, message: "本场开拍审核缺失或已过期。", severity: "error" });
                else {
                    try {
                        const scope = compilationScopeInput(current.published.director, { sceneId: work.sceneId });
                        const media = this.sceneReviewMedia(episodeId, scope.targetIds.filter(id => current.published!.director!.assets[id]?.storageKey));
                        const reviewedHash = work.review!.mediaInputHash || productionReviewHash(work.review!.inputHash, work.review!.media);
                        if (reviewedHash !== productionReviewHash(scope.inputHash, media)) throw new Error("本场审核图片已变化");
                    } catch (error) { diagnostics.push({ code: "SCENE_REVIEW_MEDIA_CHANGED", path: "workflow.sceneWorks", targetId: target, message: error instanceof Error ? error.message : String(error), severity: "error" }); }
                }
            }
            const missing = selectedTargets.filter(id => !targets.has(id));
            for (const targetId of missing) diagnostics.push({ code: "TARGET_NOT_FOUND", path: "request.targets", targetId, message: `生产目标不存在：${targetId}`, severity: "error" });
            const selectedTargetSet = new Set(selectedTargets);
            const activeBatches = this.listBatches(episodeId).filter(batch => ["pending", "running", "paused", "awaiting_review"].includes(batch.status) && !this.rejectedBatchTarget(batch, current.published));
            for (const batch of activeBatches.filter(batch => batch.targets.some(id => selectedTargetSet.has(id)))) {
                const awaitingReview = batch.status === "awaiting_review";
                const message = awaitingReview
                    ? "已有媒体生成成功但尚待审核，暂停不会释放目标。请读取该运行并查看原结果；继续沿用时完成审核，要重做时先按用户意图退回旧结果，待无在途任务且原运行结束后再用新 runId 启动"
                    : "请读取并恢复原运行；暂停仍保留目标占用，不要换 runId 重试";
                diagnostics.push({ code: awaitingReview ? "TARGET_AWAITING_REVIEW" : "TARGET_OCCUPIED", path: "request.targets", message: `所选生产目标已由运行 ${batch.runId} 占用；${message}`, severity: "error",
                    blockingRun: { runId: batch.runId, status: batch.status, taskIds: batch.submitted.map(item => item.taskId) },
                    nextAction: { action: awaitingReview ? "review" : "read_run", message, tool: "production_get_batch", input: { kind: this.projectScope ? "canvas" : "episode", id: episodeId, runId: batch.runId } } });
            }
            for (const target of selectedTargets.flatMap(id => targets.has(id) ? [targets.get(id)!] : []).filter(item => item.status !== "ready"
                && !(item.status === "complete" && item.executionTargets?.some(id => selectedTargetSet.has(id) && targets.get(id)?.status === "ready")))) {
                diagnostics.push({ code: target.status === "needs_review" ? "TARGET_NEEDS_REVIEW" : "TARGET_DEPENDENCY_BLOCKED", path: "request.targets", targetId: target.id,
                    message: `${target.title}：${target.blockers.join("；") || target.notice || target.status}`, severity: "error",
                    nextAction: { action: target.status === "needs_review" ? "review" : "correct_source", message: target.blockers.join("；") || target.notice || "读取目标就绪状态并补齐依赖。" } });
            }
            if (diagnostics.length) throw new ProductionValidationError(diagnostics);
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
            const executionProject = structuredClone(this.db.getCanvasProject(canvasId)!);
            const nodes = executionProject.nodes as any[];
            for (const id of selectedTargets) {
                if (id.startsWith("segment:")) {
                    const group: EpisodeProductionData["clipGroups"][number] | undefined = current.published.clipGroups.find(group => group.id === id.slice(8));
                    const node: any = nodes.find(node => node.id === group?.nodeId);
                    const index = node?.metadata?.segments?.findIndex((segment: any) => segment.id === group?.segmentId);
                    if (group?.segmentId && index >= 0) node.metadata.segments[index] = buildPublishedProductionClip(executionProject, current.published, group, group.segmentId, record(this.db.getSetting(H3_DEFAULTS_KEY)), runSettings);
                } else {
                    const assetId = id.startsWith("frame:") ? director.shotInputs[id.slice(6)]?.keyframeAssetId : id.slice(6);
                    const node = nodes.find(node => node.id === director.assets[assetId || ""]?.nodeId);
                    const artifact = director.artifacts.find(artifact => artifact.kind === "image" && artifact.targetId === assetId);
                    if (!node || !artifact) continue;
                    const sourceId = node.metadata?.productionImageInput?.sourceNodeId || node.id;
                    const source = nodes.find(node => node.id === sourceId) || node;
                    const manifest = compiledImageInput(director, artifact, source.id);
                    node.metadata = { ...node.metadata, prompt: artifact.prompt, productionImageInput: manifest, productionImageProjection: undefined };
                    source.metadata = { ...source.metadata, prompt: artifact.prompt, productionImageInput: manifest, productionImageProjection: undefined };
                    executionProject.connections = (executionProject.connections as any[]).filter(edge => edge.toNodeId !== source.id);
                    for (const [order, ref] of artifact.references.entries()) (executionProject.connections as any[]).push({ id: `published:${source.id}:${order}`, fromNodeId: ref.nodeId, toNodeId: source.id, order });
                }
            }
            const captured = captureCanvasInputs(executionProject, current.published, selectedTargets, record(this.db.getSetting(H3_DEFAULTS_KEY)), key => this.db.getMediaFile(key));
            const executionSnapshot = captured.targets.length === selectedTargets.length ? { ...captured, inputBasis: "published" as const } : null;
            return { selectedTargets, plan, workflow, runSettings, nextDraft, director, executionSnapshot };
    }

    startBatch(episodeId: string, raw: unknown): ProductionBatch {
        const linked = this.linked(episodeId); if (linked) return linked.service.startBatch(linked.id, raw);
        const input = directorRunStartSchema.parse(raw);
        const requestHash = batchRequestHash(input);
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
            const { selectedTargets, plan, workflow, runSettings, nextDraft, director, executionSnapshot } = this.batchCandidate(episodeId, current, input);
            const now = new Date().toISOString();
            const productionRevision = nextDraft ? current.revision + 1 : current.revision;
            if (nextDraft) this.prepare("UPDATE episode_productions SET revision=?, draft_json=?, updated_at=? WHERE episode_id=?")
                .run(productionRevision, JSON.stringify(nextDraft), now, episodeId);
            this.prepare("INSERT INTO episode_production_batches (run_id, episode_id, idempotency_key, request_hash, version, source_revision, status, targets_json, plan_json, engine_json, settings_json, submitted_json, error, pause_requested, created_at, updated_at, execution_snapshot_json) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, '[]', NULL, 0, ?, ?, ?)")
                .run(input.runId, episodeId, input.idempotencyKey, requestHash, input.version, current.revision, JSON.stringify(selectedTargets), JSON.stringify(plan), JSON.stringify(director.engine), JSON.stringify({ ...runSettings, workflow: { ...workflow, runScope: input.scope, currentWorkId: input.workId } }), now, now, executionSnapshot ? JSON.stringify(executionSnapshot) : null);
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

    resolveCanvasDependency(id: string, runId: string, targetId: string, nodeId: string, taskId: string, storageKey: string): CanvasExecutionSnapshot {
        const linked = this.linked(id); if (linked) return linked.service.resolveCanvasDependency(linked.id, runId, targetId, nodeId, taskId, storageKey);
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const batch = this.getBatch(id, runId), snapshot = batch?.executionSnapshot;
            const target = snapshot?.targets.find(target => target.id === targetId);
            const dependencies = target?.dependencies.filter(dependency => dependency.nodeId === nodeId);
            const task = this.db.getTask(taskId), media = this.db.getMediaFile(storageKey);
            if (!snapshot || !target || !dependencies?.length || !task || task.status !== "succeeded" || !media) throw new Error("前置任务或冻结依赖无效");
            const outputs = [...task.outputs, ...(Array.isArray(task.result?.media) ? task.result.media as any[] : [])];
            if (!outputs.some(output => output.storageKey === storageKey) || !dependencies.every(dep => batch!.submitted.some(item => item.id === dep.targetId && item.taskId === taskId))) throw new Error("媒体不属于本批次精确前置任务");
            for (const dependency of dependencies) {
                if (dependency.taskId && (dependency.taskId !== taskId || dependency.storageKey !== storageKey)) throw new Error("已解析依赖不可替换");
                Object.assign(dependency, { taskId, storageKey, sha256: promptHashBytes(media.filePath) });
            }
            const nodes = snapshot.project.nodes as any[], node = nodes.find(node => node.id === target.nodeId);
            if (target.segmentId) {
                const segment = node?.metadata?.segments?.find((segment: any) => segment.id === target.segmentId);
                for (const dependency of dependencies) {
                    const binding = segment?.referenceBindings?.find((binding: any) => binding.id === dependency.bindingId);
                    if (!binding) throw new Error("冻结 Clip 参考绑定不存在");
                    Object.assign(binding, { storageKey });
                    const catalog = snapshot.project.referenceCatalog as any[] || [];
                    const existing = catalog.find(asset => asset.id === binding.assetId);
                    const asset = { id: binding.assetId, mediaType: "image", sourceNodeId: nodeId, storageKey, sha256: dependency.sha256 };
                    if (existing) Object.assign(existing, asset); else catalog.push(asset);
                    snapshot.project.referenceCatalog = catalog;
                }
            } else {
                const refs = target.command.references || [];
                if (!refs.some(ref => ref.sourceNodeId === nodeId)) refs.push({ id: nodeId, sourceNodeId: nodeId, storageKey, sha256: dependencies[0].sha256, type: "image" });
                const sourceNode = nodes.find(node => node.id === nodeId);
                if (sourceNode) sourceNode.metadata = { ...sourceNode.metadata, storageKey, images: [{ storageKey, id: storageKey }], mainImageId: storageKey };
                target.command.references = refs;
                // Reorder resolved references by the frozen canvas edge order.
                const source = nodes.find(node => node.id === target.sourceNodeId);
                const order = (snapshot.project.connections as any[]).filter(edge => edge.toNodeId === source?.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(edge => edge.fromNodeId);
                refs.sort((a, b) => order.indexOf(String(a.sourceNodeId || a.id)) - order.indexOf(String(b.sourceNodeId || b.id)));
            }
            target.inputHash = inputHash(effectiveTargetInput(snapshot.project, target.nodeId, target.segmentId, snapshot.defaults));
            this.prepare("UPDATE episode_production_batches SET execution_snapshot_json=? WHERE episode_id=? AND run_id=?").run(JSON.stringify(snapshot), id, runId);
            this.db.db.exec("COMMIT");
            return snapshot;
        } catch (error) { this.db.db.exec("ROLLBACK"); throw error; }
    }

    listBatches(episodeId: string): ProductionBatch[] {
        const linked = this.linked(episodeId); if (linked) return linked.service.listBatches(linked.id);
        this.episode(episodeId);
        return (this.prepare("SELECT * FROM episode_production_batches WHERE episode_id=? ORDER BY created_at DESC").all(episodeId) as Array<Record<string, any>>).map(row => this.batchFromRow(row));
    }

    batchForRun(episodeId: string, runId: string): ProductionRun | null {
        const batch = this.getBatch(episodeId, runId);
        return batch ? { episodeId, version: batch.version, runId, targets: batch.targets, engine: batch.engine, settings: batch.settings, executionSnapshot: batch.executionSnapshot, status: batch.status, plan: batch.plan, submitted: batch.submitted, error: batch.error, updatedAt: batch.updatedAt } : null;
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

    retireBatch(episodeId: string, runId: string, reason: string): ProductionBatch {
        const linked = this.linked(episodeId); if (linked) return linked.service.retireBatch(linked.id, runId, reason);
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const batch = this.getBatch(episodeId, runId);
            if (!batch) throw new Error(`找不到生产运行 ${runId}`);
            if (["succeeded", "failed"].includes(batch.status)) { this.db.db.exec("COMMIT"); return batch; }
            if (!["paused", "awaiting_review"].includes(batch.status)) throw new Error("只能结束已暂停或待审核的历史批次");
            for (const item of batch.submitted) {
                const task = this.db.getTask(item.taskId);
                if (!task || !["succeeded", "failed", "cancelled"].includes(task.status)) throw new Error(`批次仍有在途或未知任务：${item.taskId}`);
            }
            const run = this.batchForRun(episodeId, runId);
            if (!run) throw new Error(`找不到生产运行 ${runId}`);
            this.updateBatch(run, { status: "failed", pauseRequested: false, error: `用户结束历史批次：${reason}` });
            const result = this.getBatch(episodeId, runId)!;
            this.db.db.exec("COMMIT");
            return result;
        } catch (error) { this.db.db.exec("ROLLBACK"); throw error; }
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
        if (batch.settings.parallelScenes && batch.status === "running" && batch.pauseRequested) {
            this.prepare("UPDATE episode_production_batches SET pause_requested=0, updated_at=? WHERE episode_id=? AND run_id=?").run(new Date().toISOString(), episodeId, runId);
            return this.getBatch(episodeId, runId)!;
        }
        if (!["paused", "pending", "awaiting_review"].includes(batch.status)) throw new Error(`该生产运行不能继续：${batch.status}`);
        if (batch.executionSnapshot) {
            this.prepare("UPDATE episode_production_batches SET status='pending', pause_requested=0, updated_at=? WHERE episode_id=? AND run_id=?").run(new Date().toISOString(), episodeId, runId);
            return this.getBatch(episodeId, runId)!;
        }
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

    private editedCandidate(episodeId: string, record: ProductionRecord, input: ProductionEdit, canvasCommits?: CanvasCommit[], sceneRuntime = false) {
            const draft = structuredClone(record.draft);
            const published = record.published ? structuredClone(record.published) : null;
            for (const [index, operation] of input.ops.entries()) {
                try {
                if (operation.type === "upgrade_director_continuity" && operation.previewRevision !== record.revision) throw new Error("CONTINUITY_UPGRADE_PREVIEW_STALE: 制作修订已变化，请重新预览");
                if (operation.type === "restore_archived_scene_results") {
                    if (!published) throw new Error("尚无发布版本，不能核验迁移前 H3 结果");
                    this.restoreArchivedSceneResults(episodeId, record, draft, published, operation, input.operationId, canvasCommits);
                } else if (operation.type === "select_director_result") {
                    this.selectDirectorResult(episodeId, draft, operation, input.operationId, canvasCommits);
                } else if (operation.type === "review_director_asset") {
                    const asset = draft.director?.assets[operation.assetId];
                    if (operation.version === 0 && asset?.generationTaskId) {
                        const task = this.db.getTask(String(asset.generationTaskId));
                        const media = this.db.getMediaFile(operation.storageKey);
                        const outputs = task ? [...task.outputs, ...(Array.isArray(task.result?.media) ? task.result.media as any[] : [])] : [];
                        if (!task || task.status !== "succeeded" || task.nodeId !== operation.nodeId || asset.nodeId !== operation.nodeId || asset.storageKey !== operation.storageKey
                            || draft.director!.sourceHash !== operation.sourceHash || !outputs.some(output => output.storageKey === operation.storageKey) || !media || promptHashBytes(media.filePath) !== operation.sha256) throw new Error("审核对象与本次成功归档任务不一致");
                        Object.assign(asset, { status: operation.verdict, evidence: operation.evidence, sha256: operation.sha256 });
                    } else {
                        if (!published) throw new Error("当前素材缺少可核验的生成来源");
                        this.applyDirectorAssetReview(episodeId, draft, published, operation, record.publishedVersion);
                    }
                } else this.apply(episodeId, draft, operation, record.publishedVersion, canvasCommits);
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
                        if (!binding || binding.owner_id !== episodeId || binding.owner_kind !== (this.ownerKind)) throw new Error("工作游标中的原生任务不属于当前制作对象");
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
            // Backfill only the deterministic legacy input identity; work state remains coordinator-owned.
            const previousDirector = record.draft.director && structuredClone(record.draft.director);
            if (previousDirector) {
                preserveCompilationProvenance(previousDirector);
                for (const [workId, work] of Object.entries(draft.director?.workflow.sceneWorks || {})) {
                    const prior = previousDirector.workflow.sceneWorks?.[workId];
                    if (prior && !work.inputEngine) work.inputEngine = prior.inputEngine;
                }
            }
            if (!sceneRuntime && fingerprint({ works: draft.director?.workflow.sceneWorks, review: draft.director?.workflow.sharedReview, sharedWorks: draft.director?.workflow.sharedReviewWorks, sharedAssets: draft.director?.workflow.sharedAssetReviews, sharedContinuation: draft.director?.workflow.sharedReviewContinuation }) !== fingerprint({ works: previousDirector?.workflow.sceneWorks, review: record.draft.director?.workflow.sharedReview, sharedWorks: record.draft.director?.workflow.sharedReviewWorks, sharedAssets: record.draft.director?.workflow.sharedAssetReviews, sharedContinuation: record.draft.director?.workflow.sharedReviewContinuation })) throw new Error("SCENE_RUNTIME_OWNED: 场次工作与审核记录只能通过场次协调服务更新");
            const before = record.draft.director, after = draft.director;
            if (before && after) {
                const priorSegments = before.source.segments as any[] || [], nextSegments = after.source.segments as any[] || [];
                const priorShots = before.source.shots as any[] || [], nextShots = after.source.shots as any[] || [];
                const globalChange = fingerprint(before.source.ledger) !== fingerprint(after.source.ledger) || fingerprint(before.source.style_lock) !== fingerprint(after.source.style_lock);
                const changed = [...new Set([...priorSegments, ...nextSegments].map(segment => String(segment.id)))].filter(id => {
                    const left = priorSegments.find(segment => segment.id === id), right = nextSegments.find(segment => segment.id === id);
                    const shotIds = new Set([...(left?.shot_ids || []), ...(right?.shot_ids || [])]);
                    return globalChange || fingerprint(left) !== fingerprint(right) || fingerprint(priorShots.filter(shot => shotIds.has(shot.id))) !== fingerprint(nextShots.filter(shot => shotIds.has(shot.id))) || fingerprint(before.boundaries.filter(edge => edge.from === id)) !== fingerprint(after.boundaries.filter(edge => edge.from === id));
                });
                const occupied = this.targetOccupancy(episodeId, changed);
                if (occupied.length) throw new ProductionValidationError(occupied.map((item): ProductionDiagnostic => ({ code: "TARGET_OCCUPIED", path: "request.ops", targetId: item.targetId, severity: "error", message: `目标 ${item.targetId} 被 ${item.runId || item.taskIds.join(", ") || "运行态待确认"} 占用 (${item.status})；${item.nextAction.message}`, ...(item.runId || item.taskIds.length ? { blockingRun: { runId: item.runId || item.taskIds[0], status: item.status, taskIds: item.taskIds } } : {}), nextAction: item.nextAction })));
            }
            this.validateGraph(draft);
            for (const operation of input.ops) if (operation.type === "review_keyframe") {
                const link = published?.keyframes[operation.shotId];
                if (!link || link.sourceVersion !== record.publishedVersion || fingerprint(link) !== fingerprint(draft.keyframes[operation.shotId])) throw new Error("关键帧已不是当前发布版本的媒体，不能自动通过");
                published!.keyframeReviews[operation.shotId] = draft.keyframeReviews[operation.shotId];
            }
           if (draft.director) {
               this.validateSource(draft.director, "edit");
                this.validateSubjectEntityOwnership(episodeId, draft.director);
               const projectId = this.episodeInfo(episodeId).canvasId;
                if (projectId) for (const asset of Object.values(draft.director.assets)) validateSharedAssetSource(this.db, projectId, asset);
            }
            return { draft, published };
    }


    edit(episodeId: string, raw: unknown, canvasPreparation?: { projectId: string; expectedCanvasRevision: number; operationId: string; operations: CanvasOperation[] }, sceneRuntime = false, beforeCommit?: (record: ProductionRecord) => void): ProductionRecord & { replayed?: boolean; impact?: ProductionImpact } {
        const linked = this.linked(episodeId); if (linked) return linked.service.edit(linked.id, raw, canvasPreparation, sceneRuntime, beforeCommit);
        const input = productionEditSchema.parse(raw);
        const refreshes = input.ops.filter(op => op.type === "request_director_clip_refresh");
        if (refreshes.length > 1 && !input.ops.some(op => op.type === "set_director_production" && isSubjectPromptAssembly(op.director.source))) throw new ProductionValidationError([{ code: "CLIP_REFRESH_SCOPE", path: "request.ops", message: "旧稿局部刷新单批仅允许一个 Clip", severity: "error" }]);
        if (input.ops.some(operation => operation.type === "restore_archived_scene_results") && input.ops.length !== 1) throw new Error("归档视频恢复必须单独提交，不能与其他制作编辑混批");
        const canvasCommits: CanvasCommit[] = [];
        const adoptedTasks: Array<{ taskId: string; result: Record<string, unknown> }> = [];
        const result = this.commit(episodeId, input.operationId, input.expectedRevision, fingerprint(input), (record) => {
            const packets: DirectorWorkPackage[] = [];
            if (input.adoptions) {
                if (new Set(input.adoptions.map(item => item.taskId)).size !== input.adoptions.length) throw new Error("ADOPTION_DUPLICATE");
                if (input.ops.some(op => !["patch_director_source", "patch_director_continuity", "set_director_production"].includes(op.type))) throw new Error("ADOPTION_PROTECTED_OPERATION: 采纳只允许创作源稿编辑");
                for (const adoption of input.adoptions) {
                    const task = this.db.getTask(adoption.taskId), packet = task?.input.workPackage as DirectorWorkPackage | undefined;
                    const output = task?.result;
                    if (!task || task.kind !== DIRECTOR_SUBAGENT_KIND || !packet || packet.projectId !== this.episodeInfo(episodeId).canvasId
                        || (packet.owner.kind === "episode" ? packet.owner.id !== episodeId : packet.owner.id !== packet.projectId)) throw new Error("ADOPTION_OWNER_MISMATCH: 任务未绑定当前正式稿");
                    if (task.status !== "succeeded" || output?.status !== "complete" || !Array.isArray(output.unresolved) || output.unresolved.length || output.artifactHash !== adoption.artifactHash) throw new Error("ADOPTION_INCOMPLETE: 产物未完整或身份不符");
                    const artifact = (output.artifacts as Array<Record<string, any>> | undefined)?.find(item => item.artifactHash === adoption.artifactHash);
                    if (!artifact || directorArtifact(packet.inputHash, packet.runtimeId, artifact.output, packet.contractHash).artifactHash !== adoption.artifactHash) throw new Error("ADOPTION_ARTIFACT_INVALID");
                    if (output.adoption) throw new Error("ADOPTION_ALREADY_APPLIED: 请恢复原 operationId 回执");
                    if (!record.draft.director || directorWorkInput(record.draft.director, packet.scope).inputHash !== packet.inputHash) throw new Error("ADOPTION_INPUT_CHANGED: 范围或依赖输入已变化");
                    packets.push(packet); adoptedTasks.push({ taskId: task.id, result: output });
                }
            }
            const { draft, published } = this.editedCandidate(episodeId, record, input, canvasCommits, sceneRuntime);
            if (record.draft.director && draft.director && isSubjectPromptAssembly(draft.director.source)) {
                const before = record.draft.director, after = draft.director;
                const repartition = input.ops.find(op => op.type === "repartition_director_clips");
                const explicitTargets = refreshes.filter(op => op.type === "request_director_clip_refresh").map(op => op.segmentId);
                const candidates = repartition?.type === "repartition_director_clips"
                    ? clipRows(after.source.segments).filter(segment => (segment.shot_ids || []).some((shotId: string) => repartition.shotIds.includes(shotId))).map(segment => String(segment.id))
                    : explicitTargets.length ? explicitTargets : clipRows(after.source.segments).map(segment => String(segment.id));
                const changedTargets = candidates.filter(segmentId => {
                    try {
                        const nextHash = compilationScopeInput(after, clipRefreshScope(segmentId)).inputHash;
                        const priorHash = compilationScopeInput(before, clipRefreshScope(segmentId)).inputHash;
                        return nextHash !== priorHash;
                    } catch { return true; }
                });
                const store = this.clipRefreshStore(episodeId);
                for (const segmentId of changedTargets) {
                    let resolvedAfter = after;
                    try { resolvedAfter = this.resolveSubjectPictureInputs(episodeId, after, [segmentId], true); } catch { /* Saving the draft is allowed; the refresh job will report the unresolved source. */ }
                    store.register(input.operationId, record.revision + 1, before, resolvedAfter, segmentId);
                }
            } else if (refreshes.length) {
                const refresh = refreshes[0];
                if (refresh?.type !== "request_director_clip_refresh" || !record.draft.director || !draft.director) throw new Error("CLIP_REFRESH_SOURCE_MISSING");
                assertClipEdit(record.draft.director, draft.director, input, refresh.segmentId);
                this.clipRefreshStore(episodeId).register(input.operationId, record.revision + 1, record.draft.director, draft.director, refresh.segmentId);
            }
            if (packets.length) {
                if (!draft.director || !record.draft.director) throw new Error("ADOPTION_SOURCE_MISSING");
                if (fingerprint(draft.settings) !== fingerprint(record.draft.settings) || fingerprint(published) !== fingerprint(record.published)) throw new Error("ADOPTION_PROTECTED_FIELDS");
                assertDirectorWorkScope(record.draft.director, draft.director, packets.map(packet => packet.scope));
            }
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
        }, canvasPreparation ? (record, commits) => {
            if (canvasPreparation) {
                const ownerCanvasId = this.episodeInfo(episodeId).canvasId;
                if (ownerCanvasId !== canvasPreparation.projectId) throw new Error("布局准备画布不属于当前制作对象");
                if (this.db.getCanvasProjectRevision(canvasPreparation.projectId) !== canvasPreparation.expectedCanvasRevision) throw new Error("画布版本已变化，按同一 operationId 回读并恢复布局准备");
                if (canvasPreparation.operations.length) this.db.applyCanvasProjectOperations(canvasPreparation.projectId, canvasPreparation.expectedCanvasRevision, canvasPreparation.operations, {
                    operationId: canvasPreparation.operationId, runtimeWrite: true, withinTransaction: true, deferredCommits: commits, source: { kind: "system", clientId: "production:layout", label: "准备制作布局" },
                });
            }
        } : undefined, record => {
            for (const task of adoptedTasks) this.db.updateTask(task.taskId, { result: { ...task.result, adoption: directorAdoption(input.operationId, record.revision, record.draft.director!.sourceHash, input.ops, String(task.result.artifactHash)) } });
            beforeCommit?.(record);
        });
        canvasCommits.forEach(commit => this.db.notifyCanvasCommit(commit));
        const editRefreshes = this.clipRefreshStore(episodeId).byEditAll(input.operationId);
        if (editRefreshes.length) {
            (result as any).clipRefreshes = editRefreshes.map(clipRefreshReceipt);
            if (editRefreshes.length === 1) (result as any).clipRefresh = clipRefreshReceipt(editRefreshes[0]);
        }
        const approvedAssetIds = input.ops.flatMap(op => op.type === "review_director_asset" && op.verdict === "approved" ? [op.assetId] : []);
        if (approvedAssetIds.length && !result.replayed) this.autoPromoteSharedAssets(episodeId, approvedAssetIds);
        return result;
    }

    /** Read-only eligibility shared by preflight and the transactional release. */
    private rejectedBatchTarget(batch: ProductionBatch, published: EpisodeProductionData | null) {
        if (!published || batch.status !== "awaiting_review" || batch.submitted.some(item => !["succeeded", "failed"].includes(item.status || ""))) return undefined;
        return batch.targets.find(target => {
            const entry = batch.submitted.find(item => target === `asset:${item.id}` || target === `frame:${item.id}`);
            if (!entry) return false;
            if (target.startsWith("asset:")) return published.director?.assets[target.slice(6)]?.status === "rejected";
            if (target.startsWith("frame:")) return ["rejected", "needs-redo"].includes(published.keyframeReviews[target.slice(6)]?.verdict || "");
            return false;
        });
    }

    private finishRejectedBatches(episodeId: string, published: EpisodeProductionData | null) {
        for (const batch of this.listBatches(episodeId)) {
            const returned = this.rejectedBatchTarget(batch, published);
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
        const result = this.commit(episodeId, input.operationId, input.expectedRevision, fingerprint(input), (record) => {
            const candidate = this.publishedCandidate(record, input.stage, input.scope);
            if (input.stage === "director" && candidate.director && (candidate.director.source.ledger as any)?.contract_version === 2) {
                const scopedIds = input.scope ? compilationScopeInput(candidate.director, input.scope).targetIds : undefined;
                const readySegments = candidate.director.artifacts.filter(artifact => artifact.kind === "h3" && artifact.status === "ready" && (!scopedIds || scopedIds.includes(artifact.targetId)));
                if (readySegments.length) {
                    const continuity = this.continuityForDirector(episodeId, candidate.director);
                    const targetIds = readySegments.map(artifact => String(artifact.targetId || artifact.id));
                    const blockers = continuityTargetBlockers(continuity, targetIds);
                    if (blockers.length) throw new Error(`${blockers[0].code}: 发布 ready H3 产物前需通过当前目标的连续性门禁：${blockers.map(item => item.message).join("；")}`);
                }
            }
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
        if (input.stage === "director" && !result.replayed) this.autoPromoteSharedAssets(episodeId);
        return result;
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
            const baseline = historical ? this.version(episodeId, version).snapshot : current.published;
            const snapshot = structuredClone(baseline);
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
                this.projectEquivalentHistoricalResult(episodeId, current, baseline, snapshot, version, input);
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
        return this.commit(episodeId, operationId, expectedRevision, fingerprint({ version, operationId, expectedRevision }), (record) => {
            const draft = structuredClone(this.version(episodeId, version).snapshot);
            if (draft.director && record.draft.director) {
                draft.director.workflow.sceneWorks = structuredClone(record.draft.director.workflow.sceneWorks);
                draft.director.workflow.sharedReview = structuredClone(record.draft.director.workflow.sharedReview);
                draft.director.workflow.sharedReviewWorks = structuredClone(record.draft.director.workflow.sharedReviewWorks);
                draft.director.workflow.sharedAssetReviews = structuredClone(record.draft.director.workflow.sharedAssetReviews);
                if (record.draft.director.workflow.sharedReviewContinuation) draft.director.workflow.sharedReviewContinuation = { ...structuredClone(record.draft.director.workflow.sharedReviewContinuation), status: "paused", error: "已恢复历史源稿，需明确重新启动共同审核" };
                for (const work of Object.values(draft.director.workflow.sharedReviewWorks || {})) if (!["succeeded", "failed"].includes(work.status)) { work.status = "paused"; work.error = "源稿已恢复，请核对共同审核输入后恢复"; }
                for (const work of Object.values(draft.director.workflow.sceneWorks || {})) if (!["succeeded", "failed"].includes(work.status)) {
                    work.status = "paused"; work.error = "制作源稿已恢复历史版本，请核对场次输入后明确恢复";
                }
            }
            return { ...record, revision: record.revision + 1, draft, updatedAt: new Date().toISOString() };
        });
    }

    private patchDirectorSource(director: NonNullable<EpisodeProductionData["director"]>, entity: keyof typeof directorPatchFields, id: string | undefined, patch: Record<string, unknown>) {
        applyDirectorSourcePatch(director, entity, id, patch);
    }

    private initializeDirector(data: EpisodeProductionData, brief: string) {
        const runtime = resolveAchengEngine();
        const source = { prompt_assembly: { version: 2 }, brief, fps_num: 24, fps_den: 1, script_scenes: [], shots: [], utterances: [], subject_registry: [], asset_plan: [], segments: [],
            ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] } };
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

    private commit(episodeId: string, operationId: string, expectedRevision: number, requestHash: string, mutate: (record: ProductionRecord) => ProductionRecord & { impact?: ProductionImpact }, beforeMutation?: (record: ProductionRecord, canvasCommits: CanvasCommit[]) => void, beforeCommit?: (record: ProductionRecord) => void) {
        const scriptCommits: CanvasCommit[] = [];
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const prior = this.prepare("SELECT episode_id AS owner_id, request_hash, receipt_json FROM episode_production_operations WHERE operation_id = ?").get(operationId) as { owner_id: string; request_hash: string; receipt_json: string } | undefined;
            if (prior) {
                if (prior.owner_id !== episodeId || prior.request_hash !== requestHash) throw new Error("operationId 已用于不同制作稿操作");
                this.db.db.exec("COMMIT");
                const replayed = resolveReceiptDedup(JSON.parse(prior.receipt_json) as ProductionRecord & { impact?: ProductionImpact });
                assertPublicReceipt(replayed);
                return { ...replayed, replayed: true };
            }
            const current = this.get(episodeId);
            if (current.revision !== expectedRevision) throw new ProductionConflictError(current);
            beforeMutation?.(current, scriptCommits);
            const next = mutate(current);
            const projectionOperationId = `production:${this.ownerKind}:${episodeId}:${operationId}:projection`;
            const canvasId = this.episode(episodeId).canvasId;
            const canvas = canvasId && this.db.getCanvasProject(canvasId);
            if (canvas) {
                if (next.draft.director) {
                    const owner = { kind: this.ownerKind, id: episodeId };
                    const previousSceneIds = new Set(current.draft.director ? productionSceneEntries(current.draft.director.source).map(scene => scene.id) : []);
                    const nextScenes = productionSceneEntries(next.draft.director.source);
                    const createdSceneIds = nextScenes.filter(scene => !previousSceneIds.has(scene.id)).map(scene => scene.id);
                    const createdSceneSet = new Set(createdSceneIds);
                    const previousClipIds = new Set(current.draft.clipGroups.map(group => group.id));
                    const materializeClipIds = new Set<string>();
                    for (const group of next.draft.clipGroups) {
                        const sceneIds = productionSceneIdsForShots(nextScenes, group.shotIds);
                        if (sceneIds.length !== 1) continue;
                        const isNewGroup = !previousClipIds.has(group.id);
                        if (!isNewGroup && !createdSceneSet.has(sceneIds[0])) continue;
                        materializeClipIds.add(group.id);
                        group.nodeId ||= productionLayoutStableId("production-h3-scene", owner.id, sceneIds[0]);
                        group.segmentId ||= `clip-${crypto.createHash("sha256").update([owner.id, group.id].join(String.fromCharCode(0))).digest("hex").slice(0, 24)}`;
                    }
                    const h3Defaults = record(this.db.getSetting("plugin:minimax-h3:defaults:v1"));
                    const layout = compileProductionLayout({ h3Defaults, canvasId: canvas.id, owner, production: next.draft, project: canvas, previous: this.db.getProductionLayoutPlan(canvas.id) });
                    this.db.saveProductionLayoutPlan(canvas.id, layout);
                    const sceneOperations = productionSceneCreationOperations(canvas, next.draft, layout, owner, createdSceneIds, h3Defaults);
                    const clips = clipInputOperations(canvas, next.draft, layout, h3Defaults, materializeClipIds);
                    next.referenceSync = clips.referenceSync;
                    const readyClips = new Set(clips.referenceSync.filter(item => item.status === "ready").map(item => item.targetId));
                    const clipOperations = clips.operations.filter(op => {
                        if (op.type !== "update_h3_segment") return true;
                        const projection = record(record(op.patch).productionClipProjection);
                        return readyClips.has(String(projection.targetId || ""));
                    });
                    const operations = [...sceneOperations, ...scriptNodeOperations(canvas, next.draft, owner, current.draft, layout), ...imageInputOperations(canvas, next.draft, episodeId, current.draft, layout), ...clipOperations];
                    if (operations.length) this.db.applyCanvasProjectOperations(canvasId!, Number(canvas.revision || 0), operations, { operationId: projectionOperationId, runtimeWrite: true, withinTransaction: true, deferredCommits: scriptCommits, source: { kind: "system", clientId: "production:scripts", label: "同步正式制作节点输入" } });
                } else {
                    const operations = scriptNodeOperations(canvas, next.draft, { kind: this.ownerKind, id: episodeId }, current.draft);
                    if (operations.length) this.db.applyCanvasProjectOperations(canvasId!, Number(canvas.revision || 0), operations, { operationId: projectionOperationId, runtimeWrite: true, withinTransaction: true, deferredCommits: scriptCommits, source: { kind: "system", clientId: "production:scripts", label: "同步正式制作节点输入" } });
                }
            }
            this.syncSubjectClipDependencies(episodeId, next.draft.director);
            this.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(episode_id) DO UPDATE SET revision = excluded.revision, draft_json = excluded.draft_json, published_json = excluded.published_json, published_version = excluded.published_version, updated_at = excluded.updated_at")
                .run(episodeId, next.revision, JSON.stringify(next.draft), next.published ? JSON.stringify(next.published) : null, next.publishedVersion, next.updatedAt);
            this.prepare("INSERT INTO episode_production_operations (operation_id, episode_id, request_hash, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)")
                .run(operationId, episodeId, requestHash, JSON.stringify(dedupReceipt(next)), next.updatedAt);
            beforeCommit?.(next);
            this.db.db.exec("COMMIT");
            this.events?.publish({ type: "drama-production.updated", entityId: episodeId, payload: { revision: next.revision, publishedVersion: next.publishedVersion } });
            scriptCommits.forEach(commit => this.db.notifyCanvasCommit(commit));
            return { ...next, replayed: false };
        } catch (error) { this.db.db.exec("ROLLBACK"); throw error; }
    }

    private batchFromRow(row: Record<string, any>): ProductionBatch {
        return {
            runId: String(row.run_id), episodeId: String(row.scene_id || row.episode_id || row.project_id), version: Number(row.version),
            sourceRevision: Number(row.source_revision), idempotencyKey: String(row.idempotency_key), status: String(row.status),
            targets: JSON.parse(String(row.targets_json)) as string[], plan: JSON.parse(String(row.plan_json)) as ProductionImpact,
            engine: row.engine_json ? JSON.parse(String(row.engine_json)) as Record<string, unknown> : null,
            settings: JSON.parse(String(row.settings_json)) as Record<string, unknown>,
            executionSnapshot: row.execution_snapshot_json ? JSON.parse(String(row.execution_snapshot_json)) : null,
            submitted: JSON.parse(String(row.submitted_json)) as ProductionRun["submitted"], error: row.error === null ? null : String(row.error),
            pauseRequested: Boolean(row.pause_requested), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
        };
    }

    private fromRow(episodeId: string, row: Row): ProductionRecord {
        const draftRaw = JSON.parse(row.draft_json);
        const publishedRaw = row.published_json ? JSON.parse(row.published_json) : null;
        return { episodeId, revision: row.revision, draft: episodeProductionDataSchema.parse(draftRaw), published: publishedRaw ? episodeProductionDataSchema.parse(publishedRaw) : null, publishedVersion: row.published_version, updatedAt: row.updated_at };
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

    private restoreArchivedSceneResults(episodeId: string, current: ProductionRecord, draft: EpisodeProductionData, published: EpisodeProductionData,
        operation: Extract<ProductionOperation, { type: "restore_archived_scene_results" }>, operationId: string, canvasCommits?: CanvasCommit[]) {
        if (this.ownerKind !== "episode" || this.projectScope) throw new Error("迁移前场次视频恢复仅支持分集制作稿");
        const canvasId = this.episodeInfo(episodeId).canvasId;
        const project = canvasId && this.db.getCanvasProject(canvasId);
        if (!canvasId || !project || !draft.director || !published.director) throw new Error("恢复缺少固定分集画布或导演稿");
        if (Number(project.revision || 0) !== operation.expectedCanvasRevision) throw new Error(`恢复画布 revision 已变化：当前 ${Number(project.revision || 0)}`);
        const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, any>> : [];
        const byId = new Map(nodes.map(node => [String(node.id), node]));
        const sourceNode = byId.get(operation.sourceNodeId);
        const sourceMetadata = record(sourceNode?.metadata);
        if (!sourceNode || !isH3NodeType(String(sourceNode.type)) || !String(sourceMetadata.productionArchiveLabel || "").includes("原视频")) throw new Error("来源必须是保留原视频的迁移归档 H3 节点");
        const sourceSegments = Array.isArray(sourceMetadata.segments) ? sourceMetadata.segments as Array<Record<string, any>> : [];
        const sourceSegmentById = new Map(sourceSegments.map(segment => [String(segment.id || ""), segment]));
        const sceneEntries = productionSceneEntries(draft.director.source);
        const activeStatuses = new Set(["queued", "pending", "running", "loading", "generating", "awaiting_confirmation"]);
        const targetNodeIds = [...new Set(draft.clipGroups.map(group => String(group.nodeId || "")).filter(Boolean))];
        for (let offset = 0; ; offset += 500) {
            const page = this.db.listTasks({ projectId: canvasId, nodeIds: [operation.sourceNodeId, ...targetNodeIds], limit: 500, offset });
            const active = page.find(task => activeStatuses.has(task.status));
            if (active) throw new Error(`相关 H3 任务 ${active.id} 仍在执行，不能恢复归档结果`);
            if (page.length < 500) break;
        }

        const canvasOperations: CanvasOperation[] = [];
        for (const group of draft.clipGroups) {
            const segmentId = String(group.segmentId || "");
            const sourceClip = sourceSegmentById.get(segmentId);
            if (!sourceClip?.resultStorageKey || sourceClip.status !== "success") continue;
            const storageKey = String(sourceClip.resultStorageKey);
            const sceneIds = productionSceneIdsForShots(sceneEntries, group.shotIds);
            if (sceneIds.length !== 1) throw new Error(`Clip ${group.id} 未映射到唯一正式场次，不能恢复归档视频`);
            const sceneId = sceneIds[0];
            const targetNodeId = String(group.nodeId || "");
            const targetNode = targetNodeId ? byId.get(targetNodeId) : undefined;
            const expectedNodeId = productionLayoutStableId("production-h3-scene", episodeId, sceneId);
            const expectedGroupId = productionLayoutStableId("production-scene", episodeId, sceneId);
            if (!targetNode || targetNodeId !== expectedNodeId || !isH3NodeType(String(targetNode.type)) || String(record(targetNode.metadata).groupId || "") !== expectedGroupId) {
                throw new Error(`Clip ${group.id} 没有绑定到场次 ${sceneId} 的正式 H3 节点`);
            }
            const targetClip = (Array.isArray(record(targetNode.metadata).segments) ? record(targetNode.metadata).segments as Array<Record<string, any>> : []).find(clip => String(clip.id || "") === segmentId);
            if (!targetClip || String(record(targetClip.productionClipProjection).targetId || "") !== group.id) throw new Error(`场次 H3 缺少正式 Clip 投影：${group.id}`);
            if (targetClip.resultStorageKey && String(targetClip.resultStorageKey) !== storageKey) throw new Error(`场次 Clip ${group.id} 已绑定其他视频，拒绝覆盖`);
            if (activeStatuses.has(String(targetClip.status || ""))) throw new Error(`场次 Clip ${group.id} 正在运行，拒绝恢复归档视频`);

            const publishedGroup = published.clipGroups.find(item => item.id === group.id);
            if (!publishedGroup || publishedGroup.nodeId !== operation.sourceNodeId || publishedGroup.segmentId !== segmentId) throw new Error(`迁移前视频 ${group.id} 与当前发布版本的归档节点不匹配`);
            const logs = this.db.listGenerationLogs({ projectId: canvasId, nodeId: operation.sourceNodeId, segmentId, status: "success", limit: 100 })
                .filter(log => log.outputs.some(output => output.storageKey === storageKey));
            const candidates = logs.flatMap(log => {
                const task = log.runtimeTaskId ? this.db.getTask(log.runtimeTaskId) : null;
                if (!task || task.status !== "succeeded" || task.projectId !== canvasId || task.nodeId !== operation.sourceNodeId || task.segmentId !== segmentId) return [];
                const outputs = [...task.outputs, ...(Array.isArray(record(task.result).media) ? record(task.result).media as Array<Record<string, any>> : [])];
                const output = outputs.find(item => item.storageKey === storageKey && String(item.mimeType || "video/mp4").startsWith("video/"));
                return output ? [{ log, task, output }] : [];
            });
            if (candidates.length !== 1) throw new Error(`Clip ${group.id} 的归档媒体无法与唯一成功任务和日志对应`);
            const { log, task, output } = candidates[0];
            const media = this.db.getMediaFile(storageKey);
            if (!media || !fs.existsSync(media.filePath) || !String(media.mimeType || "").startsWith("video/")) throw new Error(`归档媒体 ${storageKey} 不可用`);
            const sha256 = promptHashBytes(media.filePath);
            const loggedOutput = log.outputs.find(item => item.storageKey === storageKey)!;
            if ((output.sha256 && output.sha256 !== sha256) || (loggedOutput.sha256 && loggedOutput.sha256 !== sha256)) throw new Error(`Clip ${group.id} 的归档视频摘要与任务日志不一致`);

            const parentTaskId = String(task.parentTaskId || record(task.params).parentTaskId || task.id);
            const bindingRows = [...new Set([task.id, parentTaskId])].map(taskId =>
                this.db.db.prepare("SELECT * FROM production_task_bindings WHERE task_id=? AND owner_kind=? AND owner_id=?").get(taskId, "episode", episodeId) as Record<string, any> | undefined).filter(Boolean) as Array<Record<string, any>>;
            const binding = bindingRows.find(row => {
                if (row.project_id !== canvasId || row.node_id !== operation.sourceNodeId || row.target_kind !== "segment" || row.status === "submitted") return false;
                const targets = JSON.parse(String(row.targets_json || "[]")) as Array<{ targetId?: string; segmentId?: string }>;
                return (row.target_id === group.id || targets.some(target => target.targetId === group.id && target.segmentId === segmentId));
            });
            // Older aggregate H3 runs may only have a run-level binding. The exact successful log,
            // task and archived Clip identity remain the authority when no per-Clip binding exists.
            const sourceHash = String(binding?.source_hash || record(sourceClip.productionClipProjection).sourceHash || sourceClip.directorSourceHash || published.director.sourceHash);
            const sourceVersion = Number(binding?.version || current.publishedVersion);
            const inputOutdated = sourceHash !== draft.director.sourceHash || clipInputHash(sourceClip) !== clipInputHash(targetClip);
            const selectedResult = { generationLogId: log.id, taskId: task.id, sourceVersion, sourceHash, sourceNodeId: operation.sourceNodeId };
            Object.assign(group, { selectedResult, inputOutdated });
            if (String(targetClip.resultStorageKey || "") === storageKey && targetClip.status === "success") continue;
            const url = `/media/${encodeURIComponent(storageKey)}`;
            canvasOperations.push({ type: "update_h3_segment", nodeId: targetNodeId, segmentId, expectedFields: { resultStorageKey: targetClip.resultStorageKey, status: targetClip.status }, patch: {
                result: url, resultStorageKey: storageKey, results: [{ url, storageKey, mimeType: media.mimeType }], status: "success", progress: 1,
                runtimeTaskId: "", parentTaskId: "", errorDetails: "", cacheFingerprint: "", firstPassReady: false, firstPassResult: "", firstPassStorageKey: "", firstPassFingerprint: "",
                archivedResultOrigin: { sourceNodeId: operation.sourceNodeId, sourceSegmentId: segmentId, generationLogId: log.id, taskId: task.id, storageKey, sourceVersion, sourceHash },
            } });
        }
        if (!draft.clipGroups.some(group => group.selectedResult?.sourceNodeId === operation.sourceNodeId)) throw new Error("迁移前归档节点没有可恢复的成功视频");
        if (canvasCommits && canvasOperations.length) this.db.applyCanvasProjectOperations(canvasId, operation.expectedCanvasRevision, canvasOperations, {
            operationId: `${operationId}:restore-archived-scene-results`, runtimeWrite: true, withinTransaction: true, deferredCommits: canvasCommits,
            source: { kind: "system", clientId: "production:restore-archived-scene-results", label: "恢复迁移前场次视频结果" },
        });
    }

    private selectDirectorResult(episodeId: string, draft: EpisodeProductionData,
        op: Extract<ProductionOperation, { type: "select_director_result" }>, operationId: string, canvasCommits?: CanvasCommit[]) {
        const canvasId = this.episode(episodeId).canvasId;
        const project = canvasId && this.db.getCanvasProject(canvasId);
        const node = project && (project.nodes as Record<string, any>[]).find(node => node.id === op.nodeId);
        const log = this.db.getGenerationLog(op.generationLogId);
        if (!node || !log || log.status !== "success" || log.projectId !== canvasId || log.nodeId !== op.nodeId) throw new Error("历史结果不属于当前制作节点，或尚未成功归档");
        if (Number(project!.revision) !== op.canvasRevision) throw new Error("画布已变化，请刷新历史后重新选择");
        const task = log.runtimeTaskId && this.db.getTask(log.runtimeTaskId);
        if (!task || task.status !== "succeeded" || task.projectId !== canvasId || task.nodeId !== op.nodeId || task.segmentId !== log.segmentId) throw new Error("历史结果缺少可核验的成功任务");
        const taskId = String(task.parentTaskId || record(task.params).parentTaskId || task.id);
        // An explicit human history selection targets the current draft. Publication
        // and old task snapshot formats are not prerequisites for this edit.
        const director = draft.director;
        if (!director) throw new Error("当前制作记录缺少导演数据，无法核对历史结果归属");
        let binding = this.db.db.prepare("SELECT * FROM production_task_bindings WHERE task_id=? AND owner_kind=? AND owner_id=?")
            .get(taskId, this.ownerKind, episodeId) as Record<string, any> | undefined;
        if (!binding) {
            // Production batches persist their exact task/target mapping in submitted_json,
            // independently of native node controls' production_task_bindings.
            const targetId = `${op.targetKind === "keyframe" ? "frame" : op.targetKind}:${op.targetId}`;
            const receipt = this.prepare(`SELECT b.version,
                COALESCE(json_extract(b.execution_snapshot_json, '$.sourceHash'), json_extract(v.snapshot_json, '$.director.sourceHash')) AS source_hash
                FROM episode_production_batches b
                LEFT JOIN episode_production_versions v ON v.episode_id=b.episode_id AND v.version=b.version,
                json_each(b.submitted_json) submitted
                WHERE b.episode_id=? AND json_extract(submitted.value, '$.taskId')=?
                AND json_extract(submitted.value, '$.id')=? AND json_extract(submitted.value, '$.kind')=?
                AND json_extract(submitted.value, '$.projectId')=? AND json_extract(submitted.value, '$.nodeId')=?
                AND json_extract(submitted.value, '$.segmentId') IS ?
                ORDER BY b.created_at DESC LIMIT 1`).get(episodeId, taskId, targetId, op.targetKind === "segment" ? "h3" : "image", canvasId!, op.nodeId, log.segmentId || null);
            if (receipt?.source_hash) binding = { ...receipt, project_id: canvasId, node_id: op.nodeId, target_kind: op.targetKind, target_id: op.targetId,
                targets_json: JSON.stringify([{ targetId: op.targetId, segmentId: log.segmentId }]), status: "bound" };
        }
        if (!binding || binding.project_id !== canvasId || binding.node_id !== op.nodeId || binding.target_kind !== op.targetKind || binding.status === "submitted") throw new Error("历史任务不属于当前正式制作对象，或尚未完成结果绑定");
        const outputs = [...task.outputs, ...(Array.isArray(record(task.result).media) ? record(task.result).media as Record<string, any>[] : [])];
        const output = outputs.find(output => output.storageKey === op.storageKey);
        const media = this.db.getMediaFile(op.storageKey);
        if (!output || !log.outputs.some(output => output.storageKey === op.storageKey) || !media || !fs.existsSync(media.filePath)) throw new Error("历史任务、日志和归档媒体不一致");
        const sha256 = promptHashBytes(media.filePath);
        if (output.sha256 && output.sha256 !== sha256) throw new Error("历史归档媒体摘要不一致");
        const metadata = record(node.metadata);
        const active = String(metadata.runtimeTaskId || "");
        if (["queued", "loading", "awaiting_confirmation"].includes(String(metadata.status)) || active && ["queued", "running", "awaiting_confirmation"].includes(this.db.getTask(active)?.status || "")) throw new Error("节点正在生成，不能替换活动结果");
        const selectedResult = { generationLogId: log.id, taskId, sourceVersion: Number(binding.version), sourceHash: String(binding.source_hash) };
        const staleInput = binding.source_hash !== director.sourceHash;
        let operations: Array<Record<string, unknown> & { type: string }>;
        if (op.targetKind === "segment") {
            const group = draft.clipGroups.find(group => group.id === op.targetId);
            const targets = JSON.parse(String(binding.targets_json)) as Array<{ targetId: string; segmentId?: string }>;
            if (!group || group.nodeId !== op.nodeId || log.segmentId !== group.segmentId || !targets.some(target => target.targetId === op.targetId && target.segmentId === group.segmentId)) throw new Error("历史视频不属于这个正式 Clip");
            const clip = (Array.isArray(metadata.segments) ? metadata.segments as Record<string, unknown>[] : []).find(clip => clip.id === group.segmentId);
            if (!clip || ["queued", "loading", "awaiting_confirmation"].includes(String(clip.status))) throw new Error("Clip 正在生成，不能替换活动结果");
            if (!String(media.mimeType).startsWith("video/")) throw new Error("Clip 历史结果必须是视频");
            operations = [{ type: "restore_h3_output", nodeId: op.nodeId, segmentId: group.segmentId, generationLogId: log.id, storageKey: op.storageKey, settings: {} }];
            Object.assign(group, { selectedResult, inputOutdated: staleInput });
        } else {
            if (binding.target_id !== op.targetId || !String(media.mimeType).startsWith("image/")) throw new Error("历史图片不属于这个正式资产或关键帧");
            const assetId = op.targetKind === "keyframe" ? director.shotInputs[op.targetId]?.keyframeAssetId : op.targetId;
            const asset = assetId && director.assets[assetId];
            if (!assetId || !asset || asset.nodeId !== op.nodeId || asset.sharedSource) throw new Error("请在原资产画布选择版本，不能修改共享引用");
            const priorKey = asset.storageKey;
            const selected = { ...asset, storageKey: op.storageKey, sha256, status: "generated" as const, evidence: "", inputOutdated: staleInput, selectedResult };
            director.assets[assetId] = selected;
            if (op.targetKind === "keyframe") {
                draft.keyframes[op.targetId] = { nodeId: op.nodeId, storageKey: op.storageKey, sourceVersion: selectedResult.sourceVersion };
                delete draft.keyframeReviews[op.targetId];
            }
            for (const artifact of director.artifacts) if (priorKey !== op.storageKey && artifact.references.some(ref => ref.nodeId === op.nodeId || ref.storageKey === priorKey)) artifact.status = "stale";
            const images = Array.isArray(metadata.images) ? metadata.images as Record<string, unknown>[] : [];
            const imageId = images.find(image => image.storageKey === op.storageKey)?.id || `history:${log.id}:${op.storageKey}`;
            const image = { id: imageId, status: "success", storageKey: op.storageKey, content: `/media/${encodeURIComponent(op.storageKey)}`, naturalWidth: media.width || 0, naturalHeight: media.height || 0, bytes: media.bytes, mimeType: media.mimeType };
            const { id: selectedImageId, ...imageMetadata } = image;
            operations = [{ type: "update_node", id: op.nodeId, metadata: { ...imageMetadata, url: image.content, images: images.some(image => image.storageKey === op.storageKey) ? images : [...images, image], primaryImageId: selectedImageId, runtimeTaskId: "", runProgress: 1, errorDetails: "" } }];
        }
        if (canvasCommits) this.db.applyCanvasProjectOperations(canvasId!, op.canvasRevision, operations, { operationId: `${operationId}:result:${op.targetKind}:${op.targetId}`, runtimeWrite: true, withinTransaction: true, deferredCommits: canvasCommits, source: { kind: "system", clientId: "production:history", label: "选用制作历史结果" } });
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

    private apply(episodeId: string, draft: EpisodeProductionData, op: ProductionOperation, sourceVersion: number, canvasCommits?: CanvasCommit[]) {
        if (op.type === "archive_director_scene") {
            if (!op.confirmed) throw new Error("SCENE_DELETE_CONFIRMATION_REQUIRED: 必须先确认删除场次");
            return archiveDirectorScene({ db: this.db, owner: { kind: this.ownerKind, id: episodeId }, draft, sceneId: op.sceneId,
                expectedCanvasRevision: op.expectedCanvasRevision, canvasCommits: canvasCommits || [],
                assertTargetsIdle: targets => {
                    const occupied = this.targetOccupancy(episodeId, targets);
                    if (occupied.length) throw new Error(`SCENE_DELETE_TARGET_OCCUPIED: ${occupied.map(item => `${item.targetId}:${item.status}`).join("；")}`);
                } });
        }
        if (op.type === "restore_director_scene") return restoreDirectorScene({ db: this.db, owner: { kind: this.ownerKind, id: episodeId }, draft,
            archiveId: op.archiveId, expectedCanvasRevision: op.expectedCanvasRevision, canvasCommits: canvasCommits || [] });
        if (op.type === "delete_director_clip") {
            if (!op.confirmed) throw new Error("CLIP_DELETE_CONFIRMATION_REQUIRED: 必须先确认删除 Clip");
            return deleteDirectorClip({ db: this.db, owner: { kind: this.ownerKind, id: episodeId }, draft, segmentId: op.segmentId,
                expectedCanvasRevision: op.expectedCanvasRevision, canvasCommits: canvasCommits || [],
                assertTargetsIdle: targets => {
                    const occupied = this.targetOccupancy(episodeId, targets);
                    if (occupied.length) throw new Error(`CLIP_DELETE_TARGET_OCCUPIED: ${occupied.map(item => `${item.targetId}:${item.status}`).join("；")}`);
                } });
        }
        if (op.type === "adopt_shared_asset") {
            if (!draft.director) throw new Error("缺少 Acheng 制作稿");
            const approved = approvedSharedAsset(this.db, op.approvedId);
            const episode = this.db.getDramaEpisode(episodeId);
            if (this.projectScope || episode?.dramaId !== approved.dramaId) throw new Error("共享资产必须属于当前集的剧目");
            if (Object.values(draft.director.shotInputs).some(input => input.keyframeAssetId === op.assetId)) throw new Error("关键帧属于本集，不能采用为剧目共享资产");
            const entry = (Array.isArray(draft.director.source.asset_plan) ? draft.director.source.asset_plan : []).map(record).find(item => String(item.asset_id || item.id || "") === op.assetId);
            if (!entry) throw new Error("共享资产目标未登记到制作源稿");
            entry.canvas_scope = "shared";
            const prior = draft.director.assets[op.assetId];
            const next = { nodeId: op.nodeId, version: String(entry.version || prior?.version || approved.snapshot.version), storageKey: approved.storageKey, sha256: approved.sha256,
                status: "approved" as const, evidence: approved.evidence, sharedSource: { dramaId: approved.dramaId, assetId: approved.assetId, approvedId: approved.id, sourceProjectId: approved.sourceProjectId, sourceNodeId: approved.sourceNodeId } };
            validateSharedAssetSource(this.db, episode!.canvasId!, next);
            draft.director.assets[op.assetId] = next;
            draft.director.sourceHash = directorHash(draft.director.source);
            draft.director.executionAuthorized = false;
            const inputChanged = prior?.storageKey !== approved.storageKey || prior?.sha256 !== approved.sha256;
            const plans = (Array.isArray(draft.director.source.asset_plan) ? draft.director.source.asset_plan : []).map(record);
            const dependsOn = (id: string, seen = new Set<string>()): boolean => {
                if (id === op.assetId) return true;
                if (seen.has(id)) return false;
                seen.add(id);
                const plan = plans.find(item => String(item.asset_id || item.id) === id);
                return (Array.isArray(plan?.depends_on) ? plan.depends_on : []).some((dependency: unknown) => dependsOn(String(dependency), seen));
            };
            if (inputChanged) for (const [id, asset] of Object.entries(draft.director.assets)) if (id !== op.assetId && asset.storageKey && dependsOn(id)) asset.inputOutdated = true;
            if (inputChanged) for (const group of draft.clipGroups) if (group.shotIds.some(id => {
                const shot = Array.isArray(draft.director!.source.shots) ? draft.director!.source.shots.map(record).find(item => String(item.id || "") === id) : undefined;
                const required = Array.isArray(shot?.required_assets) ? shot.required_assets.map(String) : [];
                return [...(draft.director!.shotInputs[id]?.assetIds || []), ...required].some(assetId => dependsOn(assetId));
            })) {
                const node = (this.db.getCanvasProject(episode!.canvasId!)?.nodes as Record<string, any>[] || []).find(node => node.id === group.nodeId);
                if ((record(node?.metadata).segments as Record<string, any>[] || []).some(segment => segment.id === group.segmentId && segment.resultStorageKey)) group.inputOutdated = true;
            }
            draft.director.artifacts = draft.director.artifacts.map(item => {
                const references = item.references.map(ref => ref.nodeId === prior?.nodeId ? { ...ref, nodeId: op.nodeId, storageKey: approved.storageKey, sha256: approved.sha256 } : ref);
                return { ...item, references, status: "stale" as const };
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
            if (Object.hasOwn(op.director.source, "_canvas_compilation_scope")) throw new Error("编译隔离标记不得写入正式源稿");
            draft.director = op.director;
            projectDirector(draft);
            return;
        }
        if (op.type === "upsert_director_subject") {
            if (!draft.director || !isSubjectPromptAssembly(draft.director.source)) throw new Error("SUBJECT_SOURCE_VERSION_REQUIRED: 仅 Subject Prompt v2 可写 Subject");
            const rows = clipRows(draft.director.source.subject_registry);
            const incoming = structuredClone(op.subject);
            const previousSubject = rows.find(subject => subject.id === incoming.id);
            const previousBindings = clipRows(previousSubject?.pictureBindings);
            const bindings = clipRows(incoming.pictureBindings);
            const canonicalByKey = new Map<string, string>();
            const bindingRemap = new Map<string, string>();
            const deduped = bindings.filter(binding => {
                const { id: bindingId, ...semantics } = binding;
                const key = canonicalProduction(semantics);
                const prior = canonicalByKey.get(key);
                if (prior) {
                    bindingRemap.set(String(binding.id), prior);
                    return false;
                }
                canonicalByKey.set(key, String(binding.id));
                return true;
            });
            for (const binding of previousBindings) {
                const { id: bindingId, ...semantics } = binding;
                const key = canonicalProduction(semantics);
                const canonical = canonicalByKey.get(key);
                if (canonical && canonical !== String(binding.id)) bindingRemap.set(String(binding.id), canonical);
            }
            for (const shot of clipRows(draft.director!.source.shots)) for (const usage of clipRows(shot.subject_usages)) {
                if (usage.subjectId !== incoming.id) continue;
                usage.pictureBindingIds = [...new Set((Array.isArray(usage.pictureBindingIds) ? usage.pictureBindingIds : []).map(id => bindingRemap.get(String(id)) || String(id)))];
            }
            incoming.pictureBindings = deduped as typeof incoming.pictureBindings;
            const index = rows.findIndex(subject => subject.id === incoming.id);
            if (index < 0) rows.push(incoming); else rows[index] = incoming;
            draft.director.source.subject_registry = rows;
            draft.director.sourceHash = directorHash(draft.director.source);
            draft.director.executionAuthorized = false;
            projectDirector(draft);
            return;
        }
        if (op.type === "repair_director_subject_bindings") {
            if (!draft.director || !isSubjectPromptAssembly(draft.director.source)) throw new Error("SUBJECT_SOURCE_VERSION_REQUIRED: 仅 Subject Prompt v2 可修复绑定");
            const source = draft.director.source;
            const subjects = clipRows(source.subject_registry);
            const remaps = new Map<string, string>();
            for (const subject of subjects) {
                const seen = new Map<string, any>();
                const kept: any[] = [];
                for (const binding of clipRows(subject.pictureBindings)) {
                    const { id: bindingId, ...semantics } = binding;
                    const key = canonicalProduction(semantics);
                    const prior = seen.get(key);
                    if (prior) remaps.set(String(binding.id), String(prior.id));
                    else { seen.set(key, binding); kept.push(binding); }
                }
                subject.pictureBindings = kept;
            }
            for (const shot of clipRows(source.shots)) for (const usage of clipRows(shot.subject_usages)) {
                const ids = (Array.isArray(usage.pictureBindingIds) ? usage.pictureBindingIds : []).map(id => remaps.get(String(id)) || String(id));
                usage.pictureBindingIds = [...new Set(ids)];
            }
            source.subject_registry = subjects;
            draft.director.sourceHash = directorHash(source);
            draft.director.executionAuthorized = false;
            projectDirector(draft);
            return;
        }
        if (op.type === "delete_director_subject") {
            if (!draft.director || !isSubjectPromptAssembly(draft.director.source)) throw new Error("SUBJECT_SOURCE_VERSION_REQUIRED");
            const source = draft.director.source;
            if (clipRows(source.shots).some(shot => clipRows(shot.subject_usages).some(usage => usage.subjectId === op.id)
                || (shot.camera?.attention_subject_ids || []).includes(op.id) || clipRows(shot.keyframes).some(frame => (frame.subjectIds || []).includes(op.id)))
                || clipRows(source.utterances).some(line => line.speakerSubjectId === op.id)) throw new Error("SUBJECT_STILL_REFERENCED: 该主体仍被镜头或对白使用，请先解除引用");
            source.subject_registry = clipRows(source.subject_registry).filter(subject => subject.id !== op.id);
            draft.director.sourceHash = directorHash(source);
            draft.director.artifacts = draft.director.artifacts.map(artifact => ({ ...artifact, status: "stale" as const }));
            projectDirector(draft);
            return;
        }
        if (op.type === "set_director_shot_keyframes") {
            if (!draft.director || !isSubjectPromptAssembly(draft.director.source)) throw new Error("SUBJECT_SOURCE_VERSION_REQUIRED: 仅 Subject Prompt v2 可编辑 Shot 关键帧");
            const shot = clipRows(draft.director.source.shots).find(item => item.id === op.shotId);
            if (!shot) throw new Error(`Shot ${op.shotId} 不存在`);
            shot.keyframes = structuredClone(op.keyframes);
            draft.director.sourceHash = directorHash(draft.director.source);
            draft.director.executionAuthorized = false;
            projectDirector(draft);
            return;
        }
        if (op.type === "repartition_director_clips") {
            if (!draft.director || !isSubjectPromptAssembly(draft.director.source)) throw new Error("SUBJECT_SOURCE_VERSION_REQUIRED: 仅 Subject Prompt v2 可重组 Clip");
            repartitionDirectorClips(draft.director, op);
            projectDirector(draft);
            return;
        }
        if (op.type === "edit_director_continuity") {
            if (!draft.director || !isSubjectPromptAssembly(draft.director.source)) throw new Error("SUBJECT_SOURCE_VERSION_REQUIRED: 仅 Subject Prompt v2 可细粒度编辑连续性台账");
            const ledger = draft.director.source.ledger as Record<string, any>;
            for (const change of op.changes) {
                const collection = ledger[change.collection];
                if (!Array.isArray(collection)) throw new Error(`连续性集合 ${change.collection} 不存在`);
                const index = collection.findIndex((entry: any) => String(entry.id || `${entry.timeline_id}:${entry.fact_id}`) === change.id);
                if (change.action === "delete") {
                    if (index < 0) throw new Error(`连续性条目 ${change.id} 不存在`);
                    collection.splice(index, 1);
                } else {
                    if (!change.value) throw new Error(`连续性条目 ${change.id} 缺少 value`);
                    if (String(change.value.id || `${change.value.timeline_id}:${change.value.fact_id}`) !== change.id) throw new Error("连续性条目 ID 与变更目标不符");
                    if (index < 0) collection.push(structuredClone(change.value)); else collection[index] = structuredClone(change.value);
                }
            }
            draft.director.sourceHash = directorHash(draft.director.source);
            draft.director.executionAuthorized = false;
            projectDirector(draft);
            return;
        }
        if (op.type === "request_director_clip_refresh") return;
        if (op.type === "replace_director_clip_storyboard") {
            if (!draft.director) throw new Error("缺少 Acheng 制作稿");
            replaceDirectorClipStoryboard(draft.director, op);
            projectDirector(draft);
            return;
        }
        if (op.type === "replace_director_scene_storyboard") {
            if (!draft.director) throw new Error("缺少 Acheng 制作稿");
            replaceDirectorSceneStoryboard(draft.director, op);
            projectDirector(draft);
            return;
        }
        if (op.type === "patch_director_source") {
            if (!draft.director) throw new Error("缺少 Acheng 制作稿");
            this.patchDirectorSource(draft.director, op.entity, op.id, op.patch);
            projectDirector(draft);
            return;
        }
        if (op.type === "adopt_director_fields") {
            const canvasId = this.episodeInfo(episodeId).canvasId, project = canvasId && this.db.getCanvasProject(canvasId);
            if (!project || Number(project.revision) !== op.canvasRevision) throw new Error("画布版本已变化，请重新读取差异");
            const node = (project.nodes as any[]).find(node => node.id === op.nodeId);
            const current = op.segmentId ? node?.metadata?.segments?.find((segment: any) => segment.id === op.segmentId) : node?.metadata;
            const projection = op.segmentId ? current?.productionClipProjection : current?.productionImageProjection;
            if (!projection || projection.targetId !== op.targetId) throw new Error("目标导演基线不属于当前对象");
            const owned = op.segmentId ? draft.clipGroups.some(group => group.id === op.targetId && group.nodeId === op.nodeId && group.segmentId === op.segmentId)
                : Object.entries(draft.director?.assets || {}).some(([id, asset]) => id === op.targetId && (asset.nodeId === op.nodeId || projection.sourceNodeId === op.nodeId));
            if (!owned) throw new Error("导演字段采用目标归属无效");
            const adopted = adoptedDirectorFields(current, projection, op.fields);
            const referenceIds = adopted.patch.referenceNodeIds;
            delete adopted.patch.referenceNodeIds;
            const operations: CanvasOperation[] = [op.segmentId
                ? { type: "update_h3_segment", nodeId: op.nodeId, segmentId: op.segmentId, ...adopted }
                : { type: "update_node", id: op.nodeId, metadata: adopted.patch, metadataDelete: adopted.patchDelete }];
            if (Array.isArray(referenceIds)) {
                const sourceId = projection.sourceNodeId || op.nodeId;
                const incoming = (project.connections as any[]).filter(edge => edge.toNodeId === sourceId);
                if (incoming.length) operations.push({ type: "delete_connections", ids: incoming.map(edge => edge.id) });
                referenceIds.forEach((fromNodeId, order) => operations.push({ type: "connect_nodes", id: `adopt-${crypto.randomUUID()}`, fromNodeId, toNodeId: sourceId, order }));
            }
            if (canvasCommits) this.db.applyCanvasProjectOperations(project.id, op.canvasRevision, operations, { runtimeWrite: true, withinTransaction: true, deferredCommits: canvasCommits, source: { kind: "system", clientId: "production:adopt", label: "采用选定导演字段" } });
            return;
        }
        if (op.type === "adopt_director_clip_style") {
            if (!draft.director) throw new Error("缺少正式导演源稿");
            const canvasId = this.episodeInfo(episodeId).canvasId;
            const project = canvasId && this.db.getCanvasProject(canvasId);
            if (!project || Number(project.revision) !== op.canvasRevision) throw new Error("画布版本已变化，请重新读取用户修改后再采用");
            const group = draft.clipGroups.find(group => group.id === op.targetId);
            if (!group || group.nodeId !== op.nodeId || group.segmentId !== op.segmentId) throw new Error("待采用的 Clip 不属于该正式目标");
            const node = (project.nodes as any[]).find(node => node.id === op.nodeId);
            const nodeClips = record(node?.metadata).segments;
            const clip = (Array.isArray(nodeClips) ? nodeClips : []).find((clip: any) => clip.id === op.segmentId);
            if (!clip || (clip.styleTemplateId ?? null) !== op.styleTemplateId) throw new Error("Clip 风格已变化，请重新核对用户修改");
            this.patchDirectorSource(draft.director, "segment", op.targetId, { styleTemplateId: op.styleTemplateId });
            projectDirector(draft);
            return;
        }
        if (op.type === "patch_director_continuity") {
            if (!draft.director) throw new Error("缺少 Acheng 制作稿");
            if ((draft.director.source.ledger as any)?.contract_version !== 2) throw new Error("LEGACY_CONTINUITY_UPGRADE_REQUIRED: 旧版账本必须通过显式升级操作切换合同");
            if (isSubjectPromptAssembly(draft.director.source)) throw new Error("CONTINUITY_FINE_GRAIN_REQUIRED: Subject Prompt v2 必须使用 edit_director_continuity，不能整体覆盖连续性台账");
            this.patchDirectorSource(draft.director, "continuity", undefined, { ledger: op.ledger });
            projectDirector(draft);
            return;
        }
        if (op.type === "reverse_sync_director_prompt") {
            if (!draft.director || !isSubjectPromptAssembly(draft.director.source)) throw new Error("SUBJECT_SOURCE_VERSION_REQUIRED: Prompt 反向同步仅适用于 Subject Prompt v2");
            if (draft.director.sourceHash !== op.sourceHash) throw new Error("PROMPT_REVERSE_SYNC_STALE_SOURCE: 源稿版本已变化，保留人工 Prompt 并重新读取差异");
            const artifact = draft.director.artifacts.find(item => item.id === op.artifactId && item.kind === "h3" && item.targetId === op.segmentId);
            if (!artifact || artifact.status !== "ready" || !currentCompilationArtifact(draft.director, artifact) || artifact.sha256 !== op.basePromptHash || artifact.sourceHash !== op.sourceHash) throw new Error("PROMPT_REVERSE_SYNC_BASELINE_MISMATCH: 编译基线已变化，保留人工 Prompt 并重新读取差异");
            const ownerCanvasId = this.episodeInfo(episodeId).canvasId;
            const project = ownerCanvasId && this.db.getCanvasProject(ownerCanvasId);
            if (!project || Number(project.revision || 0) !== op.canvasRevision) throw new Error("PROMPT_REVERSE_SYNC_CANVAS_STALE: 画布已变化，保留人工 Prompt 并重新读取差异");
            const group = draft.clipGroups.find(item => item.id === op.segmentId);
            const node = group?.nodeId ? (project.nodes as Record<string, any>[] || []).find(item => item.id === group.nodeId) : undefined;
            const currentClip = (record(node?.metadata).segments as Record<string, any>[] || []).find(item => item.id === group?.segmentId);
            const projection = record(currentClip?.productionClipProjection);
            if (!group || !currentClip || projection.targetId !== group.id || currentClip.prompt !== op.prompt) throw new Error("PROMPT_REVERSE_SYNC_CANVAS_CONFLICT: 画布 Prompt 或 Clip 归属已变化，保留当前内容并重新读取差异");
            const sourceMapValue = (artifact.receipt as Record<string, any>).sourceMap;
            const checkedSourceMap = promptSourceMapSchema.safeParse(sourceMapValue);
            if (!checkedSourceMap.success || !checkedSourceMap.data.entries.length) {
                throw new Error("PROMPT_SOURCE_MAP_UNAVAILABLE: 当前激活编译器没有提供字段级 SourceMap；人工 Prompt 仍保留在画布，未猜测回写源稿");
            }
            const sourceMap = checkedSourceMap.data as PromptSourceMap;
            if (sourceMap.segmentId !== op.segmentId || sourceMap.sourceHash !== op.sourceHash || sourceMap.promptHash !== op.basePromptHash) throw new Error("PROMPT_REVERSE_SYNC_MAP_STALE: SourceMap 与编译基线不匹配，保留人工 Prompt");
            const result = reverseSyncPromptEdit(artifact.prompt, op.prompt, sourceMap);
            if (!result.changed) return;
            preserveCompilationProvenance(draft.director);
            if (result.sourceKind === "shot") {
                const shot = clipRows(draft.director.source.shots).find(item => item.id === result.sourceId);
                if (result.field === "camera.editorial_reason") {
                    const camera = shot?.camera && typeof shot.camera === "object" && !Array.isArray(shot.camera) ? shot.camera as Record<string, any> : undefined;
                    if (!camera || typeof camera.editorial_reason !== "string") throw new Error("PROMPT_REVERSE_SYNC_SOURCE_CONFLICT: SourceMap 所指摄影字段已变化或不可编辑，保留人工 Prompt");
                    camera.editorial_reason = result.value;
                } else {
                    if (!shot || typeof shot[result.field] !== "string") throw new Error("PROMPT_REVERSE_SYNC_SOURCE_CONFLICT: SourceMap 所指 Shot 字段已变化或不可编辑，保留人工 Prompt");
                    shot[result.field] = result.value;
                }
            } else {
                const utterance = clipRows(draft.director.source.utterances).find(item => item.id === result.sourceId);
                if (!utterance || typeof utterance.text !== "string") throw new Error("PROMPT_REVERSE_SYNC_SOURCE_CONFLICT: SourceMap 所指对白已变化，保留人工 Prompt");
                utterance.text = result.value;
            }
            draft.director.sourceHash = directorHash(draft.director.source);
            draft.director.artifacts = draft.director.artifacts.map(item => item.status === "ready" && !currentCompilationArtifact(draft.director!, item) ? { ...item, status: "stale" as const } : item);
            draft.director.executionAuthorized = false;
            projectDirector(draft);
            return;
        }
        if (op.type === "upgrade_director_continuity") {
            if (!draft.director) throw new Error("缺少 Acheng 制作稿");
            if (draft.director.sourceHash !== op.fromSourceHash) throw new Error("CONTINUITY_UPGRADE_PREVIEW_STALE: 源稿变化，请重新预览后升级");
            if ((draft.director.source.ledger as any)?.contract_version === 2) throw new Error("连续性账本已经升级到 v2");
            if (op.ledger.contract_version !== 2) throw new Error("升级包必须明确声明 contract_version: 2");
            const activeRuns = this.continuityUpgradeActiveRuns(episodeId);
            if (activeRuns.length) throw new Error(`CONTINUITY_UPGRADE_WAIT: 活动生成任务仍在占用版本：${activeRuns.map(run => run.runId).join(", ")}`);
            const target = resolveAchengEngine();
            if (target.runtimeId !== op.toRuntimeId) throw new Error("CONTINUITY_UPGRADE_RUNTIME_STALE: 当前激活运行版本已变化，请重新预览");
            const expectedPreview = fingerprint({ owner: { kind: this.ownerKind, id: episodeId }, expectedRevision: op.previewRevision,
                fromSourceHash: op.fromSourceHash, targetRuntimeId: op.toRuntimeId, ledger: op.ledger });
            if (op.previewHash !== expectedPreview) throw new Error("CONTINUITY_UPGRADE_PREVIEW_STALE: 预览内容与升级输入不一致");
            const legacyLedger = draft.director.source.ledger;
            this.patchDirectorSource(draft.director, "continuity", undefined, { ledger: op.ledger });
            draft.director.source.legacyContinuityProjection = legacyLedger ?? null;
            const engine = resolveAchengRuntime(op.toRuntimeId);
            draft.director.engine = { commit: engine.commit, patchVersion: engine.patchVersion, runtimeId: engine.runtimeId, version: engine.version };
            draft.director.sourceHash = directorHash(draft.director.source);
            draft.director.executionAuthorized = false;
            draft.director.artifacts = draft.director.artifacts.map(artifact => ({ ...artifact, status: "stale" as const }));
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
            const owningGroups = draft.clipGroups.filter(group => group.shotIds.includes(op.id));
            if (owningGroups.some(group => group.shotIds.length <= 1)) throw new Error("SHOT_LAST_IN_CLIP: 不能单独删除 Clip 的最后一个镜头；请删除整个 Clip");
            draft.shots = draft.shots.filter((item) => item.id !== op.id);
            delete draft.keyframes[op.id]; delete draft.keyframeReviews[op.id];
            draft.clipGroups = draft.clipGroups.map((group) => ({ ...group, shotIds: group.shotIds.filter((id) => id !== op.id) }));
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
            if (draft.director && Object.hasOwn(op.patch, "storyboardImageMode")) projectDirector(draft);
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
        if (draft.director) {
            const diagnostics = schemaDiagnostics(directorProductionSchema, draft.director);
            if (diagnostics.length) throw new ProductionValidationError(diagnostics.map(issue => ({ ...issue, path: `director.${issue.path}` })));
        }
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

    private publishedCandidate(record: ProductionRecord, stage: "script" | "shots" | "director", scope?: { sceneId?: string; targetIds?: string[] }) {
        const candidate = structuredClone(record.published || emptyEpisodeProduction());
        if (stage === "director") {
            if (!record.draft.director) throw new Error("缺少 Acheng 制作稿");
            const directorCandidate = structuredClone(record.draft);
            projectDirector(directorCandidate);
            if (scope && !directorCandidate.settings.parallelScenes) throw new Error("按范围发布须显式启用场次并行制作");
            this.validateSource(scope ? scopedCompilerInput(compilationScopeInput(directorCandidate.director!, scope).director, scope) : directorCandidate.director!, "publish");
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
        impact.imageShotIds = candidate.settings.storyboardImageMode === "skip" ? [] : [...new Set([...impact.imageShotIds, ...candidate.shots.filter((shot) => scriptScenes.has(shot.sceneId) && shot.keyframePolicy === "new").map((shot) => shot.id)])];
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
            imageShotIds: next.settings.storyboardImageMode === "skip" ? [] : next.shots.filter((shot) => imageAffected.has(shot.id) && shot.keyframePolicy === "new").map((shot) => shot.id),
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
        const keyframeAssetIds = new Set([
            ...Object.values(after.shotInputs).map(input => input.keyframeAssetId).filter((id): id is string => Boolean(id)),
            ...list(after.source.asset_plan).filter(item => ["keyframe", "storyboard", "frame"].includes(String(item.kind || item.asset_type || "").toLowerCase())).map(assetId),
        ]);
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
        const imageShotIds = next.settings.storyboardImageMode === "skip" ? [] : [...new Set([...changedFrameShots, ...list(after.source.shots).filter(shot => {
            const input = after.shotInputs[String(shot.id)];
            return input?.keyframeAssetId && changedAssets.includes(input.keyframeAssetId);
        }).map(shot => String(shot.id))])].filter(id => after.shotInputs[id]?.keyframePolicy === "new");
        const clipGroupIds = [...new Set([...changedSegments, ...next.clipGroups.filter(group => group.shotIds.some(id => changedH3Shots.includes(id))).map(group => group.id)])];
        const affected = new Set(affectedShotIds);
        const assetIds = next.settings.storyboardImageMode === "skip" ? changedAssets.filter(id => !keyframeAssetIds.has(id)) : changedAssets;
        return { changedSceneIds, affectedShotIds, imageShotIds, clipGroupIds, missingAssetNodeIds: this.missingAssets(episodeId, next, affected), assetIds };
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
