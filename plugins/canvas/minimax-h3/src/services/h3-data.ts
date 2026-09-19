import type { H3CharacterGroup, H3CharacterOutfit, H3CharacterVoice, H3Ref, H3ReferenceBinding, H3ReferenceRole, H3Segment } from "../types";
import { sameRef } from "./h3-compatibility";

export function refsForSegment(segment: H3Segment) {
    if (segment.referenceBindings?.length) {
        return segment.referenceBindings.filter((binding) => binding.enabled !== false && (binding.url || binding.storageKey)).map((binding) => ({
            url: binding.url || "", type: binding.mediaType || inferRefType(binding.mimeType || binding.url || binding.label), name: binding.label,
            storageKey: binding.storageKey, mimeType: binding.mimeType, nodeId: binding.sourceNodeId, role: binding.role,
            subjectId: binding.subjectId, storyboardSubjectIds: binding.storyboardSubjectIds, bindingId: binding.id, assetId: binding.assetId, tags: binding.tags, enabled: binding.enabled, usage: binding.usage,
            groupId: binding.groupId, outfitId: binding.outfitId,
        } as H3Ref));
    }
    const buckets = segment.refs;
    const bucketItems = [ ...(buckets?.image || []), ...(buckets?.video || []), ...(buckets?.audio || []) ];
    // Older MCP-written nodes may keep the canonical refs in buckets while
    // persisting an empty refItems array. Treat that empty array as absent;
    // once refItems contains entries it is the canonical ordered list.
    const items = segment.refItems?.length ? segment.refItems : bucketItems;
    const refs = items.filter((item) => item?.url || item?.storageKey).map((item) => ({ ...item, type: item.type || (item as H3Ref & { kind?: H3Ref["type"] }).kind || "image" as const }));
    return refs.filter((item, index, all) => all.findIndex((other) => sameRef(other, item)) === index);
}

export function segmentRefsPatch(refs: H3Ref[]): Pick<H3Segment, "referenceBindings" | "refItems" | "refs"> {
    const normalized = refs.map((ref, index) => ensureReferenceIdentity(ref, index));
    return {
        referenceBindings: normalized.map(refToBinding),
        refItems: normalized,
        refs: {
            image: normalized.filter((item) => item.type === "image"),
            video: normalized.filter((item) => item.type === "video"),
            audio: normalized.filter((item) => item.type === "audio"),
        },
    };
}

export function inferReferenceRole(ref: Pick<H3Ref, "name" | "role" | "type">): H3ReferenceRole {
    if (ref.role) return ref.role;
    const text = `${ref.name || ""} ${ref.type || ""}`.toLowerCase();
    if (/色卡|调色|palette|color card/.test(text)) return "palette";
    if (/站位|轴线|blocking|position/.test(text)) return "blocking";
    if (/四视图|三视图|turnaround|character sheet/.test(text)) return "character_turnaround";
    if (/人物|角色|定妆|形象|identity|portrait/.test(text)) return "character_identity";
    if (/分镜|关键帧|storyboard|shot|frame/.test(text)) return "storyboard";
    if (/场景|环境|scene|room/.test(text)) return "scene";
    if (/动作|运动|motion/.test(text)) return "motion_reference";
    if (/声线|配音|voice/.test(text)) return "character_voice";
    if (/音频|音乐|audio|music|sound/.test(text)) return "audio_reference";
    if (/风格|style|look/.test(text)) return "style";
    if (/道具|prop|ticket|phone/.test(text)) return "prop";
    return "other";
}

function refToBinding(ref: H3Ref): H3ReferenceBinding {
    return { id: ref.bindingId!, assetId: ref.assetId!, label: ref.name, role: inferReferenceRole(ref), tags: ref.tags || [], enabled: ref.enabled !== false, usage: ref.usage || "reference", subjectId: ref.subjectId, storyboardSubjectIds: ref.storyboardSubjectIds, mediaType: ref.type, url: ref.url, storageKey: ref.storageKey, mimeType: ref.mimeType, sourceNodeId: ref.nodeId, groupId: ref.groupId, outfitId: ref.outfitId };
}

function ensureReferenceIdentity(ref: H3Ref, index: number): H3Ref {
    const identity = ref.storageKey || ref.url || ref.nodeId || `${ref.name}-${index}`;
    return { ...ref, bindingId: ref.bindingId || stableId("binding", `${identity}:${index}`), assetId: ref.assetId || stableId("asset", identity), role: inferReferenceRole(ref), tags: ref.tags || [], enabled: ref.enabled !== false, usage: ref.usage || "reference" };
}

function stableId(prefix: string, value: string) {
    let hash = 2166136261;
    for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function inferRefType(value: string): H3Ref["type"] {
    return /video|\.(mp4|webm|mov)(?:$|\?)/i.test(value) ? "video" : /audio|\.(mp3|wav|m4a|flac)(?:$|\?)/i.test(value) ? "audio" : "image";
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

function characterGroupCapacity(segment: H3Segment, groupId?: string) {
    const rawMode = String(segment.mode || segment.taskMode || "ref2va");
    const mode = rawMode === "t2v" || rawMode === "i2v" || rawMode === "fl2v" ? rawMode : "ref2va";
    // ref2va 的参考图槽位不限数量（与画布 ref 槽位一致）：角色 outfit 不再按 9 张裁剪；
    // i2v / fl2v 的图片是固定语义（首帧 / 首尾帧）才需要限制。
    const imageLimit = mode === "t2v" ? 0 : mode === "i2v" ? 1 : mode === "fl2v" ? 2 : Number.POSITIVE_INFINITY;
    const audioLimit = mode === "ref2va" ? 3 : 0;
    // 把"其他角色组"也算上：用 h3CharacterGroups 直接汇总每个组的 enabled outfit / audio，避免
    // segment.refItems 在用户清空 / 替换时不一致而把当前 group 误判为超限。
    const groups = segment.h3CharacterGroups || {};
    let otherImages = 0;
    let otherAudios = 0;
    for (const [id, grp] of Object.entries(groups)) {
        if (groupId && id === groupId) continue;
        otherImages += grp.outfits.filter((outfit) => outfit.enabled).length;
        if (grp.voiceEnabled) otherAudios += 1;
    }
    // 当前 group 之外的 standalone ref（用户手动拖入的非角色 ref）也参与计数
    const standaloneRefs = (segment.refItems || []).filter((ref) => !ref.groupId);
    otherImages += standaloneRefs.filter((ref) => ref.type === "image").length;
    otherAudios += standaloneRefs.filter((ref) => ref.type === "audio").length;
    return {
        images: Math.max(0, imageLimit - otherImages),
        voice: otherAudios < audioLimit,
    };
}

function fitCharacterGroupToCapacity(segment: H3Segment, group: H3CharacterGroup): H3CharacterGroup {
    const capacity = characterGroupCapacity(segment, group.id);
    let imagesLeft = capacity.images;
    return {
        ...group,
        outfits: group.outfits.map((outfit) => {
            if (!outfit.enabled) return outfit;
            if (imagesLeft <= 0) return { ...outfit, enabled: false };
            imagesLeft -= 1;
            return outfit;
        }),
        voiceEnabled: Boolean(group.voice) && group.voiceEnabled && capacity.voice,
    };
}

/** 从一个角色组派生当前应在 ref 槽里的 refs：每张 enabled outfit 拆为 image ref，voiceEnabled 时 voice 拆为 audio ref。 */
export function refsFromCharacterGroup(group: H3CharacterGroup): H3Ref[] {
    const refs: H3Ref[] = [];
    const subjectId = group.subjectId || group.characterNodeId;
    for (const outfit of group.outfits) {
        if (!outfit.enabled) continue;
        refs.push({
            url: outfit.url,
            type: "image",
            name: `${group.characterName} · ${outfit.name}`,
            storageKey: outfit.storageKey,
            mimeType: outfit.mimeType,
            nodeId: group.characterNodeId,
            role: "character_turnaround",
            subjectId,
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
            nodeId: group.characterNodeId,
            subjectId,
            groupId: group.id,
        });
    }
    return refs;
}

/** 把 segment 上的 refs 重写：原 refs 拆成 "group 派生 refs + 非 group refs"。character group 的 ref 必须由当前 group.outfits 的 enabled 状态决定 —— 用户在 modal 取消勾选后，旧 ref 应该从 fromGroups 里丢掉，让 ref 槽只显示仍 enabled 的 outfit。 */
function rewriteRefsWithGroups(segment: H3Segment, groups: Record<string, H3CharacterGroup>): H3Ref[] {
    const previous = refsForSegment(segment);
    const fromGroups: H3Ref[] = [];
    const standalone: H3Ref[] = [];
    for (const ref of previous) {
        if (ref.groupId && groups[ref.groupId]) {
            // 仅当 ref 对应的 outfit 当前 enabled 时才保留 —— 否则当作 disabled，丢弃
            const group = groups[ref.groupId];
            const matchingOutfit = group?.outfits.find((outfit) => outfit.id === ref.outfitId);
            // audio ref 没有 outfitId：用 group.voiceEnabled 决定是否保留
            const isAudioRef = ref.type === "audio";
            const stillEnabled = isAudioRef ? Boolean(group?.voiceEnabled) && Boolean(group?.voice?.url) : Boolean(matchingOutfit?.enabled);
            if (stillEnabled) fromGroups.push(ref);
        } else if (ref.groupId) {
            // group 已被删，对应的 ref 一并丢弃
        } else {
            standalone.push(ref);
        }
    }
    const derived: H3Ref[] = [];
    for (const group of Object.values(groups)) {
        for (const ref of refsFromCharacterGroup(group)) {
            // derived 只补 fromGroups 没有的 ref（比如新增的 outfit / 之前没出现过的 audio ref）。
            if (!fromGroups.some((item) => sameRef(item, ref) && item.groupId === ref.groupId)) derived.push(ref);
        }
    }
    return [...standalone, ...fromGroups, ...derived].filter((item, index, all) => all.findIndex((other) => sameRef(other, item)) === index);
}

export function setSegmentCharacterGroups(segment: H3Segment, groups: Record<string, H3CharacterGroup>): H3Segment {
    const next = { ...segment, h3CharacterGroups: groups };
    return withSegmentRefs(next, rewriteRefsWithGroups(next, groups));
}

type CharacterOutfitInput = { url: string; name: string; storageKey?: string; mimeType?: string };

type UpsertCharacterGroupInput = {
    characterName: string;
    characterAssetId?: string;
    characterNodeId?: string;
    subjectId?: string;
    outfits: CharacterOutfitInput[];
    /** 只表达当前 Clip 的选择，不是服装目录。 */
    selectedOutfitKeys?: string[];
    voice?: H3CharacterVoice;
    defaultVoiceEnabled?: boolean;
};

function outfitKey(outfit: Pick<CharacterOutfitInput, "storageKey" | "url">) {
    return outfit.storageKey || outfit.url;
}

function mergeOutfitCatalog(existing: H3CharacterOutfit[], incoming: CharacterOutfitInput[], selectedOutfitKeys?: string[]) {
    const incomingByKey = new Map(incoming.map((item) => [outfitKey(item), item]));
    const existingByKey = new Map(existing.map((item) => [outfitKey(item), item]));
    const orderedKeys = [
        ...incoming.map(outfitKey),
        ...existing.map(outfitKey).filter((key) => !incomingByKey.has(key)),
    ];
    return orderedKeys.map((key) => {
        const item = incomingByKey.get(key);
        const previous = existingByKey.get(key);
        if (!item && previous) return previous;
        if (!item) throw new Error(`角色服装目录项不存在:${key}`);
        const selected = selectedOutfitKeys ? selectedOutfitKeys.includes(key) : undefined;
        return {
            id: previous?.id || genOutfitId(),
            url: item.url,
            name: item.name,
            storageKey: item.storageKey,
            mimeType: item.mimeType,
            enabled: selected ?? previous?.enabled ?? true,
        };
    });
}

/** 登记一个角色组：outfits 是完整源目录，selectedOutfitKeys 只修改当前 Clip 的启用状态。 */
export function upsertCharacterGroup(segment: H3Segment, input: UpsertCharacterGroupInput): H3Segment {
    if (!input.characterNodeId) throw new Error("角色组必须绑定已有 characterNodeId");
    if (!input.outfits.length) throw new Error(`角色 ${input.characterName || input.characterNodeId} 缺少完整服装目录`);
    if (input.selectedOutfitKeys && !input.selectedOutfitKeys.length) throw new Error("当前 Clip 至少需要选择一套角色服装");
    const existing = findCharacterGroupBySource(segment, input);
    const groups = { ...(segment.h3CharacterGroups || {}) };
    if (existing) {
        // 同源角色默认合并目录：即使调用方只带当前选择，也不能删除历史目录项。
        const nextOutfits = mergeOutfitCatalog(existing.outfits, input.outfits, input.selectedOutfitKeys);
        const nextVoice = input.voice || existing.voice;
        const nextGroup = fitCharacterGroupToCapacity(segment, {
            ...existing,
            characterName: input.characterName || existing.characterName,
            characterAssetId: input.characterAssetId || existing.characterAssetId,
            characterNodeId: input.characterNodeId,
            subjectId: input.subjectId || existing.subjectId || input.characterNodeId,
            voice: nextVoice,
            outfits: nextOutfits,
            voiceEnabled: nextVoice ? (existing.voice ? existing.voiceEnabled : (input.defaultVoiceEnabled ?? true)) : false,
        });
        if (!nextGroup.outfits.some((outfit) => outfit.enabled)) return segment;
        groups[existing.id] = nextGroup;
        return setSegmentCharacterGroups(segment, groups);
    }
    const id = genGroupId();
    const nextGroup = fitCharacterGroupToCapacity(segment, {
        id,
        characterName: input.characterName,
        characterAssetId: input.characterAssetId,
        characterNodeId: input.characterNodeId,
        subjectId: input.subjectId || input.characterNodeId,
        voice: input.voice,
        outfits: mergeOutfitCatalog([], input.outfits, input.selectedOutfitKeys),
        voiceEnabled: input.voice ? (input.defaultVoiceEnabled ?? true) : false,
    });
    if (!nextGroup.outfits.some((outfit) => outfit.enabled)) return segment;
    groups[id] = nextGroup;
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
    const nextGroup = fitCharacterGroupToCapacity(segment, {
        ...group,
        outfits: patch.outfitEnabled ? group.outfits.map((outfit) => ({
            ...outfit,
            enabled: patch.outfitEnabled![outfit.id] ?? outfit.enabled,
        })) : group.outfits,
        voiceEnabled: patch.voiceEnabled ?? group.voiceEnabled,
    });
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
