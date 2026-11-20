/**
 * 段级「按对白自动音色」派生。
 *
 * 这是影策 dramaSegmentVoicedSpeakers(drama_segment_video.go:355-379) 的本地等价实现：
 *   1. 用角色本体名 + 别名建「说话人 → 角色组」索引（影策 CastIndex，first-wins）；
 *   2. 按镜头顺序遍历本段镜头，跳过空台词与旁白（IsNarrator）；
 *   3. 用说话人查索引 → 去重 → 只保留 voice.url 非空者；
 *   4. 受 ref2va 参考音频上限截断（按当前选用视频模型的 maxAudios，经参数注入；未注入时
 *      回落 H3 原生默认 3）。
 *
 * 本地没有影策的 IsNarrator / CastIndex / 角色别名表，因此：
 *   - 旁白判定复刻影策 production.IsNarrator 的规范化词表（旁白 / narrator / 画外音），
 *     本地 utterances 的 voiceover 布尔是「画外音式表演」而非旁白身份，按真值不据此跳过；
 *   - 别名索引从 subject_registry / character_registry 的 name/aliases + h3CharacterGroups 的
 *     characterName / subjectId / characterNodeId 合成，缺失别名的角色只能按本体名命中。
 * 这些边界在报告里如实说明，不伪造本地并不存在的「旁白角色」或「别名索引」字段。
 */

import { DEFAULT_VIDEO_MAX_AUDIOS } from "../canvas/model-audio-capability.js";

/** H3 原生 ref2va 参考音频上限（兼容旧引用）；实际截断一律用 deriveAutoVoiceGroupIds 注入的 maxAudios。 */
export const H3_MAX_AUDIO_REFS = DEFAULT_VIDEO_MAX_AUDIOS;

type Row = Record<string, any>;

const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(object) : [];

/** 与影策 production.NormalizeName 对齐：小写、去首尾空白、去所有空白与标点。 */
export function normalizeSpeakerName(value: unknown): string {
    return String(value ?? "").toLowerCase().trim().replace(/[\s\p{P}]/gu, "");
}

/** 与影策 production.IsNarrator 对齐：旁白 / narrator / 画外音。 */
export function isNarratorSpeaker(value: unknown): boolean {
    const key = normalizeSpeakerName(value);
    return key === "旁白" || key === "narrator" || key === "画外音";
}

function aliasList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(item => normalizeSpeakerName(item)).filter(Boolean);
    if (typeof value === "string") return value.split(/[,，、;；|]/).map(item => normalizeSpeakerName(item)).filter(Boolean);
    return [];
}

type SpeakerIndex = Map<string, string>;

/** 建索引：规范化名 / 别名 / 主体 ID → groupId。影策 CastIndex.Add 是先到先得，不覆盖。 */
function buildSpeakerIndex(source: Row, groups: Record<string, unknown>): SpeakerIndex {
    const index: SpeakerIndex = new Map();
    const add = (key: unknown, groupId: string) => {
        const normalized = normalizeSpeakerName(key);
        if (normalized && !index.has(normalized)) index.set(normalized, groupId);
    };
    const subjects = rows(source.subject_registry);
    const subjectById = new Map(subjects.map(subject => [String(subject.id || ""), subject]));
    const characters = rows(source.character_registry);
    const characterById = new Map(characters.map(character => [String(character.id || ""), character]));
    const characterByName = new Map(characters.map(character => [normalizeSpeakerName(character.name), character]));

    for (const [groupId, raw] of Object.entries(groups)) {
        const group = object(raw);
        add(group.id, groupId);
        add(group.characterName, groupId);
        add(group.subjectId, groupId);
        add(group.characterNodeId, groupId);

        const subject = subjectById.get(String(group.subjectId || ""));
        const entityId = String(object(subject?.entityRef).id || "");
        if (subject) {
            add(subject.id, groupId);
            add(subject.name, groupId);
            add(object(subject.entityRef).id, groupId);
            for (const alias of aliasList(subject.aliases ?? subject.alias)) add(alias, groupId);
        }
        const character = characterById.get(entityId) || characterByName.get(normalizeSpeakerName(group.characterName));
        if (character) {
            add(character.id, groupId);
            add(character.name, groupId);
            for (const alias of aliasList(character.aliases ?? character.alias)) add(alias, groupId);
        }
    }
    return index;
}

/** 单个镜头的说话人候选（按台词与对白事件在原稿里出现的顺序）。 */
function speakersForShot(shot: Row, source: Row, subjectById: Map<string, Row>): string[] {
    const candidates: string[] = [];
    for (const dialogue of rows(shot.dialogues)) {
        if (!String(dialogue.text ?? "").trim()) continue;
        // 正式源稿的对白用 speaker_name / character_id（影策落地的字段），本地手稿用 speaker。
        // 三种写法都纳入候选；deriveVoiceCandidates 按 groupId 去重，不会因此重复发送音色。
        const speaker = String(dialogue.speaker ?? dialogue.speaker_name ?? dialogue.speakerName ?? "").trim();
        if (speaker) candidates.push(speaker);
        const characterId = String(dialogue.character_id ?? dialogue.characterId ?? "").trim();
        if (characterId) candidates.push(characterId);
    }
    const shotId = String(shot.id || "");
    for (const utterance of rows(source.utterances)) {
        const startShotId = String(object(utterance.start).shotId || utterance.shot_id || "");
        const endShotId = String(object(utterance.end).shotId || "");
        if (!shotId || (startShotId !== shotId && endShotId !== shotId)) continue;
        if (!String(utterance.text ?? "").trim()) continue;
        const subject = subjectById.get(String(utterance.speakerSubjectId || ""));
        if (utterance.speakerSubjectId) candidates.push(String(utterance.speakerSubjectId));
        if (subject?.name) candidates.push(String(subject.name));
        if (utterance.speakerName) candidates.push(String(utterance.speakerName));
    }
    return candidates;
}

export type AutoVoiceInput = {
    /** draft.director.source */
    source: Row;
    /** 本段镜头 ID，按镜头顺序（group.shotIds） */
    shotIds: string[];
    /** 本段 H3 角色组映射（group.id → group） */
    groups: Record<string, unknown>;
    /** 当前视频模型的参考音频上限（影策 profile.MaxAudios）；缺省回落 H3 原生 3。 */
    maxAudios?: number;
};

/** 本段按开口顺序去重的说话角色候选，含尚未绑定声线者（影策 DramaSegmentAudioReference 全集）。 */
export type VoiceCandidate = { groupId: string; characterName: string; hasVoice: boolean };

/**
 * 影策 dramaSegmentVoicedSpeakers 的本地等价：按开口顺序返回去重的说话角色候选。
 * 解析到组即标记 seen（即便没有声线），与影策 first-wins 一致；旁白与无法归组的发言跳过。
 */
export function deriveVoiceCandidates(input: Omit<AutoVoiceInput, "maxAudios">): VoiceCandidate[] {
    const source = object(input.source);
    const groups = object(input.groups) as Record<string, Row>;
    const index = buildSpeakerIndex(source, groups);
    const shots = new Map(rows(source.shots).map(shot => [String(shot.id || ""), shot]));
    const subjectById = new Map(rows(source.subject_registry).map(subject => [String(subject.id || ""), subject]));
    const result: VoiceCandidate[] = [];
    const seen = new Set<string>();
    for (const shotId of input.shotIds || []) {
        const shot = shots.get(String(shotId));
        if (!shot) continue;
        for (const candidate of speakersForShot(shot, source, subjectById)) {
            if (isNarratorSpeaker(candidate)) continue;
            const groupId = index.get(normalizeSpeakerName(candidate));
            if (!groupId || seen.has(groupId)) continue;
            seen.add(groupId);
            const group = object(groups[groupId]);
            result.push({
                groupId,
                characterName: String(group.characterName || group.name || groupId),
                // 覆写可能只给 storageKey（指定 voiceStorageKey），没有 url；两者任一非空即有声线。
                hasVoice: Boolean(String(object(group.voice).url || object(group.voice).storageKey || "").trim()),
            });
        }
    }
    return result;
}

/**
 * 返回本段「按对白自动」应选中的角色组 ID（按开口顺序去重、只带有声线者、最多 maxAudios 个）。
 */
export function deriveAutoVoiceGroupIds(input: AutoVoiceInput): string[] {
    const limit = Number.isSafeInteger(input.maxAudios) && Number(input.maxAudios) >= 0
        ? Number(input.maxAudios) : DEFAULT_VIDEO_MAX_AUDIOS;
    if (limit <= 0) return [];
    return deriveVoiceCandidates(input).filter(candidate => candidate.hasVoice).slice(0, limit).map(candidate => candidate.groupId);
}

// ===== 段级音色 Note（影策 DramaSegmentAudioReference.Note 的本地等价）=====
// 影策 drama_segment_video.go:dramaSegmentAudioReferences 对每个说话角色都写一条引用：
// 能发送的 Sent=true；发不出的写 Note 说明原因，本段按声线描述生成该角色对白。
// 本地把「发不出的 Note」作为段级持久字段 voiceReferenceNotes 落在 H3 段 metadata，
// 随段详情可查；生成日志 warnings 仍保留（两者互补，不是替代）。

export type VoiceReferenceNoteCode = "voice_sample_missing" | "mode_not_supported" | "audio_reference_limit";

/** 与影策 JSON 字段对齐：groupId≈castId、characterName≈name、reason≈note、sent 恒为 false。 */
export type VoiceReferenceNote = {
    groupId: string;
    characterName: string;
    code: VoiceReferenceNoteCode;
    reason: string;
    sent: false;
};

/** 影策三类 Note 文案，集中一处避免编译期与运行时漂移。 */
export const VOICE_NOTE_REASON = {
    voice_sample_missing: "角色尚未绑定声音样本",
    mode_not_supported: "所选视频模型不支持参考音频，按声线描述生成",
    audio_reference_limit: (limit: number) => `超出视频模型参考音频上限（${limit} 段），未随请求发送`,
} as const;

/** 编译期：按影策判定顺序给所有未发送角色生成 Note（无样本 → 模式不支持 → 超限）。 */
export function buildVoiceReferenceNotes(input: { candidates: VoiceCandidate[]; maxAudios: number }): VoiceReferenceNote[] {
    const limit = Number.isSafeInteger(input.maxAudios) && input.maxAudios >= 0 ? input.maxAudios : DEFAULT_VIDEO_MAX_AUDIOS;
    const notes: VoiceReferenceNote[] = [];
    let sent = 0;
    for (const candidate of input.candidates) {
        const base = { groupId: candidate.groupId, characterName: candidate.characterName, sent: false as const };
        if (!candidate.hasVoice) {
            notes.push({ ...base, code: "voice_sample_missing", reason: VOICE_NOTE_REASON.voice_sample_missing });
        } else if (limit <= 0) {
            notes.push({ ...base, code: "mode_not_supported", reason: VOICE_NOTE_REASON.mode_not_supported });
        } else if (sent >= limit) {
            notes.push({ ...base, code: "audio_reference_limit", reason: VOICE_NOTE_REASON.audio_reference_limit(limit) });
        } else {
            sent++; // 会随请求发送，不写 Note
        }
    }
    return notes;
}

/**
 * 运行时：h3-runner 按模型上限截断后，给被跳过的参考音频写超限 Note。
 * 只产出 audio_reference_limit（运行时才掌握实际提交清单）；无样本/模式不支持由编译期落账。
 */
export function voiceSkipNotesFromRefs(input: {
    skipped: Array<{ groupId?: unknown; label?: unknown; name?: unknown }>;
    characterGroups: Record<string, unknown>;
    maxAudios: number;
}): VoiceReferenceNote[] {
    const groups = object(input.characterGroups) as Record<string, Row>;
    const limit = Math.max(0, Math.floor(Number(input.maxAudios) || 0));
    return input.skipped.map(ref => {
        const groupId = String(ref.groupId || "");
        const group = object(groups[groupId]);
        return {
            groupId,
            characterName: String(group.characterName || group.name || ref.name || ref.label || groupId),
            code: "audio_reference_limit" as const,
            reason: VOICE_NOTE_REASON.audio_reference_limit(limit),
            sent: false as const,
        };
    });
}

/** 合并段级 Note：保留编译期的无样本/模式不支持原因，以本次运行实际超限 Note 覆盖旧超限 Note。 */
export function mergeVoiceReferenceNotes(existing: unknown, runtimeLimitNotes: VoiceReferenceNote[]): VoiceReferenceNote[] {
    const kept = (Array.isArray(existing) ? existing : []).filter((note): note is VoiceReferenceNote =>
        Boolean(note) && typeof note === "object" && !Array.isArray(note)
        && typeof (note as VoiceReferenceNote).groupId === "string"
        && (note as VoiceReferenceNote).code !== "audio_reference_limit"
        && (note as VoiceReferenceNote).sent === false);
    const seen = new Set(kept.map(note => `${note.groupId}:${note.code}`));
    const added = runtimeLimitNotes.filter(note => {
        const key = `${note.groupId}:${note.code}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return [...kept, ...added];
}

// ===== 段级音色覆写（影策 segment-references 手动音色 / autoAudioReferences 恢复自动 的本地等价）=====
// 段级覆写是「本段某角色用哪条声音样本」的用户真值，键为 H3 角色组 ID（与 h3CharacterGroups /
// autoVoiceGroupIds / referenceBindings.groupId 同一身份）。有覆写用指定音色；没有覆写沿用角色本体
// voice（自动派生），清掉覆写即「恢复自动音色」。只改声音样本，不改谁开口（开口由对白派生决定）。

export type VoiceOverride = { storageKey: string; url?: string; name?: string };
export type VoiceOverrides = Record<string, VoiceOverride>;

/** 规范化段级覆写：值可为 voiceStorageKey 字符串或 {storageKey,url?,name?}；空 storageKey 视为未指派。 */
export function normalizeVoiceOverrides(value: unknown): VoiceOverrides {
    const result: VoiceOverrides = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    for (const [groupId, raw] of Object.entries(value as Record<string, unknown>)) {
        if (!groupId) continue;
        const row = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Row : { storageKey: raw };
        const storageKey = String(row.storageKey ?? "").trim();
        if (!storageKey) continue;
        result[groupId] = {
            storageKey,
            ...(row.url ? { url: String(row.url) } : {}),
            ...(row.name ? { name: String(row.name) } : {}),
        };
    }
    return result;
}

/** 编译期：把段级覆写套到角色组的本体 voice 上；无覆写的组原样保留（沿用本体音色）。 */
export function applyVoiceOverridesToGroups(groups: Record<string, unknown>, overrides: VoiceOverrides): Record<string, unknown> {
    if (!Object.keys(overrides).length) return groups;
    return Object.fromEntries(Object.entries(groups).map(([groupId, raw]) => {
        const override = overrides[groupId];
        if (!override) return [groupId, raw];
        const group = object(raw);
        // 本体 voice 仍在（url/name 继承），storageKey 被指定音色覆盖；resolveRef 以 storageKey 优先。
        return [groupId, { ...group, voice: { ...object(group.voice), ...override } }];
    }));
}

/** 运行时：按覆写改写参考音频的媒体身份，保留 groupId / id / 标签 / 类型 / 顺序。 */
export function applyVoiceOverridesToRefs<T extends Row>(refs: T[], overrides: VoiceOverrides): T[] {
    if (!Object.keys(overrides).length) return refs;
    return refs.map(ref => {
        const override = overrides[String(ref.groupId || "")];
        if (!override) return ref;
        return { ...ref, storageKey: override.storageKey, ...(override.url ? { url: override.url } : {}) } as T;
    });
}
