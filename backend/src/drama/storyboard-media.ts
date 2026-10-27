import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { isH3NodeType } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";

const rows = (value: unknown): Array<Record<string, any>> => Array.isArray(value) ? value : [];

/** The asset identity created when an archived H3 reference is promoted to a Shot keyframe. */
export function storyboardReferenceBindingId(assetId: string) {
    if (!assetId.startsWith("storyboard:")) return "";
    try { return decodeURIComponent(assetId.slice("storyboard:".length)); }
    catch { return ""; }
}

/**
 * A selected-result keyframe may be owned by an H3 reference binding rather than
 * an image node. Accept it only when the formal Shot, archived asset and current
 * H3 Clip all identify the same binding and bytes.
 */
export function isArchivedStoryboardKeyframeBinding(input: {
    director: DirectorProduction;
    nodes: Array<Record<string, any>>;
    targetId: string;
    assetId: string;
    bindingId?: string;
    storageKey: string;
    sha256: string;
}) {
    const { director, nodes, targetId, assetId, storageKey, sha256 } = input;
    const bindingId = String(input.bindingId || storyboardReferenceBindingId(assetId));
    if (!bindingId || !assetId || !storageKey || !sha256) return false;
    const asset = director.assets[assetId];
    if (!asset || asset.nodeId || asset.storageKey !== storageKey || asset.sha256 !== sha256) return false;
    const segment = rows(director.source.segments).find(item => String(item.id || "") === targetId);
    if (!segment) return false;
    const shotIds = new Set(rows(segment.shot_ids).map(String));
    const hasSelectedFrame = rows(director.source.shots).some(shot => shotIds.has(String(shot.id || ""))
        && rows(shot.keyframes).some(frame => String(frame.assetId || frame.id || "") === assetId
            && frame.requiredForSubmission !== false && frame.anchor !== "composition"
            && !frame.sourceNode
            && frame.selection?.mode === "selected_result"
            && String(frame.selection.resultId || "") === storageKey));
    if (!hasSelectedFrame) return false;
    return nodes.some(node => isH3NodeType(String(node.type || "")) && rows(node.metadata?.segments).some(canvasSegment =>
        String(canvasSegment.productionClipProjection?.targetId || "") === targetId
        && rows(canvasSegment.referenceBindings).some(binding =>
            binding.enabled !== false
            && ["storyboard", "keyframe"].includes(String(binding.role || "").toLowerCase())
            && String(binding.id || binding.bindingId || "") === bindingId
            && String(binding.storageKey || "") === storageKey)));
}
