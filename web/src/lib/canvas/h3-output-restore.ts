import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasPluginAi } from "@/types/canvas-plugin";
import { productionObjectForNode } from "@/lib/production-object";
import { editEpisodeProduction, fetchBackendProject, fetchEpisodeProduction, fetchProductionCanvasContext } from "@/services/backend-api";
import { applyBackendCanvasEvent } from "@/stores/canvas/use-canvas-store";

/** Record the selection when a production target is available; the caller can still restore the H3 output directly otherwise. */
export async function requestFormalH3OutputSelection(projectId: string, node: CanvasNodeData, input: Parameters<CanvasPluginAi["restoreH3Output"]>[0]): Promise<boolean> {
    const segments = Array.isArray(node.metadata?.segments) ? node.metadata.segments as Record<string, unknown>[] : [];
    const segment = segments.find(item => item.id === input.segmentId);
    if (!segment) return false;
    const projection = segment.productionClipProjection as Record<string, unknown> | undefined;
    if (!projection) return false;
    if (!input.storageKey) return false;
    try {
        const context = (await fetchProductionCanvasContext(projectId)).context;
        if (!context.owner || context.owner.kind === "scene") return false;
        const owner = context.owner.kind === "episode" ? context.owner.id : { projectId: context.owner.id };
        const production = (await fetchEpisodeProduction(owner)).production;
        const object = productionObjectForNode(context, production, node, input.segmentId);
        if (object?.targetKind !== "segment" || object.targetId !== String(projection.targetId || "")) return false;
        const { project } = await fetchBackendProject(projectId);
        await editEpisodeProduction(owner, production.revision, [{
            type: "select_director_result", targetKind: "segment", targetId: object.targetId!, nodeId: node.id,
            generationLogId: input.generationLogId, storageKey: input.storageKey, canvasRevision: Number(project.revision),
        }]);
        const committed = await fetchBackendProject(projectId);
        applyBackendCanvasEvent({ type: "canvas.updated", entityId: projectId, revision: Number(committed.project.revision), payload: committed.project }, true);
        window.dispatchEvent(new CustomEvent("production-history-selected", { detail: { canvasId: projectId } }));
        return true;
    } catch {
        // An incomplete or stale production mapping must not block restoring the selected output to this Clip.
        return false;
    }
}
