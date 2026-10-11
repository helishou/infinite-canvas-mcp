import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasPluginAi } from "@/types/canvas-plugin";
import { productionObjectForNode } from "@/lib/production-object";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import i18n from "@/i18n";

/** Formal outputs use the existing reviewed selection command and its persisted receipt. */
export function requestFormalH3OutputSelection(projectId: string, node: CanvasNodeData, input: Parameters<CanvasPluginAi["restoreH3Output"]>[0]): boolean {
    const segments = Array.isArray(node.metadata?.segments) ? node.metadata.segments as Record<string, unknown>[] : [];
    const segment = segments.find(item => item.id === input.segmentId);
    if (!segment) throw new Error(i18n.t("productionCanvas.targetUnavailable"));
    const { context, production } = useProductionWorkspaceStore.getState();
    const object = context?.canvasId === projectId && production ? productionObjectForNode(context, production, node, input.segmentId) : null;
    if (object?.targetKind !== "segment") {
        if (segment.productionClipProjection) throw new Error(i18n.t("productionCanvas.targetUnavailable"));
        return false;
    }
    if (!input.storageKey) throw new Error(i18n.t("productionCanvas.resultSelectFailed"));
    window.dispatchEvent(new CustomEvent("production-node-action", { detail: {
        owner: object.owner, object, action: "select-result",
        history: { generationLogId: input.generationLogId, storageKey: input.storageKey, mimeType: "video/mp4" },
    } }));
    return true;
}
