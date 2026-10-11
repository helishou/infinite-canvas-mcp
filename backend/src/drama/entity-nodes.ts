import { productionEntities, type EpisodeProductionData, type ProductionEntityBinding, type ProductionLayoutPlan } from "@basketikun/canvas-agent/drama/production-contract";
import { applyDirectorSourcePatch } from "@basketikun/canvas-agent/drama/production-validation";
import type { BackendDatabase } from "../db.js";
import type { CanvasOperation } from "../canvas/project-ops.js";
import { projectDirector } from "./director.js";
import { productionLayoutStableId } from "./production-layout-geometry.js";

type Owner = { kind: "episode" | "canvas" | "scene"; id: string };
const nodes = (project: Record<string, any>): Record<string, any>[] => project.nodes || [];
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
    const prior = new Map(productionEntities(previous?.director?.source || {}, owner).map(entity => [`${entity.kind}:${entity.entityId}`, entity]));
    return productionEntities(data.director.source, owner).flatMap((entity): CanvasOperation[] => {
        const binding: ProductionEntityBinding = { ownerKind: owner.kind, ownerId: owner.id, kind: entity.kind, entityId: entity.entityId };
        const unit = layout.units.find(unit => unit.id === `entity:${entity.kind}:${entity.entityId}`);
        const member = unit?.members[0];
        if (!member) throw new Error("制作实体缺少正式画布布局");
        const node = nodes(project).find(node => node.id === member.nodeId);
        const nameKey = `${entity.kind}Name`, descriptionKey = `${entity.kind}Description`;
        if (!node) return [{ type: "add_node", id: member.nodeId, nodeType: entity.kind, title: entity.name, position: member.position, width: member.size.width, height: member.size.height,
            metadata: { productionEntity: binding, [nameKey]: entity.name, [descriptionKey]: entity.description, productionLayoutUnitId: unit!.id, productionLayoutBounds: member.size } }];
        if (node.type !== entity.kind) throw new Error("制作实体节点类型冲突，未覆盖原节点");
        if (node.metadata?.productionEntity && JSON.stringify(node.metadata.productionEntity) !== JSON.stringify(binding)) throw new Error("制作实体节点来源冲突");
        const metadata: Record<string, any> = { productionEntity: binding, productionLayoutUnitId: unit!.id, productionLayoutBounds: member.size };
        const old = prior.get(`${entity.kind}:${entity.entityId}`);
        for (const [field, value, baseline] of [[nameKey, entity.name, old?.name], [descriptionKey, entity.description, old?.description]] as const) {
            if (old && value === baseline) continue;
            const actual = String(node.metadata?.[field] || "");
            if (actual === value) continue;
            // Only a changed source field can conflict; leave unrelated local fields untouched.
            if (node.metadata?.productionEntity && actual !== baseline) throw new Error("制作实体的同一字段已变化，请回读后再编辑");
            metadata[field] = value;
        }
        const reference = node.metadata?.sharedAssetReference;
        if (reference) {
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
        const patch = (!old || old.name !== entity.name) && node.title !== entity.name ? { title: entity.name } : undefined;
        return patch || Object.entries(metadata).some(([key, value]) => JSON.stringify(node.metadata?.[key]) !== JSON.stringify(value)) ? [{ type: "update_node", id: node.id, patch, metadata }] : [];
    });
}

/** Reverse edits to definitions in the same ops transaction; media remains on its canvas node. */
export function syncEntityNodeEdits(db: BackendDatabase, projectId: string, before: Record<string, any>, after: Record<string, any>) {
    if (!nodes(before).some(node => node.metadata?.productionEntity)) return [];
    const episode = db.getDramaEpisodeByCanvasId(projectId);
    const owner: Owner = episode ? { kind: "episode", id: episode.id } : { kind: "canvas", id: projectId };
    const table = episode ? "episode_productions" : "canvas_productions", column = episode ? "episode_id" : "project_id";
    const row = db.db.prepare(`SELECT revision,draft_json FROM ${table} WHERE ${column}=?`).get(owner.id) as { revision: number; draft_json: string } | undefined;
    if (!row) return [];
    const draft = JSON.parse(row.draft_json) as EpisodeProductionData;
    if (!draft.director) return [];
    let changed = false;
    for (const entity of productionEntities(draft.director.source, owner)) {
        const old = nodes(before).find(node => node.metadata?.productionEntity?.kind === entity.kind && node.metadata.productionEntity.entityId === entity.entityId);
        if (!old) continue;
        const node = nodes(after).find(node => node.id === old.id);
        if (!node) continue;
        const nameKey = `${entity.kind}Name`, descriptionKey = `${entity.kind}Description`;
        const name = String(node.metadata?.[nameKey] || node.title || ""), description = String(node.metadata?.[descriptionKey] || "");
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
    if (!changed) return [];
    projectDirector(draft);
    db.db.prepare(`UPDATE ${table} SET revision=?,draft_json=?,updated_at=? WHERE ${column}=?`).run(row.revision + 1, JSON.stringify(draft), new Date().toISOString(), owner.id);
    return [{ entityId: owner.id, revision: row.revision + 1 }];
}
