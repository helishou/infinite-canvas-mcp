import type { H3CharacterGroup, H3CharacterOutfit, H3CharacterVoice, H3Ref, H3Segment } from "../types";
import { sameRef } from "./h3-compatibility";

export function refsForSegment(segment: H3Segment) {
    const buckets = segment.refs;
    const bucketItems = [ ...(buckets?.image || []), ...(buckets?.video || []), ...(buckets?.audio || []) ];
    // Older MCP-written nodes may keep the canonical refs in buckets while
    // persisting an empty refItems array. Treat that empty array as absent;
    // once refItems contains entries it is the canonical ordered list.
    const items = segment.refItems?.length ? segment.refItems : bucketItems;
    const refs = items.filter((item) => (item?.url || item?.storageKey) && String(item.role || "") !== "character_identity").map((item) => ({ ...item, type: item.type || (item as H3Ref & { kind?: H3Ref["type"] }).kind || "image" as const }));
    return refs.filter((item, index, all) => all.findIndex((other) => sameRef(other, item)) === index);
}

export function segmentRefsPatch(refs: H3Ref[]): Pick<H3Segment, "refItems" | "refs"> {
    return {
        refItems: refs,
        refs: {
            image: refs.filter((item) => item.type === "image"),
            video: refs.filter((item) => item.type === "video"),
            audio: refs.filter((item) => item.type === "audio"),
        },
    };
}

export function withSegmentRefs(segment: H3Segment, refs: H3Ref[]): H3Segment {
    return { ...segment, ...segmentRefsPatch(refs) };
}

// ---- 角色组：拖入角色资产/角色节点时建组，ref 槽里 image/audio ref 都标 groupId ----

function genGroupId(): string {
    return `cg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function genOutfitId(): string {
    return `of-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function findCharacterGroup(segment: H3Segment, groupId: string): H3CharacterGroup | undefined {
    return segment.h3CharacterGroups?.[groupId];
}

/** 按 characterAssetId 或 characterNodeId 找已有同源角色组；用于重复拖入时复用选择。 */
export function findCharacterGroupBySource(segment: H3Segment, source: { characterAssetId?: string; characterNodeId?: string }): H3CharacterGroup | undefined {
    const groups = segment.h3CharacterGroups;
    if (!groups) return undefined;
    return Object.values(groups).find((group) => (
        (source.characterAssetId && group.characterAssetId === source.characterAssetId)
        || (source.characterNodeId && group.characterNodeId === source.characterNodeId)
    ));
}

/** 从一个角色组派生当前应在 ref 槽里的 refs：每张 enabled outfit 拆为 image ref，voiceEnabled 时 voice 拆为 audio ref。 */
export function refsFromCharacterGroup(group: H3CharacterGroup): H3Ref[] {
    const refs: H3Ref[] = [];
    for (const outfit of group.outfits) {
        if (!outfit.enabled) continue;
        refs.push({
            url: outfit.url,
            type: "image",
            name: `${group.characterName} · ${outfit.name}`,
            storageKey: outfit.storageKey,
            mimeType: outfit.mimeType,
            groupId: group.id,
            outfitId: outfit.id,
        });
    }
    if (group.voiceEnabled && group.voice?.url) {
        refs.push({
            url: group.voice.url,
            type: "audio",
            name: group.voice.name || `${group.characterName} · 声线`,
            storageKey: group.voice.storageKey,
            role: "character_voice",
            groupId: group.id,
        });
    }
    return refs;
}

/** 把 segment 上的 refs 重写：原 refs 拆成 "group 派生 refs" + "非 group refs（独立 image/video/audio ref）"，再合并。 */
function rewriteRefsWithGroups(segment: H3Segment, groups: Record<string, H3CharacterGroup>): H3Ref[] {
    const previous = refsForSegment(segment);
    const fromGroups: H3Ref[] = [];
    const standalone: H3Ref[] = [];
    for (const ref of previous) {
        if (ref.groupId && groups[ref.groupId]) {
            fromGroups.push(ref);
        } else if (ref.groupId) {
            // group 已被删，对应的 ref 一并丢弃
        } else {
            standalone.push(ref);
        }
    }
    const derived: H3Ref[] = [];
    for (const group of Object.values(groups)) {
        for (const ref of refsFromCharacterGroup(group)) {
            if (!fromGroups.some((item) => sameRef(item, ref) && item.groupId === ref.groupId)) derived.push(ref);
        }
    }
    return [...standalone, ...derived].filter((item, index, all) => all.findIndex((other) => sameRef(other, item)) === index);
}

export function setSegmentCharacterGroups(segment: H3Segment, groups: Record<string, H3CharacterGroup>): H3Segment {
    const next = { ...segment, h3CharacterGroups: groups };
    return withSegmentRefs(next, rewriteRefsWithGroups(next, groups));
}

/** 登记一个新角色组，或按 source 复用现有组并补齐最新 outfit/voice 列表（保留当前 enabled / voiceEnabled 选择）。 */
export function upsertCharacterGroup(segment: H3Segment, input: {
    characterName: string;
    characterAssetId?: string;
    characterNodeId?: string;
    outfits: Array<{ url: string; name: string; storageKey?: string; mimeType?: string }>;
    voice?: H3CharacterVoice;
    defaultVoiceEnabled?: boolean;
}): H3Segment {
    const existing = findCharacterGroupBySource(segment, input);
    const groups = { ...(segment.h3CharacterGroups || {}) };
    if (existing) {
        // 同源角色：保留当前 enabled 选择，仅补齐新增的 outfit / 更新 voice 字段
        const existingByUrl = new Map(existing.outfits.map((outfit) => [outfit.url, outfit]));
        const nextOutfits: H3CharacterOutfit[] = input.outfits.map((item) => {
            const prev = existingByUrl.get(item.url);
            return {
                id: prev?.id || genOutfitId(),
                url: item.url,
                name: item.name,
                storageKey: item.storageKey,
                mimeType: item.mimeType,
                enabled: prev ? prev.enabled : true,
            };
        });
        groups[existing.id] = {
            ...existing,
            characterName: input.characterName || existing.characterName,
            voice: input.voice || existing.voice,
            outfits: nextOutfits,
        };
        return setSegmentCharacterGroups(segment, groups);
    }
    const id = genGroupId();
    groups[id] = {
        id,
        characterName: input.characterName,
        characterAssetId: input.characterAssetId,
        characterNodeId: input.characterNodeId,
        voice: input.voice,
        outfits: input.outfits.map((item) => ({
            id: genOutfitId(),
            url: item.url,
            name: item.name,
            storageKey: item.storageKey,
            mimeType: item.mimeType,
            enabled: true,
        })),
        voiceEnabled: input.voice ? (input.defaultVoiceEnabled ?? true) : false,
    };
    return setSegmentCharacterGroups(segment, groups);
}

export function removeCharacterGroup(segment: H3Segment, groupId: string): H3Segment {
    const groups = { ...(segment.h3CharacterGroups || {}) };
    if (!groups[groupId]) return segment;
    delete groups[groupId];
    return setSegmentCharacterGroups(segment, groups);
}

/** 在 modal 里编辑后整体写回：outfit.enabled 与 voiceEnabled 变更。 */
export function applyCharacterGroupEdits(segment: H3Segment, groupId: string, patch: { outfitEnabled?: Record<string, boolean>; voiceEnabled?: boolean }): H3Segment {
    const group = segment.h3CharacterGroups?.[groupId];
    if (!group) return segment;
    const nextGroup: H3CharacterGroup = {
        ...group,
        outfits: patch.outfitEnabled ? group.outfits.map((outfit) => ({
            ...outfit,
            enabled: patch.outfitEnabled![outfit.id] ?? outfit.enabled,
        })) : group.outfits,
        voiceEnabled: patch.voiceEnabled ?? group.voiceEnabled,
    };
    // 全部 outfit 都关了 → 直接删组
    if (!nextGroup.outfits.some((outfit) => outfit.enabled)) {
        return removeCharacterGroup(segment, groupId);
    }
    return setSegmentCharacterGroups(segment, { ...(segment.h3CharacterGroups || {}), [groupId]: nextGroup });
}

/** 通过 ref 在 ref 槽里的 groupId/outfitId 找到所属角色组。 */
export function findGroupForRef(segment: H3Segment, ref: H3Ref): H3CharacterGroup | undefined {
    if (!ref.groupId) return undefined;
    return segment.h3CharacterGroups?.[ref.groupId];
}

export function resultUrl(value: unknown) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    const item = value as Record<string, unknown>;
    return String(item.url || item.video_url || item.content || item.localUrl || "");
}

