import { validateH3CharacterGroups } from "./character-reference-contract.js";
export { productionImageInput, type ProductionImageInput, type ProductionImageReference } from "./production-image-input.js";
export { characterImageKey, resolveCharacterImageKeys, characterReferenceUpdates, h3CharacterSourceFromNode, syncH3CharacterGroupSource, type CharacterImageSelection, type H3CharacterSource } from "./character-image-selection.js";

import { applyReferenceOrder, orderReferencesForSubmission, remapPictureTags } from "./storyboard-reference-order.js";

export const REFERENCE_ROLES = [
    "character_identity", "character_turnaround", "scene", "blocking", "storyboard",
    "keyframe", "motion_reference", "audio_reference", "character_voice", "style",
    "palette", "prop", "other",
] as const;

export type ReferenceRole = (typeof REFERENCE_ROLES)[number];
export type ReferenceMediaType = "image" | "video" | "audio";
export type ReferenceUsage = "reference" | "first_frame" | "last_frame";
export type ReferenceRetention = "fully_preserved" | "partially_preserved" | "attribute_transfer" | "weak_reference";
export type NodeImageSelectionPolicy = { mode: "node_selection" } | { mode: "latest_success" } | { mode: "selected_result"; resultId: string };

export type ProjectReferenceAsset = {
    id: string;
    label: string;
    mediaType: ReferenceMediaType;
    role: ReferenceRole;
    tags: string[];
    url?: string;
    storageKey?: string;
    mimeType?: string;
    sourceNodeId?: string;
    subjectId?: string;
    analysis?: { summary?: string; suggestedRole?: ReferenceRole; suggestedTags?: string[]; model?: string; updatedAt?: string };
    createdAt?: string;
    updatedAt?: string;
};

/**
 * Clip 只保存对项目参考资产的稳定绑定。媒体字段是离线展示快照；提交时优先使用
 * project.referenceCatalog 中同 assetId 的资产，避免 UI 和 MCP 各自拼一套输入。
 */
export type ReferenceBinding = {
    id: string;
    assetId: string;
    label: string;
    role: ReferenceRole;
    tags: string[];
    enabled: boolean;
    usage: ReferenceUsage;
    retentionLevel?: ReferenceRetention;
    subjectId?: string;
    storyboardSubjectIds?: string[];
    mediaType?: ReferenceMediaType;
    url?: string;
    storageKey?: string;
    mimeType?: string;
    sourceNodeId?: string;
    /** Stable link to the formal Subject picture binding that produced this H3 reference. */
    pictureBindingId?: string;
    /** Formal Subject picture purposes, preserved independently of the generic H3 role. */
    picturePurpose?: string[];
    groupId?: string;
    outfitId?: string;
    resultSelectionPolicy?: NodeImageSelectionPolicy;
};

export type ReferenceIssue = { severity: "error" | "warning"; code: string; message: string; bindingId?: string };
export type CompiledReference = ReferenceBinding & { mediaType: ReferenceMediaType; ordinal: number; token: string };
export type ReferenceCompilation = {
    semanticPrompt: string;
    compiledPrompt: string;
    bindings: ReferenceBinding[];
    references: CompiledReference[];
    issues: ReferenceIssue[];
    migratedLegacyRefs: boolean;
};

export function normalizeReferenceRole(value: unknown, fallback: ReferenceRole = "other"): ReferenceRole {
    if (value === "identity" || value === "character") return "character_identity";
    return REFERENCE_ROLES.includes(value as ReferenceRole) ? value as ReferenceRole : fallback;
}

export function inferReferenceRole(value: { name?: unknown; label?: unknown; role?: unknown; type?: unknown; mimeType?: unknown }): ReferenceRole {
    const explicit = normalizeReferenceRole(value.role, "other");
    if (explicit !== "other") return explicit;
    const text = `${String(value.name || value.label || "")} ${String(value.type || "")} ${String(value.mimeType || "")}`.toLowerCase();
    if (/色卡|调色|palette|color card/.test(text)) return "palette";
    if (/站位|轴线|blocking|position/.test(text)) return "blocking";
    if (/四视图|三视图|turnaround|character sheet/.test(text)) return "character_turnaround";
    if (/人物|角色|定妆|形象|identity|portrait/.test(text)) return "character_identity";
    if (/分镜|关键帧|storyboard|shot|frame/.test(text)) return "storyboard";
    if (/场景|环境|scene|room|interior|exterior/.test(text)) return "scene";
    if (/动作|运动|motion/.test(text)) return "motion_reference";
    if (/声线|配音|voice/.test(text)) return "character_voice";
    if (/音频|音乐|audio|music|sound/.test(text)) return "audio_reference";
    if (/风格|style|look/.test(text)) return "style";
    if (/道具|prop|ticket|phone/.test(text)) return "prop";
    return "other";
}

export function inferReferenceMediaType(value: { mediaType?: unknown; type?: unknown; kind?: unknown; mimeType?: unknown; url?: unknown; name?: unknown; storageKey?: unknown }): ReferenceMediaType {
    const storageType = /^(image|video|audio):/i.exec(String(value.storageKey || ""))?.[1]?.toLowerCase();
    if (storageType === "video" || storageType === "audio" || storageType === "image") return storageType;
    const explicit = String(value.mediaType || value.type || value.kind || "").toLowerCase();
    if (explicit.includes("video")) return "video";
    if (explicit.includes("audio")) return "audio";
    const text = `${String(value.mimeType || "")} ${String(value.url || "")} ${String(value.name || "")}`.toLowerCase();
    if (/video|\.(mp4|webm|mov)(?:$|\?)/.test(text)) return "video";
    if (/audio|\.(mp3|wav|m4a|flac)(?:$|\?)/.test(text)) return "audio";
    return "image";
}

export function stableReferenceId(prefix: "asset" | "binding", value: string, index = 0) {
    let hash = 2166136261;
    for (const char of `${value}:${index}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `${prefix}-${(hash >>> 0).toString(36)}`;
}

export function referenceCatalogOf(project: Record<string, unknown>): ProjectReferenceAsset[] {
    return Array.isArray(project.referenceCatalog) ? project.referenceCatalog.map(normalizeAsset).filter(Boolean) as ProjectReferenceAsset[] : [];
}

export function referenceBindingsOf(segment: Record<string, unknown>): { bindings: ReferenceBinding[]; migratedLegacyRefs: boolean } {
    if (Array.isArray(segment.referenceBindings)) {
        return { bindings: segment.referenceBindings.map(normalizeBinding).filter(Boolean) as ReferenceBinding[], migratedLegacyRefs: false };
    }
    const refsRecord = recordOf(segment.refs);
    const buckets = ["image", "video", "audio"].flatMap((type) => {
        const value = refsRecord[type];
        return (Array.isArray(value) ? value : value ? [value] : []).map((item) => ({ ...recordOf(item), type }));
    });
    const refs = Array.isArray(segment.refItems) && segment.refItems.length ? segment.refItems : buckets;
    const bindings = refs.map((raw, index) => {
        const ref = recordOf(raw);
        const mediaType = inferReferenceMediaType(ref);
        const identity = String(ref.storageKey || ref.url || ref.nodeId || ref.name || index);
        const role = inferReferenceRole(ref);
        return normalizeBinding({
            id: String(ref.bindingId || stableReferenceId("binding", identity, index)),
            assetId: String(ref.assetId || stableReferenceId("asset", identity)),
            label: String(ref.name || `参考 ${index + 1}`), role, tags: Array.isArray(ref.tags) ? ref.tags : [], enabled: ref.enabled !== false,
            usage: ref.usage || "reference", retentionLevel: ref.retentionLevel, subjectId: ref.subjectId, storyboardSubjectIds: Array.isArray(ref.storyboardSubjectIds) ? ref.storyboardSubjectIds.map(String) : undefined, mediaType, url: ref.url, storageKey: ref.storageKey,
            mimeType: ref.mimeType, sourceNodeId: ref.nodeId,
        });
    }).filter(Boolean) as ReferenceBinding[];
    return { bindings, migratedLegacyRefs: bindings.length > 0 };
}

/**
 * 角色组的参考绑定是 `h3CharacterGroups` 的派生视图，不是独立数据。
 *
 * 历史实现把派生副本写进 segment.referenceBindings，任何整组替换 bindings 的工具都必须
 * 手工重建它们，否则预检报 character_group_binding_count / character_group_binding_source_mismatch。
 * 现在改成：编译器每次从角色组本体现场派生，写入端只负责把 h3CharacterGroups 改对。
 * 存量 segment 里已有的派生行保留作为 UI 可读快照，但不再参与正确性判断。
 */
export function characterGroupBindings(group: Record<string, unknown>): ReferenceBinding[] {
    const groupId = String(group.id || "");
    const characterNodeId = String(group.characterNodeId || "").trim();
    const characterName = String(group.characterName || "角色");
    const subjectId = String(group.subjectId || "").trim() || characterNodeId;
    if (!groupId || !characterNodeId || !subjectId) return [];
    const outfitRows = group.outfitEnabled !== false && Array.isArray(group.outfits) ? group.outfits : [];
    const refs: ReferenceBinding[] = outfitRows.filter((row) => recordOf(row).enabled !== false).map((row, index) => {
        const outfit = recordOf(row);
        const outfitKey = String(outfit.id || "");
        const url = String(outfit.url || "");
        const key = String(outfit.storageKey || url);
        if (!outfitKey || !key) return null;
        return {
            id: stableReferenceId("binding", `${groupId}:${outfitKey}`, index),
            assetId: stableReferenceId("asset", `${characterNodeId}:${key}`),
            label: `${characterName} · ${String(outfit.name || "outfit")}`,
            role: inferReferenceRole(outfit),
            tags: ["character-group", String(outfit.role || "character_turnaround"), ...(Array.isArray(outfit.picturePurpose) ? outfit.picturePurpose.map(String) : [])],
            ...(Array.isArray(outfit.picturePurpose) && outfit.picturePurpose.length ? { picturePurpose: outfit.picturePurpose.map(String) } : {}),
            enabled: true,
            usage: "reference",
            subjectId,
            mediaType: "image",
            url,
            storageKey: String(outfit.storageKey || "") || undefined,
            mimeType: String(outfit.mimeType || "") || undefined,
            sourceNodeId: characterNodeId,
            groupId,
            outfitId: outfitKey,
        } as ReferenceBinding;
    }).filter(Boolean) as ReferenceBinding[];
    const voice = recordOf(group.voice);
    if (group.voiceEnabled === true && String(voice.url || "")) {
        refs.push({
            id: stableReferenceId("binding", `${groupId}:voice`),
            assetId: String(voice.assetId || "") || stableReferenceId("asset", `${characterNodeId}:voice`),
            label: `${characterName} · ${String(voice.name || "声线")}`,
            role: "character_voice",
            tags: ["character-group"],
            enabled: true,
            usage: "reference",
            subjectId,
            mediaType: "audio",
            url: String(voice.url),
            storageKey: String(voice.storageKey || "") || undefined,
            sourceNodeId: characterNodeId,
            groupId,
        });
    }
    return refs;
}

/** Refresh group snapshots in their saved slots so existing Picture/Audio numbers keep their meaning. */
export function resolveCharacterGroupBindings(bindings: ReferenceBinding[], segment: Record<string, unknown>) {
    const groups = recordOf(segment.h3CharacterGroups);
    const derived = Object.values(groups).flatMap((raw) => characterGroupBindings(recordOf(raw)));
    const derivedIds = new Set(derived.map((binding) => binding.id));
    const used = new Set<string>();
    const ordered = bindings.flatMap((binding) => {
        if (!binding.groupId) return derivedIds.has(binding.id) ? [] : [binding];
        // Legacy IDs may differ from today's derived IDs; the group/outfit identifies the slot.
        const current = derived.find((item) => item.groupId === binding.groupId
            && item.outfitId === binding.outfitId
            && item.mediaType === (binding.mediaType || inferReferenceMediaType(binding)));
        if (!current || used.has(current.id)) return [];
        used.add(current.id);
        return [current];
    });
    return applyReferenceOrder([...ordered, ...derived.filter((binding) => !used.has(binding.id))], segment.referenceOrder,
        (binding) => binding.id);
}

export function compileReferenceSubmission(project: Record<string, unknown>, segment: Record<string, unknown>): ReferenceCompilation {
    const catalog = new Map(referenceCatalogOf(project).map((asset) => [asset.id, asset]));
    const { bindings: rawBindings, migratedLegacyRefs } = referenceBindingsOf(segment);
    const originalBindings = resolveCharacterGroupBindings(rawBindings, segment);
    const shotIds = (Array.isArray(segment.storyboardShots) ? segment.storyboardShots : [])
        .map((shot) => String(recordOf(shot).referenceBindingId || "")).filter(Boolean);
    const bindings = orderReferencesForSubmission(originalBindings, shotIds,
        (binding) => binding.id,
        (binding) => binding.enabled && binding.role === "storyboard" && (binding.mediaType || inferReferenceMediaType(binding)) === "image",
        (binding) => binding.enabled
        && binding.role !== "storyboard"
        && (binding.mediaType || inferReferenceMediaType(binding)) === "image"
        && Boolean(binding.subjectId || binding.groupId), segment.referenceOrder);
    const issues: ReferenceIssue[] = [...validateH3CharacterGroups(project, { ...segment, referenceBindings: bindings })];
    const counters: Record<ReferenceMediaType, number> = { image: 0, video: 0, audio: 0 };
    const references = bindings.filter((binding) => binding.enabled).flatMap((binding): CompiledReference[] => {
        const asset = catalog.get(binding.assetId);
        const sourceMedia = sourceMediaOf(project, { ...binding, sourceNodeId: binding.sourceNodeId || asset?.sourceNodeId });
        if (sourceMedia.selectionError) issues.push({ severity: "error", code: "source_result_unavailable", bindingId: binding.id, message: String(sourceMedia.selectionError) });
        const { selectionError: _selectionError, ...resolvedSourceMedia } = sourceMedia;
        const merged = {
            ...binding,
            ...(asset || {}),
            ...resolvedSourceMedia,
            id: binding.id,
            assetId: binding.assetId,
            enabled: binding.enabled,
            usage: binding.usage,
            role: binding.role,
            label: binding.label,
            tags: binding.tags,
            subjectId: binding.subjectId,
            sourceNodeId: binding.sourceNodeId || asset?.sourceNodeId,
        } as ReferenceBinding & ProjectReferenceAsset;
        const mediaType = inferReferenceMediaType(merged);
        if (!merged.storageKey && !merged.url) {
            issues.push({ severity: "error", code: "reference_media_missing", bindingId: binding.id, message: `参考“${binding.label}”没有可用媒体` });
            return [];
        }
        if (!asset && binding.assetId) issues.push({ severity: "warning", code: "catalog_asset_missing", bindingId: binding.id, message: `参考“${binding.label}”尚未登记到项目参考库，将使用绑定快照` });
        if (binding.role === "palette") issues.push({ severity: "warning", code: "palette_as_runtime_reference", bindingId: binding.id, message: `“${binding.label}”是色卡；仅在模型确实需要图像色彩锚点时保留` });
        const ordinal = ++counters[mediaType];
        const token = mediaType === "image" ? `<Picture ${ordinal}>` : mediaType === "video" ? `<Video ${ordinal}>` : `<Audio ${ordinal}>`;
        return [{ ...merged, mediaType, ordinal, token }];
    });
    const semanticPrompt = String(segment.prompt || "");
    const bySubjectId = new Map<string, { reference: CompiledReference; ordinal: number }>();
    let nextSubjectOrdinal = 1;
    const registerSubject = (reference: CompiledReference, ids: Array<string | undefined>) => {
        const aliases = [...new Set(ids.filter((id): id is string => Boolean(id)))];
        const existing = aliases.map((id) => bySubjectId.get(id)).find(Boolean);
        const subject = existing || { reference, ordinal: nextSubjectOrdinal++ };
        aliases.forEach((id) => { if (!bySubjectId.has(id)) bySubjectId.set(id, subject); });
    };
    // Assign character/subject IDs first, independently of the image order. Storyboard
    // images can appear before character refs in the input list but must not push
    // `<Subject 1>` to `<Subject 4>`; their `<Picture N>` numbers remain unchanged.
    references.filter((reference) => reference.mediaType === "image" && (reference.subjectId || reference.groupId)).forEach((reference) => {
        registerSubject(reference, [reference.subjectId, reference.groupId, reference.id]);
    });
    references.filter((reference) => reference.role === "storyboard").forEach((reference) => {
        (reference.storyboardSubjectIds || []).forEach((id) => {
            if (!bySubjectId.has(id)) registerSubject(reference, [id]);
        });
    });
    // Structured production prompts already name storyboard frames by their local Shot
    // and entity pictures by Subject. Those declarations are the stable binding map; do
    // not reinterpret their Picture numbers using a stale referenceBindings array order.
    // For legacy/free-form prompts without a complete map, retain the historical
    // binding-identity remap below.
    const pictureOrderIsExplicit = promptUsesSubmissionPictureOrder(semanticPrompt, segment, references, bySubjectId);
    const orderedPrompt = !pictureOrderIsExplicit && bindings.some((binding, index) => binding.id !== originalBindings[index]?.id)
        ? remapPictureTags(semanticPrompt, originalBindings.filter((binding) => binding.enabled), bindings.filter((binding) => binding.enabled),
            (binding) => binding.id, (binding) => (binding.mediaType || inferReferenceMediaType(binding)) === "image")
        : semanticPrompt;
    // Subject is a semantic prompt token, not a media-slot reference. It may
    // describe a character, prop, scene, object, or an entity defined elsewhere;
    // never validate it against character bindings or enabled media count.
    validatePromptReferences(semanticPrompt, references, undefined, issues);
    const compiledPrompt = orderedPrompt
        .replace(/<(subject|picture|video|audio)\s+(\d+)>/giu, (_marker, kind: string, ordinal: string) => `<${kind[0].toUpperCase()}${kind.slice(1).toLowerCase()} ${ordinal}>`)
        .replace(/(<Subject\s+\d+>)(?=[\p{L}\p{N}(])/gu, "$1 ");
    const promptWithBoundSubjects = bindLiteralSubjectsToPictures(compiledPrompt, references, bySubjectId);
    const promptWithBoundOutfits = bindOutfitReferenceDetails(promptWithBoundSubjects, project, segment, references, bySubjectId);
    validateLimits(segment, semanticPrompt, references, issues);
    return { semanticPrompt, compiledPrompt: promptWithBoundOutfits, bindings, references, issues, migratedLegacyRefs };
}

function promptUsesSubmissionPictureOrder(
    prompt: string,
    segment: Record<string, unknown>,
    references: CompiledReference[],
    bySubjectId: Map<string, { reference: CompiledReference; ordinal: number }>,
) {
    const images = references.filter((reference) => reference.mediaType === "image");
    const mapped = new Set<string>();
    const storyboardShots = Array.isArray(segment.storyboardShots) ? segment.storyboardShots.map(recordOf) : [];
    const storyboardBindings = images.filter((reference) => reference.role === "storyboard");
    if (storyboardBindings.length) {
        if (!storyboardShots.length) return false;
        for (const [index, shot] of storyboardShots.entries()) {
            const bindingId = String(shot.referenceBindingId || "");
            if (!bindingId) continue;
            const reference = storyboardBindings.find((item) => item.id === bindingId);
            if (!reference) return false;
            const shotNumber = index + 1;
            const anchor = new RegExp(`<Picture\\s+(\\d+)>[^\\n]*\\[Shot\\s+${shotNumber}\\]`, "i").exec(prompt);
            if (!anchor || Number(anchor[1]) !== reference.ordinal) return false;
            mapped.add(reference.id);
        }
        if (storyboardBindings.some((reference) => !mapped.has(reference.id))) return false;
    }

    const sourceByOrdinal = new Map<number, { reference: CompiledReference; ordinal: number }>();
    for (const source of bySubjectId.values()) sourceByOrdinal.set(source.ordinal, source);
    const subjectSection = /(^subject_definitions\s*[:：]\s*\r?\n)([\s\S]*?)(?=^\s*(?:summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music|storyboard_timeline)\s*[:：]|$(?![\s\S]))/im.exec(prompt);
    const subjectLines = subjectSection ? [...subjectSection[2].matchAll(/<Subject\s+(\d+)>[^\r\n]*/g)] : [];
    if (!subjectLines.length) return false;
    const subjectReferenceIds = new Set([...bySubjectId.values()].map((source) => source.reference.id));
    const explicitlyUsedPictures = new Set<number>();
    for (const match of subjectLines) {
        const source = sourceByOrdinal.get(Number(match[1]));
        const pictureNumbers = [...new Set([...match[0].matchAll(/<Picture\s+(\d+)>/gi)].map((picture) => Number(picture[1])))];
        if (!pictureNumbers.length) return false;
        for (const pictureNumber of pictureNumbers) {
            if (!Number.isSafeInteger(pictureNumber) || explicitlyUsedPictures.has(pictureNumber)) return false;
            explicitlyUsedPictures.add(pictureNumber);
            if (source) {
                // A bound Subject explicitly names the same Picture slot that its
                // stable subject binding occupies in the final submission order.
                // In that case an older persisted referenceOrder must not rebase it.
                const reference = source.reference;
                const candidate = images[pictureNumber - 1];
                if (!candidate || !(candidate.id === reference.id
                    || (reference.subjectId && candidate.subjectId === reference.subjectId)
                    || (reference.groupId && candidate.groupId === reference.groupId))) return false;
                for (const candidate of images) {
                    if (candidate.id === reference.id || (reference.subjectId && candidate.subjectId === reference.subjectId)
                        || (reference.groupId && candidate.groupId === reference.groupId)) mapped.add(candidate.id);
                }
            } else {
                // Non-entity references such as an environment image can be
                // explicitly assigned to their final Picture slot as well.
                const reference = images[pictureNumber - 1];
                if (!reference || subjectReferenceIds.has(reference.id) || reference.role === "storyboard") return false;
                mapped.add(reference.id);
            }
        }
    }

    return images.length > 0 && images.every((reference) => mapped.has(reference.id));
}

function sourceMediaOf(project: Record<string, unknown>, binding: ReferenceBinding) {
    if (!binding.sourceNodeId) return {};
    const nodes = Array.isArray(project.nodes) ? project.nodes as Array<Record<string, unknown>> : [];
    const node = nodes.find((item) => String(item.id || "") === binding.sourceNodeId);
    if (!node) return {};
    const metadata = recordOf(node.metadata);
    let media = metadata;
    if (node.type === "scene") media = recordOf(metadata.sceneImage);
    else if (node.type === "config" && metadata.smart === true && (metadata.generationMode || "image") === "image") {
        const selected = selectSmartImageResult(metadata, binding.resultSelectionPolicy);
        if (selected.error) return { selectionError: selected.error };
        media = selected.image || metadata;
    } else if (node.type === "character") return {};
    const storageKey = String(media.storageKey || recordOf(media.assetRef).storageKey || "");
    const url = String(media.content || media.url || media.localUrl || media.sourceUrl || "");
    if (!storageKey && !url) return {};
    return { ...(storageKey ? { storageKey } : {}), ...(url ? { url } : {}), ...(media.mimeType ? { mimeType: String(media.mimeType) } : {}) };
}

function bindOutfitReferenceDetails(
    prompt: string,
    project: Record<string, unknown>,
    segment: Record<string, unknown>,
    references: CompiledReference[],
    bySubjectId: Map<string, { reference: CompiledReference; ordinal: number }>,
) {
    const groups = Object.values(recordOf(segment.h3CharacterGroups));
    const nodes = Array.isArray(project.nodes) ? project.nodes.map(recordOf) : [];
    const additions = new Map<number, Array<{ token: string; instruction: string }>>();
    for (const reference of references) {
        if (reference.mediaType !== "image" || !reference.outfitId) continue;
        const group = groups.map(recordOf).find((item) =>
            String(item.id || "") === String(reference.groupId || "")
            || String(item.subjectId || "") === String(reference.subjectId || "")
            || String(item.characterNodeId || "") === String(reference.sourceNodeId || ""));
        if (!group) continue;
        const subject = [reference.subjectId, reference.groupId, reference.id]
            .map((id) => id ? bySubjectId.get(id) : undefined)
            .find(Boolean);
        if (!subject) continue;
        const outfits = Array.isArray(group.outfits) ? group.outfits.map(recordOf) : [];
        const outfit = outfits.find((item) => String(item.id || "") === reference.outfitId);
        if (!outfit || outfit.enabled === false) continue;
        const characterNodeId = String(group.characterNodeId || reference.sourceNodeId || "");
        const characterNode = nodes.find((item) => String(item.id || "") === characterNodeId);
        const metadata = recordOf(characterNode?.metadata);
        const images = Array.isArray(metadata.characterImages) ? metadata.characterImages.map(recordOf) : [];
        const outfitImage = images.find((item) => String(item.storageKey || "") === String(reference.storageKey || ""))
            || images.find((item) => String(item.outfit || item.name || "") === String(outfit.name || ""));
        const description = String(outfitImage?.outfitDescription || outfit.outfitDescription || outfit.description || "").trim();
        const purposes = [...(Array.isArray(reference.picturePurpose) ? reference.picturePurpose : []), ...(Array.isArray(outfit.picturePurpose) ? outfit.picturePurpose : [])].map(String);
        // A character image can be present in the outfit group while serving only as
        // the identity reference. Add wardrobe instructions only when that role is
        // explicit or the user supplied an outfit description for this image.
        if (purposes.length && !purposes.includes("wardrobe")) continue;
        if (!purposes.includes("wardrobe") && !description) continue;
        const instruction = description
            ? `Authored outfit description: ${description}. Match these details and the exact visible design; do not substitute or redesign it.`
            : "This is the exact outfit reference for this Subject. Reproduce its visible clothing design without substitution, simplification, or invented details.";
        const items = additions.get(subject.ordinal) || [];
        items.push({ token: reference.token, instruction });
        additions.set(subject.ordinal, items);
    }
    if (!additions.size) return prompt;
    const sectionPattern = /(^subject_definitions\s*[:：]\s*\r?\n)([\s\S]*?)(?=^\s*(?:summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music|storyboard_timeline)\s*[:：]|$(?![\s\S]))/im;
    const section = sectionPattern.exec(prompt);
    if (!section) return prompt;
    const linkedSection = section[2].replace(/<Subject\s+(\d+)>[^\r\n]*/g, (line, ordinalText: string) => {
        const items = additions.get(Number(ordinalText));
        if (!items?.length) return line;
        const missing = items.filter(({ token }) => !line.includes(token));
        if (missing.length) return line;
        const detail = items.map(({ instruction }) => instruction).join(" ");
        return `${line.trimEnd().replace(/[.。]+$/u, "")}; ${detail}`;
    });
    return `${prompt.slice(0, section.index)}${section[1]}${linkedSection}${prompt.slice(section.index + section[0].length)}`;
}

/** Resolve one image for a formal binding. Existing clips retain their legacy primary-image rule. */
export function selectSmartImageResult(metadataValue: unknown, policy?: NodeImageSelectionPolicy) {
    const metadata = recordOf(metadataValue);
    let implicitPrimarySelection = false;
    if (policy?.mode === "node_selection") {
        const nodePolicy = recordOf(metadata.smartImageReferenceSelection);
        if (nodePolicy.mode === "selected_result" && typeof nodePolicy.resultId === "string" && nodePolicy.resultId) policy = { mode: "selected_result", resultId: nodePolicy.resultId };
        else if (nodePolicy.mode === undefined) {
            const primaryImageId = String(metadata.primaryImageId || "");
            if (primaryImageId) {
                policy = { mode: "selected_result", resultId: primaryImageId };
                implicitPrimarySelection = true;
            }
            else {
                policy = { mode: "selected_result", resultId: "" };
                implicitPrimarySelection = true;
            }
        } else if (nodePolicy.mode === "latest_success") policy = { mode: "latest_success" };
        else return { error: "智能节点的引用选择策略无效；不会回退到浏览中的图片。" };
    }
    const images = Array.isArray(metadata.images) ? metadata.images.map(recordOf) : [];
    // 只把真正可引用的结果算作 candidate：失败/运行中的槽位即使带 storageKey 也不能被引用。
    // 没有写 status 的条目是历史画布上的已完成结果，按契约继续可用。
    const completed = (item: Record<string, unknown>) => Boolean(item.storageKey) && (item.status === undefined || item.status === "success");
    if (policy?.mode === "latest_success") {
        const image = images.map((item, index) => ({ item, index })).filter(entry => completed(entry.item)).sort((left, right) => {
            const leftSequence = Number.isSafeInteger(Number(left.item.generationTaskSequence)) ? Number(left.item.generationTaskSequence) : undefined;
            const rightSequence = Number.isSafeInteger(Number(right.item.generationTaskSequence)) ? Number(right.item.generationTaskSequence) : undefined;
            if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) return leftSequence - rightSequence;
            if (leftSequence !== undefined && rightSequence === undefined) return 1;
            if (leftSequence === undefined && rightSequence !== undefined) return -1;
            const leftTime = String(left.item.generationTaskCreatedAt || ""), rightTime = String(right.item.generationTaskCreatedAt || "");
            if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
            const leftOutput = Number.isSafeInteger(Number(left.item.generationOutputIndex)) ? Number(left.item.generationOutputIndex) : left.index;
            const rightOutput = Number.isSafeInteger(Number(right.item.generationOutputIndex)) ? Number(right.item.generationOutputIndex) : right.index;
            return leftOutput - rightOutput || left.index - right.index;
        }).at(-1)?.item;
        return image ? { image } : { error: "智能节点没有成功归档的图片结果；不会引用运行中、失败或占位图片。" };
    }
    if (policy?.mode === "selected_result") {
        const image = images.find(item => item.id === policy.resultId && completed(item));
        if (!image && implicitPrimarySelection) {
            const firstAvailable = images.find(completed);
            return firstAvailable ? { image: firstAvailable } : { error: "智能节点没有成功归档的图片结果；不会引用运行中、失败或占位图片。" };
        }
        return image ? { image } : { error: `选定历史结果 ${policy.resultId} 不存在、未成功或未归档。` };
    }
    const legacy = images.find(item => item.id === metadata.primaryImageId && (item.content || item.storageKey))
        || images.find(item => item.content || item.storageKey);
    return legacy ? { image: legacy } : { image: metadata };
}

function bindLiteralSubjectsToPictures(
    prompt: string,
    references: CompiledReference[],
    bySubjectId: Map<string, { reference: CompiledReference; ordinal: number }>,
) {
    const sources = new Map<number, { ordinal: number; pictures: string[] }>();
    for (const reference of references) {
        if (reference.mediaType !== "image" || reference.role === "storyboard" || (!reference.subjectId && !reference.groupId)) continue;
        const subject = [reference.subjectId, reference.groupId, reference.id]
            .map((id) => id ? bySubjectId.get(id) : undefined)
            .find(Boolean);
        if (!subject) continue;
        const source = sources.get(subject.ordinal) || { ordinal: subject.ordinal, pictures: [] };
        if (!source.pictures.includes(reference.token)) source.pictures.push(reference.token);
        sources.set(subject.ordinal, source);
    }
    if (!sources.size) return prompt;

    const sectionPattern = /(^subject_definitions\s*[:：]\s*\r?\n)([\s\S]*?)(?=^\s*(?:summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music|storyboard_timeline)\s*[:：]|$(?![\s\S]))/im;
    const section = sectionPattern.exec(prompt);
    if (!section) return prompt;
    const labels = [...new Set([...section[2].matchAll(/<Subject\s+(\d+)>/g)].map((match) => Number(match[1])))];
    const orderedSources = [...sources.values()].sort((a, b) => a.ordinal - b.ordinal);
    const subjectMap = new Map<number, { ordinal: number; pictures: string[] }>();
    if (labels.length === orderedSources.length) {
        labels.forEach((label, index) => subjectMap.set(label, orderedSources[index]));
    } else {
        for (const source of orderedSources) {
            for (const picture of source.pictures) {
                const pictureNumber = Number(picture.match(/\d+/)?.[0]);
                if (labels.includes(pictureNumber) && !subjectMap.has(pictureNumber)) subjectMap.set(pictureNumber, source);
            }
        }
    }
    if (!subjectMap.size) return prompt;

    const linkedSection = section[2].replace(/<Subject\s+(\d+)>[^\r\n]*/g, (line, labelText: string) => {
        // An authored Picture citation owns this definition, including non-character
        // Subjects such as environments. Only fill a definition with no image anchor;
        // a partial character registry must not add a conflicting positional guess.
        if (/<Picture\s+\d+>/u.test(line)) return line;
        const source = subjectMap.get(Number(labelText));
        if (!source) return line;
        const existingPictures = new Set([...line.matchAll(/<Picture\s+(\d+)>/g)].map((match) => `<Picture ${match[1]}>`));
        const missingPictures = source.pictures.filter((picture) => !existingPictures.has(picture));
        if (!missingPictures.length) return line;
        const pictureList = missingPictures.length === 1
            ? missingPictures[0]
            : `${missingPictures.slice(0, -1).join(", ")} and ${missingPictures.at(-1)}`;
        return `${line.trimEnd().replace(/[.。]+$/u, "")} (${pictureList}).`;
    });
    // Subject labels are semantic identities, independent of Picture slot numbers.
    return `${prompt.slice(0, section.index)}${section[1]}${linkedSection}${prompt.slice(section.index + section[0].length)}`;
}

export class ReferenceCompilationError extends Error {
    readonly code = "REFERENCE_INVALID";
    readonly issues: ReferenceIssue[];
    constructor(issues: ReferenceIssue[]) {
        super(issues.map((issue) => issue.message).join("；"));
        this.name = "ReferenceCompilationError";
        this.issues = structuredClone(issues);
    }
}

export function assertReferenceCompilation(compilation: ReferenceCompilation) {
    const errors = compilation.issues.filter((issue) => issue.severity === "error");
    if (errors.length) throw new ReferenceCompilationError(errors);
}

function validatePromptReferences(prompt: string, references: CompiledReference[], subjectCount: number | undefined, issues: ReferenceIssue[]) {
    const counts = {
        subject: subjectCount,
        picture: references.filter((reference) => reference.mediaType === "image").length,
        video: references.filter((reference) => reference.mediaType === "video").length,
        audio: references.filter((reference) => reference.mediaType === "audio").length,
    };
    const reported = new Set<string>();
    for (const match of prompt.matchAll(/<(Subject|Picture|Video|Audio)\s+(\d+)>/giu)) {
        const kind = match[1].toLowerCase() as keyof typeof counts;
        const ordinal = Number(match[2]);
        if (kind === "subject") continue;
        if (ordinal > 0 && ordinal <= counts[kind]) continue;
        const key = `${kind}:${ordinal}`;
        if (reported.has(key)) continue;
        reported.add(key);
        issues.push({ severity: "error", code: "prompt_reference_missing", message: `提示词引用了不存在或未启用的 ${match[1]} ${ordinal}` });
    }
}

function validateLimits(segment: Record<string, unknown>, semanticPrompt: string, references: CompiledReference[], issues: ReferenceIssue[]) {
    const mode = String(segment.taskMode || segment.mode || "ref2va").toLowerCase();
    const images = references.filter((reference) => reference.mediaType === "image");
    const videos = references.filter((reference) => reference.mediaType === "video");
    const audios = references.filter((reference) => reference.mediaType === "audio");
    if (mode === "t2v" && references.length) issues.push({ severity: "warning", code: "t2v_ignores_references", message: "T2V 模式不会提交参考素材" });
    if (mode === "t2v" && /<(?:Subject|Picture|Video|Audio)\s+\d+>/i.test(semanticPrompt)) {
        issues.push({ severity: "error", code: "t2v_prompt_uses_reference", message: "T2V 提示词不能引用 Picture、Video、Audio 或 Subject；请改用 I2V、FL2V 或 Ref2VA" });
    }
    if (mode === "i2v" && images.length !== 1) issues.push({ severity: "error", code: "i2v_image_count", message: "I2V 必须且只能使用 1 张图片" });
    if (mode === "fl2v" && images.length !== 2) issues.push({ severity: "error", code: "fl2v_image_count", message: "FL2V 必须使用 2 张图片作为首尾帧" });
    if (images.length > 9) issues.push({ severity: "error", code: "image_limit", message: "MiniMax H3 最多支持 9 张参考图片" });
    if (videos.length > 3) issues.push({ severity: "error", code: "video_limit", message: "MiniMax H3 最多支持 3 段参考视频" });
    if (audios.length > 3) issues.push({ severity: "error", code: "audio_limit", message: "MiniMax H3 最多支持 3 段参考音频" });
}

function normalizeAsset(value: unknown): ProjectReferenceAsset | null {
    const item = recordOf(value);
    const id = String(item.id || "");
    if (!id) return null;
    return { ...item, id, label: String(item.label || item.name || id), mediaType: inferReferenceMediaType(item), role: inferReferenceRole(item), tags: Array.isArray(item.tags) ? item.tags.map(String) : [] } as ProjectReferenceAsset;
}

function normalizeBinding(value: unknown): ReferenceBinding | null {
    const item = recordOf(value);
    const id = String(item.id || item.bindingId || "");
    const assetId = String(item.assetId || "");
    if (!id || !assetId) return null;
    const rawSelection = recordOf(item.resultSelectionPolicy);
    const resultSelectionPolicy: NodeImageSelectionPolicy | undefined = rawSelection.mode === "node_selection" ? { mode: "node_selection" } : rawSelection.mode === "latest_success" ? { mode: "latest_success" }
        : rawSelection.mode === "selected_result" && typeof rawSelection.resultId === "string" && rawSelection.resultId ? { mode: "selected_result", resultId: rawSelection.resultId } : undefined;
    return {
        ...item, id, assetId, label: String(item.label || item.name || assetId), role: inferReferenceRole(item),
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [], enabled: item.enabled !== false,
        usage: ["first_frame", "last_frame"].includes(String(item.usage)) ? item.usage as ReferenceUsage : "reference",
        ...(["fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference"].includes(String(item.retentionLevel)) ? { retentionLevel: item.retentionLevel as ReferenceRetention } : {}),
        ...(item.mediaType || item.type || item.kind || item.storageKey || item.mimeType || item.url ? { mediaType: inferReferenceMediaType(item) } : {}),
        ...(resultSelectionPolicy ? { resultSelectionPolicy } : {}),
    } as ReferenceBinding;
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
