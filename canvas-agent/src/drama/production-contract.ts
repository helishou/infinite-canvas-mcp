import { z } from "zod";

const id = z.string().trim().min(1);

export const directorModules = ["story", "assets", "shots", "performance", "effects", "model", "continuity"] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
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
    assets: z.record(id, z.object({ nodeId: id, assetId: z.string().optional(), storageKey: z.string().optional(), sha256: hash.optional(), version: id, status: z.enum(["planned", "generated", "approved", "rejected"]), evidence: z.string().optional() })),
    shotInputs: z.record(id, z.object({ keyframePolicy: z.enum(["new", "reuse", "none"]), assetIds: z.array(id), keyframeAssetId: id.optional() })),
    boundaries: z.array(z.object({ from: id, to: id, tailFrame: z.boolean(), motionContext: z.boolean(), reason: z.string().min(1) })),
    executionAuthorized: z.boolean().default(false),
    unresolved: z.array(z.string()).default([]),
    workflow: z.record(z.unknown()).default({}),
});
export type DirectorProduction = z.infer<typeof directorProductionSchema>;

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
});

export const productionSettingsSchema = z.object({
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
    keyframeReviews: z.record(id, z.object({ verdict: z.enum(["auto-accepted", "needs-redo"]), evidence: z.string(), sourceVersion: z.number().int().min(0) })),
    clipGroups: z.array(clipGroupSchema),
    settings: productionSettingsSchema,
    legacyImports: z.array(z.object({ source: z.enum(["fullPlot", "script.md", "storyboard.md"]), sha256: z.string(), text: z.string(), importedAt: z.string() })),
});

export const productionOperationSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("set_director_production"), director: directorProductionSchema }),
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

export type ProductionScene = z.infer<typeof productionSceneSchema>;
export type ProductionShot = z.infer<typeof productionShotSchema>;
export type EpisodeProductionData = z.infer<typeof episodeProductionDataSchema>;
export type ProductionOperation = z.infer<typeof productionOperationSchema>;
export type ProductionEdit = z.infer<typeof productionEditSchema>;
export type ProductionPublish = z.infer<typeof productionPublishSchema>;

export function emptyEpisodeProduction(): EpisodeProductionData {
    return { scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], settings: { mode: "manual", imageModel: "", h3Model: "", imageModels: {}, h3Models: {} }, legacyImports: [] };
}
