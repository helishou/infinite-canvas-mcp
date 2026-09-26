/** Keep storyboard images in shot order without moving other reference slots. */
export function orderStoryboardImageReferences<T extends object>(
    references: T[],
    shotBindingIds: string[],
    bindingIdOf: (reference: T) => string | undefined,
    isStoryboardImage: (reference: T) => boolean,
): T[] {
    const storyboard = references.filter(isStoryboardImage);
    if (storyboard.length < 2 || !shotBindingIds.length) return references;
    const byId = new Map(storyboard.map((reference) => [bindingIdOf(reference), reference]));
    const used = new Set<string>();
    const ordered = shotBindingIds.flatMap((id) => {
        const reference = byId.get(id);
        if (!reference || used.has(id)) return [];
        used.add(id);
        return [reference];
    });
    ordered.push(...storyboard.filter((reference) => !used.has(bindingIdOf(reference) || "")));
    let index = 0;
    return references.map((reference) => isStoryboardImage(reference) ? ordered[index++] : reference);
}

/** Rebase numeric Picture tags when image bindings move to different slots. */
export function remapPictureTags<T>(
    text: string,
    before: T[],
    after: T[],
    bindingIdOf: (reference: T) => string | undefined,
    isImage: (reference: T) => boolean,
): string {
    const oldImages = before.filter(isImage);
    const newOrdinalById = new Map(after.filter(isImage).map((reference, index) => [bindingIdOf(reference), index + 1]));
    return text.replace(/<Picture\s+(\d+)>/giu, (tag, number: string) => {
        const oldReference = oldImages[Number(number) - 1];
        const id = oldReference ? bindingIdOf(oldReference) : undefined;
        const ordinal = id && newOrdinalById.get(id);
        return ordinal ? `<Picture ${ordinal}>` : tag;
    });
}
