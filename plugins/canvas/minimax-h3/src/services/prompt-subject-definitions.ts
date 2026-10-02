/** Ref2VA 的 Subject 可以是人物、道具或场景，不能只按角色绑定来识别。 */
export type LiteralPromptSubject = {
    ordinal: number;
    description: string;
    pictureOrdinal?: number;
};

/** 仅把 subject_definitions 中逐行定义的标签视为有效主体。 */
export function literalPromptSubjects(prompt: string): LiteralPromptSubject[] {
    const header = /^subject_definitions\s*:[ \t]*(?:\r?\n)?/im.exec(prompt);
    if (!header) return [];
    const remainder = prompt.slice(header.index + header[0].length);
    const nextSection = /^(?:summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music|storyboard_timeline)\s*:/im.exec(remainder);
    const section = remainder.slice(0, nextSection?.index ?? remainder.length);
    const subjects = new Map<number, LiteralPromptSubject>();
    for (const match of section.matchAll(/^[ \t]*<Subject[ \t]+(\d+)>[ \t]+([^\r\n]+)/gim)) {
        const ordinal = Number(match[1]);
        if (!Number.isSafeInteger(ordinal) || ordinal < 1 || subjects.has(ordinal)) continue;
        const description = match[2].trim();
        if (!description) continue;
        const picture = /<Picture[ \t]+(\d+)>/i.exec(description);
        const pictureOrdinal = picture ? Number(picture[1]) : undefined;
        subjects.set(ordinal, { ordinal, description, ...(pictureOrdinal ? { pictureOrdinal } : {}) });
    }
    return [...subjects.values()];
}
