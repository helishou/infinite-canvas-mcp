import { promptDetails, validateDefinitionCoverage } from "../../../../../canvas-agent/src/plugins/minimax-h3/prompt-rules";
import type { H3CharacterGroup, H3SubjectDefinition } from "../types";

export type StoryboardPromptSubject = {
    id: string;
    name: string;
    englishName?: string;
    aliases: string[];
    shotMarkers: string[];
    profile: string;
    outfits: string[];
    pictures: string[];
    role?: string;
};

/**
 * 用户自定义的实体定义覆盖规则生成的 subjects。
 * 覆盖存在时它是**权威清单**：未列出的主体即视为已删除，顺序决定 `<Subject N>` 编号。
 * 名称/描述/服装/视觉来源可按实体逐项覆写，未填写的项回落到规则生成值。
 */
export function mergeSubjectDefinitions(ruleSubjects: StoryboardPromptSubject[], override?: H3SubjectDefinition[] | null): StoryboardPromptSubject[] {
    if (!override?.length) return ruleSubjects;
    const byId = new Map(ruleSubjects.map((subject) => [subject.id, subject]));
    const merged = override.map((definition): StoryboardPromptSubject => {
        const base = byId.get(definition.id);
        return {
            id: definition.id,
            name: definition.name?.trim() || base?.name || definition.id,
            englishName: definition.englishName?.trim() || base?.englishName,
            aliases: base?.aliases || [],
            shotMarkers: base?.shotMarkers || [],
            profile: definition.profile ?? base?.profile ?? "",
            outfits: definition.outfits?.length ? definition.outfits : base?.outfits || [],
            pictures: definition.pictures?.length ? definition.pictures : base?.pictures || [],
            role: definition.role || base?.role,
        };
    });
    // 覆盖清单里出现的 ID 但规则侧没有对应主体（用户手工新增）时，保留其自身描述。
    return merged.map((subject) => subject.profile || subject.pictures.length
        ? subject
        : { ...subject, profile: subject.profile || "visual features follow the linked reference" });
}

/** 把规则生成的主体清单转成可编辑的实体定义（分镜编辑表单打开时的默认值）。 */
export function toSubjectDefinitions(subjects: StoryboardPromptSubject[]): H3SubjectDefinition[] {
    return subjects.map((subject) => ({
        id: subject.id,
        name: subject.name,
        englishName: subject.englishName,
        pictures: [...subject.pictures],
        profile: subject.profile,
        outfits: [...subject.outfits],
        role: subject.role,
    }));
}

/**
 * 规则实体不仅来自媒体 ref：服装关闭但声线开启的角色组也必须保留人物身份。
 * 角色组是人物语义权威，媒体槽只是可选的服装/声线投影。
 */
export function ensureCharacterGroupSubjects(
    subjects: StoryboardPromptSubject[],
    groups: Record<string, H3CharacterGroup> | undefined,
): StoryboardPromptSubject[] {
    const next = [...subjects];
    const byId = new Map(next.map((subject) => [subject.id, subject]));
    const byAlias = new Map<string, StoryboardPromptSubject>();
    for (const subject of next) {
        for (const alias of [subject.id, subject.name, subject.englishName || "", ...subject.aliases]) {
            if (alias.trim()) byAlias.set(alias.trim().toLocaleLowerCase(), subject);
        }
    }
    for (const group of Object.values(groups || {})) {
        const outfitEnabled = group.outfitEnabled ?? group.outfits.some((outfit) => outfit.enabled);
        if (!group.voiceEnabled && !outfitEnabled) continue;
        const id = group.subjectId || group.characterNodeId || group.id;
        if (!id) continue;
        const existing = byId.get(id) || [group.id, group.characterName].map((alias) => byAlias.get(alias.toLocaleLowerCase())).find(Boolean);
        if (existing) {
            if (existing.role !== "storyboard" && existing.role !== "blocking") existing.role ||= "character_identity";
            continue;
        }
        const subject: StoryboardPromptSubject = {
            id,
            name: group.characterName || id,
            aliases: [group.id, group.characterNodeId || ""].filter((alias) => alias && alias !== id),
            shotMarkers: [],
            profile: group.voice?.description || "identity and voice follow the linked character definition",
            outfits: group.outfits.filter((outfit) => outfit.enabled).map((outfit) => outfit.name).filter(Boolean),
            pictures: [],
            role: "character_identity",
        };
        next.push(subject);
        byId.set(id, subject);
        for (const alias of [subject.id, subject.name, ...subject.aliases]) byAlias.set(alias.toLocaleLowerCase(), subject);
    }
    return next;
}

/** 已保存的实体清单是用户删除语义的权威，但启用中的纯声线角色不能因旧清单未记录而消失。 */
export function ensureCharacterGroupSubjectDefinitions(
    definitions: H3SubjectDefinition[],
    groups: Record<string, H3CharacterGroup> | undefined,
): H3SubjectDefinition[] {
    const next = [...definitions];
    const byId = new Set(next.map((definition) => definition.id));
    const byName = new Set(next.map((definition) => definition.name.trim().toLocaleLowerCase()).filter(Boolean));
    for (const group of Object.values(groups || {})) {
        const outfitEnabled = group.outfitEnabled ?? group.outfits.some((outfit) => outfit.enabled);
        if (!group.voiceEnabled && !outfitEnabled) continue;
        const id = group.subjectId || group.characterNodeId || group.id;
        if (!id || byId.has(id) || byName.has(group.characterName.trim().toLocaleLowerCase())) continue;
        next.push({
            id,
            name: group.characterName,
            pictures: [],
            profile: group.voice?.description || "identity and voice follow the linked character definition",
            outfits: group.outfits.filter((outfit) => outfit.enabled).map((outfit) => outfit.name).filter(Boolean),
            role: "character_identity",
        });
        byId.add(id);
        byName.add(group.characterName.trim().toLocaleLowerCase());
    }
    return next;
}

export type StoryboardPromptReference = {
    tag: string;
    bindingId: string;
    type: "image" | "video" | "audio";
    role: string;
    label: string;
    description: string;
    subjectId?: string;
    subjectIds?: string[];
    subjectName?: string;
    speakerId?: string;
    usage?: string;
  retentionLevel?: "fully_preserved" | "partially_preserved" | "attribute_transfer" | "weak_reference";
  shotNumbers: number[];
  compositePanels?: Array<{ index: number; row: number; column: number; shotNumbers: number[] }>;
};

export type StoryboardPromptShot = { description: string; referenceIds?: string[] };

export async function storyboardPromptFingerprint(input: unknown) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function subjectAppearsInShot(subject: StoryboardPromptSubject, shot: StoryboardPromptShot, subjectOrdinal: number) {
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
    return (shot.referenceIds || []).some((id) => subject.shotMarkers.includes(id)) ||
        subject.pictures.some((marker) => text.includes(marker.toLocaleLowerCase())) ||
        text.includes(`<subject ${subjectOrdinal}>`) || nameMatch;
}

function shotText(reference: StoryboardPromptReference, shots: StoryboardPromptShot[]) {
    return [...new Set([
        ...reference.shotNumbers,
        ...shots.flatMap((shot, index) => (shot.referenceIds || []).includes(reference.bindingId) ? [index + 1] : []),
    ])].sort((a, b) => a - b).map((number) => `[Shot ${number}]`);
}

function pictureFrameScope(reference: StoryboardPromptReference, shotsForReference: string[], shotCount: number) {
    if (reference.usage === "first_frame") return `${shotsForReference[0] || "[Shot 1]"} first frame`;
    if (reference.usage === "last_frame") return `${shotsForReference[shotsForReference.length - 1] || `[Shot ${Math.max(1, shotCount)}]`} last frame`;
    return shotsForReference.join(", ") || (["storyboard", "blocking"].includes(reference.role) ? "target shot sequence" : "");
}

function isPictureAnchor(reference: StoryboardPromptReference) {
    if (reference.type !== "image") return false;
    return reference.usage === "first_frame" || reference.usage === "last_frame" ||
        reference.role === "storyboard" || reference.role === "blocking" || (reference.role === "keyframe" && reference.shotNumbers.length > 0);
}

function trackedReferences(references: StoryboardPromptReference[]) {
    return references.filter((reference) => reference.type !== "image" || isPictureAnchor(reference));
}

export function buildStoryboardPromptSections(subjects: StoryboardPromptSubject[], references: StoryboardPromptReference[], shots: StoryboardPromptShot[]) {
    const blockingTags = new Set(references.filter((reference) => reference.type === "image" && reference.role === "blocking").map((reference) => reference.tag));
    // 实体清单里保存的「视觉来源」可能已经失效：关掉角色服装后，之前记下的 <Picture N>
    // 不再是本 Clip 的参考素材。写进提示词前必须按当前 references 过滤，否则
    // validateDefinitionCoverage 会判定「参考素材与主体来源不一致」让分镜编辑点完成失败。
    const liveTags = new Set(references.map((reference) => reference.tag));
    const subjectPictures = (subject: StoryboardPromptSubject) => subject.pictures.filter((tag) => liveTags.has(tag));
    const subjectOrdinalById = new Map(subjects.map((subject, index) => [subject.id, index + 1]));
    const subjectMarker = (subject: StoryboardPromptSubject) => `<Subject ${subjectOrdinalById.get(subject.id) || 1}>`;
    const subjectDefinitions = subjects.map((subject) => {
        const identity = [subject.name, subject.englishName && subject.englishName !== subject.name ? subject.englishName : ""].filter(Boolean).join(" / ");
        const details = promptDetails([subject.profile, ...subject.outfits]);
        const livePictures = subjectPictures(subject);
        const identityPictures = livePictures.filter((tag) => !blockingTags.has(tag));
        const blockingPictures = livePictures.filter((tag) => blockingTags.has(tag));
        if (identityPictures.length) details.unshift(`visual identity defined by reference(s) ${identityPictures.join(", ")}`);
        if (blockingPictures.length) details.push(`spatial blocking guided by ${blockingPictures.join(", ")}`);
        if (!details.length) details.push("visual features follow the linked reference");
        return `${subjectMarker(subject)} is ${identity || subject.id}. ${details.join("; ")}.`;
    }).join("\n");

    const referenceDefinitions = trackedReferences(references).map((reference) => {
        const referenceMarker = reference.tag;
        const mappedSubjects = ((reference.subjectIds?.length ? reference.subjectIds : reference.subjectId ? [reference.subjectId] : []))
            .flatMap((id) => subjects.filter((subject) => subject.id === id));
        const subjectTokens = mappedSubjects.map(subjectMarker);
        const subjectToken = subjectTokens.join(", ");
        const shotsForReference = shotText(reference, shots);
        if (reference.type === "image") {
            if (reference.role === "blocking") {
                const scope = shotsForReference.join(", ") || "the target shot sequence";
                return `${referenceMarker} is the blocking and 180-degree action-axis map for ${scope}, defining relative subject positions, orientation, sightlines, entrances, and movement paths${reference.description ? `: ${reference.description}` : ""}. It is a spatial plan, not a rendered frame or character identity source.`;
            }
            if (reference.role === "storyboard" && reference.compositePanels?.length) {
                const panelMap = reference.compositePanels.map((panel) => `Panel ${panel.index} (row ${panel.row}, column ${panel.column}) corresponds to ${panel.shotNumbers.map((number) => `[Shot ${number}]`).join(", ") || "no assigned shot"}`).join("; ");
                return `${referenceMarker} is one composite storyboard image arranged as a grid, not a single storyboard frame. Read each panel independently: ${panelMap}. The sheet defines viewpoint, subject placement, and shot order${reference.description ? `: ${reference.description}` : ""}.`;
            }
            const frameUse = reference.usage === "first_frame"
                ? `the locked opening frame of ${shotsForReference[0] || "[Shot 1]"} (visible at 00:00 of the clip)`
                : reference.usage === "last_frame"
                    ? `the locked closing frame of ${shotsForReference[shotsForReference.length - 1] || `[Shot ${Math.max(1, shots.length)}]`}`
                    : reference.role === "storyboard"
                        ? `the approved storyboard frame for ${shotsForReference.join(", ") || "the target shot sequence"}`
                        : `a keyframe anchoring the composition of ${shotsForReference.join(", ")}`;
            const plan = reference.role === "storyboard"
                ? "defining viewpoint, subject placement, and shot order"
                : "defining the target composition and visible subject state";
            const showing = subjectToken ? `, showing ${subjectToken}` : "";
            const detail = reference.description ? `: ${reference.description}` : "";
            return `${referenceMarker} is ${frameUse}${showing}, ${plan}${detail}.`;
        }
        if (reference.type === "audio") {
            const speaker = reference.speakerId ? ` (${reference.speakerId})` : "";
            if (reference.role === "character_voice") {
            const who = subjectToken || reference.subjectName || "the target speaker";
                return `${reference.tag} is the voice-timbre reference for ${who}${speaker}${reference.description ? `; ${reference.description}` : ""}. Use its timbre and pronunciation characteristics without copying the source signal.`;
            }
            return `${reference.tag} is an ambient and sound-design reference${reference.description ? `: ${reference.description}` : ""}; use only the relevant sound characteristics without copying the source signal.`;
        }
        const use = reference.role === "motion_reference"
            ? "camera movement, motion pacing, and action choreography"
            : "editing rhythm, scene structure, and visual continuity";
        return `${reference.tag} is a video reference used for ${use}${reference.description ? `: ${reference.description}` : ""}.`;
    }).join("\n");

    const retentionAnalysis = subjects.map((subject, subjectIndex) => {
        const appearanceSubject = { ...subject, pictures: subjectPictures(subject).filter((tag) => !blockingTags.has(tag)) };
        const appearances = shots.flatMap((shot, index) => subjectAppearsInShot(appearanceSubject, shot, subjectIndex + 1) ? [`[Shot ${index + 1}]`] : []);
        const scope = appearances.length ? `appears in ${appearances.join(", ")}` : "no shot appearance is explicitly assigned";
        const relationship = appearances.length ? "fully_preserved" : "weak_reference";
        const details = appearances.length
            ? "preserve only the identity, appearance, and costume attributes defined above; shot-specific actions, blocking, and settings follow the shot description"
            : "the reference remains a visual guide but is not explicitly used in a shot";
        return `${subjectMarker(subject)} (${scope}): ${relationship} - ${details}.`;
    }).join("\n");

    const referenceRetention = trackedReferences(references).map((reference) => {
        const referenceMarker = reference.tag;
        const shotsForReference = shotText(reference, shots);
        if (reference.type === "audio") {
            return `${reference.tag}: reference - ${reference.role === "character_voice" ? `use its voice characteristics for new dialogue by ${reference.subjectName || "the target speaker"}; do not copy the source signal.` : "refer to its sound characteristics without copying the source signal."}`;
        }
        if (reference.type === "video") {
            const scope = reference.role === "motion_reference" ? "camera movement and motion pacing" : "scene structure and pacing";
            const use = reference.role === "motion_reference" ? "use its motion characteristics as guidance" : "use its visual structure as guidance";
            return `${reference.tag} (${scope}): weak_reference - ${use} without reproducing the source video frame by frame.`;
        }
        if (reference.role === "blocking") {
            const scope = pictureFrameScope(reference, shotsForReference, shots.length);
            const level = reference.retentionLevel || "fully_preserved";
            const details: Record<NonNullable<StoryboardPromptReference["retentionLevel"]>, string> = {
                fully_preserved: "preserve the defined relative positions, movement paths, screen direction, and 180-degree action axis across shots without copying the overhead diagram into a rendered frame",
                partially_preserved: "retain the selected spatial relationships and action axis while following shot-specific blocking changes",
                attribute_transfer: "transfer the defined spatial relationships and action axis into the target shots without reproducing the diagram",
                weak_reference: "use the spatial arrangement and action axis only as broad guidance",
            };
            return `${referenceMarker} (${scope}): ${level} - ${details[level]}.`;
        }
        const frame = reference.usage === "first_frame" ? "first-frame" : reference.usage === "last_frame" ? "last-frame" : reference.role === "storyboard" ? "storyboard composition" : "keyframe composition";
        const frameScope = pictureFrameScope(reference, shotsForReference, shots.length);
        const level = reference.retentionLevel || "fully_preserved";
        const mappedSubjects = ((reference.subjectIds?.length ? reference.subjectIds : reference.subjectId ? [reference.subjectId] : []))
            .flatMap((id) => subjects.filter((subject) => subject.id === id));
        const subjectTokens = mappedSubjects.map(subjectMarker);
        const details: Record<NonNullable<StoryboardPromptReference["retentionLevel"]>, string> = {
            fully_preserved: `preserve the defined ${frame} role and its target viewpoint, subject placement, and visual state`,
            partially_preserved: `retain the selected visual features of the ${frame} while allowing other source-composition details to change`,
            attribute_transfer: `transfer the defined visual attributes${subjectTokens.length ? ` to ${subjectTokens.join(", ")}` : " to the target shot"} without reproducing the source frame as a whole`,
            weak_reference: `use the ${frame} only as broad visual and composition guidance`,
        };
        const panelMap = reference.compositePanels?.length
            ? ` Composite storyboard map: ${reference.compositePanels.map((panel) => `Panel ${panel.index} (row ${panel.row}, column ${panel.column}) = ${panel.shotNumbers.map((number) => `[Shot ${number}]`).join(", ") || "no assigned shot"}`).join("; ")}.`
            : "";
        return `${referenceMarker}${frameScope ? ` (${frameScope})` : ""}: ${level} - ${details[level]}.${panelMap}`;
    }).join("\n");

    const result = { subjectDefinitions: [subjectDefinitions, referenceDefinitions].filter(Boolean).join("\n"), retentionAnalysis: [retentionAnalysis, referenceRetention].filter(Boolean).join("\n") };
    // 校验也必须用过滤后的来源：失效的 <Picture N> 早已不在 references 里，
    // 拿未过滤的清单去比对必然报「参考素材与主体来源不一致」。
    const liveSubjects = subjects.map((subject) => ({ pictures: subjectPictures(subject) }));
    validateDefinitionCoverage(liveSubjects, references, result.subjectDefinitions, result.retentionAnalysis);
    return result;
}
