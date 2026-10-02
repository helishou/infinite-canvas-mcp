import { promptDetails } from "./prompt-rules.js";

export type H3SubjectDefinition = {
    id: string;
    name: string;
    englishName?: string;
    pictures?: string[];
    /** 按当前 Clip 的稳定 reference bindingId 保存，不能用 Picture 编号作键。 */
    pictureDescriptions?: Record<string, string>;
    /** 主体整体补充说明；保留旧数据，不能分摊给每张来源图。 */
    profile?: string;
    outfits?: string[];
    role?: string;
};

export type StoryboardPromptSubject = {
    id: string;
    name: string;
    englishName?: string;
    aliases: string[];
    shotMarkers: string[];
    profile: string;
    outfits: string[];
    pictures: string[];
    pictureDescriptions?: Record<string, string>;
    role?: string;
};

/** 用户清单是主体与顺序的权威；明确的空来源数组表示清除来源。 */
export function mergeSubjectDefinitions(ruleSubjects: StoryboardPromptSubject[], override?: H3SubjectDefinition[] | null): StoryboardPromptSubject[] {
    if (!override?.length) return ruleSubjects;
    const byId = new Map(ruleSubjects.map((subject) => [subject.id, subject]));
    return override.map((definition) => {
        const base = byId.get(definition.id);
        const pictures = definition.pictures ?? base?.pictures ?? [];
        const profile = definition.profile ?? base?.profile ?? "";
        return {
            id: definition.id,
            name: definition.name?.trim() || base?.name || definition.id,
            englishName: definition.englishName?.trim() || base?.englishName,
            aliases: base?.aliases || [],
            shotMarkers: base?.shotMarkers || [],
            profile: profile || (pictures.length ? "" : "visual features follow the linked reference"),
            outfits: definition.outfits?.length ? definition.outfits : base?.outfits || [],
            pictures,
            pictureDescriptions: { ...base?.pictureDescriptions, ...definition.pictureDescriptions },
            role: definition.role || base?.role,
        };
    });
}

export function toSubjectDefinitions(subjects: StoryboardPromptSubject[]): H3SubjectDefinition[] {
    return subjects.map((subject) => ({
        id: subject.id, name: subject.name, englishName: subject.englishName,
        pictures: [...subject.pictures], profile: subject.profile, outfits: [...subject.outfits], role: subject.role,
        ...(subject.pictureDescriptions ? { pictureDescriptions: { ...subject.pictureDescriptions } } : {}),
    }));
}

/** 只输出当前选中且仍有效的视觉来源；未填写时采用该来源自己的分析。 */
export function subjectVisualSourceDetails(
    subject: Pick<StoryboardPromptSubject, "pictures" | "pictureDescriptions">,
    references: Array<{ tag: string; bindingId: string; type: string; role: string; description: string }>,
) {
    return subject.pictures.flatMap((tag) => {
        const reference = references.find((item) => item.tag === tag && item.type === "image");
        if (!reference || ["storyboard", "blocking"].includes(reference.role)) return [];
        const manual = subject.pictureDescriptions?.[reference.bindingId];
        const details = promptDetails([typeof manual === "string" && manual.trim() ? manual : reference.description]);
        return details.length ? [`${tag} visual attributes: ${details.join("; ")}`] : [];
    });
}
