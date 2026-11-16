import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { buildDirectorPack, composeSegmentPrompt, packSegmentsToShotRows, packSummary, parseDirectorPack, segmentFromShotGroup, splitTimedLines } from "./director-pack";
import { packToZip, readPackHeader, zipToPack } from "./director-pack-io";

/** 导演大师真实产出的包（本机存在才跑，CI 上跳过）。 */
const REAL_PACK = "E:/daoyanwork/director/projects/prj_c433366ee9f84e0f8ce40e3bb73f4db7/director-packs/E01.mmxpack.zip";

test("段提示词按累计时间拼成「0–6秒：…」", () => {
    const text = composeSegmentPrompt([
        { camera: "中景", visual: "陈灯提灯走进义庄", durationSec: 6 },
        { camera: "特写", visual: "灯纸上的名字", durationSec: 4 },
    ], 24);
    assert.equal(text, "0–6秒：中景。陈灯提灯走进义庄\n6–10秒：特写。灯纸上的名字");
});

test("画布 Clip → 包段落：时长/帧数/累计起点自洽", () => {
    const first = segmentFromShotGroup({ index: 0, id: "seg-1", prompt: "0–6秒：…", durationSec: 6, fps: 24, start: 0 });
    const second = segmentFromShotGroup({ index: 1, id: "seg-2", prompt: "6–12秒：…", durationSec: 5.5, fps: 24, start: 6, continuityFromPrev: true });
    assert.equal(first.frameCount, 144);
    assert.equal(first.length, 144);
    assert.equal(second.frameCount, 132);
    assert.equal(second.start, 6);
    assert.equal(second.continuityFromPrev, true);
});

test("打包 → 解包 原样回来（含 output 与段落）", () => {
    const pack = buildDirectorPack({
        title: "第 1 集",
        output: { width: 1280, height: 720, fps: 24, continuityEnabled: true, continuityOverlapFrames: 22 },
        segments: [
            segmentFromShotGroup({ index: 0, id: "sh_1", prompt: "0–6秒：中景。陈灯提灯", durationSec: 6, fps: 24, start: 0 }),
            segmentFromShotGroup({ index: 1, id: "sh_2", prompt: "6–12秒：特写。灯纸", durationSec: 6, fps: 24, start: 6, continuityFromPrev: true }),
        ],
    });
    const zip = packToZip(pack);
    const back = zipToPack(zip);
    assert.equal(back.timeline.segments.length, 2);
    assert.equal(back.timeline.segments[1].prompt, "6–12秒：特写。灯纸");
    assert.equal(back.timeline.segments[1].continuityFromPrev, true);
    assert.deepEqual(back.timeline.output, pack.timeline.output);
    const header = readPackHeader(zip);
    assert.equal(header.format, "minimax-h3-director-pack");
    assert.equal(header.segments, 2);
    assert.equal(header.output.fps, 24);
});

test("段 → 镜头行：秒数来自 frameCount，空提示词的段被丢掉", () => {
    const rows = packSegmentsToShotRows([
        { id: "a", prompt: "第一段内容", negativePrompt: "", durationSec: 6, frameCount: 144, length: 144, start: 0, taskType: "", refs: [], refAudios: [], refVideos: [], continuityFromPrev: false },
        { id: "b", prompt: "   ", negativePrompt: "", durationSec: 6, frameCount: 144, length: 144, start: 6, taskType: "", refs: [], refAudios: [], refVideos: [], continuityFromPrev: true },
    ], 24);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].seconds, 6);
    assert.equal(rows[0].visual, "第一段内容");
});

test("段内「0–6秒：…」按行拆成镜头，正文去掉时间前缀", () => {
    const beats = splitTimedLines("0–6秒：全景。狄府木牌在右侧。\n6–12秒：特写。灯纸上的名字");
    assert.equal(beats.length, 2);
    assert.equal(beats[0].seconds, 6);
    assert.equal(beats[0].visual, "全景。狄府木牌在右侧。");
    assert.equal(beats[1].seconds, 6);
    assert.deepEqual(splitTimedLines("没有任何时间前缀的一段话"), []);
});

test("真实 E01 包：25 段拆成镜头后，每个镜头正文都不再带「N–M秒：」前缀", { skip: !existsSync(REAL_PACK) }, () => {
    const pack = zipToPack(new Uint8Array(readFileSync(REAL_PACK)));
    const rows = packSegmentsToShotRows(pack.timeline.segments, pack.timeline.output.fps);
    assert.ok(rows.length > pack.timeline.segments.length, `应该拆出更多镜头，实测 ${rows.length}`);
    assert.ok(rows.every(row => !/^\d+(\.\d+)?\s*[–-]/.test(row.visual)), "镜头正文不应再带时间前缀");
    assert.ok(rows.every(row => row.seconds >= 0.5 && row.seconds <= 15));
});

test("空包/坏包要报错，不要静默产出空分镜", () => {
    assert.throws(() => parseDirectorPack({ pack: { format: "something-else" }, timeline: {} }), /不是导演包/);
    assert.throws(() => parseDirectorPack({ pack: { format: "minimax-h3-director-pack", formatVersion: 9 }, timeline: {} }), /版本/);
});

test("能读导演大师真实产出的 E01 包", { skip: !existsSync(REAL_PACK) }, () => {
    const pack = zipToPack(new Uint8Array(readFileSync(REAL_PACK)));
    const summary = packSummary(pack);
    assert.equal(pack.pack.format, "minimax-h3-director-pack");
    assert.equal(summary.segmentCount, 25);
    assert.ok(summary.totalSeconds > 100, `总时长应该合理，实测 ${summary.totalSeconds}`);
    assert.equal(pack.timeline.output.fps, 24);
    assert.ok(pack.timeline.segments[0].prompt.length > 20);
});
