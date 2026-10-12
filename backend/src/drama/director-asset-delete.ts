import crypto from "node:crypto";
import { canonicalProduction, type DirectorProduction, type ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";

type Row = Record<string, any>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
const valueOf = (row: Row) => String(row.asset_id || row.id || "");
const assetReferenceFields = new Set([
    "asset_id", "assetId", "asset_ids", "assetIds", "depends_on", "required_assets", "requiredAssets",
    "keyframeAssetId", "keyframe_asset_id", "anchor_asset_id", "sourceAssetId", "source_asset_id",
]);
const entityReferenceFields = new Set([
    "scene_id", "sceneId", "source_scene_id", "character_id", "characterId", "character_ids", "characterIds",
]);
const subjectReferenceFields = new Set([
    "subjectId", "subject_id", "subjectIds", "subject_ids", "speakerSubjectId", "speaker_subject_id",
    "pictureBindingIds", "picture_binding_ids", "attention_subject_ids",
]);
const factReferenceFields = new Set(["fact_id", "factId", "fact_ids", "factIds", "continuityFactIds", "continuity_facts"]);
const OMIT = Symbol("omit");

function hasDirectMatch(value: unknown, wanted: Set<string>): boolean {
    return typeof value === "string" && wanted.has(value);
}

function stripDirectMatches(value: unknown, wanted: Set<string>): unknown {
    return Array.isArray(value) ? value.filter(item => !hasDirectMatch(item, wanted)) : value;
}

/** Clear only structured links to the removed draft asset; prose and unrelated records remain intact. */
function detachReferences(value: unknown, assetIds: Set<string>, subjectIds: Set<string>, entityIds: Set<string>, factIds: Set<string>, parentKey = ""): any {
    if (Array.isArray(value)) {
        const result: unknown[] = [];
        for (const item of value) {
            if (item && typeof item === "object" && !Array.isArray(item)) {
                const row = item as Row;
                if (parentKey === "subject_usages" && hasDirectMatch(row.subjectId ?? row.subject_id, subjectIds)) continue;
                if (parentKey === "stateRequirements" && hasDirectMatch(row.factId ?? row.fact_id, factIds)) continue;
                if (parentKey === "pictureBindings" && hasDirectMatch(row.assetId ?? row.asset_id, assetIds)) continue;
                if ((parentKey === "keyframes" || parentKey === "references") && hasDirectMatch(row.assetId ?? row.asset_id, assetIds)) continue;
            }
            const next = detachReferences(item, assetIds, subjectIds, entityIds, factIds);
            if (next !== OMIT) result.push(next);
        }
        return result;
    }
    if (!value || typeof value !== "object") return value;
    const row = value as Row;
    if (typeof row.object_kind === "string" && (hasDirectMatch(row.object_id, assetIds) || hasDirectMatch(row.object_id, entityIds))) return OMIT;
    if (row.entityRef && typeof row.entityRef === "object") {
        const ref = row.entityRef as Row;
        if ((ref.kind === "asset" && hasDirectMatch(ref.id, assetIds)) || ((ref.kind === "scene" || ref.kind === "character") && hasDirectMatch(ref.id, entityIds))) return OMIT;
    }
    const result: Row = {};
    for (const [key, child] of Object.entries(row)) {
        if (key === "sharedSource" && child && typeof child === "object" && hasDirectMatch((child as Row).assetId, assetIds)) continue;
        if (key === "source_anchor" && child && typeof child === "object" && hasDirectMatch((child as Row).scene_id, entityIds)) {
            const anchor = detachReferences(child, assetIds, subjectIds, entityIds, factIds) as Row;
            if (hasDirectMatch((child as Row).id, entityIds)) delete anchor.id;
            if (Object.keys(anchor).length) result[key] = anchor;
            continue;
        }
        if (assetReferenceFields.has(key)) {
            if (Array.isArray(child)) result[key] = stripDirectMatches(child, assetIds);
            else if (!hasDirectMatch(child, assetIds)) result[key] = detachReferences(child, assetIds, subjectIds, entityIds, factIds, key);
            continue;
        }
        if (entityReferenceFields.has(key)) {
            if (Array.isArray(child)) result[key] = stripDirectMatches(child, entityIds);
            else if (!hasDirectMatch(child, entityIds)) result[key] = detachReferences(child, assetIds, subjectIds, entityIds, factIds, key);
            continue;
        }
        if (subjectReferenceFields.has(key)) {
            if (Array.isArray(child)) result[key] = stripDirectMatches(child, subjectIds);
            else if (!hasDirectMatch(child, subjectIds)) result[key] = detachReferences(child, assetIds, subjectIds, entityIds, factIds, key);
            continue;
        }
        if (factReferenceFields.has(key)) {
            if (Array.isArray(child)) result[key] = stripDirectMatches(child, factIds);
            else if (!hasDirectMatch(child, factIds)) result[key] = detachReferences(child, assetIds, subjectIds, entityIds, factIds, key);
            continue;
        }
        const next = detachReferences(child, assetIds, subjectIds, entityIds, factIds, key);
        if (next !== OMIT) result[key] = next;
    }
    return result;
}

export function createManualDirectorAsset(director: DirectorProduction, operation: Extract<ProductionOperation, { type: "create_manual_director_asset" }>, owner: { kind: "episode" | "canvas"; id: string }): void {
    const source = director.source as Record<string, any>;
    const plan = { ...operation.assetPlan, created_by: "manual" } as Row;
    const card = operation.assetCard as Row;
    const id = String(plan.id || "").trim();
    const kind = String(plan.kind || "");
    if (!id || !["character", "scene", "prop"].includes(kind) || plan.status !== "planned") throw new Error("MANUAL_ASSET_INVALID: assetPlan must be a planned character, scene or prop with a stable ID");
    if (String(card.id || "") !== id || String(card.asset_id || "") !== id || card.asset_kind !== kind) throw new Error(`MANUAL_ASSET_CARD_MISMATCH: ${id}`);
    if (rows(plan.depends_on).length || (Array.isArray(plan.depends_on) && plan.depends_on.length)) throw new Error(`MANUAL_ASSET_DEPENDENCIES_NOT_EMPTY: ${id}`);
    if (Array.isArray(card.references) && card.references.length) throw new Error(`MANUAL_ASSET_REFERENCES_NOT_EMPTY: ${id}`);
    if (rows(source.asset_plan).some(row => valueOf(row) === id) || rows(source.asset_cards).some(row => valueOf(row) === id)) throw new Error(`ASSET_ALREADY_EXISTS: ${id}`);

    const registryKind = kind === "character" || kind === "scene" ? kind : undefined;
    const entityId = registryKind ? String(plan.entity_id || "") : id;
    const registryEntity = operation.registryEntity as Row | undefined;
    if (registryKind) {
        if (operation.registryKind !== registryKind || !registryEntity || String(registryEntity.id || "") !== entityId || !String(registryEntity.name || "").trim()) throw new Error(`MANUAL_ASSET_REGISTRY_MISMATCH: ${id}`);
        const registry = registryKind === "character" ? "character_registry" : "scene_registry";
        if (rows(source[registry]).some(row => String(row.id || "") === entityId)) throw new Error(`ASSET_ENTITY_ALREADY_EXISTS: ${entityId}`);
    } else if (operation.registryKind || operation.registryEntity) throw new Error(`MANUAL_ASSET_REGISTRY_UNEXPECTED: ${id}`);

    const subject = operation.subject as Row | undefined;
    if (subject) {
        const expectedSubjectKind = registryKind || "asset";
        if (String(subject.entityRef?.ownerKind || "") !== owner.kind || String(subject.entityRef?.ownerId || "") !== owner.id) throw new Error(`MANUAL_ASSET_SUBJECT_OWNER_MISMATCH: ${id}`);
        if (String(subject.entityRef?.kind || "") !== expectedSubjectKind || String(subject.entityRef?.id || "") !== entityId || rows(subject.pictureBindings).length) throw new Error(`MANUAL_ASSET_SUBJECT_MISMATCH: ${id}`);
        if (rows(source.subject_registry).some(row => String(row.id || "") === String(subject.id || ""))) throw new Error(`SUBJECT_ALREADY_EXISTS: ${String(subject.id || "")}`);
    }

    const nextSource: Row = {
        ...source,
        asset_plan: [...rows(source.asset_plan), plan],
        asset_cards: [...rows(source.asset_cards), card],
    };
    if (registryKind) {
        const registry = registryKind === "character" ? "character_registry" : "scene_registry";
        nextSource[registry] = [...rows(source[registry]), registryEntity];
    }
    if (subject) nextSource.subject_registry = [...rows(source.subject_registry), subject];
    director.source = nextSource as DirectorProduction["source"];
    director.sourceHash = crypto.createHash("sha256").update(canonicalProduction(director.source)).digest("hex");
    director.artifacts = director.artifacts.map(artifact => ({ ...artifact, status: "stale" as const }));
    director.executionAuthorized = false;
    if (director.workflow.currentWork) director.workflow.currentWork = { ...director.workflow.currentWork, sourceHash: director.sourceHash };
}

/** Removes an asset definition and its asset-ID links while preserving its registered scene/character entity. */
export function deleteDirectorAsset(director: DirectorProduction, assetId: string): void {
    const id = assetId.trim();
    if (!id) throw new Error("ASSET_ID_REQUIRED: 资产 ID 不能为空");
    const source = director.source as Record<string, any>;
    const plans = rows(source.asset_plan), plan = plans.find(row => valueOf(row) === id);
    if (!plan) throw new Error(`ASSET_NOT_FOUND: ${id}`);

    const kind = String(plan.kind || plan.asset_type || plan.role || "").toLowerCase();
    const entityKind = kind === "character" || kind === "person" || kind === "role" ? "character"
        : kind === "scene" || kind === "environment" || kind === "location" ? "scene" : "asset";
    const allSubjects = rows(source.subject_registry);
    const relatedSubjects = entityKind === "asset"
        ? allSubjects.filter(subject => subject.entityRef?.kind === "asset" && String(subject.entityRef?.id || "") === id)
        : [];
    const subjectIds = new Set(relatedSubjects.map(subject => String(subject.id || "")));
    const bindingIds = new Set(relatedSubjects.flatMap(subject => rows(subject.pictureBindings).map(binding => String(binding.id || ""))));
    const subjectAndBindingIds = new Set([...subjectIds, ...bindingIds]);
    const assetIds = new Set([id]);
    const noEntityIds = new Set<string>();
    const cards = rows(source.asset_cards);
    const ledger = source.ledger && typeof source.ledger === "object" ? source.ledger as Row : undefined;
    const facts = rows(ledger?.facts);
    const removedFacts = new Set(facts.filter(fact => typeof fact.object_kind === "string" && assetIds.has(String(fact.object_id || "")))
        .map(fact => String(fact.id || "")).filter(Boolean));
    const removedEvents = new Set(rows(ledger?.events).filter(event => removedFacts.has(String(event.fact_id || ""))).map(event => String(event.id || "")).filter(Boolean));

    const sourceWithoutAsset: Record<string, any> = {
        ...source,
        asset_plan: plans.filter(row => valueOf(row) !== id),
        asset_cards: cards.filter(row => valueOf(row) !== id),
    };
    if (relatedSubjects.length) sourceWithoutAsset.subject_registry = allSubjects.filter(subject => !relatedSubjects.includes(subject));
    if (ledger) {
        const nextLedger = { ...ledger };
        if (Array.isArray(ledger.facts)) nextLedger.facts = ledger.facts.filter((fact: Row) => !removedFacts.has(String(fact?.id || "")));
        if (Array.isArray(ledger.initial)) nextLedger.initial = ledger.initial.filter((item: Row) => !removedFacts.has(String(item?.fact_id || "")));
        if (Array.isArray(ledger.events)) nextLedger.events = ledger.events.filter((item: Row) => !removedFacts.has(String(item?.fact_id || "")));
        if (Array.isArray(ledger.requirements)) nextLedger.requirements = ledger.requirements
            .filter((item: Row) => !removedFacts.has(String(item?.fact_id || "")))
            .map((item: Row) => ({
                ...item,
                event_ids: Array.isArray(item.event_ids) ? item.event_ids.filter((eventId: unknown) => !removedEvents.has(String(eventId))) : item.event_ids,
            }));
        if (Array.isArray(ledger.coverage)) nextLedger.coverage = ledger.coverage.map((item: Row) => ({
            ...item,
            fact_ids: Array.isArray(item.fact_ids) ? item.fact_ids.filter((factId: unknown) => !removedFacts.has(String(factId))) : item.fact_ids,
            event_ids: Array.isArray(item.event_ids) ? item.event_ids.filter((eventId: unknown) => !removedEvents.has(String(eventId))) : item.event_ids,
        }));
        sourceWithoutAsset.ledger = nextLedger;
    }
    const nextSource = detachReferences(sourceWithoutAsset, assetIds, subjectAndBindingIds, noEntityIds, removedFacts) as Record<string, any>;
    director.source = nextSource as DirectorProduction["source"];
    const nextAssets = Object.fromEntries(Object.entries(director.assets || {})
        .filter(([key]) => key !== id)
        .map(([key, value]) => [key, detachReferences(value, assetIds, subjectAndBindingIds, noEntityIds, removedFacts)])) as DirectorProduction["assets"];
    director.assets = nextAssets;
    director.shotInputs = detachReferences(director.shotInputs || {}, assetIds, subjectAndBindingIds, noEntityIds, removedFacts) as DirectorProduction["shotInputs"];
    director.sourceHash = crypto.createHash("sha256").update(canonicalProduction(director.source)).digest("hex");
    director.artifacts = director.artifacts.map(artifact => ({ ...artifact, status: "stale" as const }));
    director.executionAuthorized = false;
    if (director.workflow.currentWork) director.workflow.currentWork = { ...director.workflow.currentWork, sourceHash: director.sourceHash };
}
