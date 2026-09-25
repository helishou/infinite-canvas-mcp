import type { H3CharacterGroup, H3CharacterGroupEditPatch, H3CharacterOutfit, H3CharacterVoice, H3Ref, H3ReferenceBinding, H3ReferenceRole, H3Segment } from "../types";
import { sameRef } from "./h3-compatibility";

export function refsForSegment(segment: H3Segment) {
    if (segment.referenceBindings?.length) {
        return segment.referenceBindings.filter((binding) => binding.enabled !== false && (binding.url || binding.storageKey)).map((binding) => ({
            url: binding.url || "", type: inferH3ReferenceMediaType(binding), name: binding.label,
            storageKey: binding.storageKey, mimeType: binding.mimeType, nodeId: binding.sourceNodeId, role: binding.role,
            subjectId: binding.subjectId, storyboardSubjectIds: binding.storyboardSubjectIds, bindingId: binding.id, assetId: binding.assetId, tags: binding.tags, description: binding.description, enabled: binding.enabled, usage: binding.usage, retentionLevel: binding.retentionLevel,
            groupId: binding.groupId, outfitId: binding.outfitId,
        } as H3Ref));
    }
    const buckets = segment.refs;
    const bucketItems = [ ...(buckets?.image || []), ...(buckets?.video || []), ...(buckets?.audio || []) ];
    // Older MCP-written nodes may keep the canonical refs in buckets while
    // persisting an empty refItems array. Treat that empty array as absent;
    // once refItems contains entries it is the canonical ordered list.
    const items = segment.refItems?.length ? segment.refItems : bucketItems;
    const refs = items.filter((item) => item?.url || item?.storageKey).map((item) => ({ ...item, type: inferH3ReferenceMediaType(item as H3Ref & { kind?: H3Ref["type"] }) }));
    return refs.filter((item, index, all) => all.findIndex((other) => sameRef(other, item)) === index);
}

export function segmentRefsPatch(refs: H3Ref[]): Pick<H3Segment, "referenceBindings" | "refItems" | "refs"> {
    const normalized = refs.map((ref, index) => ensureReferenceIdentity(ref, index));
    return {
        referenceBindings: normalized.map(refToBinding),
        refItems: undefined,
        refs: undefined,
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
    return { id: ref.bindingId!, assetId: ref.assetId!, label: ref.name, role: inferReferenceRole(ref), tags: ref.tags || [], description: ref.description, enabled: ref.enabled !== false, usage: ref.usage || "reference", retentionLevel: ref.retentionLevel, subjectId: ref.subjectId, storyboardSubjectIds: ref.storyboardSubjectIds, mediaType: ref.type, url: ref.url, storageKey: ref.storageKey, mimeType: ref.mimeType, sourceNodeId: ref.nodeId, groupId: ref.groupId, outfitId: ref.outfitId };
}

function ensureReferenceIdentity(ref: H3Ref, index: number): H3Ref {
    const identity = inferReferenceRole(ref) === "scene" && ref.nodeId ? `scene:${ref.nodeId}` : ref.storageKey || ref.url || ref.nodeId || `${ref.name}-${index}`;
    return { ...ref, bindingId: ref.bindingId || stableId("binding", `${identity}:${index}`), assetId: ref.assetId || stableId("asset", identity), role: inferReferenceRole(ref), tags: ref.tags || [], enabled: ref.enabled !== false, usage: ref.usage || "reference" };
}

function stableId(prefix: string, value: string) {
    let hash = 2166136261;
    for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `${prefix}-${(hash >>> 0).toString(36)}`;
}

export function inferH3ReferenceMediaType(value: { storageKey?: unknown; mediaType?: unknown; type?: unknown; kind?: unknown; mimeType?: unknown; url?: unknown; name?: unknown; label?: unknown }): H3Ref["type"] {
    const storageType = /^(image|video|audio):/i.exec(String(value.storageKey || ""))?.[1]?.toLowerCase();
    if (storageType === "video" || storageType === "audio" || storageType === "image") return storageType;
    return inferRefType([value.mediaType, value.type, value.kind, value.mimeType, value.url, value.name, value.label].filter(Boolean).join(" "));
}

function inferRefType(value: string): H3Ref["type"] {
    return /video|\.(mp4|webm|mov)(?:$|\?)/i.test(value) ? "video" : /audio|\.(mp3|wav|m4a|flac)(?:$|\?)/i.test(value) ? "audio" : "image";
}

export function withSegmentRefs(segment: H3Segment, refs: H3Ref[]): H3Segment {
    const next = { ...segment, ...segmentRefsPatch(refs) };
    return reconcileStoryboardTrack(segment, next);
}

function storyboardRefs(refs: H3Ref[]) {
    return refs.filter((ref) => ref.type === "image" && inferReferenceRole(ref) === "storyboard");
}

function reconcileStoryboardTrack(previous: H3Segment, next: H3Segment): H3Segment {
    const oldRefs = refsForSegment(previous).map((ref, index) => ensureReferenceIdentity(ref, index));
    const nextRefs = refsForSegment(next);
    const oldBoards = storyboardRefs(oldRefs);
    const boards = storyboardRefs(nextRefs);
    if (!boards.length) return { ...next, storyboardModeEnabled: oldBoards.length ? undefined : next.storyboardModeEnabled ?? previous.storyboardModeEnabled, storyboardDurations: {} };

    const durations: Record<string, number> = { ...(next.storyboardDurations || previous.storyboardDurations || {}) };
    const oldIds = new Set(oldBoards.map((ref) => ref.bindingId).filter((id): id is string => Boolean(id)));
    const nextIds = new Set(boards.map((ref) => ref.bindingId).filter((id): id is string => Boolean(id)));
    const validDuration = (id?: string) => id && Number.isFinite(Number(durations[id])) && Number(durations[id]) > 0 ? Number(durations[id]) : 0;

    // 旧数据没有时间分配时，先依照引用顺序平均初始化。
    if (!oldBoards.length && !Object.keys(durations).length) {
        const share = Math.max(0.5, Number(previous.duration || next.duration || 1)) / boards.length;
        for (const ref of boards) if (ref.bindingId) durations[ref.bindingId] = share;
    } else {
        // 被移除或改成普通引用的分镜时长并入相邻分镜；末张并入上一张。
        for (const [index, ref] of oldBoards.entries()) {
            const id = ref.bindingId;
            if (!id || nextIds.has(id)) continue;
            const remaining = oldBoards.slice(index + 1).find((item) => item.bindingId && nextIds.has(item.bindingId))
                || oldBoards.slice(0, index).reverse().find((item) => item.bindingId && nextIds.has(item.bindingId));
            const recipient = remaining?.bindingId;
            if (recipient) durations[recipient] = validDuration(recipient) + validDuration(id);
            delete durations[id];
        }
        // 通过角色编辑/普通 refs 添加的新分镜沿用新增入口语义，与相邻分镜平分时长。
        for (const [index, ref] of boards.entries()) {
            const id = ref.bindingId;
            if (!id || oldIds.has(id) || validDuration(id)) continue;
            const donor = boards.slice(0, index).reverse().find((item) => item.bindingId && validDuration(item.bindingId))
                || boards.slice(index + 1).find((item) => item.bindingId && validDuration(item.bindingId));
            const donorId = donor?.bindingId;
            if (donorId) {
                const half = validDuration(donorId) / 2;
                durations[donorId] = half;
                durations[id] = half;
            }
        }
        // 部分旧数据缺少绑定 ID 时，均分缺失项后再整体按比例归一。
        const missing = boards.filter((ref) => ref.bindingId && !validDuration(ref.bindingId));
        if (missing.length) {
            const assigned = boards.reduce((sum, ref) => sum + validDuration(ref.bindingId), 0);
            const remaining = Math.max(0, Number(previous.duration || next.duration || 1) - assigned);
            for (const ref of missing) if (ref.bindingId) durations[ref.bindingId] = remaining > 0 ? remaining / missing.length : 1;
        }
    }

    const normalized = Object.fromEntries(boards.flatMap((ref) => ref.bindingId ? [[ref.bindingId, validDuration(ref.bindingId) || 1]] : []));
    const sum = Object.values(normalized).reduce((value, duration) => value + duration, 0);
    const targetDuration = Math.max(0.5, Number(next.duration || previous.duration || 1));
    // IEEE-754 rounding can leave a tiny sum error after normalization. Treat
    // sub-microsecond drift as equal so the metadata-normalizing effect settles.
    const ratio = sum > 0 && Math.abs(sum - targetDuration) > 1e-6 ? targetDuration / sum : 1;
    for (const id of Object.keys(normalized)) normalized[id] *= ratio;
    return {
        ...next,
        storyboardModeEnabled: next.storyboardModeEnabled ?? previous.storyboardModeEnabled ?? true,
        storyboardDurations: normalized,
    };
}

// ---- 角色组：拖入角色资产/角色节点时建组，ref 槽里 image/audio ref 都标 groupId ----

/**
 * 用候选素材替换某个引用（画布替换 / 拖入替换）。
 * 沿用被替换引用的 bindingId：引用槽身份不变，分镜轨卡片、时长分配和提示词里的
 * <Picture N> 都留在原位，只换素材本身；候选多于 1 张时其余顺序插在原槽之后。
 * 无可用候选（例如选了已经在本 Clip 里的素材）返回原 segment，由调用方提示。
 */
export function replaceSegmentReference(segment: H3Segment, reference: H3Ref, candidates: H3Ref[]): H3Segment {
    const current = refsForSegment(segment);
    const oldIndex = current.findIndex((ref) => reference.bindingId ? ref.bindingId === reference.bindingId : sameRef(ref, reference));
    if (oldIndex < 0) return segment;
    const old = current[oldIndex];
    const base = old.groupId
        ? applyCharacterGroupEdits(segment, old.groupId, reference.type === "audio" ? { voiceEnabled: false } : { outfitEnabledById: old.outfitId ? { [old.outfitId]: false } : undefined })
        : segment;
    const baseRefs = refsForSegment(base).filter((ref) => !(old.bindingId ? ref.bindingId === old.bindingId : sameRef(ref, old)));
    const replacements = candidates
        .filter((candidate) => !baseRefs.some((ref) => sameRef(ref, candidate)))
        .map((candidate, index) => ({
            ...candidate,
            ...(index === 0 && old.bindingId ? { bindingId: old.bindingId } : {}),
            role: old.role || candidate.role,
            usage: old.usage || candidate.usage,
            retentionLevel: old.retentionLevel,
            storyboardSubjectIds: old.storyboardSubjectIds || candidate.storyboardSubjectIds,
            enabled: true,
        }))
        .filter((ref, index, all) => all.findIndex((other) => sameRef(other, ref)) === index);
    if (!replacements.length) return segment;
    const at = Math.min(oldIndex, baseRefs.length);
    return withSegmentRefs(base, [...baseRefs.slice(0, at), ...replacements, ...baseRefs.slice(at)]);
}

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
        otherImages += normalizeCharacterGroup(grp).outfitEnabled
            ? grp.outfits.filter((outfit) => outfit.enabled).length
            : 0;
        if (grp.voiceEnabled) otherAudios += 1;
    }
    // 当前 group 之外的 standalone ref（用户手动拖入的非角色 ref）也参与计数
    const standaloneRefs = refsForSegment(segment).filter((ref) => !ref.groupId);
    otherImages += standaloneRefs.filter((ref) => ref.type === "image").length;
    otherAudios += standaloneRefs.filter((ref) => ref.type === "audio").length;
    return {
        images: Math.max(0, imageLimit - otherImages),
        voice: otherAudios < audioLimit,
    };
}

function normalizeCharacterGroup(group: H3CharacterGroup): H3CharacterGroup {
    return { ...group, outfitEnabled: group.outfitEnabled ?? group.outfits.some((outfit) => outfit.enabled) };
}

function fitCharacterGroupToCapacity(segment: H3Segment, group: H3CharacterGroup): H3CharacterGroup {
    const normalized = normalizeCharacterGroup(group);
    const capacity = characterGroupCapacity(segment, normalized.id);
    let imagesLeft = capacity.images;
    return {
        ...normalized,
        outfitEnabled: normalized.outfitEnabled && normalized.outfits.length > 0 && capacity.images > 0,
        outfits: normalized.outfits.map((outfit) => {
            if (!normalized.outfitEnabled || !outfit.enabled) return outfit;
            if (imagesLeft <= 0) return { ...outfit, enabled: false };
            imagesLeft -= 1;
            return outfit;
        }),
        voiceEnabled: Boolean(normalized.voice) && normalized.voiceEnabled && capacity.voice,
    };
}

/** 从一个角色组派生当前应在 ref 槽里的 refs：每张 enabled outfit 拆为 image ref，voiceEnabled 时 voice 拆为 audio ref。 */
export function refsFromCharacterGroup(group: H3CharacterGroup): H3Ref[] {
    const refs: H3Ref[] = [];
    const normalized = normalizeCharacterGroup(group);
    const subjectId = normalized.subjectId || normalized.characterNodeId;
    for (const outfit of normalized.outfits) {
        if (!normalized.outfitEnabled || !outfit.enabled) continue;
        refs.push({
            url: outfit.url,
            type: "image",
            name: `${group.characterName} · ${outfit.name}`,
            storageKey: outfit.storageKey,
            mimeType: outfit.mimeType,
            nodeId: group.characterNodeId,
            role: outfit.role || "character_turnaround",
            subjectId,
            groupId: group.id,
            outfitId: outfit.id,
        });
    }
    if (normalized.voiceEnabled && normalized.voice?.url) {
        refs.push({
            url: normalized.voice.url,
            type: "audio",
            name: normalized.voice.name || `${normalized.characterName} · 声线`,
            storageKey: normalized.voice.storageKey,
            role: "character_voice",
            nodeId: normalized.characterNodeId,
            subjectId,
            groupId: normalized.id,
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
            // 服装总开关或逐套 enabled 任一关闭都移除图片 ref；声线只由 voiceEnabled 决定。
            const group = groups[ref.groupId];
            const matchingOutfit = group.outfits.find((outfit) => outfit.id === ref.outfitId);
            const isAudioRef = ref.type === "audio";
            const stillEnabled = isAudioRef
                ? Boolean(group.voiceEnabled) && Boolean(group.voice?.url)
                : Boolean(normalizeCharacterGroup(group).outfitEnabled) && Boolean(matchingOutfit?.enabled);
            const sourceRef = refsFromCharacterGroup(group).find((item) => isAudioRef
                ? item.type === "audio"
                : item.type === ref.type && item.outfitId === ref.outfitId);
            if (stillEnabled && sourceRef) fromGroups.push({ ...ref, ...sourceRef, bindingId: ref.bindingId, assetId: ref.assetId, order: ref.order, retentionLevel: ref.retentionLevel });
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

type CharacterOutfitInput = { url: string; name: string; storageKey?: string; mimeType?: string; role?: H3ReferenceRole };

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
    /** 角色主图索引（来自 character 节点 metadata.characterPrimaryIndex）。
     * 新建（无 existing）且未传 selectedOutfitKeys 时，自动按主图作为唯一启用服装。
     * 存量 group 的 enabled 状态完全不动。 */
    characterPrimaryIndex?: number;
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
            role: item.role || previous?.role || "character_turnaround",
            enabled: selected ?? previous?.enabled ?? true,
        };
    });
}

/** 登记一个角色组：outfits 是完整源目录，selectedOutfitKeys 只修改当前 Clip 的启用状态。
 * 新建（无 existing）且未传 selectedOutfitKeys 时，如果带 characterPrimaryIndex，则按主图作为唯一启用服装；
 * 否则保持原行为：所有 outfit 都 enabled（存量选过的都传 selectedOutfitKeys）。 */
export function upsertCharacterGroup(segment: H3Segment, input: UpsertCharacterGroupInput): H3Segment {
    if (!input.characterNodeId) throw new Error("角色组必须绑定已有 characterNodeId");
    if (!input.outfits.length && !input.voice) throw new Error(`角色 ${input.characterName || input.characterNodeId} 缺少服装目录和声线`);
    const existing = findCharacterGroupBySource(segment, input);
    const groups = { ...(segment.h3CharacterGroups || {}) };
    // 新建路径：未传 selectedOutfitKeys 时按主图默认只勾一套服装（characterPrimaryIndex）。
    const isCreating = !existing;
    const selectionExplicit = Array.isArray(input.selectedOutfitKeys);
    let nextSelectedOutfitKeys = input.selectedOutfitKeys;
    if (isCreating && !selectionExplicit && Number.isFinite(input.characterPrimaryIndex)) {
        const idx = Math.min(Math.max(Math.floor(input.characterPrimaryIndex!), 0), Math.max(input.outfits.length - 1, 0));
        const primaryOutfit = input.outfits[idx];
        if (primaryOutfit) {
            const key = outfitKey(primaryOutfit);
            if (key) nextSelectedOutfitKeys = [key];
        }
    }
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
            outfitEnabled: nextOutfits.length > 0 && (existing.outfitEnabled ?? nextOutfits.some((outfit) => outfit.enabled)),
            voiceEnabled: nextVoice ? (existing.voice ? existing.voiceEnabled : (input.defaultVoiceEnabled ?? true)) : false,
        });
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
        outfits: mergeOutfitCatalog([], input.outfits, nextSelectedOutfitKeys),
        outfitEnabled: input.outfits.length > 0 && (nextSelectedOutfitKeys
            ? nextSelectedOutfitKeys.some((key) => input.outfits.some((outfit) => outfitKey(outfit) === key))
            : Number.isFinite(input.characterPrimaryIndex)
                ? input.outfits.some((_, index) => index === Math.floor(input.characterPrimaryIndex!))
                : true),
        voiceEnabled: input.voice ? (input.defaultVoiceEnabled ?? true) : false,
    });
    groups[id] = nextGroup;
    return setSegmentCharacterGroups(segment, groups);
}

/** 用源角色节点的完整目录刷新已绑定角色组，保留仍存在服装的选择状态和稳定 ID。 */
export function syncCharacterGroupFromSource(
    segment: H3Segment,
    groupId: string,
    source: { characterName: string; characterAssetId?: string; characterNodeId: string; outfits: CharacterOutfitInput[]; voice?: H3CharacterVoice },
): H3Segment {
    const existing = segment.h3CharacterGroups?.[groupId];
    if (!existing || existing.characterNodeId !== source.characterNodeId) return segment;
    if (!source.outfits.length && !source.voice) return removeCharacterGroup(segment, groupId);

    const previousByKey = new Map(existing.outfits.map((outfit) => [outfitKey(outfit), outfit]));
    const outfits = source.outfits.map((outfit) => {
        const previous = previousByKey.get(outfitKey(outfit));
        return {
            id: previous?.id || genOutfitId(),
            ...outfit,
            enabled: previous?.enabled ?? true,
        };
    });
    const voice = source.voice;
    const nextGroup = fitCharacterGroupToCapacity(segment, {
        ...existing,
        characterName: source.characterName || existing.characterName,
        characterAssetId: source.characterAssetId || existing.characterAssetId,
        characterNodeId: source.characterNodeId,
        subjectId: existing.subjectId || source.characterNodeId,
        voice,
        outfits,
        outfitEnabled: outfits.length > 0 && (existing.outfitEnabled ?? outfits.some((outfit) => outfit.enabled)),
        voiceEnabled: voice ? (existing.voice ? existing.voiceEnabled : true) : false,
    });
    const sameOutfits = existing.outfits.length === nextGroup.outfits.length && existing.outfits.every((outfit, index) => {
        const next = nextGroup.outfits[index];
        return outfit.id === next.id && outfit.url === next.url && outfit.name === next.name
            && outfit.storageKey === next.storageKey && outfit.mimeType === next.mimeType && outfit.role === next.role && outfit.enabled === next.enabled;
    });
    if (existing.characterName === nextGroup.characterName
        && existing.characterAssetId === nextGroup.characterAssetId
        && existing.characterNodeId === nextGroup.characterNodeId
        && existing.subjectId === nextGroup.subjectId
        && JSON.stringify(existing.voice) === JSON.stringify(nextGroup.voice)
        && existing.outfitEnabled === nextGroup.outfitEnabled
        && existing.voiceEnabled === nextGroup.voiceEnabled
        && sameOutfits) return segment;

    return setSegmentCharacterGroups(segment, { ...(segment.h3CharacterGroups || {}), [groupId]: nextGroup });
}

export function removeCharacterGroup(segment: H3Segment, groupId: string): H3Segment {
    const groups = { ...(segment.h3CharacterGroups || {}) };
    if (!groups[groupId]) return segment;
    delete groups[groupId];
    return setSegmentCharacterGroups(segment, groups);
}

/** 在 modal 里编辑后整体写回：outfit.enabled 与 voiceEnabled 变更。 */
export function applyCharacterGroupEdits(segment: H3Segment, groupId: string, patch: H3CharacterGroupEditPatch): H3Segment {
    const group = segment.h3CharacterGroups?.[groupId];
    if (!group) return segment;
    const outfitEnabled = patch.outfitEnabled ?? (patch.outfitEnabledById
        ? group.outfits.some((outfit) => patch.outfitEnabledById?.[outfit.id] ?? outfit.enabled)
        : group.outfitEnabled);
    const nextGroup = fitCharacterGroupToCapacity(segment, {
        ...group,
        outfits: patch.outfitEnabledById ? group.outfits.map((outfit) => ({
            ...outfit,
            enabled: patch.outfitEnabledById?.[outfit.id] ?? outfit.enabled,
        })) : group.outfits,
        outfitEnabled: group.outfits.length > 0 && outfitEnabled,
        voiceEnabled: patch.voiceEnabled ?? group.voiceEnabled,
    });
    // 服装与声线是两个独立参考：全部关闭服装也不能删除角色组或声线。
    if (!nextGroup.voiceEnabled && !nextGroup.outfitEnabled) {
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
