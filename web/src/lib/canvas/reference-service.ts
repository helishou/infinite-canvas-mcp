import { createReferenceWriteCoordinator } from "./reference-write-coordinator";
import { deleteProjectReferenceAsset, fetchProjectReferenceAssets, upsertProjectReferenceAsset, upsertProjectReferenceAssets, validateProjectReferences } from "@/services/backend-api";
import type { CanvasReferenceService } from "@/types/canvas-plugin";

export function createCanvasReferenceService(projectId: string): CanvasReferenceService {
    return createReferenceWriteCoordinator({
        list: async () => (await fetchProjectReferenceAssets(projectId)).assets || [],
        upsert: async (asset) => (await upsertProjectReferenceAsset(projectId, asset)).asset,
        upsertMany: async (assets) => (await upsertProjectReferenceAssets(projectId, assets)).assets || [],
        remove: async (assetId) => { await deleteProjectReferenceAsset(projectId, assetId); },
        validate: async (nodeId, segmentId) => (await validateProjectReferences(projectId, nodeId, segmentId)).validation,
    });
}
