import { createHash } from "node:crypto";
import { inferReferenceMediaType, inferReferenceRole, referenceBindingsOf, referenceCatalogOf } from "../../canvas/reference-contract.js";

type RecordValue = Record<string, unknown>;
type Transition = "continuous" | "cut" | "dissolve" | "fade_black";
type StoryboardShotInput = { description: string; switchTime?: string; transitionType?: Transition; pictureBindingId?: string };
type StoryboardInput = { summary?: string; openingDescription: string; shots: StoryboardShotInput[]; overallSoundscape: string; nonDiegeticMusic: string };
type PromptSubject = { id: string; name: string; englishName?: string; aliases: string[]; shotMarkers: string[]; profile: string; outfits: string[]; pictures: string[]; role?: string };
type PromptReference = { tag: string; bindingId: string; type: "image" | "video" | "audio"; role: string; label: string; description: string; subjectId?: string; subjectIds?: string[]; subjectName?: string; speakerId?: string; usage?: string; retentionLevel?: "fully_preserved" | "partially_preserved" | "attribute_transfer" | "weak_reference"; shotNumbers: number[] };
type PromptShot = { description: string; referenceIds?: string[] };

const TRANSITIONS: Record<Transition, string> = {
    continuous: "continue the same uninterrupted shot; preserve camera movement, action, and spatial relationships without a cut or reset",
    cut: "hard cut from the preceding shot into this shot",
    dissolve: "cross-dissolve from the preceding shot into this shot",
    fade_black: "fade out from the preceding shot to black, then fade in to this shot",
};
const SECTION_END = /^(?:subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music|integrated_multimodal_description):/mi;

function record(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function string(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function promptModeOf(segment: RecordValue) {
    const mode = string(segment.mode || segment.taskMode || "ref2va");
    return ["ref2va", "t2v", "i2v", "fl2v"].includes(mode) ? mode : "ref2va";
}

function replaceSection(prompt: string, section: string, content: string, promptMode: string) {
    const header = new RegExp(`^${section}:`, "mi").exec(prompt);
    if (!header) {
        const order = promptMode === "ref2va"
            ? ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]
            : ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"];
        const nextSection = order.slice(order.indexOf(section) + 1).find((name) => new RegExp(`^${name}:`, "mi").test(prompt));
        const next = nextSection ? new RegExp(`^${nextSection}:`, "mi").exec(prompt) : null;
        const text = `${section}:\n${content}`;
        if (next) return `${prompt.slice(0, next.index).trimEnd()}\n\n${text}\n\n${prompt.slice(next.index)}`;
        return `${prompt.trimEnd()}${prompt.trim() ? "\n\n" : ""}${text}`;
    }
    const bodyStart = header.index + header[0].length;
    const remainder = prompt.slice(bodyStart);
    const next = SECTION_END.exec(remainder);
    const bodyEnd = bodyStart + (next?.index ?? remainder.length);
    const suffix = prompt.slice(bodyEnd).replace(/^(?:\r?\n)+/, "");
    return `${prompt.slice(0, header.index)}${section}:\n${content}${suffix ? "\n\n" : content ? "\n" : ""}${suffix}`;
}

function pictureDescription(ref: RecordValue, catalog: ReturnType<typeof referenceCatalogOf>) {
    const asset = catalog.find((item) => item.id === ref.assetId || Boolean(ref.storageKey && item.storageKey === ref.storageKey) || Boolean(ref.url && item.url === ref.url));
    const analysis = record(asset?.analysis);
    const refAnalysis = record(ref.analysis);
    const summary = string(analysis.summary || refAnalysis.summary);
    const tags = [...new Set([
        ...(Array.isArray(asset?.tags) ? asset.tags : []),
        ...(Array.isArray(ref.tags) ? ref.tags : []),
    ].map((tag) => String(tag).trim()).filter(Boolean))].join(", ");
    const clean = (value: string) => value
        .split(/\r?\n/u)[0]
        .replace(/\bep\d{1,3}[-_ ]s\d{1,3}[-_ ]\d{1,3}\b/giu, " ")
        .replace(/\bs\d{1,3}[-_ ]\d{1,3}\b/giu, " ")
        .replace(/\b(?:ep|episode)[-_ ]?\d+\b/giu, " ")
        .replace(/(?:storyboard|分镜图?|关键帧|参考图|图片|reference|frame|image)/giu, " ")
        .replace(/^(?:the\s+)?approved\s+/iu, "")
        .replace(/^(?:for|of|showing)\s+/iu, "")
        .replace(/[|·:：]+/gu, " ")
        .replace(/\s+/gu, " ")
        .replace(/^[\s,，.;。_-]+|[\s,，.;。_-]+$/gu, "");
    return [summary, tags, asset?.label || "", ref.name].map((value) => clean(String(value || ""))).find((value) => value && !/^(?:the|a|an|for|of)$/iu.test(value))?.slice(0, 140) || "";
}

function promptForShots(input: StoryboardInput, refs: RecordValue[], catalog: ReturnType<typeof referenceCatalogOf>) {
    const byId = new Map(refs.map((ref) => [String(ref.bindingId || ""), ref]));
    const details = input.shots.map((shot, index) => {
        const transitionType = shot.transitionType || "cut";
        if (!(transitionType in TRANSITIONS)) throw new Error(`分镜 ${index + 1} 的切换方式无效：${transitionType}`);
        const transition = index ? ` [Transition: ${TRANSITIONS[transitionType]}]` : "";
        const time = index && string(shot.switchTime) ? ` At ${string(shot.switchTime)},` : "";
        const pictureId = string(shot.pictureBindingId);
        let picture = "";
        if (pictureId) {
            const binding = byId.get(pictureId);
            if (!binding || binding.enabled === false || binding.type !== "image" || inferReferenceRole(binding) !== "storyboard" || !(binding.url || binding.storageKey)) {
                throw new Error(`分镜 ${index + 1} 绑定的分镜图不存在或不是当前 Clip 的有效分镜图：${pictureId}`);
            }
            picture = ` Use the approved ${pictureDescription(binding, catalog) || "storyboard frame"} from {{ref:${pictureId}}} as the target composition reference for this shot.`;
        }
        return `[Shot ${index + 1}]${time}${transition}${picture}${string(shot.description) ? ` ${string(shot.description)}` : ""}`;
    });
    return [string(input.openingDescription), details.join("\n")].filter(Boolean).join("\n\n");
}

function subjectAppearsInShot(subject: PromptSubject, shot: PromptShot) {
    const text = shot.description.toLocaleLowerCase();
    const names = [subject.name, subject.englishName].filter((name): name is string => typeof name === "string" && Boolean(name.trim()));
    const nameMatch = names.some((name) => {
        const normalized = name.trim().toLocaleLowerCase();
        if (/[\p{Script=Han}]/u.test(normalized)) return [...normalized].length >= 2 && text.includes(normalized);
        let offset = 0;
        while (offset < text.length) {
            const index = text.indexOf(normalized, offset);
            if (index < 0) return false;
            const before = index > 0 ? text[index - 1] : "";
            const after = text[index + normalized.length] || "";
            if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
            offset = index + normalized.length;
        }
        return false;
    });
    return (shot.referenceIds || []).some((id) => subject.shotMarkers.includes(`{{ref:${id}}}`)) ||
        subject.shotMarkers.some((marker) => text.includes(marker.toLocaleLowerCase())) ||
        [subject.id, ...subject.aliases].some((id) => text.includes(`{{subject:${id.toLocaleLowerCase()}}`)) || nameMatch;
}

function buildPromptText(subjects: PromptSubject[], references: PromptReference[], shots: PromptShot[]) {
    const subjectDefinitions = subjects.map((subject) => {
        const identity = [subject.name, subject.englishName && subject.englishName !== subject.name ? subject.englishName : ""].filter(Boolean).join(" / ");
        const details = [subject.profile, ...subject.outfits].map((value) => value.trim()).filter(Boolean);
        if (subject.pictures.length) details.unshift(`visual identity and defining features sourced from ${subject.pictures.join(", ")}`);
        if (!details.length) details.push("visual features follow the linked reference");
        return `{{subject:${subject.id}}} is ${identity || subject.id}. ${details.join("; ")}.`;
    }).join("\n");

    const isPictureAnchor = (reference: PromptReference) => reference.type === "image" && (
        reference.usage === "first_frame" || reference.usage === "last_frame" ||
        reference.role === "storyboard" || (reference.role === "keyframe" && reference.shotNumbers.length > 0)
    );
    const trackedReferences = references.filter((reference) => reference.type !== "image" || isPictureAnchor(reference));
    const referenceDefinitions = trackedReferences.map((reference) => {
        const mappedSubjects = ((reference.subjectIds?.length ? reference.subjectIds : reference.subjectId ? [reference.subjectId] : []))
            .flatMap((id) => subjects.filter((subject) => subject.id === id));
        const mappedSubject = reference.subjectId ? mappedSubjects.find((subject) => subject.id === reference.subjectId) : mappedSubjects[0];
        const subjectToken = mappedSubjects.map((subject) => `{{subject:${subject.id}}}`).join(", ");
        const shotsForReference = [...new Set([
            ...reference.shotNumbers,
            ...shots.flatMap((shot, index) => (shot.referenceIds || []).includes(reference.bindingId) ? [index + 1] : []),
        ])].sort((a, b) => a - b).map((number) => `[Shot ${number}]`);
        if (reference.type === "image") {
            const picture = reference.bindingId ? `{{ref:${reference.bindingId}}}` : reference.tag;
            const frameUse = reference.usage === "first_frame"
                ? `the first frame of ${shotsForReference[0] || "[Shot 1]"}`
                : reference.usage === "last_frame"
                    ? `the last frame of ${shotsForReference[shotsForReference.length - 1] || `[Shot ${Math.max(1, shots.length)}]`}`
                    : reference.role === "storyboard"
                        ? `a storyboard reference for ${shotsForReference.join(", ") || "the target shot sequence"}`
                        : `a keyframe for ${shotsForReference.join(", ")}`;
            const plan = reference.role === "storyboard"
                ? "defining viewpoint, subject placement, and shot order"
                : "defining the target composition and visible subject state";
            const showing = subjectToken ? `, showing ${subjectToken}` : "";
            const detail = reference.description ? `: ${reference.description}` : "";
            return `${picture} is ${frameUse}${showing}, ${plan}${detail}.`;
        }
        if (reference.type === "audio") {
            if (reference.role === "character_voice") {
                const who = mappedSubject ? `{{subject:${mappedSubject.id}}}` : reference.subjectName || reference.label || "the target speaker";
                const speaker = reference.speakerId ? ` (${reference.speakerId})` : "";
                return `${reference.tag} is the voice-timbre reference for ${who}${speaker}${reference.description ? `; ${reference.description}` : ""}. Use its timbre and pronunciation characteristics without copying the source signal.`;
            }
            return `${reference.tag} is an audio reference for ${reference.label || "the source audio"}${reference.description ? `: ${reference.description}` : ""}; use only the relevant sound characteristics without copying the source signal.`;
        }
        const use = reference.role === "motion_reference" ? "camera movement and motion" : "video structure and visual reference";
        return `${reference.tag} is ${reference.label || "a video reference"}, used as a reference for ${use}${reference.description ? `: ${reference.description}` : ""}.`;
    }).join("\n");

    const retentionAnalysis = subjects.map((subject) => {
        const appearances = shots.flatMap((shot, index) => subjectAppearsInShot(subject, shot) ? [`[Shot ${index + 1}]`] : []);
        const scope = appearances.length ? `appears in ${appearances.join(", ")}` : "no shot appearance is explicitly assigned";
        const relationship = appearances.length ? "fully_preserved" : "weak_reference";
        const details = appearances.length
            ? "preserve only the identity, appearance, and costume attributes defined above; shot-specific actions, blocking, and settings follow the shot description"
            : "the reference remains a visual guide but is not explicitly used in a shot";
        return `{{subject:${subject.id}}} (${scope}): ${relationship} - ${details}.`;
    }).join("\n");

    const referenceRetention = trackedReferences.map((reference) => {
        const mappedSubject = reference.subjectId ? subjects.find((subject) => subject.id === reference.subjectId) : undefined;
        const shotsForReference = [...new Set([
            ...reference.shotNumbers,
            ...shots.flatMap((shot, index) => (shot.referenceIds || []).includes(reference.bindingId) ? [index + 1] : []),
        ])].sort((a, b) => a - b).map((number) => `[Shot ${number}]`);
        if (reference.type === "audio") return `${reference.tag}: reference - ${reference.role === "character_voice" ? `use only its voice characteristics for new dialogue by ${mappedSubject ? `{{subject:${mappedSubject.id}}}` : reference.subjectName || reference.label || "the target speaker"}; do not copy the source signal.` : "refer to its sound characteristics without copying the source signal."}`;
        if (reference.type === "video") {
            const scope = reference.role === "motion_reference" ? "camera movement and motion" : "cut and pacing structure";
            return `${reference.tag} (${scope}): weak_reference - use the video for the role defined above without reproducing it frame by frame.`;
        }
        const frame = reference.usage === "first_frame" ? "first-frame" : reference.usage === "last_frame" ? "last-frame" : reference.role === "storyboard" ? "storyboard composition" : "keyframe composition";
        const frameScope = reference.usage === "first_frame"
            ? `${shotsForReference[0] || "[Shot 1]"} first frame`
            : reference.usage === "last_frame"
                ? `${shotsForReference[shotsForReference.length - 1] || `[Shot ${Math.max(1, shots.length)}]`} last frame`
                : shotsForReference.join(", ") || (reference.role === "storyboard" ? "target shot sequence" : "");
        const level = reference.retentionLevel || "fully_preserved";
        const subjectTokens = (reference.subjectIds?.length ? reference.subjectIds : reference.subjectId ? [reference.subjectId] : [])
            .filter((id) => subjects.some((subject) => subject.id === id))
            .map((id) => `{{subject:${id}}}`);
        const details: Record<NonNullable<PromptReference["retentionLevel"]>, string> = {
            fully_preserved: `preserve the defined ${frame} role and its target viewpoint, subject placement, and visual state`,
            partially_preserved: `retain the selected visual features of the ${frame} while allowing other source-composition details to change`,
            attribute_transfer: `transfer the defined visual attributes${subjectTokens.length ? ` to ${subjectTokens.join(", ")}` : " to the target shot"} without reproducing the source frame as a whole`,
            weak_reference: `use the ${frame} only as broad visual and composition guidance`,
        };
        return `${reference.bindingId ? `{{ref:${reference.bindingId}}}` : reference.tag}${frameScope ? ` (${frameScope})` : ""}: ${level} - ${details[level]}.`;
    }).join("\n");
    return { subjectDefinitions: [subjectDefinitions, referenceDefinitions].filter(Boolean).join("\n"), retentionAnalysis: [retentionAnalysis, referenceRetention].filter(Boolean).join("\n") };
}
function buildPromptSections(project: RecordValue, segment: RecordValue, input: StoryboardInput, bindings: ReturnType<typeof referenceBindingsOf>["bindings"]) {
    const promptMode = promptModeOf(segment);
    const ref2va = promptMode === "ref2va";
    const storyboardSection = ref2va ? "detailed_description" : "integrated_multimodal_description";
    const nodes = Array.isArray(project.nodes) ? project.nodes.map(record) : [];
    const nodeById = new Map(nodes.map((item) => [string(item.id), item]));
    const catalog = referenceCatalogOf(project);
    const groups = record(segment.h3CharacterGroups);
    const groupFor = (id: string) => Object.entries(groups).find(([groupId, raw]) => {
        const group = record(raw);
        return groupId === id || group.id === id || group.subjectId === id || group.characterNodeId === id;
    })?.[1] as RecordValue | undefined;
    const counters = { image: 0, video: 0, audio: 0 };
    const subjects = new Map<string, { id: string; name: string; englishName?: string; aliases: Set<string>; shotMarkers: Set<string>; profile: string; outfits: Set<string>; pictures: string[]; role?: string }>();
    const refs = bindings.filter((binding) => binding.enabled !== false && (binding.url || binding.storageKey)).map((binding) => ({
        url: binding.url || "",
        type: binding.mediaType || inferReferenceMediaType({ mimeType: binding.mimeType, url: binding.url, name: binding.label }),
        name: binding.label,
        storageKey: binding.storageKey,
        mimeType: binding.mimeType,
        nodeId: binding.sourceNodeId,
        role: binding.role,
        subjectId: binding.subjectId,
        storyboardSubjectIds: binding.storyboardSubjectIds,
        bindingId: binding.id,
        assetId: binding.assetId,
        tags: binding.tags,
        enabled: binding.enabled,
        usage: binding.usage,
        retentionLevel: binding.retentionLevel,
        groupId: binding.groupId,
        outfitId: binding.outfitId,
    } as RecordValue));
    const shotReferenceIds = new Set(input.shots.flatMap((shot) => [
        ...(string(shot.pictureBindingId) ? [string(shot.pictureBindingId)] : []),
        ...Array.from(string(shot.description).matchAll(/\{\{ref:([^{}]+)\}\}/gu), (match) => match[1]),
    ]));
    const referenceManifest: PromptReference[] = refs.map((ref) => {
        const type = ref.type as "image" | "video" | "audio";
        const ordinal = ++counters[type];
        const tag = type === "image" ? `<Picture ${ordinal}>` : type === "video" ? `<Video ${ordinal}>` : `<Audio ${ordinal}>`;
        const sourceNode = nodeById.get(string(ref.nodeId));
        const sourceCharacterId = sourceNode?.type === "character" ? string(sourceNode.id) : "";
        const asset = catalog.find((item) => item.id === ref.assetId || Boolean(ref.storageKey && item.storageKey === ref.storageKey) || Boolean(ref.url && item.url === ref.url));
        const role = inferReferenceRole(ref);
        const declaredSubjectId = string(ref.subjectId || asset?.subjectId);
        const sourceGroup = groupFor(string(ref.groupId || declaredSubjectId));
        const sourceMetadata = record(sourceNode?.metadata);
        const audioSubjectId = string(sourceGroup?.subjectId || sourceGroup?.characterNodeId || declaredSubjectId || sourceCharacterId) || undefined;
        const audioSubjectName = string(sourceGroup?.characterName || sourceMetadata.characterName || sourceNode?.title || ref.name);
        const referenceDescription = type === "image"
            ? pictureDescription(ref, catalog)
            : string(record(asset?.analysis).summary || record(ref.analysis).summary || record(sourceGroup?.voice).description || sourceMetadata.characterVoiceDescription);
        const mappedIds = type === "image" ? [...new Set([declaredSubjectId, string(ref.groupId), ...(Array.isArray(ref.storyboardSubjectIds) ? ref.storyboardSubjectIds.map(String) : [])].filter(Boolean))] : [];
        const anchor = type === "image" && (string(ref.usage) === "first_frame" || string(ref.usage) === "last_frame" || role === "storyboard" || (role === "keyframe" && shotReferenceIds.has(string(ref.bindingId))));
        const ids = mappedIds.length ? mappedIds : type === "image" && sourceCharacterId ? [sourceCharacterId] : type === "image" && !anchor && string(ref.bindingId) ? [string(ref.bindingId)] : [];
        const subjectIds = new Set<string>();
        for (const id of ids) {
            const group = groupFor(id) || Object.values(groups).map(record).find((item) => item.subjectId === id || item.characterNodeId === id);
            const subjectId = string(group?.subjectId || group?.characterNodeId || id);
            const characterNode = group?.characterNodeId ? nodeById.get(string(group.characterNodeId)) : id === sourceCharacterId ? sourceNode : nodeById.get(id);
            const metadata = record(characterNode?.metadata);
            const isCharacter = Boolean(group || characterNode?.type === "character" || role === "character_identity" || role === "character_turnaround");
            const name = string(group?.characterName || metadata.characterName || characterNode?.title || (isCharacter ? ref.name : asset?.label || ref.name || subjectId));
            const englishName = string(metadata.characterEnglishName);
            const profile = [string(metadata.characterDescription), role === "storyboard" && anchor ? "" : referenceDescription].filter((value, index, all) => value && all.indexOf(value) === index).join("; ");
            const entry = subjects.get(subjectId) || { id: subjectId, name, englishName: englishName || undefined, aliases: new Set<string>(), shotMarkers: new Set<string>(), profile, outfits: new Set<string>(), pictures: [], role };
            [id, group?.id, group?.subjectId, group?.characterNodeId, group?.characterName, characterNode?.id, characterNode?.title, metadata.characterName, englishName]
                .forEach((alias) => { if (typeof alias === "string" && alias.trim()) entry.aliases.add(alias.trim()); });
            if (ref.bindingId) subjectIds.add(subjectId);
            if (ref.bindingId && type === "image") entry.shotMarkers.add(`{{ref:${ref.bindingId}}}`);
            if (group && ref.outfitId) {
                const outfits = Array.isArray(group.outfits) ? group.outfits.map(record) : [];
                const outfit = outfits.find((item) => item.id === ref.outfitId);
                const images = Array.isArray(metadata.characterImages) ? metadata.characterImages.map(record) : [];
                const image = images.find((item) => String(item.outfit || item.name || "") === outfit?.name);
                const outfitDescription = string(image?.outfitDescription);
                if (outfit && (outfit.name || outfitDescription)) entry.outfits.add([outfit.name, outfitDescription].filter(Boolean).join(": "));
            }
            const pictureMarker = type === "image" && ref.bindingId ? `{{ref:${ref.bindingId}}}` : tag;
            if (!entry.pictures.includes(pictureMarker) && type === "image") entry.pictures.push(pictureMarker);
            if (!entry.profile && profile) entry.profile = profile;
            if (entry.role === "storyboard" && role !== "storyboard") entry.role = role;
            if (entry.name === entry.id && name !== subjectId) entry.name = name;
            if (!entry.englishName && englishName) entry.englishName = englishName;
            subjects.set(subjectId, entry);
        }
        return {
            tag,
            bindingId: string(ref.bindingId),
            type,
            label: string(ref.name) || `未命名${type === "audio" ? "音频" : type === "video" ? "视频" : "图片"}参考`,
            role,
            description: type === "audio"
                ? string(record(sourceGroup?.voice).description || sourceMetadata.characterVoiceDescription || record(asset?.analysis).summary || record(ref.analysis).summary)
                : referenceDescription,
            subjectId: type === "audio" ? audioSubjectId : undefined,
            subjectIds: [...subjectIds],
            subjectName: type === "audio" ? audioSubjectName : undefined,
            usage: string(ref.usage) || "reference",
            retentionLevel: ref.retentionLevel as PromptReference["retentionLevel"],
            shotNumbers: [],
        };
    });

    const voiceReferences = referenceManifest.filter((reference) => reference.type === "audio" && reference.role === "character_voice" && reference.subjectId);
    const speakerBySubject = new Map<string, string>();
    const explicitSpeakerId = (subjectId: string) => {
        const subject = subjects.get(subjectId);
        if (!subject) return "";
        const aliases = [`{{subject:${subjectId}}}`, subject.name, subject.englishName || "", ...subject.aliases].filter(Boolean);
        const text = input.shots.map((shot) => shot.description).join("\n");
        for (const alias of aliases) {
            let offset = 0;
            while (offset < text.length) {
                const index = text.toLocaleLowerCase().indexOf(alias.toLocaleLowerCase(), offset);
                if (index < 0) break;
                const near = text.slice(Math.max(0, index - 24), index + alias.length + 32);
                const match = near.match(/[（(]\s*(S\d+)\s*[)）]/iu);
                if (match) return match[1].toUpperCase();
                offset = index + alias.length;
            }
        }
        return "";
    };
    for (const reference of voiceReferences) {
        if (!reference.subjectId || speakerBySubject.has(reference.subjectId)) continue;
        const speakerId = explicitSpeakerId(reference.subjectId);
        if (speakerId) speakerBySubject.set(reference.subjectId, speakerId);
    }
    const usedSpeakerIds = new Set(speakerBySubject.values());
    let nextSpeakerNumber = 1;
    for (const reference of voiceReferences) {
        if (!reference.subjectId || speakerBySubject.has(reference.subjectId)) continue;
        while (usedSpeakerIds.has(`S${nextSpeakerNumber}`)) nextSpeakerNumber += 1;
        const speakerId = `S${nextSpeakerNumber++}`;
        speakerBySubject.set(reference.subjectId, speakerId);
        usedSpeakerIds.add(speakerId);
    }
    const referencesWithSpeakers = referenceManifest.map((reference) => ({
        ...reference,
        speakerId: reference.type === "audio" && reference.role === "character_voice" && reference.subjectId
            ? speakerBySubject.get(reference.subjectId)
            : undefined,
    }));
    const subjectManifest: PromptSubject[] = [...subjects.values()].map((subject) => ({
        id: subject.id,
        name: subject.name,
        englishName: subject.englishName,
        aliases: [...subject.aliases],
        shotMarkers: [...subject.shotMarkers],
        profile: subject.profile,
        outfits: [...subject.outfits],
        pictures: subject.pictures,
        role: subject.role,
    }));
    const normalizedShots = input.shots.map((shot) => ({
        description: string(shot.description),
        switchTime: string(shot.switchTime),
        transitionType: shot.transitionType || "cut",
        pictureBindingId: string(shot.pictureBindingId),
        pictureDescription: string(shot.pictureBindingId) ? pictureDescription(refs.find((ref) => ref.bindingId === shot.pictureBindingId) || { name: "", url: "", type: "image", bindingId: shot.pictureBindingId }, catalog) : "",
        referenceIds: [...new Set([
            ...Array.from(string(shot.description).matchAll(/\{\{ref:([^{}]+)\}\}/gu), (match) => match[1]),
            ...(string(shot.pictureBindingId) ? [string(shot.pictureBindingId)] : []),
        ])],
    }));
    const finalReferences = referencesWithSpeakers.map((reference) => ({
        ...reference,
        shotNumbers: normalizedShots.flatMap((shot, index) => shot.referenceIds.includes(reference.bindingId) ? [index + 1] : []),
    }));
    const content = {
        version: 10,
        summary: string(input.summary),
        openingDescription: string(input.openingDescription),
        shots: normalizedShots,
        overallSoundscape: string(input.overallSoundscape),
        nonDiegeticMusic: string(input.nonDiegeticMusic),
        references: finalReferences,
        referenceIdentity: refs.map((ref) => ({
            type: ref.type,
            bindingId: ref.bindingId || "",
            assetId: ref.assetId || "",
            sourceNodeId: ref.nodeId || "",
            storageKey: ref.storageKey || "",
            url: ref.storageKey ? "" : ref.url || "",
            name: ref.name || "",
            role: inferReferenceRole(ref),
            subjectId: ref.subjectId || "",
            groupId: ref.groupId || "",
            outfitId: ref.outfitId || "",
            storyboardSubjectIds: ref.storyboardSubjectIds || [],
            tags: ref.tags || [],
            usage: ref.usage || "reference",
            retentionLevel: ref.retentionLevel || "fully_preserved",
        })),
        subjects: subjectManifest,
    };
    const generated = buildPromptText(subjectManifest, finalReferences, normalizedShots);
    const fingerprint = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    let prompt = String(segment.prompt || "");
    if (ref2va) {
        prompt = replaceSection(prompt, "subject_definitions", generated.subjectDefinitions, promptMode);
        prompt = replaceSection(prompt, "summary", string(input.summary), promptMode);
        prompt = replaceSection(prompt, "retention_analysis", generated.retentionAnalysis, promptMode);
    }
    prompt = replaceSection(prompt, storyboardSection, promptForShots(input, refs, catalog), promptMode);
    prompt = replaceSection(prompt, "overall_soundscape", string(input.overallSoundscape), promptMode);
    prompt = replaceSection(prompt, "non_diegetic_music", string(input.nonDiegeticMusic), promptMode);
    return { prompt, fingerprint, subjectDefinitions: generated.subjectDefinitions, retentionAnalysis: generated.retentionAnalysis, subjectCount: subjectManifest.length, shotCount: input.shots.length, content };
}

export function writeStoryboardPrompt(project: RecordValue, segment: RecordValue, rawInput: RecordValue) {
    const input = rawInput as StoryboardInput;
    if (!Array.isArray(input.shots) || !input.shots.length) throw new Error("分镜至少需要一镜");
    const bindings = referenceBindingsOf(segment).bindings;
    const generated = buildPromptSections(project, segment, input, bindings);
    const cache = record(segment.storyboardPromptCache);
    const promptMode = promptModeOf(segment);
    if (promptMode === "ref2va" && cache.version === 10 && cache.fingerprint === generated.fingerprint && string(segment.prompt) === generated.prompt) return { ...generated, unchanged: true as const };
    if (promptMode !== "ref2va" && string(segment.prompt) === generated.prompt) return { ...generated, unchanged: true as const };
    return {
        ...generated,
        unchanged: false as const,
        ...(promptMode === "ref2va" ? { cache: { version: 10, fingerprint: generated.fingerprint, subjectDefinitions: generated.subjectDefinitions, retentionAnalysis: generated.retentionAnalysis } } : {}),
    };
}
