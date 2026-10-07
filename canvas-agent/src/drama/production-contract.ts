import { z } from "zod";
import { isH3StyleTemplateId } from "../plugins/minimax-h3/style-templates.js";
export { productionSceneEntries, productionScriptGroups } from "./production-directory.js";
export { productionWorkspaceSchemas, productionWorkspaceDescriptions, productionWorkspaceToolNames, productionWorkspaceRequest } from "./production-workspace-contract.js";
export { productionToolPreflightRequest, productionToolPreflight } from "./production-tool-preflight.js";

const id = z.string().trim().min(1);

export const productionContractVersion = "2";
export const productionLayoutPointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
export const productionLayoutSizeSchema = z.object({ width: z.number().positive().finite(), height: z.number().positive().finite() });
export const productionLayoutRoleSchema = z.enum(["asset", "script", "scene", "keyframe", "prompt", "video"]);
export const productionLayoutMemberSchema = z.object({
    role: productionLayoutRoleSchema, nodeId: id, nodeType: id, position: productionLayoutPointSchema, size: productionLayoutSizeSchema,
});
export const productionLayoutUnitSchema = z.object({
    id, area: productionLayoutRoleSchema, targets: z.array(id), sceneId: id.optional(),
    bounds: z.object({ position: productionLayoutPointSchema, size: productionLayoutSizeSchema }), members: z.array(productionLayoutMemberSchema),
    status: z.enum(["reserved", "materialized"]),
});
export const productionLayoutRegionSchema = z.object({ id, area: productionLayoutRoleSchema, bounds: z.object({ position: productionLayoutPointSchema, size: productionLayoutSizeSchema }) });
export const productionLayoutPlanSchema = z.object({
    schemaVersion: z.number().int().positive(), algorithmVersion: id, canvasId: id, owner: z.object({ kind: z.enum(["canvas", "episode", "scene"]), id }),
    structureHash: z.string().regex(/^[a-f0-9]{64}$/), geometryHash: z.string().regex(/^[a-f0-9]{64}$/),
    planHash: z.string().regex(/^[a-f0-9]{64}$/), regions: z.array(productionLayoutRegionSchema), units: z.array(productionLayoutUnitSchema),
    diagnostics: z.array(z.object({ code: id, target: id.optional(), message: z.string() })),
});
export type ProductionLayoutMember = z.infer<typeof productionLayoutMemberSchema>;
export type ProductionLayoutUnit = z.infer<typeof productionLayoutUnitSchema>;
export type ProductionLayoutPlan = z.infer<typeof productionLayoutPlanSchema>;
export type ProductionLayoutReceipt = {
    planHash: string; algorithmVersion: string; canvasRevision: number; created: Array<{ target: string; nodeIds: string[] }>;
    reused: Array<{ target: string; nodeIds: string[] }>; diagnostics: Array<{ code: string; target?: string; message: string }>;
};
export const directorPatchFields = {
    brief: ["value"],
    continuity: ["ledger"],
    style: ["style_policy", "style_policy_reason", "anchor_asset_id"],
    scene: ["scene_name", "heading", "location", "time_of_day", "text"],
    asset: ["asset_name", "name", "title", "kind", "description", "prompt", "depends_on", "role", "version", "reference_role", "canvas_scope"],
    shot: ["title", "visual", "camera", "start_frame", "end_frame", "dialogues", "audio", "required_assets", "description", "shot_type", "timeline_id", "story_order", "continuity_facts"],
    segment: ["shot_ids", "start_frame", "end_frame", "generation_clip_duration", "mode", "audio", "sound", "overall_soundscape", "non_diegetic_music", "references", "execution_gate", "styleTemplateId"],
} as const;

export const directorModules = ["story", "assets", "shots", "performance", "effects", "model", "continuity"] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const directorBoundarySchema = z.object({ from: id, to: id, tailFrame: z.boolean(), motionContext: z.boolean(), reason: z.string() });
export const sharedAssetSourceSchema = z.object({ dramaId: id, assetId: id, approvedId: id, sourceProjectId: id, sourceNodeId: id });
export const directorCurrentWorkSchema = z.object({
    workId: id,
    module: z.enum(directorModules),
    action: z.enum(["author", "compile", "produce", "review", "deliver", "blocked"]),
    targetKind: z.enum(["story", "scene", "asset", "keyframe", "shot", "segment"]).optional(),
    targetId: id.optional(),
    inputRevision: z.number().int().nonnegative(),
    sourceHash: hash.optional(),
    runId: id.optional(),
    taskId: id.optional(),
}).passthrough();
export const directorDecisionSchema = z.object({
    id,
    workId: id,
    module: z.enum(directorModules),
    targetKind: z.enum(["story", "scene", "asset", "keyframe", "shot", "segment"]).optional(),
    targetId: id.optional(),
    prompt: z.string().trim().min(1),
    choices: z.array(z.string().trim().min(1)).min(2),
    sourceHash: hash,
    allowFreeText: z.boolean().default(false),
    status: z.enum(["pending", "answered"]).default("pending"),
    answer: z.string().optional(),
    sourceRevision: z.number().int().nonnegative(),
}).passthrough();
export const directorReviewPolicySchema = z.object({
    mode: z.enum(["automatic", "mixed", "manual"]),
    shared: z.enum(["automatic", "manual"]),
    scene: z.enum(["automatic", "manual"]),
}).strict().superRefine((policy, context) => {
    if (policy.mode !== "mixed" && (policy.shared !== policy.mode || policy.scene !== policy.mode)) context.addIssue({ code: "custom", message: "审核预设与审核点配置不一致" });
});
export const directorSceneReviewSchema = z.object({
    sourceHash: hash, inputHash: hash, mediaInputHash: hash.optional(), verdict: z.enum(["approved", "rejected", "needs_human"]),
    mode: z.enum(["automatic", "manual"]), evidence: z.string().trim().min(1),
    media: z.array(z.object({ targetId: id, storageKey: id, sha256: hash })),
    checkedAt: z.string().datetime(),
}).strict();
const directorEngineSchema = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), patchVersion: id, runtimeId: id, version: id });
export const directorSceneWorkSchema = z.object({
    workId: id, sceneId: id, inputRevision: z.number().int().nonnegative(), sourceHash: hash, inputHash: hash,
    inputEngine: directorEngineSchema.optional(),
    status: z.enum(["pending", "running", "awaiting_media", "awaiting_review", "blocked", "failed", "paused", "succeeded"]),
    stage: z.enum(["create", "assets", "review", "compile", "produce", "complete"]),
    agentTurnId: id.optional(), recoveryPending: z.boolean().optional(), agentThreadId: id.optional(), compilationId: id.optional(), runIds: z.array(id).default([]),
    workPackage: z.record(z.unknown()).optional(), workArtifacts: z.array(z.record(z.unknown())).optional(),
    workAdoptions: z.record(hash, z.object({ operationId: id, revision: z.number().int().nonnegative(), sourceHash: hash, opsHash: hash, artifactHash: hash }).strict()).optional(),
    reviewPackages: z.record(id, z.record(z.unknown())).optional(), reviewArtifacts: z.array(z.record(z.unknown())).optional(),
    artifactIds: z.array(id).default([]), cursor: z.string().optional(), error: z.string().nullable().optional(),
    review: directorSceneReviewSchema.optional(), assetReviews: z.array(directorSceneReviewSchema).optional(), policy: directorReviewPolicySchema,
    model: z.string().optional(), effort: z.string().optional(), updatedAt: z.string().datetime(),
    generationAuthorized: z.boolean().default(false),
}).strict();
export type DirectorSharedReviewWork = Omit<z.infer<typeof directorSceneWorkSchema>, "sceneId" | "stage" | "runIds" | "artifactIds" | "cursor" | "generationAuthorized" | "assetReviews"> & { assetIds?: string[] };
export const directorSharedReviewWorkSchema: z.ZodType<DirectorSharedReviewWork> = directorSceneWorkSchema.omit({ sceneId: true, stage: true, runIds: true, artifactIds: true, cursor: true, generationAuthorized: true, assetReviews: true }).extend({ assetIds: z.array(id).optional() });
export const directorWorkflowSchema = z.object({
    contentDeliveryMode: z.enum(["auto_file_batch", "interactive_segment"]).optional(),
    mediaProductionMode: z.enum(["prompt_only", "per_item", "automatic"]).optional(),
    agentThreadId: id.optional(),
    currentWork: directorCurrentWorkSchema.optional(),
    pendingDecisions: z.array(directorDecisionSchema).optional(),
    sceneWorks: z.record(id, directorSceneWorkSchema).optional(),
    sharedReview: directorSceneReviewSchema.optional(),
    sharedReviewWorks: z.record(id, directorSharedReviewWorkSchema).optional(),
    sharedAssetReviews: z.array(directorSceneReviewSchema).optional(),
    sharedReviewContinuation: z.object({ authorizationId: id, contextHash: hash, status: z.enum(["active", "awaiting_review", "paused", "complete"]), policy: directorReviewPolicySchema, model: z.string().optional(), effort: z.string().optional(), error: z.string().nullable().optional(), updatedAt: z.string().datetime() }).strict().optional(),
}).passthrough();
export const directorProductionSchema = z.object({
    schemaVersion: z.literal(1),
    engine: directorEngineSchema,
    // Preserve every upstream field; Canvas does not maintain a second creative compiler.
    source: z.record(z.unknown()).superRefine((source, context) => {
        if (Array.isArray(source.segments)) source.segments.forEach((segment, index) => {
            if (segment && typeof segment === "object" && Object.hasOwn(segment, "styleTemplateId") && segment.styleTemplateId !== null && !isH3StyleTemplateId(segment.styleTemplateId)) context.addIssue({ code: "custom", path: ["segments", index, "styleTemplateId"], message: "未知 H3 风格模板，使用已登记的模板 ID 或 null" });
        });
    }),
    sourceHash: hash,
    modules: z.record(z.enum(directorModules), z.object({ status: z.enum(["planned", "partial", "committed", "blocked"]), cursor: z.unknown().optional(), evidence: z.array(z.string()).default([]), unresolved: z.array(z.string()).default([]) })),
    artifacts: z.array(z.object({
        id, kind: z.enum(["image", "h3"]), targetId: id, prompt: z.string().min(1), sha256: hash, sourceHash: hash,
        status: z.enum(["draft", "ready", "stale"]),
        references: z.array(z.object({ label: id, nodeId: id, storageKey: id, sha256: hash, role: id }).passthrough()),
        receipt: z.object({ sourceHash: hash, promptHash: hash, engineRuntimeId: id, validator: id }).passthrough(),
    })),
    // Planning drafts may precede canvas node creation and asset approval.
    assets: z.record(id, z.object({ nodeId: id.optional(), assetId: z.string().optional(), storageKey: z.string().optional(), generationTaskId: id.optional(), sha256: hash.optional(), version: id, status: z.enum(["planned", "generated", "approved", "rejected"]), evidence: z.string().optional(), sharedSource: sharedAssetSourceSchema.optional(), inputOutdated: z.boolean().optional() }).passthrough()),
    shotInputs: z.record(id, z.object({ keyframePolicy: z.enum(["new", "reuse", "none"]).default("none"), assetIds: z.array(id).default([]), keyframeAssetId: id.optional() }).passthrough()),
    boundaries: z.array(directorBoundarySchema),
    executionAuthorized: z.boolean().default(false),
    unresolved: z.array(z.string()).default([]),
    workflow: directorWorkflowSchema.default({}),
}).passthrough();
export type DirectorProduction = z.infer<typeof directorProductionSchema>;
export const productionCompilationScopeSchema = z.object({ sceneId: id.optional(), targetIds: z.array(id).min(1).optional() }).strict().refine(scope => Boolean(scope.sceneId || scope.targetIds?.length), "编译范围不能为空");
export const productionCompileSchema = z.object({ operationId: id.optional(), expectedRevision: z.number().int().nonnegative(), director: directorProductionSchema.optional(), scope: productionCompilationScopeSchema.optional() }).strict();
export const productionApplyCompilationSchema = z.object({ preparedId: z.string().uuid() }).strict();
export { productionReadSchema, productionReadQuery, projectProductionRead, projectProductionVersion, productionWriteReceipt } from "./production-read.js";

/** Stable wire hashing input shared by offline adapters and Backend. */
export function canonicalProduction(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalProduction).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalProduction(v)}`).join(",")}}`;
    return JSON.stringify(value);
}

export const scriptBlockSchema = z.object({
    id,
    kind: z.enum(["action", "dialogue"]),
    text: z.string(),
    speaker: z.string().optional(),
});

export const productionSceneSchema = z.object({
    id,
    heading: z.string(),
    location: z.string(),
    timeOfDay: z.string(),
    blocks: z.array(scriptBlockSchema),
});

export const productionShotSchema = z.object({
    id,
    sceneId: id,
    title: z.string(),
    duration: z.number().finite().min(0),
    visual: z.string(),
    camera: z.string(),
    openingState: z.string(),
    endingState: z.string(),
    sound: z.string(),
    assetNodeIds: z.array(id),
    keyframePolicy: z.enum(["new", "reuse", "none"]),
});

export const clipGroupSchema = z.object({
    id,
    shotIds: z.array(id).min(1),
    nodeId: id.nullable(),
    segmentId: id.nullable(),
    sourceVersion: z.number().int().min(0),
    continuityReason: z.string().optional(),
    inputOutdated: z.boolean().optional(),
    selectedResult: z.object({ generationLogId: id, taskId: id, sourceVersion: z.number().int().min(1), sourceHash: hash, sourceNodeId: id.optional() }).optional(),
});

export const productionSettingsSchema = z.object({
    parallelScenes: z.boolean().optional(),
    reviewPolicy: directorReviewPolicySchema.optional(),
    videoAspectRatio: z.string().regex(/^[1-9]\d*:[1-9]\d*$/).nullable().optional(),
    videoAspectRatioConfirmed: z.boolean().optional(),
    storyboardImageMode: z.enum(["generate", "skip"]).optional(),
    mode: z.enum(["manual", "auto"]),
    imageModel: z.string(),
    h3Model: z.string(),
    imageModels: z.record(id, z.string()).default({}),
    imageModelsByKind: z.object({ character: z.string().optional(), scene: z.string().optional(), prop: z.string().optional(), style: z.string().optional(), keyframe: z.string().optional() }).default({}),
    h3Models: z.record(id, z.string()).default({}),
    // Retain legacy budgets when reading old drafts; execution no longer uses them.
    imageQuota: z.number().int().min(0).nullable().optional(),
    h3Quota: z.number().int().min(0).nullable().optional(),
});

export const dramaProductionPlanSchema = z.object({
    parallelScenes: productionSettingsSchema.shape.parallelScenes,
    reviewPolicy: productionSettingsSchema.shape.reviewPolicy,
    requirements: z.string().default(""),
    imageModel: z.string().default(""),
    imageModelsByKind: productionSettingsSchema.shape.imageModelsByKind,
    h3Model: z.string().default(""),
    videoAspectRatio: productionSettingsSchema.shape.videoAspectRatio,
    storyboardImageMode: productionSettingsSchema.shape.storyboardImageMode,
    confirmedOutline: z.string().default(""),
    confirmedAt: z.string().datetime().optional(),
}).strict();
export type DramaProductionPlan = z.infer<typeof dramaProductionPlanSchema>;

/** Individual overrides take precedence over asset-category defaults and the general image model. */
export function productionImageModel(settings: { imageModel?: unknown; imageModels?: Record<string, unknown>; imageModelsByKind?: Record<string, unknown> }, source: Record<string, any>, targetId: string, fallbackKind?: "keyframe"): string {
    const plan = Array.isArray(source.asset_plan) ? source.asset_plan : [];
    const item = plan.find((asset: any) => String(asset.asset_id || asset.id) === targetId);
    const kind = String(item?.kind || fallbackKind || (Array.isArray(source.shots) && source.shots.some((shot: any) => shot.id === targetId) ? "keyframe" : "")).toLowerCase();
    const category = ["character", "costume", "outfit", "role"].includes(kind) ? "character" : ["scene", "environment"].includes(kind) ? "scene" : ["prop", "object"].includes(kind) ? "prop" : ["style", "style_mother"].includes(kind) ? "style" : ["keyframe", "storyboard", "frame"].includes(kind) ? "keyframe" : undefined;
    return [settings.imageModels?.[targetId], category ? settings.imageModelsByKind?.[category] : "", settings.imageModel].find((model): model is string => typeof model === "string" && Boolean(model)) || "";
}

export const episodeProductionDataSchema = z.object({
    director: directorProductionSchema.optional(),
    scenes: z.array(productionSceneSchema),
    shots: z.array(productionShotSchema),
    keyframes: z.record(id, z.object({ nodeId: id, storageKey: z.string(), sourceVersion: z.number().int().min(0) })),
    keyframeReviews: z.record(id, z.object({ verdict: z.enum(["auto-accepted", "needs-redo", "approved", "rejected"]), evidence: z.string(), sourceVersion: z.number().int().min(0) })),
    clipGroups: z.array(clipGroupSchema),
    settings: productionSettingsSchema,
    legacyImports: z.array(z.object({ source: z.enum(["fullPlot", "script.md", "storyboard.md"]), sha256: z.string(), text: z.string(), importedAt: z.string() })),
});

export const productionOperationSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("set_director_production"), director: directorProductionSchema }).strict(),
    z.object({ type: z.literal("set_director_brief"), brief: z.string() }).strict(),
    z.object({ type: z.literal("patch_director_source"), entity: z.enum(["brief", "style", "scene", "asset", "shot", "segment"]), id: id.optional(), patch: z.record(z.unknown()) }).strict(),
    z.object({ type: z.literal("adopt_director_fields"), targetId: id, nodeId: id, segmentId: id.optional(), canvasRevision: z.number().int().nonnegative(), fields: z.array(id).min(1) }).strict(),
    z.object({ type: z.literal("adopt_director_clip_style"), targetId: id, nodeId: id, segmentId: id, canvasRevision: z.number().int().nonnegative(), styleTemplateId: z.string().nullable() }).strict(),
    z.object({ type: z.literal("patch_director_continuity"), ledger: z.record(z.unknown()) }).strict(),
    z.object({ type: z.literal("upgrade_director_continuity"), fromSourceHash: hash, previewRevision: z.number().int().nonnegative(), previewHash: hash, toRuntimeId: id, ledger: z.record(z.unknown()) }).strict(),
    z.object({ type: z.literal("set_director_workflow"), patch: directorWorkflowSchema.partial() }).strict(),
    z.object({ type: z.literal("bind_director_asset"), assetId: id, nodeId: id }).strict(),
    z.object({ type: z.literal("adopt_shared_asset"), assetId: id, approvedId: id, nodeId: id }).strict(),
    z.object({ type: z.literal("bind_director_segment"), targetId: id, nodeId: id, segmentId: id }).strict(),
    z.object({ type: z.literal("set_director_boundary"), boundary: directorBoundarySchema }).strict(),
    z.object({ type: z.literal("set_director_segment_group"), segmentId: id, shotIds: z.array(id).min(1), removeSegmentIds: z.array(id).default([]) }).strict(),
    z.object({ type: z.literal("review_director_asset"), assetId: id, version: z.number().int().min(0), sourceHash: hash, nodeId: id, storageKey: id, sha256: hash, verdict: z.enum(["approved", "rejected"]), evidence: z.string().trim().min(1) }).strict(),
    z.object({ type: z.literal("select_director_result"), targetKind: z.enum(["asset", "keyframe", "segment"]), targetId: id, nodeId: id, generationLogId: id, storageKey: id, canvasRevision: z.number().int().nonnegative() }).strict(),
    z.object({ type: z.literal("restore_archived_scene_results"), sourceNodeId: id, expectedCanvasRevision: z.number().int().nonnegative() }).strict(),
    z.object({ type: z.literal("upsert_scene"), scene: productionSceneSchema }).strict(),
    z.object({ type: z.literal("delete_scene"), id }).strict(),
    z.object({ type: z.literal("reorder_scenes"), ids: z.array(id) }).strict(),
    z.object({ type: z.literal("upsert_script_block"), sceneId: id, block: scriptBlockSchema, beforeBlockId: id.optional() }).strict(),
    z.object({ type: z.literal("delete_script_block"), sceneId: id, id }).strict(),
    z.object({ type: z.literal("reorder_script_blocks"), sceneId: id, ids: z.array(id) }).strict(),
    z.object({ type: z.literal("upsert_shot"), shot: productionShotSchema }).strict(),
    z.object({ type: z.literal("delete_shot"), id }).strict(),
    z.object({ type: z.literal("reorder_shots"), sceneId: id, ids: z.array(id) }).strict(),
    z.object({ type: z.literal("set_keyframe"), shotId: id, nodeId: id.nullable() }).strict(),
    z.object({ type: z.literal("set_clip_group"), group: clipGroupSchema }).strict(),
    z.object({ type: z.literal("delete_clip_group"), id }).strict(),
    z.object({ type: z.literal("set_settings"), patch: productionSettingsSchema.partial() }).strict(),
    z.object({ type: z.literal("import_legacy"), source: z.enum(["fullPlot", "script.md", "storyboard.md"]) }).strict(),
    z.object({ type: z.literal("review_keyframe"), shotId: id, verdict: z.enum(["auto-accepted", "needs-redo"]), evidence: z.string().min(1) }).strict(),
]);

export const productionEditSchema = z.object({ operationId: id, expectedRevision: z.number().int().min(0), ops: z.array(productionOperationSchema).min(1), adoptions: z.array(z.object({ taskId: id, artifactHash: hash }).strict()).min(1).optional() }).strict();
export const productionPublishSchema = z.object({ operationId: id, expectedRevision: z.number().int().min(0), stage: z.enum(["script", "shots", "director"]), scope: productionCompilationScopeSchema.optional() }).strict();
export const directorRunStartSchema = z.object({ runId: id, idempotencyKey: id, workId: id.optional(), expectedRevision: z.number().int().min(0), version: z.number().int().min(0).default(0), inputBasis: z.enum(["canvas", "published"]).default("canvas"), expectedCanvasRevision: z.number().int().nonnegative().optional(), expectedPlanHash: hash.optional(), targets: z.array(id).min(1), scope: z.enum(["selected", "all_ready"]).default("selected") }).strict();
export const directorRunControlSchema = z.object({ runId: id }).strict();
export const productionContractQuerySchema = z.object({ runtimeId: id.optional().describe("Deprecated: accepted for compatibility; the contract always uses the locally active Acheng runtime."), operationType: id.optional(), moduleId: z.enum(directorModules).optional() }).strict();
export const productionContinuityReadSchema = z.object({ snapshot: z.enum(["draft", "published"]).default("draft"), view: z.enum(["summary", "issues", "timeline", "shot"]).default("summary"), targetId: id.optional(), objectId: id.optional(), pageSize: z.coerce.number().int().positive().optional(), cursor: z.string().optional() }).strict();
export const productionContinuityCheckSchema = z.object({ expectedRevision: z.number().int().nonnegative(), operationId: id, snapshot: z.enum(["draft", "published"]).default("draft"), targetIds: z.array(id).optional() }).strict();
export const productionContinuityUpgradePreviewSchema = z.object({ expectedRevision: z.number().int().nonnegative(), operationId: id, fromSourceHash: hash, ledger: z.record(z.unknown()) }).strict();
// Keep requests unparsed at this boundary so invalid inputs produce diagnostics,
// rather than disappearing into a transport-level schema error.
export const productionPreflightSchema = z.object({ action: z.enum(["edit", "publish", "compile", "generate"]), request: z.record(z.unknown()) }).strict();
export const productionPreflightRequestSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("edit"), request: productionEditSchema }),
    z.object({ action: z.literal("publish"), request: productionPublishSchema }),
    z.object({ action: z.literal("compile"), request: productionCompileSchema }),
    z.object({ action: z.literal("generate"), request: directorRunStartSchema }),
]);
export type ProductionNextAction = { action: "correct_source" | "refresh" | "configure" | "read_run" | "review" | "wait"; message: string; tool?: string; input?: Record<string, unknown> };
export type ProductionDiagnostic = { code: string; path: string; targetId?: string; message: string; severity: "error" | "warning" | "unverified"; example?: unknown; blockingRun?: { runId: string; status: string; taskIds: string[] }; nextAction?: ProductionNextAction };
export type ProductionPreflight = { readyTargets?: string[]; blockedTargets?: Array<{ targetId: string; code: string; message: string }>; warnings?: Array<{ targetId: string; code: string; message: string }>; planHash?: string; canvasRevision?: number; valid: boolean; contractVersion: string; engine: DirectorProduction["engine"] | null; revision: number | null; diagnostics: ProductionDiagnostic[]; generationReady: boolean; compileReady?: boolean; replayed?: boolean; nextActions?: ProductionNextAction[] };
export type DirectorRunStart = z.infer<typeof directorRunStartSchema>;

export type ProductionScene = z.infer<typeof productionSceneSchema>;
export type ProductionShot = z.infer<typeof productionShotSchema>;
export type EpisodeProductionData = z.infer<typeof episodeProductionDataSchema>;
export type ProductionOperation = z.infer<typeof productionOperationSchema>;
export type ProductionEdit = z.infer<typeof productionEditSchema>;
export type ProductionPublish = z.infer<typeof productionPublishSchema>;

export function emptyEpisodeProduction(): EpisodeProductionData {
    return { scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], settings: { mode: "manual", imageModel: "", h3Model: "", imageModels: {}, imageModelsByKind: {}, h3Models: {} }, legacyImports: [] };
}
