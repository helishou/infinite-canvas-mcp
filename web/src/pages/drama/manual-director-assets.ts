export type ManualAssetKind = "character" | "scene" | "prop";
type Source = Record<string, any>;
export type ManualAssetDraft = {
    id: string;
    entityId?: string;
    subjectId?: string;
    kind: ManualAssetKind;
    name: string;
    description: string;
    prompt: string;
    purpose: string;
    canvasScope?: "episode" | "shared";
    registerSubject: boolean;
    ownerKind: "episode" | "canvas";
    ownerId: string;
};

const records = (value: unknown): Source[] => Array.isArray(value) ? value.filter((item): item is Source => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];

export function createManualDirectorAsset(source: Source, draft: ManualAssetDraft) {
    const id = draft.id.trim(), name = draft.name.trim();
    if (!id || !name) throw new Error("资产 ID 和名称不能为空");
    if ([...records(source.asset_plan), ...records(source.asset_cards)].some(item => String(item.id || item.asset_id || "") === id)) throw new Error(`资产 ID 已存在：${id}`);
    if (draft.kind !== "prop" && !draft.entityId?.trim()) throw new Error("角色或场景资产必须有注册表 ID");
    if (draft.registerSubject && (!draft.subjectId?.trim() || !draft.ownerId.trim())) throw new Error("Subject 注册信息不完整");

    const assetPlan = {
        id,
        kind: draft.kind,
        asset_name: name,
        ...(draft.entityId ? { entity_id: draft.entityId } : {}),
        version: "v1",
        description: draft.description.trim(),
        purpose: draft.purpose.trim() || draft.description.trim() || name,
        depends_on: [],
        status: "planned",
        ...(draft.canvasScope ? { canvas_scope: draft.canvasScope } : {}),
    };
    const assetCard = {
        id,
        asset_id: id,
        asset_kind: draft.kind,
        asset_version: "v1",
        prompt: draft.prompt.trim(),
        references: [],
    };
    const nextSource: Source = {
        ...source,
        asset_plan: [...records(source.asset_plan), assetPlan],
        asset_cards: [...records(source.asset_cards), assetCard],
    };

    let registryKind: "character" | "scene" | undefined;
    let registryEntity: Source | undefined;
    if (draft.kind === "character") {
        const entity = { id: draft.entityId, name, description: draft.description.trim(), appearance: draft.description.trim() };
        registryKind = "character";
        registryEntity = entity;
        nextSource.character_registry = [...records(source.character_registry), entity];
    } else if (draft.kind === "scene") {
        const entity = { id: draft.entityId, name, description: draft.description.trim() };
        registryKind = "scene";
        registryEntity = entity;
        nextSource.scene_registry = [...records(source.scene_registry), entity];
    }

    const subject = draft.registerSubject ? {
        id: draft.subjectId,
        kind: draft.kind,
        entityRef: {
            ownerKind: draft.ownerKind,
            ownerId: draft.ownerId,
            kind: draft.kind === "prop" ? "asset" : draft.kind,
            id: draft.kind === "prop" ? id : draft.entityId,
        },
        pictureBindings: [],
    } : undefined;
    if (subject) nextSource.subject_registry = [...records(source.subject_registry), subject];

    return { source: nextSource, assetPlan, assetCard, subject, registryKind, registryEntity };
}

/** Resolve deletion targets by entity identity, never by the display name. */
export function manualAssetsForSubject(source: Source, subject: Source, owner: { kind: "episode" | "canvas"; id: string }): Source[] {
    const ref = subject.entityRef;
    if (!ref || ref.ownerKind !== owner.kind || ref.ownerId !== owner.id) return [];
    return records(source.asset_plan).filter(plan => {
        if (plan.created_by !== "manual") return false;
        const id = String(plan.id || plan.asset_id || "");
        if (ref.kind === "asset") return plan.kind === "prop" && id === ref.id;
        return (ref.kind === "character" || ref.kind === "scene") && plan.kind === ref.kind
            && String(plan.entity_id || plan.entityId || id) === ref.id;
    });
}
