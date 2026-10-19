import { productionLayoutStableId } from "./production-layout-geometry.js";
import { resolveCanvasCharacterImageReferences, resolveCanvasImageReferenceNode } from "../canvas/image-references.js";

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

export type SharedSubjectPictureMedia = {
    subjectId: string;
    bindingId: string;
    assetId: string;
    nodeId: string;
    resultId: string;
    storageKey: string;
    url?: string;
    name: string;
    mimeType: string;
    provides: string[];
    defaultFor: string[];
};

/** A shared character replacement invalidates only a default identity pin whose result disappeared. */
export function resetStaleSharedIdentityPictureSelections(source: { sourceProjectId: string; sourceNodeId: string }, canvasId: string,
    subjectsValue: unknown, projectValue: Record<string, any> | null | undefined): boolean {
    const subjects = rows(subjectsValue);
    const project = projectValue || {};
    const projectNodes = rows(project.nodes);
    let changed = false;
    for (const subject of subjects) {
        if (subject.kind !== "character") continue;
        for (const binding of rows(subject.pictureBindings)) {
            if (!Array.isArray(binding.defaultFor) || !binding.defaultFor.includes("identity") || binding.selection?.mode !== "selected_result"
                || binding.sourceNode?.projectId !== canvasId) continue;
            const node = projectNodes.find(item => String(item.id || "") === String(binding.sourceNode?.nodeId || ""));
            const reference = node?.metadata?.sharedAssetReference;
            if (node?.type !== "character" || reference?.sourceProjectId !== source.sourceProjectId || reference?.sourceNodeId !== source.sourceNodeId) continue;
            const resultId = String(binding.selection.resultId || "");
            const current = resolveCanvasCharacterImageReferences(node);
            if (current.some(item => item.id === resultId || item.storageKey === resultId)) continue;
            binding.selection = { mode: "node_selection" };
            changed = true;
        }
    }
    return changed;
}

/** Resolve picture bindings attached to this shared source through their episode projection nodes. */
export function sharedSubjectPictureMedia(source: { sourceProjectId: string; sourceNodeId: string }, canvasId: string,
    subjectsValue: unknown, projectValue: Record<string, any> | null | undefined, forceSelection = false): SharedSubjectPictureMedia[] {
    const projectNodes = rows(projectValue?.nodes);
    const result: SharedSubjectPictureMedia[] = [];
    for (const subject of rows(subjectsValue)) for (const binding of rows(subject.pictureBindings)) {
        if (binding.sourceNode?.projectId !== canvasId) continue;
        const nodeId = String(binding.sourceNode?.nodeId || "");
        const node = projectNodes.find(item => String(item.id || "") === nodeId);
        const reference = node?.metadata?.sharedAssetReference || node?.metadata?.sharedAssetOrigin;
        if (!node || reference?.sourceProjectId !== source.sourceProjectId || reference?.sourceNodeId !== source.sourceNodeId) continue;
        if (forceSelection && binding.selection?.mode === "selected_result") binding.selection = { mode: "node_selection" };

        let image: Record<string, any> | undefined;
        if (node.type === "character") {
            const images = rows(node.metadata?.characterImages);
            const imageKey = (candidate: Record<string, any>, index: number) => String(candidate.storageKey || candidate.url || candidate.name || `image-${index}`);
            if (binding.selection?.mode === "selected_result") {
                const resultId = String(binding.selection.resultId || "");
                image = images.find((candidate, index) => [String(candidate.id || ""), imageKey(candidate, index), String(candidate.storageKey || ""), `${nodeId}:character-image:${imageKey(candidate, index)}`].includes(resultId));
                if (!image) binding.selection = { mode: "node_selection" };
            }
            if (!image && images.length) {
                const requested = Number(node.metadata?.characterPrimaryIndex || 0);
                const primaryIndex = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 0), images.length - 1) : 0;
                image = images[primaryIndex];
            }
        } else {
            const nested = node.type === "scene" ? node.metadata?.sceneImage : node.type === "prop" ? node.metadata?.propImage : undefined;
            const resolved = nested && typeof nested === "object" ? nested as Record<string, any> : resolveCanvasImageReferenceNode(node)[0] as Record<string, any> | undefined;
            image = resolved ? { ...resolved, url: resolved.url || resolved.content } : undefined;
        }
        const storageKey = String(image?.storageKey || "");
        result.push({ subjectId: String(subject.id || ""), bindingId: String(binding.id || ""), assetId: String(binding.assetId || ""), nodeId,
            resultId: String(image?.id || storageKey), storageKey, ...(image?.url || image?.content ? { url: String(image.url || image.content) } : {}),
            name: String(image?.outfit || image?.name || node.title || nodeId), mimeType: String(image?.mimeType || "image/png"),
            provides: Array.isArray(binding.provides) ? binding.provides.map(String) : [], defaultFor: Array.isArray(binding.defaultFor) ? binding.defaultFor.map(String) : [] });
    }
    return result;
}

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
