import { stableReferenceId, type ReferenceBinding, type ReferenceRole } from "../../canvas/reference-contract.js";

type JsonRecord = Record<string, unknown>;

type CharacterGroupRequest = {
    selectedOutfitStorageKeys: string[];
    voiceEnabled?: boolean;
    subjectId?: string;
    existingGroup?: JsonRecord;
};

type BuiltCharacterGroup = {
    id: string;
    characterName: string;
    characterAssetId?: string;
    characterNodeId: string;
    subjectId: string;
    voice?: { url: string; name: string; description?: string; storageKey?: string; assetId?: string };
    outfits: Array<{ id: string; url: string; name: string; storageKey?: string; mimeType?: string; role: ReferenceRole; enabled: boolean }>;
    voiceEnabled: boolean;
};

export type CharacterGroupBuildResult = {
    group: BuiltCharacterGroup;
    refs: ReferenceBinding[];
    /** builder 只返回连接需求，绝不创建节点。 */
    ops: Array<{ type: "connect_nodes"; fromNodeId: string; toNodeId: string; role: "reference"; order: number }>;
};

function recordOf(value: unknown): JsonRecord {
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringOf(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function sourceKey(image: JsonRecord) {
    return stringOf(image.storageKey) || stringOf(image.url);
}

function imageName(image: JsonRecord) {
    return stringOf(image.outfit) || stringOf(image.name) || "outfit";
}

const CHARACTER_IMAGE_ROLES: ReferenceRole[] = ["character_identity", "character_turnaround", "storyboard", "scene", "blocking", "keyframe", "motion_reference", "style", "palette", "prop", "other"];

function imageRole(image: JsonRecord): ReferenceRole {
    return CHARACTER_IMAGE_ROLES.includes(image.role as ReferenceRole) ? image.role as ReferenceRole : "character_turnaround";
}

function outfitId(nodeId: string, key: string) {
    return `outfit-${stableReferenceId("binding", `${nodeId}:outfit:${key}`)}`;
}

function groupId(nodeId: string) {
    return `character-group-${stableReferenceId("asset", nodeId)}`;
}

/**
 * 从已有画布 character 节点构造完整角色组。
 * 调用方只传本 Clip 的 selected keys；完整服装目录永远从 node.metadata.characterImages 读取。
 */
export function buildCharacterGroupFromExistingNode(node: JsonRecord, request: CharacterGroupRequest): CharacterGroupBuildResult {
    const nodeId = stringOf(node.id);
    if (!nodeId || String(node.type || "") !== "character") throw new Error(`只能绑定已有 character 节点：${nodeId || "未知节点"}`);
    if (!request.selectedOutfitStorageKeys.length) throw new Error("当前 Clip 至少选择一套角色服装");

    const metadata = recordOf(node.metadata);
    const rawImages = Array.isArray(metadata.characterImages) ? metadata.characterImages : [];
    const images = rawImages.map(recordOf).map((image) => ({ image, key: sourceKey(image), url: stringOf(image.url) })).filter((item) => item.key && item.url);
    if (!images.length) throw new Error(`character 节点没有可用服装目录：${nodeId}`);
    const availableKeys = new Set(images.map((item) => item.key));
    const selectedKeys = new Set(request.selectedOutfitStorageKeys.map(String));
    const unknownKey = [...selectedKeys].find((key) => !availableKeys.has(key));
    if (unknownKey) throw new Error(`选择的服装不属于源角色节点：${unknownKey}`);

    const existingGroup = recordOf(request.existingGroup);
    const previousOutfits = Array.isArray(existingGroup.outfits) ? existingGroup.outfits.map(recordOf) : [];
    const previousByKey = new Map(previousOutfits.map((outfit) => [sourceKey(outfit), outfit]));
    const id = stringOf(existingGroup.id) || groupId(nodeId);
    const subjectId = stringOf(request.subjectId) || stringOf(existingGroup.subjectId) || nodeId;
    const outfits = images.map(({ image, key, url }) => {
        const previous = previousByKey.get(key);
        const id = stringOf(previous?.id) || outfitId(nodeId, key);
        return { id, url, name: imageName(image), storageKey: stringOf(image.storageKey) || undefined, mimeType: stringOf(image.mimeType) || undefined, role: imageRole(image), enabled: selectedKeys.has(key) };
    });
    const voiceUrl = stringOf(metadata.characterVoiceUrl);
    const voice = voiceUrl ? {
        url: voiceUrl,
        name: stringOf(metadata.characterVoiceName) || "声线",
        description: stringOf(metadata.characterVoiceDescription) || undefined,
        storageKey: stringOf(metadata.characterVoiceStorageKey) || undefined,
        assetId: stringOf(metadata.characterVoiceAssetId) || undefined,
    } : undefined;
    const characterName = stringOf(metadata.characterName) || stringOf(node.title) || "角色";
    const group: BuiltCharacterGroup = {
        id,
        characterName,
        characterAssetId: stringOf(metadata.characterAssetId) || undefined,
        characterNodeId: nodeId,
        subjectId,
        voice,
        outfits,
        voiceEnabled: Boolean(voice) && (request.voiceEnabled ?? Boolean(existingGroup.voiceEnabled)),
    };
    const refs: ReferenceBinding[] = outfits.filter((outfit) => outfit.enabled).map((outfit, index) => ({
        id: stableReferenceId("binding", `${id}:${outfit.id}`, index),
        assetId: stableReferenceId("asset", `${nodeId}:${outfit.storageKey || outfit.url}`),
        label: `${characterName} · ${outfit.name}`,
        role: outfit.role,
        tags: ["character-group", outfit.role],
        enabled: true,
        usage: "reference",
        subjectId,
        mediaType: "image",
        url: outfit.url,
        storageKey: outfit.storageKey,
        mimeType: outfit.mimeType,
        sourceNodeId: nodeId,
        groupId: id,
        outfitId: outfit.id,
    }));
    if (group.voiceEnabled && voice) {
        refs.push({
            id: stableReferenceId("binding", `${id}:voice`),
            assetId: voice.assetId || stableReferenceId("asset", `${nodeId}:voice`),
            label: `${characterName} · ${voice.name}`,
            role: "character_voice",
            tags: ["character-group"],
            enabled: true,
            usage: "reference",
            subjectId,
            mediaType: "audio",
            url: voice.url,
            storageKey: voice.storageKey,
            sourceNodeId: nodeId,
            groupId: id,
        });
    }
    return { group, refs, ops: [] };
}
