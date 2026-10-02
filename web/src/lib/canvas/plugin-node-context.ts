import { createPluginStorage, emitCanvasEvent, onCanvasEvent } from "@/lib/canvas/canvas-event-bus";
import { getNodePluginId } from "@/lib/canvas/node-registry";
import { getPluginNodeView } from "@/stores/canvas/plugin-node-view";
import { CanvasCollaborativeText } from "@/components/canvas/canvas-collaborative-text";
import { getCanvasTextSession, replaceCanvasText } from "@/services/api/canvas-text";
import { getCanvasTextSuggestions } from "@/services/api/canvas-text-suggestions";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeContext, CanvasPluginHost } from "@/types/canvas-plugin";

// Assemble host capabilities, node data, theme, and scale into the context injected into plugin nodes.
export function buildNodeContext(host: CanvasPluginHost, node: CanvasNodeData, theme: CanvasTheme, scale: number, isSelected = false): CanvasNodeContext {
    const storage = createPluginStorage(getNodePluginId(node.type));
    return {
        mediaUrl: host.mediaUrl,
        TextEditor: CanvasCollaborativeText,
        textDocument: (target) => getCanvasTextSession(host.projectId, target),
        textSuggestions: (target) => getCanvasTextSuggestions(host.projectId, target),
        replaceText: (target, documentId, expectedText, text) => replaceCanvasText(host.projectId, target, documentId, expectedText, text),
        view: getPluginNodeView(host.projectId, node.id),
        node,
        projectId: host.projectId,
        theme,
        scale,
        isSelected,
        updateMetadata: (patch) => host.updateMetadata(node.id, patch),
        updateNode: (patch) => host.updateNode(node.id, patch),
        getNode: (id) => host.getNode(id),
        getNodes: () => host.getNodes(),
        getConnections: () => host.getConnections(),
        getUpstream: () => host.getUpstream(node.id),
        getDownstream: () => host.getDownstream(node.id),
        applyOps: (ops) => host.applyOps(ops),
        flush: () => host.flush(),
        emit: (event, payload) => emitCanvasEvent(event, payload),
        on: (event, handler) => onCanvasEvent(event, handler),
        ai: host.ai,
        h3Defaults: host.h3Defaults,
        references: host.references,
        openPanel: () => host.openPanel(node.id),
        closePanel: () => host.closePanel(),
        openAssetPicker: (options) => host.openAssetPicker(options),
        openMediaPreview: (item) => host.openMediaPreview(item),
        storage,
        generationLogs: host.generationLogs,
    };
}
