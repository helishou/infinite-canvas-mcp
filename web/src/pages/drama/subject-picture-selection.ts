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
