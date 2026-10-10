import crypto from "node:crypto";
import { canonicalProduction, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";

type Row = Record<string, any>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
const valueOf = (row: Row) => String(row.asset_id || row.id || "");
const referenceFields = new Set([
    "asset_id", "assetId", "asset_ids", "assetIds", "depends_on", "required_assets", "requiredAssets",
    "keyframeAssetId", "keyframe_asset_id", "anchor_asset_id", "sourceAssetId", "source_asset_id",
    "subjectId", "subject_id", "subjectIds", "subject_ids", "speakerSubjectId", "speaker_subject_id",
    "pictureBindingIds", "picture_binding_ids", "scene_id", "sceneId", "source_scene_id",
    "character_id", "characterId", "character_ids", "characterIds",
]);

function matchedValues(value: unknown, wanted: Set<string>): string[] {
    if (typeof value === "string") return wanted.has(value) ? [value] : [];
    if (Array.isArray(value)) return value.flatMap(item => matchedValues(item, wanted));
    if (value && typeof value === "object") return Object.values(value as Row).flatMap(item => matchedValues(item, wanted));
    return [];
}

function collectReferences(value: unknown, path: string, assetIds: Set<string>, subjectIds: Set<string>, entityIds: Set<string>, found: string[]) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectReferences(item, `${path}[${index}]`, assetIds, subjectIds, entityIds, found));
        return;
    }
    if (!value || typeof value !== "object") return;
    const row = value as Row;
    if (row.entityRef && typeof row.entityRef === "object") {
        const ref = row.entityRef as Row;
        const matches = ref.kind === "asset" ? assetIds.has(String(ref.id || ""))
            : ref.kind === "scene" || ref.kind === "character" ? entityIds.has(String(ref.id || "")) : false;
        if (matches) found.push(`${path}.entityRef`);
    }
    if (typeof row.object_kind === "string" && (assetIds.has(String(row.object_id || "")) || entityIds.has(String(row.object_id || "")))) found.push(`${path}.object_id`);
    for (const [key, child] of Object.entries(row)) {
        if (key === "entityRef") continue;
        const wanted = key === "scene_id" || key === "sceneId" || key === "source_scene_id" || key === "character_id" || key === "characterId" || key === "character_ids" || key === "characterIds"
            ? entityIds : key === "subjectId" || key === "subject_id" || key === "subjectIds" || key === "subject_ids" || key === "speakerSubjectId" || key === "speaker_subject_id" || key === "pictureBindingIds" || key === "picture_binding_ids"
                ? subjectIds : referenceFields.has(key) ? assetIds : undefined;
        const matched = wanted ? matchedValues(child, wanted) : [];
        if (matched.length) {
            const label = row.id || row.asset_id || row.shot_id || row.scene_id || row.subjectId || row.subject_id;
            found.push(`${path}${label ? `#${label}` : ""}.${key} → ${[...new Set(matched)].join("/")}`);
        }
        collectReferences(child, `${path}.${key}`, assetIds, subjectIds, entityIds, found);
    }
}

export function directorHasAssetHistory(director: DirectorProduction | undefined, assetId: string): boolean {
    if (!director) return false;
    const id = assetId.trim();
    const source = director.source as Record<string, any>;
    if (rows(source.asset_plan).some(row => valueOf(row) === id) || rows(source.asset_cards).some(row => valueOf(row) === id)
        || Object.prototype.hasOwnProperty.call(director.assets || {}, id)
        || (director.artifacts || []).some(artifact => artifact.targetId === id)) return true;
    const references: string[] = [];
    collectReferences(source, "source", new Set([id]), new Set(), new Set(), references);
    collectReferences(director.shotInputs || {}, "shotInputs", new Set([id]), new Set(), new Set(), references);
    return references.length > 0;
}

/** Removes an unreferenced, never-materialized asset definition. Canvas media is retained. */
export function deleteManualDirectorAsset(director: DirectorProduction, assetId: string): void {
    const id = assetId.trim();
    if (!id) throw new Error("ASSET_ID_REQUIRED: 资产 ID 不能为空");
    const source = director.source as Record<string, any>;
    const plans = rows(source.asset_plan), plan = plans.find(row => valueOf(row) === id);
    if (!plan) throw new Error(`ASSET_NOT_FOUND: ${id}`);
    if (plan.created_by !== "manual") throw new Error(`ASSET_NOT_MANUAL: ${id}`);
    if (["approved", "generated", "rejected"].includes(String(plan.status || ""))) throw new Error(`ASSET_HAS_MEDIA_OR_HISTORY: ${id}`);

    const state = director.assets[id] as Row | undefined;
    if (state && (String(state.status || "planned") !== "planned" || state.nodeId || state.storageKey || state.generationTaskId || state.sha256 || state.sharedSource)) {
        throw new Error(`ASSET_HAS_MEDIA_OR_HISTORY: ${id}`);
    }
    if ((director.artifacts || []).some(artifact => artifact.targetId === id || rows(artifact.references).some(ref => String(ref.assetId || ref.asset_id || "") === id))) {
        throw new Error(`ASSET_HAS_MEDIA_OR_HISTORY: ${id}`);
    }

    const kind = String(plan.kind || plan.asset_type || plan.role || "").toLowerCase();
    const entityKind = kind === "character" || kind === "person" || kind === "role" ? "character"
        : kind === "scene" || kind === "environment" || kind === "location" ? "scene" : "asset";
    const entityId = String(plan.entity_id || plan.entityId || id);
    const allSubjects = rows(source.subject_registry);
    const relatedSubjects = allSubjects.filter(subject => subject.entityRef?.kind === entityKind && String(subject.entityRef?.id || "") === entityId);
    const subjectIds = new Set(relatedSubjects.map(subject => String(subject.id || "")));
    const bindingIds = new Set(relatedSubjects.flatMap(subject => rows(subject.pictureBindings).map(binding => String(binding.id || ""))));
    const assetIds = new Set([id]);
    const entityIds = new Set(entityKind === "asset" ? [] : [entityId]);
    const cards = rows(source.asset_cards);
    const scanSource = {
        ...source,
        asset_plan: plans.filter(row => valueOf(row) !== id),
        asset_cards: cards.filter(row => valueOf(row) !== id),
        subject_registry: allSubjects.filter(subject => !relatedSubjects.includes(subject)),
    };
    const subjectAndBindingIds = new Set([...subjectIds, ...bindingIds]);
    if (relatedSubjects.some(subject => rows(subject.pictureBindings).length > 0)) throw new Error(`ASSET_IS_BOUND: ${id} · subject_registry`);
    const usages: string[] = [];
    collectReferences(scanSource, "source", assetIds, subjectAndBindingIds, entityIds, usages);
    collectReferences(director.shotInputs || {}, "shotInputs", assetIds, subjectAndBindingIds, entityIds, usages);
    const otherAssets = Object.fromEntries(Object.entries(director.assets || {}).filter(([key]) => key !== id));
    collectReferences(otherAssets, "assets", assetIds, subjectAndBindingIds, entityIds, usages);
    if (usages.length) throw new Error(`ASSET_STILL_REFERENCED: ${id} · ${[...new Set(usages)].join(", ")}`);

    const registry = entityKind === "character" ? "character_registry" : entityKind === "scene" ? "scene_registry" : undefined;
    const nextSource: Record<string, any> = {
        ...source,
        asset_plan: plans.filter(row => valueOf(row) !== id),
        asset_cards: cards.filter(row => valueOf(row) !== id),
        subject_registry: allSubjects.filter(subject => !relatedSubjects.includes(subject)),
    };
    if (registry) nextSource[registry] = rows(source[registry]).filter(row => String(row.id || "") !== entityId);
    director.source = nextSource as DirectorProduction["source"];
    const nextAssets = { ...director.assets };
    delete nextAssets[id];
    director.assets = nextAssets;
    director.sourceHash = crypto.createHash("sha256").update(canonicalProduction(director.source)).digest("hex");
    director.artifacts = director.artifacts.map(artifact => ({ ...artifact, status: "stale" as const }));
    director.executionAuthorized = false;
    if (director.workflow.currentWork) director.workflow.currentWork = { ...director.workflow.currentWork, sourceHash: director.sourceHash };
}
