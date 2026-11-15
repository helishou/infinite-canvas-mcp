import { test } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";

import { exportAchengDeliveryBundle } from "./acheng-delivery-export.js";
import { productionSubtitleTracks } from "./production-subtitles.js";
import { buildCalibrationBindings, calibrateSubtitleTracks, type ClipTranscript, type SubtitleCalibration } from "./subtitle-calibration.js";

const source = {
    version: 2,
    prompt_assembly: { version: 2 },
    ledger: { contract_version: 2, timelines: [{ id: "main", start_frame: 0 }] },
    fps_num: 24,
    fps_den: 1,
    shots: [{
        id: "shot1", duration_frames: 240, story_order: 0, timeline_id: "main",
        utterance_refs: [{ utteranceId: "U1", role: "speaker", localStartFrame: 0, localEndFrame: 48, textStart: 0, textEnd: 5 }],
    }],
    segments: [{ id: "seg1", shot_ids: ["shot1"], locked: true }],
    utterances: [{ id: "U1", speakerName: "甲", text: "快把门打开" }],
    subject_registry: [],
};

const transcript: ClipTranscript = {
    storageKey: "video-1", durationSeconds: 10, text: "快把门打开", language: "zh",
    noSpeechProbability: 0.05,
    words: Array.from("快把门打开").map((word, index) => ({ word, start: 3.5 + index * 0.34, end: 3.84 + index * 0.34, probability: 0.9 })),
    warnings: [],
};

function makeCalibration(sourceHash: string): SubtitleCalibration {
    const tracks = productionSubtitleTracks(source);
    const bindings = buildCalibrationBindings(source, [{ segmentId: "seg1", storageKey: "video-1" }]);
    const { tracks: calibrated, report } = calibrateSubtitleTracks(tracks, [transcript], bindings);
    assert.equal(report.calibrated, 1, "fixture must produce one real calibration");
    return { version: 1, sourceHash, createdAt: "2026-11-14T00:00:00.000Z", model: "base", language: "Chinese", tracks: calibrated, report };
}

async function bundle(calibration: SubtitleCalibration | null) {
    const production = {
        revision: 7, publishedVersion: null, published: null,
        draft: { director: { engine: "minimax-h3", sourceHash: "fixture-hash", source, artifacts: [], assets: {} }, keyframes: {} },
    };
    const readiness = { unresolved: [], targets: [], nextAction: "fixture" };
    const blob = await exportAchengDeliveryBundle({
        owner: { kind: "episode" as const, id: "ep1" }, title: "测试集", projectId: "project-1",
        production: production as never, readiness: readiness as never, canvasNodes: [],
        includeGeneratedMedia: false, calibration,
    });
    return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

test("交付包同时保留创作稿 SRT 与实际音频校准 SRT，剪映字幕改用校准时间", async () => {
    const entries = await bundle(makeCalibration("fixture-hash"));
    const names = Object.keys(entries);
    assert.ok(names.includes("subtitles/main.srt"));
    assert.ok(names.includes("subtitles/calibrated/main.srt"), `缺少校准轨：${names.join(", ")}`);
    assert.ok(names.includes("subtitles/calibrated/index.json"));
    assert.match(strFromU8(entries["subtitles/main.srt"]), /00:00:00,000 --> /);
    assert.match(strFromU8(entries["subtitles/calibrated/main.srt"]), /00:00:03,500 --> /);
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
    assert.equal(manifest.subtitles.contract, "srt-1");
    assert.equal(manifest.subtitles.tracks[0].cues[0].startSeconds, 0, "authored track stays untouched");
    assert.equal(manifest.subtitles.calibrated.contract, "srt-calibrated-1");
    assert.equal(manifest.subtitles.calibrated.tracks[0].cues[0].startSeconds, 3.5);
    assert.equal(manifest.subtitles.calibrated.report.calibrated, 1);
    const draftSrtKey = names.find(name => name.endsWith("/台词字幕.srt"));
    assert.ok(draftSrtKey, "剪映草稿缺字幕文件");
    assert.match(strFromU8(entries[draftSrtKey]), /00:00:03,500 --> /, "Jianying captions must use detected audio timing");
    assert.match(strFromU8(entries["README.txt"]), /Calibrated subtitles \(real audio\)/);
});

test("sourceHash 不匹配的校准被忽略并在 manifest 里留痕，不静默改时间线", async () => {
    const entries = await bundle(makeCalibration("stale-hash"));
    const names = Object.keys(entries);
    assert.equal(names.some(name => name.startsWith("subtitles/calibrated/")), false);
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
    assert.equal(manifest.subtitles.calibrated, undefined);
    assert.ok(manifest.subtitles.warnings.some((item: string) => item.includes("旧 sourceHash")));
    assert.match(strFromU8(entries["README.txt"]), /Calibration warnings:/);
    assert.match(strFromU8(entries["README.txt"]), /Calibrated subtitles: not applied/);
    const draftSrtKey = names.find(name => name.endsWith("/台词字幕.srt"));
    assert.ok(draftSrtKey);
    assert.match(strFromU8(entries[draftSrtKey]), /00:00:00,000 --> /);
});
