import crypto from "node:crypto";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z } from "zod";
import { directorPatchFields, productionContractVersion, productionOperationSchema, productionEditSchema, productionPublishSchema, directorRunStartSchema, canonicalProduction, type DirectorProduction, type ProductionDiagnostic } from "./production-contract.js";

const scene = { id: "scene-1", heading: "Interior", location: "Room", timeOfDay: "Day", blocks: [] };
const block = { id: "block-1", kind: "action", text: "The door opens." };
const examples: Record<string, unknown> = {
    set_director_production: { director: { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "example", runtimeId: "a".repeat(40) + "-" + "b".repeat(16), version: "example" }, source: {}, sourceHash: "0".repeat(64), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], unresolved: [] } },
    set_director_brief: { brief: "A traveller returns home." },
    patch_director_source: { entity: "asset", id: "character-1", patch: { description: "Authored character appearance." } },
    set_director_workflow: { patch: { mediaProductionMode: "per_item" } },
    bind_director_asset: { assetId: "character-1", nodeId: "image-1" },
    adopt_shared_asset: { assetId: "character-1", approvedId: "approved-version-1", nodeId: "shared-reference-1" },
    bind_director_segment: { targetId: "SEG001", nodeId: "h3-1", segmentId: "clip-1" },
    set_director_boundary: { boundary: { from: "SEG001", to: "SEG002", tailFrame: true, motionContext: false, reason: "Continue the held state." } },
    set_director_segment_group: { segmentId: "SEG001", shotIds: ["shot-1"] },
    review_director_asset: { assetId: "character-1", version: 1, sourceHash: "0".repeat(64), nodeId: "image-1", storageKey: "media-1", sha256: "0".repeat(64), verdict: "approved", evidence: "Compared appearance against the reference." },
    select_director_result: { targetKind: "asset", targetId: "character-1", nodeId: "image-1", generationLogId: "log-1", storageKey: "media-1", canvasRevision: 0 },
    upsert_scene: { scene }, delete_scene: { id: scene.id }, reorder_scenes: { ids: [scene.id] },
    upsert_script_block: { sceneId: scene.id, block }, delete_script_block: { sceneId: scene.id, id: block.id }, reorder_script_blocks: { sceneId: scene.id, ids: [block.id] },
    upsert_shot: { shot: { id: "shot-1", sceneId: scene.id, title: "Arrival", duration: 5, visual: "The traveller enters.", camera: "Static", openingState: "Door closed", endingState: "Door open", sound: "Door creaks", assetNodeIds: [], keyframePolicy: "none" } },
    delete_shot: { id: "shot-1" }, reorder_shots: { sceneId: scene.id, ids: ["shot-1"] }, set_keyframe: { shotId: "shot-1", nodeId: "image-1" },
    set_clip_group: { group: { id: "SEG001", shotIds: ["shot-1"], nodeId: null, segmentId: null, sourceVersion: 0 } }, delete_clip_group: { id: "SEG001" },
    set_settings: { patch: { mode: "manual" } }, import_legacy: { source: "fullPlot" },
    review_keyframe: { shotId: "shot-1", verdict: "needs-redo", evidence: "The authored costume is missing." },
};

export function productionOperationContract(operationType?: string) {
    const options = productionOperationSchema.options.filter(option => !operationType || option.shape.type.value === operationType);
    if (!options.length) throw new Error(`Unknown production operation: ${operationType}`);
    return {
        contractVersion: productionContractVersion,
        jsonSchema: toJsonSchemaCompat(operationType ? options[0] : productionOperationSchema),
        requests: { edit: toJsonSchemaCompat(productionEditSchema), publish: toJsonSchemaCompat(productionPublishSchema), generate: toJsonSchemaCompat(directorRunStartSchema) },
        patchFields: directorPatchFields,
        operations: options.map(option => {
            const type = option.shape.type.value;
            return { type, example: option.parse({ type, ...examples[type] as object }), preconditions: type === "patch_director_source"
                ? ["Director exists; scene/asset/shot/segment require an existing stable ID; patch uses allowed fields; brief/style accept no ID; brief accepts only string value."]
                : type === "select_director_result" ? ["Successful archived output must belong to the original formal task and exact node/Clip; both revisions must match; active generation and shared reference replacement are rejected. Images require review after selection. No media generation or prompt/timeline replacement occurs."]
                : type === "set_director_production" ? ["Example is schema-valid only; replace hashes and engine with actual validated receipts."]
                : ["Target IDs, ownership, revision and production stage are checked against the current production."] };
        }),
    };
}

export function schemaDiagnostics(schema: z.ZodTypeAny, value: unknown, prefix = ""): ProductionDiagnostic[] {
    const parsed = schema.safeParse(value);
    return parsed.success ? [] : parsed.error.issues.map(issue => ({ code: "INVALID_SCHEMA", path: [prefix, ...issue.path].filter(part => part !== "").join("."), message: issue.message, severity: "error" }));
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
        return words < 2200 || (maximum !== null && words > maximum) ? [{ code: "INVALID_PROMPT_LENGTH", path: `director.artifacts.${index}.prompt`, targetId: artifact.targetId, message: `Ref2VA 正文词数不符合固定引擎要求 (${words}, minimum 2200, maximum ${maximum ?? "unbounded"})`, severity: "error" as const }] : [];
    });
}

const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

export function applyDirectorSourcePatch(director: DirectorProduction, entity: keyof typeof directorPatchFields, id: string | undefined, patch: Record<string, unknown>) {
        if (!Object.keys(patch).length) throw new Error("源字段修改内容为空");
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
            if (patch.anchor_asset_id) {
                const anchorId = String(patch.anchor_asset_id);
                const plans = Array.isArray(director.source.asset_plan) ? director.source.asset_plan.map(record) : [];
                if (!plans.some(item => String(item.asset_id || item.id || "") === anchorId && (String(item.role || item.asset_type || "").toUpperCase() === "STYLE_MOTHER" || String(item.kind || "").toLowerCase() === "style"))) throw new Error(`风格锚点 ${anchorId} 不是已登记的 STYLE_MOTHER 资产`);
            }
            if (patch.style_policy !== undefined) director.source.style_policy = patch.style_policy;
            if (patch.style_policy_reason !== undefined) director.source.style_policy_reason = patch.style_policy_reason;
            if (patch.anchor_asset_id !== undefined) director.source.style_lock = { ...record(director.source.style_lock), anchor_asset_id: patch.anchor_asset_id };
        } else {
            if (!id) throw new Error("源对象修改缺少稳定 ID");
            const collection = ({ scene: "script_scenes", asset: "asset_plan", shot: "shots", segment: "segments" } as const)[entity];
            const items = Array.isArray(director.source[collection]) ? director.source[collection] as Array<Record<string, unknown>> : [];
            const fieldId = (item: Record<string, unknown>) => String(item.id || item.scene_id || item.asset_id || "");
            const target = items.find(item => fieldId(item) === id);
            if (!target) throw new Error(`${entity} ${id} 不存在；先由 Acheng 创建稳定对象`);
            const forbidden = Object.keys(patch).filter(key => !(directorPatchFields[entity] as readonly string[]).includes(key));
            if (forbidden.length) throw new Error(`不允许直接修改字段：${forbidden.join(", ")}`);
            Object.assign(target, patch);
        }
        director.sourceHash = crypto.createHash("sha256").update(canonicalProduction(director.source)).digest("hex");
        // A changed source revision invalidates compile receipts. Recompilation may
        // retain identical prompts; target-level impact decides whether media is stale.
        director.artifacts = director.artifacts.map(artifact => ({ ...artifact, status: "stale" as const }));
        director.executionAuthorized = false;
    }
