// probe-reload-trigger-1
import { entityNodeOperations, removedSharedEntityNodeOperations, removedSubjectEntityNodeOperations } from "./entity-nodes.js";
import { captureCanvasInputs, effectiveTargetInput, inputHash, type CanvasExecutionSnapshot } from "./canvas-inputs.js";
import { replaceDirectorSceneStoryboard } from "./scene-storyboard.js";
import { editDirectorShot } from "./shot-edit.js";
import { createManualDirectorAsset, deleteDirectorAsset } from "./director-asset-delete.js";
import { sourceOf } from "../canvas/drama-asset-library.js";
import { replaceDirectorClipStoryboard, repartitionDirectorClips, assertClipEdit, clipShots, rows as clipRows } from "./clip-storyboard.js";
import { ClipRefreshStore, clipRefreshReceipt, clipRefreshScope } from "./clip-refresh.js";
import { reverseSyncPromptEdit, type PromptSourceMap } from "./prompt-reverse-sync.js";
import { subjectShotWindows, subjectStateProjection } from "@basketikun/canvas-agent/drama/subject-assembly";
import { adoptedDirectorFields } from "./input-merge.js";
import crypto from "node:crypto";
import { assertDirectorWorkScope, directorArtifact, directorAdoption, type DirectorWorkPackage } from "@basketikun/canvas-agent/agent/work-package";
import { DIRECTOR_SUBAGENT_KIND } from "@basketikun/canvas-agent/agent/delegation";
import { currentCompilationArtifact, compilationScopeInput, preserveCompilationProvenance, preserveH3ArtifactsAfterShotDurationOnlyEdit, scopedCompilerInput, productionReviewHash } from "@basketikun/canvas-agent/drama/compilation-scope";
import fs from "node:fs";
import path from "node:path";

import {
    emptyEpisodeProduction,
    canonicalProduction,
    productionImageModel,
    productionSceneEntries,
    productionScriptGroups,
    episodeProductionDataSchema,
    episodeProductionHistoryDataSchema,
    directorRunStartSchema,
    directorModules,
    directorProductionSchema,
    productionEditSchema,
    productionPublishSchema,
    productionPreflightRequestSchema,
    productionContinuityReadSchema,
    productionContinuityCheckSchema,
    productionContractVersion,
    productionEntities,
    diagnosticBlocksAction,
    isSubjectPromptAssembly,
    defaultRequiredShotKeyframes,
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
import { H3_DEFAULTS_KEY, H3_PARAM_KEYS } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { generationSettingsSnapshot } from "../canvas/generation-settings.js";
import { H3_RUNTIME_NODE_FIELDS, H3_RUNTIME_SEGMENT_FIELDS } from "@basketikun/canvas-agent/runtime-fields";
import { resolveAchengEngine } from "@basketikun/canvas-agent/skills/acheng";
import { assertAchengSource, auditAchengContinuity, validateAchengSource, preflightCompilationDirector, type AchengRuntime } from "@basketikun/canvas-agent/skills/acheng";
import { schemaDiagnostics, ProductionValidationError, applyDirectorSourcePatch, changedModelTextIdDiagnostics } from "@basketikun/canvas-agent/drama/production-validation";
import { selectSmartImageResult } from "@basketikun/canvas-agent/reference-contract";

import { directorHash, projectDirector, validateDirectorMedia, assertDirectorEngine, withoutDirectorProjection, publicProductionRecord } from "./director.js";
import { DATA_DIR } from "../config.js";
import { resolveCanvasCharacterImageReferences, resolveCanvasImageReferenceNode } from "../canvas/image-references.js";
import type { BackendDatabase } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { CanvasCommit } from "../canvas/collaboration.js";
import type { CanvasOperation } from "../canvas/project-ops.js";
import { listApprovedSharedAssets, registerSharedAssetVersion, sharedAssetHistory, sharedAssetNodeMatchesSource, validateSharedAssetSourceIdentity, type ApprovedSharedAsset, type SharedAssetIdentity } from "./shared-assets.js";
import { ensureProductionCanvas, productionCanvasContext } from "./production-canvas.js";
import { explicitShotCueCount, importDemandScriptBlocks } from "./script-demand-import.js";
import { scriptNodeOperations } from "./script-nodes.js";
import { translateH3PromptBatch } from "../canvas/translation.js";
import { compileProductionLayout, existingProductionSceneH3NodeId, productionAssetPosition, productionSceneIdsForShots } from "./production-layout.js";
import { productionLayoutStableId, productionNodePosition } from "./production-layout-geometry.js";
import { sharedSubjectPictureBinding } from "./shared-subject-picture.js";
import { compiledImageInput, assertImageReferenceCoverage, imageInputOperations, verifyImageInput } from "./image-inputs.js";
import { buildPublishedProductionClip, clipInputHash, clipInputOperations, formalStoryboardTrack, productionClipProjection, type ReferenceSync } from "./clip-inputs.js";
import { productionSceneCreationOperations } from "./production-scene-nodes.js";
import { archiveDirectorScene, deleteDirectorClip, listArchivedDirectorScenes, restoreDirectorScene } from "./production-scene-archive.js";
import { continuityTargetBlockers, ProductionContinuityReports } from "./continuity-reports.js";
import { isArchivedStoryboardKeyframeBinding } from "./storyboard-media.js";
import { dedupReceipt, resolveReceiptDedup, assertPublicReceipt } from "./receipt-dedup.js";
import { decodeReceipt, encodeReceipt, type StoredReceipt } from "./receipt-storage.js";
import type { NativeProductionTarget } from "./native-generation.js";

type Row = { revision: number; draft_json: string; published_json: string | null; published_version: number; updated_at: string; archived_at: string | null };
export type ProductionImpact = { changedSceneIds: string[]; affectedShotIds: string[]; imageShotIds: string[]; clipGroupIds: string[]; missingAssetNodeIds: string[]; assetIds?: string[] };
export type ProductionRecord = { episodeId: string; revision: number; draft: EpisodeProductionData; published: EpisodeProductionData | null; publishedVersion: number; updatedAt: string; archivedAt: string | null; referenceSync?: ReferenceSync[]; storageFormat?: "v2-single-source" | "v2-projection-migration-required"; publishedFormatStatus?: "legacy-maintenance-required" };
export type CompiledPromptTranslationRequest = { expectedRevision: number; operationId: string; targetIds: string[] };
export type ProductionTargetOccupancy = { targetId: string; status: string; runId?: string; taskIds: string[]; tasks: Array<{ taskId: string; status: string }>; nextAction: NonNullable<ProductionDiagnostic["nextAction"]> };
const activePromptTranslations = new Map<string, Promise<void>>();
const readinessStampBootId = crypto.randomUUID();
const activePromptTranslationControllers = new Map<string, AbortController>();
export type ProductionRun = { episodeId: string; version: number; runId?: string; targets?: string[]; engine?: Record<string, unknown> | null; settings?: Record<string, unknown>; executionSnapshot?: CanvasExecutionSnapshot | null; status: string; plan: ProductionImpact; submitted: Array<{ kind: "image" | "h3"; id: string; taskId: string; projectId?: string; nodeId?: string; segmentId?: string; status?: "running" | "succeeded" | "failed" }>; error: string | null; updatedAt: string };
export type ProductionBatch = {
    runId: string; episodeId: string; version: number; sourceRevision: number; idempotencyKey: string; status: string;
    targets: string[]; plan: ProductionImpact; engine: Record<string, unknown> | null; settings: Record<string, unknown>;
    executionSnapshot?: CanvasExecutionSnapshot | null; submitted: ProductionRun["submitted"]; error: string | null; pauseRequested: boolean; createdAt: string; updatedAt: string;
};
export type DirectorReadinessTarget = { id: string; targetId: string; kind: "asset" | "keyframe" | "segment"; title: string; status: "ready" | "blocked" | "needs_review" | "complete"; blockers: string[]; warnings?: string[]; artifactId?: string; executionTargets?: string[]; notice?: string };
export type DirectorPresentation = {
    key: string; workId: string; owner: { kind: "canvas" | "episode" | "scene"; id: string }; aliases?: string[]; workspace: "overview" | "story" | "assets" | "shots" | "continuity" | "production" | "advanced";
    action: "author" | "compile" | "produce" | "review" | "deliver" | "blocked"; targetKind?: string; targetId?: string; canvasId?: string;
    nodeId?: string; segmentId?: string; runId?: string; taskId?: string; status: "ready" | "working" | "needs_review" | "blocked" | "complete"; reason?: string;
};
export type DirectorStageReadiness = {
    draftInitialized: boolean;
    scriptBlocks: number;
    explicitShotCues: number;
    structuredShots: number;
    assetCards: number;
    segments: number;
    compileGate: "not_started" | "blocked" | "preflight_required";
    compileBlockers: string[];
    authoringGaps: string[];
    nextAction: string;
};
export type DirectorReadiness = { revision: number; publishedVersion: number; source: "draft" | "published"; canvasId?: string; canvasRevision?: number; targets: DirectorReadinessTarget[]; modules: Record<string, unknown>; unresolved: string[]; nextAction: string; presentation?: DirectorPresentation; sceneWorks?: DirectorProduction["workflow"]["sceneWorks"]; stage?: DirectorStageReadiness };

const fingerprint = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
function assertSingleSourceStorage(record: ProductionRecord) {
    if (record.storageFormat === "v2-projection-migration-required") throw new ProductionValidationError([{
        code: "DIRECTOR_STORAGE_MIGRATION_REQUIRED", path: "draft", message: "当前 v2 草稿仍保存旧工作台镜像。请先通过生产源稿维护命令检查并显式迁移；原稿未修改。", severity: "error",
    }]);
}
function remapSubjectEntityReferences(source: Record<string, any>, kind: string, fromId: string, toId: string) {
    if (!fromId || !toId || fromId === toId) return;
    const objectKinds = kind === "prop" ? new Set(["asset", "prop"]) : new Set([kind]);
    const ledger = record(source.ledger);
    for (const fact of clipRows(ledger.facts)) if (objectKinds.has(String(fact.object_kind || "")) && String(fact.object_id || "") === fromId) fact.object_id = toId;
    for (const shot of clipRows(source.shots)) {
        if (kind === "scene" && String(shot.scene_id || "") === fromId) shot.scene_id = toId;
        if (kind !== "character") continue;
        if (Array.isArray(shot.characters)) shot.characters = shot.characters.map((item: unknown) => {
            if (typeof item === "string") return item === fromId ? toId : item;
            if (!item || typeof item !== "object" || Array.isArray(item)) return item;
            const value = item as Record<string, any>;
            if (String(value.id || "") === fromId) value.id = toId;
            if (String(value.character_id || "") === fromId) value.character_id = toId;
            return value;
        });
    }
    if (kind === "scene") for (const scene of clipRows(source.script_scenes)) {
        if (String(scene.scene_id || "") === fromId) scene.scene_id = toId;
        if (String(scene.sceneId || "") === fromId) scene.sceneId = toId;
    }
}
function clearSubjectEntityLedgerReferences(source: Record<string, any>, subject: Record<string, any>) {
    const entityRef = record(subject.entityRef);
    const kind = String(entityRef.kind || "");
    const entityId = String(entityRef.id || "");
    if (!kind || !entityId) return;
    const objectKinds = kind === "asset" ? new Set(["asset", "prop"]) : new Set([kind]);
    const ledger = record(source.ledger);
    const removedFacts = new Set(clipRows(ledger.facts).filter(fact => objectKinds.has(String(fact.object_kind || "")) && String(fact.object_id || "") === entityId)
        .map(fact => String(fact.id || "")).filter(Boolean));
    if (!removedFacts.size) return;
    const removedEvents = new Set(clipRows(ledger.events).filter(event => removedFacts.has(String(event.fact_id || ""))).map(event => String(event.id || "")).filter(Boolean));
    if (Array.isArray(ledger.facts)) ledger.facts = ledger.facts.filter((fact: Record<string, any>) => !removedFacts.has(String(fact.id || "")));
    if (Array.isArray(ledger.initial)) ledger.initial = ledger.initial.filter((item: Record<string, any>) => !removedFacts.has(String(item.fact_id || "")));
    if (Array.isArray(ledger.events)) ledger.events = ledger.events.filter((item: Record<string, any>) => !removedFacts.has(String(item.fact_id || "")));
    if (Array.isArray(ledger.requirements)) ledger.requirements = ledger.requirements.filter((item: Record<string, any>) => !removedFacts.has(String(item.fact_id || "")))
        .map((item: Record<string, any>) => ({ ...item, event_ids: Array.isArray(item.event_ids) ? item.event_ids.filter((id: unknown) => !removedEvents.has(String(id))) : item.event_ids }));
    if (Array.isArray(ledger.coverage)) ledger.coverage = ledger.coverage.map((item: Record<string, any>) => ({
        ...item,
        fact_ids: Array.isArray(item.fact_ids) ? item.fact_ids.filter((id: unknown) => !removedFacts.has(String(id))) : item.fact_ids,
        event_ids: Array.isArray(item.event_ids) ? item.event_ids.filter((id: unknown) => !removedEvents.has(String(id))) : item.event_ids,
    }));
}
function ensureSharedSubjectPictureBinding(director: DirectorProduction, episodeId: string, canvasId: string, assetPlan: Record<string, any>, subjectId: string): boolean {
    const kind = String(assetPlan.kind || "");
    const assetId = String(assetPlan.id || assetPlan.asset_id || "");
    const entityId = String(assetPlan.entity_id || assetPlan.id || assetPlan.asset_id || "");
    if (!assetId) return false;
    const entityRefKind = kind === "prop" ? "asset" : kind;
    const subject = clipRows(director.source.subject_registry).find(row => String(row.id || "") === subjectId
        || row.entityRef?.ownerKind === "episode" && row.entityRef?.ownerId === episodeId && row.entityRef?.kind === entityRefKind && String(row.entityRef?.id || "") === entityId);
    if (!subject) return false;
    const bindings = clipRows(subject.pictureBindings);
    const binding = sharedSubjectPictureBinding(subject, assetPlan, episodeId, canvasId);
    if (!binding) return false;
    // A legacy binding can already point at the same shared asset through its mirror image node.
    // Replace it and remap the Shots/keyframes that selected it, instead of leaving two entries
    // for one picture (which reads as a duplicate "same image" reference in the Subject panel).
    // Costume variants stay untouched: they are explicit `selected_result` bindings.
    const legacyIds = new Set(bindings.filter(item => String(item.assetId || "") === assetId
        && item.selection?.mode === "node_selection"
        && String(item.sourceNode?.nodeId || "") !== binding.sourceNode.nodeId).map(item => String(item.id || "")).filter(Boolean));
    if (legacyIds.size) {
        const remap = (id: unknown) => legacyIds.has(String(id)) ? binding.id : String(id);
        for (const shot of clipRows(director.source.shots)) {
            for (const usage of clipRows(shot.subject_usages)) {
                if (Array.isArray(usage.pictureBindingIds)) usage.pictureBindingIds = [...new Set(usage.pictureBindingIds.map(remap))];
            }
            for (const frame of clipRows(shot.keyframes)) {
                const bySubject = frame.subjectPictureBindingIds && typeof frame.subjectPictureBindingIds === "object" ? frame.subjectPictureBindingIds as Record<string, unknown> : undefined;
                for (const [key, ids] of Object.entries(bySubject || {})) {
                    if (Array.isArray(ids)) bySubject![key] = [...new Set(ids.map(remap))];
                }
            }
        }
    }
    subject.pictureBindings = [...bindings.filter(item => !legacyIds.has(String(item.id || ""))), binding];
    director.sourceHash = directorHash(director.source);
    director.executionAuthorized = false;
    director.artifacts = director.artifacts.map(artifact => ({ ...artifact, status: "stale" as const }));
    if (director.workflow.currentWork) director.workflow.currentWork = { ...director.workflow.currentWork, sourceHash: director.sourceHash };
    return true;
}
function validateSharedAssetPlanSources(db: BackendDatabase, canvasId: string, director: DirectorProduction, allowLocalPromotionCandidates = false) {
    for (const plan of clipRows(director.source.asset_plan)) {
        const source = plan.sharedSource;
        if (source && typeof source === "object") {
            validateSharedAssetSourceIdentity(db, canvasId, source as SharedAssetIdentity);
        } else if (String(plan.canvas_scope || "episode") === "shared") {
            const assetId = String(plan.asset_id || plan.id || "");
            const asset = director.assets[assetId];
            const node = asset?.nodeId && (db.getCanvasProject(canvasId)?.nodes as Record<string, any>[] || []).find(item => String(item.id) === asset.nodeId);
            const localPromotionCandidate = allowLocalPromotionCandidates && productionCanvasContext(db, canvasId).role === "episode"
                && Boolean(node && asset?.storageKey && asset.sha256 && ["generated", "approved"].includes(asset.status)
                    && JSON.stringify(node).includes(String(asset.storageKey)));
            if (!localPromotionCandidate) throw new Error(`共享素材 ${assetId} 尚未选择共享画布来源`);
        }
    }
}
function stripLegacySharedAssetPointers(director?: DirectorProduction) {
    if (!director) return;
    for (const asset of Object.values(director.assets) as Array<Record<string, any>>) delete asset.sharedSource;
}
const batchRequestHash = (input: DirectorRunStart) => fingerprint({ idempotencyKey: input.idempotencyKey, workId: input.workId, expectedRevision: input.expectedRevision, version: input.version, targets: input.targets, scope: input.scope, inputBasis: input.inputBasis, expectedCanvasRevision: input.expectedCanvasRevision, expectedPlanHash: input.expectedPlanHash });
const promptHashBytes = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function clipAudioRuntime(segmentBindings: any[], canvasInput: Record<string, any> | undefined) {
    const enabled = canvasInput?.audioDrive === true;
    const selectedReferenceBindingId = typeof canvasInput?.audioDriveFile === "string" && canvasInput.audioDriveFile ? canvasInput.audioDriveFile : null;
    const result = {
        driverEnabled: enabled,
        selectedReferenceBindingId,
        start: canvasInput?.audioDriveStart != null && canvasInput.audioDriveStart !== "" && Number.isFinite(Number(canvasInput.audioDriveStart)) ? Number(canvasInput.audioDriveStart) : null,
        end: canvasInput?.audioDriveEnd != null && canvasInput.audioDriveEnd !== "" && Number.isFinite(Number(canvasInput.audioDriveEnd)) ? Number(canvasInput.audioDriveEnd) : null,
        authoredBindingId: null as string | null,
        matchStatus: "disabled" as "disabled" | "unselected" | "matched" | "unmatched" | "ambiguous",
    };
    if (!enabled) return result;
    if (!selectedReferenceBindingId) return { ...result, matchStatus: "unselected" as const };

    const reference = clipRows(canvasInput?.referenceBindings).find(binding => String(binding?.id || "") === selectedReferenceBindingId);
    const nodeId = String(reference?.sourceNodeId || reference?.nodeId || "");
    const storageKey = String(reference?.storageKey || "");
    if (!reference || !nodeId || !storageKey) return { ...result, matchStatus: "unmatched" as const };
    const matches = segmentBindings.filter(binding =>
        String(binding?.sourceNode?.nodeId || "") === nodeId
        && String(binding?.storageKey || "") === storageKey
        && (!reference.sha256 || !binding?.sha256 || String(reference.sha256) === String(binding.sha256)));
    if (matches.length !== 1) return { ...result, matchStatus: matches.length > 1 ? "ambiguous" as const : "unmatched" as const };
    return { ...result, authoredBindingId: String(matches[0].id), matchStatus: "matched" as const };
}
const productionMediaDependencyBlockers = (target: DirectorReadinessTarget | undefined) => (target?.blockers || []).filter(message =>
    message.startsWith("依赖资产 ")
    || message.includes("关键帧尚未生成或绑定")
    || message.includes("缺少参考与关键帧映射")
    || message.startsWith("Shot ") && message.includes(": "));

function directorStageReadiness(director?: DirectorProduction): DirectorStageReadiness {
    if (!director) return {
        draftInitialized: false, scriptBlocks: 0, explicitShotCues: 0, structuredShots: 0, assetCards: 0, segments: 0,
        compileGate: "not_started", compileBlockers: [], authoringGaps: [], nextAction: "先从分集当前需求建立正式剧本首稿。",
    };
    const source = director.source as Record<string, unknown>;
    const rows = Array.isArray(source.script_scenes) ? source.script_scenes.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Record<string, any>[] : [];
    const scriptBlocks = rows.reduce((count, row) => count + (Array.isArray(row.blocks) ? row.blocks.length : 1), 0);
    const scriptText = rows.map(row => Array.isArray(row.blocks)
        ? row.blocks.map((block: unknown) => String(record(block).text || "")).join("")
        : String(row.text || "")).join("");
    const explicitShotCues = explicitShotCueCount(scriptText);
    const structuredShots = Array.isArray(source.shots) ? source.shots.length : 0;
    const assetCards = Array.isArray(source.asset_cards) ? source.asset_cards.length : 0;
    const segments = Array.isArray(source.segments) ? source.segments.length : 0;
    const compileBlockers = assetCards === 0 && segments === 0
        ? ["当前没有可编译的资产卡或视频段落；先完成资产提示词卡或 Clip。"]
        : [];
    const authoringGaps = explicitShotCues > structuredShots
        ? [`剧本中有 ${explicitShotCues} 个镜头标记，正式 Shot 只有 ${structuredShots} 个；标记尚未结构化为可生产镜头。`]
        : structuredShots === 0 && scriptBlocks > 0 ? ["正式剧本尚未拆分并登记为生产 Shot。"] : [];
    const compileGate = compileBlockers.length ? "blocked" as const : "preflight_required" as const;
    const nextAction = authoringGaps.length
        ? `${authoringGaps[0]} 下一步补齐镜头时长、主体和镜头信息；不要从标记推断这些字段。`
        : compileBlockers.length
            ? `${compileBlockers[0]} 已登记 ${structuredShots} 个正式 Shot；补资产卡/视频段落后运行编译预检。`
            : "结构已具备基础编译目标；运行正式编译预检确认可编译性。";
    return { draftInitialized: true, scriptBlocks, explicitShotCues, structuredShots, assetCards, segments, compileGate, compileBlockers, authoringGaps, nextAction };
}

export class ProductionConflictError extends Error {
    constructor(readonly current: ProductionRecord) { super("制作稿版本已变化，请核对当前版本后重试"); }
}

/** Archived episodes are read-only: user edits, publishing, generation and shared-asset adoption are refused. */
export class ProductionArchivedError extends Error {
    readonly code = "PRODUCTION_ARCHIVED";
    constructor(readonly episodeId: string) { super("该分集已归档，只能查看；如需继续制作请先取消归档"); }
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
    /** 归档媒体 sha256 缓存：按 storageKey + (size, mtimeMs) 失效，避免工作包/编译每次请求重复读盘哈希。 */
    private mediaDigestCache = new Map<string, { statKey: string; digest: string }>();
    constructor(private readonly db: BackendDatabase, private readonly events?: BackendEventBus, private readonly legacyDataDir = DATA_DIR, private readonly projectScope = false, private readonly checkEngine: (engine: DirectorProduction["engine"]) => unknown = assertDirectorEngine) {}

    /** SQLite is the durable store for compilation jobs and continuity receipts. */
    storageDatabase() { return this.db; }
    isArchivedMediaPath(filePath: string) {
        return Boolean(this.db.db.prepare("SELECT 1 FROM media_files WHERE file_path=?").get(filePath));
    }
    archivedMediaDigest(filePath: string) {
        const row = this.db.db.prepare("SELECT sha256 FROM media_files WHERE file_path=?").get(filePath) as { sha256?: string | null } | undefined;
        return row?.sha256 || null;
    }
    mediaStorageKeyForPath(filePath: string) {
        const row = this.db.db.prepare("SELECT storage_key FROM media_files WHERE file_path=?").get(filePath) as { storage_key: string } | undefined;
        return row?.storage_key;
    }
    mediaPathForStorageKey(storageKey: string) { return this.db.getMediaFile(storageKey)?.filePath; }

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
    resolveSubjectPictureInputs(id: string, input: DirectorProduction, targetIds?: string[], forCompilation = false, previewSubjectIds?: string[], compileInputDiagnostics?: ProductionDiagnostic[]): DirectorProduction {
        const linked = this.linked(id);
        if (linked) return linked.service.resolveSubjectPictureInputs(linked.id, input, targetIds, forCompilation, previewSubjectIds, compileInputDiagnostics);
        if (!isSubjectPromptAssembly(input.source)) return structuredClone(input);
        const director = structuredClone(input), productionCanvasId = this.episodeInfo(id).canvasId;
        stripLegacySharedAssetPointers(director);
        this.validateSubjectEntityOwnership(id, director);
        if (!productionCanvasId) throw new Error("SUBJECT_IMAGE_PRODUCTION_CANVAS_MISSING: 制作对象尚未绑定画布");
        const assetPlans = clipRows(director.source.asset_plan), subjects = clipRows(director.source.subject_registry);
        const shotsById = new Map(clipRows(director.source.shots).map(shot => [String(shot.id), shot]));
        let sourceModeChanged = false;
        if (forCompilation) {
            for (const segment of clipRows(director.source.segments)) {
                const segmentId = String(segment.id || "");
                if (!segmentId || targetIds && !targetIds.includes(segmentId)) continue;
                // A recorded mode lock is a deliberate source choice. Without one, derive
                // the mode from visible Subjects, selected scene-environment references,
                // and required-keyframe references; stale Ref2VA defaults on voiceover/object
                // shots otherwise create a DRAFT with no media bindings. Scene environment
                // Subjects often use state_context and still need Ref2VA to carry their image.
                if (segment.mode_lock) continue;
                const shotIds = clipRows(segment.shot_ids).map(String);
                const selectedShots = shotIds.map(shotId => shotsById.get(shotId)).filter(Boolean) as Array<Record<string, any>>;
                const frames = selectedShots.flatMap(shot => clipRows(shot.keyframes).filter(frame => frame.requiredForSubmission && frame.anchor !== "composition"));
                const compositionReferences = selectedShots.flatMap(shot => [
                    ...clipRows(shot.reference_requirements).filter(reference => reference.requiredForSubmission),
                    ...clipRows(shot.keyframes).filter(frame => frame.requiredForSubmission && frame.anchor === "composition"),
                ]);
                const hasVisibleSubject = selectedShots.some(shot => clipRows(shot.subject_usages).some(usage => usage.presentation === "visible"));
                const hasSceneEnvironmentReference = selectedShots.some(shot => clipRows(shot.subject_usages).some(usage => {
                    const subject = subjects.find(item => String(item.id || "") === String(usage.subjectId || ""));
                    return subject?.entityRef?.kind === "scene"
                        && Array.isArray(usage.referencePurpose) && usage.referencePurpose.map(String).includes("environment")
                        && resolveSubjectPictureBindingIds(subject, usage).bindingIds.length > 0;
                }));
                const openingFrames = frames.filter(frame => frame.anchor === "opening").length;
                const closingFrames = frames.filter(frame => frame.anchor === "closing").length;
                // Base modes have fixed image slots: I2VA=one opening, L2VA=one
                // closing, FL2VA=one of each. Additional or in-shot frames need
                // Ref2VA so every required storyboard frame keeps a real mapping.
                const baseMode = frames.length === 1 && openingFrames === 1 ? "I2VA"
                    : frames.length === 1 && closingFrames === 1 ? "L2VA"
                        : frames.length === 2 && openingFrames === 1 && closingFrames === 1 ? "FL2VA" : undefined;
                const sourceMode = compositionReferences.length || hasSceneEnvironmentReference ? "Ref2VA"
                    : baseMode || (hasVisibleSubject || frames.length ? "Ref2VA" : "T2VA");
                if (!sourceMode || segment.mode === sourceMode) continue;
                segment.mode = sourceMode;
                delete segment.mode_lock;
                delete segment.mode_selection_reason;
                sourceModeChanged = true;
            }
            if (sourceModeChanged) director.sourceHash = directorHash(director.source);
        }
        const bindings: Array<{ subjectId: string; binding: Record<string, any>; sourcePath?: string }> = subjects.flatMap(subject => clipRows(subject.pictureBindings).map(binding => ({ subjectId: String(subject.id), binding })));
        const subjectById = new Map(subjects.map(subject => [String(subject.id), subject]));
        const previewSubjects = new Set(previewSubjectIds || []);
        const selectedShotIds = targetIds !== undefined
            ? new Set(clipRows(director.source.segments).filter(segment => targetIds.includes(String(segment.id))).flatMap(segment => (segment.shot_ids || []).map(String)))
            : undefined;
        const subjectReferenceShotIds = forCompilation ? new Set(clipRows(director.source.segments).filter(segment => String(segment.mode) === "Ref2VA"
            && (!targetIds || targetIds.includes(String(segment.id)))).flatMap(segment => (segment.shot_ids || []).map(String))) : undefined;
        const shots = clipRows(director.source.shots).filter(shot => !selectedShotIds || selectedShotIds.has(String(shot.id))), usedBindings = new Set<string>();
        const segmentTargetsByShot = new Map<string, string[]>(), bindingTargets = new Map<string, Set<string>>();
        for (const segment of clipRows(director.source.segments).filter(item => !targetIds || targetIds.includes(String(item.id)))) for (const shotId of segment.shot_ids || []) {
            const key = String(shotId); segmentTargetsByShot.set(key, [...(segmentTargetsByShot.get(key) || []), String(segment.id)]);
        }
        const markBindingUsed = (bindingId: string, shotId: string) => {
            usedBindings.add(bindingId);
            const targets = bindingTargets.get(bindingId) || new Set<string>();
            for (const target of segmentTargetsByShot.get(shotId) || []) targets.add(target);
            bindingTargets.set(bindingId, targets);
        };
        const unresolvedBinding = (diagnostic: ProductionDiagnostic, bindingId: string, allowDraft: boolean) => {
            if (!compileInputDiagnostics || !allowDraft) throw new ProductionValidationError([diagnostic]);
            const targets = [...(bindingTargets.get(bindingId) || [])];
            for (const targetId of targets.length ? targets : [bindingId]) compileInputDiagnostics.push({ ...diagnostic, targetId, severity: "warning", blocksCompilation: false, blockingActions: ["generate"] });
        };
        const taskOrderCache = new Map<string, ReturnType<BackendDatabase["getTask"]>>();
        const projectCache = new Map<string, ReturnType<BackendDatabase["getCanvasProject"]>>();
        for (const shot of shots) {
            if (!subjectReferenceShotIds || subjectReferenceShotIds.has(String(shot.id))) for (const usage of clipRows(shot.subject_usages)) for (const bindingId of resolveSubjectPictureBindingIds(subjectById.get(String(usage.subjectId)), usage).bindingIds) markBindingUsed(String(bindingId), String(shot.id));
            for (const frame of clipRows(shot.keyframes)) if (frame.requiredForSubmission && frame.anchor !== "composition") markBindingUsed(String(frame.id), String(shot.id));
            for (const reference of clipRows(shot.reference_requirements)) if (reference.requiredForSubmission) markBindingUsed(String(reference.id || reference.asset_id), String(shot.id));
            for (const frame of clipRows(shot.keyframes)) if (frame.requiredForSubmission && frame.anchor === "composition") markBindingUsed(String(frame.id), String(shot.id));
        }
        for (const shot of shots) for (const frame of clipRows(shot.keyframes).filter(item => item.requiredForSubmission && item.anchor !== "composition")) bindings.push({
            subjectId: String(frame.subjectIds?.[0] || `keyframe:${shot.id}`),
            binding: { id: String(frame.id), assetId: String(frame.assetId || frame.id), sourceNode: frame.sourceNode, selection: frame.selection },
            sourcePath: `shots.${shot.id}.keyframes.${frame.id}`,
        });
        for (const shot of shots) {
            for (const reference of clipRows(shot.reference_requirements).filter(item => item.requiredForSubmission)) bindings.push({
                subjectId: `composition:${shot.id}`,
                binding: { id: String(reference.id || reference.asset_id), assetId: String(reference.asset_id), sourceNode: reference.sourceNode, selection: reference.selection },
                sourcePath: `shots.${shot.id}.reference_requirements.${String(reference.id || reference.asset_id)}`,
            });
            for (const frame of clipRows(shot.keyframes).filter(item => item.requiredForSubmission && item.anchor === "composition")) bindings.push({
                subjectId: `composition:${shot.id}`,
                binding: { id: String(frame.id), assetId: String(frame.assetId || frame.id), sourceNode: frame.sourceNode, selection: frame.selection },
                sourcePath: `shots.${shot.id}.keyframes.${frame.id}`,
            });
        }
        for (const { subjectId, binding, sourcePath } of bindings) {
            if (previewSubjects.size && !previewSubjects.has(subjectId)) continue;
            const bindingId = String(binding.id || ""), assetId = String(binding.assetId || bindingId);
            if (!forCompilation && previewSubjects.has(subjectId)) usedBindings.add(bindingId);
            if (!usedBindings.has(bindingId)) continue;
            const bindingPath = sourcePath || `subject_registry.${subjectId}.pictureBindings.${bindingId}`;
            const plan = assetPlans.find(asset => String(asset.asset_id || asset.id) === assetId);
            const ref = binding.sourceNode && typeof binding.sourceNode === "object" ? binding.sourceNode as Record<string, any> : {};
            const projectId = String(ref.projectId || ""), nodeId = String(ref.nodeId || "");
            const project = projectId ? projectCache.get(projectId) || this.db.getCanvasProject(projectId) : null;
            if (projectId && !projectCache.has(projectId)) projectCache.set(projectId, project);
            const node = (project?.nodes as Array<Record<string, any>> | undefined)?.find(item => item.id === nodeId);
            const old = director.assets[assetId], metadata = node?.metadata || {};
            const planSharedSource = plan?.sharedSource && typeof plan.sharedSource === "object" ? plan.sharedSource as Record<string, any> : undefined;
            const sharedSource = planSharedSource;
            const isSharedAsset = Boolean(sharedSource || String(plan?.canvas_scope || "episode") === "shared");
            const archivedQuickStoryboardReference = Boolean(old?.storageKey && projectId === productionCanvasId
                && node && isH3NodeType(String(node.type || ""))
                && [
                    ...clipRows(metadata.segments).flatMap(segment => clipRows(segment.referenceBindings)),
                    ...clipRows(project?.referenceCatalog),
                ].some(reference => reference.role === "storyboard"
                    && (reference.mediaType === "image" || reference.type === "image")
                    && String(reference.storageKey || "") === String(old.storageKey)));
            // Quick Storyboard frames are already archived H3 reference assets. They
            // have no image-node owner; verify the exact H3 Clip binding, then resolve
            // their bytes by storageKey instead of dereferencing a fabricated node.
            const directStoredMedia = !isSharedAsset && Boolean(old?.storageKey)
                && (!projectId && !nodeId || archivedQuickStoryboardReference);
            const sharedBindingError = (stage: NonNullable<ProductionDiagnostic["details"]>["stage"], reason: string, message: string): never => {
                throw new ProductionValidationError([{
                    code: "SHARED_ASSET_BINDING_INVALID", path: `${bindingPath}.sourceNode`, targetId: bindingId, message, severity: "error",
                    details: { stage, reason, sourceProjectId: projectId || undefined, sourceNodeId: nodeId || undefined,
                        productionProjectId: productionCanvasId, productionNodeId: old?.nodeId,
                        expectedSourceProjectId: sharedSource?.sourceProjectId, expectedSourceNodeId: sharedSource?.sourceNodeId },
                }]);
            };
            if (directStoredMedia) {
                const storageKey = String(old!.storageKey);
                const media = this.db.getMediaFile(storageKey);
                if (!media || !fs.existsSync(media.filePath)) throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_NOT_ARCHIVED", path: `${bindingPath}.selection`, targetId: bindingId, message: "所选图片尚未归档，不能作为模型参考", severity: "error" }]);
                if (media.mimeType && !String(media.mimeType).toLowerCase().startsWith("image/")) throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_TYPE_INVALID", path: `${bindingPath}.selection`, targetId: bindingId, message: "所选归档素材不是受支持的图片类型", severity: "error" }]);
                const digest = promptHashBytes(media.filePath);
                director.assets[assetId] = { ...old, storageKey, sha256: digest, status: old.status === "approved" ? "approved" : "generated",
                    selectedResult: { imageId: bindingId, taskId: old.generationTaskId, storageKey, sha256: digest, projectId: "", nodeId: "" } };
                continue;
            }
            const smartImageNode = node?.type === "config" && metadata.smart === true && (metadata.generationMode || "image") === "image";
            // Generated media can remain in a typed asset/reference node after its canvas node
            // changes. Resolve a matching formal projection directly; otherwise use the canvas
            // image-reference resolver below. Archive, ownership, available task provenance,
            // and byte/hash checks remain authoritative.
            const projectedAssetNode = Boolean(node && ["image", "character", "scene"].includes(String(node.type))
                && metadata.productionAssetId === assetId && old?.nodeId === nodeId
                && old?.storageKey && old?.sha256 && old?.generationTaskId
                && binding.selection?.mode === "node_selection");
            if (!project || !node) {
                if (isSharedAsset) sharedBindingError("source_resolution", "binding_source_missing", "共享素材图片来源画布或节点不存在");
                throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_SOURCE_MISSING", path: `${bindingPath}.sourceNode`, targetId: bindingId, message: "图片参考来源画布或节点不存在", severity: "error" }]);
            }
            if (isSharedAsset) {
                if (!sharedSource) sharedBindingError("source_resolution", "shared_source_missing", "共享素材计划缺少正式来源身份");
                const expectedSharedSource = sharedSource!;
                try {
                    validateSharedAssetSourceIdentity(this.db, productionCanvasId, expectedSharedSource as any);
                } catch (error) {
                    sharedBindingError("projection_validation", "production_projection_invalid", error instanceof Error ? error.message : String(error));
                }
                if (projectId === productionCanvasId) {
                    if (!sharedAssetNodeMatchesSource(node, expectedSharedSource as any)) {
                        sharedBindingError("projection_validation", "binding_projection_identity_mismatch", "图片绑定指向的本地节点没有声明当前共享来源身份");
                    }
                } else if (projectId !== expectedSharedSource.sourceProjectId || nodeId !== expectedSharedSource.sourceNodeId) {
                    sharedBindingError("source_resolution", "canonical_source_mismatch", "共享图片绑定必须指向正式共享来源节点或其有效分集投影");
                }
            } else if (projectId !== productionCanvasId) {
                throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_NODE_OWNER", path: `${bindingPath}.sourceNode.projectId`, targetId: bindingId, message: "跨画布图片必须通过本集的共享素材选择入口绑定", severity: "error" }]);
            }
            const recordedSingleResult = smartImageNode && metadata.status === "success" && metadata.storageKey && metadata.generationTaskId
                ? [{ id: String(metadata.generationTaskId), storageKey: String(metadata.storageKey), generationTaskId: String(metadata.generationTaskId), status: "success" }]
                : [];
            // Production-managed image runs record a single successful result on
            // the smart node's top-level storageKey/generationTaskId fields. Older
            // canvas selectors consume metadata.images instead, so adapt that
            // proven singleton in memory while keeping the original node/history
            // untouched. Task ownership and archived bytes are verified below.
            const images: Array<Record<string, any>> = smartImageNode
                ? Array.isArray(metadata.images) ? metadata.images as Array<Record<string, any>> : recordedSingleResult
                : [];
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
            let slot: Record<string, any>;
            if (projectedAssetNode) {
                slot = { id: `asset:${assetId}`, storageKey: old!.storageKey, generationTaskId: old!.generationTaskId };
            } else if (smartImageNode) {
                const resolved = selectSmartImageResult({ ...metadata, images: orderedImages }, binding.selection as any);
                if (resolved.error || !resolved.image) throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_RESULT_MISSING", path: `${bindingPath}.selection`, targetId: bindingId, message: resolved.error || "智能节点没有有效结果", severity: "error" }]);
                slot = resolved.image as Record<string, any>;
            } else {
                const selectedResultId = String(binding.selection?.mode === "selected_result" ? binding.selection.resultId || "" : "");
                const characterImages = node.type === "character" && Array.isArray(metadata.characterImages)
                    ? metadata.characterImages.filter((image: unknown) => image && typeof image === "object" && !Array.isArray(image)) as Array<Record<string, any>> : [];
                const characterImageKey = (image: Record<string, any>, index: number) => String(image.storageKey || image.url || image.name || `image-${index}`);
                const sceneImage = node.type === "scene" && metadata.sceneImage && typeof metadata.sceneImage === "object"
                    ? metadata.sceneImage as Record<string, any> : undefined;
                const references: Array<Record<string, any>> = selectedResultId && node.type === "character"
                    ? resolveCanvasCharacterImageReferences(node)
                    : sceneImage ? [{ ...sceneImage, id: String(sceneImage.id || sceneImage.storageKey || nodeId) }]
                        : resolveCanvasImageReferenceNode(node);
                const selectedCharacterImage = selectedResultId && node.type === "character"
                    ? characterImages.find((image, index) => [String(image.id || ""), characterImageKey(image, index), String(image.storageKey || ""), `${nodeId}:character-image:${characterImageKey(image, index)}`].includes(selectedResultId))
                    : undefined;
                const reference = selectedResultId
                    ? references.find(item => item.id === selectedResultId || item.storageKey === selectedResultId || selectedCharacterImage && item.storageKey === selectedCharacterImage.storageKey)
                    : references[0];
                if (!reference?.storageKey) {
                    if (selectedResultId && references.some(item => item.storageKey)) throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_RESULT_MISSING", path: `${bindingPath}.selection`, targetId: bindingId, message: `所选图片结果 ${selectedResultId} 不属于当前来源节点`, severity: "error" }]);
                    unresolvedBinding({ code: "SUBJECT_IMAGE_RESULT_MISSING", path: `${bindingPath}.selection`, targetId: bindingId, message: "来源节点没有可读取的归档图片", severity: "error" }, bindingId, !old?.storageKey);
                    continue;
                }
                slot = { id: reference.id, storageKey: reference.storageKey, mimeType: reference.mimeType,
                    ...(selectedCharacterImage?.sha256 ? { sha256: selectedCharacterImage.sha256 } : {}),
                    generationTaskId: selectedCharacterImage?.generationTaskId || metadata.generationTaskId || "" };
            }
            const storageKey = String(slot.storageKey || ""), generationTaskId = String(slot.generationTaskId || "");
            const media = storageKey && this.db.getMediaFile(storageKey);
            if (!media || !fs.existsSync(media.filePath)) throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_NOT_ARCHIVED", path: `${bindingPath}.selection`, targetId: bindingId, message: "所选图片尚未归档，不能作为模型参考", severity: "error" }]);
            const stat = fs.statSync(media.filePath), digestCacheKey = `${stat.size}:${stat.mtimeMs}`, cachedDigest = this.mediaDigestCache.get(storageKey);
            if (media.mimeType && !String(media.mimeType).toLowerCase().startsWith("image/")) throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_TYPE_INVALID", path: `${bindingPath}.selection`, targetId: bindingId, message: "所选归档素材不是受支持的图片类型", severity: "error" }]);
            const digest = cachedDigest && cachedDigest.statKey === digestCacheKey ? cachedDigest.digest
                : crypto.createHash("sha256").update(fs.readFileSync(media.filePath)).digest("hex");
            if (!cachedDigest || cachedDigest.statKey !== digestCacheKey) {
                if (this.mediaDigestCache.size >= 512) this.mediaDigestCache.delete(this.mediaDigestCache.keys().next().value!);
                this.mediaDigestCache.set(storageKey, { statKey: digestCacheKey, digest });
            }
            const expectedDigest = String(slot.sha256 || (projectedAssetNode ? old?.sha256 : "") || "");
            if (expectedDigest && expectedDigest !== digest) throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_HASH_MISMATCH", path: `${bindingPath}.selection`, targetId: bindingId, message: "图片来源记录的哈希与归档字节不一致", severity: "error" }]);
            if (generationTaskId) {
                const task = this.db.getTask(generationTaskId);
                const outputs = [...(task?.outputs || []), ...(Array.isArray(task?.result?.media) ? task.result.media as Array<Record<string, any>> : [])];
                if (!task || task.status !== "succeeded" || task.projectId !== projectId || task.nodeId !== nodeId || !outputs.some(output => output.storageKey === storageKey)) throw new ProductionValidationError([{ code: "SUBJECT_IMAGE_PROVENANCE_INVALID", path: `${bindingPath}.selection`, targetId: bindingId, message: "节点图片缺少对应的成功任务和归档结果记录", severity: "error" }]);
            }
            // Keep the compiler manifest node on the production canvas; the picture binding remains
            // the source of truth for the shared node and the exact image selected in the UI.
            const boundNodeId = projectId === productionCanvasId ? nodeId : (old?.nodeId || nodeId);
            const { sharedSource: _legacySharedSource, ...priorAsset } = (old || {}) as Record<string, any>;
            director.assets[assetId] = { ...priorAsset, version: String(priorAsset.version || plan?.version || `node:${nodeId}`), nodeId: boundNodeId, storageKey,
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
            for (const frame of clipRows(shot.keyframes).filter(item => item.requiredForSubmission && item.anchor !== "composition")) insert.run(this.ownerKind, episodeId, String(segment.id), String(frame.sourceNode?.projectId || ""), String(frame.sourceNode?.nodeId || ""), String(frame.id), String(frame.assetId || frame.id), String((frame.subjectIds || [])[0] || ""), "keyframe");
            for (const reference of clipRows(shot.reference_requirements).filter(item => item.requiredForSubmission)) insert.run(this.ownerKind, episodeId, String(segment.id), String(reference.sourceNode?.projectId || ""), String(reference.sourceNode?.nodeId || ""), String(reference.id || reference.asset_id), String(reference.asset_id), "", "composition");
            for (const frame of clipRows(shot.keyframes).filter(item => item.requiredForSubmission && item.anchor === "composition")) insert.run(this.ownerKind, episodeId, String(segment.id), String(frame.sourceNode?.projectId || ""), String(frame.sourceNode?.nodeId || ""), String(frame.id), String(frame.assetId || frame.id), "", "composition");
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
            const canvasInputs = this.canvasEditorialState(id, [segmentId]);
            const segmentAudioBindings = clipRows(segment.audio_bindings);
            const canvasEntry = canvasInputs.find(input => input.targetId === segmentId);
            const canvasInput = canvasEntry ? { ...canvasEntry.current, ...canvasEntry.runtime } as Record<string, any> : undefined;
            const workbench = { owner: this.ownerIdentity(id), sourceVersion: "subject-prompt-v2", segmentId, sourceHash: d.sourceHash,
                inputHash: compilationScopeInput(resolved, clipRefreshScope(segmentId)).inputHash,
                segment,
                shots,
                context: {
                    timelineWindows: Object.fromEntries(shots.map(shot => [String(shot.id), windows.get(String(shot.id))])),
                    stateByShot: states,
                    resolvedSubjects: subjects.map(subject => ({ id: subject.id, kind: subject.kind, entityRef: subject.entityRef,
                        pictureBindings: clipRows(subject.pictureBindings).map(binding => ({ id: binding.id, assetId: binding.assetId, resolved: resolved.assets[String(binding.assetId)] || null })) })),
                    utterances: clipRows(d.source.utterances).filter(u => shots.some(shot => (shot.utterance_refs || []).some((ref: any) => ref.utteranceId === u.id))),
                    continuity: { status: ledger?.contract_version === 2 ? "available" : "unavailable", facts: clipRows(ledger?.facts).filter(fact => relatedFacts.has(String(fact.id))),
                    events: clipRows(ledger?.events).filter(event => shotIds.has(String(event.shot_id))), requirements: clipRows(ledger?.requirements).filter(req => shotIds.has(String(req.shot_id))),
                    coverage: clipRows(ledger?.coverage).filter(item => (item.shot_ids || []).some((shotId: string) => shotIds.has(shotId))) },
                },
                runtime: { audioBindings: segmentAudioBindings, audio: clipAudioRuntime(segmentAudioBindings, canvasInput), canvasAssociation: this.resolveDirectorSegmentRuntime(id, segmentId), targetStatus: this.targetOccupancy(id, [segmentId]),
                    directorArtifacts: d.artifacts.filter(a => a.targetId === segmentId).map(a => ({ id: a.id, status: a.status, current: currentCompilationArtifact(resolved, a), sha256: a.sha256, promptBytes: Buffer.byteLength(a.prompt), references: a.references })),
                    canvasInputs, boundaries: d.boundaries.filter(b => b.from === segmentId || b.to === segmentId), resolutionDiagnostics, workbenchBuildMs: performance.now() - started } };
            return { ...production, clipWorkbench: workbench, workbenchVersion: directorHash(workbench) };
        }
        const { segment, shots } = clipShots(d, segmentId), projection = compilationScopeInput(d, clipRefreshScope(segmentId));
        const shotIds = new Set(shots.map(s => s.id)), assetIds = new Set(Object.keys(projection.director.assets));
        const subjects = new Set(shots.flatMap(s => [...(s.characters || []).map((c: any) => typeof c === "string" ? c : c.id || c.character_id), ...(s.camera?.attention_subject_ids || [])]));
        const ledger = d.source.ledger as any;
        const related = (r: any) => shotIds.has(r.shot_id) || (r.shot_ids || []).some((s: string) => shotIds.has(s));
        const continuity = this.continuityForDirector(id, d, snapshot);
        const report: any = continuity.report;
        const segmentAudioBindings = clipRows(segment.audio_bindings);
        const canvasInputs = this.canvasEditorialState(id, [segmentId]);
        const canvasEntry = canvasInputs.find(input => input.targetId === segmentId);
        const canvasInput = canvasEntry ? { ...canvasEntry.current, ...canvasEntry.runtime } as Record<string, any> : undefined;
        const workbench = { owner: this.ownerIdentity(id), segmentId, sourceHash: d.sourceHash, inputHash: projection.inputHash, engine: d.engine,
            segment: { ...segment, audio_bindings: segmentAudioBindings }, audioRuntime: clipAudioRuntime(segmentAudioBindings, canvasInput), shots, shotInputs: Object.fromEntries(shots.map(s => [s.id, d.shotInputs[s.id]])),
            characterRegistry: clipRows(d.source.character_registry).filter(c => subjects.has(c.id)),
            sceneRegistry: clipRows(d.source.scene_registry).filter(c => shots.some(s => s.scene_id === c.id)),
            assetPlan: clipRows(projection.director.source.asset_plan), assetCards: clipRows(projection.director.source.asset_cards), assets: Object.fromEntries(Object.entries(d.assets).filter(([key]) => assetIds.has(key))),
            directorReferences: { authored: segment.references || [], compiled: d.artifacts.filter(a => a.targetId === segmentId).map(a => ({ id: a.id, status: a.status, current: currentCompilationArtifact(d, a), sha256: a.sha256, references: a.references })) },
            canvasInputs, targetStatus: this.targetOccupancy(id, [segmentId]),
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
        if (snapshot === "draft") try { director = this.resolveSubjectPictureInputs(id, authored, consumerSegments, false, [subjectId]); } catch (error) { resolutionDiagnostics = (error as any)?.diagnostics || [{ code: "SUBJECT_IMAGE_RESOLUTION", message: error instanceof Error ? error.message : String(error) }]; }
        const subject = clipRows(director.source.subject_registry).find(item => item.id === subjectId);
        if (!subject) throw new Error(`Subject ${subjectId} 不存在`);
        const ledger = director.source.ledger as Record<string, any> | undefined;
        const facts = clipRows(ledger?.facts).filter(fact => fact.object_kind === subject.entityRef?.kind && fact.object_id === subject.entityRef?.id);
        const factIds = new Set(facts.map(fact => String(fact.id))), state = subjectStateProjection(director.source);
        const usages = clipRows(director.source.shots).flatMap(shot => clipRows(shot.subject_usages).filter(usage => usage.subjectId === subjectId).map(usage => ({
            shotId: String(shot.id), clipIds: clipRows(director.source.segments).filter(clip => (clip.shot_ids || []).includes(shot.id)).map(clip => String(clip.id)),
            usage, state: state[String(shot.id)],
        })));
        const entityReference = record(subject.entityRef);
        const entityProjectId = entityReference.ownerKind === "canvas" ? String(entityReference.ownerId) : this.db.getDramaEpisode(String(entityReference.ownerId))?.canvasId;
        const entityKind = entityReference.kind === "character" || entityReference.kind === "scene" ? entityReference.kind : subject.kind === "prop" ? "prop" : undefined;
        const entityNode = snapshot === "draft" && entityProjectId && entityKind
            ? (this.db.getCanvasProject(entityProjectId)?.nodes as Array<Record<string, any>> || []).find(node => node.metadata?.productionEntity?.ownerId === entityReference.ownerId && node.metadata.productionEntity.ownerKind === entityReference.ownerKind && node.metadata.productionEntity.kind === entityKind && node.metadata.productionEntity.entityId === entityReference.id)
            : undefined;
        const workbench = { subject, ...(entityNode ? { entityNodeSource: { projectId: entityProjectId, nodeId: entityNode.id, kind: entityKind, entityId: entityReference.id } } : {}), pictureBindings: clipRows(subject.pictureBindings).map(binding => ({ ...binding, resolved: director.assets[String(binding.assetId)] || null })),
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
        const segment = clipRows(director.source.segments).find(clip => String(clip.id) === segmentId);
        const segmentAudioBindings = clipRows(segment?.audio_bindings);
        const canvasEntry = segmentId ? this.canvasEditorialState(id, [segmentId]).find(input => input.targetId === segmentId) : undefined;
        const canvasInput = canvasEntry ? { ...canvasEntry.current, ...canvasEntry.runtime } as Record<string, any> : undefined;
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
        const workbench = { shot, segment: segment || null,
            context: { timelineWindow: subjectShotWindows(director.source).get(shotId), continuity: states[shotId],
            resolvedSubjectUsages: usages.map(usage => ({ subjectId: String((usage as any).subjectId), pictureBindings: usage.pictureBindings })),
            subjectRegistry: clipRows(director.source.subject_registry).filter(subject => subjectIds.has(String(subject.id))),
            keyframeMedia: clipRows(shot.keyframes).filter(frame => frame.anchor !== "composition").map(frame => {
                let resolved: DirectorProduction["assets"][string] | null = director.assets[String(frame.assetId || frame.id)] || null;
                if (snapshot === "draft" && !frame.requiredForSubmission) {
                    try {
                        const preview = structuredClone(authored);
                        preview.source.shots = [{ ...shot, subject_usages: [], keyframes: [{ ...frame, requiredForSubmission: true }] }];
                        preview.source.segments = clipRows(authored.source.segments).filter(segment => segment.id === clipId).map(segment => ({ ...segment, shot_ids: [shotId] }));
                        resolved = this.resolveSubjectPictureInputs(id, preview, clipId ? [clipId] : [], true).assets[String(frame.assetId || frame.id)] || null;
                    } catch { resolved = null; }
                }
                return { id: frame.id, assetId: frame.assetId || frame.id, resolved };
            }),
            resolvedReferences: [
                ...clipRows(shot.reference_requirements),
                ...clipRows(shot.keyframes).filter(frame => frame.anchor === "composition").map(frame => ({
                    id: String(frame.id), asset_id: String(frame.assetId || frame.id), purpose: "构图参考", sourceNode: frame.sourceNode,
                    selection: frame.selection, retain: frame.retain || [], exclude: frame.exclude || [], requiredForSubmission: frame.requiredForSubmission !== false,
                })),
            ].map(reference => ({ ...reference, resolved: director.assets[String(reference.asset_id || reference.id)] || null })),
            utterances: clipRows(director.source.utterances).filter(u => (shot.utterance_refs || []).some((ref: any) => ref.utteranceId === u.id)) },
            runtime: { audio: clipAudioRuntime(segmentAudioBindings, canvasInput), clipId,
            directorArtifacts: director.artifacts.filter(artifact => artifact.kind === "h3" && artifact.targetId === clipId).map(artifact => ({
                id: artifact.id, status: artifact.status, sha256: artifact.sha256,
                current: Boolean(compilationInput && currentCompilationArtifact(compilationInput, artifact)),
            })),
            canvasAssociation: clipId ? this.resolveDirectorSegmentRuntime(id, clipId) : { targetId: "", status: "missing", matches: [] },
            targetStatus: clipId ? this.targetOccupancy(id, [clipId]) : [], resolutionDiagnostics } };
        return { ...production, shotWorkbench: workbench, workbenchVersion: directorHash({ revision: production.revision, sourceHash: director.sourceHash, workbench }) };
    }
    private continuityReports() { return new ProductionContinuityReports(this.db); }

    getContinuity(id: string, raw: unknown = {}): Record<string, any> {
        const linked = this.linked(id); if (linked) return linked.service.getContinuity(linked.id, raw);
        const query = productionContinuityReadSchema.parse(raw);
        const current = this.get(id);
        const selected = query.snapshot === "published" ? current.published : current.draft;
        const director = selected?.director;
        if (!director) return { owner: { kind: this.ownerKind, id }, snapshot: query.snapshot, revision: current.revision, publishedVersion: current.publishedVersion,
            status: "missing", coverageStatus: "unchecked", semanticDiscovery: "not_performed", checkedAt: null, diagnostics: { total: 1, blocked: 1, unresolved: 1 }, items: [], total: 0, nextCursor: null };
        // Continuity report reads are observational; an older source format must
        // remain inspectable even though compile/check/write paths reject it.
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
        return { owner: { kind: this.ownerKind, id }, snapshot: query.snapshot, revision: current.revision, publishedVersion: current.publishedVersion,
            sourceHash: director.sourceHash, runtime: projected.report?.engine || { ...director.engine, runtimeId: projected.report?.runtimeId || director.engine.runtimeId }, status: effectiveStatus,
            coverageStatus: projected.report?.coverageStatus || "unchecked", semanticDiscovery: "not_performed", checkedAt: projected.report?.checkedAt || null,
            diagnostics: { total: projected.report?.diagnostics?.length || 0, blocked: (projected.report?.diagnostics || []).filter((item: any) => item.severity !== "warning").length,
                unresolved: (projected.report?.diagnostics || []).filter((item: any) => /UNKNOWN|UNRESOLVED|MISSING/.test(String(item.code))).length },
            items, total: projected.total, nextCursor: projected.nextCursor, ...(projected.report ? { report: projected.report } : {}) };
    }

    continuityForDirector(id: string, director: NonNullable<EpisodeProductionData["director"]>, snapshot: "draft" | "published" = "draft") {
        const current = this.get(id);
        const formal = snapshot === "published" ? current.published?.director : current.draft.director;
        if (!formal || formal.sourceHash !== director.sourceHash) {
            return { status: "stale", sourceHash: director.sourceHash, runtime: director.engine, report: null };
        }
        return this.getContinuity(id, { snapshot, view: "summary" });
    }

    /** 编译前没有有效回执时自动跑一次正式检查；回执精确绑定本次编译 director 的 sourceHash/engine，
     *  与 production_check_continuity 共用同一份报告存储，返回可直接交给 continuityTargetBlockers 的结果。 */
    async autoRecordContinuityForDirector(id: string, director: NonNullable<EpisodeProductionData["director"]>, snapshot: "draft" | "published" = "draft"): Promise<Record<string, any>> {
        const current = this.get(id);
        const owner = { kind: this.ownerKind, id };
        const engineReport = await auditAchengContinuity(director, undefined, false);
        const operationId = `compile-auto:${crypto.randomUUID()}`;
        const segments = [...new Set(((director.source.segments || []) as any[]).map(item => String(item.id || "")))];
        const report = { ...engineReport, verdict: engineReport.status, owner, snapshot, snapshotVersion: current.publishedVersion, sourceHash: director.sourceHash,
            runtimeId: engineReport.validatorRuntimeId, engine: engineReport.validatorEngine, revision: current.revision, checkedAt: new Date().toISOString(), operationId,
            selectedTargets: segments.length ? segments : [] };
        const requestHash = fingerprint({ owner, snapshot, sourceHash: director.sourceHash, runtimeId: report.runtimeId, autoCheck: true });
        this.continuityReports().persist(owner, operationId, requestHash, report);
        this.events?.publish({ type: "drama-production.updated", entityId: id, payload: { revision: current.revision, continuitySourceHash: director.sourceHash, continuitySnapshot: snapshot } });
        return { status: report.verdict, sourceHash: director.sourceHash, runtime: { runtimeId: report.runtimeId }, report: { ...report, stale: false } };
    }

    async checkContinuity(id: string, raw: unknown): Promise<Record<string, any>> {
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
        // 乐观锁放行（last-write-wins）：客户端过期 revision 不再拦截，版本号继续自增。
        const selected = input.snapshot === "published" ? current.published : current.draft;
        const director = selected?.director;
        if (!director) throw new Error("CONTINUITY_SOURCE_MISSING: 缺少正式 Acheng 制作稿");
        this.assertCurrentDirectorFormat(director);
        const segments = new Set(((director.source.segments || []) as any[]).map(item => String(item.id || "")));
        if ((input.targetIds || []).some(target => !segments.has(target))) throw new Error("连续性检查目标必须属于当前制作稿 Segment");
        const engineReport = await auditAchengContinuity(director, input.targetIds, false);
        const report = { ...engineReport, verdict: engineReport.status, owner, snapshot: input.snapshot, snapshotVersion: current.publishedVersion, sourceHash: director.sourceHash,
            runtimeId: engineReport.validatorRuntimeId, engine: engineReport.validatorEngine, revision: current.revision, checkedAt: new Date().toISOString(), operationId: input.operationId,
            selectedTargets: input.targetIds || (segments.size ? [...segments] : []) };
        const persisted = reports.persist(owner, input.operationId, requestHash, report);
        this.events?.publish({ type: "drama-production.updated", entityId: id, payload: { revision: current.revision, continuitySourceHash: director.sourceHash, continuitySnapshot: input.snapshot } });
        return { ...persisted, revision: current.revision };
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
        }, { allowArchived: true });
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
        }, { allowArchived: true });
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
            return { ...(row.bindings_json ? { bindings: JSON.parse(row.bindings_json) } : {}), ...(row.receipt_json ? { receipt: decodeReceipt(row.receipt_json) } : {}) };
        }
        validateFresh?.();
        this.db.db.prepare("INSERT INTO production_preparations (operation_id, owner_key, request_hash) VALUES (?, ?, ?)").run(operationId, ownerKey, hash);
        return {};
    }
    async commitPreparation(id: string, operationId: string, expectedRevision: number, bindings: Record<string, unknown>[], layoutReceipt?: ProductionLayoutReceipt, layoutPlan?: ProductionLayoutPlan, canvasPreparation?: { projectId: string; expectedCanvasRevision: number; operationId: string; operations: CanvasOperation[] }, referenceSync?: ReferenceSync[]): Promise<ProductionRecord & { replayed?: boolean; layoutReceipt?: ProductionLayoutReceipt }> {
        this.db.db.prepare("UPDATE production_preparations SET bindings_json=? WHERE operation_id=?").run(JSON.stringify(bindings), operationId);
        const frozen = layoutReceipt || this.db.getProductionPreparationLayout(operationId)?.receipt as ProductionLayoutReceipt | undefined;
        const frozenPlan = layoutPlan || this.db.getProductionPreparationLayout(operationId)?.plan;
        const canvasId = this.episodeInfo(id).canvasId;
        let completedResponse: ProductionRecord & { replayed?: boolean; layoutReceipt?: ProductionLayoutReceipt } | undefined;
        const finishReceipt = (record: ProductionRecord & { replayed?: boolean }) => {
            const completed = frozen && canvasId ? { ...frozen, canvasRevision: this.db.getCanvasProjectRevision(canvasId) || frozen.canvasRevision } : frozen;
            const response = { ...record, ...(completed ? { layoutReceipt: completed } : {}), ...(referenceSync ? { referenceSync } : {}) };
            this.db.db.prepare("UPDATE production_preparations SET receipt_json=? WHERE operation_id=?").run(encodeReceipt(response), operationId);
            completedResponse = response;
            return response;
        };
        const result = bindings.length ? await this.edit(id, { operationId, expectedRevision, ops: bindings }, canvasPreparation, false, finishReceipt) : this.get(id);
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
                const scriptOps = [...(projectionLayout ? entityNodeOperations(projectedProject, result.draft, { kind: this.ownerKind, id }, result.draft, projectionLayout) : []), ...scriptNodeOperations(projectedProject, result.draft, { kind: this.ownerKind, id }, result.draft), ...(projectionLayout ? imageInputOperations(projectedProject, result.draft, id, result.draft, projectionLayout) : [])];
                if (scriptOps.length) this.db.applyCanvasProjectOperations(canvasPreparation.projectId, Number(projectedProject.revision || 0), scriptOps,
                    { operationId: `${operationId}:scripts`, runtimeWrite: true, withinTransaction: true, deferredCommits: canvasCommits, source: { kind: "system", clientId: "production:scripts", label: "准备剧本文本节点" } });
                const updatedProject = this.db.getCanvasProject(canvasPreparation.projectId)!;
                if (result.draft.director) this.db.saveProductionLayoutPlan(canvasPreparation.projectId, compileProductionLayout({ h3Defaults: record(this.db.getSetting("plugin:minimax-h3:defaults:v1")), canvasId: canvasPreparation.projectId, owner: { kind: this.ownerKind, id }, production: result.draft, project: updatedProject, previous: frozenPlan || null }));
                finishReceipt(result);
                this.db.db.exec("COMMIT");
                canvasCommits.forEach(commit => this.db.notifyCanvasCommit(commit));
            } catch (error) { this.db.db.exec("ROLLBACK"); throw error; }
        } else if (!bindings.length) {
            // 乐观锁放行：write 已在 last-write-wins 下进行，不再用 revision 复核结果。
            const canvas = canvasId && this.db.getCanvasProject(canvasId);
            if (canvas) {
                const operations = [...(projectionLayout ? entityNodeOperations(canvas, result.draft, { kind: this.ownerKind, id }, result.draft, projectionLayout) : []), ...scriptNodeOperations(canvas, result.draft, { kind: this.ownerKind, id }, result.draft), ...(projectionLayout ? imageInputOperations(canvas, result.draft, id, result.draft, projectionLayout) : [])];
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
        // 乐观锁放行（last-write-wins）：客户端过期 revision 不再拦截，版本号继续自增。
        const published = current.published;
        const director = published?.director;
        if (!director || current.publishedVersion < 1) throw new Error("接入共享画布前须先发布包含该资产的分集制作稿");
        const plan = (Array.isArray(director.source.asset_plan) ? director.source.asset_plan : []).map(record).find(item => String(item.asset_id || item.id || "") === assetId);
        if (!plan) throw new Error(`资产 ${assetId} 未登记到正式源稿`);
        if (String(plan.canvas_scope || "episode") !== "shared") throw new Error(`资产 ${assetId} 尚未标记为剧目共享`);
        if (Object.values(director.shotInputs).some(input => input.keyframeAssetId === assetId)) throw new Error("镜头关键帧属于本集，不能接入剧目共享资产");
        const asset = director.assets[assetId];
        if (!asset || !["approved", "generated"].includes(asset.status) || !asset.storageKey || !asset.sha256) throw new Error("只有已归档并绑定的媒体可以接入共享素材");
        const sourceProject = this.db.getCanvasProject(episode.canvasId);
        const sourceNode = (sourceProject?.nodes as Record<string, any>[] | undefined)?.find(node => node.id === asset.nodeId);
        const meta = record(sourceNode?.metadata);
        const storageKey = String(asset.storageKey || resolveCanvasImageReferenceNode(sourceNode || {})[0]?.storageKey || meta.storageKey || meta.resultStorageKey || sourceNode?.content || "");
        if (!sourceNode || !storageKey || !JSON.stringify(sourceNode).includes(storageKey)) throw new Error("原分集节点未绑定待接入媒体");
        if (!["image", "character", "scene"].includes(String(sourceNode.type)) && !(sourceNode.type === "config" && meta.generationMode === "image")) throw new Error("只有正式图片、角色或场景资产可以接入共享画布");
        const media = this.db.getMediaFile(storageKey);
        if (!media || !fs.existsSync(media.filePath)) throw new Error("原归档媒体不存在或不可访问");
        const sha256 = promptHashBytes(media.filePath);
        if (sha256 !== asset.sha256) throw new Error("原归档媒体摘要与所选版本不一致");
        const drama = this.db.listCanvasFolders().find(item => item.id === episode.dramaId && item.isDrama);
        if (!drama) throw new Error("剧目不存在");
        const approved = listApprovedSharedAssets(this.db, episode.dramaId).find(item => item.assetId === assetId);
        if (approved && (approved.storageKey !== storageKey || approved.sha256 !== sha256)) throw new Error("共享画布已存在其他媒体版本；先读取当前版本，再接入新来源");
        const sharedCanvasId = drama.sharedAssetCanvasId || null;
        const sharedProject = sharedCanvasId ? this.db.getCanvasProject(sharedCanvasId) : null;
        if (sharedCanvasId && !sharedProject) throw new Error("固定共享资产画布不存在，请恢复原画布");
        const targetNodeId = `shared-import-${crypto.createHash("sha256").update([episode.dramaId, assetId, storageKey, sha256].join("\0")).digest("hex").slice(0, 24)}`;
        return {
            episodeId: id, episodeRevision: current.revision, publishedVersion: current.publishedVersion, sourceHash: director.sourceHash,
            sourceCanvasId: episode.canvasId, sourceCanvasRevision: Number(sourceProject?.revision || 0), sourceNodeId: String(sourceNode!.id), assetId,
            assetName: String(plan.asset_name || plan.name || plan.title || sourceNode!.title || assetId), storageKey, sha256,
            evidence: asset.evidence || "", reviewStatus: asset.status === "approved" && Boolean(asset.evidence?.trim()) ? "approved" as const : "unreviewed" as const, sourceGenerationTaskId: String(record(asset.selectedResult).taskId || meta.runtimeTaskId || ""),
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
            if (current.archivedAt) throw new ProductionArchivedError(id);
            if (current.publishedVersion !== preview.publishedVersion || current.published?.director?.sourceHash !== preview.sourceHash) throw new ProductionConflictError(current); // 乐观锁放行：revision 不再拦截，仅保留内容漂移（publishedVersion/sourceHash）保护
            // 乐观锁放行：来源/目标画布的 revision 漂移不再拦截。
            const latest = listApprovedSharedAssets(this.db, preview.dramaId).find(item => item.assetId === input.assetId);
            if (latest && (latest.storageKey !== preview.storageKey || latest.sha256 !== preview.sha256)) throw new Error("共享画布已有更新素材版本，拒绝接入旧媒体；请重新读取当前版本");
            const episode = this.db.getDramaEpisode(id)!;
            const director = current.published!.director!;
            const asset = director.assets[input.assetId]!;
            const sourceNode = (this.db.getCanvasProject(preview.sourceCanvasId)!.nodes as Record<string, any>[]).find(node => node.id === preview.sourceNodeId)!;
            const targetProject = this.db.getCanvasProject(sharedCanvasId)!;
            const prior = (targetProject.nodes as Record<string, any>[]).find(node => node.id === preview.targetNodeId);
            const priorOrigin = record(record(prior?.metadata).sharedPromotionOrigin);
            if (prior && (priorOrigin.episodeId !== id || priorOrigin.assetId !== input.assetId || priorOrigin.storageKey !== preview.storageKey || priorOrigin.sha256 !== preview.sha256)) throw new Error("共享画布已有身份冲突节点，拒绝覆盖");
            const sourceMeta = record(sourceNode.metadata);
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
                source: { kind: "system", clientId: "production:shared-promotion", label: "接入共享素材" } }) : { duplicated: false };
            const promotedDirector = structuredClone(director);
            promotedDirector.assets[input.assetId] = { ...asset, nodeId: preview.targetNodeId, storageKey: preview.storageKey, sha256: preview.sha256,
                version: String((Array.isArray(director.source.asset_plan) ? director.source.asset_plan : []).map(record).find(item => String(item.asset_id || item.id) === input.assetId)?.version || asset.version),
                status: "generated", ...(asset.evidence ? { evidence: asset.evidence } : {}), inputOutdated: false };
            registerSharedAssetVersion(this.db, sharedCanvasId, Math.max(1, preview.publishedVersion), input.assetId, promotedDirector);
            this.db.db.exec("COMMIT");
            canvasCommits.forEach(commit => this.db.notifyCanvasCommit(commit));
            this.events?.publish({ type: "drama-production.updated", entityId: id, payload: { sharedAssetPromotion: input.assetId } });
            return { approvedId: listApprovedSharedAssets(this.db, episode.dramaId).find(item => item.assetId === input.assetId)?.id || "", canvasId: sharedCanvasId,
                nodeId: preview.targetNodeId, replayed: Boolean(result.duplicated), mediaSubmitted: false };
        } catch (error) { try { this.db.db.exec("ROLLBACK"); } catch { /* Preserve the original failure after a completed transaction. */ } throw error; }
    }

    /** 归属切到剧目共享后自动迁移：发布版本里 scope=shared 且媒体已归档时直接接入共享画布，失败只广播不阻断触发动作。 */
    sharedAssets(id: string): { assets: ApprovedSharedAsset[]; versions: ApprovedSharedAsset[] } {
        const linked = this.linked(id); if (linked) return linked.service.sharedAssets(linked.id);
        const canvasId = this.episodeInfo(id).canvasId;
        const context = canvasId ? productionCanvasContext(this.db, canvasId) : undefined;
        return { assets: context?.dramaId ? listApprovedSharedAssets(this.db, context.dramaId) : [], versions: context?.dramaId ? sharedAssetHistory(this.db, context.dramaId) : [] };
    }

    listArchivedScenes(episodeId: string): ReturnType<typeof listArchivedDirectorScenes> {
        const linked = this.linked(episodeId); if (linked) return linked.service.listArchivedScenes(linked.id);
        this.episode(episodeId);
        return listArchivedDirectorScenes(this.db, { kind: this.ownerKind, id: episodeId });
    }

    operationReceipt(id: string, operationId: string): ProductionRecord | undefined {
        const linked = this.linked(id); if (linked) return linked.service.operationReceipt(linked.id, operationId);
        const row = this.prepare("SELECT receipt_json FROM episode_production_operations WHERE episode_id=? AND operation_id=?").get(id, operationId) as { receipt_json: StoredReceipt } | undefined;
        if (!row) return undefined;
        const record = resolveReceiptDedup(decodeReceipt<ProductionRecord>(row.receipt_json));
        // Stored receipts use source-only v2 snapshots; parse defaults to restore the
        // in-memory compatibility arrays before projectDirector derives their view.
        record.draft = episodeProductionHistoryDataSchema.parse(record.draft) as EpisodeProductionData;
        if (record.published) record.published = episodeProductionHistoryDataSchema.parse(record.published) as EpisodeProductionData;
        if (record.draft.director && !isSubjectPromptAssembly(record.draft.director.source)) throw new ProductionValidationError([{ code: "UNSUPPORTED_PRODUCTION_FORMAT", path: "receipt.draft.director.source", message: "旧版制作回执只能通过生产源稿维护命令检查。", severity: "error" }]);
        if (record.draft.director && isSubjectPromptAssembly(record.draft.director.source)) projectDirector(record.draft, false);
        if (record.published?.director && isSubjectPromptAssembly(record.published.director.source)) projectDirector(record.published, false);
        assertPublicReceipt(record);
        return record;
    }

    validateClipMedia(id: string, director: DirectorProduction, targetId: string): void {
        const linked = this.linked(id); if (linked) return linked.service.validateClipMedia(linked.id, director, targetId);
        const canvasId = this.episodeInfo(id).canvasId;
        if (!canvasId) throw new Error("缺少固定制作画布");
        validateDirectorMedia(this.db, canvasId, director, [targetId]);
    }

    verifyCompilationBindings(id: string, director: DirectorProduction, options: { allowUnreferencedAssetNodes?: boolean } = {}) {
        for (const artifact of director.artifacts) if (artifact.kind === "image" && artifact.status === "ready" && artifact.sourceHash === director.sourceHash) assertImageReferenceCoverage(director, artifact);
        const canvasId = this.episodeInfo(id).canvasId;
        const rawNodes = canvasId ? this.db.getCanvasProject(canvasId)?.nodes : undefined;
        if (!Array.isArray(rawNodes)) throw new Error("Production canvas does not exist");
        const nodes = rawNodes as Array<Record<string, any>>;
        validateSharedAssetPlanSources(this.db, canvasId!, director);
        for (const segment of clipRows(director.source.segments)) for (const binding of clipRows(segment.audio_bindings)) {
            const nodeId = String(binding.sourceNode?.nodeId || ""), storageKey = String(binding.storageKey || "");
            const node = nodes.find(item => String(item.id || "") === nodeId), metadata = record(node?.metadata);
            if (binding.sourceNode?.projectId !== canvasId || node?.type !== "audio"
                || String(node.storageKey || metadata.storageKey || "") !== storageKey) throw new Error(`音频绑定「${binding.label || binding.id}」已不属于当前制作画布`);
            const media = this.db.getMediaFile(storageKey);
            if (!media || !fs.existsSync(media.filePath) || !String(media.mimeType || binding.mimeType || "").startsWith("audio/")) throw new Error(`音频绑定「${binding.label || binding.id}」缺少有效归档媒体`);
            const digest = promptHashBytes(media.filePath);
            if (digest !== binding.sha256) throw new Error(`音频绑定「${binding.label || binding.id}」的归档字节已变化`);
        }
        const isAudioReference = (binding: Record<string, any>) =>
            String(binding.storageKey || "").startsWith("audio:")
            || String(binding.mediaType || "").toLowerCase() === "audio"
            || String(binding.mimeType || "").toLowerCase().startsWith("audio/")
            || String(binding.role || "").toLowerCase().includes("audio");
        // Clip audio references are verified against the authored audio_bindings above.
        // Older compiled H3 artifact snapshots can retain the previous audio media key;
        // treating those as image bindings makes a valid audio node fail image-node checks.
        const currentArtifactReferences = director.artifacts.filter(artifact => artifact.status === "ready" && currentCompilationArtifact(director, artifact));
        const bindings: Array<Record<string, any>> = [...Object.entries(director.assets).map(([assetId, asset]) => ({ ...asset, assetId })),
            ...currentArtifactReferences.flatMap(artifact => artifact.references.filter(binding => !isAudioReference(binding)).map(binding => ({ ...binding, targetId: artifact.targetId })))];
        const currentArtifactBindings = currentArtifactReferences.flatMap(artifact => artifact.references.filter(binding => !isAudioReference(binding)).map(binding => ({ ...binding, targetId: artifact.targetId })));
        // 画布风格锚点可以位于剧目共享资产画布，只有它能跨画布解析；其余引用仍须落在本集制作画布上。
        const styleAnchorNodeId = String(director.source.style_anchor_node_id || "");
        const sharedCanvasId = productionCanvasContext(this.db, canvasId!).sharedAssetCanvasId;
        const sharedNodes = styleAnchorNodeId && sharedCanvasId && sharedCanvasId !== canvasId
            ? this.db.getCanvasProject(sharedCanvasId)?.nodes as Array<Record<string, any>> | undefined : undefined;
        const nodesById = new Map<string, Record<string, any>>([
            ...(sharedNodes || []).filter(item => String(item.id || "") === styleAnchorNodeId).map(item => [String(item.id), item] as const),
            ...nodes.map(item => [String(item.id || ""), item] as const),
        ]);
        const mediaDigests = new Map<string, string>();
        for (const binding of bindings) {
            if (!binding.storageKey) continue;
            const node = nodesById.get(String(binding.nodeId || ""));
            const storyboardTargetIds = binding.targetId ? [String(binding.targetId)] : clipRows(director.source.segments)
                .filter(segment => clipRows(segment.shot_ids).some(shotId => clipRows(director.source.shots)
                    .some(shot => String(shot.id || "") === String(shotId)
                        && clipRows(shot.keyframes).some(frame => String(frame.assetId || frame.id || "") === String(binding.assetId || "")))))
                .map(segment => String(segment.id || ""));
            const archivedStoryboardBinding = !binding.nodeId && Boolean(binding.assetId)
                && storyboardTargetIds.some(targetId => isArchivedStoryboardKeyframeBinding({ director, nodes, targetId,
                    assetId: String(binding.assetId), bindingId: binding.bindingId, storageKey: String(binding.storageKey), sha256: String(binding.sha256 || "") }));
            const meta = node?.metadata as Record<string, unknown> | undefined;
            const keys = node ? [...resolveCanvasCharacterImageReferences(node).map(r => r.storageKey), (node as any).storageKey, meta?.storageKey, meta?.resultStorageKey] : [];
            if ((!node || !keys.includes(binding.storageKey)) && !archivedStoryboardBinding) {
                const currentReference = currentArtifactBindings.some(reference => String(reference.nodeId || "") === String(binding.nodeId || "")
                    && reference.storageKey === binding.storageKey);
                // `director.assets` may retain a previous local projection after a Subject picture
                // binding has moved to its shared source. Keep validating its archived bytes below,
                // but only require the old node to remain active when a current compiled artifact
                // still consumes that exact node/media pair.
                if (!options.allowUnreferencedAssetNodes || currentReference) throw new Error(`编译引用「${binding.label || binding.nodeId}」的图片已不在制作画布的对应节点上（节点 ${binding.nodeId} 缺失或已被替换），请在画布中恢复或重新生成该图片后重新编译`);
            }
            const media = this.db.getMediaFile(binding.storageKey);
            if (!media || !fs.existsSync(media.filePath)) throw new Error(`编译引用「${binding.label || binding.nodeId}」的图片文件已从本机归档中丢失（${binding.storageKey}），无法编译`);
            const digest = mediaDigests.get(binding.storageKey) || promptHashBytes(media.filePath);
            mediaDigests.set(binding.storageKey, digest);
            if (digest !== binding.sha256) throw new Error(`编译引用「${binding.label || binding.nodeId}」的图片内容已发生变化（与源稿记录的指纹不一致），请重新编译前先在画布中重新采用该图片`);
        }
    }

    canvasStyleAnchorInput(id: string, director: DirectorProduction) {
        const nodeId = String(director.source.style_anchor_node_id || "");
        if (!nodeId) return undefined;
        const episodeCanvasId = this.episodeInfo(id).canvasId;
        let nodes = episodeCanvasId ? this.db.getCanvasProject(episodeCanvasId)?.nodes as Array<Record<string, any>> | undefined : undefined;
        let node = nodes?.find(item => String(item.id || "") === nodeId);
        if (!node) {
            // 风格母版常驻剧目共享资产画布；分集画布找不到时回退到共享画布解析。
            const sharedCanvasId = episodeCanvasId ? productionCanvasContext(this.db, episodeCanvasId).sharedAssetCanvasId : undefined;
            node = (sharedCanvasId && sharedCanvasId !== episodeCanvasId
                ? this.db.getCanvasProject(sharedCanvasId)?.nodes as Array<Record<string, any>> | undefined : undefined)
                ?.find(item => String(item.id || "") === nodeId);
        }
        if (!node) throw new Error(`风格锚点画布节点不存在：${nodeId}`);
        const reference = resolveCanvasImageReferenceNode(node).find(item => item.storageKey);
        if (!reference?.storageKey) throw new Error(`风格锚点画布节点「${String(node.title || nodeId)}」没有可用的归档图片`);
        const media = this.db.getMediaFile(reference.storageKey);
        if (!media || !fs.existsSync(media.filePath)) throw new Error(`风格锚点图片文件不可用：${reference.storageKey}`);
        return { nodeId, storageKey: reference.storageKey, sha256: promptHashBytes(media.filePath), filePath: media.filePath };
    }

    compilationReferenceFiles(id: string, director: DirectorProduction) {
        this.verifyCompilationBindings(id, director, { allowUnreferencedAssetNodes: true });
        const files: Record<string, string> = {};
        for (const [assetId, asset] of Object.entries(director.assets)) {
            const file = this.db.getMediaFile(asset.storageKey || "")?.filePath;
            if (file) files[`${assetId}\0asset`] = file;
        }
        for (const artifact of director.artifacts) for (const ref of artifact.references) {
            const file = this.db.getMediaFile(ref.storageKey)?.filePath;
            if (file) files[`${artifact.targetId}\0${ref.label}`] = file;
        }
        for (const segment of clipRows(director.source.segments)) for (const binding of clipRows(segment.audio_bindings)) {
            const file = this.db.getMediaFile(String(binding.storageKey || ""))?.filePath;
            if (file) files[`${String(segment.id || "")}\0${String(binding.label || "")}`] = file;
        }
        const styleAnchor = this.canvasStyleAnchorInput(id, director);
        if (styleAnchor) for (const card of Array.isArray(director.source.asset_cards) ? director.source.asset_cards.map(record) : []) {
            for (const ref of Array.isArray(card.references) ? card.references.map(record) : []) {
                if (ref.canvas_style_anchor === true && ref.canvas_node_id === styleAnchor.nodeId && ref.canvas_storage_key === styleAnchor.storageKey && ref.sha256 === styleAnchor.sha256) {
                    files[`${String(card.id || "")}\0${String(ref.label || `<Picture ${ref.image}>`)}`] = styleAnchor.filePath;
                }
            }
        }
        return files;
    }

    compilationReferenceFile(id: string, director: DirectorProduction, targetId: string, label: string) {
        this.verifyCompilationBindings(id, director, { allowUnreferencedAssetNodes: true });
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
        this.assertCurrentDirectorFormat(record.published.director);
        this.checkEngine(record.published.director.engine);
        const canvasId = this.episodeInfo(episodeId).canvasId;
        if (!canvasId) throw new Error("制作稿未绑定画布");
        const selected = record.published.director.artifacts.filter(item => !targetIds || targetIds.includes(item.targetId));
        validateSharedAssetPlanSources(this.db, canvasId, record.published.director);
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
            assertSingleSourceStorage(current);
            if (current.publishedVersion !== version) {
                const baseline = this.version(episodeId, version).snapshot;
                const snapshot = structuredClone(baseline);
                const asset = snapshot.director?.assets[assetId];
                const media = this.db.getMediaFile(storageKey);
                if (!asset?.nodeId || !media || !fs.existsSync(media.filePath) || !JSON.stringify(this.canvasNode(episodeId, asset.nodeId)).includes(storageKey)) throw new Error("历史任务媒体与原节点绑定不一致");
                snapshot.director!.assets[assetId] = { ...asset, storageKey, sha256: promptHashBytes(media.filePath), status: "generated", inputOutdated: false };
                this.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?").run(JSON.stringify(withoutDirectorProjection(snapshot)), episodeId, version);
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
            if (this.isSharedAssetCanvas(episodeId) && String(planEntry?.canvas_scope || "shared") === "shared")
                registerSharedAssetVersion(this.db, episodeId, Math.max(1, version), assetId, current.published!.director!);
            const updatedAt = new Date().toISOString();
            this.prepare("UPDATE episode_productions SET revision=?, draft_json=?, published_json=?, updated_at=? WHERE episode_id=?").run(current.revision + 1, JSON.stringify(withoutDirectorProjection(current.draft)), JSON.stringify(current.published ? withoutDirectorProjection(current.published) : null), updatedAt, episodeId);
            this.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?").run(JSON.stringify(withoutDirectorProjection(current.published!)), episodeId, version);
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
        this.prepare("UPDATE episode_productions SET revision=?, draft_json=?, published_json=?, updated_at=? WHERE episode_id=?").run(current.revision + 1, JSON.stringify(withoutDirectorProjection(draft)), JSON.stringify(withoutDirectorProjection(published)), updatedAt, id);
        this.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?").run(JSON.stringify(withoutDirectorProjection(published)), id, current.publishedVersion);
    }

    getForRead(episodeId: string): ProductionRecord {
        return this.get(episodeId, false, false);
    }

    get(episodeId: string, maintenanceLegacyRead = false, projectRuntimeView = true): ProductionRecord {
        const linked = this.linked(episodeId); if (linked) return linked.service.get(linked.id, maintenanceLegacyRead, projectRuntimeView);
        this.episode(episodeId);
        const row = this.prepare("SELECT * FROM episode_productions WHERE episode_id = ?").get(episodeId) as Row | undefined;
        if (row) {
            const production = this.fromRow(episodeId, row, projectRuntimeView);
            if (!maintenanceLegacyRead && production.draft.director && !isSubjectPromptAssembly(production.draft.director.source)) {
                throw new ProductionValidationError([{ code: "UNSUPPORTED_PRODUCTION_FORMAT", path: "draft.director.source", message: "旧版 Acheng 制作稿只能通过生产源稿维护命令检查并显式迁移。", severity: "error" }]);
            }
            return production;
        }
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
        return { episodeId, revision: 0, draft, published: null, publishedVersion: 0, updatedAt: "", archivedAt: null };
    }

    async translateCompiledPrompts(id: string, input: CompiledPromptTranslationRequest): Promise<Record<string, unknown>> {
        const linked = this.linked(id);
        if (linked) return linked.service.translateCompiledPrompts(linked.id, input);
        const targetIds = [...new Set(input.targetIds.map(String))];
        if (!targetIds.length || targetIds.some(targetId => !targetId)) throw new Error("翻译目标不能为空");
        const canvasId = this.ownerKind === "canvas" ? id : this.episodeInfo(id).canvasId;
        if (!canvasId) throw new Error("制作对象尚未绑定画布");
        const tool = "production_translate_compiled_prompts";
        const request = { kind: this.ownerKind, id, expectedRevision: input.expectedRevision, targetIds };
        const identity = { tool, targetId: id, projectId: canvasId, request };
        let command = this.db.getMcpCommandReceipt(input.operationId, identity);
        const replayed = Boolean(command);
        if (command?.status === "committed") return { ...(command.receipt || {}), operationId: input.operationId, replayed: true };
        if (command?.status === "rejected") throw new Error(command.error?.message || "该翻译操作已拒绝；核对输入后使用新的 operationId");
        if (!command) {
            const production = this.get(id);
            if (production.archivedAt) throw new ProductionArchivedError(id);
            // expectedRevision is a caller baseline, not a lock on unrelated production state.
            // The frozen target artifact hashes, H3 bindings and prompt hashes below provide
            // the compare-and-write boundary for this operation.
            if (input.expectedRevision > production.revision) throw new ProductionConflictError(production);
            const director = production.draft.director;
            if (!director) throw new Error("制作稿缺少导演源稿");
            const project = this.db.getCanvasProject(canvasId);
            if (!project) throw new Error("正式制作画布不存在");
            const targets = targetIds.map(targetId => {
                const artifact = director.artifacts.find(item => item.kind === "h3" && item.targetId === targetId);
                if (!artifact || artifact.status !== "ready" || !currentCompilationArtifact(director, artifact) || artifact.receipt.promptHash !== artifact.sha256) {
                    throw new Error(`Clip ${targetId} 尚无当前有效的编译提示词；先编译成功后再翻译`);
                }
                const runtime = this.resolveDirectorSegmentRuntime(id, targetId);
                if (runtime.status !== "resolved") throw new Error(`Clip ${targetId} 的 H3 节点映射${runtime.status === "ambiguous" ? "不唯一" : "缺失"}`);
                const nodeId = runtime.matches[0].nodeId;
                const segmentId = runtime.matches[0].segmentId;
                const node = (project.nodes as Array<Record<string, any>>).find(item => String(item.id) === nodeId);
                if (!node || !isH3NodeType(String(node.type || ""))) throw new Error(`Clip ${targetId} 的正式 H3 节点不存在`);
                const segment = clipRows(record(node.metadata).segments).find(item => item.id === segmentId);
                if (!segment || String(record(segment.productionClipProjection).targetId || "") !== targetId) throw new Error(`Clip ${targetId} 的正式 H3 绑定已变化`);
                if (!String(artifact.prompt || "").trim()) throw new Error(`Clip ${targetId} 的编译提示词为空，无法翻译`);
                return {
                    targetId,
                    nodeId,
                    segmentId,
                    sourceHash: artifact.sha256,
                    canvasPromptHash: crypto.createHash("sha256").update(String(segment.prompt || ""), "utf8").digest("hex"),
                };
            });
            command = this.db.prepareMcpCommand({
                operationId: input.operationId,
                ...identity,
                payload: { stage: "translate", baseRevision: Number(project.revision || 0), targets,
                    resumeRequest: { kind: this.ownerKind, id, expectedRevision: input.expectedRevision, targetIds } },
                receipt: { canvasId, targetIds, translationStatus: "queued", translatedCount: 0 },
            });
        }
        if (command.status === "committed") return { ...(command.receipt || {}), operationId: input.operationId, replayed: true };
        if (command.status === "rejected") throw new Error(command.error?.message || "该翻译操作已拒绝；核对输入后使用新的 operationId");
        if (!command.payload) throw new Error("翻译操作回执缺少冻结任务");
        this.scheduleCompiledPromptTranslation(id, canvasId, input, identity);
        return {
            ...(command.receipt || {}),
            operationId: input.operationId,
            status: String(command.receipt?.translationStatus || "queued"),
            targetId: id,
            nextAction: { tool: "mcp_get_command_receipt", input: { operationId: input.operationId } },
            replayed,
        };
    }

    cancelCompiledPromptTranslation(id: string, operationId: string): boolean {
        const linked = this.linked(id);
        if (linked) return linked.service.cancelCompiledPromptTranslation(linked.id, operationId);
        const key = `${this.ownerKind}:${id}:${operationId}`;
        const controller = activePromptTranslationControllers.get(key);
        if (!controller) return false;
        controller.abort();
        return true;
    }

    compiledPromptTranslationStatus(id: string, operationId: string, expectedRevision: number, targetIds: string[]): {
        operationId: string; status: string; targetCount?: number; translatedCount?: number; cachedCount?: number; error?: string; nextAction: Record<string, string>;
    } {
        const linked = this.linked(id);
        if (linked) return linked.service.compiledPromptTranslationStatus(linked.id, operationId, expectedRevision, targetIds);
        const canvasId = this.ownerKind === "canvas" ? id : this.episodeInfo(id).canvasId;
        const identity = { tool: "production_translate_compiled_prompts", targetId: id, projectId: canvasId || undefined,
            request: { kind: this.ownerKind, id, expectedRevision, targetIds } };
        const command = this.db.getMcpCommandReceipt(operationId, identity);
        if (!command) return { operationId, status: "not_found", nextAction: { action: "retry_same_operation", message: "使用原 operationId 与原参数恢复翻译。" } };
        const receipt = command.receipt || {};
        const receiptStatus = String(receipt.translationStatus || "");
        const status = command.status === "rejected" ? receiptStatus.startsWith("rejected_") ? receiptStatus : "rejected" : String(receiptStatus || command.status);
        return { operationId, status, targetCount: targetIds.length,
            ...(typeof receipt.translatedCount === "number" ? { translatedCount: receipt.translatedCount } : {}),
            ...(typeof receipt.cachedCount === "number" ? { cachedCount: receipt.cachedCount } : {}),
            ...(typeof receipt.lastError === "string" ? { error: receipt.lastError } : command.error ? { error: command.error.message } : {}),
            nextAction: status === "committed" ? { action: "done", message: "翻译已写回。" }
                : status === "rejected_stale" ? { action: "recompile", message: "目标输入已变化；重新编译后再发起翻译。" }
                : command.status === "rejected" ? { action: "review_failure", message: "命令已拒绝，查看 errorCode 后修复输入。" }
                : { action: "retry_same_operation", message: "沿原 operationId 查询或重提相同请求。" } };
    }

    recoverCompiledPromptTranslations() {
        let resumed = 0;
        for (const command of this.db.listPreparedMcpCommands("production_translate_compiled_prompts")) {
            const payload = record(command.payload), receipt = record(command.receipt);
            if (!["queued", "translating", "applying"].includes(String(receipt.translationStatus || "queued"))) continue;
            const request = record(payload.resumeRequest);
            if (request.kind && String(request.kind) !== this.ownerKind) continue;
            const legacyBelongsToOwner = this.ownerKind === "canvas" ? command.targetId === command.projectId : command.targetId !== command.projectId;
            if (!request.kind && !legacyBelongsToOwner) continue;
            const id = String(request.id || command.targetId || "");
            const targetIds = Array.isArray(request.targetIds) ? request.targetIds.map(String) : [];
            const expectedRevision = Number(request.expectedRevision);
            if (!id || !Number.isInteger(expectedRevision) || expectedRevision < 0 || !targetIds.length || command.projectId == null) {
                this.db.updatePreparedMcpCommandReceipt(command.operationId, { ...receipt, translationStatus: "retry_required", lastError: "后台翻译已恢复为可重试；沿原 operationId 与原参数重提可继续，不能新建重复翻译。" });
                continue;
            }
            const input = { expectedRevision, operationId: command.operationId, targetIds };
            const identity = { tool: "production_translate_compiled_prompts", targetId: id, projectId: command.projectId, request: { kind: this.ownerKind, id, expectedRevision, targetIds } };
            this.scheduleCompiledPromptTranslation(id, command.projectId, input, identity);
            resumed++;
        }
        return resumed;
    }

    private scheduleCompiledPromptTranslation(
        id: string,
        canvasId: string,
        input: CompiledPromptTranslationRequest,
        identity: { tool: string; targetId: string; projectId: string; request: unknown },
    ) {
        const key = `${this.ownerKind}:${id}:${input.operationId}`;
        if (activePromptTranslations.has(key)) return;
        const controller = new AbortController();
        activePromptTranslationControllers.set(key, controller);
        const job = Promise.resolve().then(() => this.runCompiledPromptTranslation(id, canvasId, input, identity, controller.signal)).catch(error => {
            const command = this.db.getMcpCommandReceipt(input.operationId, identity);
            if (command?.status === "prepared" && command.payload) {
                const message = error instanceof Error ? error.message : String(error);
                const stale = controller.signal.aborted || /已变化|已被更新的编译替代|绑定已变化|节点映射已变化/.test(message);
                const translationStatus = stale ? "rejected_stale" : "retry_required";
                try {
                    this.db.updatePreparedMcpCommand({ operationId: input.operationId, ...identity, payload: command.payload,
                        receipt: { ...(command.receipt || {}), translationStatus, lastError: message } });
                    if (stale) this.db.rejectMcpCommand(input.operationId, "TRANSLATION_STALE", message);
                } catch { /* Another worker may have completed the frozen command. */ }
            }
        }).finally(() => { activePromptTranslations.delete(key); activePromptTranslationControllers.delete(key); });
        activePromptTranslations.set(key, job);
    }

    private async runCompiledPromptTranslation(
        id: string,
        canvasId: string,
        input: CompiledPromptTranslationRequest,
        identity: { tool: string; targetId: string; projectId: string; request: unknown },
        signal: AbortSignal,
    ) {
        if (signal.aborted) throw new Error("翻译已被更新的编译替代");
        let command = this.db.getMcpCommandReceipt(input.operationId, identity);
        if (!command || command.status !== "prepared" || !command.payload) return;
        let payload = command.payload;
        // Resume legacy receipts frozen before translation became asynchronous.
        if (payload.stage === undefined && Array.isArray(payload.operations)) payload = { ...payload, stage: "apply" };
        if (payload.stage === "translate") {
            const production = this.get(id);
            // `expectedRevision` is the caller's read baseline, not a lock. The
            // frozen artifact, binding, and H3 prompt hashes below guard the
            // translation inputs while allowing unrelated source edits.
            const director = production.draft.director;
            const project = this.db.getCanvasProject(canvasId);
            if (!director || !project) throw new Error("制作稿或画布不存在");
            const snapshots = payload.targets as Array<{ targetId: string; nodeId: string; segmentId: string; sourceHash: string; canvasPromptHash: string }>;
            const targets = snapshots.map(snapshot => {
                const artifact = director.artifacts.find(item => item.kind === "h3" && item.targetId === snapshot.targetId);
                if (!artifact || artifact.status !== "ready" || !currentCompilationArtifact(director, artifact) || artifact.sha256 !== snapshot.sourceHash || artifact.receipt.promptHash !== artifact.sha256) {
                    throw new Error(`Clip ${snapshot.targetId} 的编译基线已变化；请重新编译并发起翻译`);
                }
                const runtime = this.resolveDirectorSegmentRuntime(id, snapshot.targetId);
                if (runtime.status !== "resolved" || runtime.matches[0].nodeId !== snapshot.nodeId || runtime.matches[0].segmentId !== snapshot.segmentId) {
                    throw new Error(`Clip ${snapshot.targetId} 的 H3 节点映射已变化；请重新读取目标`);
                }
                const node = (project.nodes as Array<Record<string, any>>).find(item => String(item.id) === snapshot.nodeId);
                const segment = clipRows(record(node?.metadata).segments).find(item => item.id === snapshot.segmentId);
                if (!segment || String(record(segment.productionClipProjection).targetId || "") !== snapshot.targetId || crypto.createHash("sha256").update(String(segment.prompt || ""), "utf8").digest("hex") !== snapshot.canvasPromptHash) {
                    throw new Error(`Clip ${snapshot.targetId} 的 H3 提示词在翻译期间已变化；未写入任何译文`);
                }
                return { ...snapshot, sourcePrompt: String(artifact.prompt || "") };
            });
            command = this.db.updatePreparedMcpCommand({
                operationId: input.operationId,
                ...identity,
                payload,
                receipt: { ...(command.receipt || {}), translationStatus: "translating" },
            });
            const settings = { get: (key: string) => this.db.getSetting(key), set: (key: string, value: unknown) => this.db.setSetting(key, value), delete: (key: string) => this.db.deleteSetting(key) };
            let translations;
            try {
                translations = await translateH3PromptBatch({ settings }, targets.map(target => ({ id: target.targetId, text: target.sourcePrompt })), signal);
                if (signal.aborted) throw new Error("翻译已被更新的编译替代");
            } catch (error) {
                if (signal.aborted) throw error;
                const current = this.db.getMcpCommandReceipt(input.operationId, identity);
                if (current?.status === "prepared" && current.payload) this.db.updatePreparedMcpCommand({
                    operationId: input.operationId,
                    ...identity,
                    payload: current.payload,
                    receipt: { ...(current.receipt || {}), translationStatus: "retry_required", lastError: "翻译未完成；使用相同 operationId 重试可从缓存恢复已完成部分" },
                });
                return;
            }
            const translationById = new Map(translations.map(item => [item.id, item]));
            const translated = targets.map(target => {
                const result = translationById.get(target.targetId);
                if (!result) throw new Error(`Clip ${target.targetId} 缺少翻译结果`);
                return { ...target, prompt: result.translatedText, cached: result.cached };
            });
            const latestProduction = this.get(id);
            const latestDirector = latestProduction.draft.director;
            const latestProject = this.db.getCanvasProject(canvasId);
            if (signal.aborted) throw new Error("翻译已被更新的编译替代");
            if (!latestDirector || !latestProject) throw new ProductionConflictError(latestProduction);
            const operations: CanvasOperation[] = translated.map(item => {
                const artifact = latestDirector.artifacts.find(candidate => candidate.kind === "h3" && candidate.targetId === item.targetId);
                if (!artifact || artifact.status !== "ready" || !currentCompilationArtifact(latestDirector, artifact) || artifact.sha256 !== item.sourceHash) throw new Error(`Clip ${item.targetId} 的编译状态在翻译期间已变化；未写入任何译文`);
                const matches = this.resolveDirectorSegmentRuntime(id, item.targetId);
                if (matches.status !== "resolved" || matches.matches[0].nodeId !== item.nodeId || matches.matches[0].segmentId !== item.segmentId) throw new Error(`Clip ${item.targetId} 的 H3 绑定在翻译期间已变化；未写入任何译文`);
                const node = (latestProject.nodes as Array<Record<string, any>>).find(row => String(row.id) === item.nodeId);
                const segment = clipRows(record(node?.metadata).segments).find(row => row.id === item.segmentId);
                if (crypto.createHash("sha256").update(String(segment?.prompt || ""), "utf8").digest("hex") !== item.canvasPromptHash) throw new Error(`Clip ${item.targetId} 的 H3 提示词在翻译期间已变化；未写入任何译文`);
                return { type: "update_h3_segment", nodeId: item.nodeId, segmentId: item.segmentId, patch: { prompt: item.prompt } };
            });
            payload = { ...payload, stage: "apply", baseRevision: Number(latestProject.revision || 0), operations };
            command = this.db.updatePreparedMcpCommand({
                operationId: input.operationId,
                ...identity,
                payload,
                receipt: {
                    ...(command.receipt || {}),
                    translationStatus: "applying",
                    translatedCount: translated.length,
                    cachedCount: translated.filter(item => item.cached).length,
                    targets: translated.map(item => ({ targetId: item.targetId, nodeId: item.nodeId, segmentId: item.segmentId, sourceHash: item.sourceHash, translatedHash: crypto.createHash("sha256").update(item.prompt, "utf8").digest("hex") })),
                },
            });
        }
        if (payload.stage !== "apply" || !Array.isArray(payload.operations)) throw new Error("翻译操作回执缺少冻结写入内容");
        const baseRevision = Number(payload.baseRevision);
        if (!Number.isFinite(baseRevision)) throw new Error("翻译操作回执缺少有效的画布基线");
        const committed = this.db.applyCanvasProjectOperations(canvasId, undefined, payload.operations as CanvasOperation[], {
            operationId: input.operationId,
            baseRevision,
            mcpCommand: { tool: identity.tool, targetId: identity.targetId, request: identity.request },
            source: { kind: "system", clientId: "production:compiled-prompt-translation", label: "编译提示词英文翻译" },
        });
        this.events?.publish({ type: "canvas.updated", entityId: canvasId, revision: committed.revision, payload: committed.project });
    }
    assertSingleSourceStorageReady(record: ProductionRecord) { assertSingleSourceStorage(record); }

    resolveDirectorSegmentRuntime(id: string, targetId: string): { targetId: string; status: "resolved" | "missing" | "ambiguous"; matches: Array<{ nodeId: string; segmentId: string }> } {
        const linked = this.linked(id); if (linked) return linked.service.resolveDirectorSegmentRuntime(linked.id, targetId);
        const owner = { kind: this.ownerKind, id };
        const canvasId = this.ownerKind === "canvas" ? id : this.episodeInfo(id).canvasId;
        const project = canvasId ? this.db.getCanvasProject(canvasId) : undefined;
        const matches: Array<{ nodeId: string; segmentId: string }> = [];
        for (const node of (project?.nodes as Array<Record<string, any>> | undefined) || []) {
            const metadata = record(node.metadata);
            if (String(metadata.productionOwnerKind || "") !== owner.kind || String(metadata.productionOwnerId || "") !== owner.id) continue;
            for (const segment of clipRows(metadata.segments)) if (String(record(segment.productionClipProjection).targetId || "") === targetId) {
                matches.push({ nodeId: String(node.id || ""), segmentId: String(segment.id || "") });
            }
        }
        return { targetId, status: matches.length === 1 ? "resolved" as const : matches.length ? "ambiguous" as const : "missing" as const, matches };
    }

    /** Read-only maintenance report for v2 rows written before source-only storage. */
    inspectSingleSourceStorage(episodeId: string) {
        const current = this.get(episodeId);
        if (!current.draft.director || !isSubjectPromptAssembly(current.draft.director.source)) return { episodeId, revision: current.revision, status: "not_applicable", blockers: [] as string[] };
        if (current.storageFormat !== "v2-projection-migration-required") return { episodeId, revision: current.revision, status: "already_single_source", blockers: [] as string[] };
        const blockers: string[] = [];
        const compareSnapshot = (label: string, value: EpisodeProductionData | null) => {
            if (!value?.director || !isSubjectPromptAssembly(value.director.source)) { blockers.push(`${label}: source format is missing or not v2`); return; }
            const projected = structuredClone(value);
            projectDirector(projected, false);
            const comparable = (data: EpisodeProductionData) => ({
                scenes: data.scenes.map(({ id, heading, location, timeOfDay, blocks }) => ({ id, heading, location, timeOfDay, blocks })),
                shots: (data.shots as any[]).map(({ id, sceneId, title, duration, visual, camera, openingState, endingState, sound, assetNodeIds, keyframePolicy }) => ({ id, sceneId, title, duration, visual, camera, openingState, endingState, sound, assetNodeIds, keyframePolicy })),
                clipGroups: data.clipGroups.map(({ id, shotIds }) => ({ id, shotIds })),
            });
            const storedView = comparable(value), projectedView = comparable(projected);
            // 迁移只做一件事：删掉镜像，保留 source。因此要判断的是「删掉镜像会不会丢信息」，
            // 而不是「镜像是否与今天的投影逐字节相同」。后者是脆弱命题：投影是 source 的纯函数，
            // 只要投影逻辑演进（例如新增派生字段 characters/startFrame/stateUnresolved），
            // 所有历史镜像都会显得「不一致」，迁移因此永久卡死——那不是数据损坏，
            // 而是闸门问错了问题。实测已遇到两例：键序差异（早期 dialogue block 写
            // {id,kind,text,speaker}，投影产 {id,kind,speaker,text}）、以及投影新增派生键。
            //
            // 正确判据（按 id 对齐逐条比对）：
            //   - 镜像有、投影无的键  → 真丢信息，阻塞
            //   - 两侧都有但值不同    → 真冲突，阻塞
            //   - 投影有、镜像无的键  → 投影新派生的字段，不丢信息，放行
            for (const field of ["scenes", "shots", "clipGroups"] as const) {
                const storedRows = storedView[field] as Array<Record<string, any>>;
                const projectedRows = projectedView[field] as Array<Record<string, any>>;
                const keyOf = (row: Record<string, any>) => String(row?.id ?? "");
                const projectedById = new Map(projectedRows.map(row => [keyOf(row), row]));
                if (storedRows.length !== projectedRows.length) { blockers.push(`${label}: stored ${field} mirror has ${storedRows.length} rows, projection has ${projectedRows.length}`); continue; }
                for (const storedRow of storedRows) {
                    const projectedRow = projectedById.get(keyOf(storedRow));
                    if (!projectedRow) { blockers.push(`${label}: stored ${field} mirror contains ${keyOf(storedRow)} which the projection does not produce`); continue; }
                    for (const [key, storedValue] of Object.entries(storedRow)) {
                        if (!Object.hasOwn(projectedRow, key)) { blockers.push(`${label}: stored ${field}.${keyOf(storedRow)}.${key} exists only in the mirror; dropping it would lose data`); continue; }
                        if (canonicalProduction(storedValue) !== canonicalProduction(projectedRow[key])) blockers.push(`${label}: stored ${field}.${keyOf(storedRow)}.${key} disagrees with the source projection`);
                    }
                }
            }
            for (const group of value.clipGroups) {
                const association = this.resolveDirectorSegmentRuntime(episodeId, group.id);
                if (association.status !== "resolved") { blockers.push(`${label}: Canvas association for Segment ${group.id} is ${association.status}`); continue; }
                const [{ nodeId, segmentId }] = association.matches;
                if (group.nodeId && nodeId !== group.nodeId || group.segmentId && segmentId !== group.segmentId) blockers.push(`${label}: Canvas association for Segment ${group.id} differs from stored mirror`);
                const canvasId = this.ownerKind === "canvas" ? episodeId : this.episodeInfo(episodeId).canvasId;
                const node = (this.db.getCanvasProject(canvasId || "")?.nodes as Array<Record<string, any>> | undefined)?.find(item => String(item.id || "") === nodeId);
                const clip = clipRows(record(node?.metadata).segments).find(item => String(item.id || "") === segmentId);
                const origin = record(clip?.archivedResultOrigin), hasResultIdentity = Boolean(origin.generationLogId || origin.taskId || origin.sourceHash);
                if (hasResultIdentity) {
                    if (!origin.generationLogId || !origin.taskId || !origin.sourceHash) blockers.push(`${label}: selected result identity for Segment ${group.id} is incomplete`);
                    else {
                        const task = this.db.getTask(String(origin.taskId)), log = this.db.getGenerationLog(String(origin.generationLogId));
                        if (!task || task.status !== "succeeded" || task.projectId !== canvasId || task.nodeId !== nodeId || task.segmentId !== segmentId
                            || !log || log.status !== "success" || log.nodeId !== nodeId || log.segmentId !== segmentId || log.runtimeTaskId !== task.id) blockers.push(`${label}: selected result for Segment ${group.id} does not match a successful task and generation log`);
                    }
                }
            }
        };
        compareSnapshot("draft", current.draft);
        if (current.published?.director && isSubjectPromptAssembly(current.published.director.source)) compareSnapshot("published", current.published);
        return { episodeId, revision: current.revision, status: blockers.length ? "blocked" : "ready", blockers };
    }

    /** Explicit maintenance transaction; ordinary edits deliberately refuse these rows. */
    applySingleSourceStorage(episodeId: string, expectedRevision: number, operationId: string): ProductionRecord {
        const linked = this.linked(episodeId); if (linked) return linked.service.applySingleSourceStorage(linked.id, expectedRevision, operationId);
        if (!operationId.trim()) throw new Error("operationId 不能为空");
        const requestHash = fingerprint({ type: "deduplicate_director_v2_projection", episodeId, expectedRevision });
        const tables = PRODUCTION_TABLES[this.ownerKind];
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const prior = this.prepare(`SELECT request_hash, receipt_json FROM ${tables.operations} WHERE operation_id=?`).get(operationId) as { request_hash: string; receipt_json: StoredReceipt } | undefined;
            if (prior) {
                if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT: operationId 已用于不同维护操作");
                this.db.db.exec("COMMIT");
                return decodeReceipt<ProductionRecord>(prior.receipt_json);
            }
            const current = this.get(episodeId);
            if (current.revision !== expectedRevision) throw new ProductionConflictError(current);
            const report = this.inspectSingleSourceStorage(episodeId);
            if (report.status !== "ready") throw new Error(`DIRECTOR_STORAGE_MIGRATION_BLOCKED: ${report.blockers.join("; ") || report.status}`);
            const draft = withoutDirectorProjection(current.draft) as EpisodeProductionData;
            const published = current.published ? withoutDirectorProjection(current.published) as EpisodeProductionData : null;
            const next: ProductionRecord = { ...current, revision: current.revision + 1, draft, published, updatedAt: new Date().toISOString(), storageFormat: "v2-single-source" };
            const fresh = this.prepare(`SELECT revision FROM ${tables.productions} WHERE ${tables.key}=?`).get(episodeId) as { revision: number } | undefined;
            if (!fresh || Number(fresh.revision) !== expectedRevision) throw new ProductionConflictError(this.get(episodeId));
            this.prepare(`UPDATE ${tables.productions} SET revision=?, draft_json=?, published_json=?, updated_at=? WHERE ${tables.key}=? AND revision=?`)
                .run(next.revision, JSON.stringify(draft), published ? JSON.stringify(published) : null, next.updatedAt, episodeId, expectedRevision);
            const versions = this.prepare(`SELECT version, snapshot_json FROM ${tables.versions} WHERE ${tables.key}=?`).all(episodeId) as Array<{ version: number; snapshot_json: string }>;
            for (const version of versions) {
                const snapshot = JSON.parse(version.snapshot_json) as EpisodeProductionData;
                if (snapshot.director && isSubjectPromptAssembly(snapshot.director.source)) this.prepare(`UPDATE ${tables.versions} SET snapshot_json=? WHERE ${tables.key}=? AND version=?`)
                    .run(JSON.stringify(withoutDirectorProjection(snapshot)), episodeId, version.version);
            }
            this.prepare(`INSERT INTO ${tables.operations} (operation_id, ${tables.key}, request_hash, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)`)
                .run(operationId, episodeId, requestHash, encodeReceipt(publicProductionRecord(next)), next.updatedAt);
            this.db.db.exec("COMMIT");
            this.events?.publish({ type: "drama-production.updated", entityId: episodeId, payload: { revision: next.revision, publishedVersion: next.publishedVersion } });
            return next;
        } catch (error) { this.db.db.exec("ROLLBACK"); throw error; }
    }

    /** Exact live target status for diagnostics and generation/refresh gates. Saving a new source revision does not mutate active run snapshots. */
    targetOccupancy(id: string, targetIds: string[]): ProductionTargetOccupancy[] {
        const linked = this.linked(id); if (linked) return linked.service.targetOccupancy(linked.id, targetIds);
        const current = this.get(id);
        const segmentIds = new Set((current.draft.director?.source.segments as any[] || []).map(segment => String(segment.id)));
        const wanted = new Set(targetIds.map(target => target.includes(":") ? target : segmentIds.has(target) ? `segment:${target}` : target));
        const occupied: ProductionTargetOccupancy[] = [];
        for (const batch of this.listBatches(id).filter(batch => ["pending", "running", "paused", "awaiting_review"].includes(batch.status))) {
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

    async preflight(episodeId: string, raw: unknown, compilationRuntimeId?: string): Promise<ProductionPreflight> {
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
        // 乐观锁放行：expectedRevision 不再作为预检拦截项（版本号仍返回在 result.revision）。
        if (input.action === "edit" && input.request.ops.some(operation => operation.type === "restore_archived_scene_results") && input.request.ops.length !== 1) diagnostics.push({ code: "ARCHIVED_RESULT_RESTORE_MIXED", path: "request.ops", message: "归档视频恢复必须单独提交，不能与其他制作编辑混批", severity: "error" });
        if (diagnostics.length) { result.nextActions = diagnostics.flatMap(item => item.nextAction ? [item.nextAction] : []); return result; }
        let candidate = current.draft;
        try {
            if (input.action === "edit") candidate = this.simulateEditedCandidate(episodeId, input.request).draft;
            else if (input.action === "publish") candidate = await this.publishedCandidate(current, input.request.stage, input.request.scope);
            else if (input.action === "compile") {
                if (!current.draft.director) throw new ProductionValidationError([{ code: "COMPILE_STAGE_NOT_READY", path: "director", message: "请先保存正式导演源稿，再准备编译。", severity: "error" }]);
                const director = directorProductionSchema.parse(structuredClone(current.draft.director));
                const referenceFiles = this.compilationReferenceFiles(episodeId, director);
                if (this.checkEngine === assertDirectorEngine) {
                    const checked = await preflightCompilationDirector(director, (targetId, label) => referenceFiles[`${targetId}\0${label}`], compilationRuntimeId);
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
                if (checked.director && this.checkEngine === assertDirectorEngine) await this.validateSource(checked.director, "generate");
                if (checked.executionSnapshot) {
                    const snapshot = checked.executionSnapshot;
                    return { ...result, valid: true, generationReady: true, engine: null, readyTargets: snapshot.targets.map(target => target.id), blockedTargets: snapshot.blockedTargets, warnings: snapshot.warnings, planHash: snapshot.planHash, canvasRevision: snapshot.canvasRevision };
                }
                candidate = current.published!;
            }
            result.engine = candidate.director?.engine || null;
            if (input.action !== "compile" && candidate.director && this.checkEngine === assertDirectorEngine) diagnostics.push(...(await validateAchengSource(candidate.director, input.action === "edit" ? "edit" : input.action === "publish" ? "publish" : "generate", undefined, input.action === "edit" ? this.sourceShotValidationScope(input.request.ops) : undefined)));
        } catch (error) {
            if (error instanceof ProductionValidationError) diagnostics.push(...error.diagnostics);
            else diagnostics.push({ code: "PRODUCTION_BLOCKED", path: "request", message: error instanceof Error ? error.message : String(error), severity: "error" });
        }
        result.valid = !diagnostics.some(item => diagnosticBlocksAction(item, input.action));
        result.generationReady = input.action === "generate" && result.valid && !diagnostics.some(item => item.severity === "unverified");
        result.compileReady = input.action === "compile" && result.valid;
        result.nextActions = diagnostics.filter(item => diagnosticBlocksAction(item, input.action)).map(item => item.nextAction || { action: item.code === "REVISION_CONFLICT" ? "refresh" : "correct_source", message: item.message,
            tool: "production_get", input: { kind: this.projectScope ? "canvas" : "episode", id: episodeId } });
        return result;
    }

    private sourceShotValidationScope(ops: readonly ProductionOperation[]) {
        if (!ops.length) return undefined;
        const shotIds = new Set<string>();
        const localShotFields = new Set([
            "title", "visual", "camera", "dialogues", "audio", "description", "shot_type",
            "performance", "combat", "state_description", "identity_context", "offscreen_character_ids",
            "prompt_contract_version", "subject_usages", "utterance_refs", "reference_requirements", "keyframes",
        ]);
        for (const operation of ops) {
            if (operation.type === "patch_director_source" && operation.entity === "shot" && operation.id
                && Object.keys(operation.patch).every(field => localShotFields.has(field))) {
                shotIds.add(operation.id);
                continue;
            }
            if (operation.type === "set_director_shot_keyframes" || operation.type === "set_director_shot_utterances") {
                shotIds.add(operation.shotId);
                continue;
            }
            return undefined;
        }
        return shotIds.size ? { shotIds: [...shotIds] } : undefined;
    }

    private async validateSource(director: NonNullable<EpisodeProductionData["director"]>, stage: "edit" | "publish" | "generate", scope?: { shotIds: string[] }): Promise<void> {
        // The existing injected engine checker is also used by temporary-data tests.
        // Production instances always verify the immutable runtime.
        const checkedEngine = this.checkEngine(director.engine);
        if (this.checkEngine === assertDirectorEngine) {
            const candidate = stage === "edit" && isSubjectPromptAssembly(director.source) ? { ...director, artifacts: [] } : director;
            await assertAchengSource(candidate, stage, checkedEngine as AchengRuntime, scope);
        }
    }

    /** readiness 条件请求（If-None-Match）的输入戳：PRAGMA data_version 在每次事务提交后必递增，
     *  未提交任何写入 ⇒ 数据库状态逐字节不变 ⇒ readiness 结果必然相同，可安全返回 304 跳过 1.2s 全量计算。
     *  bootId 防止进程重启后 data_version 归零与旧客户端缓存戳撞号。 */
    readinessInputStamp(episodeId: string, source: "draft" | "published" = "draft", runId?: string): string | null {
        const linked = this.linked(episodeId);
        const targetId = linked ? linked.id : episodeId;
        const production = this.prepare("SELECT revision FROM episode_productions WHERE episode_id = ?").get(targetId) as { revision: number } | undefined;
        if (!production) return null;
        const dataVersion = (this.prepare("PRAGMA data_version").get() as { data_version: number } | undefined)?.data_version ?? 0;
        return crypto.createHash("sha256").update(`${targetId}|${source}|${runId ?? ""}|${production.revision}|${dataVersion}|${readinessStampBootId}`).digest("hex").slice(0, 20);
    }

    workflowReadiness(episodeId: string, source: "draft" | "published" = "draft", runId?: string): DirectorReadiness {
        // 一次请求只读一次制作稿：get() 会完整 JSON.parse + zod 校验，制作稿可达数 MB。
        const current = this.get(episodeId);
        // 生产批次也只读一次：每次 listBatches 都会解析所有 run 的执行快照。
        const batches = this.listBatches(episodeId);
        const baseline = this.formalWorkflowReadiness(episodeId, source, runId, current, batches);
        if (source === "published") return baseline;
        const data = current.draft;
        if (!data.director) return baseline;
        const stage = directorStageReadiness(data.director);
        const keyframeIds = new Set(Object.values(data.director.shotInputs).map(input => input.keyframeAssetId).filter(Boolean));
        const ids = [...Object.keys(data.director.assets).filter(id => !keyframeIds.has(id)).map(id => `asset:${id}`), ...Object.keys(data.director.shotInputs).filter(id => data.director!.shotInputs[id].keyframeAssetId).map(id => `frame:${id}`), ...data.clipGroups.map(group => `segment:${group.id}`)];
        try {
            const checked = this.canvasExecution(episodeId, ids);
            const project = checked.canvasId ? this.db.getCanvasProject(checked.canvasId) : null;
            const nodes = (project?.nodes || []) as Array<Record<string, any>>;
            const ready = new Set(checked.targets.map(target => target.id));
            const dependencyBlocked = new Map(checked.targets.filter(target => target.dependencies.length && data.director!.workflow.mediaProductionMode !== "automatic").map(target => [target.id, target.dependencies.map(dependency => dependency.targetId)]));
            const targets = ids.map(id => {
                const previous = baseline.targets.find(target => target.id === id);
                const mediaBlockers = productionMediaDependencyBlockers(previous);
                // Canvas execution snapshots do not know the authored H3 mode's media
                // contract. Keep the formal Ref2VA image requirement visible when the
                // workbench overlays its current-canvas readiness snapshot.
                const referenceModeBlockers = previous?.blockers.filter(message => message.startsWith("Ref2VA")) || [];
                const segmentId = id.startsWith("segment:") ? id.slice("segment:".length) : "";
                const compilationBlockers = segmentId ? previous?.blockers.filter(message => message.includes("需要由当前激活 Acheng 引擎重新编译") || message.includes("完整编译提示词")) || [] : [];
                const canvasBlockers = checked.blockedTargets.filter(target => target.targetId === id).map(target => target.message);
                const blockers = [...new Set([
                    ...referenceModeBlockers,
                    ...compilationBlockers,
                    ...canvasBlockers,
                    ...mediaBlockers,
                    ...(dependencyBlocked.has(id) ? [`请先生成前置目标：${dependencyBlocked.get(id)!.join(", ")}`] : []),
                ])];
                const targetReady = ready.has(id) && !dependencyBlocked.has(id) && mediaBlockers.length === 0 && referenceModeBlockers.length === 0 && compilationBlockers.length === 0;
                return { ...(previous || { id, targetId: id.slice(id.indexOf(":") + 1), kind: id.startsWith("segment:") ? "segment" as const : id.startsWith("frame:") ? "keyframe" as const : "asset" as const, title: id }),
                    status: targetReady ? previous?.status === "complete" ? "complete" as const : "ready" as const : "blocked" as const, blockers, notice: "使用当前已保存内容" };
            });
            const next = targets.find(target => target.status === "ready") || targets.find(target => target.status === "blocked");
            return { ...baseline, targets, canvasId: checked.canvasId, canvasRevision: checked.canvasRevision,
                unresolved: [...new Set(targets.flatMap(target => target.blockers))],
                stage,
                nextAction: next ? next.status === "ready" ? `可以推进：${next.title}` : `先补齐：${next.blockers[0]}` : stage.nextAction,
                presentation: this.directorPresentation(episodeId, current, data.director, targets, runId, batches) };
        } catch { return baseline; }
    }

    private formalWorkflowReadiness(episodeId: string, source: "draft" | "published" = "draft", runId?: string, loaded?: ProductionRecord, batches?: ProductionBatch[]): DirectorReadiness {
        const current = loaded ?? this.get(episodeId);
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
        const stage = directorStageReadiness(director);
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
            return { revision: current.revision, publishedVersion: current.publishedVersion, source, targets: [], modules: {}, unresolved: ["尚未接入 Acheng 制作稿"], nextAction: stage.nextAction, presentation, stage };
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
                references: artifact.references.map(ref => [ref.label, ref.nodeId || "", ref.bindingId || "", ref.assetId || "", ref.storageKey, ref.sha256, ref.role]),
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
        const canvasRole = canvasId ? productionCanvasContext(this.db, canvasId, project).role : "ordinary";
        const nodes = project?.nodes as Array<Record<string, any>> | undefined;
        const subjectRows = objectList(director.source.subject_registry);
        const subjectById = new Map<string, Record<string, any>>(subjectRows.map(subject => [String(subject.id || ""), subject]));
        const pictureBindingsById = new Map(subjectRows.flatMap(subject => objectList(subject.pictureBindings).map(binding => [String(binding.id || ""), binding] as const)));
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
            // Verified archived output stays complete when current-canvas generation updates the draft only.
            const unpublished = source === "draft" && input.status !== "complete" && (publicationWide || unpublishedTargets.has(input.id));
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
        const assetScope = (id: string) => String(planById.get(id)?.canvas_scope || (planById.get(id)?.sharedSource || canvasRole === "shared-assets" ? "shared" : "episode"));
        const assetScopeBlockers = (id: string) => {
            const scope = assetScope(id);
            if (!["shared", "episode"].includes(scope)) return [`资产 ${id} 的画布归属无效：${scope}`];
            if (canvasRole === "shared-assets" && scope !== "shared") return [`资产 ${id} 标记为本集专用，不能在剧目共享资产画布生产`];
            if (canvasRole !== "shared-assets" && scope === "shared" && !planById.get(id)?.sharedSource) return [`共享素材 ${id} 尚未选择同剧目共享节点`];
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
            if (!dep || !usableAssetMedia(dep)) return [`依赖资产 ${id} 的媒体未就绪`];
            return [];
        });
        const usableAssetMedia = (asset: NonNullable<DirectorProduction["assets"][string]>) => {
            if (!asset.nodeId || !asset.storageKey || !asset.sha256 || !canvasId) return false;
            const media = this.db.getMediaFile(asset.storageKey);
            const node = nodes?.find(item => item.id === asset.nodeId);
            if (!media || !node || !fs.existsSync(media.filePath) || crypto.createHash("sha256").update(fs.readFileSync(media.filePath)).digest("hex") !== asset.sha256) return false;
            const metadata = record(node.metadata);
            return [...resolveCanvasCharacterImageReferences(node).map(item => item.storageKey), node.storageKey, metadata.storageKey, metadata.resultStorageKey].includes(asset.storageKey);
        };
        const pushAsset = (id: string, title: string, blockers: string[]) => {
            const artifact = artifactFor("image", id);
            const asset = director.assets[id];
            const reusable = Boolean(asset && usableAssetMedia(asset));
            const all = [...blockers, ...assetScopeBlockers(id), ...compiled(artifact, `资产 ${id}`)];
            if (!reusable && !imageModelFor(id, asset?.nodeId)) all.push("缺少图片模型；请在现有模型设置中选择模型");
            if (artifact?.status === "ready" && canvasId) {
                try { validateDirectorMedia(this.db, canvasId, director, [id]); }
                catch (error) { all.push(error instanceof Error ? error.message : String(error)); }
            } else if (!canvasId) all.push("制作对象尚未关联画布");
            const status = reusable ? "complete" : all.length ? "blocked" : "ready";
            addTarget({ id: `asset:${id}`, targetId: id, kind: "asset", title, status, blockers: reusable ? [] : [...new Set(all)], ...(asset?.inputOutdated ? { notice: "沿用已绑定媒体；其源输入版本较早" } : {}), ...(artifact ? { artifactId: artifact.id } : {}) });
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
            const frame = data.keyframes[shotId];
            const frameAsset = director.assets[assetId];
            const frameUsable = Boolean(frame?.storageKey && frameAsset?.storageKey === frame.storageKey && usableAssetMedia(frameAsset));
            const artifact = assetId ? artifactFor("image", assetId) : undefined;
            const deps = [...(input.assetIds || []), ...idList(shot.required_assets)].filter(Boolean);
            const blockers = [...(canvasRole === "shared-assets" ? ["剧目共享资产画布只生产可复用资产；关键帧应在分集画布生成"] : []), ...(assetId ? assetScopeBlockers(assetId) : ["关键帧未绑定 Acheng 图像资产"]), ...dependencyBlockers(deps), ...compiled(artifact, `镜头 ${shotId} 的关键帧`)];
            if (!frameUsable && !imageModelFor(assetId || shotId, frameAsset?.nodeId || frame?.nodeId)) blockers.push("缺少图片模型；请在现有模型设置中选择模型");
            if (!canvasId) blockers.push("制作对象尚未关联画布");
            if (artifact?.status === "ready" && canvasId) {
                try { validateDirectorMedia(this.db, canvasId, director, [assetId]); }
                catch (error) { blockers.push(error instanceof Error ? error.message : String(error)); }
            }
            if (input.keyframePolicy === "reuse" && !frameUsable) blockers.push("复用关键帧的绑定媒体不可用");
            const status = frameUsable ? "complete" : blockers.length ? "blocked" : "ready";
            addTarget({ id: `frame:${shotId}`, targetId: shotId, kind: "keyframe", title: String(shot.title || shotId), status, blockers: frameUsable ? [] : [...new Set(blockers)], ...(artifact ? { artifactId: artifact.id } : {}) });
        }
        const boundaryByFrom = new Map(director.boundaries.map(boundary => [boundary.from, boundary]));
        const registeredSceneEntries = productionSceneEntries(director.source);
        const promptV2 = isSubjectPromptAssembly(director.source);
        const shotWindows = promptV2 ? subjectShotWindows(director.source) : undefined;
        const completionBatches = batches ?? this.listBatches(episodeId);
        for (const [index, segment] of segments.entries()) {
            const segmentId = String(segment.id || "");
            if (!segmentId) continue;
            const shotIds = Array.isArray(segment.shot_ids) ? segment.shot_ids.map(String) : [];
            const artifact = artifactFor("h3", segmentId);
            const blockers = [...(canvasRole === "shared-assets" ? ["剧目共享资产画布不能生产分集视频 Clip"] : []), ...compiled(artifact, `Segment ${segmentId}`)];
            const continuityWarnings = hasContinuityV2 ? continuityTargetBlockers(continuityReport, [segmentId]).map(item => `${item.code}: ${item.message}`) : [];
            const group = data.clipGroups.find(item => item.id === segmentId);
            const sceneIds = productionSceneIdsForShots(registeredSceneEntries, shotIds);
            if (sceneIds.length !== 1) blockers.push(sceneIds.length ? "Segment 跨越多个正式场次；先按场次拆分" : "Segment 未映射到唯一正式场次；无法分配场次 H3 节点");
            const declaresEnvironmentUsage = isSubjectPromptAssembly(director.source) && shotIds.some(shotId => {
                const shot = shots.find(item => String(item.id) === shotId);
                return objectList(shot?.subject_usages).some(usage => {
                    const subject = subjectById.get(String(usage.subjectId || ""));
                    return subject?.entityRef?.kind === "scene" && Array.isArray(usage.referencePurpose) && usage.referencePurpose.map(String).includes("environment");
                });
            });
            const hasSceneReference = artifact?.references.some(reference => ["scene", "environment"].includes(String(reference.role).toLowerCase())) || false;
            if (sceneIds.length === 1 && !declaresEnvironmentUsage && !hasSceneReference) {
                continuityWarnings.push("Segment 使用了正式场景，但 Shot 未声明 scene/environment Subject；场景空间不会进入 H3 图片参考。需要环境锚点时，先生成并绑定场景图，再编译当前 Segment。");
            }
            if (declaresEnvironmentUsage && artifact && !hasSceneReference) {
                blockers.push("Shot 已声明 scene/environment 图片参考，但当前 H3 产物未绑定场景图；请修复场景 Subject 图片绑定并重编、应用此 Segment");
            }
            if (!h3ModelFor(segmentId, group?.nodeId ?? undefined)) blockers.push("缺少 H3 模型；请在现有模型设置中选择模型");
            if (!shotIds.length) blockers.push("Segment 尚未编入 Shot");
            const fps = Number(director.source.fps_num || 24) / Number(director.source.fps_den || 1);
            const sourceShots = new Map(shots.map(shot => [String(shot.id), shot]));
            if (shotIds.some(id => !sourceShots.has(id))) blockers.push("Segment 引用了尚未登记的 Shot");
            const includedShots = shotIds.map(id => sourceShots.get(id)).filter((item): item is Record<string, any> => Boolean(item));
            const startFrame = promptV2 ? shotWindows?.get(shotIds[0])?.startFrame : Number(segment.start_frame);
            const endFrame = promptV2 ? shotWindows?.get(shotIds.at(-1) || "")?.endFrame : Number(segment.end_frame);
            const durationFrames = Number(endFrame) - Number(startFrame);
            const duration = durationFrames / fps;
            const declared = String(segment.generation_clip_duration || "").split("/").map(Number);
            const declaredSeconds = declared.length === 2 ? declared[0] / declared[1] : declared[0];
            const storedWindowMismatch = Boolean(promptV2 && (segment.start_frame !== undefined || segment.end_frame !== undefined)
                && (Number(segment.start_frame) !== Number(startFrame) || Number(segment.end_frame) !== Number(endFrame)));
            if (!Number.isFinite(duration) || duration < 4 || duration > 15 || !promptV2 && Math.abs(duration - declaredSeconds) > 1e-7)
                blockers.push(promptV2 ? "Clip 时长由 Shots 派生，且须在 4–15 秒内" : "帧窗与秒数须一致，并在 4–15 秒内");
            if (storedWindowMismatch) blockers.push("Segment 帧窗必须与 Shots 的派生帧窗一致");
            const shotPositions = shotIds.map(id => shots.findIndex(shot => String(shot.id) === id));
            if (shotPositions.some(position => position < 0) || shotPositions.some((position, i) => i > 0 && position !== shotPositions[i - 1] + 1)) blockers.push("Segment 必须覆盖连续的相邻 Shot");
            if (!promptV2 && includedShots.length === shotIds.length && includedShots.length && (includedShots[0].start_frame !== segment.start_frame || includedShots[includedShots.length - 1].end_frame !== segment.end_frame || includedShots.some((shot, i) => i > 0 && shot.start_frame !== includedShots[i - 1].end_frame))) blockers.push("Segment 帧窗未覆盖 Shot 的连续边界");
            const requiredAssets = shotIds.flatMap(id => {
                const shot = sourceShots.get(id);
                const input = director.shotInputs[id];
                return [...(input?.assetIds || []), ...idList(shot?.required_assets)].filter(Boolean);
            });
            const subjectAssetIds: string[] = [];
            if (isSubjectPromptAssembly(director.source)) {
                for (const shotId of shotIds) {
                    const shot = sourceShots.get(shotId);
                    for (const usage of objectList(shot?.subject_usages)) {
                        const resolved = resolveSubjectPictureBindingIds(subjectById.get(String(usage.subjectId || "")), usage);
                        blockers.push(...resolved.issues.map(issue => `Shot ${shotId}: ${issue}`));
                        for (const bindingId of resolved.bindingIds) {
                            const binding = pictureBindingsById.get(String(bindingId));
                            if (binding) subjectAssetIds.push(String(binding.assetId || binding.id));
                        }
                    }
                }
            }
            requiredAssets.push(...subjectAssetIds);
            const requiredKeyframeAssets = shotIds.flatMap(shotId => {
                const shot = sourceShots.get(shotId);
                if (isSubjectPromptAssembly(director.source)) return objectList(shot?.keyframes).filter(frame => frame.requiredForSubmission && frame.anchor !== "composition").map(frame => String(frame.assetId || frame.id || "")).filter(Boolean);
                const input = director.shotInputs[shotId];
                return input?.keyframePolicy !== "none" && input?.keyframeAssetId ? [input.keyframeAssetId] : [];
            });
            const compositionReferenceAssets = isSubjectPromptAssembly(director.source) ? shotIds.flatMap(shotId => {
                const shot = sourceShots.get(shotId);
                return [
                    ...objectList(shot?.reference_requirements).filter(reference => reference.requiredForSubmission).map(reference => String(reference.asset_id || "")),
                    ...objectList(shot?.keyframes).filter(frame => frame.requiredForSubmission && frame.anchor === "composition").map(frame => String(frame.assetId || frame.id || "")),
                ];
            }) : [];
            if (String(segment.mode) === "Ref2VA" && ![...requiredAssets, ...requiredKeyframeAssets, ...compositionReferenceAssets].some(Boolean)) blockers.push("Ref2VA 模式至少需要一张已选择的图片参考或必需关键帧；请补选图片或切换到适用的无图模式");
            blockers.push(...dependencyBlockers([...requiredAssets, ...compositionReferenceAssets]));
            for (const shotId of shotIds) {
                if (!isSubjectPromptAssembly(director.source)) {
                    const input = director.shotInputs[shotId];
                    if (!input && !skipStoryboardImages) blockers.push(`Shot ${shotId} 缺少参考与关键帧映射`);
                    else if (input && input.keyframePolicy !== "none" && !skipStoryboardImages) {
                        const frame = data.keyframes[shotId];
                        const review = data.keyframeReviews[shotId];
                        if (!frame?.storageKey) blockers.push(`Shot ${shotId} 的关键帧尚未生成或绑定`);
                    }
                }
            }
            const outgoingBoundaries = director.boundaries.filter(boundary => boundary.from === segmentId);
            const outgoingBoundary = boundaryByFrom.get(segmentId);
            if (index < segments.length - 1 && !outgoingBoundaries.length) continuityWarnings.push(`缺少 ${segmentId} → ${String(segments[index + 1].id)} 的连续性决定`);
            else if (index < segments.length - 1 && outgoingBoundaries.length > 1) continuityWarnings.push(`Segment ${segmentId} 有重复连续性边界`);
            else if (index < segments.length - 1 && outgoingBoundary?.to !== String(segments[index + 1].id)) continuityWarnings.push(`已有边界 ${segmentId} → ${outgoingBoundary?.to} 已不相邻`);
            else if (index < segments.length - 1 && !outgoingBoundary?.reason.trim()) continuityWarnings.push(`边界 ${segmentId} → ${String(segments[index + 1].id)} 缺少理由`);
            else if (index === segments.length - 1 && outgoingBoundaries.length) continuityWarnings.push(`最后一个 Segment ${segmentId} 有多余连续性边界`);
            if (outgoingBoundary?.tailFrame && outgoingBoundary.motionContext) blockers.push(`边界 ${segmentId} 同时启用了尾帧参考与 Motion Context`);
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
            addTarget({ id: `segment:${segmentId}`, targetId: segmentId, kind: "segment", title: segmentId, status: blockers.length ? "blocked" : completed ? "complete" : "ready", blockers: [...new Set(blockers)], ...(continuityWarnings.length ? { warnings: continuityWarnings } : {}),
                ...(artifact ? { artifactId: artifact.id } : {}), ...(hasMotionChain ? { executionTargets, notice: `Motion Context 使用同一连续组运行；本次范围从 ${String(segments[chainStart].id)} 到 ${String(segments[chainEnd].id)}。如果没有可复用 latent，将从组首段重新运行。` } : {}) });
        }
        let engineError = "";
        for (const item of targets) {
            const assetId = item.kind === "keyframe" ? director.shotInputs[item.targetId]?.keyframeAssetId : item.targetId;
            const asset = assetId ? director.assets[assetId] : undefined;
            if (asset?.inputOutdated && asset.storageKey) item.notice = "沿用已绑定媒体；其源输入版本较早";
            if (item.kind === "segment" && data.clipGroups.find(group => group.id === item.targetId)?.inputOutdated) item.notice = "已有成片对应旧共享输入；更新引用不会自动重新生成";
        }
        try { this.checkEngine(director.engine); } catch (error) { engineError = error instanceof Error ? error.message : String(error); }
        if (engineError) for (const item of targets.filter(target => target.status === "ready")) { item.status = "blocked"; item.blockers.push(engineError); }
        const blockedModules = Object.values(director.modules).flatMap(item => item.unresolved);
        const next = targets.find(item => item.status === "ready") || targets.find(item => item.status === "needs_review") || targets.find(item => item.status === "blocked");
        const nextAction = next ? next.status === "ready" ? `可以推进：${next.title}` : next.status === "needs_review" ? `待审核：${next.title}` : `先补齐：${next.blockers[0]}` : blockedModules[0] || stage.nextAction;
        const presentation = this.directorPresentation(episodeId, current, current.draft.director || director, targets, runId, completionBatches);
        return { revision: current.revision, publishedVersion: current.publishedVersion, source, targets, modules: moduleStates, unresolved: [...new Set([...director.unresolved, ...blockedModules, ...ungroupedShotIssues, ...invalidBoundaryIssues])], nextAction, stage, ...(presentation ? { presentation } : {}), sceneWorks: current.draft.director?.workflow.sceneWorks };
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

    private directorPresentation(episodeId: string, current: ProductionRecord, director: DirectorProduction, targets: DirectorReadinessTarget[], requestedRunId?: string, batches?: ProductionBatch[]): DirectorPresentation | undefined {
        const owner = { kind: this.ownerKind, id: episodeId };
        // 同一请求内只读一次批次；调用方已加载时直接复用。
        const allBatches = () => batches ?? this.listBatches(episodeId);
        const canvasId = this.episodeInfo(episodeId).canvasId || undefined;
        const canonicalId = current.episodeId;
        const aliases = [...new Set([canonicalId, canvasId].filter((id): id is string => Boolean(id) && id !== owner.id))];
        const declaredWork = director.workflow.currentWork;
        let inferredReason = "";
        let work = declaredWork;
        if (!work) {
            const runs = allBatches();
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
            const active = allBatches().filter(item => ["pending", "running", "paused", "awaiting_review"].includes(item.status));
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
                    status = native.target_kind === "segment" ? "complete" : targets.find(target => target.targetId === native.target_id)?.status === "complete" ? "complete" : "blocked";
                    action = status === "blocked" ? "blocked" : "deliver"; reason = status === "blocked" ? "归档结果尚未通过媒体与节点绑定校验" : "查看本轮任务的真实归档结果";
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
                ...(group ? { runtime: Object.fromEntries(["audioDrive", "audioDriveFile", "audioDriveStart", "audioDriveEnd"].map(field => [field, input[field]])) } : {}),
                directorBaseline: projection?.nextValues || {}, manualFields: fields.filter(field => projection?.fieldHashes?.[field] && projection.fieldHashes[field] !== inputHash(input[field])), directorChanges: (projection?.conflicts || []).filter((field: string) => !fields.includes(field) || !projection?.fieldHashes?.[field] || projection.fieldHashes[field] !== inputHash(input[field])), inputOutdated: input.inputOutdated || false }];
        });
    }

    canvasExecution(id: string, targets: string[], expectedCanvasRevision?: number): CanvasExecutionSnapshot {
        const linked = this.linked(id); if (linked) return linked.service.canvasExecution(linked.id, targets, expectedCanvasRevision);
        const current = this.get(id), canvasId = this.episodeInfo(id).canvasId;
        const project = canvasId && this.db.getCanvasProject(canvasId);
        if (!project) throw new Error("制作对象未关联可用画布");
        if (expectedCanvasRevision !== undefined && expectedCanvasRevision > Number(project.revision)) throw new Error("请求画布基线晚于当前画布版本");
        const snapshot = captureCanvasInputs(project, current.draft, targets, record(this.db.getSetting(H3_DEFAULTS_KEY)), key => this.db.getMediaFile(key));
        if (!this.isSharedAssetCanvas(id) && current.draft.director) {
            const plans = new Map((Array.isArray(current.draft.director.source.asset_plan) ? current.draft.director.source.asset_plan : []).map(item => [String(item.asset_id || item.id || ""), item]));
            for (const blocked of snapshot.blockedTargets) {
                const assetId = blocked.targetId.startsWith("asset:") ? blocked.targetId.slice("asset:".length) : "";
                const plan = plans.get(assetId);
                if (assetId && plan?.canvas_scope === "shared" && !plan?.sharedSource) {
                    blocked.code = "SHARED_SOURCE_REQUIRED";
                    blocked.message = `共享资产 ${assetId} 尚未选择同剧目共享节点`;
                }
            }
        }
        return snapshot;
    }

    private canvasBatchCandidate(id: string, current: ProductionRecord, input: DirectorRunStart) {
        // 乐观锁放行（last-write-wins）：客户端过期 revision 不再拦截，版本号继续自增。
        const director = current.draft.director;
        if (!director) throw new Error("生产对象缺少导演登记信息");
        const executionSnapshot = this.canvasExecution(id, input.targets, input.expectedCanvasRevision);
        const draftReadiness = this.formalWorkflowReadiness(id, "draft");
        const readinessById = new Map(draftReadiness.targets.map(target => [target.id, target]));
        const missingMedia: ProductionDiagnostic[] = input.targets.flatMap(targetId => productionMediaDependencyBlockers(readinessById.get(targetId)).map(message => ({
            code: "PRODUCTION_MEDIA_DEPENDENCY", path: "targets", targetId, message, severity: "error" as const, blockingActions: ["generate"],
        })));
        if (missingMedia.length) throw new ProductionValidationError(missingMedia);
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
            nextDraft = structuredClone(current.draft);
            const [kind, ...parts] = selectedTargets[0].split(":");
            const targetId = parts.join(":");
            const targetKind = kind === "segment" ? "segment" as const : kind === "frame" ? "keyframe" as const : "asset" as const;
            const sameWork = director.workflow.currentWork?.workId === input.workId ? director.workflow.currentWork : undefined;
            nextDraft.director!.workflow.currentWork = { ...(sameWork || {}), workId: input.workId, module: targetKind === "segment" ? "model" : "assets", action: "produce", targetKind, targetId,
                runId: input.runId, inputRevision: current.revision + 1, sourceHash: director.sourceHash };
        }
        return { selectedTargets, plan, workflow: director.workflow, runSettings: current.draft.settings, nextDraft, director, executionSnapshot };
    }

    private batchCandidate(episodeId: string, current: ProductionRecord, input: DirectorRunStart) {
            if (input.inputBasis === "canvas") return this.canvasBatchCandidate(episodeId, current, input);
            // 乐观锁放行（last-write-wins）：客户端过期 revision 不再拦截，版本号继续自增。
            if (current.publishedVersion !== input.version || !current.published?.director) throw new Error("请先发布当前 Acheng 制作稿");
            this.assertCurrentDirectorFormat(current.published.director);
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
            const missing = selectedTargets.filter(id => !targets.has(id));
            for (const targetId of missing) diagnostics.push({ code: "TARGET_NOT_FOUND", path: "request.targets", targetId, message: `生产目标不存在：${targetId}`, severity: "error" });
            const selectedTargetSet = new Set(selectedTargets);
            const activeBatches = this.listBatches(episodeId).filter(batch => ["pending", "running", "paused", "awaiting_review"].includes(batch.status));
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

    startBatch(episodeId: string, raw: unknown): ProductionBatch | Promise<ProductionBatch> {
        const linked = this.linked(episodeId); if (linked) return linked.service.startBatch(linked.id, raw);
        const input = directorRunStartSchema.parse(raw);
        const requestHash = batchRequestHash(input);
        const existing = this.prepare("SELECT * FROM episode_production_batches WHERE episode_id=? AND idempotency_key=?").get(episodeId, input.idempotencyKey) as Record<string, any> | undefined;
        if (existing) {
            if (existing.request_hash !== requestHash) throw new Error("idempotencyKey 已用于不同生产范围");
            return this.batchFromRow(existing);
        }
        const validationBase = this.get(episodeId);
        if (validationBase.archivedAt) throw new ProductionArchivedError(episodeId);
        assertSingleSourceStorage(validationBase);
        const prepared = this.batchCandidate(episodeId, validationBase, input);
        const shouldValidateSource = Boolean(prepared.director && this.checkEngine === assertDirectorEngine);
        if (prepared.director && !shouldValidateSource) this.checkEngine(prepared.director.engine);
        const commitPrepared = () => {
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const prior = this.prepare("SELECT * FROM episode_production_batches WHERE episode_id=? AND idempotency_key=?").get(episodeId, input.idempotencyKey) as Record<string, any> | undefined;
            if (prior) {
                if (prior.request_hash !== requestHash) throw new Error("idempotencyKey 已用于不同生产范围");
                this.db.db.exec("COMMIT");
                return this.batchFromRow(prior);
            }
            const current = this.get(episodeId);
            if (current.revision !== validationBase.revision) throw new ProductionConflictError(current);
            if (current.archivedAt) throw new ProductionArchivedError(episodeId);
            for (const active of this.listBatches(episodeId)) if (["pending", "running", "paused", "awaiting_review"].includes(active.status) && active.targets.some(target => prepared.selectedTargets.includes(target))) {
                throw new ProductionValidationError([{ code: "TARGET_OCCUPIED", path: "targets", message: `目标已由运行 ${active.runId} 占用`, severity: "error", blockingRun: { runId: active.runId, status: active.status, taskIds: active.submitted.map(item => item.taskId) } }]);
            }
            if (prepared.executionSnapshot && this.db.getCanvasProjectRevision(prepared.executionSnapshot.canvasId) !== prepared.executionSnapshot.canvasRevision) throw new Error("画布版本已变化，请重新预检生产批次");
            const { selectedTargets, plan, workflow, runSettings, nextDraft, director, executionSnapshot } = prepared;
            const now = new Date().toISOString();
            const productionRevision = nextDraft ? current.revision + 1 : current.revision;
            if (nextDraft) this.prepare("UPDATE episode_productions SET revision=?, draft_json=?, updated_at=? WHERE episode_id=?")
                .run(productionRevision, JSON.stringify(withoutDirectorProjection(nextDraft)), now, episodeId);
            this.prepare("INSERT INTO episode_production_batches (run_id, episode_id, idempotency_key, request_hash, version, source_revision, status, targets_json, plan_json, engine_json, settings_json, submitted_json, error, pause_requested, created_at, updated_at, execution_snapshot_json) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, '[]', NULL, 0, ?, ?, ?)")
                .run(input.runId, episodeId, input.idempotencyKey, requestHash, input.version, current.revision, JSON.stringify(selectedTargets), JSON.stringify(plan), JSON.stringify(director.engine), JSON.stringify({ ...runSettings, workflow: { ...workflow, runScope: input.scope, currentWorkId: input.workId } }), now, now, executionSnapshot ? JSON.stringify(executionSnapshot) : null);
            const created = this.getBatch(episodeId, input.runId);
            if (!created) throw new Error("生产批次未被当前制作对象持久化");
            this.db.db.exec("COMMIT");
            this.events?.publish({ type: "drama-production.updated", entityId: episodeId, payload: { revision: productionRevision, publishedVersion: input.version, runId: input.runId, status: created!.status } });
            return created!;
        } catch (error) { try { this.db.db.exec("ROLLBACK"); } catch { /* Preserve the original failure after a completed transaction. */ } throw error; }
        };
        if (shouldValidateSource) return this.validateSource(prepared.director!, "generate").then(commitPrepared);
        return commitPrepared();
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
            if (["succeeded", "failed", "retired"].includes(batch.status)) { this.db.db.exec("COMMIT"); return batch; }
            if (!["paused", "awaiting_review"].includes(batch.status)) throw new Error("只能结束已暂停或待审核的历史批次");
            for (const item of batch.submitted) {
                const task = this.db.getTask(item.taskId);
                if (!task || !["succeeded", "failed", "cancelled"].includes(task.status)) throw new Error(`批次仍有在途或未知任务：${item.taskId}`);
            }
            const run = this.batchForRun(episodeId, runId);
            if (!run) throw new Error(`找不到生产运行 ${runId}`);
            this.updateBatch(run, { status: "retired", pauseRequested: false, error: `用户结束历史批次：${reason}` });
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
        if (this.get(episodeId).archivedAt) throw new ProductionArchivedError(episodeId);
        const settings = batch.settings;
        if (batch.executionSnapshot) {
            this.prepare("UPDATE episode_production_batches SET status='pending', pause_requested=0, settings_json=?, updated_at=? WHERE episode_id=? AND run_id=?").run(JSON.stringify(settings), new Date().toISOString(), episodeId, runId);
            return this.getBatch(episodeId, runId)!;
        }
        const currentProduction = this.get(episodeId);
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
        this.prepare("UPDATE episode_production_batches SET status='pending', version=?, targets_json=?, plan_json=?, settings_json=?, pause_requested=0, error=NULL, updated_at=? WHERE episode_id=? AND run_id=?")
            .run(currentProduction.publishedVersion, JSON.stringify(targets), JSON.stringify(plan), JSON.stringify(settings), new Date().toISOString(), episodeId, runId);
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
        const snapshot = episodeProductionHistoryDataSchema.parse(JSON.parse(row.snapshot_json)) as EpisodeProductionData;
        if (snapshot.director && !isSubjectPromptAssembly(snapshot.director.source)) throw new ProductionValidationError([{ code: "UNSUPPORTED_PRODUCTION_FORMAT", path: "version.snapshot.director.source", message: "旧版发布快照只能通过生产源稿维护命令检查。", severity: "error" }]);
        return { version: row.version, stage: row.stage, snapshot, impact: JSON.parse(row.impact_json) as ProductionImpact, createdAt: row.created_at };
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

    private defaultMissingShotTimeline(source: Record<string, any>) {
        if (source.ledger?.contract_version !== 2 || !Array.isArray(source.shots)) return false;
        const ledger = source.ledger as Record<string, any>;
        let changed = false;
        let timelineRows = clipRows(ledger.timelines);
        if (!timelineRows.some(row => String(row.id || "") === "main")) {
            if (!timelineRows.length) { ledger.timelines = [{ id: "main", start_frame: 0 }]; timelineRows = clipRows(ledger.timelines); changed = true; }
        }
        const timelineIds = timelineRows.map(row => String(row.id || "")).filter(Boolean);
        const defaultTimelineId = timelineIds.includes("main") ? "main" : timelineIds[0] || "main";
        const nextOrder = new Map<string, number>(), occupied = new Map<string, Set<number>>();
        for (const shot of clipRows(source.shots)) {
            const timelineId = String(shot.timeline_id || defaultTimelineId);
            if (shot.timeline_id !== timelineId) { shot.timeline_id = timelineId; changed = true; }
            const used = occupied.get(timelineId) || new Set<number>();
            let storyOrder = Number.isInteger(shot.story_order) && shot.story_order >= 0 ? Number(shot.story_order) : nextOrder.get(timelineId) || 0;
            if (!Number.isInteger(shot.story_order) || shot.story_order < 0) {
                while (used.has(storyOrder)) storyOrder += 1;
                shot.story_order = storyOrder; changed = true;
            }
            used.add(storyOrder); occupied.set(timelineId, used);
            nextOrder.set(timelineId, Math.max(nextOrder.get(timelineId) || 0, storyOrder + 1));
        }
        return changed;
    }

    private simulateEditedCandidate(episodeId: string, input: ProductionEdit, sceneRuntime = false, overwriteCompiledPromptTargets?: ReadonlySet<string>) {
        const canvasCommits: CanvasCommit[] = [];
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.get(episodeId);
            if (current.archivedAt) throw new ProductionArchivedError(episodeId);
            if (input.expectedRevision > current.revision) throw new ProductionConflictError(current);
            assertSingleSourceStorage(current);
            this.ensureSourceLifecycleBaseline(episodeId, current);
            const candidate = this.editedCandidate(episodeId, current, input, canvasCommits, sceneRuntime, undefined, overwriteCompiledPromptTargets);
            this.db.db.exec("ROLLBACK");
            return candidate;
        } catch (error) { try { this.db.db.exec("ROLLBACK"); } catch { /* Preserve the simulation failure. */ } throw error; }
    }

    private editedCandidate(episodeId: string, record: ProductionRecord, input: ProductionEdit, canvasCommits?: CanvasCommit[], sceneRuntime = false, onStage?: (name: string, durationMs: number) => void, overwriteCompiledPromptTargets?: ReadonlySet<string>) {
            const measure = <T>(name: string, action: () => T): T => {
                const startedAt = performance.now();
                try { return action(); }
                finally { onStage?.(name, Math.round(performance.now() - startedAt)); }
            };
            const draft = measure("candidate_draft_clone", () => structuredClone(record.draft));
            const published = record.published ? measure("candidate_published_clone", () => structuredClone(record.published)) : null;
            const allowMissingSourceEntityCreate = input.expectedRevision >= record.revision;
            const deferredProjectionOps = new Set(["patch_director_source", "set_director_shot_keyframes", "set_director_shot_utterances"]);
            let directorProjectionDirty = false, lastProjectionOperation = -1;
            const flushDirectorProjection = () => {
                if (!directorProjectionDirty) return;
                const operation = input.ops[lastProjectionOperation];
                try { measure("deferred_director_projection", () => projectDirector(draft)); }
                catch (error) {
                    if (error instanceof ProductionValidationError) throw error;
                    console.error("[edit-op-error] op=", operation?.type, "index=", lastProjectionOperation, "msg=", error instanceof Error ? error.message : String(error), "\nSTACK=", error instanceof Error ? (error.stack || "") : "");
                    throw new ProductionValidationError([{ code: "INVALID_OPERATION", path: `request.ops.${lastProjectionOperation}`, targetId: operation && "id" in operation ? String(operation.id) : undefined, message: error instanceof Error ? error.message : String(error), severity: "error" }]);
                }
                directorProjectionDirty = false;
            };
            for (const [index, operation] of input.ops.entries()) {
                try {
                const lifecycleDelete = operation.type === "delete_director_asset" ? { entity: "asset" as const, id: String(operation.id || "") }
                    : operation.type === "delete_director_clip" ? { entity: "segment" as const, id: operation.segmentId }
                    : operation.type === "archive_director_scene" ? { entity: "scene" as const, id: operation.sceneId }
                    : operation.type === "edit_director_shot" && operation.action === "delete" ? { entity: "shot" as const, id: operation.shotId }
                    : operation.type === "remove_shared_director_asset" ? { entity: "asset" as const, id: String(operation.id || "") } : undefined;
                if (lifecycleDelete?.id && this.ignoreStaleSourceDelete(episodeId, record.revision, input.expectedRevision, lifecycleDelete.entity, lifecycleDelete.id)) continue;
                if (operation.type === "patch_director_source" && operation.id && !allowMissingSourceEntityCreate && draft.director) {
                    this.restoreSourceEntityFromLifecycle(episodeId, record.revision, input.expectedRevision, draft.director, operation.entity, operation.id);
                }
                const deferProjection = deferredProjectionOps.has(operation.type);
                if (directorProjectionDirty && !deferProjection) flushDirectorProjection();
                measure(`operation_${operation.type}`, () => {
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
                } else if (operation.type === "delete_director_asset") {
                    const active = this.listBatches(episodeId).find(batch => ["pending", "running", "paused", "awaiting_review"].includes(batch.status) && batch.targets.includes(`asset:${operation.id}`));
                    if (active) throw new Error(`ASSET_RUN_ACTIVE: 资产正被生产批次 ${active.runId} 使用`);
                    this.apply(episodeId, draft, operation, record.publishedVersion, canvasCommits, deferProjection, allowMissingSourceEntityCreate, overwriteCompiledPromptTargets, sceneRuntime);
                } else this.apply(episodeId, draft, operation, record.publishedVersion, canvasCommits, deferProjection, allowMissingSourceEntityCreate, overwriteCompiledPromptTargets, sceneRuntime);
                });
                if (deferProjection) { directorProjectionDirty = true; lastProjectionOperation = index; }
                } catch (error) {
                    if (error instanceof ProductionValidationError) throw error;
                    if ((error as { code?: string })?.code === "BASE_HISTORY_UNAVAILABLE") throw error;
                    console.error("[edit-op-error] op=", operation?.type, "index=", index, "msg=", error instanceof Error ? error.message : String(error), "\nSTACK=", error instanceof Error ? (error.stack || "") : "");
                    throw new ProductionValidationError([{ code: "INVALID_OPERATION", path: `request.ops.${index}`, targetId: "id" in operation ? String(operation.id) : undefined, message: error instanceof Error ? error.message : String(error), severity: "error" }]);
                }
            }
            flushDirectorProjection();
            const hasRequiredKeyframePolicy = draft.director && measure("required_keyframe_policy", () => defaultRequiredShotKeyframes(draft.director!.source));
            if (hasRequiredKeyframePolicy && draft.director) {
                draft.director.sourceHash = directorHash(draft.director.source);
                draft.director.executionAuthorized = false;
                draft.director.artifacts = draft.director.artifacts.map(artifact => ({ ...artifact, status: "stale" as const }));
                if (draft.director.workflow.currentWork) draft.director.workflow.currentWork = { ...draft.director.workflow.currentWork, sourceHash: draft.director.sourceHash };
            }
            const previousSource = record.draft.director?.source;
            const hasLegacyTimelineBackfill = draft.director && measure("legacy_timeline_backfill", () => (!record.draft.director || fingerprint(previousSource) !== fingerprint(draft.director!.source))
                && this.defaultMissingShotTimeline(draft.director!.source as Record<string, any>));
            if (hasLegacyTimelineBackfill && draft.director) {
                draft.director.sourceHash = directorHash(draft.director.source);
                draft.director.executionAuthorized = false;
                draft.director.artifacts = draft.director.artifacts.map(artifact => ({ ...artifact, status: "stale" as const }));
                if (draft.director.workflow.currentWork) draft.director.workflow.currentWork = { ...draft.director.workflow.currentWork, sourceHash: draft.director.sourceHash };
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
            const previousDirector = measure("workflow_provenance_check", () => {
                const previousDirector = record.draft.director && structuredClone(record.draft.director);
                if (previousDirector) {
                    preserveCompilationProvenance(previousDirector);
                    for (const [workId, work] of Object.entries(draft.director?.workflow.sceneWorks || {})) {
                        const prior = previousDirector.workflow.sceneWorks?.[workId];
                        if (prior && !work.inputEngine) work.inputEngine = prior.inputEngine;
                    }
                }
                if (!sceneRuntime && fingerprint({ works: draft.director?.workflow.sceneWorks, review: draft.director?.workflow.sharedReview, sharedWorks: draft.director?.workflow.sharedReviewWorks, sharedAssets: draft.director?.workflow.sharedAssetReviews, sharedContinuation: draft.director?.workflow.sharedReviewContinuation }) !== fingerprint({ works: previousDirector?.workflow.sceneWorks, review: record.draft.director?.workflow.sharedReview, sharedWorks: record.draft.director?.workflow.sharedReviewWorks, sharedAssets: record.draft.director?.workflow.sharedAssetReviews, sharedContinuation: record.draft.director?.workflow.sharedReviewContinuation })) throw new Error("SCENE_RUNTIME_OWNED: 场次工作与审核记录只能通过场次协调服务更新");
                return previousDirector;
            });
            measure("graph_validation", () => this.validateGraph(draft));
            for (const operation of input.ops) if (operation.type === "review_keyframe") {
                const link = published?.keyframes[operation.shotId];
                if (!link || link.sourceVersion !== record.publishedVersion || fingerprint(link) !== fingerprint(draft.keyframes[operation.shotId])) throw new Error("关键帧已不是当前发布版本的媒体，不能自动通过");
                published!.keyframeReviews[operation.shotId] = draft.keyframeReviews[operation.shotId];
            }
           if (draft.director) {
                if (record.draft.director && isSubjectPromptAssembly(draft.director.source)) {
                    const diagnostics = measure("model_prompt_text_validation", () =>
                        changedModelTextIdDiagnostics(record.draft.director!.source, draft.director!.source));
                    if (diagnostics.length) throw new ProductionValidationError(diagnostics);
                }
                measure("subject_entity_ownership", () => this.validateSubjectEntityOwnership(episodeId, draft.director!));
               const projectId = this.episodeInfo(episodeId).canvasId;
                if (projectId) measure("shared_asset_validation", () => validateSharedAssetPlanSources(this.db, projectId, draft.director!, true));
            }
            return { draft, published };
    }

    private ensureSourceLifecycleBaseline(episodeId: string, record: ProductionRecord) {
        const floor = this.db.db.prepare("SELECT revision FROM production_source_lifecycle_floors WHERE owner_kind=? AND owner_id=?")
            .get(this.ownerKind, episodeId) as { revision: number } | undefined;
        if (floor) return;
        this.db.db.prepare("INSERT INTO production_source_lifecycle_floors(owner_kind,owner_id,revision) VALUES(?,?,?)")
            .run(this.ownerKind, episodeId, record.revision);
        for (const item of sourceLifecycleEntries(record.draft.director?.source)) {
            this.db.db.prepare(`INSERT OR IGNORE INTO production_source_lifecycle_events
                (owner_kind,owner_id,entity_type,entity_id,revision,generation,state,snapshot_json,operation_id,created_at)
                VALUES(?,?,?,?,?,1,'alive',?,'baseline',?)`)
                .run(this.ownerKind, episodeId, item.entityType, item.entityId, record.revision, JSON.stringify(item.value), new Date().toISOString());
        }
    }

    private lifecycleEvent(episodeId: string, entity: string, id: string, atRevision?: number) {
        const row = atRevision === undefined
            ? this.db.db.prepare(`SELECT revision,generation,state,snapshot_json FROM production_source_lifecycle_events
                WHERE owner_kind=? AND owner_id=? AND entity_type=? AND entity_id=? ORDER BY revision DESC LIMIT 1`).get(this.ownerKind, episodeId, entity, id)
            : this.db.db.prepare(`SELECT revision,generation,state,snapshot_json FROM production_source_lifecycle_events
                WHERE owner_kind=? AND owner_id=? AND entity_type=? AND entity_id=? AND revision<=? ORDER BY revision DESC LIMIT 1`).get(this.ownerKind, episodeId, entity, id, atRevision);
        return row as { revision: number; generation: number; state: "alive" | "deleted"; snapshot_json: string | null } | undefined;
    }

    private restoreSourceEntityFromLifecycle(episodeId: string, currentRevision: number, baseRevision: number,
        director: NonNullable<EpisodeProductionData["director"]>, entity: string, id: string) {
        const collection = sourceLifecycleCollection(entity);
        if (!collection) return;
        const source = director.source as Record<string, unknown>;
        const items = Array.isArray(source[collection]) ? source[collection] as Array<Record<string, unknown>> : [];
        const fieldId = (item: Record<string, unknown>) => String(item.id || item.scene_id || item.asset_id || "");
        if (items.some(item => fieldId(item) === id)) return;
        const floor = this.db.db.prepare("SELECT revision FROM production_source_lifecycle_floors WHERE owner_kind=? AND owner_id=?")
            .get(this.ownerKind, episodeId) as { revision: number } | undefined;
        const base = this.lifecycleEvent(episodeId, entity, id, baseRevision);
        const latest = this.lifecycleEvent(episodeId, entity, id);
        if (!floor || baseRevision < floor.revision || base?.state !== "alive" || latest?.state !== "deleted" || !latest.snapshot_json) {
            throw Object.assign(new Error(`BASE_HISTORY_UNAVAILABLE: ${entity} ${id} 已删除，且请求基线无法恢复；本地草稿已保留`),
                { code: "BASE_HISTORY_UNAVAILABLE", conflictTargets: [`${entity}:${id}`], currentRevision });
        }
        items.push(JSON.parse(latest.snapshot_json) as Record<string, unknown>);
        source[collection] = items;
    }

    private ignoreStaleSourceDelete(episodeId: string, currentRevision: number, baseRevision: number, entity: string, id: string) {
        if (baseRevision >= currentRevision) return false;
        const floor = this.db.db.prepare("SELECT revision FROM production_source_lifecycle_floors WHERE owner_kind=? AND owner_id=?")
            .get(this.ownerKind, episodeId) as { revision: number } | undefined;
        const base = this.lifecycleEvent(episodeId, entity, id, baseRevision);
        const latest = this.lifecycleEvent(episodeId, entity, id);
        if (!floor || baseRevision < floor.revision || !base) {
            throw Object.assign(new Error(`BASE_HISTORY_UNAVAILABLE: ${entity} ${id} 的生命周期历史不足，删除草稿已保留`),
                { code: "BASE_HISTORY_UNAVAILABLE", conflictTargets: [`${entity}:${id}`], currentRevision });
        }
        if (base.state === "deleted" || !latest || latest.state === "deleted" || latest.generation !== base.generation) return true;
        return false;
    }

    private recordSourceLifecycleChanges(episodeId: string, before?: Record<string, unknown>, after?: Record<string, unknown>, revision?: number, operationId = "") {
        if (revision === undefined) return;
        const previous = new Map(sourceLifecycleEntries(before).map(item => [`${item.entityType}\0${item.entityId}`, item.value]));
        const next = new Map(sourceLifecycleEntries(after).map(item => [`${item.entityType}\0${item.entityId}`, item.value]));
        const keys = new Set([...previous.keys(), ...next.keys()]);
        for (const compound of keys) {
            const split = compound.indexOf("\0"), entityType = compound.slice(0, split), entityId = compound.slice(split + 1);
            const oldValue = previous.get(compound), newValue = next.get(compound);
            if (oldValue && newValue) continue;
            const latest = this.lifecycleEvent(episodeId, entityType, entityId);
            const generation = newValue
                ? latest?.state === "deleted" ? latest.generation + 1 : latest?.generation || 1
                : latest?.generation || 1;
            this.db.db.prepare(`INSERT INTO production_source_lifecycle_events
                (owner_kind,owner_id,entity_type,entity_id,revision,generation,state,snapshot_json,operation_id,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?)`).run(this.ownerKind, episodeId, entityType, entityId, revision, generation,
                    newValue ? "alive" : "deleted", JSON.stringify(newValue || oldValue), operationId, new Date().toISOString());
        }
    }


    /** One-time, source-only migration hook. Remove after the authorized target draft is upgraded. */
    async migrateSubjectPromptV2(episodeId: string, expectedRevision: number, operationId: string, source: Record<string, unknown>) {
        const requestHash = fingerprint({ type: "migrate_subject_prompt_v2", episodeId, expectedRevision, source });
        const replay = this.replayOperationReceipt(episodeId, operationId, requestHash);
        if (replay) return replay;
        const validationBase = this.get(episodeId, true);
        const racedReplay = this.replayOperationReceipt(episodeId, operationId, requestHash);
        if (racedReplay) return racedReplay;
        if (!validationBase.draft.director) throw new Error("缺少当前 Acheng Director 制作稿");
        if (isSubjectPromptAssembly(validationBase.draft.director.source)) throw new Error("制作稿已经使用 Subject Prompt Assembly v2");
        const validatedDirector = structuredClone(validationBase.draft.director);
        validatedDirector.source = structuredClone(source);
        validatedDirector.sourceHash = directorHash(validatedDirector.source);
        try { await this.validateSource(validatedDirector, "edit"); }
        catch (error) {
            const racedReplay = this.replayOperationReceipt(episodeId, operationId, requestHash);
            if (racedReplay) return racedReplay;
            throw error;
        }
        return this.commit(episodeId, operationId, expectedRevision, requestHash, current => {
            if (current.revision !== validationBase.revision) throw new ProductionConflictError(current);
            if (!current.draft.director) throw new Error("缺少当前 Acheng Director 制作稿");
            if (isSubjectPromptAssembly(current.draft.director.source)) throw new Error("制作稿已经使用 Subject Prompt Assembly v2");
            const draft = structuredClone(current.draft);
            const director = draft.director!;
            director.source = structuredClone(source);
            director.sourceHash = directorHash(director.source);
            this.validateSubjectEntityOwnership(episodeId, director);
            projectDirector(draft);
            this.validateGraph(draft);
            return { ...current, revision: current.revision + 1, draft, updatedAt: new Date().toISOString() };
        }, { maintenanceLegacyRead: true, allowArchived: true });
    }

    edit(episodeId: string, raw: unknown, canvasPreparation?: { projectId: string; expectedCanvasRevision: number; operationId: string; operations: CanvasOperation[] }, sceneRuntime = false, beforeCommit?: (record: ProductionRecord) => void, onStage?: (name: string, durationMs: number) => void, overwriteCompiledPromptTargets?: ReadonlySet<string>): ProductionRecord & { replayed?: boolean; impact?: ProductionImpact } | Promise<ProductionRecord & { replayed?: boolean; impact?: ProductionImpact }> {
        const linked = this.linked(episodeId); if (linked) return linked.service.edit(linked.id, raw, canvasPreparation, sceneRuntime, beforeCommit, onStage, overwriteCompiledPromptTargets);
        const input = productionEditSchema.parse(raw);
        const shotDependencyFreeEdit = input.ops.length > 0 && input.ops.every(operation => operation.type === "set_director_shot_utterances"
            || operation.type === "patch_director_source" && operation.entity === "shot"
                && !["subject_usages", "keyframes", "reference_requirements"].some(field => Object.hasOwn(operation.patch, field)));
        const shotProjectionIds = (() => {
            if (!input.ops.length) return undefined;
            const ids = new Set<string>();
            let hasSubjectBindingEdit = false;
            for (const operation of input.ops) {
                if (operation.type === "patch_director_source" && operation.entity === "shot" && operation.id) ids.add(operation.id);
                else if (operation.type === "set_director_shot_keyframes" || operation.type === "set_director_shot_utterances") ids.add(operation.shotId);
                else if (operation.type === "request_director_shot_refresh") for (const shotId of operation.shotIds) ids.add(shotId);
                else if (operation.type === "request_director_clip_refresh") continue;
                else if (operation.type === "upsert_director_subject") hasSubjectBindingEdit = true;
                else return undefined;
            }
            return ids.size || hasSubjectBindingEdit ? ids : undefined;
        })();
        const refreshes = input.ops.filter(op => op.type === "request_director_clip_refresh" || op.type === "request_director_shot_refresh");
        const refreshTargetIds = refreshes.flatMap(op => op.type === "request_director_clip_refresh" ? [op.segmentId] : []);
        const refreshShotIds = refreshes.flatMap(op => op.type === "request_director_shot_refresh" ? op.shotIds : []);
        if (new Set(refreshTargetIds).size !== refreshTargetIds.length || new Set(refreshShotIds).size !== refreshShotIds.length) throw new ProductionValidationError([{ code: "CLIP_REFRESH_SCOPE", path: "request.ops", message: "同一批返修不能重复登记同一个 Clip 或 Shot", severity: "error" }]);
        if (input.ops.some(operation => operation.type === "restore_archived_scene_results") && input.ops.length !== 1) throw new Error("归档视频恢复必须单独提交，不能与其他制作编辑混批");
        // 归档状态是记录级开关：必须单独提交，不能与其他编辑或采纳混批，也不触发重编译或画布重投影。
        const archiveOp = input.ops.length === 1 && input.ops[0].type === "set_archived" ? input.ops[0] : undefined;
        if (input.ops.some(operation => operation.type === "set_archived") && (!archiveOp || input.adoptions)) throw new Error("归档状态必须单独提交，不能与其他制作编辑或采纳混批");
        const forceBoundaryTargets = new Set(input.ops.filter((operation): operation is Extract<ProductionOperation, { type: "set_director_boundary" }> => operation.type === "set_director_boundary").map(operation => operation.boundary.from));
        const measure = <T>(name: string, action: () => T): T => {
            const startedAt = performance.now();
            try { return action(); }
            finally { onStage?.(name, Math.round(performance.now() - startedAt)); }
        };
        const canvasCommits: CanvasCommit[] = [];
        const adoptedTasks: Array<{ taskId: string; result: Record<string, unknown> }> = [];
        const requestHash = overwriteCompiledPromptTargets?.size
            ? fingerprint({ input, overwriteCompiledPromptTargets: [...overwriteCompiledPromptTargets].sort() }) : fingerprint(input);
        const shouldValidateSource = !sceneRuntime && !archiveOp && this.checkEngine === assertDirectorEngine;
        let validatedDirectorFingerprint: string | null | undefined;
        const mutate = (record: ProductionRecord) => {
            if (archiveOp) return { ...record, revision: record.revision + 1, archivedAt: archiveOp.archived ? record.archivedAt || new Date().toISOString() : null, updatedAt: new Date().toISOString() };
            const packets: DirectorWorkPackage[] = [];
            if (input.adoptions) {
                if (new Set(input.adoptions.map(item => item.taskId)).size !== input.adoptions.length) throw new Error("ADOPTION_DUPLICATE");
                if (input.ops.some(op => !["patch_director_source", "set_director_production"].includes(op.type))) throw new Error("ADOPTION_PROTECTED_OPERATION: 采纳只允许创作源稿编辑");
                for (const adoption of input.adoptions) {
                    const task = this.db.getTask(adoption.taskId), packet = task?.input.workPackage as DirectorWorkPackage | undefined;
                    const output = task?.result;
                    if (!task || task.kind !== DIRECTOR_SUBAGENT_KIND || !packet || packet.projectId !== this.episodeInfo(episodeId).canvasId
                        || (packet.owner.kind === "episode" ? packet.owner.id !== episodeId : packet.owner.id !== packet.projectId)) throw new Error("ADOPTION_OWNER_MISMATCH: 任务未绑定当前正式稿");
                    if (task.status !== "succeeded" || output?.status !== "complete" || !Array.isArray(output.unresolved) || output.artifactHash !== adoption.artifactHash) throw new Error("ADOPTION_INCOMPLETE: 产物未完整或身份不符");
                    const artifact = (output.artifacts as Array<Record<string, any>> | undefined)?.find(item => item.artifactHash === adoption.artifactHash);
                    if (!artifact || directorArtifact(packet.inputHash, packet.runtimeId, artifact.output, packet.contractHash).artifactHash !== adoption.artifactHash) throw new Error("ADOPTION_ARTIFACT_INVALID");
                    if (output.adoption) throw new Error("ADOPTION_ALREADY_APPLIED: 请恢复原 operationId 回执");
                    // The work package is an immutable snapshot for provenance, not an approval lock.
                    // Apply the caller's scoped ops to the latest draft revision; revision concurrency,
                    // owner checks and assertDirectorWorkScope below remain authoritative.
                    if (!record.draft.director) throw new Error("ADOPTION_SOURCE_MISSING");
                    packets.push(packet); adoptedTasks.push({ taskId: task.id, result: output });
                }
            }
            const { draft, published } = this.editedCandidate(episodeId, record, input, canvasCommits, sceneRuntime, onStage, overwriteCompiledPromptTargets);
            if (draft.director && !shouldValidateSource) this.checkEngine(draft.director.engine);
            if (validatedDirectorFingerprint !== undefined && (draft.director ? fingerprint(draft.director) : null) !== validatedDirectorFingerprint) throw new Error("SOURCE_CHANGED_DURING_VALIDATION: 制作依赖在异步校验期间变化，请重试");
            if (record.draft.director && draft.director) {
                preserveH3ArtifactsAfterShotDurationOnlyEdit(record.draft.director, draft.director);
            }
            stripLegacySharedAssetPointers(draft.director);
            for (const operation of input.ops) if (operation.type === "set_director_shot_utterances") {
                for (const utterance of operation.utterances) {
                    if (!utterance.utteranceId || utterance.delivery === undefined) continue;
                    const saved = clipRows(draft.director?.source.utterances).find(row => String(row.id || "") === utterance.utteranceId);
                    if (!saved || saved.delivery !== utterance.delivery) throw new ProductionValidationError([{ code: "WRITE_VERIFICATION_FAILED", path: `utterances.${utterance.utteranceId}.delivery`, targetId: utterance.utteranceId, message: "对白指导未能按请求写入；本次制作编辑已回滚", severity: "error" }]);
                }
            }
            if (refreshes.length && record.draft.director && draft.director && isSubjectPromptAssembly(draft.director.source)) {
                const before = record.draft.director, after = draft.director;
                const explicitTargets = refreshes.flatMap(op => op.type === "request_director_clip_refresh" ? [op.segmentId] : []);
                const shotTargets = refreshShotIds;
                const shotResolvedTargets = new Set<string>();
                if (shotTargets.length) {
                    const beforeSegments = clipRows(before.source.segments);
                    const afterSegments = clipRows(after.source.segments);
                    const afterShotIds = new Set(clipRows(after.source.shots).map(shot => String(shot.id || "")));
                    const segmentContainsShot = (segment: Record<string, any>, shotId: string) => Array.isArray(segment.shot_ids) && segment.shot_ids.map(String).includes(shotId);
                    for (const shotId of shotTargets) {
                        if (!afterShotIds.has(shotId)) throw new ProductionValidationError([{ code: "SHOT_REFRESH_TARGET_UNKNOWN", path: `request.ops.shotIds.${shotId}`, targetId: shotId, message: `返修 Shot ${shotId} 不存在于本次提交后的当前源稿`, severity: "error" }]);
                        const currentSegments = afterSegments.filter(segment => segmentContainsShot(segment, shotId));
                        if (currentSegments.length !== 1) throw new ProductionValidationError([{ code: "SHOT_REFRESH_MAPPING_INVALID", path: `request.ops.shotIds.${shotId}`, targetId: shotId, message: `返修 Shot ${shotId} 必须且只能映射到一个当前 Clip`, severity: "error" }]);
                        // Resolve within the same source transaction: include a surviving prior
                        // Clip as well as the current Clip if this edit repartitioned the Shot.
                        const priorIds = beforeSegments.filter(segment => segmentContainsShot(segment, shotId)).map(segment => String(segment.id));
                        for (const segmentId of [...priorIds, ...currentSegments.map(segment => String(segment.id))]) {
                            if (afterSegments.some(segment => String(segment.id) === segmentId)) shotResolvedTargets.add(segmentId);
                        }
                    }
                }
                if (explicitTargets.some(segmentId => shotResolvedTargets.has(segmentId))) throw new ProductionValidationError([{ code: "CLIP_REFRESH_SCOPE", path: "request.ops", message: "Segment 目标与 Shot 目标解析后重叠，不能重复登记同一 Clip", severity: "error" }]);
                const targetIds = [...new Set([...explicitTargets, ...shotResolvedTargets])];
                const changedTargets = measure("clip_refresh_input_hash_comparison", () => targetIds.filter(segmentId => {
                    try {
                        const nextHash = compilationScopeInput(after, clipRefreshScope(segmentId)).inputHash;
                        const priorHash = compilationScopeInput(before, clipRefreshScope(segmentId)).inputHash;
                        return nextHash !== priorHash;
                    } catch { return true; }
                }));
                const store = this.clipRefreshStore(episodeId);
                measure("clip_refresh_binding_resolution", () => {
                    for (const segmentId of changedTargets) {
                        let resolvedAfter = after;
                        try { resolvedAfter = this.resolveSubjectPictureInputs(episodeId, after, [segmentId], true); } catch { /* Saving the draft is allowed; the refresh job will report the unresolved source. */ }
                        store.register(input.operationId, record.revision + 1, before, resolvedAfter, segmentId);
                    }
                });
            } else if (refreshes.length) {
                if (refreshes.some(op => op.type === "request_director_shot_refresh")) throw new Error("SHOT_REFRESH_REQUIRES_V2: 按稳定 Shot 身份返修仅支持 Prompt Assembly v2");
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
            if (published && input.ops.some((operation) => operation.type === "review_keyframe" || operation.type === "review_director_asset")) this.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?").run(JSON.stringify(withoutDirectorProjection(published)), episodeId, record.publishedVersion);
            return { ...record, revision: record.revision + 1, draft, published, updatedAt: new Date().toISOString() };
        };
        const commitOptions: Parameters<EpisodeProductionService["commitCore"]>[5] = {
            beforeMutation: canvasPreparation ? (record, commits) => {
                if (canvasPreparation) {
                    const ownerCanvasId = this.episodeInfo(episodeId).canvasId;
                    if (ownerCanvasId !== canvasPreparation.projectId) throw new Error("布局准备画布不属于当前制作对象");
                    if (this.db.getCanvasProjectRevision(canvasPreparation.projectId) !== canvasPreparation.expectedCanvasRevision) throw new Error("画布版本已变化，按同一 operationId 回读并恢复布局准备");
                    if (canvasPreparation.operations.length) this.db.applyCanvasProjectOperations(canvasPreparation.projectId, canvasPreparation.expectedCanvasRevision, canvasPreparation.operations, {
                        operationId: canvasPreparation.operationId, runtimeWrite: true, withinTransaction: true, deferredCommits: commits, source: { kind: "system", clientId: "production:layout", label: "准备制作布局" },
                    });
                }
            } : undefined,
            beforeCommit: record => {
                for (const task of adoptedTasks) this.db.updateTask(task.taskId, { result: { ...task.result, adoption: directorAdoption(input.operationId, record.revision, record.draft.director!.sourceHash, input.ops, String(task.result.artifactHash)) } });
                beforeCommit?.(record);
            },
            onStage,
            shotProjectionIds: input.ops.some(op => op.type === "upsert_director_subject") && shotProjectionIds
                ? (current, next) => {
                    const currentSource = current.draft.director?.source as Record<string, any> | undefined;
                    const nextSource = next.draft.director?.source as Record<string, any> | undefined;
                    if (!currentSource || !nextSource || !isSubjectPromptAssembly(currentSource) || !isSubjectPromptAssembly(nextSource)) return undefined;
                    const changedSubjectIds = new Set<string>();
                    for (const operation of input.ops) {
                        if (operation.type !== "upsert_director_subject") continue;
                        const subjectId = String(operation.subject.id || "");
                        const before = clipRows(currentSource.subject_registry).find(subject => String(subject.id || "") === subjectId);
                        const after = clipRows(nextSource.subject_registry).find(subject => String(subject.id || "") === subjectId);
                        if (!before || !after) return undefined;
                        const withoutPictures = (subject: Record<string, any>) => {
                            const copy = structuredClone(subject);
                            delete copy.pictureBindings;
                            return copy;
                        };
                        // Editing Subject identity/description also updates entity nodes and
                        // keeps the complete projection path. Picture-binding-only changes
                        // can target just the Shots that consume the changed Subject.
                        if (canonicalProduction(withoutPictures(before)) !== canonicalProduction(withoutPictures(after))) return undefined;
                        if (canonicalProduction(before.pictureBindings || []) !== canonicalProduction(after.pictureBindings || [])) changedSubjectIds.add(subjectId);
                    }
                    const ids = new Set(shotProjectionIds);
                    for (const shot of clipRows(nextSource.shots)) {
                        const referencedByUsage = clipRows(shot.subject_usages).some(usage => changedSubjectIds.has(String(usage.subjectId || "")));
                        const referencedByKeyframe = clipRows(shot.keyframes).some(frame =>
                            (Array.isArray(frame.subjectIds) && frame.subjectIds.some((id: unknown) => changedSubjectIds.has(String(id))))
                            || Object.keys(record(frame.subjectPictureBindingIds)).some(id => changedSubjectIds.has(id)));
                        if (referencedByUsage || referencedByKeyframe) ids.add(String(shot.id || ""));
                    }
                    ids.delete("");
                    return ids.size ? ids : undefined;
                }
                : shotProjectionIds,
            shotDependencyFreeEdit: shotDependencyFreeEdit || Boolean(archiveOp), maintenanceLegacyRead: false,
            overwriteCompiledPromptTargets, forceBoundaryTargets, allowArchived: Boolean(archiveOp), skipCanvasProjection: Boolean(archiveOp),
        };
        const commitPrepared = () => {
            const result = this.commit(episodeId, input.operationId, input.expectedRevision, requestHash, mutate, commitOptions);
            canvasCommits.forEach(commit => this.db.notifyCanvasCommit(commit));
            if (refreshes.length) {
                const editRefreshes = this.clipRefreshStore(episodeId).byEditAll(input.operationId);
                if (editRefreshes.length) {
                    (result as any).clipRefreshes = editRefreshes.map(clipRefreshReceipt);
                    if (editRefreshes.length === 1) (result as any).clipRefresh = clipRefreshReceipt(editRefreshes[0]);
                }
            }
            return result;
        };
        if (!shouldValidateSource) return commitPrepared();
        if (this.replayOperationReceipt(episodeId, input.operationId, requestHash)) return commitPrepared();
        const simulate = () => this.simulateEditedCandidate(episodeId, input, sceneRuntime, overwriteCompiledPromptTargets);
        let simulated: ReturnType<typeof simulate>;
        try { simulated = simulate(); }
        catch (error) {
            if (this.replayOperationReceipt(episodeId, input.operationId, requestHash)) return commitPrepared();
            throw error;
        }
        validatedDirectorFingerprint = simulated.draft.director ? fingerprint(simulated.draft.director) : null;
        const validationStarted = performance.now();
        const validation = simulated.draft.director
            ? this.validateSource(simulated.draft.director, "edit", this.sourceShotValidationScope(input.ops))
            : Promise.resolve();
        return validation.catch(error => {
            if (this.replayOperationReceipt(episodeId, input.operationId, requestHash)) return;
            throw error;
        }).finally(() => onStage?.("acheng_source_validation", Math.round(performance.now() - validationStarted))).then(commitPrepared);
    }

    async previewImpact(episodeId: string, stage: "script" | "shots" | "director"): Promise<ProductionImpact> {
        const linked = this.linked(episodeId); if (linked) return linked.service.previewImpact(linked.id, stage);
        const current = this.get(episodeId);
        const candidate = this.publishedCandidate(current, stage);
        if (stage === "director" && candidate.director) await this.validateSource(candidate.director, "publish");
        return this.publicationImpact(current, candidate, episodeId, stage);
    }

    publish(episodeId: string, raw: unknown): ProductionRecord & { replayed?: boolean; impact?: ProductionImpact } | Promise<ProductionRecord & { replayed?: boolean; impact?: ProductionImpact }> {
        const linked = this.linked(episodeId); if (linked) return linked.service.publish(linked.id, raw);
        const input = productionPublishSchema.parse(raw);
        const requestHash = fingerprint(input);
        const replay = this.replayOperationReceipt(episodeId, input.operationId, requestHash);
        if (replay) return replay;
        let validationBase: ProductionRecord;
        let preparedCandidate: EpisodeProductionData;
        try {
            validationBase = this.get(episodeId);
            preparedCandidate = this.publishedCandidate(validationBase, input.stage, input.scope);
        } catch (error) {
            const racedReplay = this.replayOperationReceipt(episodeId, input.operationId, requestHash);
            if (racedReplay) return racedReplay;
            throw error;
        }
        const shouldValidateSource = Boolean(input.stage === "director" && preparedCandidate.director && this.checkEngine === assertDirectorEngine);
        if (input.stage === "director" && preparedCandidate.director && !shouldValidateSource) this.checkEngine(preparedCandidate.director.engine);
        const commitPrepared = () => {
        const result = this.commit(episodeId, input.operationId, input.expectedRevision, requestHash, (record) => {
            if (record.revision !== validationBase.revision) throw new ProductionConflictError(record);
            const candidate = this.publishedCandidate(record, input.stage, input.scope);
            if (fingerprint(candidate) !== fingerprint(preparedCandidate)) throw new Error("SOURCE_CHANGED_DURING_VALIDATION: 发布依赖在异步校验期间变化，请重试");
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
                .run(episodeId, publishedVersion, input.stage, JSON.stringify(withoutDirectorProjection(candidate)), JSON.stringify(impact), updatedAt);
            const draft = structuredClone(record.draft);
            if (input.stage === "director") draft.keyframeReviews = structuredClone(candidate.keyframeReviews);
            if (input.stage !== "script") draft.clipGroups = candidate.clipGroups;
            return { ...record, revision: record.revision + 1, draft, published: candidate, publishedVersion, updatedAt, impact };
        });
        return result;
        };
        if (shouldValidateSource) {
            const director = input.scope && preparedCandidate.director
                ? scopedCompilerInput(compilationScopeInput(preparedCandidate.director, input.scope).director, input.scope)
                : preparedCandidate.director!;
            return this.validateSource(director, "publish").catch(error => {
                const racedReplay = this.replayOperationReceipt(episodeId, input.operationId, requestHash);
                if (racedReplay) return racedReplay;
                throw error;
            }).then(commitPrepared);
        }
        return commitPrepared();
    }

    /** Runtime outcome binding; source content stays at the published version. */
    bindRuntime(episodeId: string, version: number, input: { shotId?: string; groupId?: string; nodeId: string; segmentId?: string; storageKey?: string; completed?: boolean }): ProductionRecord {
        const linked = this.linked(episodeId); if (linked) return linked.service.bindRuntime(linked.id, version, input);
        this.db.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.get(episodeId);
            assertSingleSourceStorage(current);
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
            if (snapshot.director) projectDirector(snapshot);
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
                this.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?").run(JSON.stringify(withoutDirectorProjection(snapshot)), episodeId, version);
                this.projectEquivalentHistoricalResult(episodeId, current, baseline, snapshot, version, input);
                this.db.db.exec("COMMIT");
                this.events?.publish({ type: "drama-production.updated", entityId: episodeId, payload: { publishedVersion: current.publishedVersion, historyVersion: version } });
                return current;
            }
            if (fingerprint(snapshot) === fingerprint(current.published) && fingerprint(draft) === fingerprint(current.draft)) { this.db.db.exec("COMMIT"); return current; }
            const revision = current.revision + 1;
            const updatedAt = new Date().toISOString();
            this.prepare("UPDATE episode_productions SET revision=?, draft_json=?, published_json=?, updated_at=? WHERE episode_id=?")
                .run(revision, JSON.stringify(withoutDirectorProjection(draft)), JSON.stringify(withoutDirectorProjection(snapshot)), updatedAt, episodeId);
            this.prepare("UPDATE episode_production_versions SET snapshot_json=? WHERE episode_id=? AND version=?")
                .run(JSON.stringify(withoutDirectorProjection(snapshot)), episodeId, version);
            this.db.db.exec("COMMIT");
            this.events?.publish({ type: "drama-production.updated", entityId: episodeId, payload: { revision, publishedVersion: version } });
            return { ...current, revision, draft, published: snapshot, updatedAt };
        } catch (error) { this.db.db.exec("ROLLBACK"); throw error; }
    }

    restore(episodeId: string, version: number, operationId: string, expectedRevision: number): ProductionRecord & { replayed?: boolean } {
        const linked = this.linked(episodeId); if (linked) return linked.service.restore(linked.id, version, operationId, expectedRevision);
        const snapshot = this.version(episodeId, version).snapshot;
        if (snapshot.director) this.assertCurrentDirectorFormat(snapshot.director);
        return this.commit(episodeId, operationId, expectedRevision, fingerprint({ version, operationId, expectedRevision }), (record) => {
            const draft = structuredClone(snapshot);
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

    private patchDirectorSource(director: NonNullable<EpisodeProductionData["director"]>, entity: keyof typeof directorPatchFields, id: string | undefined, patch: Record<string, unknown>, allowMissingSourceEntityCreate = true) {
        applyDirectorSourcePatch(director, entity, id, patch, { allowCreate: allowMissingSourceEntityCreate });
    }

    private initializeDirector(data: EpisodeProductionData, brief: string, initialScriptScenes?: Record<string, unknown>[]) {
        const runtime = resolveAchengEngine();
        const source = { version: 2, prompt_assembly: { version: 2 }, brief, fps_num: 24, fps_den: 1,
            script_scenes: initialScriptScenes || [], shots: [], utterances: [], subject_registry: [],
            character_registry: [], scene_registry: initialScriptScenes?.length ? [{ id: String(initialScriptScenes[0].scene_id || initialScriptScenes[0].id), name: String(initialScriptScenes[0].scene_name || initialScriptScenes[0].scene_id || initialScriptScenes[0].id), location: String(initialScriptScenes[0].location || ""), time_of_day: String(initialScriptScenes[0].time_of_day || "") }] : [], asset_plan: [], asset_cards: [], segments: [],
            ledger: { contract_version: 2, facts: [], timelines: [{ id: "main" }], initial: [], events: [], requirements: [], coverage: [] } };
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
        const promptV2 = isSubjectPromptAssembly(director.source);
        const shotWindows = promptV2 ? subjectShotWindows(director.source) : undefined;
        const windowFor = (shot: Record<string, any>) => promptV2
            ? shotWindows?.get(String(shot.id || ""))
            : { startFrame: Number(shot.start_frame), endFrame: Number(shot.end_frame) };
        if (ordered.some((item, index) => index > 0 && windowFor(item)?.startFrame !== windowFor(ordered[index - 1])?.endFrame)) throw new Error("Shot 帧窗不连续；请让 Acheng 重新规划边界");
        const fps = Number(director.source.fps_num || 24) / Number(director.source.fps_den || 1);
        const startFrame = Number(windowFor(ordered[0])?.startFrame), endFrame = Number(windowFor(ordered[ordered.length - 1])?.endFrame);
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
        const patch: Record<string, unknown> = { shot_ids: ordered.map(item => String(item.id)), execution_gate: "Reconfirm mode, references and sound after regrouping" };
        if (promptV2) {
            delete target.start_frame;
            delete target.end_frame;
            delete target.generation_clip_duration;
        } else Object.assign(patch, { start_frame: startFrame, end_frame: endFrame, generation_clip_duration: seconds });
        this.patchDirectorSource(director, "segment", segmentId, patch);
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

    private replayOperationReceipt(episodeId: string, operationId: string, requestHash: string) {
        const prior = this.prepare("SELECT episode_id AS owner_id, request_hash, receipt_json FROM episode_production_operations WHERE operation_id = ?")
            .get(operationId) as { owner_id: string; request_hash: string; receipt_json: StoredReceipt } | undefined;
        if (prior) {
            if (prior.owner_id !== episodeId || prior.request_hash !== requestHash) throw new Error("operationId 已用于不同制作稿操作");
            const replayed = resolveReceiptDedup(decodeReceipt<ProductionRecord & { impact?: ProductionImpact }>(prior.receipt_json));
            replayed.draft = episodeProductionHistoryDataSchema.parse(replayed.draft) as EpisodeProductionData;
            if (replayed.published) replayed.published = episodeProductionHistoryDataSchema.parse(replayed.published) as EpisodeProductionData;
            if (replayed.draft.director && isSubjectPromptAssembly(replayed.draft.director.source)) projectDirector(replayed.draft, false);
            if (replayed.published?.director && isSubjectPromptAssembly(replayed.published.director.source)) projectDirector(replayed.published, false);
            assertPublicReceipt(replayed);
            return { ...replayed, replayed: true };
        }
        const durableKey = this.db.db.prepare("SELECT request_hash FROM production_operation_keys WHERE owner_kind=? AND owner_id=? AND operation_id=?")
            .get(this.ownerKind, episodeId, operationId) as { request_hash: string } | undefined;
        if (durableKey) {
            if (durableKey.request_hash !== requestHash) throw new Error("operationId 已用于不同制作稿操作");
            throw Object.assign(new Error("OPERATION_RECEIPT_UNAVAILABLE: 操作已提交但完整回执已清理；请读取当前制作稿核对，不要重放"), { code: "OPERATION_RECEIPT_UNAVAILABLE", committed: true });
        }
        return null;
    }

    private commitCore(episodeId: string, operationId: string, expectedRevision: number, requestHash: string, mutate: (record: ProductionRecord) => ProductionRecord & { impact?: ProductionImpact }, options: {
        beforeMutation?: (record: ProductionRecord, canvasCommits: CanvasCommit[]) => void;
        beforeCommit?: (record: ProductionRecord) => void;
        onStage?: (name: string, durationMs: number) => void;
        shotProjectionIds?: ReadonlySet<string> | ((current: ProductionRecord, next: ProductionRecord) => ReadonlySet<string> | undefined);
        shotDependencyFreeEdit?: boolean;
        maintenanceLegacyRead?: boolean;
        overwriteCompiledPromptTargets?: ReadonlySet<string>;
        forceBoundaryTargets?: ReadonlySet<string>;
        /** Permit writing an archived production: un-archive edits plus runtime/maintenance write-backs. */
        allowArchived?: boolean;
        /** Record-level edits (archiving) must not recompile and re-project the canvas. */
        skipCanvasProjection?: boolean;
    } = {}) {
        const measure = <T>(name: string, action: () => T): T => {
            const startedAt = performance.now();
            try { return action(); }
            finally { options.onStage?.(name, Math.round(performance.now() - startedAt)); }
        };
        const scriptCommits: CanvasCommit[] = [];
        measure("transaction_begin", () => this.db.db.exec("BEGIN IMMEDIATE"));
        try {
            const { replayed, current } = measure("revision_read", () => {
                const replayed = this.replayOperationReceipt(episodeId, operationId, requestHash);
                if (replayed) return { replayed, current: null as ProductionRecord | null };
                return { replayed: null, current: this.get(episodeId, Boolean(options.maintenanceLegacyRead)) };
            });
            if (replayed) {
                this.db.db.exec("COMMIT");
                return replayed;
            }
            if (!current) throw new Error("制作稿读取失败");
            if (current.archivedAt && !options.allowArchived) throw new ProductionArchivedError(episodeId);
            if (expectedRevision > current.revision) throw new ProductionConflictError(current);
            assertSingleSourceStorage(current);
            this.ensureSourceLifecycleBaseline(episodeId, current);
            // 乐观锁放行（last-write-wins）：客户端过期 revision 不再拦截，版本号继续自增。
            measure("pre_mutation_hook", () => options.beforeMutation?.(current, scriptCommits));
            const finishMutation = (next: ProductionRecord & { impact?: ProductionImpact }) => {
            const shotProjectionIds = typeof options.shotProjectionIds === "function"
                ? options.shotProjectionIds(current, next)
                : options.shotProjectionIds;
            const candidateSource = next.draft.director?.source;
            if (candidateSource && isSubjectPromptAssembly(candidateSource)) {
                const previousSource = current.draft.director?.source;
                const diagnostics = changedModelTextIdDiagnostics(
                    previousSource && isSubjectPromptAssembly(previousSource) ? previousSource : {},
                    candidateSource,
                );
                if (diagnostics.length) throw new ProductionValidationError(diagnostics);
            }
            // BEGIN IMMEDIATE is the write-order linearization point. Always derive the
            // committed revision from the row read under this transaction, never from a
            // caller cursor or a mutation's captured revision.
            next.revision = current.revision + 1;
            this.recordSourceLifecycleChanges(episodeId, current.draft.director?.source, next.draft.director?.source, next.revision, operationId);
            const projectionOperationId = `production:${this.ownerKind}:${episodeId}:${operationId}:projection`;
            let canvasId = options.skipCanvasProjection ? null : this.episode(episodeId).canvasId;
            if (!canvasId && !options.skipCanvasProjection && this.ownerKind === "episode" && next.draft.director && productionEntities(next.draft.director.source, { kind: this.ownerKind, id: episodeId }).length) {
                canvasId = ensureProductionCanvas(this.db, "episode", episodeId, undefined, true).project.id;
            }
            const canvas = canvasId && this.db.getCanvasProject(canvasId);
            if (canvas) {
                if (next.draft.director) {
                    if (this.ownerKind === "episode" && current.draft.director) syncSharedEntityEdits(this.db, current.draft, next.draft, episodeId, canvas.id, operationId, scriptCommits);
                    const owner = { kind: this.ownerKind, id: episodeId };
                    const previousSceneIds = new Set(current.draft.director ? productionSceneEntries(current.draft.director.source).map(scene => scene.id) : []);
                    const nextScenes = productionSceneEntries(next.draft.director.source);
                    const createdSceneIds = nextScenes.filter(scene => !previousSceneIds.has(scene.id)).map(scene => scene.id);
                    const createdSceneSet = new Set(createdSceneIds);
                    const previousClipIds = new Set(current.draft.clipGroups.map(group => group.id));
                    const materializeClipIds = new Set<string>();
                    const sceneNodes = (canvas.nodes as any[]).filter(node => node.type === "minimax-h3:video"
                        && node.metadata?.productionOwnerKind === owner.kind
                        && node.metadata?.productionOwnerId === owner.id
                        && !node.metadata?.productionArchiveLabel);
                    for (const group of next.draft.clipGroups) {
                        const sceneIds = productionSceneIdsForShots(nextScenes, group.shotIds);
                        if (sceneIds.length !== 1) continue;
                        const scene = nextScenes.find(item => item.id === sceneIds[0]);
                        const isNewGroup = !previousClipIds.has(group.id);
                        const currentSceneNode = sceneNodes.find(node => String(node.id || "") === String(group.nodeId || ""));
                        const targetSceneNode = sceneNodes.find(node => String(node.metadata?.productionSceneId || "") === sceneIds[0])
                            || (!createdSceneSet.has(sceneIds[0])
                                ? sceneNodes.find(node => String(node.metadata?.productionSceneId || "") === String(scene?.environmentId || ""))
                                : undefined);
                        const currentSceneId = String(currentSceneNode?.metadata?.productionSceneId || "");
                        const sceneAssignmentChanged = Boolean(currentSceneNode?.metadata?.productionSceneId
                            && currentSceneId !== sceneIds[0] && currentSceneId !== String(scene?.environmentId || ""));
                        if (!isNewGroup && !createdSceneSet.has(sceneIds[0]) && !sceneAssignmentChanged) continue;
                        materializeClipIds.add(group.id);
                        group.nodeId = targetSceneNode?.id || (sceneAssignmentChanged
                            ? productionLayoutStableId("production-h3-scene", owner.id, sceneIds[0])
                            : group.nodeId || existingProductionSceneH3NodeId(canvas, next.draft, owner, sceneIds[0])
                                || productionLayoutStableId("production-h3-scene", owner.id, sceneIds[0]));
                        group.segmentId ||= `clip-${crypto.createHash("sha256").update([owner.id, group.id].join(String.fromCharCode(0))).digest("hex").slice(0, 24)}`;
                    }
                    const h3Defaults = record(this.db.getSetting("plugin:minimax-h3:defaults:v1"));
                    const previousLayout = this.db.getProductionLayoutPlan(canvas.id);
                    const shotTargets = shotProjectionIds
                        ? new Set(next.draft.clipGroups.filter(group => group.shotIds.some(shotId => shotProjectionIds.has(shotId))).map(group => group.id))
                        : options.overwriteCompiledPromptTargets?.size
                            ? new Set(next.draft.clipGroups.filter(group => options.overwriteCompiledPromptTargets!.has(group.id)).map(group => group.id))
                            : undefined;
                    const scopedShotProjection = Boolean(previousLayout && shotTargets?.size);
                    const layout = scopedShotProjection ? previousLayout! : measure("layout_compile", () => compileProductionLayout({ h3Defaults, canvasId: canvas.id, owner, production: next.draft, project: canvas, previous: previousLayout }));
                    if (!scopedShotProjection) this.db.saveProductionLayoutPlan(canvas.id, layout);
                    const deferShotClipProjection = Boolean(options.shotDependencyFreeEdit
                        && !options.overwriteCompiledPromptTargets?.size && !options.forceBoundaryTargets?.size);
                    const { sceneOperations, clips } = measure("clip_and_scene_projection", () => ({
                        sceneOperations: scopedShotProjection ? [] : productionSceneCreationOperations(canvas, next.draft, layout, owner, createdSceneIds, h3Defaults),
                        clips: deferShotClipProjection
                            ? { operations: [], referenceSync: [] }
                            : clipInputOperations(canvas, next.draft, layout, h3Defaults, materializeClipIds, scopedShotProjection ? shotTargets : undefined, options.overwriteCompiledPromptTargets, options.forceBoundaryTargets),
                    }));
                    next.referenceSync = deferShotClipProjection ? undefined : clips.referenceSync;
                    const readyClips = new Set(clips.referenceSync.filter(item => item.status === "ready").map(item => item.targetId));
                    const forcedBoundarySegments = new Set(next.draft.clipGroups.filter(group => options.forceBoundaryTargets?.has(group.id)).map(group => String(group.segmentId || "")));
                    const clipOperations = clips.operations.filter(op => {
                        if (op.type !== "update_h3_segment") return true;
                        const projection = record(record(op.patch).productionClipProjection);
                        return readyClips.has(String(projection.targetId || "")) || forcedBoundarySegments.has(String(op.segmentId || ""));
                    });
                    const operations = measure("canvas_operation_plan", () => scopedShotProjection ? clipOperations : [...entityNodeOperations(canvas, next.draft, owner, current.draft, layout), ...removedSharedEntityNodeOperations(canvas, current.draft, next.draft, owner), ...sceneOperations, ...scriptNodeOperations(canvas, next.draft, owner, current.draft), ...imageInputOperations(canvas, next.draft, episodeId, current.draft, layout), ...clipOperations, ...removedSubjectEntityNodeOperations(canvas, current.draft, next.draft, owner)]);
                    if (operations.length) measure("canvas_operation_apply", () => this.db.applyCanvasProjectOperations(canvasId!, Number(canvas.revision || 0), operations, { operationId: projectionOperationId, runtimeWrite: true, withinTransaction: true, deferredCommits: scriptCommits, source: { kind: "system", clientId: "production:scripts", label: "同步正式制作节点输入" } }));
                } else {
                    const operations = scriptNodeOperations(canvas, next.draft, { kind: this.ownerKind, id: episodeId }, current.draft);
                    if (operations.length) measure("canvas_operation_apply", () => this.db.applyCanvasProjectOperations(canvasId!, Number(canvas.revision || 0), operations, { operationId: projectionOperationId, runtimeWrite: true, withinTransaction: true, deferredCommits: scriptCommits, source: { kind: "system", clientId: "production:scripts", label: "同步正式制作节点输入" } }));
                }
            }
            measure("dependency_and_receipt_persist", () => {
                if (!options.shotDependencyFreeEdit) this.syncSubjectClipDependencies(episodeId, next.draft.director);
                this.prepare("INSERT INTO episode_productions (episode_id, revision, draft_json, published_json, published_version, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(episode_id) DO UPDATE SET revision = excluded.revision, draft_json = excluded.draft_json, published_json = excluded.published_json, published_version = excluded.published_version, updated_at = excluded.updated_at, archived_at = excluded.archived_at")
                    .run(episodeId, next.revision, JSON.stringify(withoutDirectorProjection(next.draft)), next.published ? JSON.stringify(withoutDirectorProjection(next.published)) : null, next.publishedVersion, next.updatedAt, next.archivedAt ?? null);
                this.prepare("INSERT INTO episode_production_operations (operation_id, episode_id, request_hash, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)")
                    .run(operationId, episodeId, requestHash, encodeReceipt(dedupReceipt(publicProductionRecord(next) as ProductionRecord)), next.updatedAt);
                this.db.db.prepare("INSERT INTO production_operation_keys(owner_kind,owner_id,operation_id,request_hash,committed_revision,created_at) VALUES(?,?,?,?,?,?)")
                    .run(this.ownerKind, episodeId, operationId, requestHash, next.revision, next.updatedAt);
            });
            measure("pre_commit_hook", () => options.beforeCommit?.(next));
            measure("sqlite_commit", () => this.db.db.exec("COMMIT"));
            this.events?.publish({ type: "drama-production.updated", entityId: episodeId, payload: { revision: next.revision, publishedVersion: next.publishedVersion } });
            scriptCommits.forEach(commit => this.db.notifyCanvasCommit(commit));
            return { ...next, replayed: false };
            };
            return finishMutation(measure("source_validation_and_mutation", () => mutate(current)));
        } catch (error) { this.db.db.exec("ROLLBACK"); throw error; }
    }

    private commit(episodeId: string, operationId: string, expectedRevision: number, requestHash: string, mutate: (record: ProductionRecord) => ProductionRecord & { impact?: ProductionImpact }, options: Parameters<EpisodeProductionService["commitCore"]>[5] = {}) {
        return this.commitCore(episodeId, operationId, expectedRevision, requestHash, mutate, options);
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

    private fromRow(episodeId: string, row: Row, projectRuntimeView = true): ProductionRecord {
        const draftRaw = JSON.parse(row.draft_json);
        const publishedRaw = row.published_json ? JSON.parse(row.published_json) : null;
        // Parse stored snapshots without rewriting them. Public get rejects old
        // formats below; the explicit maintenance commit is the only caller that
        // opts into reading one for an authorized source replacement.
        const draft = episodeProductionHistoryDataSchema.parse(draftRaw) as EpisodeProductionData;
        const draftSourceOnly = Boolean(draft.director && isSubjectPromptAssembly(draft.director.source)
            && !["scenes", "shots", "clipGroups"].some(key => Object.hasOwn(draftRaw, key)));
        if (draftSourceOnly && projectRuntimeView) { projectDirector(draft, false); this.hydrateDirectorRuntimeView(episodeId, draft, row.published_version); }
        let published: EpisodeProductionData | null = publishedRaw ? episodeProductionHistoryDataSchema.parse(publishedRaw) as EpisodeProductionData : null;
        const publishedIsV2 = Boolean(published?.director && isSubjectPromptAssembly(published.director.source));
        const publishedSourceOnly = !publishedIsV2 || !["scenes", "shots", "clipGroups"].some(key => Object.hasOwn(publishedRaw, key));
        if (published?.director && publishedSourceOnly && projectRuntimeView) {
            projectDirector(published, false);
            this.hydrateDirectorRuntimeView(episodeId, published, row.published_version);
        }
        return { episodeId, revision: row.revision, draft, published, publishedVersion: row.published_version, updatedAt: row.updated_at, archivedAt: row.archived_at || null,
            ...(draft.director && isSubjectPromptAssembly(draft.director.source) ? { storageFormat: draftSourceOnly && publishedSourceOnly ? "v2-single-source" : "v2-projection-migration-required" } : {}),
            ...(draft.director && isSubjectPromptAssembly(draft.director.source) && published?.director && !isSubjectPromptAssembly(published.director.source) ? { publishedFormatStatus: "legacy-maintenance-required" as const } : {}) };
    }

    private hydrateDirectorRuntimeView(episodeId: string, data: EpisodeProductionData, version: number) {
        const director = data.director;
        if (!director || !isSubjectPromptAssembly(director.source)) return;
        const canvasId = this.ownerKind === "canvas" ? episodeId : this.episodeInfo(episodeId).canvasId;
        const project = canvasId ? this.db.getCanvasProject(canvasId) : undefined;
        const owner = { kind: this.ownerKind, id: episodeId };
        const matches = new Map<string, Array<{ node: Record<string, any>; segment: Record<string, any> }>>();
        for (const node of (project?.nodes as Array<Record<string, any>> | undefined) || []) {
            const metadata = record(node.metadata);
            if (String(metadata.productionOwnerId || "") !== owner.id || String(metadata.productionOwnerKind || "") !== owner.kind) continue;
            for (const segment of clipRows(metadata.segments)) {
                const targetId = String(record(segment.productionClipProjection).targetId || "");
                if (!targetId) continue;
                const items = matches.get(targetId) || [];
                items.push({ node, segment });
                matches.set(targetId, items);
            }
        }
        for (const group of data.clipGroups) {
            const candidates = matches.get(group.id) || [];
            if (candidates.length !== 1) {
                group.nodeId = null;
                group.segmentId = null;
                continue;
            }
            const [{ node, segment }] = candidates;
            group.nodeId = String(node.id || "") || null;
            group.segmentId = String(segment.id || "") || null;
            group.sourceVersion = Number(record(segment.archivedResultOrigin).sourceVersion || version || 0);
            if (typeof segment.inputOutdated === "boolean") group.inputOutdated = segment.inputOutdated;
            const origin = record(segment.archivedResultOrigin);
            if (origin.generationLogId && origin.taskId && origin.sourceHash) group.selectedResult = {
                generationLogId: String(origin.generationLogId), taskId: String(origin.taskId),
                sourceVersion: Number(origin.sourceVersion || version || 1), sourceHash: String(origin.sourceHash),
                ...(origin.sourceNodeId ? { sourceNodeId: String(origin.sourceNodeId) } : {}),
            };
        }
    }

    private episode(episodeId: string) {
        const episode = this.projectScope
            ? (this.db.getCanvasProject(episodeId) ? { id: episodeId, canvasId: episodeId, fullPlot: "", title: "", dramaId: "", episodeNumber: 0, synopsis: "" } : null)
            : this.db.getDramaEpisode(episodeId);
        if (!episode) throw new Error("分集不存在");
        return episode;
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
            if (!targetNode || targetNodeId !== expectedNodeId || !isH3NodeType(String(targetNode.type)) || String(record(targetNode.metadata).productionSceneId || "") !== sceneId) {
                throw new Error(`Clip ${group.id} 没有绑定到场次 ${sceneId} 的正式 H3 节点`);
            }
            const targetClip = (Array.isArray(record(targetNode.metadata).segments) ? record(targetNode.metadata).segments as Array<Record<string, any>> : []).find(clip => String(clip.id || "") === segmentId);
            if (!targetClip || String(record(targetClip.productionClipProjection).targetId || "") !== group.id) throw new Error(`场次 H3 缺少正式 Clip 投影：${group.id}`);
            if (targetClip.resultStorageKey && String(targetClip.resultStorageKey) !== storageKey) throw new Error(`场次 Clip ${group.id} 已绑定其他视频，拒绝覆盖`);
            if (activeStatuses.has(String(targetClip.status || ""))) throw new Error(`场次 Clip ${group.id} 正在运行，拒绝恢复归档视频`);

            const archiveSourceHash = String(record(sourceClip.productionClipProjection).sourceHash || sourceClip.directorSourceHash || "");
            const publishedSourceHash = String(published.director?.sourceHash || "");
            if (!archiveSourceHash || archiveSourceHash !== publishedSourceHash) throw new Error(`迁移前视频 ${group.id} 与当前发布版本的导演源稿哈希不匹配`);
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
        if (Boolean(op.generationLogId) === Boolean(op.taskId)) throw new Error("必须且只能提供 generationLogId 或 taskId");
        const taskLogs = op.generationLogId ? [] : this.db.listGenerationLogs({ projectId: canvasId || undefined, nodeId: op.nodeId, runtimeTaskId: op.taskId, status: "success", limit: 2 }).filter(item => !item.segmentId);
        if (!op.generationLogId && taskLogs.length !== 1) throw new Error("任务没有唯一对应的成功归档日志；请回读节点历史后重试");
        const log = this.db.getGenerationLog(op.generationLogId || taskLogs[0].id);
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
            const alreadyActive = String(clip.resultStorageKey || "") === op.storageKey && clip.status === "success";
            const logParams = record(log.params);
            const submission = record(logParams.submission);
            const taskParams = record(task.params);
            const expectedRuntime = record(record(taskParams.h3ExecutionContract).expectedRuntime);
            const settingsSource = Object.keys(expectedRuntime).length ? expectedRuntime : Object.keys(taskParams).length ? taskParams : logParams;
            const safeSettingsSource = generationSettingsSnapshot(settingsSource, {});
            const settings = Object.fromEntries(H3_PARAM_KEYS
                .filter(key => Object.prototype.hasOwnProperty.call(safeSettingsSource, key))
                .map(key => [key, safeSettingsSource[key]]));
            const historicalPrompt = typeof submission.authoredPrompt === "string" ? submission.authoredPrompt
                : typeof logParams.prompt === "string" ? logParams.prompt
                    : typeof taskParams.prompt === "string" ? taskParams.prompt : "";
            if (historicalPrompt.trim()) settings.prompt = historicalPrompt;
            operations = alreadyActive
                ? clip.inputOutdated === staleInput ? [] : [{ type: "update_h3_segment", nodeId: op.nodeId, segmentId: group.segmentId,
                    expectedFields: { resultStorageKey: clip.resultStorageKey, status: clip.status }, patch: { inputOutdated: staleInput } }]
                : [{ type: "restore_h3_output", nodeId: op.nodeId, segmentId: group.segmentId, generationLogId: log.id, storageKey: op.storageKey, settings }];
            Object.assign(group, { selectedResult, inputOutdated: staleInput });
        } else {
            if (binding.target_id !== op.targetId || !String(media.mimeType).startsWith("image/")) throw new Error("历史图片不属于这个正式资产或关键帧");
            const assetId = op.targetKind === "keyframe" ? director.shotInputs[op.targetId]?.keyframeAssetId : op.targetId;
            const asset = assetId && director.assets[assetId];
            const plan = assetId ? clipRows(director.source.asset_plan).find(item => String(item.asset_id || item.id || "") === assetId) : undefined;
            if (!assetId || !asset || asset.nodeId !== op.nodeId || plan?.sharedSource) throw new Error("请在原资产画布选择版本，不能修改共享引用");
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
        if (canvasCommits && operations.length) this.db.applyCanvasProjectOperations(canvasId!, op.canvasRevision, operations, { operationId: `${operationId}:result:${op.targetKind}:${op.targetId}`, runtimeWrite: true, withinTransaction: true, deferredCommits: canvasCommits, source: { kind: "system", clientId: "production:history", label: "选用制作历史结果" } });
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
        const propImage = record(metadata.propImage);
        const hasPropImage = node.type === "prop" && propImage.storageKey === op.storageKey;
        if (!["image", "character", "scene"].includes(String(node.type)) && !hasPropImage && !(node.type === "config" && metadata.generationMode === "image")) throw new Error("资产审核目标必须含有图片媒体");
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

    private apply(episodeId: string, draft: EpisodeProductionData, op: ProductionOperation, sourceVersion: number, canvasCommits?: CanvasCommit[], deferDirectorProjection = false, allowMissingSourceEntityCreate = true, overwriteCompiledPromptTargets?: ReadonlySet<string>, sceneRuntime = false) {
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
        if (op.type === "bind_director_segment") {
            const group = draft.clipGroups.find(item => item.id === op.targetId);
            const node = this.canvasNode(episodeId, op.nodeId);
            if (!group || !isH3NodeType(String(node.type))) throw new Error("Segment 或 H3 节点不属于当前制作");
            // 允许外部 Agent 绑定：不再要求 segment 已预先登记在 H3 节点的 segments 列表中。
            // if (!(record(node.metadata).segments as Record<string, any>[] || []).some(item => item.id === op.segmentId)) throw new Error("Clip 不属于目标 H3 节点");
            group.nodeId = op.nodeId; group.segmentId = op.segmentId;
            projectDirector(draft);
            return;
        }
        if (op.type === "initialize_director_from_demand") {
            const episode = this.db.getDramaEpisode(episodeId);
            if (!episode) throw new Error(`分集不存在：${episodeId}`);
            const demand = String(episode.synopsis || "").trim() || String(episode.fullPlot || "").trim();
            if (!demand) throw new Error("CURRENT_DEMAND_EMPTY: 当前分集没有已保存的需求正文");
            const location = demand.match(/(?:【)?场景(?:】|[：:])\s*([^\r\n]+)/)?.[1]?.trim() || episode.title;
            const timeOfDay = demand.match(/(?:【)?时间(?:】|[：:])\s*([^\r\n]+)/)?.[1]?.trim() || "";
            const scriptId = `script-${crypto.createHash("sha256").update(episode.id).digest("hex").slice(0, 12)}`;
            const scriptScenes = importDemandScriptBlocks(demand, { blockId: scriptId, sceneId: location, sceneName: location, location, timeOfDay });
            if (draft.director) {
                const director = draft.director;
                const source = director.source as Record<string, any>;
                const emptyCollections = ["script_scenes", "shots", "segments", "subject_registry", "character_registry", "scene_registry", "asset_plan", "asset_cards", "utterances"]
                    .every(key => source[key] === undefined || Array.isArray(source[key]) && source[key].length === 0);
                const ledger = record(source.ledger);
                const emptyLedger = ["facts", "initial", "events", "requirements", "coverage"]
                    .every(key => ledger[key] === undefined || Array.isArray(ledger[key]) && ledger[key].length === 0);
                const workflow = record(director.workflow);
                const currentWork = record(workflow.currentWork);
                const hasWorkflowActivity = Object.keys(currentWork).length > 0 || Boolean(workflow.agentThreadId)
                    || Object.keys(record(workflow.sceneWorks)).length > 0
                    || (Array.isArray(workflow.pendingDecisions) && workflow.pendingDecisions.some((item: unknown) => record(item).status === "pending"))
                    || Object.keys(record(workflow.sharedReviewWorks)).length > 0
                    || (Array.isArray(workflow.sharedAssetReviews) && workflow.sharedAssetReviews.length > 0)
                    || Boolean(workflow.sharedReview)
                    || Boolean(workflow.sharedReviewContinuation);
                const emptyShell = emptyCollections && emptyLedger && director.artifacts.length === 0 && Object.keys(director.assets).length === 0
                    && Object.keys(director.shotInputs).length === 0 && director.executionAuthorized !== true && !hasWorkflowActivity;
                if (!emptyShell) throw new Error("DIRECTOR_ALREADY_INITIALIZED: 当前正式稿已有内容或工作状态；拒绝覆盖");
                source.script_scenes = scriptScenes;
                source.scene_registry = [{ id: location, name: location, location, time_of_day: timeOfDay }];
                director.sourceHash = directorHash(source);
                director.artifacts = director.artifacts.map(artifact => ({ ...artifact, status: "stale" as const }));
                director.executionAuthorized = false;
            } else {
                this.initializeDirector(draft,
                    `《${episode.title}》首版制作稿；以当前分集已保存需求为唯一正文来源。`,
                    scriptScenes);
            }
            projectDirector(draft);
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
            const incoming = structuredClone(op.director);
            const trustedManualIds = new Set(clipRows(draft.director?.source.asset_plan).filter(plan => plan.created_by === "manual").map(plan => String(plan.id || plan.asset_id || "")));
            incoming.source.asset_plan = clipRows(incoming.source.asset_plan).map(plan => {
                const normalized = { ...plan };
                if (!trustedManualIds.has(String(normalized.id || normalized.asset_id || ""))) delete normalized.created_by;
                return normalized;
            });
            incoming.sourceHash = directorHash(incoming.source);
            const existing = draft.director;
            if (existing) {
                const workflow = existing.workflow;
                const hasWorkflowRuntimeState = Boolean(workflow.currentWork || workflow.agentThreadId || workflow.sharedReview || workflow.sharedReviewContinuation)
                    || Object.keys(workflow.sceneWorks || {}).length > 0 || Object.keys(workflow.sharedReviewWorks || {}).length > 0
                    || (workflow.pendingDecisions || []).some(item => item.status === "pending");
                const hasRuntimeState = existing.artifacts.length > 0 || Object.keys(existing.assets).length > 0
                    || Object.keys(existing.shotInputs).length > 0 || existing.executionAuthorized
                    || hasWorkflowRuntimeState
                    || Object.values(existing.modules).some(module => module.status !== "planned");
                if (!hasRuntimeState) {
                    // The first saved source has no Backend runtime state to preserve.
                    // Keep the supplied initial package intact, but do not carry an
                    // execution authorization into the newly established source.
                    incoming.executionAuthorized = false;
                    draft.director = incoming;
                    projectDirector(draft);
                    return;
                }
                // Whole-source replacement is atomic at director.source. Backend-owned runtime
                // state stays attached to the production record; source-derived compilation
                // artifacts are retained as history but cannot remain active for the new source.
                const preserved = structuredClone(existing);
                if (sceneRuntime) for (const [workId, incomingWork] of Object.entries(incoming.workflow.sceneWorks || {})) {
                    const currentWork = preserved.workflow.sceneWorks?.[workId];
                    if (currentWork && incomingWork.workAdoptions) currentWork.workAdoptions = structuredClone(incomingWork.workAdoptions);
                }
                preserved.source = incoming.source;
                preserved.sourceHash = incoming.sourceHash;
                const nextSource = { ...existing, source: incoming.source, sourceHash: incoming.sourceHash };
                preserved.artifacts = preserved.artifacts.map(artifact => overwriteCompiledPromptTargets?.size && currentCompilationArtifact(nextSource, artifact)
                    ? artifact
                    : artifact.status === "ready" ? { ...artifact, status: "stale" as const } : artifact);
                preserved.executionAuthorized = false;
                if (overwriteCompiledPromptTargets?.size) {
                    const compiled = incoming.artifacts.filter(artifact => overwriteCompiledPromptTargets.has(artifact.targetId));
                    const targets = new Set(compiled.map(artifact => artifact.targetId));
                    preserved.artifacts = [...preserved.artifacts.filter(artifact => !targets.has(artifact.targetId)), ...compiled];
                    // Compilation resolves Subject pictures from the currently bound
                    // entity nodes. Persist those exact media bindings with the artifacts;
                    // otherwise the prompt is compiled from the latest image while the
                    // saved director keeps the previous asset hash and immediately marks
                    // every scoped artifact stale after apply.
                    preserved.assets = structuredClone(incoming.assets);
                    preserved.engine = incoming.engine;
                }
                if (preserved.workflow.currentWork) preserved.workflow.currentWork = { ...preserved.workflow.currentWork, sourceHash: incoming.sourceHash };
                draft.director = preserved;
            } else {
                if (incoming.workflow.currentWork) incoming.workflow.currentWork = { ...incoming.workflow.currentWork, sourceHash: incoming.sourceHash };
                incoming.executionAuthorized = false;
                draft.director = incoming;
            }
            projectDirector(draft);
            return;
        }
        if (op.type === "upsert_director_subject") {
            if (!draft.director || !isSubjectPromptAssembly(draft.director.source)) throw new Error("SUBJECT_SOURCE_VERSION_REQUIRED: 仅 Subject Prompt v2 可写 Subject");
            const rows = clipRows(draft.director.source.subject_registry);
            const incoming = structuredClone(op.subject);
            const previousSubject = rows.find(subject => subject.id === incoming.id);
            const previousBindings = clipRows(previousSubject?.pictureBindings);
            // First registration follows the canonical entity node. Existing edits and
            // explicit unbinding stay user-controlled; reads never create bindings.
            const ref = incoming.entityRef;
            const entityKind = ref.kind === "asset" ? "prop" : ref.kind;
            const rebindIdentityChanged = Boolean(previousSubject && canonicalProduction(previousSubject.entityRef) !== canonicalProduction(ref));
            if (previousSubject && rebindIdentityChanged) {
                if (ref.ownerKind !== this.ownerKind || ref.ownerId !== episodeId
                    || !productionEntities(draft.director.source, { kind: this.ownerKind, id: episodeId }).some(entity => entity.kind === entityKind && entity.entityId === ref.id)) {
                    throw new Error("主体只能切换到当前本集已登记的同类型画布实体");
                }
                const occupiedSubject = rows.find(subject => subject.id !== incoming.id && canonicalProduction(subject.entityRef) === canonicalProduction(ref));
                if (occupiedSubject) {
                    const previousRef = previousSubject.entityRef;
                    const previousKind = previousRef.kind === "asset" ? "prop" : previousRef.kind;
                    if (previousRef.ownerKind !== this.ownerKind || previousRef.ownerId !== episodeId || previousKind !== entityKind) throw new Error("目标实体已绑定其他类型主体，不能交换绑定");
                    const occupiedBindings = clipRows(occupiedSubject.pictureBindings);
                    const currentIdentityBinding = previousBindings.find(binding => Array.isArray(binding.defaultFor) && binding.defaultFor.includes("identity")) || previousBindings[0];
                    const pictureRemap = new Map<string, string>();
                    for (const oldBinding of occupiedBindings) {
                        const provides = Array.isArray(oldBinding.provides) ? oldBinding.provides : [];
                        const replacement = previousBindings.find(binding => (Array.isArray(binding.provides) ? binding.provides : []).some(value => provides.includes(value))) || currentIdentityBinding;
                        if (replacement) pictureRemap.set(String(oldBinding.id), String(replacement.id));
                    }
                    for (const shot of clipRows(draft.director.source.shots)) {
                        for (const usage of clipRows(shot.subject_usages)) if (usage.subjectId === occupiedSubject.id) {
                            usage.pictureBindingIds = [...new Set((Array.isArray(usage.pictureBindingIds) ? usage.pictureBindingIds : []).map(id => pictureRemap.get(String(id)) || String(id)))];
                        }
                        for (const frame of clipRows(shot.keyframes)) {
                            const bySubject = frame.subjectPictureBindingIds && typeof frame.subjectPictureBindingIds === "object" ? frame.subjectPictureBindingIds as Record<string, unknown> : undefined;
                            if (!bySubject || !Object.hasOwn(bySubject, occupiedSubject.id)) continue;
                            bySubject[occupiedSubject.id] = [...new Set((Array.isArray(bySubject[occupiedSubject.id]) ? bySubject[occupiedSubject.id] as unknown[] : []).map(id => pictureRemap.get(String(id)) || String(id)))];
                        }
                    }
                    occupiedSubject.entityRef = structuredClone(previousRef);
                    occupiedSubject.pictureBindings = structuredClone(previousBindings);
                } else {
                    const previousRef = previousSubject.entityRef;
                    remapSubjectEntityReferences(draft.director.source, previousRef.kind === "asset" ? "prop" : previousRef.kind, String(previousRef.id || ""), String(ref.id || ""));
                }
            }
            if (!previousSubject && incoming.pictureBindings.length === 0 && ref.ownerKind === this.ownerKind && ref.ownerId === episodeId
                && productionEntities(draft.director.source, { kind: this.ownerKind, id: episodeId }).some(entity => entity.kind === entityKind && entity.entityId === ref.id)) {
                const projectId = this.ownerKind === "canvas" ? episodeId : this.db.getDramaEpisode(episodeId)?.canvasId;
                if (projectId) {
                    const nodeId = productionLayoutStableId("production-entity", this.ownerKind, episodeId, entityKind, ref.id);
                    const bindingId = `picture:${incoming.id}:${encodeURIComponent(projectId)}:${encodeURIComponent(nodeId)}`;
                    const purpose = entityKind === "scene" ? "environment" : entityKind === "prop" ? "prop" : "identity";
                    incoming.pictureBindings = [{ id: bindingId, assetId: bindingId, sourceNode: { projectId, nodeId },
                        selection: { mode: "node_selection" }, provides: [purpose], retain: [entityKind === "prop" ? "道具身份、形状与材质" : entityKind === "scene" ? "场景环境与布局" : "主体身份与已登记外观"],
                        exclude: ["原图姿势", "无关背景"], applicableState: {}, defaultFor: [purpose] }];
                }
            }
            if (previousSubject && rebindIdentityChanged && ref.ownerKind === this.ownerKind && ref.ownerId === episodeId) {
                const sharedPlan = clipRows(draft.director.source.asset_plan).find(plan => plan.sharedSource
                    && String(plan.kind || "") === entityKind
                    && String(plan.entity_id || (entityKind === "prop" ? plan.id || plan.asset_id : "")) === String(ref.id || ""));
                if (sharedPlan) {
                    const binding = sharedSubjectPictureBinding(incoming, sharedPlan, episodeId, String(this.db.getDramaEpisode(episodeId)?.canvasId || ""));
                    if (binding) incoming.pictureBindings = [...incoming.pictureBindings, binding];
                }
            }
            const bindings = clipRows(incoming.pictureBindings);
            // One Subject can bind multiple selected images from the same shared
            // character node. `director.assets` is keyed by assetId, so distinct
            // selections cannot share that key or the later image overwrites the
            // earlier one during prompt compilation.
            const selectionByAssetId = new Map<string, string>();
            for (const binding of bindings) {
                const assetId = String(binding.assetId || "");
                if (!assetId) continue;
                const selectionKey = canonicalProduction({ sourceNode: binding.sourceNode, selection: binding.selection });
                const previousSelection = selectionByAssetId.get(assetId);
                if (previousSelection && previousSelection !== selectionKey) {
                    const suffix = crypto.createHash("sha256").update(`${binding.id}\0${selectionKey}`).digest("hex").slice(0, 12);
                    binding.assetId = `${assetId}:selection:${suffix}`;
                    selectionByAssetId.set(String(binding.assetId), selectionKey);
                } else selectionByAssetId.set(assetId, selectionKey);
            }
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
            const episodeCanvasId = this.episodeInfo(episodeId).canvasId;
            if (episodeCanvasId) {
                const episodeProject = this.db.getCanvasProject(episodeCanvasId);
                const projectNodes = clipRows(episodeProject?.nodes);
                for (const binding of incoming.pictureBindings) {
                    const assetId = String(binding.assetId || ""), sourcePlan = clipRows(draft.director.source.asset_plan).find(item => String(item.id || item.asset_id || "") === assetId);
                    if (!sourcePlan?.sharedSource || binding.sourceNode?.projectId !== episodeCanvasId) continue;
                    const sourceNode = projectNodes.find(node => String(node.id || "") === String(binding.sourceNode?.nodeId || ""));
                    if (!sourceNode || !sharedAssetNodeMatchesSource(sourceNode, sourcePlan.sharedSource)) continue;
                    const previousAsset = draft.director.assets[assetId];
                    if (!previousAsset) continue;
                    const singleSourceAsset = { ...previousAsset } as DirectorProduction["assets"][string] & { sharedSource?: unknown };
                    delete singleSourceAsset.sharedSource;
                    draft.director.assets[assetId] = { ...singleSourceAsset, nodeId: String(sourceNode.id) };
                }
            }
            if (rebindIdentityChanged) {
                const validBindingIds = new Set(incoming.pictureBindings.map(binding => String(binding.id)));
                const defaultIdentity = incoming.pictureBindings.find(binding => Array.isArray(binding.defaultFor) && binding.defaultFor.includes("identity"));
                for (const shot of clipRows(draft.director.source.shots)) {
                    for (const usage of clipRows(shot.subject_usages)) if (usage.subjectId === incoming.id) {
                        usage.pictureBindingIds = [...new Set((Array.isArray(usage.pictureBindingIds) ? usage.pictureBindingIds : []).map(id => bindingRemap.get(String(id)) || (defaultIdentity && previousBindings.some(binding => String(binding.id) === String(id)) ? String(defaultIdentity.id) : String(id))).filter(id => validBindingIds.has(String(id))))];
                    }
                    for (const frame of clipRows(shot.keyframes)) {
                        const bySubject = frame.subjectPictureBindingIds && typeof frame.subjectPictureBindingIds === "object" ? frame.subjectPictureBindingIds as Record<string, unknown> : undefined;
                        if (!bySubject || !Object.hasOwn(bySubject, incoming.id)) continue;
                        const mapped = (Array.isArray(bySubject[incoming.id]) ? bySubject[incoming.id] as unknown[] : []).map(bindingId => {
                            const id = String(bindingId);
                            return bindingRemap.get(id) || (defaultIdentity && previousBindings.some(binding => String(binding.id) === id) ? String(defaultIdentity.id) : id);
                        }).filter(id => validBindingIds.has(String(id)));
                        if (mapped.length) bySubject[incoming.id] = [...new Set(mapped)]; else delete bySubject[incoming.id];
                    }
                }
            }
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
        if (op.type === "create_manual_director_asset") {
            if (!draft.director) throw new Error("DIRECTOR_NOT_INITIALIZED: 没有正式制作稿");
            const sharedSource = op.assetPlan.sharedSource;
            if (sharedSource) {
                if (this.ownerKind !== "episode") throw new Error("共享节点只能登记到分集制作稿");
                const existingPlan = clipRows(draft.director.source.asset_plan).find(item => item.sharedSource?.sourceProjectId === sharedSource.sourceProjectId && item.sharedSource?.sourceNodeId === sharedSource.sourceNodeId);
                if (existingPlan) {
                    if (String(existingPlan.id || existingPlan.asset_id || "") !== op.assetPlan.id || canonicalProduction(existingPlan.sharedSource) !== canonicalProduction(sharedSource)) throw new Error("共享节点已以其他资产身份纳入本集");
                    const episode = this.db.getDramaEpisode(episodeId);
                    const drama = episode?.dramaId ? this.db.listCanvasFolders().find(folder => folder.id === episode.dramaId && folder.isDrama) : undefined;
                    const shared = this.db.getCanvasProject(sharedSource.sourceProjectId);
                    const sourceNode = (shared?.nodes as Array<Record<string, any>> || []).find(node => node.id === sharedSource.sourceNodeId);
                    if (!episode?.canvasId || !drama || drama.sharedAssetCanvasId !== sharedSource.sourceProjectId || !sourceNode
                        || sourceNode.type !== existingPlan.kind) throw new Error("共享节点已变化或不属于当前共享资产画布");
                    if (ensureSharedSubjectPictureBinding(draft.director, episodeId, episode.canvasId, existingPlan, String(op.subject?.id || ""))) projectDirector(draft);
                    return;
                }
                const episode = this.db.getDramaEpisode(episodeId);
                const drama = episode?.dramaId ? this.db.listCanvasFolders().find(folder => folder.id === episode.dramaId && folder.isDrama) : undefined;
                if (!episode?.canvasId || !drama || drama.sharedAssetCanvasId !== sharedSource.sourceProjectId || sharedSource.assetId !== op.assetPlan.id) throw new Error("共享节点来源与当前剧目不匹配");
                const shared = this.db.getCanvasProject(sharedSource.sourceProjectId);
                const sourceNode = (shared?.nodes as Array<Record<string, any>> || []).find(node => node.id === sharedSource.sourceNodeId);
                if (!sourceNode || sourceNode.type !== op.assetPlan.kind || !["character", "scene", "prop"].includes(String(sourceNode.type || ""))) throw new Error("共享节点已变化或不属于当前共享资产画布");
                const source = { dramaId: episode.dramaId, assetId: op.assetPlan.id, sourceProjectId: sharedSource.sourceProjectId, sourceNodeId: sharedSource.sourceNodeId };
                if (this.db.getAssetRecord(source.assetId)) {
                    const current = this.db.getAssetRecord(source.assetId)!;
                    if (canonicalProduction(current.metadata.sharedAssetSource) !== canonicalProduction(source)) throw new Error("共享资产 ID 已被其他来源占用");
                } else {
                    const existingSource = this.db.listSharedAssetRecordsForProject(source.sourceProjectId).find(asset => {
                        const registered = sourceOf(asset);
                        return registered?.dramaId === source.dramaId && registered.sourceProjectId === source.sourceProjectId && registered.sourceNodeId === source.sourceNodeId;
                    });
                    if (existingSource) throw Object.assign(new Error(`该共享节点已登记为资产 ${existingSource.id}，请复用已有资产身份`), { code: "SHARED_ASSET_ID_CONFLICT" });
                    const now = new Date().toISOString();
                    this.db.upsertAssetRecord({ id: source.assetId, kind: op.assetPlan.kind, title: sourceNode.title || op.assetPlan.asset_name, coverUrl: "", tags: [],
                        folderId: null, dramaId: episode.dramaId, data: {}, note: null, source: "production-shared",
                        metadata: { projectId: source.sourceProjectId, nodeId: source.sourceNodeId, sharedAssetSource: source }, createdAt: now, updatedAt: now });
                }
            }
            createManualDirectorAsset(draft.director, op, { kind: this.ownerKind, id: episodeId });
            if (sharedSource) {
                draft.director.assets[op.assetPlan.id] = { version: op.assetPlan.version, status: "planned" };
                const episodeCanvasId = this.db.getDramaEpisode(episodeId)?.canvasId;
                if (episodeCanvasId) ensureSharedSubjectPictureBinding(draft.director, episodeId, episodeCanvasId, op.assetPlan as Record<string, any>, String(op.subject?.id || ""));
            }
            projectDirector(draft);
            return;
        }
        if (op.type === "delete_director_asset") {
            if (!draft.director) throw new Error("DIRECTOR_NOT_INITIALIZED: 没有正式制作稿");
            deleteDirectorAsset(draft.director, op.id);
            projectDirector(draft);
            return;
        }
        if (op.type === "remove_shared_director_asset") {
            if (!draft.director || this.ownerKind !== "episode") throw new Error("共享资产只能从分集使用范围移除");
            const source = draft.director.source as Record<string, any>;
            const plan = clipRows(source.asset_plan).find(item => String(item.id || item.asset_id || "") === op.id && item.sharedSource);
            if (!plan) return;
            const kind = String(plan.kind || ""), entityId = String(plan.entity_id || op.id);
            const entityRefKind = kind === "prop" ? "asset" : kind;
            // Subject ownership is not always episode-scoped: shared assets selected from the drama
            // canvas register `ownerKind: "drama"` (or `"canvas"`). Match the stable entity identity
            // and any picture binding that points at this asset instead of the owner, otherwise this
            // guard is skipped for those registrations and the removal silently detaches Shot
            // references while leaving an orphan Subject behind.
            const subjects = clipRows(source.subject_registry).filter(subject => {
                const reference = subject.entityRef && typeof subject.entityRef === "object" ? subject.entityRef : {};
                const entityMatches = String(reference.kind || "") === entityRefKind && [entityId, op.id].includes(String(reference.id || ""));
                const bindingMatches = clipRows(subject.pictureBindings).some(binding => String(binding.assetId || binding.asset_id || "") === op.id);
                return entityMatches || bindingMatches;
            });
            const subjectIds = new Set(subjects.map(subject => String(subject.id || "")));
            if (clipRows(source.shots).some(shot => clipRows(shot.subject_usages).some(usage => subjectIds.has(String(usage.subjectId || "")))
                || (shot.camera?.attention_subject_ids || []).some((id: unknown) => subjectIds.has(String(id)))
                || clipRows(shot.keyframes).some(frame => clipRows(frame.subjectIds).some(id => subjectIds.has(String(id))))
                || clipRows(shot.reference_requirements).some(ref => clipRows(ref.subjectIds).some(id => subjectIds.has(String(id)))))
                || clipRows(source.utterances).some(line => subjectIds.has(String(line.speakerSubjectId || "")))
                || kind === "character" && clipRows(source.shots).some(shot => clipRows(shot.characters).some(character => String(character.id || character.character_id || character) === entityId))
                || kind === "scene" && (clipRows(source.shots).some(shot => String(shot.scene_id || "") === entityId) || clipRows(source.script_scenes).some(scene => String(scene.scene_id || scene.id || "") === entityId))) throw new Error("SUBJECT_STILL_REFERENCED: 先解除分镜和对白中的主体引用，再移出共享资产");
            deleteDirectorAsset(draft.director, op.id);
            const nextSource = draft.director.source as Record<string, any>;
            nextSource.asset_plan = clipRows(nextSource.asset_plan).filter(item => String(item.id || item.asset_id || "") !== op.id);
            nextSource.asset_cards = clipRows(nextSource.asset_cards).filter(item => String(item.id || item.asset_id || "") !== op.id);
            nextSource.subject_registry = clipRows(nextSource.subject_registry).filter(subject => !subjectIds.has(String(subject.id || "")));
            if (kind === "character") nextSource.character_registry = clipRows(nextSource.character_registry).filter(item => String(item.id || "") !== entityId);
            if (kind === "scene") nextSource.scene_registry = clipRows(nextSource.scene_registry).filter(item => String(item.id || "") !== entityId);
            draft.director.sourceHash = directorHash(nextSource);
            projectDirector(draft);
            return;
        }
        if (op.type === "delete_director_subject") {
            if (!draft.director || !isSubjectPromptAssembly(draft.director.source)) throw new Error("SUBJECT_SOURCE_VERSION_REQUIRED");
            const source = draft.director.source;
            const subject = clipRows(source.subject_registry).find(item => String(item.id || "") === op.id);
            if (!subject) return;
            const shots = clipRows(source.shots);
            const utterances = clipRows(source.utterances);
            const usedUtterances = new Set(utterances.filter(line => String(line.speakerSubjectId || "") === op.id).map(line => String(line.id || "")));
            const entityRef = record(subject.entityRef);
            const entityKind = String(entityRef.kind || "");
            const entityId = String(entityRef.id || "");
            const objectKinds = entityKind === "asset" ? new Set(["asset", "prop"]) : new Set([entityKind]);
            const ledgerFacts = clipRows(record(source.ledger).facts).filter(fact => objectKinds.has(String(fact.object_kind || "")) && String(fact.object_id || "") === entityId);
            const hasReferences = ledgerFacts.length > 0 || shots.some(shot => clipRows(shot.subject_usages).some(usage => String(usage.subjectId || "") === op.id)
                || (Array.isArray(shot.camera?.attention_subject_ids) && shot.camera.attention_subject_ids.some((id: unknown) => String(id) === op.id))
                || clipRows(shot.keyframes).some(frame => clipRows(frame.subjectIds).some(id => String(id) === op.id))
                || clipRows(shot.reference_requirements).some(reference => clipRows(reference.subjectIds).some(id => String(id) === op.id))
                || clipRows(shot.utterance_refs).some(reference => usedUtterances.has(String(reference.utteranceId || ""))));
            if (hasReferences && !op.referenceAction) throw new Error("SUBJECT_STILL_REFERENCED: 删除前请选择清除引用或改绑主体");
            let replacement: Record<string, any> | undefined;
            if (op.referenceAction === "replace") {
                replacement = clipRows(source.subject_registry).find(item => String(item.id || "") === String(op.replacementSubjectId || ""));
                if (!replacement || replacement.id === op.id || replacement.kind !== subject.kind) throw new Error("SUBJECT_REPLACEMENT_INVALID: 请选择另一个同类型主体");
                const replacementEntityId = String(replacement.entityRef?.id || "");
                remapSubjectEntityReferences(source, subject.kind === "prop" ? "prop" : entityKind, entityId, replacementEntityId);
            } else if (op.referenceAction === "clear") {
                clearSubjectEntityLedgerReferences(source, subject);
            }
            const subjectId = String(op.id);
            for (const shot of shots) {
                if (Array.isArray(shot.subject_usages)) shot.subject_usages = shot.subject_usages.flatMap((usage: Record<string, any>) => {
                    if (String(usage.subjectId || "") !== subjectId) return [usage];
                    if (!replacement) return [];
                    // Picture bindings belong to the original Subject. Let the replacement's
                    // default binding resolve instead of carrying stale binding IDs across.
                    return [{ ...usage, subjectId: replacement.id, pictureBindingMode: "default", pictureBindingIds: [] }];
                });
                if (shot.camera && Array.isArray(shot.camera.attention_subject_ids)) {
                    shot.camera.attention_subject_ids = shot.camera.attention_subject_ids.flatMap((id: unknown) => String(id) === subjectId ? replacement ? [replacement.id] : [] : [id]);
                }
                if (Array.isArray(shot.keyframes)) for (const frame of shot.keyframes) {
                    if (Array.isArray(frame.subjectIds)) frame.subjectIds = [...new Set(frame.subjectIds.map(String).flatMap((id: string) => id === subjectId ? replacement ? [String(replacement.id)] : [] : [id]))];
                    if (frame.subjectPictureBindingIds && typeof frame.subjectPictureBindingIds === "object") {
                        const mappings = { ...frame.subjectPictureBindingIds };
                        delete mappings[subjectId];
                        frame.subjectPictureBindingIds = mappings;
                    }
                }
                if (Array.isArray(shot.reference_requirements)) for (const reference of shot.reference_requirements) {
                    if (Array.isArray(reference.subjectIds)) reference.subjectIds = [...new Set(reference.subjectIds.map(String).flatMap((id: string) => id === subjectId ? replacement ? [String(replacement.id)] : [] : [id]))];
                    if (reference.subjectPictureBindingIds && typeof reference.subjectPictureBindingIds === "object") {
                        const mappings = { ...reference.subjectPictureBindingIds };
                        delete mappings[subjectId];
                        reference.subjectPictureBindingIds = mappings;
                    }
                }
                if (!replacement && usedUtterances.size && Array.isArray(shot.utterance_refs)) shot.utterance_refs = shot.utterance_refs.filter((reference: Record<string, any>) => !usedUtterances.has(String(reference.utteranceId || "")));
            }
            if (replacement) {
                for (const line of utterances) if (String(line.speakerSubjectId || "") === subjectId) line.speakerSubjectId = replacement.id;
            } else if (usedUtterances.size) {
                source.utterances = utterances.filter(line => !usedUtterances.has(String(line.id || "")));
            }
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
            if (!deferDirectorProjection) projectDirector(draft);
            return;
        }
        if (op.type === "set_director_shot_utterances") {
            if (!draft.director || !isSubjectPromptAssembly(draft.director.source)) throw new Error("SUBJECT_SOURCE_VERSION_REQUIRED: 仅 Subject Prompt v2 可编辑镜头对白");
            const source = draft.director.source as Record<string, any>;
            const shot = clipRows(source.shots).find(item => item.id === op.shotId);
            if (!shot) throw new Error(`Shot ${op.shotId} 不存在`);
            const subjects = new Set(clipRows(source.subject_registry).map((item: any) => String(item.id)));
            const utterances = clipRows(source.utterances).map((item: any) => ({ ...item }));
            // `next` filters this array without cloning its rows. Shared-utterance
            // edits mutate those rows in place, so keep an immutable baseline for
            // the no-op check or delivery-only edits compare equal to themselves.
            const originalUtterancesJson = JSON.stringify(utterances);
            const referencesByUtterance = new Map<string, Array<{ shot: Record<string, any>; ref: Record<string, any> }>>();
            const orderedShots = clipRows(source.shots);
            for (const other of orderedShots) for (const ref of clipRows(other.utterance_refs)) {
                const references = referencesByUtterance.get(String(ref.utteranceId)) || [];
                references.push({ shot: other, ref });
                referencesByUtterance.set(String(ref.utteranceId), references);
            }
            const keptIds = new Set(op.utterances.map(item => item.utteranceId).filter((item): item is string => Boolean(item)));
            const removedIds = new Set<string>();
            const unchangedShared = new Set<string>();
            const editedShared = new Map<string, { item: (typeof op.utterances)[number]; text: string; refs: Array<{ shotId: string; ref: Record<string, any> }> }>();
            const priorRefs = clipRows(shot.utterance_refs);
            for (const utterance of utterances) {
                const utteranceId = String(utterance.id), references = referencesByUtterance.get(utteranceId) || [];
                const owners = new Set(references.map(({ shot: ownerShot }) => String(ownerShot.id)));
                if (!owners.has(op.shotId)) continue;
                if (keptIds.has(utteranceId)) {
                    if (owners.size <= 1) continue;
                    // Shared utterances keep one canonical concatenated text. New Shot forms edit only
                    // their own slice; old persisted drafts still submit the whole line plus manual cuts.
                    const candidate = op.utterances.find(item => String(item.utteranceId || "") === utteranceId);
                    const priorRef = priorRefs.find(ref => String(ref.utteranceId) === utteranceId);
                    if (!candidate || !priorRef) throw new Error("对白 " + utteranceId + " 在本镜缺少有效引用，无法修改");
                    const oldCharacters = Array.from(String(utterance.text));
                    const oldStart = Number(priorRef.textStart), oldEnd = Number(priorRef.textEnd);
                    const oldSegment = oldCharacters.slice(oldStart, oldEnd).join("");
                    const currentCuts = references.slice(0, -1).map(({ ref }) => Number(ref.textEnd));
                    const cutsUnchanged = !candidate.textCuts || candidate.textCuts.length === currentCuts.length
                        && candidate.textCuts.every((cut, index) => cut === currentCuts[index]);
                    const newCharacters = candidate.textMode === "segment"
                        ? [...oldCharacters.slice(0, oldStart), ...Array.from(candidate.text), ...oldCharacters.slice(oldEnd)]
                        : candidate.textMode === "partition" ? oldCharacters : Array.from(candidate.text);
                    const newText = newCharacters.join("");
                    const unchanged = candidate && priorRef
                        && String(candidate.speakerSubjectId || "") === String(utterance.speakerSubjectId || "")
                        && String(candidate.speakerName || "") === String(utterance.speakerName || "")
                        && (candidate.textMode === "segment" ? String(candidate.text) === oldSegment : String(candidate.text) === String(utterance.text))
                        && Number(candidate.localStartFrame) === Number(priorRef.localStartFrame)
                        && Number(candidate.localEndFrame) === Number(priorRef.localEndFrame)
                        && String(candidate.delivery ?? "") === String(utterance.delivery ?? "")
                        && cutsUnchanged;
                    if (unchanged) {
                        unchangedShared.add(utteranceId);
                        continue;
                    }
                    const textChanged = newText !== String(utterance.text);
                    let boundaries: number[] | undefined;
                    if (candidate.textCuts?.length === references.length - 1) {
                        const cuts = candidate.textCuts;
                        if (cuts && cuts.length === references.length - 1) boundaries = [0, ...cuts, newCharacters.length];
                    } else if (!textChanged) boundaries = [0, ...references.slice(0, -1).map(({ ref }) => Number(ref.textEnd)), newCharacters.length];
                    else if (candidate.textMode === "whole") throw new Error("对白 " + utteranceId + " 跨镜共用，请手动选择每个镜头的切字位置");
                    if (boundaries) {
                        if (boundaries.length !== references.length + 1 || boundaries.some((value, index) => index > 0 && value <= boundaries![index - 1])
                            || boundaries[0] !== 0 || boundaries.at(-1) !== newCharacters.length) {
                            throw new Error("对白 " + utteranceId + " 的切字位置无效；每个镜头都必须分到连续且非空的一段");
                        }
                    }
                    const targetReferenceIndex = references.findIndex(({ shot: ownerShot, ref }) => String(ownerShot.id) === op.shotId && ref === priorRef);
                    if (targetReferenceIndex < 0) throw new Error("对白 " + utteranceId + " 的本镜引用已变化，请刷新后重试");
                    const delta = newCharacters.length - oldCharacters.length;
                    const updatedRefs = references.map(({ shot: ownerShot, ref }, index) => {
                        let start = Number(ref.textStart), end = Number(ref.textEnd);
                        if (boundaries) { start = boundaries[index]; end = boundaries[index + 1]; }
                        else if (index === targetReferenceIndex) end = start + Array.from(candidate.text).length;
                        else if (index > targetReferenceIndex) { start += delta; end += delta; }
                        const ownerShotId = String(ownerShot.id);
                        const window = ownerShotId === op.shotId ? {
                            localStartFrame: candidate.localStartFrame,
                            localEndFrame: candidate.localEndFrame,
                        } : {};
                        const updated = { ...ref, ...window, textStart: start, textEnd: end };
                        return { shotId: ownerShotId, ref: updated };
                    });
                    editedShared.set(utteranceId, { item: candidate, text: newText, refs: updatedRefs });
                    continue;
                }
                if (owners.size > 1) throw new Error(`对白 ${utteranceId} 跨多个镜头引用，不能从本镜删除`);
                removedIds.add(utteranceId);
            }
            const next = utterances.filter((utterance: any) => !removedIds.has(String(utterance.id)));
            for (const [utteranceId, edit] of editedShared) {
                const record = next.find((item: any) => String(item.id) === utteranceId);
                if (!record) throw new Error(`共享对白 ${utteranceId} 不存在`);
                if (edit.item.speakerSubjectId) record.speakerSubjectId = edit.item.speakerSubjectId;
                else delete record.speakerSubjectId;
                if (edit.item.speakerName) record.speakerName = edit.item.speakerName;
                else delete record.speakerName;
                record.text = edit.text;
                if (edit.item.delivery) record.delivery = edit.item.delivery;
                else delete record.delivery;
                const orderedRefs = edit.refs.map(item => ({ ...item, order: orderedShots.findIndex((candidateShot: any) => String(candidateShot.id) === item.shotId) }))
                    .sort((left, right) => left.order - right.order);
                const first = orderedRefs[0], last = orderedRefs.at(-1)!;
                record.start = { shotId: first.shotId, localFrame: first.ref.localStartFrame };
                record.end = { shotId: last.shotId, localFrame: last.ref.localEndFrame };
                for (const updated of edit.refs) {
                    if (updated.shotId === op.shotId) continue;
                    const ownerShot = orderedShots.find((candidateShot: any) => String(candidateShot.id) === updated.shotId);
                    if (ownerShot) ownerShot.utterance_refs = clipRows(ownerShot.utterance_refs).map((ref: Record<string, any>) => String(ref.utteranceId) === utteranceId ? structuredClone(updated.ref) : ref);
                }
            }
            const duration = Number(shot.duration_frames);
            const refs: Array<Record<string, unknown>> = [];
            for (const [index, item] of op.utterances.entries()) {
                if (item.speakerSubjectId ? !subjects.has(item.speakerSubjectId) || Boolean(item.speakerName) : !String(item.speakerName || "").trim()) throw new Error(`对白 ${index + 1} 请指定已登记说话主体或填写临时说话人称呼`);
                if (item.localEndFrame <= item.localStartFrame || item.localEndFrame > duration) throw new Error(`对白 ${index + 1} 的时间窗须位于镜头时长内且起止递增`);
                const textLength = Array.from(item.text).length;
                const utteranceId = item.utteranceId || `UTT:${op.shotId}:${index + 1}`;
                if (unchangedShared.has(String(item.utteranceId))) {
                    const priorRef = priorRefs.find(ref => String(ref.utteranceId) === utteranceId);
                    if (priorRef) { refs.push(structuredClone(priorRef)); continue; }
                }
                const sharedRef = editedShared.get(String(item.utteranceId))?.refs.find(ref => ref.shotId === op.shotId)?.ref;
                if (sharedRef) { refs.push(structuredClone(sharedRef)); continue; }
                const existing = next.findIndex((utterance: any) => String(utterance.id) === utteranceId);
                const record: Record<string, unknown> = { id: utteranceId, ...(item.speakerSubjectId ? { speakerSubjectId: item.speakerSubjectId } : {}), ...(item.speakerName ? { speakerName: item.speakerName.trim() } : {}), text: item.text, ...(item.delivery ? { delivery: item.delivery } : {}), voiceover: Boolean(item.voiceover), start: { shotId: op.shotId, localFrame: item.localStartFrame }, end: { shotId: op.shotId, localFrame: item.localEndFrame } };
                if (existing >= 0) next[existing] = record; else next.push(record);
                refs.push({ utteranceId, role: "speaker", localStartFrame: item.localStartFrame, localEndFrame: item.localEndFrame, textStart: 0, textEnd: textLength });
            }
            if (JSON.stringify(next) === originalUtterancesJson && JSON.stringify(refs) === JSON.stringify(priorRefs)) return; // 整单都是原样重放：不动草稿，也不撤销执行授权
            source.utterances = next;
            shot.utterance_refs = refs;
            draft.director.sourceHash = directorHash(draft.director.source);
            draft.director.executionAuthorized = false;
            if (!deferDirectorProjection) projectDirector(draft);
            return;
        }
        if (op.type === "repartition_director_clips") {
            if (!draft.director || !isSubjectPromptAssembly(draft.director.source)) throw new Error("SUBJECT_SOURCE_VERSION_REQUIRED: 仅 Subject Prompt v2 可重组 Clip");
            repartitionDirectorClips(draft.director, op);
            projectDirector(draft);
            return;
        }
        if (op.type === "edit_director_continuity") {
            if (!draft.director || draft.director.source.version !== 2 || (draft.director.source.ledger as any)?.contract_version !== 2) throw new Error("UNSUPPORTED_PRODUCTION_FORMAT: 当前连续性编辑只支持 Acheng Director 制作稿 v2。");
            const ledger = draft.director.source.ledger as Record<string, any>;
            for (const change of op.changes) {
                const collection = ledger[change.collection];
                if (!Array.isArray(collection)) throw new Error(`连续性集合 ${change.collection} 不存在`);
                const index = collection.findIndex((entry: any) => String(entry.id || `${entry.timeline_id}:${entry.fact_id}`) === change.id);
                if (change.action === "delete") {
                    if (index < 0) throw new Error(`连续性条目 ${change.id} 不存在`);
                    const removed = collection[index];
                    collection.splice(index, 1);
                    if (change.collection === "facts") {
                        const factId = String(removed.id || "");
                        for (const shot of clipRows(draft.director.source.shots)) {
                            if (Array.isArray(shot.continuity_facts)) shot.continuity_facts = shot.continuity_facts.filter((id: unknown) => id !== factId);
                            if (Array.isArray(shot.subject_usages)) shot.subject_usages = shot.subject_usages.map((usage: Record<string, any>) => ({
                                ...usage,
                                ...(Array.isArray(usage.continuityFactIds) ? { continuityFactIds: usage.continuityFactIds.filter((id: unknown) => id !== factId) } : {}),
                                ...(Array.isArray(usage.stateRequirements) ? { stateRequirements: usage.stateRequirements.filter((requirement: Record<string, any>) => requirement.factId !== factId) } : {}),
                            }));
                        }
                        for (const subject of clipRows(draft.director.source.subject_registry)) for (const binding of clipRows(subject.pictureBindings)) {
                            if (binding.applicableState && Object.prototype.hasOwnProperty.call(binding.applicableState, factId)) {
                                const applicableState = { ...binding.applicableState };
                                delete applicableState[factId];
                                binding.applicableState = applicableState;
                            }
                        }
                    }
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
            for (const binding of op.keyframeBindings || []) {
                if (!binding.storageKey) continue;
                const media = this.db.getMediaFile(binding.storageKey);
                if (!media || !fs.existsSync(media.filePath)) continue;
                const asset = draft.director.assets[binding.assetId];
                if (asset) {
                    asset.sha256 = promptHashBytes(media.filePath);
                    asset.status = "generated";
                }
            }
            if (!isSubjectPromptAssembly(draft.director.source)) {
                const group = draft.clipGroups.find(item => item.id === op.segmentId);
                for (const shotId of group?.shotIds || []) {
                    const binding = op.keyframeBindings?.find(item => item.shotId === shotId);
                    const input = draft.director.shotInputs[shotId];
                    const nodeId = binding?.nodeId || binding?.containerNodeId || group?.nodeId;
                    if (binding?.storageKey && nodeId) {
                        draft.keyframes[shotId] = { nodeId, storageKey: binding.storageKey, sourceVersion: 0 };
                        delete draft.keyframeReviews[shotId];
                    } else if (binding || input?.keyframePolicy === "none" || !input?.keyframeAssetId) {
                        delete draft.keyframes[shotId];
                        delete draft.keyframeReviews[shotId];
                    }
                }
            }
            projectDirector(draft);
            const group = draft.clipGroups.find(item => item.id === op.segmentId);
            const projectId = this.projectScope ? episodeId : this.episodeInfo(episodeId).canvasId;
            const project = projectId ? this.db.getCanvasProject(projectId) : null;
            if (!group?.nodeId || !group.segmentId || !projectId || !project) throw new Error("CLIP_STORYBOARD_CANVAS_BINDING_MISSING: Clip 未绑定唯一的 H3 节点");
            const node = (project.nodes as Array<Record<string, any>> || []).find(item => item.id === group.nodeId);
            const existing = (node?.metadata?.segments as Array<Record<string, any>> | undefined)?.find(item => item.id === group.segmentId);
            if (!existing || existing.productionClipProjection?.targetId !== group.id) throw new Error("CLIP_STORYBOARD_CANVAS_BINDING_MISMATCH: H3 Clip 与制作台绑定不一致");
            const removedStoryboardBindingIds = new Set(op.removedStoryboardBindingIds || []);
            const referenceBindings = (Array.isArray(existing.referenceBindings) ? existing.referenceBindings : []).filter((ref: Record<string, unknown>) =>
                !(removedStoryboardBindingIds.has(String(ref.id || "")) && ref.mediaType === "image" && ref.role === "storyboard"));
            const storyboard = formalStoryboardTrack(draft, group, removedStoryboardBindingIds.size ? { ...existing, referenceBindings } : existing,
                Array.isArray(project.referenceCatalog) ? project.referenceCatalog : []);
            if (!storyboard) throw new Error("CLIP_STORYBOARD_SOURCE_INVALID: 无法从正式 Shot 生成 H3 分镜轨");
            const storyboardPatch = { ...storyboard,
                ...(storyboard.referenceBindings ? { referenceBindings: storyboard.referenceBindings } : {}),
                ...(referenceBindings.length !== (Array.isArray(existing.referenceBindings) ? existing.referenceBindings.length : 0) ? { referenceBindings } : {}) };
            if (canonicalProduction(existing.storyboardShots || []) !== canonicalProduction(storyboard.storyboardShots)
                || canonicalProduction(existing.referenceBindings || []) !== canonicalProduction(storyboardPatch.referenceBindings || existing.referenceBindings || [])
                || Number(existing.duration || 0) !== storyboard.duration || existing.storyboardModeEnabled !== true
                || referenceBindings.length !== (Array.isArray(existing.referenceBindings) ? existing.referenceBindings.length : 0)) {
                this.db.applyCanvasProjectOperations(projectId, Number(project.revision || 0), [{ type: "update_h3_segment", nodeId: group.nodeId, segmentId: group.segmentId, patch: storyboardPatch }], {
                    operationId: `${crypto.randomUUID()}:clip-storyboard-writeback`, runtimeWrite: true, withinTransaction: true, deferredCommits: canvasCommits || [],
                    source: { kind: "system", clientId: "production:clip-storyboard", label: "同步制作分镜轨" },
                });
            }
            return;
        }
        if (op.type === "replace_director_scene_storyboard") {
            if (!draft.director) throw new Error("缺少 Acheng 制作稿");
            replaceDirectorSceneStoryboard(draft.director, op);
            projectDirector(draft);
            return;
        }
        if (op.type === "edit_director_shot") {
            if (!draft.director) throw new Error("缺少导演源稿");
            if (op.action === "delete") {
                const segment = clipRows(draft.director.source.segments).find(row => row.shot_ids?.includes(op.shotId));
                if (segment?.shot_ids?.length === 1) {
                    const projectId = this.episodeInfo(episodeId).canvasId || (this.projectScope ? episodeId : undefined);
                    const project = projectId ? this.db.getCanvasProject(projectId) : null;
                    return deleteDirectorClip({ db: this.db, owner: { kind: this.ownerKind, id: episodeId }, draft, segmentId: String(segment.id), expectedCanvasRevision: Number(project?.revision || 0), canvasCommits: canvasCommits || [], assertTargetsIdle: targets => {
                        const occupied = this.targetOccupancy(episodeId, targets);
                        if (occupied.length) throw new Error(`CLIP_DELETE_TARGET_OCCUPIED: ${occupied.map(item => `${item.targetId}:${item.status}`).join("；")}`);
                    } });
                }
            }
            const beforeIds = clipRows(draft.director.source.shots).map(shot => String(shot.id));
            editDirectorShot(draft.director, op);
            const afterIds = new Set(clipRows(draft.director.source.shots).map(shot => String(shot.id)));
            for (const id of beforeIds) if (!afterIds.has(id)) { delete draft.keyframes[id]; delete draft.keyframeReviews[id]; }
            projectDirector(draft); return;
        }
        if (op.type === "patch_director_source") {
            if (!draft.director) throw new Error("缺少 Acheng 制作稿");
            this.patchDirectorSource(draft.director, op.entity, op.id, op.patch, allowMissingSourceEntityCreate);
            if (!deferDirectorProjection) projectDirector(draft);
            return;
        }
        if (op.type === "set_director_scene_environment") {
            const director = draft.director;
            if (!director) throw new Error("缺少导演源稿");
            const source = director.source;
            const group = productionScriptGroups(clipRows(source.script_scenes)).find(item => item.key === op.sceneId);
            if (!group) throw new Error(`剧本场次不存在：${op.sceneId}`);
            if (!clipRows(source.scene_registry).some(item => String(item.id || "") === op.environmentId)) throw new Error(`场景环境不存在：${op.environmentId}`);
            const entry = productionSceneEntries(source).find(item => item.id === op.sceneId);
            if (!entry) throw new Error(`剧本场次无法解析：${op.sceneId}`);
            const affected = new Set(entry.shotIds);
            const shots = clipRows(source.shots);
            const segments = clipRows(source.segments);
            for (const segment of segments) {
                const members = (Array.isArray(segment.shot_ids) ? segment.shot_ids : []).map(String);
                const resultingEnvironments = new Set(members.map(shotId => affected.has(shotId)
                    ? op.environmentId
                    : String(shots.find(shot => String(shot.id || "") === shotId)?.scene_id || "")));
                if (resultingEnvironments.size > 1) throw new Error(`场景变更会让 Clip ${String(segment.id || "")} 跨场景；请先调整 Clip 边界`);
            }
            const occurrenceIds = new Set(group.blocks.map(block => String(block.id || "")).filter(Boolean));
            source.script_scenes = clipRows(source.script_scenes).map(block => occurrenceIds.has(String(block.id || "")) ? { ...block, scene_id: op.environmentId } : block);
            source.shots = shots.map(shot => affected.has(String(shot.id || "")) ? { ...shot, scene_id: op.environmentId } : shot);
            director.sourceHash = directorHash(source);
            director.artifacts = director.artifacts.map(artifact => ({ ...artifact, status: "stale" as const }));
            director.executionAuthorized = false;
            projectDirector(draft);
            return;
        }
        if (op.type === "split_director_scene") {
            const director = draft.director;
            if (!director || !isSubjectPromptAssembly(director.source)) throw new Error("场次拆分仅支持 Subject Prompt Assembly v2 正式源稿");
            const source = director.source as Record<string, any>;
            const scriptScenes = clipRows(source.script_scenes);
            const groups = productionScriptGroups(scriptScenes);
            const group = groups.find(item => item.key === op.sourceSceneId);
            if (!group) throw new Error(`原场次不存在：${op.sourceSceneId}`);
            if (group.blocks.length !== 1) throw new Error("当前专用拆分工具要求原场次对应单条正式剧本记录；多块场次请先按块拆分后再迁镜头");
            if (scriptScenes.some(row => String(row.id || "") === String(op.newScene.id))) throw new Error(`新场次 ID 已存在：${op.newScene.id}`);
            const environment = clipRows(source.scene_registry).find(row => String(row.id || "") === String(op.newScene.scene_id));
            if (!environment) throw new Error(`新场景环境未登记：${op.newScene.scene_id}`);
            const subjects = clipRows(source.subject_registry);
            const environmentSubject = subjects.find(row => String(row.id || "") === op.environmentSubjectId);
            if (!environmentSubject || environmentSubject.kind !== "scene" || environmentSubject.entityRef?.kind !== "scene"
                || String(environmentSubject.entityRef?.id || "") !== String(op.newScene.scene_id)) {
                throw new Error("环境 Subject 必须是新场景环境对应的已登记场景 Subject");
            }
            const binding = clipRows(environmentSubject.pictureBindings).find(row => String(row.id || "") === op.environmentPictureBindingId);
            if (!binding || !(Array.isArray(binding.provides) ? binding.provides : []).map(String).includes("environment")) throw new Error("指定图片绑定不属于新环境 Subject 或未提供 environment 用途");

            const originalRow = group.blocks[0];
            const entry = productionSceneEntries(source).find(item => item.id === op.sourceSceneId);
            if (!entry) throw new Error("原场次无法解析对应镜头");
            const allShots = clipRows(source.shots);
            const existingShotIds = new Set(allShots.map(shot => String(shot.id || "")));
            const movedIds = new Set(op.shotIds.map(String));
            if (movedIds.size !== op.shotIds.length) throw new Error("shotIds 包含重复镜头");
            if (op.shotIds.some((id: string) => !existingShotIds.has(id) || !entry.shotIds.includes(id))) throw new Error("所有待迁镜头必须属于原场次且存在于正式源稿");
            const incomingBlocks = Array.isArray(op.newScene.blocks) ? op.newScene.blocks : [];
            const incomingBlockIds = incomingBlocks.length ? incomingBlocks.map((block: Record<string, any>) => String(block.id || "")) : [String(op.newScene.id)];
            if (incomingBlockIds.some((id: string) => !id) || new Set(incomingBlockIds).size !== incomingBlockIds.length) throw new Error("新场次正文块必须提供互不重复的稳定 ID");
            const existingBlockIds = new Set(scriptScenes.flatMap(row => Array.isArray(row.blocks) ? row.blocks.map((block: Record<string, any>) => String(block.id || "")) : [String(row.id || "")]).filter(Boolean));
            if (incomingBlockIds.some((id: string) => existingBlockIds.has(id))) throw new Error("新场次正文块 ID 必须与现有正文块不同");
            const entryOrder = entry.shotIds;
            const selectedPositions = op.shotIds.map((id: string) => entryOrder.indexOf(id)).sort((a: number, b: number) => a - b);
            if (selectedPositions.some((position: number, index: number) => index > 0 && position !== selectedPositions[index - 1] + 1)) throw new Error("待迁镜头必须是原场次中的一个连续镜头段");
            const occurrenceBeatIds = (row: Record<string, any>) => [...new Set([
                ...(Array.isArray(row.beat_ids) ? row.beat_ids.map(String) : []),
                ...(Array.isArray(row.blocks) ? row.blocks.flatMap((block: Record<string, any>) => Array.isArray(block.beat_ids) ? block.beat_ids.map(String) : []) : []),
            ])];
            const originalBeatIds = occurrenceBeatIds(originalRow);
            const movedBeatIds = occurrenceBeatIds(op.newScene);
            const retainedBeatIds = occurrenceBeatIds({ ...originalRow, ...op.sourceScenePatch });
            if (originalBeatIds.length) {
                const combined = [...retainedBeatIds, ...movedBeatIds];
                if (new Set(combined).size !== combined.length || combined.length !== originalBeatIds.length || originalBeatIds.some((id: string) => !combined.includes(id))) {
                    throw new Error("原场次节拍必须无重复、无遗漏地拆分到 sourceScenePatch.beat_ids 与 newScene.beat_ids");
                }
                const beatSet = new Set(movedBeatIds);
                const retainedBeatSet = new Set(retainedBeatIds);
                for (const shot of allShots.filter(item => entry.shotIds.includes(String(item.id || "")))) {
                    const allowedBeats = movedIds.has(String(shot.id || "")) ? beatSet : retainedBeatSet;
                    if ((Array.isArray(shot.story_beat_ids) ? shot.story_beat_ids : []).some((id: unknown) => !allowedBeats.has(String(id)))) throw new Error(`镜头 ${String(shot.id)} 的 story_beat_ids 与拆分后的场次 beat_ids 不一致`);
                }
            }
            const segments = clipRows(source.segments);
            for (const segment of segments) {
                const members = (Array.isArray(segment.shot_ids) ? segment.shot_ids : []).map(String);
                const movedCount = members.filter((id: string) => movedIds.has(id)).length;
                if (movedCount > 0 && movedCount !== members.length) throw new Error(`待迁镜头会拆开 Clip ${String(segment.id || "")}; 请先调整 Clip 边界`);
            }
            Object.assign(originalRow, op.sourceScenePatch);
            const originalIndex = scriptScenes.findIndex(row => String(row.id || "") === String(originalRow.id || ""));
            source.script_scenes = [...scriptScenes.slice(0, originalIndex + 1), structuredClone(op.newScene), ...scriptScenes.slice(originalIndex + 1)];
            source.shots = allShots.map(shot => {
                if (!movedIds.has(String(shot.id || ""))) return shot;
                const usages = clipRows(shot.subject_usages);
                const priorEnvironmentUsage = usages.find(usage => {
                    const subject = subjects.find(row => String(row.id || "") === String(usage.subjectId || ""));
                    return subject?.entityRef?.kind === "scene" && (Array.isArray(usage.referencePurpose) ? usage.referencePurpose : []).map(String).includes("environment");
                });
                const nextUsage = { ...(priorEnvironmentUsage || {}), subjectId: op.environmentSubjectId, presentation: "state_context",
                    pictureBindingMode: "explicit", pictureBindingIds: [op.environmentPictureBindingId], referencePurpose: ["environment"],
                    continuityFactIds: [], stateRequirements: [] };
                const resolvedEnvironment = resolveSubjectPictureBindingIds(environmentSubject, nextUsage);
                if (resolvedEnvironment.issues.length || !resolvedEnvironment.bindingIds.includes(op.environmentPictureBindingId)) {
                    throw new Error(`新环境图片绑定无法用于镜头 ${String(shot.id)}：${resolvedEnvironment.issues.join("；") || "指定绑定未解析"}`);
                }
                const nextUsages = usages.filter(usage => usage !== priorEnvironmentUsage);
                nextUsages.push(nextUsage);
                const oldEnvironmentSubjectId = priorEnvironmentUsage ? String(priorEnvironmentUsage.subjectId || "") : "";
                const keyframes = clipRows(shot.keyframes).map(frame => {
                    const mapping = record(frame.subjectPictureBindingIds);
                    if (oldEnvironmentSubjectId && Array.isArray(mapping[oldEnvironmentSubjectId])) {
                        const next = { ...mapping };
                        delete next[oldEnvironmentSubjectId];
                        next[op.environmentSubjectId] = [op.environmentPictureBindingId];
                        return { ...frame, subjectPictureBindingIds: next };
                    }
                    return frame;
                });
                return { ...shot, source_scene_id: op.newScene.id, scene_id: op.newScene.scene_id, subject_usages: nextUsages, keyframes };
            });
            const oldBlocks = Array.isArray(originalRow.blocks) ? originalRow.blocks : [originalRow];
            const oldBlockIds = new Set(oldBlocks.map((block: Record<string, any>) => String(block.id || "")).filter(Boolean));
            const anchorRemap = new Map<string, string>();
            if (!incomingBlocks.length) anchorRemap.set(String(originalRow.id || ""), String(op.newScene.id));
            for (const oldBlock of oldBlocks) {
                const oldBlockId = String(oldBlock.id || "");
                if (!oldBlockId || oldBlockId === String(originalRow.id || "") && !incomingBlocks.length) continue;
                const oldBeats = new Set(Array.isArray(oldBlock.beat_ids) ? oldBlock.beat_ids.map(String) : []);
                if (!oldBeats.size) continue;
                const matches = incomingBlocks.filter((block: Record<string, any>) => Array.isArray(block.beat_ids) && block.beat_ids.some((id: unknown) => oldBeats.has(String(id))));
                if (matches.length === 1) anchorRemap.set(oldBlockId, String(matches[0].id || ""));
            }
            for (const event of clipRows(source.ledger?.events)) {
                if (!movedIds.has(String(event.shot_id || ""))) continue;
                const anchor = record(event.source_anchor), oldBlockId = String(anchor.block_id || "");
                if (!oldBlockId || !oldBlockIds.has(oldBlockId)) continue;
                if (!anchorRemap.has(oldBlockId)) throw new Error(`连续性事件 ${String(event.id || "")} 的来源正文块 ${oldBlockId} 无法映射到新场次正文块`);
                event.source_anchor = { ...anchor, block_id: anchorRemap.get(oldBlockId) };
            }
            const story = record(source.story);
            if (Array.isArray(story.beats)) story.beats = story.beats.map((beat: Record<string, any>) => movedBeatIds.includes(String(beat.id || ""))
                ? { ...beat, scene_id: op.newScene.scene_id }
                : beat);
            const ledger = record(source.ledger);
            const digestSceneBlock = (scene: Record<string, any>) => {
                const block = { ...scene };
                for (const key of Object.keys(block)) if (key.startsWith("display_") || ["note", "notes", "color", "layout", "bounds", "collapsed", "hidden"].includes(key)) delete block[key];
                if (typeof block.text === "string") block.text = block.text.replace(/\r\n?/g, "\n").split("\n").map((line: string) => line.replace(/[ \t]+$/g, "")).join("\n").trim();
                return crypto.createHash("sha256").update(canonicalProduction({ scene_id: String(scene.scene_id || scene.id || ""), block })).digest("hex");
            };
            if (Array.isArray(ledger.coverage)) {
                const movedEventIds = new Set(clipRows(ledger.events).filter(event => movedIds.has(String(event.shot_id || ""))).map(event => String(event.id || "")));
                const retainedEventIds = new Set(clipRows(ledger.events).filter(event => !movedIds.has(String(event.shot_id || ""))).map(event => String(event.id || "")));
                const rows: Record<string, any>[] = [];
                for (const coverage of clipRows(ledger.coverage)) {
                    if (String(coverage.source_anchor?.block_id || "") !== String(originalRow.id || "")) { rows.push(coverage); continue; }
                    const coverageShots = Array.isArray(coverage.shot_ids) ? coverage.shot_ids.map(String) : [];
                    const retainedShots = coverageShots.filter((id: string) => !movedIds.has(id));
                    const movedShots = coverageShots.filter((id: string) => movedIds.has(id));
                    const retainedEvents = Array.isArray(coverage.event_ids) ? coverage.event_ids.filter((id: unknown) => retainedEventIds.has(String(id))) : coverage.event_ids;
                    const movedEvents = Array.isArray(coverage.event_ids) ? coverage.event_ids.filter((id: unknown) => movedEventIds.has(String(id))) : coverage.event_ids;
                    if (retainedShots.length) rows.push({ ...coverage, source_digest: digestSceneBlock(originalRow), shot_ids: retainedShots, event_ids: retainedEvents });
                    if (movedShots.length) {
                        const anchorBlockId = incomingBlocks.length ? String(anchorRemap.get(String(originalRow.id || "")) || "") : String(op.newScene.id);
                        if (!anchorBlockId) throw new Error(`连续性覆盖 ${String(coverage.id || "")} 无法映射到新场次正文块`);
                        rows.push({ ...coverage, id: retainedShots.length ? `${String(coverage.id || "COV")}:${String(op.newScene.id)}` : coverage.id,
                            source_anchor: { ...record(coverage.source_anchor), block_id: anchorBlockId }, source_digest: digestSceneBlock(op.newScene), shot_ids: movedShots, event_ids: movedEvents });
                    }
                    if (!retainedShots.length && !movedShots.length) rows.push(coverage);
                }
                ledger.coverage = rows;
            }
            director.sourceHash = directorHash(source);
            director.executionAuthorized = false;
            director.artifacts = director.artifacts.map(artifact => ({ ...artifact, status: "stale" as const }));
            if (director.workflow.currentWork) director.workflow.currentWork = { ...director.workflow.currentWork, sourceHash: director.sourceHash };
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
        // 允许外部 Agent（MCP 调用方）在 Acheng 制作稿存在时也直接修改投影，不再强制要求走 set_director_production。
        // if (draft.director && !["set_settings", "set_keyframe", "review_keyframe"].includes(op.type)) {
        //     throw new Error("Acheng 制作稿是正式源；请通过 set_director_production 修改对应源字段并重新编译，不能单独修改投影");
        // }
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
            const group = draft.clipGroups.find(item => item.id === op.id);
            if (!group) throw new Error(`Clip ${op.id} 不存在`);
            const shotIds = new Set(group.shotIds);
            draft.clipGroups = draft.clipGroups.filter((item) => item.id !== op.id);
            draft.shots = draft.shots.filter(item => !shotIds.has(item.id));
            for (const shotId of shotIds) { delete draft.keyframes[shotId]; delete draft.keyframeReviews[shotId]; }
        } else if (op.type === "set_settings") {
            draft.settings = { ...draft.settings, ...op.patch };
            if (draft.director && Object.hasOwn(op.patch, "storyboardImageMode")) projectDirector(draft);
        } else if (op.type === "review_keyframe") {
            if (!draft.keyframes[op.shotId]?.storageKey) throw new Error("关键帧没有可访问媒体");
            draft.keyframeReviews[op.shotId] = { verdict: op.verdict, evidence: op.evidence, sourceVersion };
        }
    }

    private assertCurrentDirectorFormat(director: DirectorProduction) {
        const diagnostics = schemaDiagnostics(directorProductionSchema, director, "director");
        if (diagnostics.length) throw new ProductionValidationError(diagnostics);
    }

    private validateGraph(draft: EpisodeProductionData) {
        if (draft.director) {
            this.assertCurrentDirectorFormat(draft.director);
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
            return artifact ? { prompt: artifact.sha256, references: artifact.references.map(ref => [ref.label, ref.nodeId || "", ref.bindingId || "", ref.assetId || "", ref.storageKey, ref.sha256, ref.role]) } : null;
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

const SOURCE_LIFECYCLE_COLLECTIONS: Record<string, string> = {
    scene: "script_scenes", environment: "scene_registry", character: "character_registry",
    asset: "asset_plan", asset_card: "asset_cards", shot: "shots", segment: "segments", subject: "subject_registry",
};
function sourceLifecycleCollection(entity: string) { return SOURCE_LIFECYCLE_COLLECTIONS[entity]; }
function sourceLifecycleEntries(value: unknown) {
    const source = record(value);
    const entries: Array<{ entityType: string; entityId: string; value: Record<string, unknown> }> = [];
    for (const [entityType, collection] of Object.entries(SOURCE_LIFECYCLE_COLLECTIONS)) {
        const items = Array.isArray(source[collection]) ? source[collection] as Array<Record<string, unknown>> : [];
        for (const item of items) {
            const entityId = String(item.id || item.scene_id || item.asset_id || "");
            if (entityId) entries.push({ entityType, entityId, value: item });
        }
    }
    return entries;
}

function syncSharedEntityEdits(db: BackendDatabase, before: EpisodeProductionData, after: EpisodeProductionData, episodeId: string, originatingProjectId: string, operationId: string, commits: CanvasCommit[]) {
    if (!before.director || !after.director) return;
    const owner = { kind: "episode", id: episodeId };
    const previous = new Map(productionEntities(before.director.source, owner).map(entity => [`${entity.kind}:${entity.entityId}`, entity]));
    const oldPlans = new Map((Array.isArray(before.director.source.asset_plan) ? before.director.source.asset_plan as Array<Record<string, any>> : []).map(plan => [String(plan.id || plan.asset_id || ""), plan]));
    const nextPlans = Array.isArray(after.director.source.asset_plan) ? after.director.source.asset_plan as Array<Record<string, any>> : [];
    const operations = new Map<string, CanvasOperation[]>();
    for (const entity of productionEntities(after.director.source, owner)) {
        const prior = previous.get(`${entity.kind}:${entity.entityId}`);
        if (!prior || prior.name === entity.name && prior.description === entity.description) continue;
        const plan = nextPlans.find(item => entity.assetIds.includes(String(item.id || item.asset_id || "")) && item.sharedSource);
        const oldPlan = plan ? oldPlans.get(String(plan.id || plan.asset_id || "")) : undefined;
        const source = plan?.sharedSource as Record<string, string> | undefined;
        if (!source || !oldPlan?.sharedSource || source.sourceProjectId !== oldPlan.sharedSource.sourceProjectId || source.sourceNodeId !== oldPlan.sharedSource.sourceNodeId) continue;
        const projectId = source.sourceProjectId, project = db.getCanvasProject(projectId);
        const node = (project?.nodes as Array<Record<string, any>> || []).find(item => item.id === source.sourceNodeId);
        if (!node || node.type !== entity.kind) throw new Error("共享资产源节点已不存在或类型已变化");
        const metadata = node.metadata || {}, nameKey = `${entity.kind}Name`, descriptionKey = `${entity.kind}Description`;
        const currentName = String(metadata[nameKey] || node.title || ""), currentDescription = String(metadata[descriptionKey] || "");
        if (prior.name !== currentName && entity.name !== currentName) throw new Error("共享资产名称已被其他修改更新，请回读后重试");
        if (prior.description !== currentDescription && entity.description !== currentDescription) throw new Error("共享资产描述已被其他修改更新，请回读后重试");
        const patch: CanvasOperation = { type: "update_node", id: node.id,
            ...(entity.name !== currentName ? { patch: { title: entity.name } } : {}),
            metadata: { ...(entity.name !== currentName ? { [nameKey]: entity.name } : {}), ...(entity.description !== currentDescription ? { [descriptionKey]: entity.description } : {}) } };
        const group = operations.get(projectId) || [];
        group.push(patch); operations.set(projectId, group);
    }
    for (const [projectId, ops] of operations) db.applyCanvasProjectOperations(projectId, undefined, ops, {
        operationId: `${operationId}:shared-entity-edit:${projectId}`, runtimeWrite: true, withinTransaction: true, deferredCommits: commits,
        originatingProjectId, source: { kind: "system", clientId: "system:shared-library", label: "同步分集共享资产编辑" },
    });
}
function reorder<T extends { id: string }>(items: T[], ids: string[]) {
    if (ids.length !== items.length || new Set(ids).size !== ids.length || ids.some((id) => !items.some((item) => item.id === id))) throw new Error("排序列表必须恰好包含当前全部 ID");
    return ids.map((id) => items.find((item) => item.id === id)!);
}
function orderShotsByScene(draft: EpisodeProductionData) {
    return draft.scenes.flatMap((scene) => draft.shots.filter((shot) => shot.sceneId === scene.id));
}
