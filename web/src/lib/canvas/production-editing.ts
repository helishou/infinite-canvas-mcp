import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasProductionEditing } from "@/types/canvas-plugin";

type Input = Parameters<CanvasProductionEditing["reverseSyncPrompt"]>[0];
type Handler = CanvasProductionEditing["reverseSyncPrompt"];
// Capability routing only: edits still use the production editor's existing persistent command journal.
const editors = new Map<string, { token: symbol; handler: Handler }>();
export function registerProductionPromptEditor(projectId: string, handler: Handler) {
    const token = Symbol(projectId);
    editors.set(projectId, { token, handler });
    return () => { if (editors.get(projectId)?.token === token) editors.delete(projectId); };
}

export function sourceSegmentForCanvasClip(groups: Array<{ id: string; nodeId: string | null; segmentId: string | null }>, nodeId: string, segmentId: string) {
    const group = groups.find(group => group.nodeId === nodeId && group.segmentId === segmentId);
    if (!group) throw new Error("PROMPT_REVERSE_SYNC_TARGET_MISMATCH");
    return group.id;
}

export function createProductionEditing(projectId: string, getNode: (id: string) => CanvasNodeData | null, flush: () => Promise<void>): CanvasProductionEditing {
    return { reverseSyncPrompt: async (input: Input) => {
        await flush();
        const node = getNode(input.nodeId), segments = node?.metadata?.segments;
        const clip = Array.isArray(segments) ? segments.find(clip => clip.id === input.segmentId) : undefined;
        const projection = clip?.productionClipProjection as Record<string, unknown> | undefined;
        if (!clip || projection?.promptAssemblyVersion !== 2 || projection.artifactId !== input.artifactId
            || projection.sourceHash !== input.sourceHash || projection.promptHash !== input.basePromptHash) throw new Error("PROMPT_REVERSE_SYNC_BASELINE_MISMATCH");
        const editor = editors.get(projectId);
        if (!editor) throw new Error("PRODUCTION_EDITOR_NOT_READY");
        return editor.handler(input);
    } };
}
