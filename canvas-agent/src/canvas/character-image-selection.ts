type Node = { id?: unknown; type?: unknown; metadata?: unknown };
type Image = { storageKey?: unknown; url?: unknown; name?: unknown };
export type CharacterImageSelection = { imageKeys?: string[]; voiceEnabled?: boolean };

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function imagesOf(metadata: Record<string, unknown>): Image[] {
    return Array.isArray(metadata.characterImages) ? metadata.characterImages.filter((image) => image && typeof image === "object" && !Array.isArray(image)) : [];
}

export function characterImageKey(image: Image, index: number): string {
    return String(image.storageKey || image.url || image.name || `image-${index}`);
}

function primaryKey(metadata: Record<string, unknown>): string {
    const images = imagesOf(metadata);
    const value = Number(metadata.characterPrimaryIndex || 0);
    const index = Math.min(Math.max(Number.isFinite(value) ? Math.trunc(value) : 0, 0), Math.max(images.length - 1, 0));
    return images[index] ? characterImageKey(images[index], index) : "";
}

/** Missing selections follow the primary image; obsolete media keys recover to it. An explicit empty list disables images. */
export function resolveCharacterImageKeys(metadataValue: unknown, selectionValue?: unknown): string[] {
    const metadata = record(metadataValue);
    const selection = record(selectionValue);
    const primary = primaryKey(metadata);
    if (!Array.isArray(selection.imageKeys)) return primary ? [primary] : [];
    const available = new Set(imagesOf(metadata).map(characterImageKey));
    return [...new Set(selection.imageKeys.map(String).flatMap((key) => available.has(key) ? [key] : primary ? [primary] : []))];
}

/** Derive downstream edits in the same command as a character image/primary change, without modifying historical snapshots. */
export function characterReferenceUpdates(previous: Node, current: Node, nodes: Node[]) {
    if (previous.type !== "character" || current.type !== "character") return [];
    const before = record(previous.metadata);
    const after = record(current.metadata);
    const oldPrimary = primaryKey(before);
    const nextPrimary = primaryKey(after);
    if (JSON.stringify([imagesOf(before).map(characterImageKey), oldPrimary]) === JSON.stringify([imagesOf(after).map(characterImageKey), nextPrimary])) return [];
    const available = new Set(imagesOf(after).map(characterImageKey));
    const characterId = String(current.id || "");
    return nodes.flatMap((node) => {
        const references = record(record(node.metadata).characterReferences) as Record<string, CharacterImageSelection>;
        const selection = record(references[characterId]) as CharacterImageSelection;
        if (!Array.isArray(selection.imageKeys) || !selection.imageKeys.length) return [];
        const keys = [...new Set(selection.imageKeys.map(String).map((key) => {
            if (nextPrimary && (key === oldPrimary || !available.has(key))) return nextPrimary;
            return key;
        }))];
        if (JSON.stringify(keys) === JSON.stringify(selection.imageKeys)) return [];
        return [{ id: String(node.id), metadata: { characterReferences: { ...references, [characterId]: { ...selection, imageKeys: keys } } } }];
    });
}
