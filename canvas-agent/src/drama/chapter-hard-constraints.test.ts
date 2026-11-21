/**
 * 影策分镜硬约束接线测试：
 * 1) segmentMode auto/fixed/range 走 SegmentShotsForVideo 真实切段（3-9 镜、场景切换断开、模型上限收紧）；
 * 2) 自定义对白四参数通过 customDialogueRule 喂进 ShotMs；
 * 3) episodeSeconds 经 ShotTarget/LineTarget 给出诊断，但不改写 LLM 产出。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { planChapterStoryboard, toSceneStoryboardOps, type ChapterStoryboardInput } from "./chapter-storyboard.js";
import { buildChapterDemandPrompt } from "./chapter-demand.js";
import {
    LineTarget,
    ShotTarget,
    ShotMs,
    customDialogueRule,
} from "./pacing.js";

/** 不带情绪/动作词的画面，避免输入文件的 hint 提档逻辑干扰时长断言。 */
const neutralBeats = (count: number, seconds = 2) =>
    Array.from({ length: count }, (_, index) => ({
        title: `画面${index + 1}`,
        visual: `画面${index + 1}。`,
        seconds,
    }));

/** 段落在镜头表中的连续区间（用 shot.id 在 plan.shots 里的下标表示）。 */
const segmentRanges = (plan: ReturnType<typeof planChapterStoryboard>) =>
    plan.segments.map(segment =>
        segment.shot_ids.map(id => plan.shots.findIndex(shot => shot.id === id)),
    );

test("segmentMode 未传时保持旧装箱行为（向后兼容）", () => {
    const plan = planChapterStoryboard({
        chapterId: "EP-LEGACY",
        fps: 24,
        clipSeconds: 5,
        scenes: [{ sceneKey: "s", environmentId: "env", beats: neutralBeats(3, 2) }],
    });
    assert.equal(plan.segments.length, 1);
    assert.deepEqual(plan.segments[0].shot_ids.length, 3);
});

test("fixed 模式：SegmentShotsForVideo 按模型上限收紧后真实切段（每段 3 镜）", () => {
    const plan = planChapterStoryboard({
        chapterId: "EP-FIXED",
        fps: 24,
        pacing: "slow",
        segmentMode: "fixed",
        // 30s 超过模型硬上限 15s，segmentLimits 会收紧到 15s：4s/镜 → 每段 3 镜(12s)。
        segmentSeconds: 30,
        // slow 档 4s hint 落在 3-10s 内，不被情绪/动作提档影响。
        scenes: [{ sceneKey: "s", environmentId: "env", beats: neutralBeats(12, 4) }],
    });
    assert.equal(plan.shots.length, 12);
    assert.equal(plan.segments.length, 4);
    assert.deepEqual(segmentRanges(plan).map(range => range.length), [3, 3, 3, 3]);
    // 连续覆盖、无遗漏、无重叠。
    assert.deepEqual(segmentRanges(plan).flat(), Array.from({ length: 12 }, (_, i) => i));
    for (const segment of plan.segments) {
        assert.equal(segment.mode, "T2VA");
        const frames = segment.shot_ids.reduce((sum, id) => sum + plan.shots.find(shot => shot.id === id)!.duration_frames, 0);
        assert.ok(frames >= 4 * 24 && frames <= 15 * 24, `段落 ${frames} 帧越界`);
    }
});

test("auto/fixed 按场景硬约束切分；单场次内两模式切段密度不同", () => {
    const makeInput = (segmentMode: string, segmentSeconds?: number): ChapterStoryboardInput => ({
        chapterId: "EP-SCENE",
        fps: 24,
        pacing: "rapid",
        segmentMode,
        ...(segmentSeconds ? { segmentSeconds } : {}),
        scenes: [
            { sceneKey: "a", sceneName: "甲处", environmentId: "env-a", beats: neutralBeats(3) },
            { sceneKey: "b", sceneName: "乙处", environmentId: "env-b", beats: neutralBeats(4) },
        ],
    });
    // 两种模式都不允许产出跨场次 Clip（后端 SCENE_STORYBOARD_SCOPE 会拒）。
    for (const plan of [planChapterStoryboard(makeInput("auto")), planChapterStoryboard(makeInput("fixed", 15))]) {
        assert.deepEqual(plan.segments.map(segment => segment.shot_ids.length), [3, 4]);
        for (const segment of plan.segments) {
            const envs = new Set(segment.shot_ids.map(id => planShot(plan, id).scene_id));
            assert.equal(envs.size, 1);
        }
        const covered = plan.segments.flatMap(segment => segment.shot_ids);
        assert.deepEqual(covered, plan.shots.map(shot => shot.id));
        // 每个 op 的 segment.shot_ids 都只含本场镜头，能过后端 scope 校验。
        const ops = toSceneStoryboardOps(plan, new Map([["env-a", "scene-a"], ["env-b", "scene-b"]]));
        for (const op of ops) {
            const owned = new Set(op.shots.map(shot => String(shot.id)));
            for (const segment of op.segments) {
                assert.ok((segment.shot_ids as string[]).every(id => owned.has(id)));
            }
        }
    }

    // 单场次内差异：fixed(8s) 每 4 镜一段；auto(4-15s) 每 7 镜一段。
    const single = (segmentMode: string, segmentSeconds?: number) => planChapterStoryboard({
        chapterId: "EP-DENSITY",
        fps: 24,
        pacing: "rapid",
        segmentMode,
        ...(segmentSeconds ? { segmentSeconds } : {}),
        scenes: [{ sceneKey: "s", environmentId: "env", beats: neutralBeats(14, 2) }],
    });
    assert.deepEqual(single("fixed", 8).segments.map(segment => segment.shot_ids.length), [4, 4, 4, 2]);
    assert.deepEqual(single("auto").segments.map(segment => segment.shot_ids.length), [7, 7]);
});

test("range 模式按 MinMs/MaxMs 切段，段长不超模型上限", () => {
    const plan = planChapterStoryboard({
        chapterId: "EP-RANGE",
        fps: 24,
        pacing: "slow",
        segmentMode: "range",
        segmentMinSeconds: 8,
        segmentMaxSeconds: 15,
        scenes: [{ sceneKey: "s", environmentId: "env", beats: neutralBeats(9, 4) }],
    });
    assert.equal(plan.segments.length, 3);
    assert.deepEqual(segmentRanges(plan).map(range => range.length), [3, 3, 3]);
    for (const segment of plan.segments) {
        assert.ok(segment.shot_ids.length >= 3 && segment.shot_ids.length <= 9);
    }
    assert.deepEqual(segmentRanges(plan).flat(), Array.from({ length: 9 }, (_, i) => i));
});

test("自定义对白四参数改变台词撑长；非法值被影策范围夹紧", () => {
    const dialogue = "话".repeat(40);
    const base: ChapterStoryboardInput = {
        chapterId: "EP-CUSTOM",
        fps: 24,
        pacing: "rapid",
        dialogueMode: "custom",
        scenes: [{ sceneKey: "s", environmentId: "env", beats: [
            { title: "台词", visual: "画面", seconds: 3, dialogue, speaker: "甲" },
        ] }],
    };
    // 40 字 @2 字/秒 + 2000ms 气口 = 22000ms；@8 字/秒 + 100ms = 5100ms。
    const slow = planChapterStoryboard({ ...base, customDialogueRule: { speechRate: 2, linePauseMs: 2000 } });
    const fast = planChapterStoryboard({ ...base, customDialogueRule: { speechRate: 8, linePauseMs: 100 } });
    assert.equal(slow.shots[0].duration_frames, Math.round(22 * 24));
    assert.equal(fast.shots[0].duration_frames, Math.round(5.1 * 24));
    assert.ok(slow.shots[0].duration_frames > fast.shots[0].duration_frames);

    // 非 custom 档忽略自定义规则。
    const standard = planChapterStoryboard({ ...base, dialogueMode: "standard", customDialogueRule: { speechRate: 8 } });
    assert.equal(standard.shots[0].duration_frames, Math.round(9.388 * 24));

    // 纯函数层：夹紧 + 缺省补齐 + ShotMs 规则透传。
    assert.deepEqual(customDialogueRule({ speechRate: 99, linePauseMs: 9999 }), {
        charsPerSecond: 8,
        lineSeconds: 4.5,
        maxRunes: 16,
        pauseMs: 2000,
    });
    assert.equal(ShotMs(3, dialogue, "rapid", "custom", customDialogueRule({ speechRate: 8, linePauseMs: 100 })), 5100);
});

test("episodeSeconds：ShotTarget/LineTarget 诊断不改镜头，提示词给软参考", () => {
    const plan = planChapterStoryboard({
        chapterId: "EP-EST",
        fps: 24,
        pacing: "relaxed",
        dialogueMode: "standard",
        episodeSeconds: 90,
        scenes: [{ sceneKey: "s", environmentId: "env", beats: [
            { title: "一", visual: "画面一。", seconds: 6, dialogue: "台词一。", speaker: "甲" },
            { title: "二", visual: "画面二。", seconds: 6, dialogue: "台词二。", speaker: "甲" },
            { title: "三", visual: "画面三。", seconds: 6 },
        ] }],
    });
    assert.ok(plan.episodeTargets);
    assert.equal(plan.episodeTargets.shotTarget, 20); // round(90 / relaxed 4.5)
    assert.equal(plan.episodeTargets.lineTarget, 20); // round(90 / standard 4.5)
    assert.equal(plan.episodeTargets.actualShots, 3);
    assert.equal(plan.episodeTargets.actualLines, 2);
    assert.equal(plan.shots.length, 3, "估算只诊断，不改写 LLM 产出");
    assert.ok(plan.diagnostics.some(text => text.includes("episodeSeconds=90s")));
    assert.ok(plan.diagnostics.some(text => text.includes("镜头数明显少于估算")));
    assert.ok(plan.diagnostics.some(text => text.includes("台词数明显少于估算")));

    assert.equal(planChapterStoryboard({
        chapterId: "EP-NOEST",
        scenes: [{ sceneKey: "s", environmentId: "env", beats: neutralBeats(1) }],
    }).episodeTargets, undefined);

    const { system } = buildChapterDemandPrompt({
        chapterTitle: "章", chapterBody: "正文", environments: [], episodeSeconds: 90,
    });
    assert.ok(system.includes("目标单集约 90 秒"));
    assert.ok(system.includes("20 镜"));
    assert.ok(!buildChapterDemandPrompt({ chapterTitle: "章", chapterBody: "正文", environments: [] }).system.includes("目标单集"));
});

test("ShotTarget/LineTarget 与影策真源一致（4 下限、240 上限、台词至少 1 条）", () => {
    assert.equal(ShotTarget(90, "relaxed"), 20);
    assert.equal(ShotTarget(1, "rapid"), 4);
    assert.equal(ShotTarget(10000, "rapid"), 240);
    assert.equal(LineTarget(90, "dense"), 30); // dense lineSeconds=3
    assert.equal(LineTarget(0, "dense"), 1);
});

function planShot(plan: ReturnType<typeof planChapterStoryboard>, id: string) {
    const shot = plan.shots.find(item => item.id === id);
    assert.ok(shot, `找不到镜头 ${id}`);
    return shot;
}
