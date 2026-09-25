export type CharacterGroupValidationIssue = {
    severity: "error" | "warning";
    code: string;
    message: string;
    groupId?: string;
    characterNodeId?: string;
    outfitKey?: string;
    bindingId?: string;
};

type JsonRecord = Record<string, unknown>;
const CHARACTER_IMAGE_ROLES = new Set(["character_identity", "character_turnaround", "storyboard", "scene", "blocking", "keyframe", "motion_reference", "style", "palette", "prop", "other"]);

function recordOf(value: unknown): JsonRecord {
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function arrayOf(value: unknown): JsonRecord[] {
    return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function mediaKey(value: JsonRecord) {
    const key = String(value.storageKey || value.url || "").trim();
    return key || undefined;
}

function characterImageRole(image: JsonRecord | undefined) {
    const role = String(image?.role || "");
    return CHARACTER_IMAGE_ROLES.has(role) ? role : "character_turnaround";
}

function nodeMetadata(node: JsonRecord) {
    return recordOf(node.metadata);
}

function issue(code: string, message: string, extra: Partial<CharacterGroupValidationIssue> = {}): CharacterGroupValidationIssue {
    return { severity: "error", code, message, ...extra };
}

/**
 * 验证 H3 角色组的来源、完整目录和派生引用关系。
 *
 * 角色组的 outfits 是完整源目录；enabled 只表示当前 Clip 的选择。
 * 这里故意不按 enabled 过滤源目录，因此“只剩一套”的数据会在生成前明确失败。
 */
export function validateH3CharacterGroups(project: Record<string, unknown>, segment: Record<string, unknown>): CharacterGroupValidationIssue[] {
    const groups = recordOf(segment.h3CharacterGroups);
    const nodes = arrayOf(project.nodes);
    const nodeById = new Map(nodes.map((node) => [String(node.id || ""), node]));
    const catalog = new Map(arrayOf(project.referenceCatalog).map((asset) => [String(asset.id || ""), asset]));
    const bindings = arrayOf(segment.referenceBindings);
    const issues: CharacterGroupValidationIssue[] = [];

    for (const [groupKey, rawGroup] of Object.entries(groups)) {
        const group = recordOf(rawGroup);
        const groupId = String(group.id || groupKey);
        const characterNodeId = String(group.characterNodeId || "").trim();
        if (!characterNodeId) {
            issues.push(issue("character_group_source_missing", `角色组“${String(group.characterName || groupId)}”没有 characterNodeId`, { groupId }));
            continue;
        }
        const sourceNode = nodeById.get(characterNodeId);
        if (!sourceNode) {
            issues.push(issue("character_group_source_missing", `角色组“${String(group.characterName || groupId)}”找不到源角色节点：${characterNodeId}`, { groupId, characterNodeId }));
            continue;
        }
        if (String(sourceNode.type || "") !== "character") {
            issues.push(issue("character_group_source_not_character", `角色组“${String(group.characterName || groupId)}”的源节点不是 character：${characterNodeId}`, { groupId, characterNodeId }));
            continue;
        }

        const sourceMetadata = nodeMetadata(sourceNode);
        const sourceAssetId = String(sourceMetadata.characterAssetId || "").trim();
        const groupAssetId = String(group.characterAssetId || "").trim();
        if (!groupAssetId) {
            issues.push(issue("character_group_asset_missing", `角色组“${String(group.characterName || groupId)}”没有 characterAssetId`, { groupId, characterNodeId }));
        }
        if (groupAssetId && sourceAssetId && groupAssetId !== sourceAssetId) {
            issues.push(issue("character_group_asset_mismatch", `角色组“${String(group.characterName || groupId)}”的 characterAssetId 与源节点不一致`, { groupId, characterNodeId }));
        }

        const sourceImages = arrayOf(sourceMetadata.characterImages);
        const sourceKeys = sourceImages.map(mediaKey).filter((key): key is string => Boolean(key));
        const sourceImagesByKey = new Map<string, JsonRecord>();
        sourceImages.forEach((image) => {
            const key = mediaKey(image);
            if (key) sourceImagesByKey.set(key, image);
        });
        const outfitItems = arrayOf(group.outfits);
        const outfitsByKey = new Map<string, JsonRecord>();
        for (const outfit of outfitItems) {
            const key = mediaKey(outfit);
            if (!key) {
                issues.push(issue("character_group_outfit_media_missing", `角色组“${String(group.characterName || groupId)}”有服装缺少 url/storageKey`, { groupId, characterNodeId }));
                continue;
            }
            if (outfitsByKey.has(key)) {
                issues.push(issue("character_group_outfit_duplicate", `角色组“${String(group.characterName || groupId)}”重复服装：${key}`, { groupId, characterNodeId, outfitKey: key }));
            }
            outfitsByKey.set(key, outfit);
            if (!String(outfit.url || "").trim()) {
                issues.push(issue("character_group_preview_url_missing", `角色组“${String(group.characterName || groupId)}”服装缺少预览 URL：${key}`, { groupId, characterNodeId, outfitKey: key }));
            }
        }
        for (const key of sourceKeys) {
            if (!outfitsByKey.has(key)) {
                issues.push(issue("character_group_outfit_missing", `角色组“${String(group.characterName || groupId)}”缺少源节点服装：${key}`, { groupId, characterNodeId, outfitKey: key }));
            }
        }

        const expectedSubjectId = String(group.subjectId || "").trim() || characterNodeId;
        // 总开关关闭时保留完整服装目录，但当前 Clip 不再要求这些图片的派生 binding。
        const enabledOutfits = group.outfitEnabled === false ? [] : outfitItems.filter((outfit) => outfit.enabled !== false);
        for (const outfit of enabledOutfits) {
            const key = mediaKey(outfit);
            if (!key) continue;
            const matching = bindings.filter((binding) => String(binding.groupId || "") === groupId && String(binding.outfitId || "") === String(outfit.id || ""));
            if (matching.length !== 1) {
                issues.push(issue("character_group_binding_count", `角色组“${String(group.characterName || groupId)}”的启用服装“${key}”应有一个派生 binding，实际 ${matching.length} 个`, { groupId, characterNodeId, outfitKey: key }));
                continue;
            }
            const binding = matching[0];
            const bindingUrl = String(binding.url || catalog.get(String(binding.assetId || ""))?.url || "").trim();
            if (!bindingUrl) {
                issues.push(issue("character_group_preview_url_missing", `角色组“${String(group.characterName || groupId)}”的 binding 缺少预览 URL：${key}`, { groupId, characterNodeId, outfitKey: key, bindingId: String(binding.id || "") }));
            }
            if (String(binding.sourceNodeId || "") !== characterNodeId) {
                issues.push(issue("character_group_binding_source_mismatch", `角色组“${String(group.characterName || groupId)}”的 binding 没有绑定源角色节点`, { groupId, characterNodeId, outfitKey: key, bindingId: String(binding.id || "") }));
            }
            const sourceImage = sourceImagesByKey.get(key);
            const expectedRole = characterImageRole(sourceImage);
            if (String(outfit.role || "character_turnaround") !== expectedRole || String(binding.role || "") !== expectedRole) {
                issues.push(issue("character_group_binding_role_mismatch", `角色组“${String(group.characterName || groupId)}”的图片职责与源角色节点不一致`, { groupId, characterNodeId, outfitKey: key, bindingId: String(binding.id || "") }));
            }
            if (String(binding.subjectId || "") !== expectedSubjectId) {
                issues.push(issue("character_group_binding_subject_mismatch", `角色组“${String(group.characterName || groupId)}”的 binding subjectId 不一致`, { groupId, characterNodeId, outfitKey: key, bindingId: String(binding.id || "") }));
            }
        }
    }

    return issues;
}
