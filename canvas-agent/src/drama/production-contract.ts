import { z } from "zod";
import { isH3StyleTemplateId } from "../plugins/minimax-h3/style-templates.js";
export { productionSceneEntries, productionScriptGroups } from "./production-directory.js";
export { productionEntities, productionEntityBinding, productionEntityDescriptionField, productionEntityText, type ProductionEntityBinding } from "./production-entities.js";
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
    spec: ["fps_num", "fps_den", "production_total_duration", "generation_clip_limit", "delivery_scope", "prompt_detail_policy"],
    story: ["synopsis", "A", "B", "C", "five_stage_arc"],
    continuity: ["ledger"],
    style: ["style_policy", "style_policy_reason", "anchor_asset_id", "style_anchor_node_id"],
    scene: ["scene_name", "heading", "location", "time_of_day", "text", "blocks"],
    environment: ["name", "description", "prompt_description"],
    character: ["name", "appearance", "description", "prompt_description", "identity", "voice_description", "voice"],
    asset_card: ["prompt", "seven_steps", "references", "reference_policy", "target_skill", "source_repository", "recipe", "mode", "transaction", "character_name", "state_label", "view_layout", "generation_status", "actual_settings", "output_file", "heavy_scene", "structure_lock", "style_anchor_purpose"],
    asset: ["asset_name", "name", "title", "kind", "description", "prompt", "depends_on", "role", "version", "reference_role", "canvas_scope", "status"],
    shot: ["title", "visual", "camera", "scene_id", "source_scene_id", "start_frame", "end_frame", "duration_frames", "dialogues", "audio", "required_assets", "description", "shot_type", "timeline_id", "story_order", "continuity_facts", "characters", "performance", "combat", "state_description", "reference_requirements", "prompt_contract_version", "identity_context", "offscreen_character_ids", "subject_usages", "utterance_refs", "features"],
    segment: ["shot_ids", "start_frame", "end_frame", "generation_clip_duration", "mode", "mode_lock", "mode_selection_reason", "audio", "sound", "overall_soundscape", "non_diegetic_music", "references", "subjects", "execution_gate", "styleTemplateId", "motion_profile", "summary", "audio_bindings", "animation_term_ids", "animation_term_evidence", "locked", "preLockNoiseSeedMode"],
} as const;

const directorPatchSourceEntities = Object.keys(directorPatchFields).filter((entity): entity is Exclude<keyof typeof directorPatchFields, "continuity"> => entity !== "continuity") as [Exclude<keyof typeof directorPatchFields, "continuity">, ...Exclude<keyof typeof directorPatchFields, "continuity">[]];
const directorPatchObjectSchema = z.object(Object.fromEntries(
    [...new Set(Object.values(directorPatchFields).flat())].map(field => [field, z.unknown()]),
)).strict();

export const directorModules = ["story", "assets", "shots", "performance", "effects", "model", "continuity"] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const directorBoundarySchema = z.object({ from: id, to: id, tailFrame: z.boolean(), motionContext: z.boolean(), reason: z.string() });
export const sharedAssetSourceSchema = z.object({ dramaId: id, assetId: id, sourceProjectId: id, sourceNodeId: id }).strict();
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
    mode: z.enum(["none", "automatic", "mixed", "manual"]),
    shared: z.enum(["none", "automatic", "manual"]),
    scene: z.enum(["none", "automatic", "manual"]),
}).strict().superRefine((policy, context) => {
    if (policy.mode === "none" && (policy.shared !== "none" || policy.scene !== "none")
        || policy.mode !== "none" && policy.mode !== "mixed" && (policy.shared !== policy.mode || policy.scene !== policy.mode)
        || policy.mode === "mixed" && (policy.shared === "none" || policy.scene === "none")) context.addIssue({ code: "custom", message: "审核预设与审核点配置不一致" });
});
export const defaultDirectorReviewPolicy = { mode: "none", shared: "none", scene: "none" } as const;
export type DirectorReviewPolicy = z.infer<typeof directorReviewPolicySchema>;
export const resolveDirectorReviewPolicy = (policy?: DirectorReviewPolicy | null): DirectorReviewPolicy =>
    policy ? directorReviewPolicySchema.parse(policy) : { ...defaultDirectorReviewPolicy };
export const directorSceneReviewSchema = z.object({
    sourceHash: hash, inputHash: hash, mediaInputHash: hash.optional(), verdict: z.enum(["approved", "rejected", "needs_human"]),
    mode: z.enum(["automatic", "manual"]), evidence: z.string().trim().min(1),
    media: z.array(z.object({ targetId: id, storageKey: id, sha256: hash })),
    checkedAt: z.string().datetime(),
}).strict();
const directorEngineSchema = z.object({
    commit: z.string().regex(/^[a-f0-9]{40}$/), patchVersion: id, runtimeId: id, version: id,
    compilerHash: hash.optional(),
    compilerHashes: z.object({ h3: hash.optional(), image: hash.optional() }).strict().optional(),
});
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
const directorProductionBaseSchema = z.object({
    schemaVersion: z.literal(1),
    engine: directorEngineSchema,
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
    assets: z.record(id, z.object({ nodeId: id.optional(), assetId: z.string().optional(), storageKey: z.string().optional(), generationTaskId: id.optional(), sha256: hash.optional(), version: id, status: z.enum(["planned", "generated", "approved", "rejected"]), evidence: z.string().optional(), inputOutdated: z.boolean().optional() }).passthrough()),
    shotInputs: z.record(id, z.object({ keyframePolicy: z.enum(["new", "reuse", "none"]).default("none"), assetIds: z.array(id).default([]), keyframeAssetId: id.optional() }).passthrough()),
    boundaries: z.array(directorBoundarySchema),
    executionAuthorized: z.boolean().default(false),
    unresolved: z.array(z.string()).default([]),
    workflow: directorWorkflowSchema.default({}),
}).passthrough();
/** Stored snapshots remain structurally readable for history; they are never a write or execution contract. */
export const directorProductionHistorySchema = directorProductionBaseSchema;
export const directorProductionSchema = directorProductionBaseSchema.superRefine((director, context) => {
    const source = director.source as Record<string, unknown>;
    if (Array.isArray(source.segments)) source.segments.forEach((segment, index) => {
        if (segment && typeof segment === "object" && Object.hasOwn(segment, "styleTemplateId") && segment.styleTemplateId !== null && !(isH3StyleTemplateId(segment.styleTemplateId) || typeof segment.styleTemplateId === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/i.test(segment.styleTemplateId))) context.addIssue({ code: "custom", path: ["source", "segments", index, "styleTemplateId"], message: "无效 H3 风格模板 ID" });
    });
    for (const issue of directorSourceV2Diagnostics(source)) context.addIssue({ code: "custom", path: ["source", ...issue.path], message: issue.message });
});
export type DirectorProduction = z.infer<typeof directorProductionSchema>;
export function isSubjectPromptAssembly(source: Record<string, unknown>) {
    return source.version === 2
        && (source.prompt_assembly as Record<string, unknown> | undefined)?.version === 2
        && (source.ledger as Record<string, unknown> | undefined)?.contract_version === 2;
}

/** Materialize the required default when a source write introduces keyframes; preserve explicit false. */
export function defaultRequiredShotKeyframes(source: Record<string, unknown>) {
    let changed = false;
    for (const shot of Array.isArray(source.shots) ? source.shots : []) {
        if (!shot || typeof shot !== "object" || Array.isArray(shot)) continue;
        const row = shot as Record<string, unknown>;
        for (const keyframe of Array.isArray(row.keyframes) ? row.keyframes : []) {
            if (!keyframe || typeof keyframe !== "object" || Array.isArray(keyframe)) continue;
            const frame = keyframe as Record<string, unknown>;
            if (!Object.hasOwn(frame, "requiredForSubmission")) {
                frame.requiredForSubmission = true;
                changed = true;
            }
        }
    }
    return changed;
}

export function resolveSubjectPictureBindingIds(subjectValue: unknown, usageValue: unknown) {
    const subject = subjectValue && typeof subjectValue === "object" ? subjectValue as Record<string, any> : {};
    const usage = usageValue && typeof usageValue === "object" ? usageValue as Record<string, any> : {};
    const bindings = Array.isArray(subject.pictureBindings) ? subject.pictureBindings as Array<Record<string, any>> : [];
    const explicit = Array.isArray(usage.pictureBindingIds) ? usage.pictureBindingIds.map(String) : [];
    const requirements = new Map((Array.isArray(usage.stateRequirements) ? usage.stateRequirements : [])
        .map((item: Record<string, unknown>) => [String(item.factId), String(item.value)]));
    const applicable = (binding: Record<string, any>) => Object.entries(binding.applicableState || {})
        .every(([factId, value]) => requirements.get(factId) === String(value));
    // Missing/default preserves the historical contract: an empty list inherits
    // purpose defaults, while a non-empty list is an explicit selection. The
    // new explicit mode lets callers represent an intentional empty selection.
    if (usage.pictureBindingMode === "explicit" || explicit.length) {
        const selected = explicit.map(id => bindings.find(binding => String(binding.id) === id));
        const missing = explicit.filter((_id, index) => !selected[index]);
        const mismatched = selected.filter((binding): binding is Record<string, any> => binding !== undefined && !applicable(binding));
        return { bindingIds: explicit.filter((_id, index) => Boolean(selected[index])), issues: [
            ...missing.map(id => "图片绑定 " + id + " 不属于 Subject " + String(subject.id || "")),
            ...mismatched.map(binding => "图片绑定 " + String(binding.id) + " 的适用状态与本镜状态要求冲突"),
        ] };
    }
    const purposes = [...new Set((Array.isArray(usage.referencePurpose) && usage.referencePurpose.length ? usage.referencePurpose : ["identity"]).map(String))];
    const sceneEnvironment = subject.entityRef?.kind === "scene" && purposes.includes("environment");
    // Scene environment references are visible background inputs even when the
    // Subject itself is carried as state context rather than a foreground subject.
    // Other non-visible usages remain excluded from default bindings.
    if (usage.presentation !== "visible" && !(usage.presentation === "state_context" && sceneEnvironment)) {
        return { bindingIds: [] as string[], issues: [] as string[] };
    }
    if (subject.entityRef?.kind === "scene" && !purposes.includes("environment")) return { bindingIds: [] as string[], issues: [] as string[] };
    // Older prop bindings were authored as identity. Keep them usable until a Subject has
    // purpose-specific prop bindings, while new prop bindings use the explicit prop purpose.
    const isPropSubject = subject.kind === "prop" || subject.entityRef?.kind === "asset";
    const legacyPropBindings = isPropSubject && !bindings.some(binding => Array.isArray(binding.provides) && binding.provides.map(String).includes("prop"));
    const selected: string[] = [], issues: string[] = [];
    for (const purpose of purposes) {
        const eligible = bindings.filter(binding => Array.isArray(binding.provides)
            && (binding.provides.map(String).includes(purpose) || purpose === "prop" && legacyPropBindings && binding.provides.map(String).includes("identity"))
            && applicable(binding));
        const matches = eligible.filter(binding => Array.isArray(binding.defaultFor)
            && (binding.defaultFor.map(String).includes(purpose) || purpose === "prop" && legacyPropBindings && binding.defaultFor.map(String).includes("identity")));
        const fixedResults = eligible.filter(binding => binding.selection?.mode === "selected_result");
        if (matches.length === 1) selected.push(String(matches[0].id));
        else if (matches.length > 1) issues.push(purpose + " 默认图片绑定有歧义：" + matches.map(binding => binding.id).join(", "));
        else if (eligible.length === 1) selected.push(String(eligible[0].id));
        // A pinned generation result is an explicit, stable image choice. When
        // no purpose default is declared and older node-selection bindings make
        // the candidate set ambiguous, prefer that one pinned result rather than
        // silently compiling a visible Subject without an identity reference.
        else if (fixedResults.length === 1) selected.push(String(fixedResults[0].id));
        else if (!eligible.length) issues.push("缺少适用于 " + purpose + " 的默认图片绑定");
        else issues.push(purpose + " 默认图片绑定有歧义：" + eligible.map(binding => binding.id).join(", "));
    }
    return { bindingIds: [...new Set(selected)], issues };
}

/** Both legacy `wardrobe` and current `clothing` labels mean a Subject clothing reference. */
export function isClothingPictureBinding(bindingValue: unknown) {
    const binding = bindingValue && typeof bindingValue === "object" && !Array.isArray(bindingValue)
        ? bindingValue as Record<string, unknown> : {};
    return Array.isArray(binding.provides) && binding.provides.map(String).some((value: string) => value === "clothing" || value === "wardrobe");
}
export const productionCompilationScopeSchema = z.object({ sceneId: id.optional(), targetIds: z.array(id).min(1).optional(), output: z.literal("selected").optional() }).strict().refine(scope => Boolean(scope.sceneId || scope.targetIds?.length), "编译范围不能为空");
export const productionCompileSchema = z.object({
    operationId: id.optional(),
    expectedRevision: z.number().int().nonnegative().describe("读取制作稿的基线 revision；编译使用 Backend 当前已保存源稿，并在完成/应用时校验目标输入 manifest"),
    // Kept for compatibility with older HTTP clients. Backend compilation must
    // use its saved draft; a caller-provided snapshot is never authoritative.
    director: directorProductionSchema.optional().describe("已废弃并忽略；编译始终使用 Backend 已保存的正式制作稿。"),
    scope: productionCompilationScopeSchema.optional(),
}).strict();
/** Execution requests require a stable identity so callers can recover queued work after a lost response. */
export const productionCompileSubmissionSchema = productionCompileSchema.extend({ operationId: id });
export const productionApplyCompilationSchema = z.object({ preparedId: z.string().uuid() }).strict();
export const promptSourceMapSchema = z.object({
    version: z.literal(1), offsetUnit: z.literal("utf16"), segmentId: id, sourceHash: hash, promptHash: hash,
    entries: z.array(z.object({
        start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
        sourceKind: z.enum(["shot", "utterance"]), sourceId: id,
        field: z.enum(["visual", "action", "audio", "camera.editorial_reason", "text"]), sourceText: z.string(),
        sourceValue: z.string(), sourceStart: z.number().int().nonnegative(), sourceEnd: z.number().int().nonnegative(),
    }).strict()),
}).strict().superRefine((map, context) => {
    const ordered = [...map.entries].sort((a, b) => a.start - b.start || a.end - b.end);
    for (const [index, entry] of ordered.entries()) {
        if (entry.end <= entry.start) context.addIssue({ code: "custom", path: ["entries", index], message: "SourceMap span must be non-empty" });
        if (entry.sourceEnd < entry.sourceStart || entry.sourceEnd > entry.sourceValue.length || entry.sourceValue.slice(entry.sourceStart, entry.sourceEnd) !== entry.sourceText) context.addIssue({ code: "custom", path: ["entries", index], message: "SourceMap source span does not match its source value" });
        if (index > 0 && ordered[index - 1].end > entry.start) context.addIssue({ code: "custom", path: ["entries", index], message: "SourceMap spans must not overlap" });
        if (entry.sourceKind === "shot" && entry.field === "text" || entry.sourceKind === "utterance" && entry.field !== "text") context.addIssue({ code: "custom", path: ["entries", index, "field"], message: "SourceMap field is incompatible with its source kind" });
    }
});
export type PromptSourceMap = z.infer<typeof promptSourceMapSchema>;

const subjectPictureBindingSchema = z.object({
    id, assetId: id, sourceNode: z.object({ projectId: id, nodeId: id }).strict(),
    selection: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("node_selection") }).strict(),
        z.object({ mode: z.literal("latest_success") }).strict(),
        z.object({ mode: z.literal("selected_result"), resultId: id }).strict(),
    ]),
    provides: z.array(id).min(1), retain: z.array(z.string()), exclude: z.array(z.string()),
    applicableState: z.record(id, z.string()).default({}), defaultFor: z.array(id).default([]),
}).strict();
const subjectEntrySchema = z.object({
    id, kind: z.enum(["character", "scene", "prop", "animal", "other"]),
    entityRef: z.object({ ownerKind: z.enum(["episode", "drama", "canvas"]), ownerId: id, kind: z.enum(["character", "scene", "asset"]), id }).strict(),
    pictureBindings: z.array(subjectPictureBindingSchema).default([]),
}).strict();
const shotSubjectUsageSchema = z.object({
    subjectId: id, presentation: z.enum(["visible", "offscreen_voice", "state_context"]),
    localStartFrame: z.number().int().nonnegative().optional(), localEndFrame: z.number().int().positive().optional(),
    pictureBindingMode: z.enum(["default", "explicit"]).optional(),
    pictureBindingIds: z.array(id).default([]), referencePurpose: z.array(id).default([]), continuityFactIds: z.array(id).default([]),
    stateRequirements: z.array(z.object({ factId: id, value: id }).strict()).default([]),
    localNotes: z.string().optional(),
}).strict();
const shotKeyframeFields = {
    id, assetId: id, sourceNode: z.object({ projectId: id, nodeId: id }).strict().optional(),
    selection: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("node_selection") }).strict(),
        z.object({ mode: z.literal("latest_success") }).strict(),
        z.object({ mode: z.literal("selected_result"), resultId: id }).strict(),
    ]),
    subjectIds: z.array(id).default([]), subjectPictureBindingIds: z.record(id, z.array(id)).optional(), retain: z.array(z.string()), exclude: z.array(z.string()), requiredForSubmission: z.boolean().default(true),
};
const validateShotKeyframe = (keyframe: { anchor: string; localFrame?: number }, context: z.RefinementCtx) => {
    if (keyframe.anchor === "at_frame" && keyframe.localFrame === undefined) context.addIssue({ code: "custom", path: ["localFrame"], message: "at_frame 关键帧必须提供镜头局部帧" });
    if (keyframe.anchor !== "at_frame" && keyframe.localFrame !== undefined) context.addIssue({ code: "custom", path: ["localFrame"], message: "非定时锚点不能指定 localFrame" });
};
// Source reads accept the old composition anchor so saved v2 productions stay readable.
// New writes use the temporal-only schema and move composition refs to reference_requirements.
const shotKeyframeSchema = z.object({ ...shotKeyframeFields, anchor: z.enum(["composition", "opening", "closing", "at_frame"]), localFrame: z.number().int().nonnegative().optional() }).strict().superRefine(validateShotKeyframe);
const shotKeyframeWriteSchema = z.object({ ...shotKeyframeFields, anchor: z.enum(["opening", "closing", "at_frame"]), localFrame: z.number().int().nonnegative().optional() }).strict().superRefine(validateShotKeyframe);
const shotReferenceRequirementSchema = z.object({
    id, asset_id: id, asset_version: id, purpose: z.string().trim().min(1),
    sourceNode: z.object({ projectId: id, nodeId: id }).strict(),
    selection: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("node_selection") }).strict(),
        z.object({ mode: z.literal("latest_success") }).strict(),
        z.object({ mode: z.literal("selected_result"), resultId: id }).strict(),
    ]),
    retain: z.array(z.string()), exclude: z.array(z.string()), requiredForSubmission: z.boolean().default(true),
    subjectIds: z.array(id).optional(), subjectPictureBindingIds: z.record(id, z.array(id)).optional(),
}).strict();
const shotUtteranceRefSchema = z.object({ utteranceId: id, role: z.enum(["speaker", "reaction"]), localStartFrame: z.number().int().nonnegative(), localEndFrame: z.number().int().positive(), textStart: z.number().int().nonnegative(), textEnd: z.number().int().positive() }).strict();
const utteranceSchema = z.object({
    id, speakerSubjectId: id.optional(), speakerName: z.string().trim().min(1).optional(), text: z.string().min(1), delivery: z.string().optional(), voiceover: z.boolean().default(false),
    start: z.object({ shotId: id, localFrame: z.number().int().nonnegative() }).strict(),
    end: z.object({ shotId: id, localFrame: z.number().int().positive() }).strict(),
}).strict().refine(value => Boolean(value.speakerSubjectId) !== Boolean(value.speakerName), "对白说话人须选择已登记 Subject 或填写本镜称呼");
/** Exact archived audio inputs for a Subject Prompt v2 Clip. Images remain on Subject/keyframe bindings. */
export const shotAudioBindingSchema = z.object({
    id, label: z.string().trim().min(1), sourceNode: z.object({ projectId: id, nodeId: id }).strict(),
    storageKey: id, sha256: hash, role: id, shotIds: z.array(id).min(1), mimeType: z.string().startsWith("audio/"),
}).strict();

/** Structured, source-owned inputs for compiler-assembled Prompt v2. */
export function directorSourceV2Diagnostics(source: Record<string, unknown>) {
    const issues: Array<{ path: (string | number)[]; message: string }> = [];
    const add = (path: (string | number)[], message: string) => issues.push({ path, message });
    const assembly = source.prompt_assembly as Record<string, unknown> | undefined;
    const unsupportedMessage = "UNSUPPORTED_PRODUCTION_FORMAT: 当前制作台仅支持 Subject Prompt Assembly v2 与 Shot 局部帧账本 v2。请使用当前版 Acheng Director 升级后重新提交；原稿未修改。";
    if (source.version !== 2) {
        add(["version"], unsupportedMessage);
        return issues;
    }
    const ledger = source.ledger as Record<string, any> | undefined;
    if (!ledger || ledger.contract_version !== 2) {
        add(["ledger", "contract_version"], unsupportedMessage);
        return issues;
    }
    if (!assembly || assembly.version !== 2) {
        add(["prompt_assembly", "version"], "当前制作稿 v2 的 Prompt Assembly 结构不受支持。");
        return issues;
    }
    const subjectsResult = z.array(subjectEntrySchema).safeParse(source.subject_registry);
    const shots = Array.isArray(source.shots) ? source.shots as Array<Record<string, any>> : [];
    const segments = Array.isArray(source.segments) ? source.segments as Array<Record<string, any>> : [];
    const utterancesResult = z.array(utteranceSchema).safeParse(source.utterances ?? []);
    for (const issue of subjectsResult.success ? [] : subjectsResult.error.issues) add(["subject_registry", ...issue.path], issue.message);
    for (const issue of utterancesResult.success ? [] : utterancesResult.error.issues) add(["utterances", ...issue.path], issue.message);
    if (!subjectsResult.success || !utterancesResult.success) return issues;
    const subjects = subjectsResult.data, utterances = utterancesResult.data;
    const assets = rowsForContract(source.asset_plan).map(item => String(item.asset_id || item.id || ""));
    const entityIds = new Map<string, Set<string>>([
        ["character", new Set(rowsForContract(source.character_registry).map(item => String(item.id || "")))],
        ["scene", new Set(rowsForContract(source.scene_registry).map(item => String(item.id || "")))],
        ["asset", new Set(assets)],
    ]);
    const subjectById = new Map(subjects.map(subject => [subject.id, subject]));
    const entityOwners = new Set<string>();
    const bindingOwners = new Map<string, string>();
    const bindingIds = new Set<string>();
    for (const [subjectIndex, subject] of subjects.entries()) {
        const entityKey = `${subject.entityRef.ownerKind}:${subject.entityRef.ownerId}:${subject.entityRef.kind}:${subject.entityRef.id}`;
        if (entityOwners.has(entityKey)) add(["subject_registry", subjectIndex, "entityRef"], "同一已登记实体只能对应一个稳定 Subject");
        entityOwners.add(entityKey);
// 允许外部 Agent 注册 Subject，不再强制要求 entity 已预先登记。
        // if (!entityIds.get(subject.entityRef.kind)?.has(subject.entityRef.id)) add(["subject_registry", subjectIndex, "entityRef"], "Subject 必须引用已登记的人物、场景或资产");
        for (const [bindingIndex, binding] of subject.pictureBindings.entries()) {
            const path = ["subject_registry", subjectIndex, "pictureBindings", bindingIndex];
            if (bindingIds.has(binding.id)) add([...path, "id"], `重复图片绑定 ID：${binding.id}`);
            bindingIds.add(binding.id); bindingOwners.set(binding.id, subject.id);
        }
    }
    const shotById = new Map<string, Record<string, any>>();
    const shotOrder = new Map<string, number>();
    const timelineOrder = new Set<string>();
    const ledgerSource = source.ledger && typeof source.ledger === "object" ? source.ledger as Record<string, any> : {};
    const timelines = rowsForContract(ledgerSource.timelines).map(item => String(item.id || "")).filter(Boolean);
    const defaultTimelineId = timelines.includes("main") ? "main" : timelines[0] || "main";
    const nextStoryOrder = new Map<string, number>();
    for (const [index, shot] of shots.entries()) {
        const path = ["shots", index];
        if (Object.hasOwn(shot, "prompt_contract_version") && shot.prompt_contract_version !== 2) add([...path, "prompt_contract_version"], "当前制作稿 v2 的 Shot 提示结构不受支持。");
        if (!shot.id || shotById.has(String(shot.id))) add([...path, "id"], "Shot ID 必须全局唯一");
        else shotById.set(String(shot.id), shot);
        if (!Number.isInteger(shot.duration_frames) || shot.duration_frames <= 0) add([...path, "duration_frames"], "新合同 Shot 必须使用正整数 duration_frames");
        if (Object.hasOwn(shot, "start_frame") || Object.hasOwn(shot, "end_frame")) add(path, "prompt v2 Shot 的全局帧窗由 duration_frames、timeline 与 story_order 派生");
        for (const field of ["state_description", "state_in", "state_out", "continuity_cues", "required_assets", "dialogues"]) if (Object.hasOwn(shot, field)) add([...path, field], "prompt v2 Shot 状态、参考与对白必须使用各自的结构化来源");
        const timelineId = String(shot.timeline_id || defaultTimelineId);
        let storyOrder = Number.isInteger(shot.story_order) && shot.story_order >= 0
            ? Number(shot.story_order)
            : nextStoryOrder.get(timelineId) || 0;
        let orderKey = `${timelineId}\0${storyOrder}`;
        while (!(Number.isInteger(shot.story_order) && shot.story_order >= 0) && timelineOrder.has(orderKey)) {
            storyOrder += 1;
            orderKey = `${timelineId}\0${storyOrder}`;
        }
        if (Number.isInteger(shot.story_order) && shot.story_order >= 0 && timelineOrder.has(orderKey)) add([...path, "story_order"], "同一 timeline 的 story_order 不能重复");
        timelineOrder.add(orderKey);
        nextStoryOrder.set(timelineId, Math.max(nextStoryOrder.get(timelineId) || 0, storyOrder + 1));
        shotOrder.set(String(shot.id), index);
        const usages = z.array(shotSubjectUsageSchema).safeParse(shot.subject_usages ?? []);
        const keyframes = z.array(shotKeyframeSchema).safeParse(shot.keyframes ?? []);
        const references = z.array(shotReferenceRequirementSchema).safeParse(shot.reference_requirements ?? []);
        const utteranceRefs = z.array(shotUtteranceRefSchema).safeParse(shot.utterance_refs ?? []);
        for (const [field, result] of [["subject_usages", usages], ["keyframes", keyframes], ["reference_requirements", references], ["utterance_refs", utteranceRefs]] as const) {
            for (const issue of result.success ? [] : result.error.issues) add([...path, field, ...issue.path], issue.message);
        }
        if (references.success) {
            const seenReferences = new Set<string>();
            for (const [referenceIndex, reference] of references.data.entries()) {
                if (seenReferences.has(reference.id)) add([...path, "reference_requirements", referenceIndex, "id"], `重复画面参考 ID：${reference.id}`);
                seenReferences.add(reference.id);
                if (reference.purpose !== "构图参考") add([...path, "reference_requirements", referenceIndex, "purpose"], "当前分镜页只允许登记构图参考用途");
            }
        }
        if (usages.success) for (const [usageIndex, usage] of usages.data.entries()) {
            if (!subjectById.has(usage.subjectId)) add([...path, "subject_usages", usageIndex, "subjectId"], "Shot 引用了未登记 Subject");
           for (const bindingId of usage.pictureBindingIds) if (bindingOwners.get(bindingId) !== usage.subjectId) add([...path, "subject_usages", usageIndex, "pictureBindingIds"], `图片绑定 ${bindingId} 不属于 Subject ${usage.subjectId}`);
            if (usage.localStartFrame !== undefined && usage.localStartFrame >= Number(shot.duration_frames) || usage.localEndFrame !== undefined && usage.localEndFrame > Number(shot.duration_frames) || usage.localStartFrame !== undefined && usage.localEndFrame !== undefined && usage.localEndFrame <= usage.localStartFrame) add([...path, "subject_usages", usageIndex], "Subject 出现范围必须位于 Shot 时长内且起止递增");
       }
        if (usages.success) for (const [usageIndex, usage] of usages.data.entries()) {
            const subject = subjectById.get(usage.subjectId);
            if (subject) for (const issue of resolveSubjectPictureBindingIds(subject, usage).issues) {
                // A missing or ambiguous default image is an input-readiness problem, not a
                // reason to reject the authored Shot. The action-specific validator blocks
                // generation while allowing the source and text prompt to be saved/compiled.
                if (issue.startsWith("缺少适用于 ") || issue.includes(" 默认图片绑定有歧义：")) continue;
                add([...path, "subject_usages", usageIndex, "pictureBindingIds"], issue);
            }
        }
        if (keyframes.success) for (const [keyframeIndex, keyframe] of keyframes.data.entries()) {
            if (keyframe.localFrame !== undefined && keyframe.localFrame >= Number(shot.duration_frames)) add([...path, "keyframes", keyframeIndex, "localFrame"], "关键帧时刻超出 Shot 时长");
            for (const subjectId of keyframe.subjectIds) if (!subjectById.has(subjectId)) add([...path, "keyframes", keyframeIndex, "subjectIds"], `关键帧引用未登记 Subject ${subjectId}`);
            for (const [subjectId, bindingIds] of Object.entries(keyframe.subjectPictureBindingIds || {})) {
                if (!keyframe.subjectIds.includes(subjectId)) add([...path, "keyframes", keyframeIndex, "subjectPictureBindingIds", subjectId], "关键帧服装绑定必须属于已引用主体");
                for (const bindingId of bindingIds) {
                    const owner = bindingOwners.get(bindingId);
                    const subject = subjectById.get(subjectId);
                    const binding = rowsForContract(subject?.pictureBindings).find(item => String(item.id) === bindingId);
                    if (owner !== subjectId || !isClothingPictureBinding(binding)) add([...path, "keyframes", keyframeIndex, "subjectPictureBindingIds", subjectId], `服装绑定 ${bindingId} 不属于该主体或不是服装参考`);
                }
            }
        }
        if (utteranceRefs.success) for (const [refIndex, ref] of utteranceRefs.data.entries()) {
            if (ref.localEndFrame <= ref.localStartFrame || ref.localEndFrame > Number(shot.duration_frames)) add([...path, "utterance_refs", refIndex], "对白引用时窗须位于 Shot 内");
        }
    }
    if (utterancesResult.success) for (const [index, utterance] of utterances.entries()) {
        if (utterance.speakerSubjectId && !subjectById.has(utterance.speakerSubjectId)) add(["utterances", index, "speakerSubjectId"], "说话 Subject 未登记");
        const startIndex = shotOrder.get(utterance.start.shotId), endIndex = shotOrder.get(utterance.end.shotId);
        const references = shots.flatMap((shot, shotIndex) => rowsForContract(shot.utterance_refs).filter(ref => ref.utteranceId === utterance.id).map(ref => ({ shot, shotIndex, ref })))
            .sort((a, b) => a.shotIndex - b.shotIndex || Number(a.ref.localStartFrame) - Number(b.ref.localStartFrame));
        if (!references.length) add(["utterances", index], "对白事件必须由 Shot 引用");
        else {
            if (references[0].shot.id !== utterance.start.shotId || references[0].ref.localStartFrame !== utterance.start.localFrame) add(["utterances", index, "start"], "对白起点与 Shot 声音覆盖不一致");
            const last = references.at(-1)!;
            if (last.shot.id !== utterance.end.shotId || last.ref.localEndFrame !== utterance.end.localFrame) add(["utterances", index, "end"], "对白终点与 Shot 声音覆盖不一致");
            let textCursor = 0;
            for (const [partIndex, part] of references.entries()) {
                if (part.ref.textStart !== textCursor || part.ref.textEnd <= part.ref.textStart) add(["utterances", index, "references", partIndex], "对白原文片段必须按顺序连续覆盖且不重不漏");
                textCursor = Number(part.ref.textEnd);
                if (partIndex > 0 && references[partIndex - 1].shotIndex !== part.shotIndex && references[partIndex - 1].ref.localEndFrame !== Number(references[partIndex - 1].shot.duration_frames)) add(["utterances", index, "references", partIndex - 1], "跨切对白必须连续到达镜头切点");
                if (partIndex < references.length - 1 && references[partIndex + 1].shotIndex !== part.shotIndex && part.ref.localEndFrame !== Number(part.shot.duration_frames)) add(["utterances", index, "references", partIndex], "跨切对白必须连续到达镜头切点");
            }
            if (textCursor !== Array.from(utterance.text).length) add(["utterances", index, "text"], "Shot 声音片段未逐字覆盖完整对白原文");
            if (references.some(part => Number(part.ref.textEnd) > Array.from(utterance.text).length)) add(["utterances", index, "references"], "对白片段索引超出原文");
            const segmentIds = new Set(references.map(part => segments.find(segment => (segment.shot_ids || []).includes(part.shot.id))?.id || ""));
            if (segmentIds.size !== 1 || segmentIds.has("")) add(["utterances", index], "完整对白事件必须包含在同一个 Clip");
        }
        if (startIndex === undefined || endIndex === undefined || startIndex > endIndex) add(["utterances", index], "对白起止 Shot 不存在或顺序倒置");
        else {
            const startShot = shotById.get(utterance.start.shotId)!, endShot = shotById.get(utterance.end.shotId)!;
            if (startShot.timeline_id !== endShot.timeline_id || utterance.start.localFrame >= Number(startShot.duration_frames) || utterance.end.localFrame > Number(endShot.duration_frames)) add(["utterances", index], "对白时间须处于同一时间线的有效 Shot 帧窗");
        }
    }
    const partitioned = new Set<string>();
    const compilerScope = source._canvas_compilation_scope as Record<string, any> | undefined;
    const compiledShotIds = compilerScope ? new Set(segments.flatMap(segment => Array.isArray(segment.shot_ids) ? segment.shot_ids.map(String) : [])) : undefined;
    for (const [segmentIndex, segment] of segments.entries()) {
        const ids = Array.isArray(segment.shot_ids) ? segment.shot_ids.map(String) : [];
        if (!ids.length) add(["segments", segmentIndex, "shot_ids"], "Clip 至少包含一个 Shot");
        let prior = -1, timelineId: string | undefined;
        for (const [shotIndex, shotId] of ids.entries()) {
            const position = shotOrder.get(shotId);
            if (position === undefined) add(["segments", segmentIndex, "shot_ids", shotIndex], `未知 Shot：${shotId}`);
            else if (position <= prior) add(["segments", segmentIndex, "shot_ids", shotIndex], "Clip 中的 Shots 必须按源稿顺序连续排列");
            else if (prior >= 0 && position !== prior + 1) add(["segments", segmentIndex, "shot_ids", shotIndex], "Clip 不能跳过中间 Shot");
            else if (timelineId && shotById.get(shotId)?.timeline_id !== timelineId) add(["segments", segmentIndex, "shot_ids", shotIndex], "Clip 不能合并不同叙事时间线");
            prior = position ?? prior;
            timelineId ||= String(shotById.get(shotId)?.timeline_id || "");
            if (partitioned.has(shotId)) add(["segments", segmentIndex, "shot_ids", shotIndex], `Shot ${shotId} 被多个 Clip 重复使用`);
            partitioned.add(shotId);
        }
        if (ids.some(id => shotOrder.get(id) === undefined)) continue;
        const durationFrames = ids.reduce((sum, id) => sum + Number(shotById.get(id)!.duration_frames), 0);
        if (Object.hasOwn(segment, "duration_frames") || Object.hasOwn(segment, "generation_clip_duration")) add(["segments", segmentIndex], "Clip 时长由 Shot 时长求和派生，不作为源稿字段保存");
        for (const field of ["references", "subjects", "definition", "retention", "prompt", "subject_definitions", "retention_analysis", "detailed_description"]) if (Object.hasOwn(segment, field)) add(["segments", segmentIndex, field], "prompt v2 Clip 的 Subject、Picture 与 Prompt 由 Shots 编译派生");
        const audioBindings = z.array(shotAudioBindingSchema).safeParse(segment.audio_bindings ?? []);
        if (!audioBindings.success) for (const issue of audioBindings.error.issues) add(["segments", segmentIndex, "audio_bindings", ...issue.path], issue.message);
        else for (const [bindingIndex, binding] of audioBindings.data.entries()) {
            const path = ["segments", segmentIndex, "audio_bindings", bindingIndex];
            if (binding.sourceNode.projectId !== String(source.project_id || "")) add([...path, "sourceNode", "projectId"], "音频来源节点必须属于当前制作画布");
            if (binding.shotIds.some(shotId => !ids.includes(shotId))) add([...path, "shotIds"], "音频绑定镜头必须属于当前 Clip");
        }
    }
    for (const shot of shots) if ((!compiledShotIds || compiledShotIds.has(String(shot.id))) && !partitioned.has(String(shot.id))) add(["shots", shotOrder.get(String(shot.id)) ?? 0], "新合同每个输出 Shot 必须且只能归属一个 Clip");
    {
        const facts = rowsForContract(ledger.facts);
        const factsById = new Map(facts.map(fact => [String(fact.id), fact]));
        const subjectForEntity = new Map<string, string>();
        for (const subject of subjects) subjectForEntity.set(`${subject.entityRef.kind}:${subject.entityRef.id}`, subject.id);
        for (const [index, fact] of facts.entries()) {
            if (!subjectForEntity.has(`${fact.object_kind}:${fact.object_id}`)) add(["ledger", "facts", index], "连续性事实所属对象必须映射到稳定 Subject");
            const descriptions = fact.value_descriptions;
            const values = Array.isArray(fact.allowed_values) ? fact.allowed_values.map(String) : [];
            if (!descriptions || typeof descriptions !== "object" || values.some(value => typeof descriptions[value] !== "string" || !descriptions[value].trim())) add(["ledger", "facts", index, "value_descriptions"], "每个合法连续性值都需要模型可读描述");
        }
        const scriptBlocks = new Set(rowsForContract(source.script_scenes).flatMap(scene => rowsForContract(Array.isArray(scene.blocks) ? scene.blocks : typeof scene.text === "string" ? [scene] : []).map(block => String(block.id))));
        for (const [index, event] of rowsForContract(ledger.events).entries()) {
            if (!Number.isInteger(event.local_frame) || event.local_frame < 0) add(["ledger", "events", index, "local_frame"], "新合同状态事件使用 Shot 局部帧");
            const shot = shotById.get(String(event.shot_id));
            if (!shot) add(["ledger", "events", index, "shot_id"], "状态事件引用未知 Shot");
            else if (event.local_frame >= Number(shot.duration_frames)) add(["ledger", "events", index, "local_frame"], "状态事件超出 Shot 时长");
            if (!factsById.has(String(event.fact_id))) add(["ledger", "events", index, "fact_id"], "状态事件引用未知连续性事实");
            const anchorBlock = String(event.source_anchor?.block_id ?? "");
            if (anchorBlock && !scriptBlocks.has(anchorBlock)) add(["ledger", "events", index, "source_anchor"], "状态事件引用了未知剧本块");
        }
    }
    return issues;
}

function rowsForContract(value: unknown): Array<Record<string, any>> {
    return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, any>> : [];
}
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

const directorSceneOccurrenceFields = z.object({
    id,
    scene_id: id,
    scene_name: z.string().trim().min(1),
    heading: z.string().optional(),
    location: z.string().trim().min(1),
    time_of_day: z.string().trim().min(1),
    text: z.string().optional(),
    beat_ids: z.array(id),
    blocks: z.array(z.record(z.unknown())).optional(),
}).passthrough();
const directorSceneOccurrenceSchema = directorSceneOccurrenceFields.refine(scene => typeof scene.text === "string" || Boolean(scene.blocks?.length), "新场次必须提供 text 或 blocks");
const directorScenePatchSchema = directorSceneOccurrenceFields.partial().omit({ id: true, scene_id: true }).strict();
export const productionSplitSceneSchema = z.object({
    operationId: id,
    expectedRevision: z.number().int().nonnegative(),
    sourceSceneId: id,
    sourceScenePatch: directorScenePatchSchema.default({}),
    newScene: directorSceneOccurrenceSchema,
    shotIds: z.array(id).min(1),
    environmentSubjectId: id,
    environmentPictureBindingId: id,
}).strict();

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
    reviewPolicy: directorReviewPolicySchema.default(defaultDirectorReviewPolicy),
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
    reviewPolicy: directorReviewPolicySchema.default(defaultDirectorReviewPolicy),
    requirements: z.string().default(""),
    imageModel: z.string().default(""),
    imageModelsByKind: productionSettingsSchema.shape.imageModelsByKind,
    /** Initial style image node selected during drama setup; transferred into the shared director source once it exists. */
    styleAnchorNodeId: z.string().min(1).optional(),
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
    // Formal Acheng v2 stores Story/Shot/Segment only in director.source. These
    // arrays remain available for legacy no-Director productions and are omitted
    // from v2 storage/API snapshots; Backend may derive an ephemeral internal view.
    scenes: z.array(productionSceneSchema).default([]),
    shots: z.array(productionShotSchema).default([]),
    keyframes: z.record(id, z.object({ nodeId: id, storageKey: z.string(), sourceVersion: z.number().int().min(0) })),
    keyframeReviews: z.record(id, z.object({ verdict: z.enum(["auto-accepted", "needs-redo", "approved", "rejected"]), evidence: z.string(), sourceVersion: z.number().int().min(0) })),
    clipGroups: z.array(clipGroupSchema).default([]),
    settings: productionSettingsSchema,
    legacyImports: z.array(z.object({ source: z.enum(["fullPlot", "script.md", "storyboard.md"]), sha256: z.string(), text: z.string(), importedAt: z.string() })),
});
/** Historical published/revision snapshots can be read, but the current draft and every write use v2. */
export const episodeProductionHistoryDataSchema = episodeProductionDataSchema.extend({ director: directorProductionHistorySchema.optional() });

export const productionOperationSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("set_director_production"), director: directorProductionSchema }).strict(),
    z.object({ type: z.literal("replace_director_scene_storyboard"), sceneId: id, shots: z.array(z.record(z.unknown())).min(1), segments: z.array(z.record(z.unknown())).min(1), shotInputs: z.record(z.unknown()) }).strict(),
    z.object({ type: z.literal("archive_director_scene"), sceneId: id, expectedCanvasRevision: z.number().int().nonnegative(), confirmed: z.literal(true) }).strict(),
    z.object({ type: z.literal("restore_director_scene"), archiveId: id, expectedCanvasRevision: z.number().int().nonnegative() }).strict(),
    z.object({ type: z.literal("delete_director_clip"), segmentId: id, expectedCanvasRevision: z.number().int().nonnegative(), confirmed: z.literal(true) }).strict(),
    z.object({ type: z.literal("upsert_director_subject"), subject: subjectEntrySchema }).strict(),
    z.object({ type: z.literal("rebind_director_subject"), subjectId: id, sourceProjectId: id, sourceNodeId: id }).strict(),
    z.object({ type: z.literal("repair_director_subject_bindings") }).strict(),
    z.object({ type: z.literal("delete_director_subject"), id, referenceAction: z.enum(["clear", "replace"]).optional(), replacementSubjectId: id.optional() }).strict(),
    z.object({ type: z.literal("create_manual_director_asset"), assetPlan: z.object({ id, kind: z.enum(["character", "scene", "prop"]), asset_name: z.string().min(1), entity_id: id.optional(), version: id, description: z.string(), purpose: z.string(), depends_on: z.array(id), status: z.literal("planned"), canvas_scope: z.enum(["episode", "shared"]).optional(), sharedSource: sharedAssetSourceSchema.optional() }).strict(), assetCard: z.object({ id, asset_id: id, asset_kind: z.enum(["character", "scene", "prop"]), asset_version: id, prompt: z.string(), references: z.array(z.unknown()) }).passthrough(), registryKind: z.enum(["character", "scene"]).optional(), registryEntity: z.record(z.unknown()).optional(), subject: subjectEntrySchema.optional() }).strict(),
    z.object({ type: z.literal("delete_director_asset"), id, confirmed: z.literal(true) }).strict(),
    z.object({ type: z.literal("remove_shared_director_asset"), id }).strict(),
    z.object({ type: z.literal("set_director_shot_keyframes"), shotId: id, keyframes: z.array(shotKeyframeWriteSchema) }).strict(),
    z.object({
        type: z.literal("set_director_shot_utterances"), shotId: id,
        utterances: z.array(z.object({
            utteranceId: id.optional(), speakerSubjectId: id.optional(), speakerName: z.string().trim().min(1).optional(), text: z.string().min(1), delivery: z.string().optional(), voiceover: z.boolean(),
            localStartFrame: z.number().int().nonnegative(), localEndFrame: z.number().int().positive(),
            textMode: z.enum(["whole", "segment", "partition"]).optional(), textCuts: z.array(z.number().int().positive()).optional(),
        }).strict().refine(value => Boolean(value.speakerSubjectId) !== Boolean(value.speakerName), "对白说话人须选择已登记 Subject 或填写本镜称呼")).max(32),
    }).strict(),
    z.object({ type: z.literal("edit_director_shot"), action: z.enum(["insert", "duplicate", "delete", "move", "split", "merge"]), shotId: id.optional(), targetShotId: id.optional(), newShotId: id.optional(), position: z.enum(["before", "after"]).optional(), splitFrame: z.number().int().positive().optional(), textOffsets: z.record(z.number().int().nonnegative()).optional(), reaction: z.boolean().optional(), shot: z.record(z.unknown()).optional(), firstShotPatch: z.record(z.unknown()).optional(), segment: z.record(z.unknown()).optional(), cameraShotId: id.optional() }).strict(),
    z.object({ type: z.literal("repartition_director_clips"), shotIds: z.array(id).min(1), segments: z.array(z.record(z.unknown())).min(1) }).strict(),
    z.object({ type: z.literal("reverse_sync_director_prompt"), segmentId: id, artifactId: id, sourceHash: hash, basePromptHash: hash, prompt: z.string(), canvasRevision: z.number().int().nonnegative() }).strict(),
    z.object({ type: z.literal("edit_director_continuity"), changes: z.array(z.object({ collection: z.enum(["facts", "timelines", "initial", "events", "requirements", "coverage"]), action: z.enum(["upsert", "delete"]), id, value: z.record(z.unknown()).optional() }).strict()).min(1) }).strict(),
    z.object({ type: z.literal("replace_director_clip_storyboard"), segmentId: id, segment: z.record(z.unknown()), shots: z.array(z.record(z.unknown())).min(1), shotInputs: z.record(z.unknown()), keyframeBindings: z.array(z.object({ shotId: id, assetId: id, bindingId: id, nodeId: id.optional(), containerNodeId: id.optional(), storageKey: id.optional(), label: z.string().optional() }).strict()).optional(), removedStoryboardBindingIds: z.array(id).optional() }).strict(),
    z.object({ type: z.literal("request_director_clip_refresh"), segmentId: id }).strict(),
    z.object({ type: z.literal("set_director_brief"), brief: z.string() }).strict(),
    z.object({ type: z.literal("initialize_director_from_demand") }).strict(),
    z.object({ type: z.literal("patch_director_source"), entity: z.enum(directorPatchSourceEntities), id: id.optional(), patch: directorPatchObjectSchema }).strict(),
    z.object({ type: z.literal("set_director_scene_environment"), sceneId: id, environmentId: id }).strict(),
    z.object({ type: z.literal("split_director_scene"), sourceSceneId: id, sourceScenePatch: directorScenePatchSchema.default({}), newScene: directorSceneOccurrenceSchema, shotIds: z.array(id).min(1), environmentSubjectId: id, environmentPictureBindingId: id }).strict(),
    z.object({ type: z.literal("adopt_director_fields"), targetId: id, nodeId: id, segmentId: id.optional(), canvasRevision: z.number().int().nonnegative(), fields: z.array(id).min(1) }).strict(),
    z.object({ type: z.literal("adopt_director_clip_style"), targetId: id, nodeId: id, segmentId: id, canvasRevision: z.number().int().nonnegative(), styleTemplateId: z.string().nullable() }).strict(),
    z.object({ type: z.literal("set_director_workflow"), patch: directorWorkflowSchema.partial() }).strict(),
    z.object({ type: z.literal("bind_director_asset"), assetId: id, nodeId: id }).strict(),
    z.object({ type: z.literal("bind_director_segment"), targetId: id, nodeId: id, segmentId: id }).strict(),
    z.object({ type: z.literal("set_director_boundary"), boundary: directorBoundarySchema }).strict(),
    z.object({ type: z.literal("set_director_segment_group"), segmentId: id, shotIds: z.array(id).min(1), removeSegmentIds: z.array(id).default([]) }).strict(),
    z.object({ type: z.literal("review_director_asset"), assetId: id, version: z.number().int().min(0), sourceHash: hash, nodeId: id, storageKey: id, sha256: hash, verdict: z.enum(["approved", "rejected"]), evidence: z.string().trim().min(1) }).strict(),
    z.object({ type: z.literal("select_director_result"), targetKind: z.enum(["asset", "keyframe", "segment"]), targetId: id, nodeId: id, generationLogId: id.optional(), taskId: id.optional(), storageKey: id, canvasRevision: z.number().int().nonnegative() }).strict(),
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
    z.object({ type: z.literal("set_archived"), archived: z.boolean() }).strict(),
    z.object({ type: z.literal("review_keyframe"), shotId: id, verdict: z.enum(["auto-accepted", "needs-redo"]), evidence: z.string().min(1) }).strict(),
]);

const productionOperationInputSchema = productionOperationSchema.superRefine((operation, context) => {
    if (operation.type !== "patch_director_source") return;
    const allowed = new Set<string>(directorPatchFields[operation.entity as keyof typeof directorPatchFields] as readonly string[]);
    for (const field of Object.keys(operation.patch)) if (!allowed.has(field)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["patch", field], message: `实体 ${operation.entity} 不允许修改字段 ${field}` });
    }
});

export const productionEditSchema = z.object({ operationId: id, expectedRevision: z.number().int().min(0).describe("读取制作稿的基线 revision；同字段写入按 Backend 成功提交顺序以后写入者为准；set_director_production 将 source 作为原子字段"), ops: z.array(productionOperationInputSchema).min(1), adoptions: z.array(z.object({ taskId: id, artifactHash: hash }).strict()).min(1).optional() }).strict();
export const productionPublishSchema = z.object({ operationId: id, expectedRevision: z.number().int().min(0).describe("读取制作稿的基线 revision；发布按当前目标输入与发布版本检查，不因无关 revision 增长拒绝"), stage: z.enum(["script", "shots", "director"]), scope: productionCompilationScopeSchema.optional() }).strict();
export const directorRunStartSchema = z.object({ runId: id, idempotencyKey: id, workId: id.optional(), expectedRevision: z.number().int().min(0).describe("读取制作稿的基线 revision；运行按所选目标的冻结输入校验"), version: z.number().int().min(0).default(0), inputBasis: z.enum(["canvas", "published"]).default("canvas"), expectedCanvasRevision: z.number().int().nonnegative().optional().describe("读取画布输入的基线 revision；不作为全局写锁"), expectedPlanHash: hash.optional().describe("生成预检返回的目标输入 manifest；传入时用于拒绝目标输入已变化的提交"), targets: z.array(id).min(1), scope: z.enum(["selected", "all_ready"]).default("selected") }).strict();
export const directorRunControlSchema = z.object({ runId: id }).strict();
export const productionContractQuerySchema = z.object({
    runtimeId: id.optional().describe("Deprecated: accepted for compatibility; the contract always uses the locally active Acheng runtime."),
    operationType: id.optional().describe("只接受 contract.operations[].type 中的精确操作标识；edit/publish/compile/generate 属于 contract.requests，不是 operationType。提供时默认只返回该操作的 schema、示例、前置条件和引擎身份；省略所有范围参数时仅返回查询指南。"),
    moduleId: z.enum(directorModules).optional().describe("按需读取单个模块的专属说明文件。"),
    includeRequests: z.boolean().optional().describe("operationType 已提供时，额外包含 edit/publish/compile/generate 请求 schema。"),
    includePatchFields: z.boolean().optional().describe("operationType 已提供时，额外包含完整 patchFields allowlist。"),
    includeSourceContract: z.boolean().optional().describe("operationType 已提供时，额外包含激活引擎的完整源稿校验合同。"),
    moduleFile: z.string().min(1).optional().describe("读取 moduleId 对应的精确文件；不传时只返回模块文件目录和摘要。正文按 chunkBytes/cursor 分块。"),
    chunkBytes: z.coerce.number().int().positive().max(65536).optional().describe("模块文件分块大小，默认 32768 字节，最大 65536。"),
    cursor: z.string().optional().describe("沿上次模块文件返回的 cursor 续读。"),
}).strict();
export function validateProductionContractQuery(input: z.infer<typeof productionContractQuerySchema>) {
    const invalid = (field: string, reason: string) => { throw Object.assign(new Error(`${field}: ${reason}`), { code: "INVALID_INPUT" }); };
    if ((input.includeRequests || input.includePatchFields || input.includeSourceContract) && !input.operationType) invalid("operationType", "完整合同附加项必须与精确 operationType 一起读取");
    if (input.moduleFile && !input.moduleId) invalid("moduleId", "读取模块文件时必须提供 moduleId");
    if ((input.chunkBytes !== undefined || input.cursor) && !input.moduleFile) invalid("moduleFile", "chunkBytes/cursor 只能用于精确 moduleFile 分块读取");
}
export const productionContinuityReadSchema = z.object({ snapshot: z.enum(["draft", "published"]).default("draft"), view: z.enum(["summary", "issues", "timeline", "shot"]).default("summary"), targetId: id.optional(), objectId: id.optional(), pageSize: z.coerce.number().int().positive().max(100).default(20), cursor: z.string().optional() }).strict();
export const productionContinuityCheckSchema = z.object({ expectedRevision: z.number().int().nonnegative(), operationId: id, snapshot: z.enum(["draft", "published"]).default("draft"), targetIds: z.array(id).optional() }).strict();
// Keep requests unparsed at this boundary so invalid inputs produce diagnostics,
// rather than disappearing into a transport-level schema error. Describe the
// action-specific required revision so callers can construct a valid request.
export const productionPreflightSchema = z.object({
    action: z.enum(["edit", "publish", "compile", "generate"]),
    request: z.record(z.unknown()).describe("按 action 传完整请求：compile 需 expectedRevision；edit/publish 需 operationId 和 expectedRevision；generate 需 runId、idempotencyKey、expectedRevision 和 targets。后端返回诊断，不要把 request 字段放在 request 外层。"),
}).strict();
type ProductionPreflightRequest =
    | { action: "edit"; request: z.infer<typeof productionEditSchema> }
    | { action: "publish"; request: z.infer<typeof productionPublishSchema> }
    | { action: "compile"; request: z.infer<typeof productionCompileSchema> }
    | { action: "generate"; request: z.infer<typeof directorRunStartSchema> };
export const productionPreflightRequestSchema: z.ZodType<ProductionPreflightRequest, z.ZodTypeDef, any> = z.discriminatedUnion("action", [
    z.object({ action: z.literal("edit"), request: productionEditSchema }),
    z.object({ action: z.literal("publish"), request: productionPublishSchema }),
    z.object({ action: z.literal("compile"), request: productionCompileSchema }),
    z.object({ action: z.literal("generate"), request: directorRunStartSchema }),
]);
export type ProductionNextAction = { action: "correct_source" | "refresh" | "configure" | "read_run" | "review" | "wait"; message: string; tool?: string; input?: Record<string, unknown> };
export type ProductionBlockingAction = "edit" | "compile" | "apply" | "publish" | "generate";
export type ProductionDiagnosticDetails = {
    stage?: "source_resolution" | "adoption_validation" | "projection_validation" | "media_validation";
    reason?: string;
    sourceProjectId?: string;
    sourceNodeId?: string;
    productionProjectId?: string;
    productionNodeId?: string;
    expectedSourceProjectId?: string;
    expectedSourceNodeId?: string;
};
export type ProductionDiagnostic = { code: string; path: string; targetId?: string; shotId?: string; origin?: "source" | "compiler"; matchedText?: string; blockingActions?: ProductionBlockingAction[]; blocksCompilation?: boolean; message: string; severity: "error" | "warning" | "unverified"; example?: unknown; details?: ProductionDiagnosticDetails; blockingRun?: { runId: string; status: string; taskIds: string[] }; nextAction?: ProductionNextAction };
export const diagnosticBlocksAction = (diagnostic: ProductionDiagnostic, action: ProductionBlockingAction) =>
    diagnostic.blockingActions ? diagnostic.blockingActions.includes(action) : diagnostic.severity === "error" && (action !== "compile" || diagnostic.blocksCompilation !== false);
export type ProductionPreflight = { readyTargets?: string[]; blockedTargets?: Array<{ targetId: string; code: string; message: string }>; warnings?: Array<{ targetId: string; code: string; message: string }>; planHash?: string; canvasRevision?: number; valid: boolean; contractVersion: string; engine: DirectorProduction["engine"] | null; revision: number | null; diagnostics: ProductionDiagnostic[]; generationReady: boolean; compileReady?: boolean; replayed?: boolean; nextActions?: ProductionNextAction[] };
export type DirectorRunStart = z.infer<typeof directorRunStartSchema>;

export type ProductionScene = z.infer<typeof productionSceneSchema>;
export type ProductionShot = z.infer<typeof productionShotSchema>;
export type EpisodeProductionData = z.infer<typeof episodeProductionDataSchema>;
export type ProductionOperation = z.infer<typeof productionOperationSchema>;
export type ProductionEdit = z.infer<typeof productionEditSchema>;
export type ProductionPublish = z.infer<typeof productionPublishSchema>;

export function emptyEpisodeProduction(): EpisodeProductionData {
    return { scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], settings: { mode: "manual", imageModel: "", h3Model: "", imageModels: {}, imageModelsByKind: {}, h3Models: {}, reviewPolicy: { ...defaultDirectorReviewPolicy } }, legacyImports: [] };
}
