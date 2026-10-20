import crypto from "node:crypto";
import { canonicalProduction, isSubjectPromptAssembly, productionEntities, type EpisodeProductionData, type ProductionEntityBinding, type ProductionLayoutPlan } from "@basketikun/canvas-agent/drama/production-contract";
import { applyDirectorSourcePatch, changedModelTextIdDiagnostics, ProductionValidationError } from "@basketikun/canvas-agent/drama/production-validation";
import type { BackendDatabase } from "../db.js";
import type { CanvasOperation } from "../canvas/project-ops.js";
import { directorHash, projectDirector, withoutDirectorProjection } from "./director.js";
import { deleteDirectorAsset } from "./director-asset-delete.js";
import { productionLayoutStableId } from "./production-layout-geometry.js";
import { resolveCanvasImageReferenceNode } from "../canvas/image-references.js";

type Owner = { kind: "episode" | "canvas" | "scene"; id: string };
const nodes = (project: Record<string, any>): Record<string, any>[] => project.nodes || [];
const h3ProjectionFields = ["sourceShotId", "title", "duration", "taskMode", "prompt", "referenceBindings", "tailFrameContinuation", "motionContextEnabled", "directorEngine", "directorSourceHash", "styleTemplateId", "h3CharacterGroups", "storyboardShots", "aspectRatio", "modelName"];
const projectionHash = (value: unknown) => crypto.createHash("sha256").update(canonicalProduction(value ?? null)).digest("hex");
function h3InputHash(segment: Record<string, any>) {
    const fields: Array<[string, unknown]> = h3ProjectionFields.map(key => [key, segment[key] ?? null]);
    if (segment.productionClipProjection?.styleTemplateDeclared === true) fields.push(["styleTemplateDeclared", true]);
    return projectionHash(fields);
}
function subjectImageForEntity(project: Record<string, any>, source: Record<string, any>, owner: Owner, entity: { kind: string; entityId: string }) {
    if (entity.kind !== "prop" && entity.kind !== "scene") return undefined;
    const refKind = entity.kind === "prop" ? "asset" : "scene";
    const subject = (Array.isArray(source.subject_registry) ? source.subject_registry : []).find((item: Record<string, any>) => item.entityRef?.ownerKind === owner.kind
        && item.entityRef?.ownerId === owner.id && item.entityRef?.kind === refKind && String(item.entityRef?.id || "") === entity.entityId);
    const bindings = (Array.isArray(subject?.pictureBindings) ? subject.pictureBindings : []) as Array<Record<string, any>>;
    const binding = bindings.find(item => Array.isArray(item.defaultFor) && item.defaultFor.includes("identity")) || bindings[0];
    const sourceNode = binding?.sourceNode?.projectId === project.id ? nodes(project).find(node => node.id === binding.sourceNode.nodeId) : undefined;
    if (!sourceNode) return undefined;
    const selection = binding.selection && typeof binding.selection === "object" ? binding.selection as Record<string, any> : {};
    const references = resolveCanvasImageReferenceNode(sourceNode);
    const selectedId = selection.mode === "selected_result" ? String(selection.resultId || "") : "";
    const reference = selectedId ? references.find(item => item.id === selectedId || item.storageKey === selectedId) : references[0];
    const metadata = sourceNode.metadata || {};
    const imageRows = Array.isArray(metadata.images) ? metadata.images as Array<Record<string, any>> : [];
    const image = imageRows.find(item => String(item.id || "") === selectedId || String(item.storageKey || "") === selectedId) || {};
    const storageKey = String(reference?.storageKey || image.storageKey || metadata.storageKey || sourceNode.storageKey || "");
    if (!storageKey) return undefined;
    const key = entity.kind === "prop" ? "propImage" : "sceneImage";
    return { [key]: {
        storageKey,
        ...(reference?.url || image.url || metadata.content || sourceNode.content ? { url: String(reference?.url || image.url || metadata.content || sourceNode.content) } : {}),
        name: String(image.name || reference?.name || sourceNode.title || entity.entityId),
        ...(Number(image.width || image.naturalWidth || metadata.naturalWidth || sourceNode.naturalWidth) ? { width: Number(image.width || image.naturalWidth || metadata.naturalWidth || sourceNode.naturalWidth) } : {}),
        ...(Number(image.height || image.naturalHeight || metadata.naturalHeight || sourceNode.naturalHeight) ? { height: Number(image.height || image.naturalHeight || metadata.naturalHeight || sourceNode.naturalHeight) } : {}),
        ...(Number(image.bytes || metadata.bytes || sourceNode.bytes) ? { bytes: Number(image.bytes || metadata.bytes || sourceNode.bytes) } : {}),
        mimeType: String(image.mimeType || reference?.mimeType || metadata.mimeType || sourceNode.mimeType || "image/png"),
    } };
}
export function normalizeEntityNodeOperation(project: Record<string, any>, operation: CanvasOperation) {
    if (operation.type !== "update_node") return operation;
    const node = nodes(project).find(node => node.id === operation.id), binding = node?.metadata?.productionEntity as ProductionEntityBinding | undefined;
    if (!binding) return operation;
    const patch = (operation.patch || {}) as Record<string, any>, metadata = (operation.metadata || {}) as Record<string, any>;
    if (patch.type && patch.type !== binding.kind) throw new Error("制作实体节点类型不能直接修改");
    const nameKey = `${binding.kind}Name`;
    const name = metadata[nameKey] ?? patch.metadata?.[nameKey];
    if (name !== undefined) operation.patch = { ...patch, title: String(name) };
    else if (patch.title !== undefined) operation.metadata = { ...metadata, [nameKey]: String(patch.title) };
    return operation;
}
export const entityNodeId = (owner: Owner, kind: string, id: string) => productionLayoutStableId("production-entity", owner.kind, owner.id, kind, id);
export function entityNodeOperations(project: Record<string, any>, data: EpisodeProductionData, owner: Owner, previous: EpisodeProductionData | undefined, layout: ProductionLayoutPlan): CanvasOperation[] {
    if (!data.director) return [];
    const planRows = Array.isArray(data.director.source.asset_plan) ? data.director.source.asset_plan as Array<Record<string, any>> : [];
    const prior = new Map(productionEntities(previous?.director?.source || {}, owner).map(entity => [`${entity.kind}:${entity.entityId}`, entity]));
    return productionEntities(data.director.source, owner).flatMap((entity): CanvasOperation[] => {
        const binding: ProductionEntityBinding = { ownerKind: owner.kind, ownerId: owner.id, kind: entity.kind, entityId: entity.entityId };
        const unit = layout.units.find(unit => unit.id === `entity:${entity.kind}:${entity.entityId}`);
        const member = unit?.members[0];
        if (!member) throw new Error("制作实体缺少正式画布布局");
        const node = nodes(project).find(node => node.id === member.nodeId);
        const nameKey = `${entity.kind}Name`, descriptionKey = `${entity.kind}Description`;
        const imageProjection = subjectImageForEntity(project, data.director!.source as Record<string, any>, owner, entity);
        const linkedPlan = planRows.find(plan => String(plan.entity_id || plan.id || plan.asset_id || "") === entity.entityId && plan.sharedSource);
        const sharedSource = linkedPlan?.sharedSource as { dramaId?: string; assetId?: string; sourceProjectId?: string; sourceNodeId?: string } | undefined;
        const sharedAssetReference = sharedSource?.dramaId && sharedSource.assetId && sharedSource.sourceProjectId && sharedSource.sourceNodeId
            ? { dramaId: sharedSource.dramaId, assetId: sharedSource.assetId, sourceProjectId: sharedSource.sourceProjectId, sourceNodeId: sharedSource.sourceNodeId, writeThrough: true }
            : undefined;
        if (!node) return [{ type: "add_node", id: member.nodeId, nodeType: entity.kind, title: entity.name, position: member.position, width: member.size.width, height: member.size.height,
            metadata: { productionEntity: binding, [nameKey]: entity.name, [descriptionKey]: entity.description, productionLayoutUnitId: unit!.id, productionLayoutBounds: member.size,
                ...(sharedAssetReference ? { sharedAssetReference } : {}), ...(imageProjection || {}) } }];
        if (node.type !== entity.kind) throw new Error("制作实体节点类型冲突，未覆盖原节点");
        if (node.metadata?.productionEntity && JSON.stringify(node.metadata.productionEntity) !== JSON.stringify(binding)) throw new Error("制作实体节点来源冲突");
        const metadata: Record<string, any> = { productionEntity: binding, productionLayoutUnitId: unit!.id, productionLayoutBounds: member.size };
        if (sharedAssetReference) metadata.sharedAssetReference = sharedAssetReference;
        if (imageProjection) Object.assign(metadata, imageProjection);
        const old = prior.get(`${entity.kind}:${entity.entityId}`);
        for (const [field, value, baseline] of [[nameKey, entity.name, old?.name], [descriptionKey, entity.description, old?.description]] as const) {
            if (old && value === baseline) continue;
            const actual = String(node.metadata?.[field] || "");
            if (actual === value) continue;
            // Only a changed source field can conflict; leave unrelated local fields untouched.
            if (old && node.metadata?.productionEntity && actual !== baseline) throw new Error("制作实体的同一字段已变化，请回读后再编辑");
            metadata[field] = value;
        }
        const reference = node.metadata?.sharedAssetReference;
        if (reference) {
            if (reference.writeThrough) {
                metadata.sharedAssetReference = { ...reference };
                delete metadata.sharedAssetReference.edits;
            } else {
            const edits = { ...reference.edits };
            for (const key of [nameKey, descriptionKey]) if (Object.hasOwn(metadata, key)) {
                const field = `metadata.${key}`, base = edits[field] ? edits[field].base : node.metadata?.[key];
                if (JSON.stringify(metadata[key]) === JSON.stringify(base)) delete edits[field];
                else edits[field] = { base, value: metadata[key] };
            }
            if (metadata[nameKey] !== undefined) {
                const base = edits.title ? edits.title.base : node.title;
                if (entity.name === base) delete edits.title; else edits.title = { base, value: entity.name };
            }
            metadata.sharedAssetReference = { ...reference, edits };
            }
        }
        const patch = (!old || old.name !== entity.name) && node.title !== entity.name ? { title: entity.name } : undefined;
        return patch || Object.entries(metadata).some(([key, value]) => JSON.stringify(node.metadata?.[key]) !== JSON.stringify(value)) ? [{ type: "update_node", id: node.id, patch, metadata }] : [];
    });
}

/** Unlink an explicitly removed shared production entity from its episode canvas. */
export function removedSharedEntityNodeOperations(project: Record<string, any>, before: EpisodeProductionData | undefined, after: EpisodeProductionData, owner: Owner): CanvasOperation[] {
    if (!before?.director || !after.director || owner.kind !== "episode") return [];
    const nextIds = new Set(productionEntities(after.director.source, owner).map(entity => `${entity.kind}:${entity.entityId}`));
    return productionEntities(before.director.source, owner).flatMap((entity): CanvasOperation[] => {
        if (!entity.assetIds.some(assetId => {
            const plan = (before.director!.source.asset_plan as Array<Record<string, any>> || []).find(item => String(item.id || item.asset_id || "") === assetId);
            return Boolean(plan?.sharedSource);
        }) || nextIds.has(`${entity.kind}:${entity.entityId}`)) return [];
        const binding: ProductionEntityBinding = { ownerKind: owner.kind, ownerId: owner.id, kind: entity.kind, entityId: entity.entityId };
        const node = nodes(project).find(item => JSON.stringify(item.metadata?.productionEntity) === JSON.stringify(binding));
        return node ? [{ type: "delete_node", id: node.id }] : [];
    });
}

/** Reverse edits to definitions in the same ops transaction; media remains on its canvas node. */
export function syncEntityNodeEdits(db: BackendDatabase, projectId: string, before: Record<string, any>, after: Record<string, any>) {
    const empty = { updates: [] as Array<{ entityId: string; revision: number }>, operations: [] as CanvasOperation[] };
    if (!nodes(before).some(node => node.metadata?.productionEntity)) return empty;
    const episode = db.getDramaEpisodeByCanvasId(projectId);
    const owner: Owner = episode ? { kind: "episode", id: episode.id } : { kind: "canvas", id: projectId };
    const table = episode ? "episode_productions" : "canvas_productions", column = episode ? "episode_id" : "project_id";
    const row = db.db.prepare(`SELECT revision,draft_json FROM ${table} WHERE ${column}=?`).get(owner.id) as { revision: number; draft_json: string } | undefined;
    if (!row) return empty;
    const draft = JSON.parse(row.draft_json) as EpisodeProductionData;
    if (!draft.director) return empty;
    const previousSource = structuredClone(draft.director.source);
    let changed = false;
    for (const entity of productionEntities(draft.director.source, owner)) {
        const old = nodes(before).find(node => node.metadata?.productionEntity?.kind === entity.kind && node.metadata.productionEntity.entityId === entity.entityId);
        if (!old) continue;
        const node = nodes(after).find(node => node.id === old.id);
        if (!node) {
            const entityReferenceKind = entity.kind === "prop" ? "asset" : entity.kind;
            const subjects = (draft.director.source.subject_registry as Array<Record<string, any>> || []).filter(subject => subject.entityRef?.ownerKind === owner.kind && subject.entityRef?.ownerId === owner.id
                && subject.entityRef?.kind === entityReferenceKind && String(subject.entityRef?.id || "") === (entity.kind === "prop" ? entity.entityId : entity.entityId));
            const subjectIds = new Set(subjects.map(subject => String(subject.id || "")));
            const source = draft.director.source as Record<string, any>;
            if ((Array.isArray(source.shots) ? source.shots : []).some((shot: Record<string, any>) => (Array.isArray(shot.subject_usages) ? shot.subject_usages : []).some((usage: Record<string, any>) => subjectIds.has(String(usage.subjectId || "")))
                || (Array.isArray(shot.camera?.attention_subject_ids) ? shot.camera.attention_subject_ids : []).some((id: unknown) => subjectIds.has(String(id)))
                || (Array.isArray(shot.keyframes) ? shot.keyframes : []).some((frame: Record<string, any>) => (frame.subjectIds || []).some((id: unknown) => subjectIds.has(String(id))))
                || (Array.isArray(shot.reference_requirements) ? shot.reference_requirements : []).some((reference: Record<string, any>) => (reference.subjectIds || []).some((id: unknown) => subjectIds.has(String(id)))))
                || (Array.isArray(source.utterances) ? source.utterances : []).some((line: Record<string, any>) => subjectIds.has(String(line.speakerSubjectId || "")))
                || entity.kind === "character" && (Array.isArray(source.shots) ? source.shots : []).some((shot: Record<string, any>) => (Array.isArray(shot.characters) ? shot.characters : []).some((character: any) => String(character.id || character.character_id || character) === entity.entityId))
                || entity.kind === "scene" && ((Array.isArray(source.shots) ? source.shots : []).some((shot: Record<string, any>) => String(shot.scene_id || "") === entity.entityId)
                    || (Array.isArray(source.script_scenes) ? source.script_scenes : []).some((scene: Record<string, any>) => String(scene.scene_id || scene.id || "") === entity.entityId))) throw new Error("SUBJECT_STILL_REFERENCED: 该节点对应主体仍被分镜、剧本场景或对白使用");
            if (entity.assetIds[0]) deleteDirectorAsset(draft.director, entity.assetIds[0]);
            const next = draft.director.source as Record<string, any>;
            if (entity.kind === "character") next.character_registry = (Array.isArray(next.character_registry) ? next.character_registry : []).filter((item: Record<string, any>) => String(item.id || "") !== entity.entityId);
            if (entity.kind === "scene") next.scene_registry = (Array.isArray(next.scene_registry) ? next.scene_registry : []).filter((item: Record<string, any>) => String(item.id || "") !== entity.entityId);
            next.subject_registry = (Array.isArray(next.subject_registry) ? next.subject_registry : []).filter((subject: Record<string, any>) => !subjectIds.has(String(subject.id || "")));
            draft.director.sourceHash = directorHash(next);
            draft.director.artifacts = draft.director.artifacts.map(artifact => ({ ...artifact, status: "stale" as const }));
            draft.director.executionAuthorized = false;
            projectDirector(draft);
            changed = true;
            continue;
        }
        const nameKey = `${entity.kind}Name`, descriptionKey = `${entity.kind}Description`;
        const name = String(node.metadata?.[nameKey] || node.title || ""), description = String(node.metadata?.[descriptionKey] || "");
        const reference = node.metadata?.sharedAssetReference;
        if (reference?.writeThrough) {
            const oldName = String(old.metadata?.[nameKey] || old.title || ""), oldDescription = String(old.metadata?.[descriptionKey] || "");
            if (name !== oldName && name !== entity.name || description !== oldDescription && description !== entity.description) throw new Error("共享资产相同字段已变化，请回读后再编辑");
            // captureAssetEdits already wrote these fields through; shared propagation updated this episode's production source.
            continue;
        }
        const patch: Record<string, any> = {};
        if (name !== String(old.metadata?.[nameKey] || old.title || "")) {
            if (String(old.metadata?.[nameKey] || old.title || "") !== entity.name) throw new Error("制作实体名称已变化，请回读后再编辑");
            patch[entity.kind === "prop" ? "asset_name" : "name"] = name;
        }
        if (description !== String(old.metadata?.[descriptionKey] || "")) {
            if (String(old.metadata?.[descriptionKey] || "") !== entity.description) throw new Error("制作实体描述已变化，请回读后再编辑");
            const collection = entity.kind === "character" ? "character_registry" : entity.kind === "scene" ? "scene_registry" : "asset_plan";
            const target = (draft.director.source[collection] as Record<string, any>[]).find(item => String(item.id || item.asset_id) === entity.entityId)!;
            const value = target[entity.descriptionField];
            patch[entity.descriptionField] = value && typeof value === "object" ? { ...value, description } : description;
        }
        if (Object.keys(patch).length) {
            applyDirectorSourcePatch(draft.director, entity.kind === "scene" ? "environment" : entity.kind === "prop" ? "asset" : "character", entity.entityId, patch);
            changed = true;
        }
    }
    const imageOperations: CanvasOperation[] = [];
    for (const entity of productionEntities(draft.director.source, owner)) {
        const imageProjection = subjectImageForEntity(after, draft.director.source as Record<string, any>, owner, entity);
        if (!imageProjection) continue;
        const binding: ProductionEntityBinding = { ownerKind: owner.kind, ownerId: owner.id, kind: entity.kind, entityId: entity.entityId };
        const entityNode = nodes(after).find(node => JSON.stringify(node.metadata?.productionEntity) === JSON.stringify(binding));
        if (!entityNode || Object.entries(imageProjection).every(([key, value]) => JSON.stringify(entityNode.metadata?.[key]) === JSON.stringify(value))) continue;
        imageOperations.push({ type: "update_node", id: entityNode.id, metadata: imageProjection });
    }
    if (!changed && !imageOperations.length) return empty;
    if (changed) {
        if (isSubjectPromptAssembly(draft.director.source)) {
            const diagnostics = changedModelTextIdDiagnostics(previousSource, draft.director.source);
            if (diagnostics.length) throw new ProductionValidationError(diagnostics);
        }
        projectDirector(draft);
        db.db.prepare(`UPDATE ${table} SET revision=?,draft_json=?,updated_at=? WHERE ${column}=?`).run(row.revision + 1, JSON.stringify(withoutDirectorProjection(draft)), new Date().toISOString(), owner.id);
    }
    return { updates: changed ? [{ entityId: owner.id, revision: row.revision + 1 }] : [], operations: imageOperations };
}

/** Keep explicit H3 references to scene nodes current in the same canvas transaction. */
export function syncH3SceneImageReferences(before: Record<string, any>, after: Record<string, any>): CanvasOperation[] {
    const scenes = new Map<string, Record<string, any>>();
    for (const oldNode of nodes(before)) {
        if (oldNode.type !== "scene") continue;
        const nextNode = nodes(after).find(node => node.id === oldNode.id);
        if (!nextNode) continue;
        const oldImage = oldNode.metadata?.sceneImage || {}, image = nextNode.metadata?.sceneImage || {};
        if (["url", "storageKey", "mimeType"].every(key => String(oldImage[key] || "") === String(image[key] || ""))) continue;
        scenes.set(oldNode.id, image);
    }
    if (!scenes.size) return [];
    return nodes(after).filter(node => String(node.type || "").startsWith("minimax-h3:")).flatMap(h3 => {
        let changed = false;
        const segments = (Array.isArray(h3.metadata?.segments) ? h3.metadata.segments : []).map((segment: Record<string, any>) => {
            const references = Array.isArray(segment.referenceBindings) ? segment.referenceBindings : [];
            let referencesChanged = false;
            const nextReferences = references.map((reference: Record<string, any>) => {
                const image = scenes.get(String(reference.sourceNodeId || ""));
                if (!image || reference.role !== "scene" || reference.mediaType !== "image") return reference;
                const next: Record<string, any> = { ...reference, url: String(image.url || ""), storageKey: String(image.storageKey || ""), mimeType: String(image.mimeType || "image/png") };
                if (["url", "storageKey", "mimeType"].every(key => String(reference[key] || "") === String(next[key] || ""))) return reference;
                referencesChanged = true;
                return next;
            });
            if (!referencesChanged) return segment;
            changed = true;
            const nextSegment: Record<string, any> = { ...segment, referenceBindings: nextReferences,
                ...(segment.result || segment.resultStorageKey ? { inputOutdated: true } : {}) };
            if (segment.productionClipProjection) {
                const projection = { ...segment.productionClipProjection, fieldHashes: { ...segment.productionClipProjection.fieldHashes, referenceBindings: projectionHash(nextReferences) } };
                nextSegment.productionClipProjection = { ...projection, inputHash: h3InputHash(nextSegment) };
            }
            return nextSegment;
        });
        return changed ? [{ type: "update_node", id: h3.id, metadata: { segments } }] : [];
    });
}
