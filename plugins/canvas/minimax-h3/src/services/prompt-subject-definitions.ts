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

/**
 * Formal v2 prompt definitions own the Subject ordinal and display name.
 * Picture ordinals remain independent and never decide Subject identity.
 *
 * 正文只写“the person shown in <Picture 1>”这类描述时，引号里不是实体名，
 * 直接当名称显示会让编辑器的引用块写成一句描述。此时用被引用的素材名兜底。
 */
export function bindLiteralSubjectsToReferences(
    subjects: LiteralPromptSubject[],
    options: { referenceName?: (subject: LiteralPromptSubject) => string | undefined } = {},
) {
    return subjects.map((subject) => {
        // Subject and Picture ordinals are independent. A cited Picture can be
        // an environment, a character image, or another kind of visual source;
        // it does not determine the identity or type of the Subject token.
        const id = `prompt-subject-${subject.ordinal}`;
        const identity = subject.description.replace(/^is\s+/iu, "").split(/[;,，。]/u, 1)[0]?.trim() || id;
        const name = /<(?:Subject|Picture|Video|Audio)\s+\d+>/iu.test(identity)
            ? options.referenceName?.(subject)?.trim() || `Subject ${subject.ordinal}`
            : identity;
        return {
            id,
            name,
            pictures: [],
            ...(/\bidentity\s*:/iu.test(subject.description) ? { role: "character_identity" } : {}),
        };
    });
}
