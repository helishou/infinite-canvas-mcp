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
};

export type StoryboardPromptShot = { description: string; referenceIds?: string[] };

export async function storyboardPromptFingerprint(input: unknown) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function subjectAppearsInShot(subject: StoryboardPromptSubject, shot: StoryboardPromptShot) {
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

function shotText(reference: StoryboardPromptReference, shots: StoryboardPromptShot[]) {
    return [...new Set([
        ...reference.shotNumbers,
        ...shots.flatMap((shot, index) => (shot.referenceIds || []).includes(reference.bindingId) ? [index + 1] : []),
    ])].sort((a, b) => a - b).map((number) => `[Shot ${number}]`);
}

function pictureFrameScope(reference: StoryboardPromptReference, shotsForReference: string[], shotCount: number) {
    if (reference.usage === "first_frame") return `${shotsForReference[0] || "[Shot 1]"} first frame`;
    if (reference.usage === "last_frame") return `${shotsForReference[shotsForReference.length - 1] || `[Shot ${Math.max(1, shotCount)}]`} last frame`;
    return shotsForReference.join(", ") || (reference.role === "storyboard" ? "target shot sequence" : "");
}

function isPictureAnchor(reference: StoryboardPromptReference) {
    if (reference.type !== "image") return false;
    return reference.usage === "first_frame" || reference.usage === "last_frame" ||
        reference.role === "storyboard" || (reference.role === "keyframe" && reference.shotNumbers.length > 0);
}

function trackedReferences(references: StoryboardPromptReference[]) {
    return references.filter((reference) => reference.type !== "image" || isPictureAnchor(reference));
}

export function buildStoryboardPromptSections(subjects: StoryboardPromptSubject[], references: StoryboardPromptReference[], shots: StoryboardPromptShot[]) {
    const subjectDefinitions = subjects.map((subject) => {
        const identity = [subject.name, subject.englishName && subject.englishName !== subject.name ? subject.englishName : ""].filter(Boolean).join(" / ");
        const details = [subject.profile, ...subject.outfits].map((value) => value.trim()).filter(Boolean);
        if (subject.pictures.length) details.unshift(`visual identity and defining features sourced from ${subject.pictures.join(", ")}`);
        if (!details.length) details.push("visual features follow the linked reference");
        return `{{subject:${subject.id}}} is ${identity || subject.id}. ${details.join("; ")}.`;
    }).join("\n");

    const referenceDefinitions = trackedReferences(references).map((reference) => {
        const referenceMarker = reference.type === "image" && reference.bindingId ? `{{ref:${reference.bindingId}}}` : reference.tag;
        const mappedSubjects = ((reference.subjectIds?.length ? reference.subjectIds : reference.subjectId ? [reference.subjectId] : []))
            .flatMap((id) => subjects.filter((subject) => subject.id === id));
        const subjectTokens = mappedSubjects.map((subject) => `{{subject:${subject.id}}}`);
        const subjectToken = subjectTokens.join(", ");
        const shotsForReference = shotText(reference, shots);
        if (reference.type === "image") {
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
            return `${referenceMarker} is ${frameUse}${showing}, ${plan}${detail}.`;
        }
        if (reference.type === "audio") {
            const speaker = reference.speakerId ? ` (${reference.speakerId})` : "";
            if (reference.role === "character_voice") {
                const who = subjectToken || reference.subjectName || reference.label || "the target speaker";
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

    const referenceRetention = trackedReferences(references).map((reference) => {
        const referenceMarker = reference.type === "image" && reference.bindingId ? `{{ref:${reference.bindingId}}}` : reference.tag;
        const shotsForReference = shotText(reference, shots);
        if (reference.type === "audio") {
            return `${reference.tag}: reference - ${reference.role === "character_voice" ? `use its voice characteristics for new dialogue by ${reference.subjectName || reference.label || "the target speaker"}; do not copy the source signal.` : "refer to its sound characteristics without copying the source signal."}`;
        }
        if (reference.type === "video") {
            const scope = reference.role === "motion_reference" ? "camera movement and motion" : "cut and pacing structure";
            const use = reference.role === "motion_reference" ? "use its motion characteristics as guidance" : "use its visual structure as guidance";
            return `${reference.tag} (${scope}): weak_reference - ${use} without reproducing the source video frame by frame.`;
        }
        const frame = reference.usage === "first_frame" ? "first-frame" : reference.usage === "last_frame" ? "last-frame" : reference.role === "storyboard" ? "storyboard composition" : "keyframe composition";
        const frameScope = pictureFrameScope(reference, shotsForReference, shots.length);
        const level = reference.retentionLevel || "fully_preserved";
        const mappedSubjects = ((reference.subjectIds?.length ? reference.subjectIds : reference.subjectId ? [reference.subjectId] : []))
            .flatMap((id) => subjects.filter((subject) => subject.id === id));
        const subjectTokens = mappedSubjects.map((subject) => `{{subject:${subject.id}}}`);
        const details: Record<NonNullable<StoryboardPromptReference["retentionLevel"]>, string> = {
            fully_preserved: `preserve the defined ${frame} role and its target viewpoint, subject placement, and visual state`,
            partially_preserved: `retain the selected visual features of the ${frame} while allowing other source-composition details to change`,
            attribute_transfer: `transfer the defined visual attributes${subjectTokens.length ? ` to ${subjectTokens.join(", ")}` : " to the target shot"} without reproducing the source frame as a whole`,
            weak_reference: `use the ${frame} only as broad visual and composition guidance`,
        };
        return `${referenceMarker}${frameScope ? ` (${frameScope})` : ""}: ${level} - ${details[level]}.`;
    }).join("\n");

    return { subjectDefinitions: [subjectDefinitions, referenceDefinitions].filter(Boolean).join("\n"), retentionAnalysis: [retentionAnalysis, referenceRetention].filter(Boolean).join("\n") };
}
