import assert from "node:assert/strict";
import test from "node:test";

import type { SubtitleCue, SubtitleTrack } from "./production-subtitles";
import {
    buildCalibrationBindings, buildTranscriptAxis, calibrateSubtitleTracks, clearSubtitleCalibration,
    findBestMatch, normalizeForMatch, readSubtitleCalibration, writeSubtitleCalibration,
    type CalibrationClipBinding, type ClipTranscript, type SubtitleCalibration,
} from "./subtitle-calibration";

const cue = (overrides: Partial<SubtitleCue> = {}): SubtitleCue => ({
    index: 1, timelineId: "main", shotId: "S1", utteranceId: "U1", speaker: "甲", voiceover: false,
    role: "speaker", startFrame: 0, endFrame: 48, startSeconds: 0, endSeconds: 2, text: "快把门打开", ...overrides,
});

const track = (cues: SubtitleCue[]): SubtitleTrack => ({ timelineId: "main", fps: 24, cues, srt: "" });

const binding = (overrides: Partial<CalibrationClipBinding> = {}): CalibrationClipBinding => ({
    segmentId: "C1", storageKey: "video-1", shotIds: ["S1"], startSeconds: 10, authoredDurationSeconds: 2, ...overrides,
});

const wordsOf = (text: string, start: number, end: number, probability = 0.9) =>
    Array.from(text).map((word, index) => ({ word, start: start + (end - start) * (index / text.length), end: start + (end - start) * ((index + 1) / text.length), probability }));

const transcript = (overrides: Partial<ClipTranscript> = {}): ClipTranscript => ({
    storageKey: "video-1", durationSeconds: 2, text: "快把门打开", language: "zh",
    noSpeechProbability: 0.05, words: wordsOf("快把门打开", 0.5, 2.4), warnings: [], ...overrides,
});

function memoryStorage() {
    const map = new Map<string, string>();
    return {
        get length() { return map.size; },
        key: (index: number) => [...map.keys()][index] ?? null,
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => { map.set(key, value); },
        removeItem: (key: string) => { map.delete(key); },
    };
}

const calibration = (): SubtitleCalibration => ({
    version: 1, sourceHash: "hash-a", createdAt: "2026-11-14T00:00:00.000Z", model: "base", language: "Chinese",
    tracks: [], report: { totalCues: 0, calibrated: 0, unmatched: 0, unmapped: 0, averageShiftSeconds: 0, maxShiftSeconds: 0, averageConfidence: 0, clips: [], warnings: [] },
});

test("normalizeForMatch strips punctuation, whitespace and case but keeps CJK characters", () => {
    assert.equal(normalizeForMatch("快把门，打开！"), "快把门打开");
    assert.equal(normalizeForMatch("Hello, World!"), "helloworld");
    assert.equal(normalizeForMatch("  …—  "), "");
});

test("buildTranscriptAxis interpolates a multi-character word across its real time span", () => {
    const axis = buildTranscriptAxis([{ word: "打开！", start: 1, end: 2, probability: 0.8 }]);
    assert.deepEqual(axis.map(item => item.char), ["打", "开"]);
    assert.equal(axis[0].start, 1);
    assert.equal(axis[0].end, 1.5);
    assert.equal(axis[1].end, 2);
});

test("findBestMatch skips recognition noise and stays monotone from the cursor", () => {
    const axis = buildTranscriptAxis(wordsOf("呃快把门打开", 0, 3));
    const match = findBestMatch(axis, normalizeForMatch("快把门打开"), 0);
    assert.ok(match);
    assert.equal(match.matched, 5);
    assert.ok(match.firstIndex >= 1);
});

test("a confidently heard line is moved onto the real audio timeline without changing its text", () => {
    const { tracks, report } = calibrateSubtitleTracks([track([cue()])], [transcript()], [binding()]);
    const calibrated = tracks[0].cues[0];
    assert.equal(calibrated.calibrated, true);
    assert.equal(calibrated.reason, "matched");
    assert.equal(calibrated.text, "快把门打开");
    assert.ok(Math.abs(calibrated.startSeconds - 10.5) < 0.01, `start=${calibrated.startSeconds}`);
    assert.ok(Math.abs(calibrated.endSeconds - 12.4) < 0.01, `end=${calibrated.endSeconds}`);
    assert.equal(calibrated.originalStartSeconds, 0);
    assert.ok(Math.abs(report.averageShiftSeconds - 10.5) < 0.01);
    assert.equal(report.calibrated, 1);
    assert.equal(report.unmatched, 0);
    assert.match(tracks[0].srt, /00:00:10,500 --> 00:00:12,400/);
});

test("garbled recognition keeps the authored timeline instead of silently retiming", () => {
    // Real observation from a generated clip: base model produced "快把软件给'RE但是" with probability ~0.005.
    const noisy = transcript({ text: "快把软件给RE但是", words: wordsOf("快把软件给RE但是", 6.5, 10.0, 0.005), noSpeechProbability: 0.56 });
    const { tracks, report } = calibrateSubtitleTracks([track([cue()])], [noisy], [binding()]);
    assert.equal(tracks[0].cues[0].calibrated, false);
    assert.equal(tracks[0].cues[0].startSeconds, 0);
    assert.equal(tracks[0].cues[0].endSeconds, 2);
    assert.equal(report.calibrated, 0);
    assert.equal(report.unmatched, 1);
    assert.ok(report.warnings.some(warning => warning.includes("no_speech_prob")));
});

test("a collapsed word timeline (all characters at one instant) is rejected as a Whisper failure", () => {
    const collapsed = transcript({ words: Array.from("快把门打开").map(word => ({ word, start: 10.08, end: 10.08, probability: 0.9 })) });
    const { tracks, report } = calibrateSubtitleTracks([track([cue()])], [collapsed], [binding()]);
    assert.equal(tracks[0].cues[0].calibrated, false);
    assert.equal(report.calibrated, 0);
    assert.ok(report.clips[0].warnings.length >= 0);
});

test("missing binding or missing transcript is reported, never guessed", () => {
    const first = calibrateSubtitleTracks([track([cue()])], [transcript()], []);
    assert.equal(first.tracks[0].cues[0].reason, "no-binding");
    assert.equal(first.report.unmapped, 1);
    const second = calibrateSubtitleTracks([track([cue()])], [], [binding()]);
    assert.equal(second.tracks[0].cues[0].reason, "no-transcript");
    assert.equal(second.report.unmapped, 1);
    assert.ok(second.report.warnings.some(warning => warning.includes("找不到对应生成视频")));
});

test("duration mismatch is reported without stretching the real audio positions", () => {
    const { tracks, report } = calibrateSubtitleTracks([track([cue()])], [transcript({ durationSeconds: 3 })], [binding()]);
    assert.equal(report.clips[0].durationRatio, 1.5);
    assert.ok(report.clips[0].warnings.some(warning => warning.includes("相差 50%")));
    assert.ok(Math.abs(tracks[0].cues[0].startSeconds - 10.5) < 0.01, "no proportional stretch applied");
});

test("monotone cursor prevents a later line from matching an earlier audio position", () => {
    const cues = [cue({ text: "第一句台词", startSeconds: 0, endSeconds: 1 }), cue({ text: "第二句台词", startSeconds: 3, endSeconds: 4 })];
    const heard = transcript({ words: wordsOf("第一句台词然后第二句台词", 0.2, 4.0) });
    const { tracks, report } = calibrateSubtitleTracks([track(cues)], [heard], [binding({ shotIds: ["S1"], authoredDurationSeconds: 5 })]);
    const [first, second] = tracks[0].cues;
    assert.equal(first.calibrated, true);
    assert.equal(second.calibrated, true);
    assert.ok(second.startSeconds > first.startSeconds, `${first.startSeconds} -> ${second.startSeconds}`);
    assert.equal(report.calibrated, 2);
});

test("calibrated cues never overlap and keep a minimum visible duration", () => {
    const cues = [
        cue({ text: "快把门打开", startSeconds: 0, endSeconds: 0.1 }),
        cue({ text: "快把门打开", startSeconds: 0.2, endSeconds: 0.3 }),
    ];
    const { tracks } = calibrateSubtitleTracks([track(cues)], [], []);
    assert.ok(tracks[0].cues[0].endSeconds <= tracks[0].cues[1].startSeconds + 0.001);
    assert.ok(tracks[0].cues[0].endSeconds > tracks[0].cues[0].startSeconds);
    assert.equal(tracks[0].cues[0].index, 1);
    assert.equal(tracks[0].cues[1].index, 2);
});

test("buildCalibrationBindings maps a Clip to its Shot window on the global timeline", () => {
    const source = {
        version: 2, prompt_assembly: { version: 2 }, ledger: { contract_version: 2, timelines: [{ id: "main", start_frame: 0 }] },
        fps_num: 24, fps_den: 1,
        shots: [
            { id: "S1", story_order: 0, duration_frames: 48, utterance_refs: [] },
            { id: "S2", story_order: 1, duration_frames: 48, utterance_refs: [] },
        ],
        segments: [{ id: "C1", shot_ids: ["S1", "S2"] }],
        utterances: [], subject_registry: [],
    };
    const bindings = buildCalibrationBindings(source, [{ segmentId: "C1", storageKey: "video-1" }]);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].startSeconds, 0);
    assert.equal(bindings[0].authoredDurationSeconds, 4);
    assert.deepEqual(bindings[0].shotIds, ["S1", "S2"]);
});

test("calibration cache is bound to sourceHash and drops stale entries", () => {
    const storage = memoryStorage();
    writeSubtitleCalibration("project-1", "hash-a", calibration(), storage);
    assert.equal(readSubtitleCalibration("project-1", "hash-a", storage)?.sourceHash, "hash-a");
    assert.equal(readSubtitleCalibration("project-1", "hash-b", storage), null);
    writeSubtitleCalibration("project-1", "hash-b", { ...calibration(), sourceHash: "hash-b" }, storage);
    assert.equal(storage.length, 1, "stale hash entry removed");
    assert.equal(readSubtitleCalibration("project-1", "hash-a", storage), null);
    clearSubtitleCalibration("project-1", storage);
    assert.equal(storage.length, 0);
});

test("corrupt cache payload is ignored rather than crashing the page", () => {
    const storage = memoryStorage();
    storage.setItem("infinite-canvas:subtitle-calibration:v1:project-1:hash-a", "{not json");
    assert.equal(readSubtitleCalibration("project-1", "hash-a", storage), null);
});
