import { createHash } from "node:crypto";
import { inferReferenceMediaType, inferReferenceRole, referenceBindingsOf, referenceCatalogOf } from "../../canvas/reference-contract.js";
import { orderStoryboardImageReferences, remapPictureTags } from "../../canvas/storyboard-reference-order.js";
import { assembleH3Prompt } from "./prompt-sections.js";
import { deriveStoryboardDurations, formatShotTimestamp, isReferenceNameEcho, normalizeRef2vaSummary, promptDetails, stripDuplicateTransition, stripStoryboardCues, validateDefinitionCoverage, validatePromptReferences, validateShotTimeline, validateStoryboardShotDescriptions, visualReferenceTags } from "./prompt-rules.js";

type RecordValue = Record<string, unknown>;
type Transition = "continuous" | "cut" | "dissolve" | "fade_black";
type StoryboardShotInput = { description: string; switchTime?: string; transitionType?: Transition; pictureBindingId?: string };
type StoryboardInput = { summary?: string; openingDescription: string; shots: StoryboardShotInput[]; overallSoundscape: string; nonDiegeticMusic: string };
type PromptSubject = { id: string; name: string; englishName?: string; aliases: string[]; shotMarkers: string[]; profile: string; outfits: string[]; pictures: string[]; role?: string };
type PromptReference = { tag: string; bindingId: string; type: "image" | "video" | "audio"; role: string; label: string; description: string; subjectId?: string; subjectIds?: string[]; subjectName?: string; speakerId?: string; usage?: string; retentionLevel?: "fully_preserved" | "partially_preserved" | "attribute_transfer" | "weak_reference"; shotNumbers: number[]; compositePanels?: Array<{ index: number; row: number; column: number; shotNumbers: number[] }> };
type PromptShot = { description: string; referenceIds?: string[] };
type CompositePanel = { bindingId: string; index: number; row: number; column: number; shotNumbers: number[] };
type CompositeLayout = { rows: number; columns: number; panels: CompositePanel[] };

const SHOT_TRANSITION_LEADIN: Record<Transition, string> = {
    continuous: "the shot continues",
    cut: "the shot hard-cuts",
    dissolve: "the shot cross-dissolves",
    fade_black: "the shot fades out to black, then fades in",
};
const STORYBOARD_KEYFRAME_GUIDANCE = "Storyboard images establish shot-entry keyframes, not frozen poses for the entire shot. After each keyframe, keep the camera setup and spatial relationship stable while allowing natural breathing, gaze changes, head and shoulder movement, restrained hand gestures, facial reactions, and clothing motion.";
function record(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function string(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

const COMPOSITE_LAYOUTS: Record<number, { rows: number; columns: number }> = {
    2: { rows: 1, columns: 2 }, 3: { rows: 1, columns: 3 }, 4: { rows: 2, columns: 2 },
    5: { rows: 1, columns: 5 }, 6: { rows: 2, columns: 3 }, 7: { rows: 2, columns: 4 },
    8: { rows: 2, columns: 4 }, 9: { rows: 3, columns: 3 },
};

function storyboardCompositePlan(enabled: boolean, shots: StoryboardShotInput[], bindings: ReturnType<typeof referenceBindingsOf>["bindings"]): CompositeLayout | null {
    if (!enabled) return null;
    const available = new Set(bindings.filter((binding) => binding.enabled && binding.role === "storyboard" && (binding.mediaType || inferReferenceMediaType(binding)) === "image" && (binding.url || binding.storageKey)).map((binding) => binding.id));
    const pictureBindings = bindings.filter((binding) => binding.enabled && (binding.mediaType || inferReferenceMediaType(binding)) === "image" && (binding.url || binding.storageKey));
    const uses = new Map<string, number[]>();
    shots.forEach((shot, index) => {
        const ids = [...new Set([
            ...Array.from(string(shot.description).matchAll(/<Picture\s+(\d+)>/giu), (match) => pictureBindings[Number(match[1]) - 1]?.id).filter((id): id is string => Boolean(id)),
            ...(string(shot.pictureBindingId) ? [string(shot.pictureBindingId)] : []),
        ])];
        ids.filter((id) => available.has(id)).forEach((id) => uses.set(id, [...(uses.get(id) || []), index + 1]));
    });
    const bindingIds = [...uses.keys()];
    const layout = COMPOSITE_LAYOUTS[bindingIds.length];
    if (bindingIds.length < 2 || !layout) return null;
    return { ...layout, panels: bindingIds.map((bindingId, index) => ({ bindingId, index: index + 1, row: Math.floor(index / layout.columns) + 1, column: index % layout.columns + 1, shotNumbers: [...new Set(uses.get(bindingId) || [])] })) };
}
function promptModeOf(segment: RecordValue) {
    const mode = string(segment.mode || segment.taskMode || "ref2va");
    return ["ref2va", "t2v", "i2v", "fl2v"].includes(mode) ? mode : "ref2va";
}

function pictureDescription(ref: RecordValue, catalog: ReturnType<typeof referenceCatalogOf>) {
    const asset = catalog.find((item) => item.id === ref.assetId || Boolean(ref.storageKey && item.storageKey === ref.storageKey) || Boolean(ref.url && item.url === ref.url));
    const analysis = record(asset?.analysis);
    const refAnalysis = record(ref.analysis);
    const summary = string(analysis.summary || refAnalysis.summary);
    const tags = visualReferenceTags([
        ...(Array.isArray(asset?.tags) ? asset.tags : []),
        ...(Array.isArray(ref.tags) ? ref.tags : []),
    ].map(String)).join(", ");
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
    // 描述只取视觉分析摘要与标签，禁止兜底到 asset.label / ref.name（文件名对模型无语义）；
    // 摘要或标签本身只是素材名的回显时同样丢弃（历史数据里存在把 label 写进 analysis.summary 的情况）。
    const names = [asset?.label, ref.name, ref.label];
    const details = [summary, tags].filter((value) => !isReferenceNameEcho(String(value || ""), names));
    return details.map((value) => clean(String(value || ""))).find((value) => value && !/^(?:the|a|an|for|of)$/iu.test(value))?.slice(0, 140) || "";
}

function promptForShots(input: StoryboardInput, refs: RecordValue[], catalog: ReturnType<typeof referenceCatalogOf>, composite: CompositeLayout | null, references: PromptReference[]) {
    const byId = new Map(refs.map((ref) => [String(ref.bindingId || ""), ref]));
    const originalPictureRefs = refs.filter((ref) => ref.type === "image");
    const compositeSourceIds = new Set(composite?.panels.map((panel) => panel.bindingId) || []);
    const pictureTagForId = (id: string) => {
        const finalId = compositeSourceIds.has(id) ? composite?.panels[0]?.bindingId : id;
        return references.find((reference) => reference.bindingId === finalId)?.tag || "<Picture 1>";
    };
    const normalizeLegacyReferences = (description: string) => description.replace(/\{\{\s*ref:\s*([^{}]+?)\s*\}\}/gu, (marker, rawId: string) => {
        const id = rawId.trim();
        return originalPictureRefs.some((ref) => String(ref.bindingId || "") === id) ? pictureTagForId(id) : marker;
    });
    const remapDescription = (description: string) => description.replace(/<Picture\s+(\d+)>/giu, (marker, ordinal: string) => {
        const id = String(originalPictureRefs[Number(ordinal) - 1]?.bindingId || "");
        return id ? pictureTagForId(id) : marker;
    });
    const details = input.shots.map((shot, index) => {
        const transitionType = shot.transitionType || "cut";
        if (!(transitionType in SHOT_TRANSITION_LEADIN)) throw new Error(`分镜 ${index + 1} 的切换方式无效：${transitionType}`);
        const transition = index ? ` ${SHOT_TRANSITION_LEADIN[transitionType]}.` : "";
        const timestamp = index ? formatShotTimestamp(string(shot.switchTime)) : "";
        const time = timestamp ? ` At ${timestamp},` : "";
        const pictureId = string(shot.pictureBindingId);
        let picture = "";
        if (pictureId) {
            const binding = byId.get(pictureId);
            if (!binding || binding.enabled === false || binding.type !== "image" || inferReferenceRole(binding) !== "storyboard" || !(binding.url || binding.storageKey)) {
                throw new Error(`分镜 ${index + 1} 绑定的分镜图不存在或不是当前 Clip 的有效分镜图：${pictureId}`);
            }
            const panel = composite?.panels.find((item) => item.bindingId === pictureId);
            const position = panel ? ` In the composite storyboard image, this is Panel ${panel.index} (row ${panel.row}, column ${panel.column}), shared by ${panel.shotNumbers.map((number) => `[Shot ${number}]`).join(", ")}.` : "";
            picture = ` Use the approved ${pictureDescription(binding, catalog) || "storyboard frame"} from ${pictureTagForId(pictureId)} as the shot-entry keyframe and composition anchor for this shot. After the keyframe, keep the camera setup and spatial relationship stable while allowing natural performance.${position}`;
        }
        const normalizedDescription = stripStoryboardCues(normalizeLegacyReferences(index ? stripDuplicateTransition(string(shot.description), transitionType) : string(shot.description)));
        const extraPanelIds = [...new Set(Array.from(normalizedDescription.matchAll(/<Picture\s+(\d+)>/giu), (match) => originalPictureRefs[Number(match[1]) - 1]?.bindingId).filter((id): id is string => Boolean(id)))];
        const extraPanels = composite ? extraPanelIds
            .filter((id) => id !== pictureId).map((id) => composite.panels.find((panel) => panel.bindingId === id)).filter(Boolean)
            .map((panel) => `This shot uses composite storyboard Panel ${panel!.index} (row ${panel!.row}, column ${panel!.column}).`).join(" ") : "";
        return `[Shot ${index + 1}]${time}${transition}${picture}${extraPanels ? ` ${extraPanels}` : ""}${normalizedDescription ? ` ${remapDescription(normalizedDescription)}` : ""}`;
    });
    return [STORYBOARD_KEYFRAME_GUIDANCE, string(input.openingDescription), details.join("\n")].filter(Boolean).join("\n\n");
}

function subjectAppearsInShot(subject: PromptSubject, shot: PromptShot, subjectOrdinal: number) {
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

function buildPromptText(subjects: PromptSubject[], references: PromptReference[], shots: PromptShot[]) {
    const blockingTags = new Set(references.filter((reference) => reference.type === "image" && reference.role === "blocking").map((reference) => reference.tag));
    const subjectOrdinalById = new Map(subjects.map((subject, index) => [subject.id, index + 1]));
    const subjectMarker = (subject: PromptSubject) => `<Subject ${subjectOrdinalById.get(subject.id) || 1}>`;
    const subjectDefinitions = subjects.map((subject) => {
        const identity = [subject.name, subject.englishName && subject.englishName !== subject.name ? subject.englishName : ""].filter(Boolean).join(" / ");
        const details = promptDetails([subject.profile, ...subject.outfits]);
        const identityPictures = subject.pictures.filter((tag) => !blockingTags.has(tag));
        const blockingPictures = subject.pictures.filter((tag) => blockingTags.has(tag));
        if (identityPictures.length) details.unshift(`visual identity defined by reference(s) ${identityPictures.join(", ")}`);
        if (blockingPictures.length) details.push(`spatial blocking guided by ${blockingPictures.join(", ")}`);
        if (!details.length) details.push("visual features follow the linked reference");
        return `${subjectMarker(subject)} is ${identity || subject.id}. ${details.join("; ")}.`;
    }).join("\n");

    const isPictureAnchor = (reference: PromptReference) => reference.type === "image" && (
        reference.usage === "first_frame" || reference.usage === "last_frame" ||
        reference.role === "storyboard" || reference.role === "blocking" || (reference.role === "keyframe" && reference.shotNumbers.length > 0)
    );
    const trackedReferences = references.filter((reference) => reference.type !== "image" || isPictureAnchor(reference));
    const referenceDefinitions = trackedReferences.map((reference) => {
        const mappedSubjects = ((reference.subjectIds?.length ? reference.subjectIds : reference.subjectId ? [reference.subjectId] : []))
            .flatMap((id) => subjects.filter((subject) => subject.id === id));
        const mappedSubject = reference.subjectId ? mappedSubjects.find((subject) => subject.id === reference.subjectId) : mappedSubjects[0];
        const subjectToken = mappedSubjects.map(subjectMarker).join(", ");
        const shotsForReference = [...new Set([
            ...reference.shotNumbers,
            ...shots.flatMap((shot, index) => (shot.referenceIds || []).includes(reference.bindingId) ? [index + 1] : []),
        ])].sort((a, b) => a - b).map((number) => `[Shot ${number}]`);
        if (reference.type === "image") {
            const picture = reference.tag;
            if (reference.role === "blocking") {
                const scope = shotsForReference.join(", ") || "the target shot sequence";
                return `${picture} is the blocking and 180-degree action-axis map for ${scope}, defining relative subject positions, orientation, sightlines, entrances, and movement paths${reference.description ? `: ${reference.description}` : ""}. It is a spatial plan, not a rendered frame or character identity source.`;
            }
            if (reference.role === "storyboard" && reference.compositePanels?.length) {
                const panelMap = reference.compositePanels.map((panel) => `Panel ${panel.index} (row ${panel.row}, column ${panel.column}) corresponds to ${panel.shotNumbers.map((number) => `[Shot ${number}]`).join(", ") || "no assigned shot"}`).join("; ");
                return `${picture} is one composite storyboard image arranged as a grid, not a single storyboard frame. Read each panel independently: ${panelMap}. The sheet defines viewpoint, subject placement, and shot order.`;
            }
            const frameUse = reference.usage === "first_frame"
                ? `the locked opening frame of ${shotsForReference[0] || "[Shot 1]"} (visible at 00:00 of the clip)`
                : reference.usage === "last_frame"
                    ? `the locked closing frame of ${shotsForReference[shotsForReference.length - 1] || `[Shot ${Math.max(1, shots.length)}]`}`
                    : reference.role === "storyboard"
                        ? `the approved storyboard keyframe at the entry of ${shotsForReference.join(", ") || "the target shot sequence"}`
                        : `a keyframe anchoring the composition of ${shotsForReference.join(", ")}`;
            const plan = reference.role === "storyboard"
                ? "defining the entry viewpoint, subject placement, and shot setup; after the keyframe, the actors can perform naturally while the camera remains stable"
                : "defining the target composition and visible subject state";
            const showing = subjectToken ? `, showing ${subjectToken}` : "";
            const detail = reference.description ? `: ${reference.description}` : "";
            return `${picture} is ${frameUse}${showing}, ${plan}${detail}.`;
        }
        if (reference.type === "audio") {
            if (reference.role === "character_voice") {
                const who = mappedSubject ? subjectMarker(mappedSubject) : reference.subjectName || "the target speaker";
                const speaker = reference.speakerId ? ` (${reference.speakerId})` : "";
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
        const appearances = shots.flatMap((shot, index) => subjectAppearsInShot(subject, shot, subjectIndex + 1) ? [`[Shot ${index + 1}]`] : []);
        const scope = appearances.length ? `appears in ${appearances.join(", ")}` : "no shot appearance is explicitly assigned";
        const relationship = appearances.length ? "fully_preserved" : "weak_reference";
        const details = appearances.length
            ? "preserve only the identity, appearance, and costume attributes defined above; shot-specific actions, blocking, and settings follow the shot description"
            : "the reference remains a visual guide but is not explicitly used in a shot";
        return `${subjectMarker(subject)} (${scope}): ${relationship} - ${details}.`;
    }).join("\n");

    const referenceRetention = trackedReferences.map((reference) => {
        const mappedSubject = reference.subjectId ? subjects.find((subject) => subject.id === reference.subjectId) : undefined;
        const shotsForReference = [...new Set([
            ...reference.shotNumbers,
            ...shots.flatMap((shot, index) => (shot.referenceIds || []).includes(reference.bindingId) ? [index + 1] : []),
        ])].sort((a, b) => a - b).map((number) => `[Shot ${number}]`);
        if (reference.type === "audio") return `${reference.tag}: reference - ${reference.role === "character_voice" ? `use only its voice characteristics for new dialogue by ${mappedSubject ? subjectMarker(mappedSubject) : reference.subjectName || "the target speaker"}; do not copy the source signal.` : "refer to its sound characteristics without copying the source signal."}`;
        if (reference.type === "video") {
            const scope = reference.role === "motion_reference" ? "camera movement and motion pacing" : "scene structure and pacing";
            return `${reference.tag} (${scope}): weak_reference - use the video for the role defined above without reproducing it frame by frame.`;
        }
        if (reference.role === "blocking") {
            const scope = shotsForReference.join(", ") || "target shot sequence";
            const level = reference.retentionLevel || "fully_preserved";
            const details: Record<NonNullable<PromptReference["retentionLevel"]>, string> = {
                fully_preserved: "preserve the defined relative positions, movement paths, screen direction, and 180-degree action axis across shots without copying the overhead diagram into a rendered frame",
                partially_preserved: "retain the selected spatial relationships and action axis while following shot-specific blocking changes",
                attribute_transfer: "transfer the defined spatial relationships and action axis into the target shots without reproducing the diagram",
                weak_reference: "use the spatial arrangement and action axis only as broad guidance",
            };
            return `${reference.tag} (${scope}): ${level} - ${details[level]}.`;
        }
        const frame = reference.usage === "first_frame" ? "first-frame" : reference.usage === "last_frame" ? "last-frame" : reference.role === "storyboard" ? "storyboard composition" : "keyframe composition";
        const frameScope = reference.usage === "first_frame"
            ? `${shotsForReference[0] || "[Shot 1]"} first frame`
            : reference.usage === "last_frame"
                ? `${shotsForReference[shotsForReference.length - 1] || `[Shot ${Math.max(1, shots.length)}]`} last frame`
                : shotsForReference.join(", ") || (reference.role === "storyboard" ? "target shot sequence" : "");
        const level = reference.retentionLevel || "fully_preserved";
        const subjectTokens = (reference.subjectIds?.length ? reference.subjectIds : reference.subjectId ? [reference.subjectId] : [])
            .flatMap((id) => subjects.filter((subject) => subject.id === id).map(subjectMarker));
        const details: Record<NonNullable<PromptReference["retentionLevel"]>, string> = {
            fully_preserved: reference.role === "storyboard"
                ? `preserve the defined ${frame} entry viewpoint, subject placement, and shot setup, then allow natural performance while the camera remains stable`
                : `preserve the defined ${frame} role and its target viewpoint, subject placement, and visual state`,
            partially_preserved: `retain the selected visual features of the ${frame} while allowing other source-composition details to change`,
            attribute_transfer: `transfer the defined visual attributes${subjectTokens.length ? ` to ${subjectTokens.join(", ")}` : " to the target shot"} without reproducing the source frame as a whole`,
            weak_reference: `use the ${frame} only as broad visual and composition guidance`,
        };
        const panelMap = reference.compositePanels?.length
            ? ` Composite storyboard map: ${reference.compositePanels.map((panel) => `Panel ${panel.index} (row ${panel.row}, column ${panel.column}) = ${panel.shotNumbers.map((number) => `[Shot ${number}]`).join(", ") || "no assigned shot"}`).join("; ")}.`
            : "";
        return `${reference.tag}${frameScope ? ` (${frameScope})` : ""}: ${level} - ${details[level]}.${panelMap}`;
    }).join("\n");
    const result = { subjectDefinitions: [subjectDefinitions, referenceDefinitions].filter(Boolean).join("\n"), retentionAnalysis: [retentionAnalysis, referenceRetention].filter(Boolean).join("\n") };
    validateDefinitionCoverage(subjects, references, result.subjectDefinitions, result.retentionAnalysis);
    return result;
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
    const allRefs = bindings.filter((binding) => binding.enabled !== false && (binding.url || binding.storageKey)).map((binding) => ({
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
    const composite = storyboardCompositePlan(segment.storyboardCompositeEnabled === true && promptMode === "ref2va", input.shots, bindings);
    const compositeSourceIds = new Set(composite?.panels.map((panel) => panel.bindingId) || []);
    const representativeBindingId = composite?.panels[0]?.bindingId || "";
    const compositeSubjectIds = [...new Set(bindings.filter((binding) => compositeSourceIds.has(binding.id)).flatMap((binding) => [binding.subjectId, binding.groupId, ...(binding.storyboardSubjectIds || [])]).filter((id): id is string => Boolean(id)))];
    const refs = composite ? allRefs.flatMap((ref) => {
        const id = string(ref.bindingId);
        if (!compositeSourceIds.has(id)) return [ref];
        return id === representativeBindingId ? [{ ...ref, name: "合成分镜图", assetId: `storyboard-composite-${createHash("sha256").update(JSON.stringify(composite.panels)).digest("hex").slice(0, 20)}`, storyboardSubjectIds: compositeSubjectIds, compositePanels: composite.panels.map(({ index, row, column, shotNumbers }) => ({ index, row, column, shotNumbers })) }] : [];
    }) : allRefs;
    const pictureBindings = allRefs.filter((ref) => ref.type === "image");
    const shotReferenceIds = new Set(input.shots.flatMap((shot) => [
        ...(string(shot.pictureBindingId) ? [string(shot.pictureBindingId)] : []),
        ...Array.from(string(shot.description).matchAll(/<Picture\s+(\d+)>/giu), (match) => pictureBindings[Number(match[1]) - 1]?.bindingId).filter((id): id is string => Boolean(id)),
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
        const audioSubjectName = string(sourceGroup?.characterName || sourceMetadata.characterName || sourceNode?.title);
        const referenceDescription = type === "image" && !(composite && string(ref.bindingId) === representativeBindingId)
            ? pictureDescription(ref, catalog)
            : type === "image" ? ""
            : string(record(asset?.analysis).summary || record(ref.analysis).summary || record(sourceGroup?.voice).description || sourceMetadata.characterVoiceDescription);
        const mappedIds = type === "image" ? [...new Set([declaredSubjectId, string(ref.groupId), ...(Array.isArray(ref.storyboardSubjectIds) ? ref.storyboardSubjectIds.map(String) : [])].filter(Boolean))] : [];
        const anchor = type === "image" && (string(ref.usage) === "first_frame" || string(ref.usage) === "last_frame" || role === "storyboard" || role === "blocking" || (role === "keyframe" && shotReferenceIds.has(string(ref.bindingId))));
        const ids = mappedIds.length ? mappedIds : type === "image" && sourceCharacterId ? [sourceCharacterId] : type === "image" && !anchor && string(ref.bindingId) ? [string(ref.bindingId)] : [];
        const subjectIds = new Set<string>();
        for (const id of ids) {
            const group = groupFor(id) || Object.values(groups).map(record).find((item) => item.subjectId === id || item.characterNodeId === id);
            const subjectId = string(group?.subjectId || group?.characterNodeId || id);
            const characterNode = group?.characterNodeId ? nodeById.get(string(group.characterNodeId)) : id === sourceCharacterId ? sourceNode : nodeById.get(id);
            const metadata = record(characterNode?.metadata);
            const isCharacter = Boolean(group || characterNode?.type === "character" || role === "character_identity" || role === "character_turnaround");
            // 非角色图片主体（场景/道具/风格等）命名禁止落到文件名——按参考用途给稳定英文名。
            const roleFallbackName: Record<string, string> = { scene: "Scene", prop: "Prop", style: "Style", palette: "Palette", blocking: "Blocking", storyboard: "Storyboard" };
            const name = string(group?.characterName || metadata.characterName || characterNode?.title || (isCharacter ? ref.name : roleFallbackName[role] || "Reference"));
            const englishName = string(metadata.characterEnglishName);
            const profile = [string(metadata.characterDescription), role === "storyboard" && anchor ? "" : referenceDescription].filter((value, index, all) => value && all.indexOf(value) === index).join("; ");
            const entry = subjects.get(subjectId) || { id: subjectId, name, englishName: englishName || undefined, aliases: new Set<string>(), shotMarkers: new Set<string>(), profile, outfits: new Set<string>(), pictures: [], role };
            [id, group?.id, group?.subjectId, group?.characterNodeId, group?.characterName, characterNode?.id, characterNode?.title, metadata.characterName, englishName]
                .forEach((alias) => { if (typeof alias === "string" && alias.trim()) entry.aliases.add(alias.trim()); });
            if (ref.bindingId) subjectIds.add(subjectId);
            if (ref.bindingId && type === "image") entry.shotMarkers.add(string(ref.bindingId));
            if (group && ref.outfitId) {
                const outfits = Array.isArray(group.outfits) ? group.outfits.map(record) : [];
                const outfit = outfits.find((item) => item.id === ref.outfitId);
                const images = Array.isArray(metadata.characterImages) ? metadata.characterImages.map(record) : [];
                const image = images.find((item) => String(item.outfit || item.name || "") === outfit?.name);
                const outfitDescription = string(image?.outfitDescription);
                if (outfitDescription) entry.outfits.add(outfitDescription);
            }
            const pictureMarker = tag;
            // Storyboard frames are concrete shot anchors, not reusable subject identity.
            // Keeping them out of <Subject> prevents a frame composition from leaking into
            // every later shot that mentions the same subject.
            if (!entry.pictures.includes(pictureMarker) && type === "image" && role !== "storyboard" && role !== "blocking") entry.pictures.push(pictureMarker);
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
            ...(Array.isArray(ref.compositePanels) ? { compositePanels: ref.compositePanels as PromptReference["compositePanels"] } : {}),
            shotNumbers: [],
        };
    });

    // 服装关闭但声线开启的角色仍必须进入主体定义与保留分析，否则人物在提示词里凭空消失。
    for (const reference of referenceManifest) {
        if (reference.type !== "audio" || reference.role !== "character_voice" || !reference.subjectId) continue;
        if (subjects.has(reference.subjectId)) continue;
        const group = groupFor(reference.subjectId) || Object.values(groups).map(record).find((item) => item.subjectId === reference.subjectId || item.characterNodeId === reference.subjectId);
        const characterNode = group?.characterNodeId ? nodeById.get(string(group.characterNodeId)) : nodeById.get(reference.subjectId);
        const metadata = record(characterNode?.metadata);
        const name = string(group?.characterName || metadata.characterName || characterNode?.title || reference.subjectName) || reference.subjectId;
        const profile = [string(metadata.characterDescription), string(record(group?.voice).description) || reference.description].filter((value, index, all) => value && all.indexOf(value) === index).join("; ");
        const entry = subjects.get(reference.subjectId) || { id: reference.subjectId, name, aliases: new Set<string>(), shotMarkers: new Set<string>(), profile, outfits: new Set<string>(), pictures: [], role: "character_identity" };
        [reference.subjectId, group?.id, group?.characterNodeId, group?.characterName, characterNode?.id, characterNode?.title, metadata.characterName]
            .forEach((alias) => { if (typeof alias === "string" && alias.trim()) entry.aliases.add(alias.trim()); });
        if (!entry.profile && profile) entry.profile = profile;
        if (entry.name === entry.id && name !== reference.subjectId) entry.name = name;
        subjects.set(reference.subjectId, entry);
    }
    const voiceReferences = referenceManifest.filter((reference) => reference.type === "audio" && reference.role === "character_voice" && reference.subjectId);
    const speakerBySubject = new Map<string, string>();
    const explicitSpeakerId = (subjectId: string) => {
        const subject = subjects.get(subjectId);
        if (!subject) return "";
        const subjectOrdinal = [...subjects.keys()].indexOf(subjectId) + 1;
        const aliases = [`<Subject ${subjectOrdinal}>`, subject.name, subject.englishName || "", ...subject.aliases].filter(Boolean);
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
    validatePromptReferences([input.summary, input.openingDescription, ...input.shots.map((shot) => shot.description), input.overallSoundscape, input.nonDiegeticMusic].join("\n"), allRefs.map((ref) => ({ type: string(ref.type), bindingId: string(ref.bindingId) })), subjectManifest.length);
    const normalizeLegacyReferences = (description: string) => description.replace(/\{\{\s*ref:\s*([^{}]+?)\s*\}\}/gu, (marker, rawId: string) => {
        const id = rawId.trim();
        const finalId = compositeSourceIds.has(id) ? representativeBindingId : id;
        return referencesWithSpeakers.find((reference) => reference.bindingId === finalId)?.tag || marker;
    });
    const normalizedShots = input.shots.map((shot) => {
        const description = normalizeLegacyReferences(string(shot.description));
        return {
            description,
            switchTime: string(shot.switchTime),
            transitionType: shot.transitionType || "cut",
            pictureBindingId: compositeSourceIds.has(string(shot.pictureBindingId)) ? representativeBindingId : string(shot.pictureBindingId),
            pictureDescription: string(shot.pictureBindingId) ? pictureDescription(allRefs.find((ref) => ref.bindingId === shot.pictureBindingId) || { name: "", url: "", type: "image", bindingId: shot.pictureBindingId }, catalog) : "",
            referenceIds: [...new Set([
                ...Array.from(description.matchAll(/<Picture\s+(\d+)>/giu), (match) => pictureBindings[Number(match[1]) - 1]?.bindingId).filter((id): id is string => Boolean(id)),
                ...(string(shot.pictureBindingId) ? [string(shot.pictureBindingId)] : []),
            ].map((id) => compositeSourceIds.has(id) ? representativeBindingId : id))],
        };
    });
    const finalReferences = referencesWithSpeakers.map((reference) => ({
        ...reference,
        shotNumbers: normalizedShots.flatMap((shot, index) => shot.referenceIds.includes(reference.bindingId) ? [index + 1] : []),
    }));
    const summary = ref2va ? normalizeRef2vaSummary(input.summary, {
        hasStoryboardFrames: finalReferences.some((reference) => reference.type === "image" && reference.role === "storyboard" && reference.shotNumbers.length > 0),
        hasReferenceImages: finalReferences.some((reference) => reference.type === "image"),
        hasAudioReference: finalReferences.some((reference) => reference.type === "audio"),
    }) : string(input.summary);
    const storyboardDurations = deriveStoryboardDurations(normalizedShots, segment.duration);
    const content = {
        version: 13,
        storyboardComposite: { enabled: segment.storyboardCompositeEnabled === true, ...(composite ? { rows: composite.rows, columns: composite.columns, panels: composite.panels, sourceIdentity: allRefs.filter((ref) => compositeSourceIds.has(string(ref.bindingId))).map((ref) => ({ bindingId: ref.bindingId, assetId: ref.assetId, storageKey: ref.storageKey || "", url: ref.storageKey ? "" : ref.url || "" })) } : {}) },
        summary,
        openingDescription: string(input.openingDescription),
        shots: normalizedShots,
        storyboardDurations,
        overallSoundscape: string(input.overallSoundscape),
        nonDiegeticMusic: string(input.nonDiegeticMusic),
        references: finalReferences,
        referenceIdentity: allRefs.map((ref) => ({
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
    const prompt = assembleH3Prompt(promptMode, {
        ...(ref2va ? {
            subject_definitions: generated.subjectDefinitions,
            summary,
            retention_analysis: generated.retentionAnalysis,
        } : {}),
        [storyboardSection]: promptForShots(input, allRefs, catalog, composite, finalReferences),
        overall_soundscape: string(input.overallSoundscape),
        non_diegetic_music: string(input.nonDiegeticMusic),
    });
    return { prompt, fingerprint, subjectDefinitions: generated.subjectDefinitions, retentionAnalysis: generated.retentionAnalysis, subjectCount: subjectManifest.length, shotCount: input.shots.length, storyboardDurations, content };
}

export function writeStoryboardPrompt(project: RecordValue, segment: RecordValue, rawInput: RecordValue) {
    const originalInput = rawInput as StoryboardInput;
    if (!Array.isArray(originalInput.shots) || !originalInput.shots.length) throw new Error("分镜至少需要一镜");
    const originalBindings = referenceBindingsOf(segment).bindings;
    const bindings = orderStoryboardImageReferences(originalBindings,
        originalInput.shots.flatMap((shot) => string(shot.pictureBindingId) ? [string(shot.pictureBindingId)] : []),
        (binding) => binding.id,
        (binding) => binding.enabled && Boolean(binding.url || binding.storageKey) && binding.role === "storyboard" && (binding.mediaType || inferReferenceMediaType(binding)) === "image");
    const orderChanged = bindings.some((binding, index) => binding.id !== originalBindings[index]?.id);
    const storyboardIds = new Set(bindings.filter((binding) => binding.enabled && (binding.url || binding.storageKey) && binding.role === "storyboard").map((binding) => binding.id));
    const existingShots = Array.isArray(segment.storyboardShots) ? segment.storyboardShots.map(record) : undefined;
    const orderedShots = existingShots && orderStoryboardImageReferences(existingShots,
        originalInput.shots.flatMap((shot) => string(shot.pictureBindingId) ? [string(shot.pictureBindingId)] : []),
        (shot) => string(shot.referenceBindingId), (shot) => storyboardIds.has(string(shot.referenceBindingId)));
    const shotOrderChanged = Boolean(orderedShots?.some((shot, index) => shot.id !== existingShots?.[index]?.id));
    const remap = (value: string) => orderChanged
        ? remapPictureTags(value, originalBindings.filter((binding) => binding.enabled && (binding.url || binding.storageKey)), bindings.filter((binding) => binding.enabled && (binding.url || binding.storageKey)),
            (binding) => binding.id, (binding) => (binding.mediaType || inferReferenceMediaType(binding)) === "image")
        : value;
    const input: StoryboardInput = {
        ...originalInput,
        summary: remap(originalInput.summary || ""),
        openingDescription: remap(originalInput.openingDescription),
        shots: originalInput.shots.map((shot) => ({ ...shot, description: remap(shot.description) })),
        overallSoundscape: remap(originalInput.overallSoundscape),
        nonDiegeticMusic: remap(originalInput.nonDiegeticMusic),
    };
    validateStoryboardShotDescriptions(input.shots);
    validateShotTimeline(input.shots, segment.duration === undefined ? undefined : Number(segment.duration));
    const generated = buildPromptSections(project, segment, input, bindings);
    const cache = record(segment.storyboardPromptCache);
    const promptMode = promptModeOf(segment);
    if (!orderChanged && !shotOrderChanged && promptMode === "ref2va" && cache.version === 13 && cache.fingerprint === generated.fingerprint && string(segment.prompt) === generated.prompt) return { ...generated, unchanged: true as const };
    if (!orderChanged && !shotOrderChanged && promptMode !== "ref2va" && string(segment.prompt) === generated.prompt) return { ...generated, unchanged: true as const };
    return {
        ...generated,
        unchanged: false as const,
        ...(orderChanged ? { referenceBindings: bindings } : {}),
        ...(shotOrderChanged ? { storyboardShots: orderedShots } : {}),
        ...(promptMode === "ref2va" ? { cache: { version: 13, fingerprint: generated.fingerprint, subjectDefinitions: generated.subjectDefinitions, retentionAnalysis: generated.retentionAnalysis } } : {}),
    };
}
