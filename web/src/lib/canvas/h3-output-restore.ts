import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasPluginAi } from "@/types/canvas-plugin";
import { productionObjectForNode } from "@/lib/production-object";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import { editEpisodeProduction, fetchBackendProject, fetchEpisodeProduction, fetchProductionCanvasContext } from "@/services/backend-api";
import { applyBackendCanvasEvent } from "@/stores/canvas/use-canvas-store";
import i18n from "@/i18n";

/** Formal outputs use the existing reviewed selection command and its persisted receipt. */
export async function requestFormalH3OutputSelection(projectId: string, node: CanvasNodeData, input: Parameters<CanvasPluginAi["restoreH3Output"]>[0]): Promise<boolean> {
    const segments = Array.isArray(node.metadata?.segments) ? node.metadata.segments as Record<string, unknown>[] : [];
    const segment = segments.find(item => item.id === input.segmentId);
    if (!segment) throw new Error(i18n.t("productionCanvas.targetUnavailable"));
    const projection = segment.productionClipProjection as Record<string, unknown> | undefined;
    if (!projection) return false;
    if (!input.storageKey) throw new Error(i18n.t("productionCanvas.resultSelectFailed"));

    const workspace = useProductionWorkspaceStore.getState();
    const workspaceObject = workspace.context?.canvasId === projectId && workspace.production
        ? productionObjectForNode(workspace.context, workspace.production, node, input.segmentId)
        : null;
    if (workspaceObject?.targetKind === "segment" && workspaceObject.targetId === String(projection.targetId || "")) {
        const event = new CustomEvent("production-node-action", { cancelable: true, detail: {
            owner: workspaceObject.owner, object: workspaceObject, action: "select-result",
            history: { generationLogId: input.generationLogId, storageKey: input.storageKey, mimeType: "video/mp4" },
        } });
        // The Director panel owns the reviewed modal while it is mounted. If the
        // user is operating the H3 node directly, continue through the same
        // Backend selection operation below instead of losing the window event.
        if (!window.dispatchEvent(event)) return true;
    }

    const context = (await fetchProductionCanvasContext(projectId)).context;
    if (!context.owner) return false;
    if (context.owner.kind === "scene") throw new Error(i18n.t("productionCanvas.targetUnavailable"));
    const owner = context.owner.kind === "episode" ? context.owner.id : { projectId: context.owner.id };
    const production = (await fetchEpisodeProduction(owner)).production;
    const object = productionObjectForNode(context, production, node, input.segmentId);
    if (object?.targetKind !== "segment" || object.targetId !== String(projection.targetId || "")) {
        throw new Error(i18n.t("productionCanvas.targetUnavailable"));
    }
    const { project } = await fetchBackendProject(projectId);
    await editEpisodeProduction(owner, production.revision, [{
        type: "select_director_result", targetKind: "segment", targetId: object.targetId!, nodeId: node.id,
        generationLogId: input.generationLogId, storageKey: input.storageKey, canvasRevision: Number(project.revision),
    }]);
    const committed = await fetchBackendProject(projectId);
    applyBackendCanvasEvent({ type: "canvas.updated", entityId: projectId, revision: Number(committed.project.revision), payload: committed.project }, true);
    window.dispatchEvent(new CustomEvent("production-history-selected", { detail: { canvasId: projectId } }));
    return true;
}
