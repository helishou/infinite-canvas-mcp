import type { ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";

type Row = Record<string, any>;

/** Keep a production scene/prop image edit as the selected Subject source on that same canvas node. */
export function bindEntityPictureToNode(source: Record<string, unknown> | undefined, ownerKind: string, ownerId: string,
    entityKind: "scene" | "prop", entityId: string, projectId: string, nodeId: string): ProductionOperation | undefined {
    const subjects = Array.isArray(source?.subject_registry) ? source.subject_registry as Row[] : [];
    const subjectKind = entityKind === "prop" ? "asset" : "scene";
    const subject = subjects.find(item => item.entityRef?.ownerKind === ownerKind && item.entityRef?.ownerId === ownerId
        && item.entityRef?.kind === subjectKind && String(item.entityRef?.id || "") === entityId);
    if (!subject) return undefined;

    const bindings = Array.isArray(subject.pictureBindings) ? subject.pictureBindings as Row[] : [];
    const preferredIndex = bindings.findIndex(binding => Array.isArray(binding.defaultFor) && binding.defaultFor.includes("identity"));
    const index = preferredIndex >= 0 ? preferredIndex : bindings.length ? 0 : -1;
    const active = index >= 0 ? bindings[index] : undefined;
    if (active?.sourceNode?.projectId === projectId && active.sourceNode?.nodeId === nodeId && active.selection?.mode === "node_selection") return undefined;

    const sourceNode = { projectId, nodeId };
    const pictureBindings = [...bindings];
    if (index >= 0) pictureBindings[index] = { ...active, sourceNode, selection: { mode: "node_selection" } };
    else {
        const scene = entityKind === "scene";
        const id = `picture:${subject.id}:${encodeURIComponent(projectId)}:${encodeURIComponent(nodeId)}`;
        pictureBindings.push({ id, assetId: id, sourceNode, selection: { mode: "node_selection" },
            provides: [scene ? "environment" : "identity"], retain: [scene ? "场景布局与环境关系" : "道具形态与材质"],
            exclude: [], applicableState: {}, defaultFor: [scene ? "environment" : "identity"] });
    }
    return { type: "upsert_director_subject", subject: { ...subject, pictureBindings } } as ProductionOperation;
}
