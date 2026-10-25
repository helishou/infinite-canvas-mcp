/** Live library references always point to their canonical node in the shared asset canvas. */
export type SharedAssetSource = { dramaId: string; assetId: string; sourceProjectId: string; sourceNodeId: string };
export type SharedAssetEdit = { base?: unknown; value?: unknown; deleted?: boolean };
export type SharedAssetReference = SharedAssetSource & { edits?: Record<string, SharedAssetEdit>; /** Production-selected refs write supported edits through to their canonical shared node. */ writeThrough?: boolean };
export type AssetNode = { id: string; type: string; title?: string; metadata?: Record<string, any>; [key: string]: any };

const COMMON = ["content", "storageKey", "naturalWidth", "naturalHeight", "bytes", "mimeType", "durationMs"];
const FIELDS: Record<string, string[]> = {
    text: ["content"], image: COMMON, video: COMMON, audio: COMMON,
    // Entity image fields are canonical. Top-level content/storageKey/dimensions are derived covers.
    prop: ["propName", "propDescription", "propImage", "itemName", "itemDescription"],
    character: ["characterName", "characterEnglishName", "characterDescription", "characterImages", "characterPrimaryIndex", "characterVoiceUrl", "characterVoiceName", "characterVoiceDescription", "characterVoiceStorageKey", "characterVoiceAssetId"],
    scene: ["sceneName", "sceneDescription", "sceneImage", "sceneColorCard", "sceneColorPalette", "sceneColorCardPrompt"],
};
const ENTITY_IMAGE_PROJECTION_FIELDS = ["content", "storageKey", "naturalWidth", "naturalHeight", "bytes", "mimeType"] as const;
export const sharedAssetFields = (type: string) => ["title", ...(FIELDS[type] || []).map(key => `metadata.${key}`)];
export const sameAssetValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function assetField(node: AssetNode, field: string): unknown { return field === "title" ? node.title : node.metadata?.[field.slice(9)]; }

const CHARACTER_PRIMARY_FIELDS = ["content", "storageKey", "naturalWidth", "naturalHeight", "bytes", "mimeType"] as const;

/** Keep legacy character cover fields as a projection of the primary character image. */
export function normalizeCharacterPrimaryMedia<T extends Record<string, any>>(value: T, source: "gallery" | "preview" | "legacy" = "gallery"): T {
    const metadata: Record<string, any> = { ...value };
    const images = Array.isArray(metadata.characterImages)
        ? metadata.characterImages.filter((image: unknown) => image && typeof image === "object" && !Array.isArray(image)).map((image: Record<string, any>) => ({ ...image }))
        : [];
    let primaryIndex = Number(metadata.characterPrimaryIndex || 0);
    if (!Number.isFinite(primaryIndex)) primaryIndex = 0;
    primaryIndex = Math.max(0, Math.trunc(primaryIndex));

    if (source === "preview" && CHARACTER_PRIMARY_FIELDS.some(field => Object.hasOwn(metadata, field))) {
        primaryIndex = images.length ? Math.min(primaryIndex, images.length - 1) : 0;
        const primary = { ...(images[primaryIndex] || {}) };
        if (Object.hasOwn(metadata, "content")) primary.url = metadata.content;
        if (Object.hasOwn(metadata, "storageKey")) primary.storageKey = metadata.storageKey;
        if (Object.hasOwn(metadata, "naturalWidth")) primary.width = metadata.naturalWidth;
        if (Object.hasOwn(metadata, "naturalHeight")) primary.height = metadata.naturalHeight;
        if (Object.hasOwn(metadata, "bytes")) primary.bytes = metadata.bytes;
        if (Object.hasOwn(metadata, "mimeType")) primary.mimeType = metadata.mimeType;
        if (images.length) images[primaryIndex] = primary; else images.push(primary);
        metadata.characterImages = images;
        metadata.characterPrimaryIndex = primaryIndex;
    } else if (!images.length && source === "legacy" && CHARACTER_PRIMARY_FIELDS.some(field => Object.hasOwn(metadata, field))) {
        images.push({
            url: metadata.content || "", storageKey: metadata.storageKey, width: metadata.naturalWidth, height: metadata.naturalHeight,
            bytes: metadata.bytes, mimeType: metadata.mimeType,
        });
        metadata.characterImages = images;
        metadata.characterPrimaryIndex = 0;
        primaryIndex = 0;
    }

    if (!images.length) {
        metadata.characterImages = [];
        metadata.characterPrimaryIndex = 0;
        for (const field of CHARACTER_PRIMARY_FIELDS) delete metadata[field];
        return metadata as T;
    }

    primaryIndex = Math.min(primaryIndex, images.length - 1);
    metadata.characterImages = images;
    metadata.characterPrimaryIndex = primaryIndex;
    const primary = images[primaryIndex];
    metadata.content = String(primary.url || primary.dataUrl || primary.content || "");
    const fields: Array<[typeof CHARACTER_PRIMARY_FIELDS[number], unknown]> = [
        ["storageKey", primary.storageKey], ["naturalWidth", primary.width ?? primary.naturalWidth],
        ["naturalHeight", primary.height ?? primary.naturalHeight], ["bytes", primary.bytes], ["mimeType", primary.mimeType],
    ];
    for (const [field, fieldValue] of fields) {
        if (fieldValue === undefined || fieldValue === null || fieldValue === "") delete metadata[field];
        else metadata[field] = fieldValue;
    }
    return metadata as T;
}

/** Keep scene/prop image objects authoritative; legacy top-level media fields are projections. */
export function normalizeEntityPrimaryMedia<T extends Record<string, any>>(
    type: string, value: T, source: "gallery" | "nested" | "preview" | "legacy" = "legacy",
): T {
    if (type === "character") return normalizeCharacterPrimaryMedia(value, source === "preview" ? "preview" : source === "gallery" ? "gallery" : "legacy");
    if (type !== "scene" && type !== "prop") return value;

    const metadata: Record<string, any> = { ...value };
    const nestedKey = type === "scene" ? "sceneImage" : "propImage";
    let image = metadata[nestedKey] && typeof metadata[nestedKey] === "object" && !Array.isArray(metadata[nestedKey])
        ? { ...metadata[nestedKey] } as Record<string, any> : undefined;
    if (!image && type === "scene" && source === "legacy" && Array.isArray(metadata.sceneImages) && metadata.sceneImages.length === 1
        && metadata.sceneImages[0] && typeof metadata.sceneImages[0] === "object" && !Array.isArray(metadata.sceneImages[0])) {
        image = { ...metadata.sceneImages[0] } as Record<string, any>;
    }
    if (source === "preview" && CHARACTER_PRIMARY_FIELDS.some(field => Object.hasOwn(metadata, field))) {
        image ||= {};
        if (Object.hasOwn(metadata, "content")) image.url = metadata.content;
        if (Object.hasOwn(metadata, "storageKey")) image.storageKey = metadata.storageKey;
        if (Object.hasOwn(metadata, "naturalWidth")) image.width = metadata.naturalWidth;
        if (Object.hasOwn(metadata, "naturalHeight")) image.height = metadata.naturalHeight;
        if (Object.hasOwn(metadata, "bytes")) image.bytes = metadata.bytes;
        if (Object.hasOwn(metadata, "mimeType")) image.mimeType = metadata.mimeType;
    } else if (!image && source === "legacy" && CHARACTER_PRIMARY_FIELDS.some(field => Object.hasOwn(metadata, field))) {
        image = { url: metadata.content || "", storageKey: metadata.storageKey, width: metadata.naturalWidth, height: metadata.naturalHeight,
            bytes: metadata.bytes, mimeType: metadata.mimeType };
    }

    if (!image) {
        delete metadata[nestedKey];
        for (const field of CHARACTER_PRIMARY_FIELDS) delete metadata[field];
        return metadata as T;
    }
    metadata[nestedKey] = image;
    metadata.content = String(image.url || image.dataUrl || image.content || "");
    const fields: Array<[typeof CHARACTER_PRIMARY_FIELDS[number], unknown]> = [
        ["storageKey", image.storageKey], ["naturalWidth", image.width ?? image.naturalWidth],
        ["naturalHeight", image.height ?? image.naturalHeight], ["bytes", image.bytes], ["mimeType", image.mimeType],
    ];
    for (const [field, fieldValue] of fields) {
        if (fieldValue === undefined || fieldValue === null || fieldValue === "") delete metadata[field];
        else metadata[field] = fieldValue;
    }
    return metadata as T;
}

export function setAssetField(node: AssetNode, field: string, value: unknown) {
    const target = field === "title" ? node : (node.metadata ||= {});
    const key = field === "title" ? field : field.slice(9);
    if (value === undefined) delete target[key]; else target[key] = value;
}
export function resolveSharedAssetNode(node: AssetNode, source: AssetNode): AssetNode {
    const result = { ...node, metadata: { ...node.metadata } };
    const ref = node.metadata?.sharedAssetReference as SharedAssetReference;
    delete result.metadata.sharedAssetMissing;
    if (["character", "scene", "prop"].includes(node.type)) for (const field of ENTITY_IMAGE_PROJECTION_FIELDS) delete result.metadata[field];
    if (node.type === "character") result.metadata.characterAssetId = ref.assetId;
    if (node.type === "scene") result.metadata.sceneAssetId = ref.assetId;
    if (node.type === "prop") result.metadata.productionAssetId = ref.assetId;
    for (const field of sharedAssetFields(node.type)) {
        const edit = ref?.writeThrough ? undefined : ref?.edits?.[field];
        setAssetField(result, field, edit ? edit.deleted ? undefined : edit.value : assetField(source, field));
    }
    if (["character", "scene", "prop"].includes(node.type)) {
        let hasLegacyProjectionEdit = false;
        if (!ref?.writeThrough) for (const field of ENTITY_IMAGE_PROJECTION_FIELDS) {
            const edit = ref?.edits?.[`metadata.${field}`];
            if (!edit) continue;
            hasLegacyProjectionEdit = true;
            if (edit.deleted) delete result.metadata[field];
            else if (Object.hasOwn(edit, "value")) result.metadata[field] = edit.value;
        }
        result.metadata = normalizeEntityPrimaryMedia(node.type, result.metadata, hasLegacyProjectionEdit ? "preview" : "legacy");
    }
    return result;
}
/** Persist identity, local intent and view context; never persist source content in a reference. */
export function stripSharedAssetContent(node: AssetNode): AssetNode {
    if (!node.metadata?.sharedAssetReference) return node;
    const result = { ...node, metadata: { ...node.metadata } };
    if (["character", "scene", "prop"].includes(node.type)) for (const field of ENTITY_IMAGE_PROJECTION_FIELDS) delete result.metadata[field];
    for (const field of sharedAssetFields(node.type)) setAssetField(result, field, undefined);
    return result;
}

export function libraryAssetNode(asset: { id: string; kind: string; title: string; data: Record<string, any> }): AssetNode {
    const d = asset.data as Record<string, any>;
    const metadata: Record<string, any> = { content: d.url || d.dataUrl || d.imageUrl || d.content || "", storageKey: d.storageKey, naturalWidth: d.width, naturalHeight: d.height, bytes: d.bytes, mimeType: d.mimeType, durationMs: d.durationMs };
    if (asset.kind === "character") Object.assign(metadata, { characterName: asset.title, characterAssetId: asset.id, characterEnglishName: d.englishName || "", characterDescription: d.description || "", characterImages: d.images || [], characterPrimaryIndex: d.primaryIndex || 0, characterVoiceUrl: d.voice || "", characterVoiceName: d.voiceName || "", characterVoiceDescription: d.voiceDescription || "", characterVoiceStorageKey: d.voiceStorageKey || "", characterVoiceAssetId: d.voiceAssetId || "" });
    if (asset.kind === "scene") Object.assign(metadata, { sceneName: asset.title, sceneDescription: d.description || "", sceneImage: d.image, sceneColorCard: d.colorCard, sceneColorPalette: d.colorPalette, sceneColorCardPrompt: d.colorCardPrompt || "" });
    if (asset.kind === "prop") Object.assign(metadata, { propName: d.name || asset.title, propDescription: d.description || "", propImage: d.image });
    if (["character", "scene", "prop"].includes(asset.kind)) {
        const image = asset.kind === "character" ? d.images?.[d.primaryIndex || 0] : d.image;
        Object.assign(metadata, { content: image?.url || "", storageKey: image?.storageKey, naturalWidth: image?.width, naturalHeight: image?.height, bytes: image?.bytes, mimeType: image?.mimeType });
    }
    const normalizedMetadata = normalizeEntityPrimaryMedia(asset.kind, metadata, "legacy");
    return { id: `library-${asset.id}`, type: asset.kind, title: asset.title, metadata: normalizedMetadata };
}
