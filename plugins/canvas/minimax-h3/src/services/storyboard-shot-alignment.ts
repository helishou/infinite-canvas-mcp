import type { H3Ref } from "../types";
import { inferReferenceRole } from "./h3-data";

/** The prompt owns the shot count. Images can fill empty slots only when counts match. */
export function alignStoryboardShotsToReferences<T extends { id: string; pictureBindingId?: string }>(shots: T[], imageRefs: H3Ref[]) {
    const pictures = imageRefs.filter((ref) => ref.type === "image" && ref.enabled !== false && inferReferenceRole(ref) === "storyboard" && ref.bindingId);
    const pictureIds = new Set(pictures.map((ref) => ref.bindingId!));
    const bound = new Set<string>();
    let changed = false;
    const aligned = shots.map((shot) => {
        const id = shot.pictureBindingId;
        if (!id) return shot;
        if (pictureIds.has(id) && !bound.has(id)) {
            bound.add(id);
            return shot;
        }
        changed = true;
        return { ...shot, pictureBindingId: undefined };
    });

    if (pictures.length !== shots.length) return { shots: aligned, changed };

    const unused = pictures.filter((ref) => !bound.has(ref.bindingId!));
    let nextUnused = 0;
    return {
        shots: aligned.map((shot) => {
            if (shot.pictureBindingId) return shot;
            const ref = unused[nextUnused++];
            if (!ref) return shot;
            changed = true;
            return { ...shot, pictureBindingId: ref.bindingId };
        }),
        changed,
    };
}
