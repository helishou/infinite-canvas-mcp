import { subjectShotWindows } from "@basketikun/canvas-agent/drama/subject-assembly";

import { cuesToSrt, productionSourceFps, type SubtitleCue, type SubtitleTrack } from "./production-subtitles";
import { productionSegments, segmentShotIds } from "./production-source";

/**
 * Calibrates the *timeline* of authored subtitle cues against word timestamps from the real
 * generated video audio. The authored dialogue text stays authoritative: Whisper's recognition
 * text is only used to locate each line on the audio timeline, never to rewrite what characters say.
 *
 * Deliberately does NOT touch `director.source`: changing it would invalidate sourceHash, mark
 * artifacts stale, and force a recompile that collides with translation-frozen prompt hashes.
 */

export type TranscriptWord = { word: string; start: number; end: number; probability: number };

export type ClipTranscript = {
    storageKey: string;
    durationSeconds: number;
    text: string;
    language: string;
    noSpeechProbability: number;
    words: TranscriptWord[];
    warnings: string[];
};

export type CalibrationClipBinding = {
    segmentId: string;
    storageKey: string;
    shotIds: string[];
    /** Global timeline offset (seconds) of the first Shot this generated video covers. */
    startSeconds: number;
    authoredDurationSeconds: number;
};

export type CalibratedCue = SubtitleCue & {
    calibrated: boolean;
    /** Matched character ratio in [0,1]; 0 when the cue kept its authored time. */
    confidence: number;
    originalStartSeconds: number;
    originalEndSeconds: number;
    reason?: "matched" | "low-confidence" | "no-binding" | "no-transcript" | "too-short" | "no-words";
    storageKey?: string;
};

export type CalibratedTrack = { timelineId: string; fps: number; cues: CalibratedCue[]; srt: string };

export type CalibrationClipReport = {
    storageKey: string;
    wordCount: number;
    durationSeconds: number;
    authoredDurationSeconds: number;
    durationRatio: number;
    noSpeechProbability: number;
    warnings: string[];
};

export type CalibrationReport = {
    totalCues: number;
    calibrated: number;
    unmatched: number;
    unmapped: number;
    averageShiftSeconds: number;
    maxShiftSeconds: number;
    averageConfidence: number;
    clips: CalibrationClipReport[];
    warnings: string[];
};

export type SubtitleCalibration = {
    version: 1;
    sourceHash: string;
    createdAt: string;
    model: string;
    language: string;
    tracks: CalibratedTrack[];
    report: CalibrationReport;
};

export type CalibrationOptions = {
    /** Minimum matched-character ratio before a cue's timeline may be replaced. Default 0.6. */
    minMatchRatio?: number;
    minMatchedChars?: number;
    /** Warn when real video length differs from the authored Shot window by more than this ratio. */
    maxDurationRatioDeviation?: number;
    /** Smallest visible cue duration after calibration. Default 0.4s. */
    minCueDurationSeconds?: number;
};

const DEFAULTS: Required<CalibrationOptions> = {
    minMatchRatio: 0.6,
    minMatchedChars: 2,
    maxDurationRatioDeviation: 0.15,
    minCueDurationSeconds: 0.4,
};

const CACHE_PREFIX = "infinite-canvas:subtitle-calibration:v1:";

/** Punctuation, symbols and whitespace are not spoken; stripping them keeps Chinese and English comparable. */
export function normalizeForMatch(text: string): string {
    return Array.from(String(text ?? "").toLowerCase()).filter(character => !/[\s\p{P}\p{S}]/u.test(character)).join("");
}

type AxisChar = { char: string; start: number; end: number; probability: number };

/** Flatten word timestamps into a character timeline; each character inherits its word's time span. */
export function buildTranscriptAxis(words: readonly TranscriptWord[]): AxisChar[] {
    const axis: AxisChar[] = [];
    for (const word of words) {
        const characters = Array.from(normalizeForMatch(word.word));
        if (!characters.length) continue;
        const start = Number.isFinite(word.start) ? Math.max(0, word.start) : 0;
        const end = Number.isFinite(word.end) ? Math.max(start, word.end) : start;
        const span = (end - start) / characters.length;
        characters.forEach((char, index) => axis.push({ char, start: start + span * index, end: start + span * (index + 1), probability: word.probability ?? 0 }));
    }
    return axis;
}

type Match = { score: number; firstIndex: number; lastIndex: number; matched: number };

/** Monotone best-effort subsequence match inside a bounded window; skips recognition noise. */
export function findBestMatch(axis: readonly AxisChar[], needle: string, cursor: number, maxGaps = 6): Match | null {
    if (!needle.length || !axis.length) return null;
    const characters = Array.from(needle);
    const windowEnd = Math.min(axis.length, cursor + characters.length * 3 + 12);
    let best: Match | null = null;
    for (let start = cursor; start < windowEnd; start += 1) {
        let position = start, matched = 0, gaps = 0, firstIndex = -1, lastIndex = -1;
        for (const character of characters) {
            while (position < windowEnd && axis[position].char !== character && gaps < maxGaps) { position += 1; gaps += 1; }
            if (position < windowEnd && axis[position].char === character) {
                if (firstIndex < 0) firstIndex = position;
                lastIndex = position;
                matched += 1;
                position += 1;
            }
        }
        const score = matched / characters.length - gaps * 0.02;
        if (matched > 0 && (!best || score > best.score)) best = { score, firstIndex, lastIndex, matched };
    }
    return best && best.firstIndex >= 0 ? best : null;
}

/** Resolve which generated video covers which Shots, and where that video starts on the global timeline. */
export function buildCalibrationBindings(
    source: unknown,
    clips: readonly { segmentId: string; storageKey: string }[],
): CalibrationClipBinding[] {
    const fps = productionSourceFps(source);
    const windows = subjectShotWindows((source && typeof source === "object" ? source : {}) as Record<string, unknown>);
    const segments = productionSegments({ draft: { director: { source } } } as unknown as Parameters<typeof productionSegments>[0]);
    const bindings: CalibrationClipBinding[] = [];
    for (const clip of clips) {
        const segment = segments.find(item => String(item.id) === String(clip.segmentId));
        const shotIds = segment ? segmentShotIds(segment) : [];
        const frames = shotIds.map(id => windows.get(id)).filter((window): window is NonNullable<typeof window> => Boolean(window));
        if (!frames.length) continue;
        const startFrame = Math.min(...frames.map(window => window.startFrame));
        const endFrame = Math.max(...frames.map(window => window.endFrame));
        bindings.push({
            segmentId: String(clip.segmentId),
            storageKey: String(clip.storageKey),
            shotIds,
            startSeconds: startFrame / fps,
            authoredDurationSeconds: Math.max(0, (endFrame - startFrame) / fps),
        });
    }
    return bindings;
}

function clampCueTimes(cues: CalibratedCue[], minDuration: number, fps: number): CalibratedCue[] {
    const sorted = [...cues].map(cue => ({ ...cue }));
    sorted.sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
    for (const [index, cue] of sorted.entries()) {
        const nextStart = sorted[index + 1]?.startSeconds;
        const wantedEnd = Math.max(cue.endSeconds, cue.startSeconds + minDuration);
        cue.endSeconds = typeof nextStart === "number" ? Math.min(wantedEnd, Math.max(cue.startSeconds + 0.05, nextStart)) : wantedEnd;
        cue.startFrame = Math.round(cue.startSeconds * fps);
        cue.endFrame = Math.round(cue.endSeconds * fps);
    }
    return sorted.map((cue, index) => ({ ...cue, index: index + 1 }));
}

/**
 * Replace cue timestamps with real audio positions for cues that can be confidently located.
 * Everything else keeps its authored frame window and is reported, never silently guessed.
 */
export function calibrateSubtitleTracks(
    tracks: readonly SubtitleTrack[],
    transcripts: readonly ClipTranscript[],
    bindings: readonly CalibrationClipBinding[],
    options: CalibrationOptions = {},
): { tracks: CalibratedTrack[]; report: CalibrationReport } {
    const settings = { ...DEFAULTS, ...options };
    const transcriptByKey = new Map(transcripts.map(item => [String(item.storageKey), item]));
    const bindingByShot = new Map<string, CalibrationClipBinding>();
    for (const binding of bindings) for (const shotId of binding.shotIds) if (!bindingByShot.has(shotId)) bindingByShot.set(shotId, binding);
    const axes = new Map<string, AxisChar[]>();
    const cursors = new Map<string, number>();
    const rejectedClips = new Set<string>();
    const warnings: string[] = [];

    const clipReports: CalibrationClipReport[] = transcripts.map(transcript => {
        const binding = bindings.find(item => item.storageKey === transcript.storageKey);
        const authored = binding?.authoredDurationSeconds ?? 0;
        const ratio = authored > 0 && transcript.durationSeconds > 0 ? transcript.durationSeconds / authored : 0;
        const clipWarnings = [...(Array.isArray(transcript.warnings) ? transcript.warnings : [])];
        if (ratio && Math.abs(ratio - 1) > settings.maxDurationRatioDeviation) {
            clipWarnings.push(`实际视频时长 ${transcript.durationSeconds.toFixed(2)}s 与创作稿窗口 ${authored.toFixed(2)}s 相差 ${Math.round((ratio - 1) * 100)}%，校准按识别到的真实时间定位，未做比例拉伸`);
        }
        if (transcript.noSpeechProbability > 0.5) {
            clipWarnings.push(`no_speech_prob=${transcript.noSpeechProbability.toFixed(2)}，该段可能没有清晰台词，已跳过整段校准`);
            rejectedClips.add(String(transcript.storageKey));
        }
        axes.set(String(transcript.storageKey), buildTranscriptAxis(Array.isArray(transcript.words) ? transcript.words : []));
        cursors.set(String(transcript.storageKey), 0);
        for (const warning of clipWarnings) if (!warnings.includes(warning)) warnings.push(warning);
        return {
            storageKey: String(transcript.storageKey),
            wordCount: Array.isArray(transcript.words) ? transcript.words.length : 0,
            durationSeconds: transcript.durationSeconds,
            authoredDurationSeconds: authored,
            durationRatio: ratio,
            noSpeechProbability: transcript.noSpeechProbability,
            warnings: clipWarnings,
        };
    });

    let totalCues = 0, calibrated = 0, unmatched = 0, unmapped = 0;
    const shifts: number[] = [], confidences: number[] = [];
    const resultTracks: CalibratedTrack[] = tracks.map(track => {
        const cues: CalibratedCue[] = track.cues.map(cue => {
            totalCues += 1;
            const base: CalibratedCue = {
                ...cue, calibrated: false, confidence: 0,
                originalStartSeconds: cue.startSeconds, originalEndSeconds: cue.endSeconds,
            };
            const binding = bindingByShot.get(String(cue.shotId));
            if (!binding) { unmapped += 1; return { ...base, reason: "no-binding" }; }
            const transcript = transcriptByKey.get(binding.storageKey);
            if (!transcript) { unmapped += 1; return { ...base, reason: "no-transcript", storageKey: binding.storageKey }; }
            if (rejectedClips.has(binding.storageKey)) { unmatched += 1; return { ...base, reason: "low-confidence", storageKey: binding.storageKey }; }
            const axis = axes.get(binding.storageKey) || [];
            if (!axis.length) { unmatched += 1; return { ...base, reason: "no-words", storageKey: binding.storageKey }; }
            const needle = normalizeForMatch(cue.text);
            if (needle.length < settings.minMatchedChars) { unmatched += 1; return { ...base, reason: "too-short", storageKey: binding.storageKey }; }
            const match = findBestMatch(axis, needle, cursors.get(binding.storageKey) || 0);
            const confidence = match ? match.matched / needle.length : 0;
            if (!match || confidence < settings.minMatchRatio || match.matched < settings.minMatchedChars) {
                unmatched += 1;
                return { ...base, confidence, reason: "low-confidence", storageKey: binding.storageKey };
            }
            const localStart = axis[match.firstIndex].start;
            const localEnd = Math.max(axis[match.lastIndex].end, localStart);
            // A collapsed word timeline (all characters at one instant) is a Whisper failure mode,
            // not real speech: those cues must keep their authored window.
            if (needle.length >= 4 && localEnd - localStart < 0.12) {
                unmatched += 1;
                return { ...base, confidence, reason: "low-confidence", storageKey: binding.storageKey };
            }
            cursors.set(binding.storageKey, match.lastIndex + 1);
            const startSeconds = Math.max(0, binding.startSeconds + localStart);
            const endSeconds = Math.max(startSeconds, binding.startSeconds + localEnd);
            calibrated += 1;
            shifts.push(startSeconds - cue.startSeconds);
            confidences.push(confidence);
            return {
                ...base, calibrated: true, confidence, reason: "matched", storageKey: binding.storageKey,
                startSeconds, endSeconds,
            };
        });
        const clamped = clampCueTimes(cues, settings.minCueDurationSeconds, track.fps);
        return { timelineId: track.timelineId, fps: track.fps, cues: clamped, srt: cuesToSrt(clamped) };
    });

    if (!calibrated && totalCues > 0) warnings.push("没有任何台词能可信地匹配到实际音频，字幕保持创作稿时间线（可换更大的 Whisper 模型后重试）");
    if (unmapped > 0) warnings.push(`${unmapped} 条台词找不到对应生成视频或识别结果，保持原时间线`);
    if (unmatched > 0) warnings.push(`${unmatched} 条台词匹配置信度不足，保持原时间线`);

    const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    return {
        tracks: resultTracks,
        report: {
            totalCues, calibrated, unmatched, unmapped,
            averageShiftSeconds: average(shifts),
            maxShiftSeconds: shifts.length ? Math.max(...shifts.map(Math.abs)) : 0,
            averageConfidence: average(confidences),
            clips: clipReports, warnings,
        },
    };
}

/** Cache is bound to sourceHash: recompiling the production automatically invalidates stale calibration. */
export function readSubtitleCalibration(projectId: string, sourceHash: string, storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): SubtitleCalibration | null {
    if (!storage || !projectId || !sourceHash) return null;
    try {
        const key = `${CACHE_PREFIX}${projectId}:${sourceHash}`;
        const raw = storage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as SubtitleCalibration;
        return parsed.version === 1 && Array.isArray(parsed.tracks) && parsed.report ? parsed : null;
    } catch { return null; }
}

export function writeSubtitleCalibration(projectId: string, sourceHash: string, calibration: SubtitleCalibration, storage: Pick<Storage, "setItem" | "removeItem" | "length" | "key"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage) {
    if (!storage || !projectId || !sourceHash) return;
    try {
        const prefix = `${CACHE_PREFIX}${projectId}:`;
        for (let index = storage.length - 1; index >= 0; index -= 1) {
            const key = storage.key(index);
            if (key && key.startsWith(prefix) && key !== `${prefix}${sourceHash}`) storage.removeItem(key);
        }
        storage.setItem(`${prefix}${sourceHash}`, JSON.stringify(calibration));
    } catch { /* quota / private mode: calibration stays available for this session only */ }
}

export function clearSubtitleCalibration(projectId: string, storage: Pick<Storage, "removeItem" | "length" | "key"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage) {
    if (!storage || !projectId) return;
    try {
        const prefix = `${CACHE_PREFIX}${projectId}:`;
        for (let index = storage.length - 1; index >= 0; index -= 1) {
            const key = storage.key(index);
            if (key && key.startsWith(prefix)) storage.removeItem(key);
        }
    } catch { /* ignore */ }
}
