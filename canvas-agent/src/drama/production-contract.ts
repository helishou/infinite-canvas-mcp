import { z } from "zod";
export { productionSceneEntries } from "./production-directory.js";
export { productionWorkspaceSchemas, productionWorkspaceDescriptions, productionWorkspaceToolNames, productionWorkspaceRequest } from "./production-workspace-contract.js";

const id = z.string().trim().min(1);

export const productionContractVersion = "2";
export const directorPatchFields = {
    brief: ["value"],
    style: ["style_policy", "style_policy_reason", "anchor_asset_id"],
    scene: ["scene_name", "heading", "location", "time_of_day", "text"],
    asset: ["asset_name", "name", "title", "kind", "description", "prompt", "depends_on", "role", "version", "reference_role"],
    shot: ["title", "visual", "camera", "start_frame", "end_frame", "state_in", "state_out", "dialogues", "audio", "required_assets", "description", "shot_type"],
    segment: ["shot_ids", "start_frame", "end_frame", "generation_clip_duration", "mode", "audio", "sound", "overall_soundscape", "non_diegetic_music", "references", "execution_gate"],
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
export const directorWorkflowSchema = z.object({
    contentDeliveryMode: z.enum(["auto_file_batch", "interactive_segment"]).optional(),
    mediaProductionMode: z.enum(["prompt_only", "per_item", "automatic"]).optional(),
    agentThreadId: id.optional(),
    currentWork: directorCurrentWorkSchema.optional(),
    pendingDecisions: z.array(directorDecisionSchema).optional(),
}).passthrough();
export const directorProductionSchema = z.object({
    schemaVersion: z.literal(1),
    engine: z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), patchVersion: id, runtimeId: id, version: id }),
    // Preserve every upstream field; Canvas does not maintain a second creative compiler.
    source: z.record(z.unknown()),
    sourceHash: hash,
    modules: z.record(z.enum(directorModules), z.object({ status: z.enum(["planned", "partial", "committed", "blocked"]), cursor: z.unknown().optional(), evidence: z.array(z.string()).default([]), unresolved: z.array(z.string()).default([]) })),
    artifacts: z.array(z.object({
        id, kind: z.enum(["image", "h3"]), targetId: id, prompt: z.string().min(1), sha256: hash, sourceHash: hash,
        status: z.enum(["draft", "ready", "stale"]),
        references: z.array(z.object({ label: id, nodeId: id, storageKey: id, sha256: hash, role: id }).passthrough()),
        receipt: z.object({ sourceHash: hash, promptHash: hash, engineRuntimeId: id, validator: id }).passthrough(),
    })),
    // Planning drafts may precede canvas node creation and asset approval.
    assets: z.record(id, z.object({ nodeId: id.optional(), assetId: z.string().optional(), storageKey: z.string().optional(), sha256: hash.optional(), version: id, status: z.enum(["planned", "generated", "approved", "rejected"]), evidence: z.string().optional(), sharedSource: sharedAssetSourceSchema.optional(), inputOutdated: z.boolean().optional() }).passthrough()),
    shotInputs: z.record(id, z.object({ keyframePolicy: z.enum(["new", "reuse", "none"]).default("none"), assetIds: z.array(id).default([]), keyframeAssetId: id.optional() }).passthrough()),
    boundaries: z.array(directorBoundarySchema),
    executionAuthorized: z.boolean().default(false),
    unresolved: z.array(z.string()).default([]),
    workflow: directorWorkflowSchema.default({}),
}).passthrough();
export type DirectorProduction = z.infer<typeof directorProductionSchema>;
export const productionCompileSchema = z.object({ expectedRevision: z.number().int().nonnegative(), director: directorProductionSchema.optional() }).strict();
export const productionApplyCompilationSchema = z.object({ preparedId: z.string().uuid() }).strict();
export { productionReadSchema, productionReadQuery, projectProductionRead, productionWriteReceipt } from "./production-read.js";

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
});

export const productionSettingsSchema = z.object({
    videoAspectRatio: z.string().regex(/^[1-9]\d*:[1-9]\d*$/).nullable().optional(),
    videoAspectRatioConfirmed: z.boolean().optional(),
    mode: z.enum(["manual", "auto"]),
    imageModel: z.string(),
    h3Model: z.string(),
    imageModels: z.record(id, z.string()).default({}),
    h3Models: z.record(id, z.string()).default({}),
    // Retain legacy budgets when reading old drafts; execution no longer uses them.
    imageQuota: z.number().int().min(0).nullable().optional(),
    h3Quota: z.number().int().min(0).nullable().optional(),
});

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
    z.object({ type: z.literal("set_director_production"), director: directorProductionSchema }),
    z.object({ type: z.literal("set_director_brief"), brief: z.string() }),
    z.object({ type: z.literal("patch_director_source"), entity: z.enum(["brief", "style", "scene", "asset", "shot", "segment"]), id: id.optional(), patch: z.record(z.unknown()) }),
    z.object({ type: z.literal("set_director_workflow"), patch: directorWorkflowSchema.partial() }),
    z.object({ type: z.literal("bind_director_asset"), assetId: id, nodeId: id }),
    z.object({ type: z.literal("adopt_shared_asset"), assetId: id, approvedId: id, nodeId: id }),
    z.object({ type: z.literal("bind_director_segment"), targetId: id, nodeId: id, segmentId: id }),
    z.object({ type: z.literal("set_director_boundary"), boundary: directorBoundarySchema }),
    z.object({ type: z.literal("set_director_segment_group"), segmentId: id, shotIds: z.array(id).min(1), removeSegmentIds: z.array(id).default([]) }),
    z.object({ type: z.literal("review_director_asset"), assetId: id, version: z.number().int().min(1), sourceHash: hash, nodeId: id, storageKey: id, sha256: hash, verdict: z.enum(["approved", "rejected"]), evidence: z.string().trim().min(1) }),
    z.object({ type: z.literal("upsert_scene"), scene: productionSceneSchema }),
    z.object({ type: z.literal("delete_scene"), id }),
    z.object({ type: z.literal("reorder_scenes"), ids: z.array(id) }),
    z.object({ type: z.literal("upsert_script_block"), sceneId: id, block: scriptBlockSchema, beforeBlockId: id.optional() }),
    z.object({ type: z.literal("delete_script_block"), sceneId: id, id }),
    z.object({ type: z.literal("reorder_script_blocks"), sceneId: id, ids: z.array(id) }),
    z.object({ type: z.literal("upsert_shot"), shot: productionShotSchema }),
    z.object({ type: z.literal("delete_shot"), id }),
    z.object({ type: z.literal("reorder_shots"), sceneId: id, ids: z.array(id) }),
    z.object({ type: z.literal("set_keyframe"), shotId: id, nodeId: id.nullable() }),
    z.object({ type: z.literal("set_clip_group"), group: clipGroupSchema }),
    z.object({ type: z.literal("delete_clip_group"), id }),
    z.object({ type: z.literal("set_settings"), patch: productionSettingsSchema.partial() }),
    z.object({ type: z.literal("import_legacy"), source: z.enum(["fullPlot", "script.md", "storyboard.md"]) }),
    z.object({ type: z.literal("review_keyframe"), shotId: id, verdict: z.enum(["auto-accepted", "needs-redo"]), evidence: z.string().min(1) }),
]);

export const productionEditSchema = z.object({ operationId: id, expectedRevision: z.number().int().min(0), ops: z.array(productionOperationSchema).min(1) });
export const productionPublishSchema = z.object({ operationId: id, expectedRevision: z.number().int().min(0), stage: z.enum(["script", "shots", "director"]) });
export const directorRunStartSchema = z.object({ runId: id, idempotencyKey: id, workId: id.optional(), expectedRevision: z.number().int().min(0), version: z.number().int().min(1), targets: z.array(id).min(1), scope: z.enum(["selected", "all_ready"]).default("selected") });
export const directorRunControlSchema = z.object({ runId: id });
export const productionContractQuerySchema = z.object({ runtimeId: id.optional(), operationType: id.optional() });
// Keep requests unparsed at this boundary so invalid inputs produce diagnostics,
// rather than disappearing into a transport-level schema error.
export const productionPreflightSchema = z.object({ action: z.enum(["edit", "publish", "generate"]), request: z.record(z.unknown()) });
export const productionPreflightRequestSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("edit"), request: productionEditSchema }),
    z.object({ action: z.literal("publish"), request: productionPublishSchema }),
    z.object({ action: z.literal("generate"), request: directorRunStartSchema }),
]);
export type ProductionDiagnostic = { code: string; path: string; targetId?: string; message: string; severity: "error" | "warning" | "unverified" };
export type ProductionPreflight = { valid: boolean; contractVersion: string; engine: DirectorProduction["engine"] | null; revision: number | null; diagnostics: ProductionDiagnostic[]; generationReady: boolean };
export type DirectorRunStart = z.infer<typeof directorRunStartSchema>;

export type ProductionScene = z.infer<typeof productionSceneSchema>;
export type ProductionShot = z.infer<typeof productionShotSchema>;
export type EpisodeProductionData = z.infer<typeof episodeProductionDataSchema>;
export type ProductionOperation = z.infer<typeof productionOperationSchema>;
export type ProductionEdit = z.infer<typeof productionEditSchema>;
export type ProductionPublish = z.infer<typeof productionPublishSchema>;

export function emptyEpisodeProduction(): EpisodeProductionData {
    return { scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], settings: { mode: "manual", imageModel: "", h3Model: "", imageModels: {}, h3Models: {} }, legacyImports: [] };
}
