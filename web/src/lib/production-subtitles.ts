import { isSubjectPromptAssembly } from "@basketikun/canvas-agent/drama/production-contract";
import { subjectShotWindows } from "@basketikun/canvas-agent/drama/subject-assembly";

import { subjectDisplayName } from "./production-source";

type Row = Record<string, any>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) : [];

export type SubtitleCue = {
    index: number;
    timelineId: string;
    shotId: string;
    utteranceId: string;
    speaker: string;
    delivery?: string;
    voiceover: boolean;
    role: string;
    /** Absolute timeline frames (timeline origin + Shot window + local frame). */
    startFrame: number;
    endFrame: number;
    startSeconds: number;
    endSeconds: number;
    text: string;
};

export type SubtitleTrack = { timelineId: string; fps: number; cues: SubtitleCue[]; srt: string };

/** Fallback only for sources that never recorded a frame rate; every real production writes fps_num/fps_den. */
export const DEFAULT_SUBTITLE_FPS = 24;

export function productionSourceFps(source: unknown) {
    const record = source && typeof source === "object" ? source as Row : {};
    const numerator = Number(record.fps_num), denominator = Number(record.fps_den ?? 1);
    return Number.isFinite(numerator) && numerator > 0 && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : DEFAULT_SUBTITLE_FPS;
}

/** SRT timestamps are millisecond precise; frames convert with the production frame rate, not a rounded fps. */
export function srtTimestamp(seconds: number) {
    const total = Math.max(0, Math.round(seconds * 1000));
    const milliseconds = total % 1000, whole = Math.floor(total / 1000);
    return `${String(Math.floor(whole / 3600)).padStart(2, "0")}:${String(Math.floor(whole / 60) % 60).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

export function cuesToSrt(cues: readonly SubtitleCue[]) {
    if (!cues.length) return "";
    // Blank line after every block keeps the last cue terminated the same way SubRip readers expect.
    return `${cues.map((cue, index) => `${index + 1}\n${srtTimestamp(cue.startSeconds)} --> ${srtTimestamp(cue.endSeconds)}\n${cue.text}\n`).join("\n")}\n`;
}

/**
 * Subtitle cues are the authored dialogue itself: every Shot `utterance_refs` window is placed on the
 * authoritative Shot timeline (subjectShotWindows), and the cue text is the ref's own slice of the
 * utterance text — cross-cut lines stay split exactly as authored, nothing is re-timed or re-wrapped.
 * Only Subject Prompt Assembly v2 carries structured utterances; older formats deliver no cues.
 */
export function productionSubtitleTracks(source: unknown): SubtitleTrack[] {
    const record = source && typeof source === "object" ? source as Row : {};
    if (!isSubjectPromptAssembly(record)) return [];
    const fps = productionSourceFps(record);
    const utterances = new Map(rows(record.utterances).map(utterance => [String(utterance.id), utterance]));
    const windows = subjectShotWindows(record);
    const timelineOrder = new Map(rows(record.ledger?.timelines).map((timeline, index) => [String(timeline.id), index]));
    const cues: SubtitleCue[] = [];
    for (const shot of rows(record.shots)) {
        const window = windows.get(String(shot.id));
        if (!window) continue;
        for (const ref of rows(shot.utterance_refs)) {
            const utterance = utterances.get(String(ref.utteranceId));
            if (!utterance) continue;
            // Text ranges index code points (the same slice the Shot editor and split rules use), not UTF-16 units.
            const characters = Array.from(String(utterance.text ?? ""));
            const textStart = Math.max(0, Math.min(characters.length, Number(ref.textStart ?? 0)));
            const textEnd = Math.max(textStart, Math.min(characters.length, Number(ref.textEnd ?? characters.length)));
            const text = characters.slice(textStart, textEnd).join("").trim();
            if (!text) continue;
            // A cue never leaves its Shot window, even if a hand-edited draft recorded a longer sound interval.
            const startFrame = window.startFrame + Math.max(0, Number(ref.localStartFrame ?? 0));
            const endFrame = Math.min(window.endFrame, window.startFrame + Number(ref.localEndFrame ?? 0));
            if (!(endFrame > startFrame)) continue;
            cues.push({
                index: 0,
                timelineId: window.timelineId,
                shotId: String(shot.id),
                utteranceId: String(utterance.id),
                speaker: String(utterance.speakerName || "").trim() || (utterance.speakerSubjectId ? subjectDisplayName(record, String(utterance.speakerSubjectId)) : ""),
                delivery: typeof utterance.delivery === "string" && utterance.delivery.trim() ? utterance.delivery : undefined,
                voiceover: utterance.voiceover === true,
                role: String(ref.role || "speaker"),
                startFrame,
                endFrame,
                startSeconds: startFrame / fps,
                endSeconds: endFrame / fps,
                text,
            });
        }
    }
    cues.sort((left, right) => (timelineOrder.get(left.timelineId) ?? Number.MAX_SAFE_INTEGER) - (timelineOrder.get(right.timelineId) ?? Number.MAX_SAFE_INTEGER)
        || left.startFrame - right.startFrame || left.endFrame - right.endFrame || left.speaker.localeCompare(right.speaker));
    const byTimeline = new Map<string, SubtitleCue[]>();
    for (const cue of cues) byTimeline.set(cue.timelineId, [...(byTimeline.get(cue.timelineId) || []), cue]);
    return [...byTimeline].map(([timelineId, timelineCues]) => {
        const reindexed = timelineCues.map((cue, index) => ({ ...cue, index: index + 1 }));
        return { timelineId, fps, cues: reindexed, srt: cuesToSrt(reindexed) };
    });
}
