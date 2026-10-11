/** Live library references are distinct from immutable production approved versions. */
export type SharedAssetSource = { dramaId: string; assetId: string; sourceProjectId: string; sourceNodeId: string };
export type SharedAssetEdit = { base?: unknown; value?: unknown; deleted?: boolean };
export type SharedAssetReference = SharedAssetSource & { edits?: Record<string, SharedAssetEdit> };
export type AssetNode = { id: string; type: string; title?: string; metadata?: Record<string, any>; [key: string]: any };

const COMMON = ["content", "storageKey", "naturalWidth", "naturalHeight", "bytes", "mimeType", "durationMs"];
const FIELDS: Record<string, string[]> = {
    text: ["content"], image: COMMON, video: COMMON, audio: COMMON,
    character: [...COMMON, "characterName", "characterEnglishName", "characterDescription", "characterImages", "characterPrimaryIndex", "characterVoiceUrl", "characterVoiceName", "characterVoiceDescription", "characterVoiceStorageKey", "characterVoiceAssetId"],
    scene: [...COMMON, "sceneName", "sceneDescription", "sceneImage", "sceneColorCard", "sceneColorPalette", "sceneColorCardPrompt"],
};
export const sharedAssetFields = (type: string) => ["title", ...(FIELDS[type] || []).map(key => `metadata.${key}`)];
export const sameAssetValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function assetField(node: AssetNode, field: string): unknown { return field === "title" ? node.title : node.metadata?.[field.slice(9)]; }
export function setAssetField(node: AssetNode, field: string, value: unknown) {
    const target = field === "title" ? node : (node.metadata ||= {});
    const key = field === "title" ? field : field.slice(9);
    if (value === undefined) delete target[key]; else target[key] = value;
}
export function resolveSharedAssetNode(node: AssetNode, source: AssetNode): AssetNode {
    const result = { ...node, metadata: { ...node.metadata } };
    const ref = node.metadata?.sharedAssetReference as SharedAssetReference;
    delete result.metadata.sharedAssetMissing;
    if (node.type === "character") result.metadata.characterAssetId = ref.assetId;
    if (node.type === "scene") result.metadata.sceneAssetId = ref.assetId;
    for (const field of sharedAssetFields(node.type)) {
        const edit = ref?.edits?.[field];
        setAssetField(result, field, edit ? edit.deleted ? undefined : edit.value : assetField(source, field));
    }
    return result;
}
/** Persist identity, local intent and view context; never persist source content in a reference. */
export function stripSharedAssetContent(node: AssetNode): AssetNode {
    if (!node.metadata?.sharedAssetReference) return node;
    const result = { ...node, metadata: { ...node.metadata } };
    for (const field of sharedAssetFields(node.type)) setAssetField(result, field, undefined);
    return result;
}

export function libraryAssetNode(asset: { id: string; kind: string; title: string; data: Record<string, any> }): AssetNode {
    const d = asset.data as Record<string, any>;
    const metadata: Record<string, any> = { content: d.url || d.dataUrl || d.imageUrl || d.content || "", storageKey: d.storageKey, naturalWidth: d.width, naturalHeight: d.height, bytes: d.bytes, mimeType: d.mimeType, durationMs: d.durationMs };
    if (asset.kind === "character") Object.assign(metadata, { characterName: asset.title, characterAssetId: asset.id, characterEnglishName: d.englishName || "", characterDescription: d.description || "", characterImages: d.images || [], characterPrimaryIndex: d.primaryIndex || 0, characterVoiceUrl: d.voice || "", characterVoiceName: d.voiceName || "", characterVoiceDescription: d.voiceDescription || "", characterVoiceStorageKey: d.voiceStorageKey || "", characterVoiceAssetId: d.voiceAssetId || "" });
    if (asset.kind === "scene") Object.assign(metadata, { sceneName: asset.title, sceneDescription: d.description || "", sceneImage: d.image, sceneColorCard: d.colorCard, sceneColorPalette: d.colorPalette, sceneColorCardPrompt: d.colorCardPrompt || "" });
    if (asset.kind === "character" || asset.kind === "scene") {
        const image = asset.kind === "character" ? d.images?.[d.primaryIndex || 0] : d.image;
        Object.assign(metadata, { content: image?.url || "", storageKey: image?.storageKey, naturalWidth: image?.width, naturalHeight: image?.height, bytes: image?.bytes, mimeType: image?.mimeType });
    }
    return { id: `library-${asset.id}`, type: asset.kind, title: asset.title, metadata };
}
