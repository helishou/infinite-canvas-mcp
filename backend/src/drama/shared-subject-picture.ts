import { productionLayoutStableId } from "./production-layout-geometry.js";

type Row = Record<string, any>;
type SharedSubjectPictureBinding = {
    id: string;
    assetId: string;
    sourceNode: { projectId: string; nodeId: string };
    selection: { mode: "node_selection" };
    provides: string[];
    retain: string[];
    exclude: string[];
    applicableState: Record<string, string>;
    defaultFor: string[];
};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];

/** Build a live picture binding to the episode's shared-reference entity node. */
export function sharedSubjectPictureBinding(subject: Row, assetPlan: Row, episodeId: string, canvasId: string): SharedSubjectPictureBinding | undefined {
    const kind = String(assetPlan.kind || "");
    if (!["character", "scene", "prop"].includes(kind)) return undefined;
    const entityId = String(assetPlan.entity_id || assetPlan.id || "");
    const entityRefKind = kind === "prop" ? "asset" : kind;
    if (!entityId || subject.entityRef?.ownerKind !== "episode" || subject.entityRef?.ownerId !== episodeId
        || subject.entityRef?.kind !== entityRefKind || String(subject.entityRef?.id || "") !== entityId) {
        throw new Error("共享资产主体登记与稳定实体身份不匹配");
    }
    const localNodeId = productionLayoutStableId("production-entity", "episode", episodeId, kind, entityId);
    const bindings = rows(subject.pictureBindings);
    if (bindings.some(binding => binding.sourceNode?.projectId === canvasId && binding.sourceNode?.nodeId === localNodeId && binding.assetId === assetPlan.id)) return undefined;
    const hasIdentityDefault = bindings.some(binding => Array.isArray(binding.defaultFor) && binding.defaultFor.includes("identity"));
    return {
        id: `picture:${subject.id}:${encodeURIComponent(canvasId)}:${encodeURIComponent(localNodeId)}`,
        assetId: String(assetPlan.id),
        sourceNode: { projectId: canvasId, nodeId: localNodeId },
        selection: { mode: "node_selection" },
        provides: [kind === "scene" ? "environment" : "identity"],
        retain: kind === "scene" ? ["scene layout and environment"] : ["character identity and costume as defined by the reference image"],
        exclude: ["pose, camera angle, background, and unrelated composition"],
        applicableState: {},
        defaultFor: hasIdentityDefault ? [] : ["identity"],
    };
}
