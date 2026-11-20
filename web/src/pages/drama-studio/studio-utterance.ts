/**
 * 导演源稿台词视图（web 本地纯函数，不依赖 canvas-agent dist）。
 *
 * 新剧目真值在 draft.director.source.utterances[]，镜头通过 shot.utterance_refs[]
 * 以 utteranceId 关联；老剧目回填的 shot.dialogues[] 仍然是兼容来源。
 * 说话人解析与 screenplayData 同款：speakerSubjectId → subject_registry.entityRef.id
 * → character_registry.name，缺失再回退 speakerName / speakerSubjectId。
 */
export type StudioSource = Record<string, any>;
export type StudioRow = Record<string, any>;

export const studioRows = (value: unknown): StudioRow[] =>
    Array.isArray(value)
        ? value.filter((x): x is StudioRow => Boolean(x) && typeof x === "object" && !Array.isArray(x))
        : [];

const studioStr = (value: unknown): string =>
    (typeof value === "string" || typeof value === "number") ? String(value) : "";

export type SpeakerRegistry = { subjectById: Map<string, StudioRow>; charNameById: Map<string, string> };

export function speakerRegistryOf(source: StudioSource): SpeakerRegistry {
    const subjectById = new Map<string, StudioRow>();
    for (const s of studioRows(source.subject_registry)) {
        const id = studioStr(s.id);
        if (id) subjectById.set(id, s);
    }
    const charNameById = new Map<string, string>();
    for (const c of studioRows(source.character_registry)) {
        const id = studioStr(c.id);
        if (id) charNameById.set(id, studioStr(c.name));
    }
    return { subjectById, charNameById };
}

export function speakerNameOf(reg: SpeakerRegistry, u: StudioRow): string {
    const ref = reg.subjectById.get(studioStr(u.speakerSubjectId))?.entityRef as StudioRow | undefined;
    return reg.charNameById.get(studioStr(ref?.id))
        || studioStr(u.speakerName)
        || studioStr(u.speakerSubjectId)
        || "未命名";
}

export type ShotUtteranceLine = {
    utteranceId?: string;
    speakerSubjectId?: string;
    speaker: string;
    text: string;
    reference?: StudioRow;
};

/**
 * 一个镜头的台词行：优先按 shot.utterance_refs → utteranceId 聚合（含跨镜共享台词），
 * 没有 refs 时兼容 utterance.start.shotId，最后再并入老剧目 shot.dialogues[]。
 */
export function utterancesOfShot(
    source: StudioSource,
    shot: StudioRow,
    reg: SpeakerRegistry = speakerRegistryOf(source),
): ShotUtteranceLine[] {
    const byId = new Map<string, StudioRow>();
    for (const u of studioRows(source.utterances)) {
        const id = studioStr(u.id);
        if (id && !byId.has(id)) byId.set(id, u);
    }
    const lines: ShotUtteranceLine[] = [];
    const seen = new Set<string>();
    const refs = studioRows(shot.utterance_refs);
    if (refs.length) {
        for (const ref of refs) {
            const uid = studioStr(ref.utteranceId);
            if (!uid || seen.has(uid)) continue;
            const u = byId.get(uid);
            if (!u) continue;
            const text = studioStr(u.text).trim();
            if (!text) continue;
            seen.add(uid);
            lines.push({
                utteranceId: uid,
                speakerSubjectId: studioStr(u.speakerSubjectId) || undefined,
                speaker: speakerNameOf(reg, u),
                text,
                reference: ref,
            });
        }
    } else {
        const shotId = studioStr(shot.id);
        for (const u of studioRows(source.utterances)) {
            const start = (u.start || {}) as StudioRow;
            if (!shotId || studioStr(start.shotId) !== shotId) continue;
            const uid = studioStr(u.id);
            if (uid && seen.has(uid)) continue;
            const text = studioStr(u.text).trim();
            if (!text) continue;
            if (uid) seen.add(uid);
            lines.push({
                utteranceId: uid || undefined,
                speakerSubjectId: studioStr(u.speakerSubjectId) || undefined,
                speaker: speakerNameOf(reg, u),
                text,
            });
        }
    }
    // 老剧目回填在 shot.dialogues[] 的台词仍然保留；同文本不再重复一条。
    const texts = new Set(lines.map(line => line.text));
    for (const d of studioRows(shot.dialogues)) {
        const text = studioStr(d.text).trim();
        if (!text || texts.has(text)) continue;
        texts.add(text);
        lines.push({ speaker: studioStr(d.speaker) || "旁白", text });
    }
    return lines;
}

/** 全片台词行（对白逐字核查的镜头侧数据源）。 */
export function dialogueShotLinesOf(source: StudioSource): string[] {
    const reg = speakerRegistryOf(source);
    const lines: string[] = [];
    for (const shot of studioRows(source.shots)) {
        for (const line of utterancesOfShot(source, shot, reg)) {
            if (line.text) lines.push(line.text);
        }
    }
    return lines;
}
