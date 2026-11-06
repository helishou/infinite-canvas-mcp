import assert from "node:assert/strict";
import test from "node:test";

import { productionSourceFps, productionSubtitleTracks, srtTimestamp } from "./production-subtitles";

const shot = (id: string, storyOrder: number, durationFrames: number, refs: Array<Record<string, unknown>>, timelineId?: string) => ({
    id, title: id, timeline_id: timelineId, story_order: storyOrder, duration_frames: durationFrames,
    subject_usages: [], keyframes: [], utterance_refs: refs,
});
const speakerRef = (utteranceId: string, localStartFrame: number, localEndFrame: number, textStart: number, textEnd: number, role: "speaker" | "reaction" = "speaker") =>
    ({ utteranceId, role, localStartFrame, localEndFrame, textStart, textEnd });
const source = (overrides: Record<string, unknown> = {}) => ({
    version: 2,
    prompt_assembly: { version: 2 },
    fps_num: 24,
    fps_den: 1,
    subject_registry: [],
    character_registry: [],
    scene_registry: [],
    asset_plan: [],
    shots: [],
    segments: [],
    utterances: [],
    ledger: { contract_version: 2, facts: [], timelines: [{ id: "main", start_frame: 0 }], initial: [], events: [], requirements: [], coverage: [] },
    ...overrides,
});

test("a Shot dialogue window becomes one cue at the Shot's own absolute frames", () => {
    const draft = source({
        shots: [shot("S1", 0, 48, []), shot("S2", 1, 72, [speakerRef("U1", 12, 36, 0, 6)])],
        utterances: [{ id: "U1", speakerName: "信使", text: "站住，别动。", voiceover: false }],
    });
    const [track] = productionSubtitleTracks(draft);
    assert.equal(track.timelineId, "main");
    assert.equal(track.fps, 24);
    assert.equal(track.cues.length, 1);
    const [cue] = track.cues;
    assert.deepEqual({ startFrame: cue.startFrame, endFrame: cue.endFrame, shotId: cue.shotId, speaker: cue.speaker, text: cue.text },
        { startFrame: 60, endFrame: 84, shotId: "S2", speaker: "信使", text: "站住，别动。" });
    assert.equal(cue.startSeconds, 2.5);
    assert.equal(cue.endSeconds, 3.5);
    assert.equal(track.srt, "1\n00:00:02,500 --> 00:00:03,500\n站住，别动。\n\n");
});

test("a cross-cut line keeps each Shot's own text slice and never re-times it", () => {
    const draft = source({
        shots: [
            shot("S1", 0, 48, [speakerRef("U1", 24, 48, 0, 3)]),
            shot("S2", 1, 48, [speakerRef("U1", 0, 24, 3, 9, "reaction")]),
        ],
        utterances: [{ id: "U1", speakerName: "青儿", text: "赵家村供祭猪一口。" }],
    });
    const [track] = productionSubtitleTracks(draft);
    assert.deepEqual(track.cues.map(cue => [cue.index, cue.startFrame, cue.endFrame, cue.role, cue.text]), [
        [1, 24, 48, "speaker", "赵家村"],
        [2, 48, 72, "reaction", "供祭猪一口。"],
    ]);
    assert.match(track.srt, /^1\n00:00:01,000 --> 00:00:02,000\n赵家村\n\n2\n00:00:02,000 --> 00:00:03,000\n供祭猪一口。\n\n$/);
});

test("cues follow the authoritative Shot windows, not array order or authored story_order gaps", () => {
    const draft = source({
        ledger: { contract_version: 2, facts: [], timelines: [{ id: "main", start_frame: 240 }], initial: [], events: [], requirements: [], coverage: [] },
        shots: [
            shot("late", 7, 48, [speakerRef("U2", 0, 24, 0, 3)]),
            shot("early", 2, 96, [speakerRef("U1", 0, 24, 0, 3)]),
        ],
        utterances: [{ id: "U1", speakerName: "甲", text: "先说。" }, { id: "U2", speakerName: "乙", text: "后说。" }],
    });
    const [track] = productionSubtitleTracks(draft);
    assert.deepEqual(track.cues.map(cue => [cue.shotId, cue.startFrame, cue.text]), [["early", 240, "先说。"], ["late", 336, "后说。"]]);
});

test("each timeline keeps its own track and restarts cue numbering", () => {
    const draft = source({
        ledger: { contract_version: 2, facts: [], timelines: [{ id: "main", start_frame: 0 }, { id: "alt", start_frame: 1000 }], initial: [], events: [], requirements: [], coverage: [] },
        shots: [
            shot("M1", 0, 48, [speakerRef("U1", 0, 24, 0, 3)], "main"),
            shot("A1", 0, 48, [speakerRef("U2", 0, 24, 0, 3)], "alt"),
            shot("M2", 1, 48, [speakerRef("U1", 24, 48, 3, 6)], "main"),
        ],
        utterances: [{ id: "U1", speakerName: "甲", text: "主线的台词" }, { id: "U2", speakerName: "乙", text: "备线的台词" }],
    });
    const tracks = productionSubtitleTracks(draft);
    assert.deepEqual(tracks.map(track => [track.timelineId, track.cues.map(cue => [cue.index, cue.startFrame])]), [
        ["main", [[1, 0], [2, 72]]],
        ["alt", [[1, 1000]]],
    ]);
});

test("frame rate and timestamps stay exact for drop-frame style rates", () => {
    const draft = source({
        fps_num: 30000, fps_den: 1001,
        shots: [shot("S1", 0, 100, [speakerRef("U1", 0, 50, 0, 2)])],
        utterances: [{ id: "U1", speakerName: "甲", text: "慢帧" }],
    });
    const [track] = productionSubtitleTracks(draft);
    assert.equal(track.fps, 30000 / 1001);
    assert.equal(srtTimestamp(track.cues[0].endSeconds), "00:00:01,668");
    assert.equal(productionSourceFps({ fps_num: 0 }), 24);
    assert.equal(productionSourceFps({}), 24);
});

test("text slices index code points, so astral characters never shift a cue", () => {
    const draft = source({
        shots: [shot("S1", 0, 48, [speakerRef("U1", 0, 24, 0, 2)]), shot("S2", 1, 48, [speakerRef("U1", 24, 48, 2, 4)])],
        utterances: [{ id: "U1", speakerName: "甲", text: "🎬开拍" }],
    });
    const [track] = productionSubtitleTracks(draft);
    assert.deepEqual(track.cues.map(cue => cue.text), ["🎬开", "拍"]);
});

test("no invented dialogue: unknown utterance ids, empty slices and non-v2 sources produce no cues", () => {
    const draft = source({
        shots: [shot("S1", 0, 48, [speakerRef("MISSING", 0, 24, 0, 3), speakerRef("U1", 24, 48, 2, 2)])],
        utterances: [{ id: "U1", speakerName: "甲", text: "有字" }],
    });
    assert.deepEqual(productionSubtitleTracks(draft), []);
    assert.deepEqual(productionSubtitleTracks({ version: 1, shots: [{ id: "S1", start_frame: 0, end_frame: 24, dialogues: [{ speaker: "甲", text: "旧格式" }] }] }), []);
    assert.deepEqual(productionSubtitleTracks(undefined), []);
});

test("speaker falls back to the registered Subject display name and keeps delivery metadata", () => {
    const draft = source({
        subject_registry: [{ id: "SUBJ", entityRef: { kind: "character", id: "CHAR" } }],
        character_registry: [{ id: "CHAR", name: "青儿" }],
        shots: [shot("S1", 0, 48, [speakerRef("U1", 0, 24, 0, 2)])],
        utterances: [{ id: "U1", speakerSubjectId: "SUBJ", text: "去吧", delivery: "低声", voiceover: true }],
    });
    const [cue] = productionSubtitleTracks(draft)[0].cues;
    assert.equal(cue.speaker, "青儿");
    assert.equal(cue.delivery, "低声");
    assert.equal(cue.voiceover, true);
    assert.equal(cue.text, "去吧");
});
