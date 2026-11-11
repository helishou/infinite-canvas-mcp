import { createH3NodeMetadata, isH3NodeType } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
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
    published?: EpisodeProductionData | null,
): CanvasOperation[] {
    const nodes = Array.isArray(project.nodes) ? project.nodes : [];
    const present = new Set(nodes.map(node => String(node.id)));
    const scenes = production.director ? productionSceneEntries(production.director.source) : [];
    const operations: CanvasOperation[] = [];
    for (const sceneId of new Set(sceneIds)) {
        const scene = scenes.find(item => item.id === sceneId);
        if (!scene) continue;
        const videoUnit = layout.units.find(unit => unit.sceneId === sceneId && unit.members.some(member => member.role === "video"));
        const videoMember = videoUnit?.members.find(member => member.role === "video");
        const hasClip = production.clipGroups.some(group => productionSceneIdsForShots(scenes, group.shotIds).includes(sceneId));
        if (videoMember && !hasClip && !present.has(videoMember.nodeId)) {
            operations.push({ type: "add_node", id: videoMember.nodeId, nodeType: "minimax-h3:video",
                title: `${scene.title || sceneId} · H3`, position: videoMember.position,
                width: videoMember.size.width, height: videoMember.size.height,
                metadata: { ...createH3NodeMetadata(h3Defaults, { segments: [] }), segments: [], productionSceneId: sceneId,
                    productionOwnerKind: owner.kind, productionOwnerId: owner.id,
                    productionLayoutUnitId: videoUnit!.id, productionLayoutBounds: videoUnit!.bounds.size } });
            present.add(videoMember.nodeId);
        } else if (videoMember && present.has(videoMember.nodeId)) {
            const existing = nodes.find(node => String(node.id) === videoMember.nodeId);
            if (!existing) continue;
            const metadata = existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {};
            const metadataPatch = {
                productionSceneId: sceneId, productionOwnerKind: owner.kind, productionOwnerId: owner.id,
                productionLayoutUnitId: videoUnit?.id, productionLayoutBounds: videoUnit?.bounds.size,
            };
            const metadataChanged = Object.entries(metadataPatch).some(([key, value]) => JSON.stringify(metadata[key]) !== JSON.stringify(value));
            const metadataDelete = Object.hasOwn(metadata, "groupId") ? ["groupId"] : [];
            if (metadataChanged || metadataDelete.length) operations.push({ type: "update_node", id: existing.id, metadata: metadataPatch, ...(metadataDelete.length ? { metadataDelete } : {}) });
        }
    }
    // A removed scene can leave an empty timeline with its old node-level video.
    // Release only its obsolete production ownership; retain media, history and layout.
    if (production.director) {
        const publishedScenes = published?.director ? productionSceneEntries(published.director.source) : [];
        const liveSceneIds = new Set([...scenes, ...publishedScenes].flatMap(scene => [scene.id, scene.environmentId]));
        const claimedNodeIds = new Set([
            ...production.clipGroups.map(group => group.nodeId),
            ...(published?.clipGroups || []).map(group => group.nodeId),
            ...layout.units.filter(unit => unit.sceneId && liveSceneIds.has(unit.sceneId))
                .flatMap(unit => unit.members.filter(member => member.role === "video").map(member => member.nodeId)),
        ]);
        for (const node of nodes) {
            const metadata = node.metadata || {};
            if (!isH3NodeType(String(node.type)) || metadata.productionOwnerKind !== owner.kind || metadata.productionOwnerId !== owner.id
                || !metadata.productionSceneId || liveSceneIds.has(String(metadata.productionSceneId))
                || claimedNodeIds.has(String(node.id)) || metadata.productionArchiveLabel
                || !Array.isArray(metadata.segments) || metadata.segments.length || metadata.runtimeTaskId
                || ["queued", "loading", "generating", "awaiting_confirmation"].includes(String(metadata.status || ""))) continue;
            operations.push({ type: "update_node", id: String(node.id), metadataDelete: [
                "productionSceneId", "productionOwnerKind", "productionOwnerId", "productionLayoutUnitId", "productionLayoutBounds",
            ].filter(key => Object.hasOwn(metadata, key)) });
        }
    }
    return operations;
}
