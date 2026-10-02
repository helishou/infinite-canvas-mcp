type Node = { id?: unknown; type?: unknown; title?: unknown; metadata?: unknown };
type Image = { storageKey?: unknown; url?: unknown; name?: unknown };
export type CharacterImageSelection = { imageKeys?: string[]; voiceEnabled?: boolean };
export type H3CharacterOutfitSource = { url: string; name: string; storageKey?: string; mimeType?: string; role?: string };
export type H3CharacterSource = {
    characterName: string;
    characterAssetId?: string;
    characterNodeId: string;
    characterPrimaryIndex?: number;
    outfits: H3CharacterOutfitSource[];
    voice?: { url: string; name: string; description?: string; storageKey?: string; assetId?: string };
};
type H3CharacterOutfit = H3CharacterOutfitSource & { id: string; enabled: boolean };
type H3CharacterGroup = {
    characterName: string;
    characterAssetId?: string;
    characterNodeId?: string;
    subjectId?: string;
    outfits: H3CharacterOutfit[];
    outfitEnabled?: boolean;
    voice?: H3CharacterSource["voice"];
    voiceEnabled: boolean;
};
const H3_IMAGE_ROLES = new Set(["character_identity", "character_turnaround", "storyboard", "scene", "blocking", "keyframe", "motion_reference", "style", "palette", "prop", "other"]);

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

/** Read the full costume catalog from the source character node, including disabled costumes. */
export function h3CharacterSourceFromNode(node: Node): H3CharacterSource | null {
    if (node.type !== "character" || !node.id) return null;
    const metadata = record(node.metadata);
    const outfits = imagesOf(metadata).flatMap((image) => {
        const media = record(image);
        const url = String(media.url || media.dataUrl || media.localUrl || "").trim();
        const storageKey = String(media.storageKey || record(media.assetRef).storageKey || "").trim();
        if (!url && !storageKey) return [];
        const role = String(media.role || "");
        return [{ url, name: String(media.outfit || media.name || "outfit"), storageKey: storageKey || undefined,
            mimeType: String(media.mimeType || "") || undefined, role: H3_IMAGE_ROLES.has(role) ? role : "character_turnaround" }];
    });
    const voiceUrl = String(metadata.characterVoiceUrl || "").trim();
    const rawPrimary = Number(metadata.characterPrimaryIndex || 0);
    return {
        characterName: String(metadata.characterName || node.title || "角色"),
        characterAssetId: String(metadata.characterAssetId || "") || undefined,
        characterNodeId: String(node.id),
        characterPrimaryIndex: Number.isFinite(rawPrimary) ? Math.min(Math.max(Math.trunc(rawPrimary), 0), Math.max(outfits.length - 1, 0)) : 0,
        outfits,
        voice: voiceUrl ? {
            url: voiceUrl,
            name: String(metadata.characterVoiceName || "声线"),
            description: String(metadata.characterVoiceDescription || "") || undefined,
            storageKey: String(metadata.characterVoiceStorageKey || "") || undefined,
            assetId: String(metadata.characterVoiceAssetId || "") || undefined,
        } : undefined,
    };
}

function h3OutfitKey(outfit: H3CharacterOutfitSource) {
    return outfit.storageKey || outfit.url;
}

function stableOutfitId(characterNodeId: string, key: string) {
    let hash = 2166136261;
    for (const char of `${characterNodeId}:outfit:${key}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `outfit-${(hash >>> 0).toString(36)}`;
}

/** Keep Clip selection by media key; a same-length in-place replacement inherits its slot's selection and ID. */
export function syncH3CharacterGroupSource<T extends H3CharacterGroup>(existing: T, source: H3CharacterSource): T | null {
    if (existing.characterNodeId !== source.characterNodeId) return existing;
    if (!source.outfits.length && !source.voice) return null;
    const incomingKeys = new Set(source.outfits.map(h3OutfitKey));
    const existingByKey = new Map(existing.outfits.map((outfit) => [h3OutfitKey(outfit), outfit]));
    const usedIds = new Set<string>();
    const outfits = source.outfits.map((outfit, index) => {
        const key = h3OutfitKey(outfit);
        let previous = existingByKey.get(key);
        if (previous && usedIds.has(previous.id)) previous = undefined;
        if (!previous && source.outfits.length === existing.outfits.length) {
            const slot = existing.outfits[index];
            if (slot && !incomingKeys.has(h3OutfitKey(slot)) && !usedIds.has(slot.id)) previous = slot;
        }
        if (previous) usedIds.add(previous.id);
        return { ...outfit, id: previous?.id || stableOutfitId(source.characterNodeId, key), enabled: previous?.enabled ?? false };
    });
    if (existing.outfitEnabled !== false && existing.outfits.some((outfit) => outfit.enabled) && outfits.length && !outfits.some((outfit) => outfit.enabled)) {
        const index = Math.min(Math.max(source.characterPrimaryIndex || 0, 0), outfits.length - 1);
        outfits[index] = { ...outfits[index], enabled: true };
    }
    const next = {
        ...existing,
        characterName: source.characterName || existing.characterName,
        characterAssetId: source.characterAssetId || existing.characterAssetId,
        characterNodeId: source.characterNodeId,
        subjectId: existing.subjectId || source.characterNodeId,
        voice: source.voice,
        outfits,
        outfitEnabled: outfits.length > 0 && (existing.outfitEnabled ?? outfits.some((outfit) => outfit.enabled)),
        voiceEnabled: source.voice ? (existing.voice ? existing.voiceEnabled : true) : false,
    } as T;
    return JSON.stringify(next) === JSON.stringify(existing) ? existing : next;
}
