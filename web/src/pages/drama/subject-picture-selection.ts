import { isClothingPictureBinding, resolveSubjectPictureBindingIds } from "@basketikun/canvas-agent/drama/production-contract";

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
    const outfitIds = new Set(bindings.filter(isClothingPictureBinding).map(binding => String(binding.id)));
    const current = resolveSubjectPictureBindingIds(subject, usage).bindingIds;
    const retained = current.filter(id => !outfitIds.has(id));
    const selected = outfitBindingIds.filter(id => outfitIds.has(String(id))).map(String);
    return setShotPictureBindingIds(usage, [...new Set([...retained, ...selected])]);
}

/** Apply keyframe Subject appearances to Shot references once, with the same outfit selection saved on the keyframes. */
export function syncKeyframeSubjectsToShotUsages(usages: Array<Record<string, any>>, keyframes: Array<Record<string, any>>, subjects: Array<Record<string, any>>) {
    const next = structuredClone(usages), subjectById = new Map(subjects.map(subject => [String(subject.id), subject]));
    const subjectIds = [...new Set(keyframes.flatMap(frame => (Array.isArray(frame.subjectIds) ? frame.subjectIds : []).map(String)))];
    for (const subjectId of subjectIds) {
        const subject = subjectById.get(subjectId);
        if (!subject) continue;
        let index = next.findIndex(usage => String(usage.subjectId) === subjectId);
        if (index < 0) {
            next.push({ subjectId, presentation: "visible", pictureBindingIds: [], pictureBindingMode: "default", referencePurpose: ["identity"], continuityFactIds: [], stateRequirements: [] });
            index = next.length - 1;
        }
        next[index] = { ...next[index], presentation: "visible" };
        const selections = keyframes.filter(frame => (Array.isArray(frame.subjectIds) ? frame.subjectIds : []).map(String).includes(subjectId)
            && Object.prototype.hasOwnProperty.call(frame.subjectPictureBindingIds || {}, subjectId));
        if (!selections.length) continue;
        const outfits = [...new Set(selections.flatMap(frame => (frame.subjectPictureBindingIds?.[subjectId] || []).map(String)))];
        next[index] = setShotOutfitBindingIds(subject, next[index], outfits);
    }
    return next;
}

/** Convert Cascader leaf paths into the keyframe's Subject and outfit fields. */
export function keyframeSubjectSelectionFromPaths(paths: Array<Array<string | number>>) {
    const selections = paths.map(path => path.map(String)).filter(path => path.length >= 2);
    const subjectIds = [...new Set(selections.map(path => path[0]))];
    const subjectPictureBindingIds = Object.fromEntries(subjectIds.map(subjectId => [subjectId,
        [...new Set(selections.filter(path => path[0] === subjectId && path[1] !== "__default__").map(path => path[1]))],
    ]));
    return { subjectIds, subjectPictureBindingIds };
}
