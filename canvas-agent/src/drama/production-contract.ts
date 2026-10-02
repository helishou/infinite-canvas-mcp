import { z } from "zod";

const id = z.string().trim().min(1);

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
    scenes: z.array(productionSceneSchema),
    shots: z.array(productionShotSchema),
    keyframes: z.record(id, z.object({ nodeId: id, storageKey: z.string(), sourceVersion: z.number().int().min(0) })),
    keyframeReviews: z.record(id, z.object({ verdict: z.enum(["auto-accepted", "needs-redo"]), evidence: z.string(), sourceVersion: z.number().int().min(0) })),
    clipGroups: z.array(clipGroupSchema),
    settings: productionSettingsSchema,
    legacyImports: z.array(z.object({ source: z.enum(["fullPlot", "script.md", "storyboard.md"]), sha256: z.string(), text: z.string(), importedAt: z.string() })),
});

export const productionOperationSchema = z.discriminatedUnion("type", [
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
export const productionPublishSchema = z.object({ operationId: id, expectedRevision: z.number().int().min(0), stage: z.enum(["script", "shots"]) });

export type ProductionScene = z.infer<typeof productionSceneSchema>;
export type ProductionShot = z.infer<typeof productionShotSchema>;
export type EpisodeProductionData = z.infer<typeof episodeProductionDataSchema>;
export type ProductionOperation = z.infer<typeof productionOperationSchema>;
export type ProductionEdit = z.infer<typeof productionEditSchema>;
export type ProductionPublish = z.infer<typeof productionPublishSchema>;

export function emptyEpisodeProduction(): EpisodeProductionData {
    return { scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], settings: { mode: "manual", imageModel: "", h3Model: "", imageModels: {}, h3Models: {} }, legacyImports: [] };
}
