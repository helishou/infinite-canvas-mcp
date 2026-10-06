import type { EpisodeProduction, ProductionCanvasContext, ProductionPresentation } from "@/services/backend-api";
import type { CanvasNodeData } from "@/types/canvas";

export type ProductionObject = {
    owner: NonNullable<ProductionCanvasContext["owner"]>;
    canvasId: string;
    workspace: "story" | "assets" | "shots" | "continuity" | "production" | "overview";
    targetKind?: string;
    targetId?: string;
    nodeId?: string;
    segmentId?: string;
    clipIndex?: number;
    title: string;
};

/** Resolve only formal mappings. A selected H3 node can have many Clips. */
export function productionObjectForNode(context: ProductionCanvasContext, production: EpisodeProduction, node: Pick<CanvasNodeData, "id" | "title"> & { metadata?: Record<string, unknown> }, segmentId?: string): ProductionObject | null {
    if (!context.owner) return null;
    const director = production.draft.director;
    if (!director) return null;
    if (node.metadata?.productionScriptId) return null; // Script text uses the ordinary canvas editor.
    const base = { owner: context.owner, canvasId: context.canvasId, nodeId: node.id };
    const group = production.draft.clipGroups.find(item => item.nodeId === node.id && Boolean(segmentId) && item.segmentId === segmentId);
    if (group) return { ...base, workspace: "production", targetKind: "segment", targetId: group.id, segmentId: group.segmentId || undefined, clipIndex: production.draft.clipGroups.indexOf(group) + 1, title: node.title || group.id };
    const frame = Object.entries(production.draft.keyframes).find(([, item]) => item.nodeId === node.id);
    if (frame) return { ...base, workspace: "shots", targetKind: "shot", targetId: frame[0], title: production.draft.shots.find(shot => shot.id === frame[0])?.title || node.title || frame[0] };
    const asset = Object.entries(director.assets).find(([, item]) => item.nodeId === node.id);
    if (asset) {
        const shot = Object.entries(director.shotInputs).find(([, input]) => input.keyframeAssetId === asset[0]);
        if (shot) return { ...base, workspace: "shots", targetKind: "shot", targetId: shot[0], title: production.draft.shots.find(item => item.id === shot[0])?.title || node.title || asset[0] };
        const plan = Array.isArray(director.source.asset_plan) ? director.source.asset_plan as Record<string, unknown>[] : [];
        const source = plan.find(item => String(item.asset_id || item.id) === asset[0]);
        return { ...base, workspace: "assets", targetKind: "asset", targetId: asset[0], title: String(source?.asset_name || source?.name || node.title || asset[0]) };
    }
    // The node itself is a valid canvas reference, but it is not a formal target.
    return null;
}

export function productionObjectForPresentation(presentation: ProductionPresentation, production: EpisodeProduction | null): ProductionObject | null {
    if (!presentation.canvasId) return null;
    const id = presentation.targetId;
    let title = id || "";
    if (production && id) {
        if (presentation.targetKind === "segment") title = id;
        else if (presentation.targetKind === "shot" || presentation.targetKind === "keyframe") title = production.draft.shots.find(shot => shot.id === id)?.title || title;
        else if (presentation.targetKind === "asset") {
            const plan = production.draft.director?.source.asset_plan;
            const item = Array.isArray(plan) ? plan.find(item => String(item?.asset_id || item?.id) === id) : undefined;
            title = String(item?.asset_name || item?.name || title);
        }
    }
    const clipIndex = presentation.targetKind === "segment" && production ? production.draft.clipGroups.findIndex(group => group.id === id) + 1 : 0;
    return { owner: presentation.owner, canvasId: presentation.canvasId, workspace: presentation.workspace === "advanced" ? "overview" : presentation.workspace,
        targetKind: presentation.targetKind, targetId: id, nodeId: presentation.nodeId, segmentId: presentation.segmentId, ...(clipIndex > 0 ? { clipIndex } : {}), title };
}

export function productionObjectPath(object: ProductionObject) {
    const query = new URLSearchParams({ productionKind: object.owner.kind, productionId: object.owner.id, workspace: object.workspace });
    if (object.targetKind && object.targetId) query.set("target", `${object.targetKind}:${object.targetId}`);
    if (object.nodeId) query.set("nodeId", object.nodeId);
    if (object.segmentId) query.set("segmentId", object.segmentId);
    return `/canvas/${encodeURIComponent(object.canvasId)}?${query}`;
}

/** Review state belongs to the formal record; H3 runtime state belongs to the selected Clip. */
export function productionObjectState(production: EpisodeProduction, object: ProductionObject, node: { metadata?: Record<string, unknown> }) {
    const director = production.draft.director;
    const assetId = object.targetKind === "shot" ? director?.shotInputs[object.targetId || ""]?.keyframeAssetId : object.targetId;
    const asset = assetId ? director?.assets[assetId] : undefined;
    const frame = object.targetKind === "shot" ? production.draft.keyframes[object.targetId || ""] : undefined;
    const review = object.targetKind === "shot" ? production.draft.keyframeReviews[object.targetId || ""] : undefined;
    const group = object.targetKind === "segment" ? production.draft.clipGroups.find(group => group.id === object.targetId) : undefined;
    const segments = Array.isArray(node.metadata?.segments) ? node.metadata.segments as Record<string, unknown>[] : [];
    const runtime = object.targetKind === "segment" ? segments.find(segment => segment.id === object.segmentId) : node.metadata;
    const working = ["queued", "loading", "running", "pending", "awaiting_confirmation"].includes(String(runtime?.status));
    const failed = ["error", "failed"].includes(String(runtime?.status));
    const storageKey = object.targetKind === "segment" ? runtime?.resultStorageKey : frame?.storageKey || asset?.storageKey;
    const verdict = review?.verdict;
    const status = working ? "working" : failed ? "failed" : asset?.inputOutdated || group?.inputOutdated ? "outdated" : verdict === "approved" || verdict === "auto-accepted" ? "approved" : verdict === "rejected" || verdict === "needs-redo" ? "rejected" : asset?.status === "approved" ? "approved" : asset?.status === "rejected" ? "rejected" : storageKey ? object.targetKind === "segment" ? "complete" : "needs_review" : "planned";
    const publishedAsset = assetId ? production.published?.director?.assets[assetId] : undefined;
    const publishedFrame = object.targetKind === "shot" ? production.published?.keyframes[object.targetId || ""] : undefined;
    const canReview = Boolean(!working && !asset?.sharedSource && assetId && production.publishedVersion && storageKey && storageKey === node.metadata?.storageKey && storageKey === (publishedFrame?.storageKey || publishedAsset?.storageKey) && object.nodeId === (publishedFrame?.nodeId || publishedAsset?.nodeId));
    return { status, working, canReview, assetId, storageKey };
}

export function productionObjectPrompt(object: ProductionObject) {
    return `【当前画布制作对象】\n制作归属：${object.owner.kind}:${object.owner.id}\n画布：${object.canvasId}\n对象：${object.targetKind || "production"}:${object.targetId || ""}（${object.title}）\n${object.nodeId ? `节点：${object.nodeId}\n` : ""}${object.segmentId ? `H3 Clip：${object.segmentId}\n` : ""}本条用户请求关联上述对象。先核验正式制作记录及节点／Clip 映射，再按用户要求处理；参考选择、生成和审核沿用正式制作链路。`;
}
