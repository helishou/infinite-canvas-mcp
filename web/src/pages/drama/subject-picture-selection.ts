import { resolveSubjectPictureBindingIds } from "@basketikun/canvas-agent/drama/production-contract";

export type ShotPictureBindingMode = "default" | "explicit";

/** Preserve legacy non-empty pictureBindingIds as an explicit selection. */
export function shotPictureBindingMode(usage: Record<string, any>): ShotPictureBindingMode {
    if (usage.pictureBindingMode === "explicit" || (Array.isArray(usage.pictureBindingIds) && usage.pictureBindingIds.length > 0)) return "explicit";
    return "default";
}

export function setShotPictureBindingMode(subject: unknown, usage: Record<string, any>, mode: ShotPictureBindingMode) {
    if (mode === "default") return { ...usage, pictureBindingMode: "default", pictureBindingIds: [] };
    return { ...usage, pictureBindingMode: "explicit", pictureBindingIds: resolveSubjectPictureBindingIds(subject, usage).bindingIds };
}

export function setShotPictureBindingIds(usage: Record<string, any>, pictureBindingIds: string[]) {
    return { ...usage, pictureBindingMode: "explicit", pictureBindingIds };
}

/** Change this Shot's outfit references without dropping its identity or other picture bindings. */
export function setShotOutfitBindingIds(subject: unknown, usage: Record<string, any>, outfitBindingIds: string[]) {
    const bindings = subject && typeof subject === "object" && Array.isArray((subject as Record<string, any>).pictureBindings)
        ? (subject as Record<string, any>).pictureBindings as Array<Record<string, any>> : [];
    const outfitIds = new Set(bindings.filter(binding => Array.isArray(binding.provides) && binding.provides.map(String).includes("clothing")).map(binding => String(binding.id)));
    const current = resolveSubjectPictureBindingIds(subject, usage).bindingIds;
    const retained = current.filter(id => !outfitIds.has(id));
    const selected = outfitBindingIds.filter(id => outfitIds.has(String(id))).map(String);
    return setShotPictureBindingIds(usage, [...new Set([...retained, ...selected])]);
}
