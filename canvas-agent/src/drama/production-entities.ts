export type ProductionEntityKind = "character" | "scene" | "prop";
export type ProductionEntityBinding = { ownerKind: "episode" | "canvas" | "scene"; ownerId: string; kind: ProductionEntityKind; entityId: string };
export function productionEntityBinding(value: unknown): ProductionEntityBinding | undefined {
    if (!value || typeof value !== "object") return undefined;
    const binding = value as ProductionEntityBinding;
    return ["episode", "canvas", "scene"].includes(binding.ownerKind) && ["character", "scene", "prop"].includes(binding.kind) && typeof binding.ownerId === "string" && typeof binding.entityId === "string" ? binding : undefined;
}
const rows = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value : [];

export function productionEntityDescriptionField(kind: ProductionEntityKind, row: Record<string, any>) {
    const fields = kind === "character" ? ["appearance", "description", "prompt_description", "identity"] : kind === "scene" ? ["description", "prompt_description"] : ["description", "prompt"];
    return fields.find(field => typeof row[field] === "string" ? Boolean(row[field].trim()) : Boolean(row[field] && typeof row[field] === "object")) || fields[0];
}
export function productionEntityText(value: unknown): string {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") return String((value as Record<string, any>).description || (value as Record<string, any>).text || "");
    return "";
}
/** Identity comes from registry IDs and explicit entity_id, never display names. */
export function productionEntities(source: Record<string, any>, owner: { kind: string; id: string }) {
    const plans = rows(source.asset_plan), subjects = rows(source.subject_registry);
    const result: Array<{ kind: ProductionEntityKind; entityId: string; name: string; description: string; descriptionField: string; assetIds: string[] }> = [];
    const add = (kind: ProductionEntityKind, row: Record<string, any>, assetIds: string[]) => {
        const entityId = String(row.id || row.asset_id || "");
        if (!entityId) return;
        const refs = subjects.filter(subject => subject.entityRef?.kind === (kind === "prop" ? "asset" : kind) && subject.entityRef.id === entityId);
        if (refs.length && refs.every(subject => subject.entityRef.ownerId !== owner.id || subject.entityRef.ownerKind !== owner.kind)) return;
        const descriptionField = productionEntityDescriptionField(kind, row);
        result.push({ kind, entityId, name: String(row.name || row.asset_name || row.scene_name || row.title || entityId), description: productionEntityText(row[descriptionField]), descriptionField, assetIds });
    };
    for (const row of rows(source.character_registry)) add("character", row, plans.filter(plan => String(plan.entity_id || "") === String(row.id)).map(plan => String(plan.id || plan.asset_id)));
    for (const row of rows(source.scene_registry)) add("scene", row, plans.filter(plan => String(plan.entity_id || "") === String(row.id)).map(plan => String(plan.id || plan.asset_id)));
    for (const row of plans) if (["prop", "道具"].includes(String(row.kind || row.asset_kind || "").toLowerCase()) || subjects.some(subject => subject.kind === "prop" && subject.entityRef?.kind === "asset" && subject.entityRef.id === String(row.id || row.asset_id))) add("prop", row, [String(row.id || row.asset_id)]);
    return result;
}
