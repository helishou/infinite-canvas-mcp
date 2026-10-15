import crypto from "node:crypto";
import { resizeShotAnchors } from "./subject-assembly.js";
import { isH3StyleTemplateId } from "../plugins/minimax-h3/style-templates.js";
import { currentCompilationArtifact } from "./compilation-scope.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z } from "zod";
import { directorPatchFields, productionContractVersion, productionOperationSchema, productionEditSchema, productionPublishSchema, productionCompileSchema, directorRunStartSchema, canonicalProduction, isSubjectPromptAssembly, scriptBlockSchema, shotAudioBindingSchema, type DirectorProduction, type ProductionDiagnostic } from "./production-contract.js";

const scene = { id: "scene-1", heading: "Interior", location: "Room", timeOfDay: "Day", blocks: [] };
const block = { id: "block-1", kind: "action", text: "The door opens." };
const examples: Record<string, unknown> = {
    set_director_production: { director: { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "example", runtimeId: "a".repeat(40) + "-" + "b".repeat(16), version: "example" }, source: { version: 2, prompt_assembly: { version: 2 }, subject_registry: [], shots: [], segments: [], utterances: [], asset_plan: [], character_registry: [], scene_registry: [], ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] } }, sourceHash: "0".repeat(64), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], unresolved: [] } },
    delete_director_subject: { id: "SUBJECT1" },
    create_manual_director_asset: { assetPlan: { id: "PROP1", kind: "prop", asset_name: "Prop", version: "v1", description: "", purpose: "", depends_on: [], status: "planned" }, assetCard: { id: "PROP1", asset_id: "PROP1", asset_kind: "prop", asset_version: "v1", prompt: "", references: [] } },
    remove_shared_director_asset: { id: "SHARED_ASSET1" },
    set_director_scene_environment: { sceneId: "SCENE1", environmentId: "ENV1" },
    upsert_director_subject: { subject: { id: "SUBJECT1", kind: "character", entityRef: { ownerKind: "episode", ownerId: "episode1", kind: "character", id: "CHARACTER1" }, pictureBindings: [
        { id: "BINDING1", assetId: "ASSET1", sourceNode: { projectId: "canvas1", nodeId: "image1" }, selection: { mode: "latest_success" }, provides: ["identity"], retain: ["face and hair"], exclude: ["pose and background"], applicableState: {}, defaultFor: ["identity"] },
    ] } },
    rebind_director_subject: { subjectId: "SUBJECT1", sourceProjectId: "shared-canvas1", sourceNodeId: "character-node1" },
    set_director_shot_keyframes: { shotId: "SHOT1", keyframes: [] },
    set_director_shot_utterances: { shotId: "SHOT1", utterances: [] },
    edit_director_shot: { action: "split", shotId: "SHOT1", newShotId: "SHOT2", splitFrame: 48, textOffsets: {} },
    repartition_director_clips: { shotIds: ["SHOT1", "SHOT2"], segments: [{ shot_ids: ["SHOT1"] }, { shot_ids: ["SHOT2"] }] },
    reverse_sync_director_prompt: { segmentId: "CLIP1", artifactId: "ARTIFACT1", sourceHash: "0".repeat(64), basePromptHash: "1".repeat(64), prompt: "Edited source-backed Prompt text", canvasRevision: 1 },
    edit_director_continuity: { changes: [{ collection: "facts", action: "upsert", id: "FACT1", value: { id: "FACT1", object_kind: "character", object_id: "CHARACTER1", allowed_values: ["outside"], value_descriptions: { outside: "The character stays outside." } } }] },
    replace_director_clip_storyboard: { segmentId: "CLIP1", segment: { id: "CLIP1", shot_ids: ["SHOT1"] }, shots: [{ id: "SHOT1", start_frame: 0, end_frame: 48 }], shotInputs: { SHOT1: { keyframePolicy: "none", assetIds: [] } } },
    request_director_clip_refresh: { segmentId: "CLIP1" },
    set_director_brief: { brief: "A traveller returns home." },
    patch_director_source: { entity: "asset", id: "character-1", patch: { description: "Authored character appearance." } },
    replace_director_scene_storyboard: { sceneId: "SC1", shots: [{ id: "SH1", source_scene_id: "SC1", start_frame: 0, end_frame: 120 }], segments: [{ id: "SEG1", shot_ids: ["SH1"], start_frame: 0, end_frame: 120 }], shotInputs: { SH1: { keyframePolicy: "none", assetIds: [] } } },
    archive_director_scene: { sceneId: "SC1", expectedCanvasRevision: 1, confirmed: true },
    delete_director_asset: { id: "PROP1", confirmed: true },
    restore_director_scene: { archiveId: "archive-1", expectedCanvasRevision: 1 },
    delete_director_clip: { segmentId: "SEG1", expectedCanvasRevision: 1, confirmed: true },
    adopt_director_fields: { targetId: "SEG001", nodeId: "h3-1", segmentId: "clip-1", canvasRevision: 1, fields: ["prompt"] },
    adopt_director_clip_style: { targetId: "segment-1", nodeId: "h3-node", segmentId: "clip-1", canvasRevision: 1, styleTemplateId: "soft-light" },
    set_director_workflow: { patch: { mediaProductionMode: "per_item" } },
    bind_director_asset: { assetId: "character-1", nodeId: "image-1" },
    adopt_shared_asset: { assetId: "character-1", approvedId: "approved-version-1", nodeId: "shared-reference-1" },
    bind_director_segment: { targetId: "SEG001", nodeId: "h3-1", segmentId: "clip-1" },
    set_director_boundary: { boundary: { from: "SEG001", to: "SEG002", tailFrame: true, motionContext: false, reason: "Continue the held state." } },
    set_director_segment_group: { segmentId: "SEG001", shotIds: ["shot-1"] },
    review_director_asset: { assetId: "character-1", version: 1, sourceHash: "0".repeat(64), nodeId: "image-1", storageKey: "media-1", sha256: "0".repeat(64), verdict: "approved", evidence: "Compared appearance against the reference." },
    select_director_result: { targetKind: "asset", targetId: "character-1", nodeId: "image-1", taskId: "canvas-task-1", storageKey: "media-1", canvasRevision: 0 },
    restore_archived_scene_results: { sourceNodeId: "archived-h3-1", expectedCanvasRevision: 0 },
    upsert_scene: { scene }, delete_scene: { id: scene.id }, reorder_scenes: { ids: [scene.id] },
    upsert_script_block: { sceneId: scene.id, block }, delete_script_block: { sceneId: scene.id, id: block.id }, reorder_script_blocks: { sceneId: scene.id, ids: [block.id] },
    upsert_shot: { shot: { id: "shot-1", sceneId: scene.id, title: "Arrival", duration: 5, visual: "The traveller enters.", camera: "Static", openingState: "Door closed", endingState: "Door open", sound: "Door creaks", assetNodeIds: [], keyframePolicy: "none" } },
    delete_shot: { id: "shot-1" }, reorder_shots: { sceneId: scene.id, ids: ["shot-1"] }, set_keyframe: { shotId: "shot-1", nodeId: "image-1" },
    set_clip_group: { group: { id: "SEG001", shotIds: ["shot-1"], nodeId: null, segmentId: null, sourceVersion: 0 } }, delete_clip_group: { id: "SEG001" },
    set_settings: { patch: { mode: "manual" } },
    review_keyframe: { shotId: "shot-1", verdict: "needs-redo", evidence: "The authored costume is missing." },
};

export function productionOperationContract(operationType?: string) {
    const options = productionOperationSchema.options.filter(option => !operationType || option.shape.type.value === operationType);
    if (!options.length) throw new Error(`Unknown production operation: ${operationType}`);
    return {
        contractVersion: productionContractVersion,
        jsonSchema: toJsonSchemaCompat(operationType ? options[0] : productionOperationSchema),
        requests: { edit: toJsonSchemaCompat(productionEditSchema), publish: toJsonSchemaCompat(productionPublishSchema), compile: toJsonSchemaCompat(productionCompileSchema.extend({ operationId: z.string().min(1) })), generate: toJsonSchemaCompat(directorRunStartSchema) },
        patchFields: directorPatchFields,
        operations: options.map(option => {
            const type = option.shape.type.value;
            return { type, example: option.parse({ type, ...examples[type] as object }), preconditions: type === "patch_director_source"
                ? ["Director exists; scene edits script_scenes, environment edits scene_registry, asset edits asset_plan, and asset_card edits asset_cards. Each object requires an existing stable ID and allowed fields; brief/style accept no ID; brief accepts only string value."]
                : type === "archive_director_scene" ? ["Requires explicit user confirmation and the current canvas revision. The scene, its Shots/Clips, and bound H3 canvas nodes are archived and restorable for 30 days; ordinary node deletion cannot bypass this operation."]
                : type === "create_manual_director_asset" ? ["Creates one manually authored character, scene or prop with its matching asset card and optional registry/Subject records in one revision-checked Backend operation. Shared-source records are accepted only for a node on the current drama's shared asset canvas. The Backend stamps created_by=manual; callers cannot confer manual origin through a source patch. IDs must be unique and all linked rows must refer to the same asset/entity."]
                : type === "remove_shared_director_asset" ? ["Removes only the current episode's registration and reference node for a shared source. Shot/dialogue users must be detached first; the shared canvas node and asset record are retained."]
                : type === "delete_director_asset" ? ["Requires explicit user confirmation. Removes the asset definition and its structured links from the current draft. Archived canvas media and production artifacts remain in history; affected compilation artifacts are marked stale. Canvas nodes/media are not deleted, and published versions remain immutable."]
                : type === "restore_director_scene" ? ["Archive must belong to this production, remain within its 30-day retention window, and have no ID conflicts; both production and canvas revisions must match."]
                : type === "delete_director_clip" ? ["Requires explicit confirmation; deletes the Clip and its owned Shots as one source transaction. A single Shot cannot be deleted while leaving an empty Clip."]
                : type === "select_director_result" ? ["Successful archived output must belong to the original formal task and exact node/Clip; pass generationLogId or its exact taskId; both revisions must match; active generation and shared reference replacement are rejected. Images require review after selection. No media generation or prompt/timeline replacement occurs."]
                : type === "restore_archived_scene_results" ? ["Episode draft only. Verifies the archive node, exact Clip identity, succeeded task, generation log and media bytes before restoring outputs to matching scene H3 nodes. Preserves the original archive and provenance; creates no task and does not modify the published version."]
                : type === "edit_director_shot" ? ["Prompt v2 only. Insert/duplicate/delete/move maintain stable Shot and Clip identities. Split/merge rebase local ledger events, timed performance, keyframes and utterance coverage without changing dialogue text or duration. Crossing dialogue text is allocated from the existing audio window by default; textOffsets is an optional override; supply cameraShotId when merging different cameras. Delete removes the Shot and its exclusive dialogue/events, retaining other Shots and remaining cross-Shot dialogue slices; dependent ledger references are cleaned atomically. Shot duration edits synchronize inherited appearances, keyframe anchors, timed actions/sounds and ledger anchors while leaving dialogue speed unchanged. Deleting the last Shot removes its Clip atomically; no separate command is required. Move stays within a Clip; Clip partition changes use repartition_director_clips."]
                : type === "upsert_director_subject" || type === "set_director_shot_keyframes" ? ["Use selection.mode=node_selection to follow the smart node's independent reference choice. latest_success and selected_result are explicit binding overrides. Browsing history does not restore generation settings."]
                : type === "set_director_production" ? ["Example is schema-valid only; replace hashes and engine with actual validated receipts."]
                : ["Target IDs, ownership, revision and production stage are checked against the current production."] };
        }),
    };
}

export function schemaDiagnostics(schema: z.ZodTypeAny, value: unknown, prefix = ""): ProductionDiagnostic[] {
    const parsed = schema.safeParse(value);
    return parsed.success ? [] : parsed.error.issues.map(issue => ({ code: issue.message.startsWith("UNSUPPORTED_PRODUCTION_FORMAT:") ? "UNSUPPORTED_PRODUCTION_FORMAT" : "INVALID_SCHEMA", path: [prefix, ...issue.path].filter(part => part !== "").join("."), message: issue.message, severity: "error" }));
}

export class ProductionValidationError extends Error {
    constructor(public readonly diagnostics: ProductionDiagnostic[]) { super(diagnostics.map(item => `${item.path}: ${item.message}`).join("; ")); }
}

export function ref2vaPromptDiagnostics(director: DirectorProduction, maximum: number | null): ProductionDiagnostic[] {
    const segments = Array.isArray(director.source.segments) ? director.source.segments as Array<Record<string, unknown>> : [];
    return (director.artifacts || []).flatMap((artifact, index) => {
        if (artifact.kind !== "h3" || artifact.status !== "ready" || segments.find(item => item.id === artifact.targetId)?.mode !== "Ref2VA") return [];
        // Inspect normalized newlines without changing the authored bytes/hash.
        const body = artifact.prompt.replace(/\r\n?/g, "\n").split("detailed_description:\n")[1]?.split("\n\noverall_soundscape:")[0] || "";
        const words = body.match(/\b[A-Za-z]+(?:[-'][A-Za-z]+)*\b/g)?.length || 0;
        const diagnostics = artifact.receipt.diagnostics as Record<string, any> | undefined;
        const declaredMinimum = diagnostics?.detailPolicy?.minimum_words;
        const matchedReceipt = artifact.receipt.validator === "compile_h3/validate_package"
            && artifact.receipt.engineRuntimeId === ((artifact.receipt.engine as DirectorProduction["engine"] | undefined) || director.engine).runtimeId
            && artifact.receipt.sourceHash === artifact.sourceHash
            && artifact.receipt.promptHash === artifact.sha256
            && diagnostics?.accepted === true && diagnostics?.formatPass === "PASSED";
        // Each artifact retains its actual compiler's policy after other targets use a newer engine.
        const minimum = matchedReceipt && Number.isInteger(declaredMinimum) && declaredMinimum >= 0 ? declaredMinimum : 2200;
        return words < minimum || (maximum !== null && words > maximum) ? [{ code: "INVALID_PROMPT_LENGTH", path: `director.artifacts.${index}.prompt`, targetId: artifact.targetId, message: `Ref2VA 正文词数不符合编译回执要求 (${words}, minimum ${minimum}, maximum ${maximum ?? "unbounded"})`, severity: "error" as const }] : [];
    });
}

const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

export function applyDirectorSourcePatch(director: DirectorProduction, entity: keyof typeof directorPatchFields, id: string | undefined, patch: Record<string, unknown>) {
        if (!Object.keys(patch).length) throw new Error("源字段修改内容为空");
        if (entity === "continuity") {
            if (id || Object.keys(patch).some(key => key !== "ledger") || !patch.ledger || typeof patch.ledger !== "object" || Array.isArray(patch.ledger)) throw new Error("连续性修改只接受无 ID 的 ledger 对象");
            director.source.ledger = patch.ledger;
        } else
        if (entity === "brief") {
            if (id || Object.keys(patch).some(key => key !== "value") || typeof patch.value !== "string") throw new Error("需求字段只接受不带 ID 的字符串 value");
            director.source.brief = patch.value;
        } else if (entity === "style") {
            if (id) throw new Error("风格锁修改不接受对象 ID");
            const forbidden = Object.keys(patch).filter(key => !(directorPatchFields.style as readonly string[]).includes(key));
            if (forbidden.length) throw new Error(`不允许直接修改风格字段：${forbidden.join(", ")}`);
            if (patch.style_policy !== undefined && !["required", "waived"].includes(String(patch.style_policy))) throw new Error("风格策略只能是 required 或 waived");
            if (patch.style_policy_reason !== undefined && typeof patch.style_policy_reason !== "string") throw new Error("风格理由必须是字符串");
            if (patch.anchor_asset_id !== undefined && typeof patch.anchor_asset_id !== "string") throw new Error("风格锚点 ID 必须是字符串");
            if (patch.style_anchor_node_id !== undefined && typeof patch.style_anchor_node_id !== "string") throw new Error("画布风格锚点节点 ID 必须是字符串");
            if (patch.anchor_asset_id) {
                const anchorId = String(patch.anchor_asset_id);
                const plans = Array.isArray(director.source.asset_plan) ? director.source.asset_plan.map(record) : [];
                if (!plans.some(item => String(item.asset_id || item.id || "") === anchorId && (String(item.role || item.asset_type || "").toUpperCase() === "STYLE_MOTHER" || String(item.kind || "").toLowerCase() === "style"))) throw new Error(`风格锚点 ${anchorId} 不是已登记的 STYLE_MOTHER 资产`);
            }
            const previousAnchorId = String(record(director.source.style_lock).anchor_asset_id || "");
            if (previousAnchorId && patch.anchor_asset_id !== undefined && !patch.anchor_asset_id) {
                const cards = Array.isArray(director.source.asset_cards) ? director.source.asset_cards.map(record) : [];
                const plans = Array.isArray(director.source.asset_plan) ? director.source.asset_plan.map(record) : [];
                const cardById = new Map(cards.map(card => [String(card.id || card.asset_id || ""), card]));
                for (const card of cards) {
                    const references = Array.isArray(card.references) ? card.references.map(record) : [];
                    card.references = references.filter(ref => !(String(ref.asset_id || "") === previousAnchorId && String(ref.role || "").toLowerCase() === "style"));
                    const stillUsed = (card.references as Array<Record<string, unknown>>).some(ref => String(ref.asset_id || "") === previousAnchorId);
                    if (stillUsed) continue;
                    const targetId = String(card.id || card.asset_id || "");
                    const plan = plans.find(item => String(item.asset_id || item.id || "") === targetId);
                    if (plan && Array.isArray(plan.depends_on)) plan.depends_on = plan.depends_on.filter((dependency: unknown) => String(dependency) !== previousAnchorId);
                }
                for (const plan of plans) {
                    const targetId = String(plan.asset_id || plan.id || "");
                    if (cardById.has(targetId)) continue;
                    const dependencyReferences = cards.some(card => String(card.id || card.asset_id || "") === targetId
                        && Array.isArray(card.references) && card.references.map(record).some(ref => String(ref.asset_id || "") === previousAnchorId));
                    if (!dependencyReferences && Array.isArray(plan.depends_on)) plan.depends_on = plan.depends_on.filter((dependency: unknown) => String(dependency) !== previousAnchorId);
                }
            }
            if (patch.style_policy !== undefined) director.source.style_policy = patch.style_policy;
            if (patch.style_policy_reason !== undefined) director.source.style_policy_reason = patch.style_policy_reason;
            if (patch.style_anchor_node_id !== undefined) {
                if (patch.style_anchor_node_id) {
                    director.source.style_anchor_node_id = patch.style_anchor_node_id;
                    delete director.source.style_lock;
                } else {
                    delete director.source.style_anchor_node_id;
                }
            }
            if (patch.anchor_asset_id !== undefined) {
                if (patch.anchor_asset_id) {
                    director.source.style_lock = { ...record(director.source.style_lock), anchor_asset_id: patch.anchor_asset_id };
                    delete director.source.style_anchor_node_id;
                } else if (patch.style_anchor_node_id !== undefined) {
                    delete director.source.style_lock;
                } else {
                    director.source.style_lock = { ...record(director.source.style_lock), anchor_asset_id: "" };
                }
            }
        } else if (entity === "spec") {
            // 文档级制作规格（fps、总时长、Clip 上限、交付范围、提示词细则）直接挂在 source 顶层，无对象 ID。
            if (id) throw new Error("制作规格不接受对象 ID");
            const forbidden = Object.keys(patch).filter(key => !(directorPatchFields.spec as readonly string[]).includes(key));
            if (forbidden.length) throw new Error(`不允许直接修改规格字段：${forbidden.join(", ")}`);
            for (const label of ["fps_num", "fps_den"]) if (Object.hasOwn(patch, label) && (!Number.isInteger(patch[label]) || Number(patch[label]) < 1)) throw new Error(`${label} 必须是 ≥1 的整数`);
            if (Object.hasOwn(patch, "generation_clip_limit") && (!Number.isInteger(patch.generation_clip_limit) || Number(patch.generation_clip_limit) < 1)) throw new Error("generation_clip_limit 必须是 ≥1 的整数");
            if (Object.hasOwn(patch, "delivery_scope") && typeof patch.delivery_scope !== "string") throw new Error("delivery_scope 必须是文字");
            if (Object.hasOwn(patch, "prompt_detail_policy")) {
                const policy = patch.prompt_detail_policy;
                if (!policy || typeof policy !== "object" || Array.isArray(policy) || typeof (policy as Record<string, unknown>).profile !== "string" || !String((policy as Record<string, unknown>).profile).trim()) throw new Error("prompt_detail_policy 必须是带非空 profile 的对象");
            }
            if (Object.hasOwn(patch, "production_total_duration")) {
                const value = String(patch.production_total_duration ?? "").trim();
                if (!value) delete director.source.production_total_duration;
                else if (!/^\d+(\.\d+)?$/.test(value) && !/^\d+\/\d+$/.test(value)) throw new Error("production_total_duration 只接受秒数或「帧数/每秒帧数」分数");
                else director.source.production_total_duration = /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
            }
            for (const key of ["fps_num", "fps_den", "generation_clip_limit", "delivery_scope", "prompt_detail_policy"] as const) if (Object.hasOwn(patch, key)) {
                if (key === "delivery_scope" && !String(patch[key]).trim()) delete director.source[key];
                else director.source[key] = patch[key];
            }
        } else if (entity === "story") {
            // 结构化故事线（梗概/A-B-C 支线/五幕弧光）合并进 source.story，保留其余键。
            if (id) throw new Error("故事线结构不接受对象 ID");
            const allowed = directorPatchFields.story as readonly string[];
            const forbidden = Object.keys(patch).filter(key => !allowed.includes(key));
            if (forbidden.length) throw new Error(`不允许直接修改故事线字段：${forbidden.join(", ")}`);
            const story = record(director.source.story);
            for (const key of ["synopsis", "A", "B", "C"] as const) if (Object.hasOwn(patch, key)) {
                if (typeof patch[key] !== "string") throw new Error(`故事线 ${key} 必须是文字`);
                story[key] = String(patch[key]);
            }
            if (Object.hasOwn(patch, "five_stage_arc")) {
                const arc = patch.five_stage_arc;
                if (!Array.isArray(arc) || arc.length !== 5 || arc.some(item => typeof item !== "string" || !String(item).trim())) throw new Error("five_stage_arc 必须是恰好五个非空阶段说明");
                story.five_stage_arc = arc.map(String);
            }
            if (Object.keys(patch).length) director.source.story = story;
        } else {
            if (!id) throw new Error("源对象修改缺少稳定 ID");
            const collection = ({ scene: "script_scenes", environment: "scene_registry", character: "character_registry", asset: "asset_plan", asset_card: "asset_cards", shot: "shots", segment: "segments" } as const)[entity];
            const items = Array.isArray(director.source[collection]) ? director.source[collection] as Array<Record<string, unknown>> : [];
            const fieldId = (item: Record<string, unknown>) => String(item.id || item.scene_id || item.asset_id || "");
            const target = items.find(item => fieldId(item) === id);
            if (!target) throw new Error(`${entity} ${id} 不存在；先由 Acheng 创建稳定对象`);
            const forbidden = Object.keys(patch).filter(key => !(directorPatchFields[entity] as readonly string[]).includes(key));
            if (forbidden.length) throw new Error(`不允许直接修改字段：${forbidden.join(", ")}`);
            if (entity === "scene" && Object.hasOwn(patch, "blocks")) {
                // 结构化剧本场次以整段数组替换 blocks（增段/删段/重排/换说话人都走这里）。
                // passthrough 保留编译期可能附加的段落扩展字段，不替作者删数据。
                const parsed = z.array(scriptBlockSchema.passthrough()).safeParse(patch.blocks);
                if (!parsed.success) throw new Error(`剧本段落必须是 {{id, kind: action|dialogue, text, speaker?}} 的数组；不合格条目：${parsed.error.issues.slice(0, 4).map(issue => issue.path.join(".") || "(根)").join(", ")}`);
                patch.blocks = parsed.data;
            }
            if (entity === "segment" && Object.hasOwn(patch, "styleTemplateId") && patch.styleTemplateId !== null && !(isH3StyleTemplateId(patch.styleTemplateId) || typeof patch.styleTemplateId === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/i.test(patch.styleTemplateId))) throw new Error("无效 H3 风格模板 ID");
            if (entity === "asset" && patch.canvas_scope !== undefined && !["shared", "episode"].includes(String(patch.canvas_scope))) throw new Error("资产画布归属只能是 shared 或 episode");
            if (entity === "asset" && patch.canvas_scope === "episode" && director.assets[id]?.sharedSource) throw new Error("已采用的剧目共享资产必须保留 shared 归属；需要本集专用版本时请新建分集资产");
            if (entity === "asset" && patch.status !== undefined && !["planned", "approved"].includes(String(patch.status))) throw new Error("资产计划状态只能是 planned 或 approved");
            if (entity === "asset" && patch.status !== undefined && id && Object.hasOwn(director.source, "style_lock")) {
                // style_lock 与锚点资产的审批状态必须同步：改锚点状态时校验不制造新的不一致。
                const lock = record(director.source.style_lock);
                const anchorId = String(lock.anchor_asset_id || "");
                if (anchorId === id) {
                    const lockStatus = String(lock.status || "planned");
                    const otherPlan = (Array.isArray(director.source.asset_plan) ? director.source.asset_plan : []).map(record)
                        .find(item => String(item.asset_id || item.id || "") === anchorId);
                    const planStatus = String(patch.status);
                    if (otherPlan && planStatus !== lockStatus && director.assets[anchorId]?.status !== planStatus)
                        throw new Error(`STYLE_MOTHER 状态必须与 style_lock.status（${lockStatus}）一致；请一并调整 style_lock 或先审批资产`);
                }
            }
            if (entity === "shot" && Object.hasOwn(patch, "features")) {
                const features = patch.features;
                if (!features || typeof features !== "object" || Array.isArray(features)) throw new Error("镜头特性必须是布尔标记对象");
                for (const [key, value] of Object.entries(features)) if (typeof value !== "boolean") throw new Error(`镜头特性 ${key} 只能是 true 或 false`);
            }
            if (entity === "shot" && Object.hasOwn(patch, "combat") && patch.combat !== null) {
                if (!patch.combat || typeof patch.combat !== "object" || Array.isArray(patch.combat)) throw new Error("打戏数据必须是对象，或用 null 清除");
                if (record(patch.features).combat === false) throw new Error("features.combat 关闭时不能保存打戏数据");
            }
            if (entity === "shot" && Object.hasOwn(patch, "performance") && patch.performance !== null) {
                const performance = patch.performance;
                if (!performance || typeof performance !== "object" || Array.isArray(performance)) throw new Error("表演设计必须是对象，或用 null 清除");
                const data = record(performance);
                const tracks = data.tracks;
                if (tracks !== undefined && (!tracks || typeof tracks !== "object" || Array.isArray(tracks))) throw new Error("表演轨道必须是对象");
                if (tracks && typeof tracks === "object" && !Array.isArray(tracks)) for (const [name, raw] of Object.entries(tracks)) {
                    const track = record(raw);
                    if (!Number.isInteger(track.start) || !Number.isInteger(track.end) || Number(track.start) < 0 || Number(track.end) < Number(track.start)) throw new Error(`表演轨道 ${name} 的 start/end 帧无效`);
                    if (typeof track.cue !== "string" || typeof track.visibility !== "string") throw new Error(`表演轨道 ${name} 需要 cue 与 visibility 文本`);
                }
            }
            if (entity === "segment" && Object.hasOwn(patch, "animation_term_ids")) {
                if (!Array.isArray(patch.animation_term_ids) || patch.animation_term_ids.some(item => typeof item !== "string" || !item.trim())) throw new Error("动画术语 ID 必须是非空字符串数组");
            }
            if (entity === "segment" && Object.hasOwn(patch, "animation_term_evidence")) {
                if (!Array.isArray(patch.animation_term_evidence)) throw new Error("动画术语证据必须是数组");
                const required = ["term_id", "term", "time_window", "observable_fact", "camera_or_layout", "sound_or_qa"];
                for (const [index, item] of patch.animation_term_evidence.entries()) {
                    const evidence = record(item);
                    for (const key of required) if (typeof evidence[key] !== "string" || !String(evidence[key]).trim()) throw new Error(`动画术语证据第 ${index + 1} 条缺少 ${key}`);
                }
            }
            if (entity === "segment" && Object.hasOwn(patch, "motion_profile")) {
                const profile = patch.motion_profile;
                if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("运动档案必须是字符串键值对象");
                for (const [key, value] of Object.entries(profile)) if (typeof value !== "string") throw new Error(`运动档案 ${key} 只能是文字说明`);
            }
            if (entity === "segment" && Object.hasOwn(patch, "summary")) {
                if (typeof patch.summary !== "string") throw new Error("段摘要必须是文字");
                if (!String(patch.summary).trim()) { delete patch.summary; delete target.summary; }
            }
            if (entity === "segment" && Object.hasOwn(patch, "audio_bindings")) {
                const parsed = z.array(shotAudioBindingSchema).safeParse(patch.audio_bindings);
                if (!parsed.success) throw new Error(`音频绑定不合格：${parsed.error.issues.slice(0, 4).map(issue => issue.path.join(".") || "(根)").join(", ")}`);
                patch.audio_bindings = parsed.data;
            }
            const previousDuration = Number(target.duration_frames);
            Object.assign(target, patch);
            // A production asset can point at a character/scene registry row. Keep
            // those display fields together at the source boundary so the normal
            // production projection updates the corresponding canvas entity node.
            if (entity === "asset" && target.entity_id) {
                const entityId = String(target.entity_id);
                const registries = [
                    ["character_registry", "character"],
                    ["scene_registry", "scene"],
                ] as const;
                const matches = registries.flatMap(([collection, kind]) => {
                    const row = (Array.isArray(director.source[collection]) ? director.source[collection] as Array<Record<string, any>> : [])
                        .find(item => String(item.id || "") === entityId);
                    return row ? [{ row, kind }] : [];
                });
                // Registry IDs are scoped by kind; an ambiguous cross-kind ID is
                // left untouched rather than guessing which entity owns the asset.
                if (matches.length === 1) {
                    const { row, kind } = matches[0];
                    if (["asset_name", "name", "title"].some(field => Object.hasOwn(patch, field))) {
                        row.name = String(patch.asset_name ?? patch.name ?? patch.title ?? "");
                    }
                    if (Object.hasOwn(patch, "description")) {
                        const fields = kind === "character" ? ["appearance", "description", "prompt_description", "identity"] : ["description", "prompt_description"];
                        const field = fields.find(key => typeof row[key] === "string" ? Boolean(row[key].trim()) : Boolean(row[key] && typeof row[key] === "object")) || fields[0];
                        const previous = row[field];
                        const description = patch.description;
                        row[field] = previous && typeof previous === "object"
                            ? { ...previous, ...(Object.hasOwn(previous, "description") ? { description } : Object.hasOwn(previous, "text") ? { text: description } : { description }) }
                            : description;
                    }
                }
            }
            if (entity === "shot" && isSubjectPromptAssembly(director.source) && previousDuration > 0 && Object.hasOwn(patch, "duration_frames") && Number.isInteger(target.duration_frames) && Number(target.duration_frames) > 0 && Number(target.duration_frames) !== previousDuration) {
                resizeShotAnchors(director.source, target, previousDuration);
            }
        }
        director.sourceHash = crypto.createHash("sha256").update(canonicalProduction(director.source)).digest("hex");
        // A changed source revision invalidates compile receipts. Recompilation may
        // retain identical prompts; target-level impact decides whether media is stale.
        director.artifacts = director.artifacts.map(artifact => currentCompilationArtifact(director, artifact) ? artifact : { ...artifact, status: "stale" as const });
        director.executionAuthorized = false;
    }

/** Continuation decisions belong to the authored adjacent edges, not inferred Clip defaults. */
export function continuityBoundaryDiagnostics(director: DirectorProduction, stage: "edit" | "compile" | "publish" | "generate" = "compile"): ProductionDiagnostic[] {
    const segments = (Array.isArray(director.source.segments) ? director.source.segments : []) as Array<Record<string, any>>;
    const boundaries = Array.isArray(director.boundaries) ? director.boundaries : [];
    const ids = segments.map(segment => String(segment.id || ""));
    const expected = ids.slice(0, -1).map((from, index) => ({ from, to: ids[index + 1] }));
    const diagnostics: ProductionDiagnostic[] = [];
    const issue = (code: string, from: string, message: string) => diagnostics.push({ code, path: "director.boundaries", targetId: from, severity: "warning", message,
        ...(stage === "generate" && code === "CONTINUITY_MODES_CONFLICT" ? { blockingActions: ["generate"] as const } : {}) });
    for (const pair of expected) {
        const rows = boundaries.filter(edge => edge.from === pair.from && edge.to === pair.to);
        if (rows.length !== 1) issue(rows.length ? "DUPLICATE_CONTINUITY_BOUNDARY" : "MISSING_CONTINUITY_BOUNDARY", pair.from, `${pair.from} → ${pair.to} 必须登记唯一的尾帧与潜空间决定；缺项不能当作关闭`);
        else if (typeof rows[0].tailFrame !== "boolean" || typeof rows[0].motionContext !== "boolean") issue("MISSING_CONTINUITY_FLAGS", pair.from, `${pair.from} → ${pair.to} 两项开关必须显式为 true 或 false`);
        else if (rows[0].tailFrame && rows[0].motionContext) issue("CONTINUITY_MODES_CONFLICT", pair.from, `${pair.from} → ${pair.to} 尾帧参考与 Motion Context 不能同时开启；请选择一种衔接方式，或两项都关闭`);
        else if (typeof rows[0].reason !== "string" || !rows[0].reason.trim()) issue("CONTINUITY_REASON_REQUIRED", pair.from, `${pair.from} → ${pair.to} 需要说明承接的动作/状态或断链的叙事事实`);
    }
    for (const edge of boundaries) if (!expected.some(pair => pair.from === edge.from && pair.to === edge.to)) issue("NON_ADJACENT_CONTINUITY_BOUNDARY", edge.from, `${edge.from} → ${edge.to} 不是当前相邻 Segment，不能连接旧边界或末段`);
    // Ordinary edited scenes may legitimately use cuts on every boundary.
    // Repeated cut reasons alone are not evidence that latent continuation is needed.
    return diagnostics;
}

export function outgoingDirectorBoundary(director: DirectorProduction, segmentId: string) {
    const segments = (Array.isArray(director.source.segments) ? director.source.segments : []) as Array<Record<string, any>>;
    const index = segments.findIndex(segment => segment.id === segmentId);
    if (index < 0) throw new Error(`Segment 未登记：${segmentId}`);
    if (index === segments.length - 1) return undefined;
    const to = String(segments[index + 1].id);
    const matches = director.boundaries.filter(edge => edge.from === segmentId);
    if (matches.length !== 1 || matches[0].to !== to || typeof matches[0].tailFrame !== "boolean" || typeof matches[0].motionContext !== "boolean" || typeof matches[0].reason !== "string" || !matches[0].reason.trim()) return undefined;
    if (matches[0].tailFrame && matches[0].motionContext) throw new Error(`CONTINUITY_MODES_CONFLICT: ${segmentId} → ${to} 尾帧参考与 Motion Context 不能同时开启`);
    return matches[0];
}
