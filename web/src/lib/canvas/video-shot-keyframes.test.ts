import assert from "node:assert/strict";
import test from "node:test";

import { CUT_BASE_RATIO, CUT_MERGE_SECONDS, MAX_SHOT_KEYFRAMES, MIN_CUT_SCORE, detectCuts } from "./video-shot-keyframes";
import { REAL_H3_SAMPLE_SCORES } from "./__real_scores";

/** 采样格：1/12 秒。取样点必须落在格上，否则 makeSamples 写不进峰值。 */
const GRID = 12;
function gridTime(seconds: number) {
    return Number((Math.round(seconds * GRID) / GRID).toFixed(3));
}

/** 造一串样本：低噪底 + 指定位置的跳变峰。 */
function makeSamples(peaks: Array<{ time: number; score: number }>, total = 60, base = 0.02) {
    const marked = new Map(peaks.map((peak) => [Number(peak.time.toFixed(3)), peak.score]));
    return Array.from({ length: total }, (_, index) => {
        const time = Number((index / GRID).toFixed(3));
        // 一点点抖动，模拟真实画面而不是完美常数。
        return { time, score: marked.get(time) ?? base + (index % 3) * 0.004 };
    });
}

/** 把真实分数数组还原成带时间戳的样本。 */
function realSamples() {
    return REAL_H3_SAMPLE_SCORES.map((score, index) => ({ time: Number((index / GRID).toFixed(3)), score }));
}

/** ffmpeg scene score 在同一视频上给出的 10 个切点，作为真值。 */
const FFMPEG_CUTS = [0.792, 1.583, 2.417, 3.333, 3.917, 4.792, 5.25, 6.0, 6.708, 7.333];

test("无跳变时返回空", () => {
    assert.deepEqual(detectCuts(makeSamples([])), []);
});

test("单个跳变被识别为镜1", () => {
    const cuts = detectCuts(makeSamples([{ time: 2, score: 0.55 }]));
    assert.equal(cuts.length, 1);
    assert.equal(cuts[0].index, 1);
    assert.equal(cuts[0].time, 2);
});

test("多个跳变按时间顺序编号", () => {
    const cuts = detectCuts(makeSamples([
        { time: 1, score: 0.5 },
        { time: 2.5, score: 0.7 },
        { time: 4, score: 0.45 },
    ]));
    assert.deepEqual(cuts.map((cut) => cut.index), [1, 2, 3]);
    assert.deepEqual(cuts.map((cut) => cut.time), [1, 2.5, 4]);
});

test("同一次转场的连续多个峰只保留最强的一个", () => {
    const cuts = detectCuts(makeSamples([
        { time: 2, score: 0.4 },
        { time: gridTime(2 + CUT_MERGE_SECONDS / 3), score: 0.75 },
        { time: gridTime(2 + (CUT_MERGE_SECONDS * 2) / 3), score: 0.5 },
    ]));
    assert.equal(cuts.length, 1);
    assert.equal(cuts[0].score, 0.75);
});

test("间隔超过合并窗口的两次跳变算两镜", () => {
    const cuts = detectCuts(makeSamples([
        { time: 2, score: 0.4 },
        { time: gridTime(2 + CUT_MERGE_SECONDS + 0.5), score: 0.38 },
    ]));
    assert.equal(cuts.length, 2);
    assert.deepEqual(cuts.map((cut) => cut.index), [1, 2]);
});

test("整段静止（全样本同分）不会误报", () => {
    const still = Array.from({ length: 40 }, (_, index) => ({ time: Number((index / GRID).toFixed(3)), score: 0 }));
    assert.deepEqual(detectCuts(still), []);
});

test("低于绝对阈值的抖动不算切换", () => {
    assert.deepEqual(detectCuts(makeSamples([{ time: 3, score: 0.03 }])), []);
});

test("样本不足时返回空", () => {
    assert.deepEqual(detectCuts([]), []);
    assert.deepEqual(detectCuts([{ time: 0, score: 0.9 }]), []);
});

test("baseRatio 越大越保守", () => {
    const samples = makeSamples([{ time: 2, score: 0.2 }]);
    assert.equal(detectCuts(samples, 2.0, 0.05).length, 1);
    assert.equal(detectCuts(samples, 20, 0.05).length, 0);
});

test("真实回归：H3 成片应检出全部 10 个分镜", () => {
    const cuts = detectCuts(realSamples());
    assert.equal(cuts.length, FFMPEG_CUTS.length, `实得 ${cuts.length} 个：${cuts.map((cut) => cut.time).join(", ")}`);
});

test("真实回归：检出位置与 ffmpeg 真值逐一对应", () => {
    const cuts = detectCuts(realSamples());
    // 容差 250ms。实测第 6 镜我落在 4.667、ffmpeg 报 4.792：像素直方图和 RGB 平均差
    // 对「什么时候算跳变」的口径不同，早半格抽帧反而更好。切点数必须严格相等。
    cuts.forEach((cut, index) => {
        const error = Math.abs(cut.time - FFMPEG_CUTS[index]);
        assert.ok(error <= 0.25, `第 ${index + 1} 镜偏差 ${(error * 1000).toFixed(0)}ms，超出 250ms 容差`);
    });
});

test("真实回归：噪声中位数必须高于绝对阈值，否则样本会被直接卡死", () => {
    // 这组数据的中位数约 0.067。旧阈值 0.12 会先卡掉一半以上样本，只检出 8/10。
    const sorted = [...REAL_H3_SAMPLE_SCORES].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    assert.ok(MIN_CUT_SCORE < median, `MIN_CUT_SCORE(${MIN_CUT_SCORE}) 必须低于噪声中位数(${median.toFixed(4)})`);
});

test("真实回归：切点数对 baseRatio 不敏感（不是卡在临界点的孤岛）", () => {
    // 之前 ratio=1.8 恰好命中 10 个，但 1.7/1.9 都只有 9 个 —— 那是临界点不是稳健值。
    // 全局中位基线下，正确区间内检出数应保持稳定。
    for (const ratio of [1.7, 1.8, 1.9, 2.0, 2.2]) {
        const cuts = detectCuts(realSamples(), ratio, MIN_CUT_SCORE);
        assert.ok(cuts.length >= 9, `ratio ${ratio} 只检出 ${cuts.length} 个，过于敏感`);
    }
});

test("真实回归：静帧段不产生误报（检出数不超过真值）", () => {
    const cuts = detectCuts(realSamples());
    assert.ok(cuts.length <= FFMPEG_CUTS.length, `检出 ${cuts.length} 个，超过真值，多半是误报`);
});

test("负样本：连续变化但无切换的画面不应检出", () => {
    // ffmpeg testsrc2 6 秒连续动画，实测中位 0.0466 / max 0.0650，阈值 0.0932 -> 0 检出。
    const scores = [
        0.0466, 0.0481, 0.0452, 0.0477, 0.0490, 0.0443, 0.0468, 0.0502, 0.0459, 0.0471,
        0.0448, 0.0485, 0.0460, 0.0493, 0.0455, 0.0479, 0.0439, 0.0488, 0.0464, 0.0650,
        0.0457, 0.0472, 0.0491, 0.0446, 0.0469, 0.0480, 0.0451, 0.0475, 0.0449, 0.0466,
    ];
    assert.deepEqual(detectCuts(scores.map((score, index) => ({ time: Number((index / GRID).toFixed(3)), score }))), []);
});

test("负样本：灰底加噪点（近似静止）不应检出", () => {
    // 实测中位 0.0004 / max 0.0008。
    const scores = Array.from({ length: 30 }, (_, index) => ({ time: Number((index / GRID).toFixed(3)), score: 0.0004 + (index % 5) * 0.0001 }));
    assert.deepEqual(detectCuts(scores), []);
});

test("导出常量是合理正数", () => {
    assert.ok(MAX_SHOT_KEYFRAMES > 0 && MAX_SHOT_KEYFRAMES <= 200);
    assert.ok(CUT_BASE_RATIO > 1);
    assert.ok(CUT_MERGE_SECONDS > 0);
    assert.ok(MIN_CUT_SCORE > 0 && MIN_CUT_SCORE < 0.2);
});
