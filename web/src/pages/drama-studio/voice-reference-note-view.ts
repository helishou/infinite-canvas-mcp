/**
 * 段级音色 Note 的前端视图投影（影策 DramaSegmentAudioReference.Note 的本地等价）。
 *
 * 真值在画布 H3 段 metadata.segments[].voiceReferenceNotes，由编译期（clip-inputs）
 * 与运行时（h3-runner）写入：groupId/角色名/reason/code/sent=false。
 * 本模块只做「读出来、过滤掉已发送、给出展示标签/配色」，不产生第二份真值。
 */

export type VoiceReferenceNoteCode = "voice_sample_missing" | "mode_not_supported" | "audio_reference_limit";

export type VoiceReferenceNoteView = {
    groupId: string;
    characterName: string;
    code: VoiceReferenceNoteCode;
    reason: string;
    sent: boolean;
};

export const VOICE_NOTE_CODES: readonly VoiceReferenceNoteCode[] = ["voice_sample_missing", "mode_not_supported", "audio_reference_limit"];

/** 三类 Note 在段详情音色区的短标签（超限 / 无样本 / 模式不支持）。 */
export const VOICE_NOTE_LABEL: Record<VoiceReferenceNoteCode, string> = {
    voice_sample_missing: "无样本",
    mode_not_supported: "模式不支持",
    audio_reference_limit: "超限",
};

export const VOICE_NOTE_STYLE: Record<VoiceReferenceNoteCode, string> = {
    voice_sample_missing: "border-amber-500/40 bg-amber-500/10 text-amber-500",
    mode_not_supported: "border-sky-500/40 bg-sky-500/10 text-sky-300",
    audio_reference_limit: "border-rose-500/40 bg-rose-500/10 text-rose-400",
};

const str = (v: unknown): string => (typeof v === "string" || typeof v === "number") ? String(v) : "";

/** 从段级字段读出未随请求发送的 Note；未知 code 按「模式不支持」保守展示，已发送项不展示。 */
export function projectVoiceReferenceNotes(value: unknown): VoiceReferenceNoteView[] {
    return (Array.isArray(value) ? value : [])
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map((item) => ({
            groupId: str(item.groupId),
            characterName: str(item.characterName || item.groupId),
            code: (VOICE_NOTE_CODES.includes(str(item.code) as VoiceReferenceNoteCode)
                ? str(item.code) : "mode_not_supported") as VoiceReferenceNoteCode,
            reason: str(item.reason),
            sent: item.sent === true,
        }))
        .filter((note) => !note.sent);
}
