import { describe, expect, it } from "vitest";
import {
    AverageShotSeconds,
    BoundsMs,
    DefaultShotMs,
    DialogueDense,
    DialogueStandard,
    DurationOptions,
    fitDialogue,
    ImportedShotMs,
    MaxSegmentShots,
    MaxStoryboardShotSeconds,
    MinSegmentShots,
    Segment,
    SegmentAuto,
    SegmentFixed,
    SegmentLimits,
    SegmentRange,
    SegmentShotsForVideo,
    segmentLimits,
    segmentTitle,
    ShotMs,
    SnapVideoSeconds,
    durationBounds,
    SpokenMs,
    TargetSeconds,
    NormalizeName,
    Normalized,
    PacingFast,
    PacingRapid,
    PacingSlow,
    dialogueRules,
    pacingRules,
} from "./pacing";

/** 把段数组压成可比较的 [Start, End, Title] 元组。 */
const shape = (segments: Segment[]) => segments.map((s) => [s.Start, s.End, s.Title]);

/** 构造 DurationOptions，字段缺省按 Go 零值。 */
const opts = (o: Partial<DurationOptions> = {}): DurationOptions => ({
    Values: o.Values ?? [],
    Min: o.Min ?? 0,
    Max: o.Max ?? 0,
    Step: o.Step ?? 0,
});

/** 构造 SegmentLimits，字段缺省按 Go 零值。 */
const limits = (o: Partial<SegmentLimits> = {}): SegmentLimits => ({
    Mode: o.Mode ?? SegmentAuto,
    MinMs: o.MinMs ?? 0,
    MaxMs: o.MaxMs ?? 0,
});

describe("pacingRules 五档边界（storyboard.go:222-228）", () => {
    const cases: Array<[string, number, number, number]> = [
        [PacingRapid, 1500, 3000, 2.0],
        [PacingFast, 1500, 4000, 2.5],
        ["standard", 2000, 6000, 3.5],
        ["relaxed", 2500, 8000, 4.5],
        [PacingSlow, 3000, 10000, 5.5],
    ];

    it("规则表逐档对齐影策真源", () => {
        expect(pacingRules[PacingRapid]).toEqual({ minMs: 1500, maxMs: 3000, average: 2.0, label: expect.any(String) });
        expect(pacingRules[PacingFast]).toEqual({ minMs: 1500, maxMs: 4000, average: 2.5, label: expect.any(String) });
        expect(pacingRules.standard).toEqual({ minMs: 2000, maxMs: 6000, average: 3.5, label: expect.any(String) });
        expect(pacingRules.relaxed).toEqual({ minMs: 2500, maxMs: 8000, average: 4.5, label: expect.any(String) });
        expect(pacingRules[PacingSlow]).toEqual({ minMs: 3000, maxMs: 10000, average: 5.5, label: expect.any(String) });
    });

    it.each(cases)("%s 的 BoundsMs / AverageShotSeconds", (mode, low, high, avg) => {
        expect(BoundsMs(mode)).toEqual([low, high]);
        expect(AverageShotSeconds(mode)).toBe(avg);
        // 低于下限夹到下限，高于上限夹到上限（hint 秒数）。
        expect(ShotMs((low - 500) / 1000, "", mode, DialogueDense)).toBe(low);
        expect(ShotMs((high + 2000) / 1000, "", mode, DialogueDense)).toBe(high);
    });

    it("未知档按 rapid 默认（storyboard.go:130-134）", () => {
        expect(BoundsMs("bogus")).toEqual([1500, 3000]);
        expect(AverageShotSeconds("")).toBe(2.0);
    });

    it("dialogueRules 三档对齐（storyboard.go:251-255）", () => {
        expect(dialogueRules[DialogueDense]).toEqual({ charsPerSecond: 4.5, lineSeconds: 3, maxRunes: 12, pauseMs: 300 });
        expect(dialogueRules[DialogueStandard]).toEqual({ charsPerSecond: 4.5, lineSeconds: 4.5, maxRunes: 16, pauseMs: 500 });
        expect(dialogueRules.sparse).toEqual({ charsPerSecond: 4.5, lineSeconds: 7, maxRunes: 20, pauseMs: 500 });
    });
});

describe("ShotMs / SpokenMs / fitDialogue（storyboard.go:288-322）", () => {
    it("ShotMs 的 hint clamp 与默认值（对照 TestShotDurationFollowsDialogue / TestStoryboardRules）", () => {
        expect(ShotMs(3, "台词")).toBe(3000); // 短台词不撑长到超过 hint
        expect(ShotMs(0, "")).toBe(DefaultShotMs); // hint<=0 用 3000
        expect(ShotMs(40, "")).toBe(3000); // rapid 上限 3 秒
        expect(ShotMs(9, "", PacingFast, DialogueDense)).toBe(4000); // fast 上限 4 秒
        expect(ShotMs(0.9, "", PacingFast, DialogueDense)).toBe(1500); // fast 下限 1.5 秒
        expect(ShotMs(12, "", PacingSlow, DialogueDense)).toBe(10000); // slow 上限 10 秒
        expect(ShotMs(2, "", PacingSlow, DialogueDense)).toBe(3000); // slow 下限 3 秒
    });

    it("SpokenMs 按 rune 计字数、TrimSpace 后再算、先截断再加气口", () => {
        expect(SpokenMs("", dialogueRules[DialogueDense])).toBe(0);
        expect(SpokenMs("  台词  ", dialogueRules[DialogueDense])).toBe(744); // 2/4.5*1000=444 + 300
        expect(SpokenMs("话".repeat(90), dialogueRules[DialogueDense])).toBe(20300); // 20000 + 300
        expect(SpokenMs("话".repeat(18), dialogueRules[DialogueStandard])).toBe(4500); // 4000 + 500
        expect(SpokenMs("😀😀", dialogueRules[DialogueDense])).toBe(744); // Array.from 按码点计
    });

    it("fitDialogue 台词撑长并受 60 秒绝对上限约束", () => {
        expect(fitDialogue(1000, "话".repeat(90), dialogueRules[DialogueDense])).toBe(20300);
        expect(fitDialogue(1000, "话".repeat(400), dialogueRules[DialogueDense])).toBe(
            MaxStoryboardShotSeconds * 1000,
        );
        expect(fitDialogue(3000, "台词", dialogueRules[DialogueDense])).toBe(3000); // 短台词不缩短 target
        // ShotMs 走同一条撑长路径（对照 TestShotDurationFollowsDialogue）。
        expect(ShotMs(0, "话".repeat(90))).toBe(20300);
        expect(ShotMs(0, "话".repeat(400))).toBe(60000);
    });

    it("ImportedShotMs 自由 1-60 秒且不按 pacing 夹（对照 TestImportedShotKeepsWrittenDuration）", () => {
        expect(ImportedShotMs(8, "", PacingFast, DialogueStandard)).toBe(8000);
        expect(ImportedShotMs(1, "话".repeat(18), PacingFast, DialogueStandard)).toBe(4500);
        expect(ImportedShotMs(0, "")).toBe(DefaultShotMs);
        expect(ImportedShotMs(90, "")).toBe(MaxStoryboardShotSeconds * 1000);
        expect(ImportedShotMs(0.4, "", PacingFast, DialogueStandard)).toBe(1000); // 下限 1 秒
    });
});

describe("DurationOptions / SnapVideoSeconds（timing.go:21-74）", () => {
    it("Bounds 取档位极值并夹到非负", () => {
        expect(durationBounds(opts({ Values: [10, 5] }))).toEqual([5, 10]);
        expect(durationBounds(opts({ Min: -1, Max: 15 }))).toEqual([0, 15]);
        expect(durationBounds(opts())).toEqual([0, 0]);
    });

    it("SnapVideoSeconds 选择不短于镜头时长的最小档（对照 TestSnapVideoSeconds）", () => {
        expect(SnapVideoSeconds(4700, opts({ Values: [10, 5] }))).toBe(5);
        expect(SnapVideoSeconds(5100, opts({ Values: [5, 10] }))).toBe(10);
        expect(SnapVideoSeconds(3200, opts({ Min: 2, Max: 12, Step: 1 }))).toBe(4);
        expect(SnapVideoSeconds(20000, opts({ Values: [5, 10] }))).toBe(10); // 超过所有档取最长
        expect(SnapVideoSeconds(100, opts())).toBe(5); // 无档位默认 5 秒
        expect(SnapVideoSeconds(7000, opts())).toBe(10); // 无档位 >5 秒默认 10 秒
        expect(SnapVideoSeconds(0, opts({ Values: [10, 5] }))).toBe(5); // need 下限 1，仍取 5
    });
});

describe("NormalizeName / segmentTitle（timing.go:76-86, 209-227）", () => {
    it("NormalizeName 小写、去空白、去标点", () => {
        expect(NormalizeName(" 萧 炎· ")).toBe("萧炎");
        expect(NormalizeName("大厅（东）")).toBe("大厅东");
        expect(NormalizeName("  ABC  ")).toBe("abc");
        expect(NormalizeName("") ).toBe("");
    });

    it("segmentTitle 段内最多 3 个场景名、去重、空段回退", () => {
        expect(segmentTitle(["大厅", " 大厅 ", "后山", "后山", "门口"])).toBe("大厅 / 后山 / 门口");
        expect(segmentTitle(["a", "b", "c", "d"])).toBe("a / b / c");
        expect(segmentTitle(["  ", ""])).toBe("剧情段");
        expect(segmentTitle([])).toBe("剧情段");
    });
});

describe("Normalized / TargetSeconds / segmentLimits（storyboard.go:86-213）", () => {
    it("Normalized 默认值：segmentSeconds=10,min=8,max=15,pacing=rapid,dialogue=dense", () => {
        const s = Normalized({});
        expect(s.SegmentMode).toBe(SegmentFixed);
        expect(s.SegmentSeconds).toBe(10);
        expect(s.SegmentMinSeconds).toBe(8);
        expect(s.SegmentMaxSeconds).toBe(15);
        expect(s.Pacing).toBe(PacingRapid);
        expect(s.Dialogue).toBe(DialogueDense);
        expect(s.Transition).toBe("auto");
        expect(s.TransitionMs).toBe(150);
        expect(s.Performance).toBe(7);
        expect(s.CameraMotion).toBe(3);
    });

    it("Normalized 夹紧范围、纠正 min>max、非法档回退", () => {
        const s = Normalized({
            SegmentMode: "bogus",
            SegmentSeconds: 200,
            SegmentMinSeconds: 20,
            SegmentMaxSeconds: 8,
            Pacing: "weird",
            Dialogue: "x",
            Performance: 99,
            CameraMotion: -1,
        });
        expect(s.SegmentMode).toBe(SegmentFixed);
        expect(s.SegmentSeconds).toBe(60);
        expect(s.SegmentMinSeconds).toBe(8);
        expect(s.SegmentMaxSeconds).toBe(20);
        expect(s.Pacing).toBe(PacingRapid);
        expect(s.Dialogue).toBe(DialogueDense);
        expect(s.Performance).toBe(10);
        expect(s.CameraMotion).toBe(3);
    });

    it("自定义对白参数只在 custom 档补齐并夹紧（storyboard.go:140-145）", () => {
        expect(Normalized({ Dialogue: "custom", SpeechRate: 99 }).SpeechRate).toBe(8.0);
        expect(Normalized({ Dialogue: "custom", LineMaxRunes: 1 }).LineMaxRunes).toBe(4);
        // 预设档下未填的保持未填（0）；填了但越界仍然夹紧（storyboard.go:167-176）。
        expect(Normalized({ Dialogue: DialogueDense, SpeechRate: 9 }).SpeechRate).toBe(8.0);
        expect(Normalized({ Dialogue: DialogueDense }).SpeechRate).toBe(0);
    });

    it("TargetSeconds：range 取中值、其它取上限（storyboard.go:96-102）", () => {
        expect(TargetSeconds(limits({ Mode: SegmentRange, MinMs: 8000, MaxMs: 15000 }))).toBe(11);
        expect(TargetSeconds(limits({ Mode: SegmentFixed, MinMs: 10000, MaxMs: 10000 }))).toBe(10);
        expect(TargetSeconds(limits({ Mode: SegmentAuto, MinMs: 5000, MaxMs: 10000 }))).toBe(10);
    });

    it("SegmentLimits 合成模型档位（对照 TestStoryboardRules）", () => {
        const upTo15 = opts({ Max: 15 });
        expect(segmentLimits({ Pacing: PacingFast, Dialogue: DialogueDense, SegmentMode: SegmentFixed, SegmentSeconds: 10 }, upTo15)).toEqual(
            limits({ Mode: SegmentFixed, MinMs: 10000, MaxMs: 10000 }),
        );
        expect(segmentLimits({ SegmentMode: SegmentFixed, SegmentSeconds: 30 }, upTo15).MaxMs).toBe(15000);
        expect(segmentLimits({}, upTo15)).toEqual(limits({ Mode: SegmentFixed, MinMs: 10000, MaxMs: 10000 }));
        expect(segmentLimits({ SegmentMode: SegmentRange, SegmentMinSeconds: 20, SegmentMaxSeconds: 8 }, upTo15)).toEqual(
            limits({ Mode: SegmentRange, MinMs: 8000, MaxMs: 15000 }),
        );
        const fiveToTen = opts({ Values: [10, 5] });
        expect(segmentLimits({ SegmentMode: SegmentAuto }, fiveToTen)).toEqual(
            limits({ Mode: SegmentAuto, MinMs: 5000, MaxMs: 10000 }),
        );
        expect(segmentLimits({ SegmentMode: SegmentFixed, SegmentSeconds: 4 }, fiveToTen)).toEqual(
            limits({ Mode: SegmentFixed, MinMs: 5000, MaxMs: 5000 }),
        );
        expect(segmentLimits({ SegmentMode: SegmentRange, SegmentMinSeconds: 4, SegmentMaxSeconds: 8 }, opts({ Min: 6, Max: 30, Step: 1 }))).toEqual(
            limits({ Mode: SegmentRange, MinMs: 6000, MaxMs: 8000 }),
        );
        expect(segmentLimits({ SegmentMode: SegmentRange, SegmentMinSeconds: 4, SegmentMaxSeconds: 4 }, opts({ Min: 5, Max: 30, Step: 1 }))).toEqual(
            limits({ Mode: SegmentRange, MinMs: 5000, MaxMs: 5000 }),
        );
    });
});

describe("SegmentShotsForVideo（timing.go:132-184）", () => {
    it("场景切换断开 + 满 9 镜断开 + 尾段合并（对照 TestSegmentShotsGroupsScenesIntoReviewableBlocks）", () => {
        const scenes = [
            "大厅", "大厅", "大厅", "大厅",
            "后山", "后山", "后山", "后山", "后山", "后山", "后山", "后山", "后山", "后山", "后山", "后山",
            "门口",
        ];
        const durations = scenes.map(() => 2000);
        const segments = SegmentShotsForVideo(scenes, durations, limits({ Mode: SegmentAuto }));
        let covered = 0;
        for (const seg of segments) {
            expect(seg.End - seg.Start).toBeLessThanOrEqual(MaxSegmentShots);
            expect(seg.Start).toBe(covered);
            covered = seg.End;
        }
        expect(covered).toBe(scenes.length);
        expect(segments[0].Title).toBe("大厅");
        expect(segments[0].End).toBe(4);
        const last = segments[segments.length - 1];
        expect(last.End - last.Start).toBeGreaterThanOrEqual(MinSegmentShots);
        expect(shape(segments)).toEqual([
            [0, 4, "大厅"],
            [4, 13, "后山"],
            [13, 17, "后山 / 门口"],
        ]);
    });

    it("MaxMs 溢出断开、单镜超上限独占、fixed 按时长装箱、range 尾段借镜（对照 TestSegmentShotsForVideoRespectsModelLimit）", () => {
        const scenes = ["大殿", "大殿", "大殿", "大殿", "后山", "后山"];
        const durations = [5000, 5000, 5000, 5000, 4000, 4000];
        const auto = SegmentShotsForVideo(scenes, durations, limits({ Mode: SegmentAuto, MaxMs: 15000 }));
        expect(shape(auto)).toEqual([
            [0, 3, "大殿"],
            [3, 6, "大殿 / 后山"],
        ]);
        const long = SegmentShotsForVideo(["a", "a"], [20000, 3000], limits({ Mode: SegmentAuto, MaxMs: 15000 }));
        expect(long.length).toBe(2);
        expect(long[0].End).toBe(1);
        const fixed = SegmentShotsForVideo(
            scenes,
            durations,
            limits({ Mode: SegmentFixed, MinMs: 10000, MaxMs: 10000 }),
        );
        expect(shape(fixed)).toEqual([
            [0, 2, "大殿"],
            [2, 4, "大殿"],
            [4, 6, "后山"],
        ]);
        const ranged = SegmentShotsForVideo(
            scenes,
            durations,
            limits({ Mode: SegmentRange, MinMs: 12000, MaxMs: 20000 }),
        );
        expect(shape(ranged)).toEqual([
            [0, 3, "大殿"],
            [3, 6, "大殿 / 后山"],
        ]);
        const choppy = SegmentShotsForVideo(
            ["a", "b", "c", "d", "e", "f"],
            [4000, 4000, 4000, 4000, 4000, 4000],
            limits({ Mode: SegmentRange, MinMs: 12000, MaxMs: 20000 }),
        );
        expect(shape(choppy)).toEqual([
            [0, 3, "a / b / c"],
            [3, 6, "d / e / f"],
        ]);
    });

    it("尾段 rebalance：挪最少镜 / 不跌破前段下限 / 不超上限 / auto 模式补足（对照 TestSegmentShotsForVideoRebalancesShortTrailingSegment）", () => {
        const same = ["a", "a", "a", "a"];
        const balanced = SegmentShotsForVideo(
            same,
            [4000, 4000, 4000, 1000],
            limits({ Mode: SegmentRange, MinMs: 5000, MaxMs: 12000 }),
        );
        expect(shape(balanced)).toEqual([
            [0, 2, "a"],
            [2, 4, "a"],
        ]);
        const kept = SegmentShotsForVideo(
            same.slice(0, 3),
            [5000, 5000, 1000],
            limits({ Mode: SegmentRange, MinMs: 6000, MaxMs: 10000 }),
        );
        expect(shape(kept)).toEqual([
            [0, 2, "a"],
            [2, 3, "a"],
        ]);
        const overflow = SegmentShotsForVideo(
            same,
            [5000, 5000, 9000, 2000],
            limits({ Mode: SegmentRange, MinMs: 3000, MaxMs: 10000 }),
        );
        expect(shape(overflow)).toEqual([
            [0, 2, "a"],
            [2, 3, "a"],
            [3, 4, "a"],
        ]);
        const auto = SegmentShotsForVideo(
            ["a", "a", "b", "b"],
            [4000, 4000, 2000, 1000],
            limits({ Mode: SegmentAuto, MinMs: 4000, MaxMs: 10000 }),
        );
        expect(shape(auto)).toEqual([
            [0, 1, "a"],
            [1, 4, "a / b"],
        ]);
    });

    it("空输入 / 长度不一致返回空数组（Go 返回 nil）", () => {
        expect(SegmentShotsForVideo([], [], limits())).toEqual([]);
        expect(SegmentShotsForVideo(["a"], [], limits())).toEqual([]);
        expect(SegmentShotsForVideo(["a"], [3000], limits())).toEqual([{ Start: 0, End: 1, Title: "a" }]);
    });
});
