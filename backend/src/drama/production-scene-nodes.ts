import { createH3NodeMetadata } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { productionSceneEntries, type EpisodeProductionData, type ProductionLayoutPlan } from "@basketikun/canvas-agent/drama/production-contract";
import type { CanvasOperation } from "../canvas/project-ops.js";
import { productionLayoutStableId } from "./production-layout-geometry.js";
import { productionSceneIdsForShots } from "./production-layout.js";

type Owner = { kind: "episode" | "canvas"; id: string };
type Project = Record<string, any> & { nodes?: Array<Record<string, any>> };

/** Materialize scene containers and empty scene H3 nodes; Clip-bearing nodes are built by clipInputOperations. */
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
        const sceneUnit = layout.units.find(unit => unit.sceneId === sceneId && unit.members.some(member => member.role === "scene"));
        const videoUnit = layout.units.find(unit => unit.sceneId === sceneId && unit.members.some(member => member.role === "video"));
        const sceneMember = sceneUnit?.members.find(member => member.role === "scene");
        const videoMember = videoUnit?.members.find(member => member.role === "video");
        const groupId = productionLayoutStableId("production-scene", owner.id, sceneId);
        if (sceneMember && !present.has(sceneMember.nodeId)) {
            operations.push({ type: "add_node", id: sceneMember.nodeId, nodeType: "group", title: scene.title || sceneId,
                position: sceneMember.position, width: sceneMember.size.width, height: sceneMember.size.height,
                metadata: { productionSceneId: sceneId, productionOwnerKind: owner.kind, productionOwnerId: owner.id,
                    productionLayoutUnitId: sceneUnit!.id, productionLayoutBounds: sceneUnit!.bounds.size } });
            present.add(sceneMember.nodeId);
        }
        const hasClip = production.clipGroups.some(group => productionSceneIdsForShots(scenes, group.shotIds).includes(sceneId));
        if (videoMember && !hasClip && !present.has(videoMember.nodeId)) {
            operations.push({ type: "add_node", id: videoMember.nodeId, nodeType: "minimax-h3:video",
                title: `${scene.title || sceneId} · H3`, position: videoMember.position,
                width: videoMember.size.width, height: videoMember.size.height,
                metadata: { ...createH3NodeMetadata(h3Defaults, { segments: [] }), segments: [], productionSceneId: sceneId,
                    productionOwnerKind: owner.kind, productionOwnerId: owner.id, groupId,
                    productionLayoutUnitId: videoUnit!.id, productionLayoutBounds: videoUnit!.bounds.size } });
            present.add(videoMember.nodeId);
        }
    }
    return operations;
}
