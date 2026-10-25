import { createH3NodeMetadata } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { productionSceneEntries, type EpisodeProductionData, type ProductionLayoutPlan } from "@basketikun/canvas-agent/drama/production-contract";
import type { CanvasOperation } from "../canvas/project-ops.js";
import { productionSceneIdsForShots } from "./production-layout.js";

type Owner = { kind: "episode" | "canvas"; id: string };
type Project = Record<string, any> & { nodes?: Array<Record<string, any>> };

/** Materialize empty scene H3 nodes; Clip-bearing nodes are built by clipInputOperations. */
export function productionSceneCreationOperations(
    project: Project,
    production: EpisodeProductionData,
    layout: ProductionLayoutPlan,
    owner: Owner,
    sceneIds: readonly string[],
    h3Defaults: Record<string, unknown>,
): CanvasOperation[] {
    const nodes = Array.isArray(project.nodes) ? project.nodes : [];
    const present = new Set(nodes.map(node => String(node.id)));
    const scenes = production.director ? productionSceneEntries(production.director.source) : [];
    const operations: CanvasOperation[] = [];
    for (const sceneId of new Set(sceneIds)) {
        const scene = scenes.find(item => item.id === sceneId);
        if (!scene) continue;
        const sceneUnit = layout.units.find(unit => unit.id === `scene:${sceneId}`);
        const sceneMember = sceneUnit?.members.find(member => member.role === "scene");
        const groupId = sceneMember?.nodeId;
        if (sceneMember && !present.has(sceneMember.nodeId)) {
            operations.push({ type: "add_node", id: sceneMember.nodeId, nodeType: "group",
                title: scene.title || sceneId, position: sceneMember.position,
                width: sceneMember.size.width, height: sceneMember.size.height,
                metadata: { productionSceneId: sceneId, productionOwnerKind: owner.kind, productionOwnerId: owner.id,
                    productionLayoutUnitId: sceneUnit!.id, productionLayoutBounds: sceneUnit!.bounds.size } });
            present.add(sceneMember.nodeId);
        }
        const videoUnit = layout.units.find(unit => unit.sceneId === sceneId && unit.members.some(member => member.role === "video"));
        const videoMember = videoUnit?.members.find(member => member.role === "video");
        const hasClip = production.clipGroups.some(group => productionSceneIdsForShots(scenes, group.shotIds).includes(sceneId));
        if (videoMember && !hasClip && !present.has(videoMember.nodeId)) {
            operations.push({ type: "add_node", id: videoMember.nodeId, nodeType: "minimax-h3:video",
                title: `${scene.title || sceneId} · H3`, position: videoMember.position,
                width: videoMember.size.width, height: videoMember.size.height,
                metadata: { ...createH3NodeMetadata(h3Defaults, { segments: [] }), segments: [], productionSceneId: sceneId, ...(groupId ? { groupId } : {}),
                    productionOwnerKind: owner.kind, productionOwnerId: owner.id,
                    productionLayoutUnitId: videoUnit!.id, productionLayoutBounds: videoUnit!.bounds.size } });
            present.add(videoMember.nodeId);
        } else if (videoMember && present.has(videoMember.nodeId)) {
            const existing = nodes.find(node => String(node.id) === videoMember.nodeId);
            if (!existing) continue;
            const metadata = existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {};
            const metadataPatch = {
                productionSceneId: sceneId, ...(groupId ? { groupId } : {}), productionOwnerKind: owner.kind, productionOwnerId: owner.id,
                productionLayoutUnitId: videoUnit?.id, productionLayoutBounds: videoUnit?.bounds.size,
            };
            const metadataChanged = Object.entries(metadataPatch).some(([key, value]) => JSON.stringify(metadata[key]) !== JSON.stringify(value));
            if (metadataChanged) operations.push({ type: "update_node", id: existing.id, metadata: metadataPatch });
        }
    }
    return operations;
}
