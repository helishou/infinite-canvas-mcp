import assert from "node:assert/strict";
import test from "node:test";
import { planChapterStoryboard, toSceneStoryboardOps, type ChapterStoryboardInput } from "./chapter-storyboard.js";

const base: ChapterStoryboardInput = {
    chapterId: "EP-1",
    fps: 24,
    clipSeconds: 5,
    // 用极快档：这些用例的 2/2.5/3s hint 本就是验证「秒数按帧率量化」的机制，
    // rapid 档 (1.5-3s) 不会 clamp 这些值，保留原断言语义。影策节奏默认走 relaxed，见单独用例。
    pacing: "rapid",
    scenes: [
        {
            sceneKey: "temple",
            sceneName: "破庙",
            environmentId: "env-temple",
            beats: [
                { title: "推门", visual: "陈九推开破庙的门，雨水灌进来。", seconds: 2 },
                { title: "抬眼", visual: "他抬眼看向供桌后的黑影。", seconds: 2.5 },
                { title: "拔刀", visual: "刀光出鞘。", seconds: 3 },
            ],
        },
    ],
};

test("秒数按帧率量化；段长必须落在 4–15 秒，不足 4 秒的尾段并入前一段", () => {
    const plan = planChapterStoryboard(base);
    assert.deepEqual(plan.shots.map(shot => shot.duration_frames), [48, 60, 72], "2s/2.5s/3s @24fps");
    assert.equal(plan.totalFrames, 180);
    assert.equal(plan.totalSeconds, 7.5);
    // 旧规则会切成 4.5s + 3s，但 3s 低于编译器 4 秒下限会被拒；现在 3s 尾段并回，整段 7.5s 合法。
    assert.equal(plan.segments.length, 1);
    assert.deepEqual(plan.segments[0].shot_ids.length, 3);
    const frames = plan.segments[0].shot_ids.reduce((sum, id) => sum + plan.shots.find(shot => shot.id === id)!.duration_frames, 0);
    assert.ok(frames >= 96 && frames <= 360, `段落 ${plan.segments[0].id} 落在 4-15 秒之外：${frames}`);
});

test("时长足够时仍按 5 秒目标切段", () => {
    // slow 档 (3-10s) 容纳 4s hint，验证分段装箱机制（不受 rapid 的 3s 上限 clamp）
    const plan = planChapterStoryboard({ ...base, pacing: "slow", scenes: [{ ...base.scenes[0], beats: [
        { title: "一", visual: "a", seconds: 4 },
        { title: "二", visual: "b", seconds: 4 },
        { title: "三", visual: "c", seconds: 4 },
    ] }] });
    assert.deepEqual(plan.segments.map(segment => segment.shot_ids.length), [1, 1, 1], "每镜 4s 恰好到达下限，各自独立成段");
    for (const segment of plan.segments) {
        const frames = segment.shot_ids.reduce((sum, id) => sum + plan.shots.find(shot => shot.id === id)!.duration_frames, 0);
        assert.ok(frames >= 96 && frames <= 360);
    }
});

test("所有镜头都被恰好一个 Clip 覆盖，且顺序与镜头表一致", () => {
    const plan = planChapterStoryboard(base);
    const covered = plan.segments.flatMap(segment => segment.shot_ids);
    assert.deepEqual(covered, plan.shots.map(shot => shot.id));
    assert.equal(new Set(covered).size, plan.shots.length);
});

test("单镜超过单段上限时独占一段并给出诊断，不静默改镜头时长", () => {
    const plan = planChapterStoryboard({
        ...base,
        pacing: "slow", // slow 档 (3-10s) 容纳 8s 长镜，验证「超过单段上限独占一段」
        scenes: [{ ...base.scenes[0], beats: [{ title: "长镜", visual: "长达八秒的长镜头。", seconds: 8 }] }],
    });
    assert.equal(plan.shots[0].duration_frames, 192);
    assert.equal(plan.segments.length, 1);
    assert.ok(plan.diagnostics.some(text => text.includes("独占一段")));
});

test("段落不跨场次", () => {
    const plan = planChapterStoryboard({
        ...base,
        scenes: [
            { sceneKey: "a", environmentId: "env-a", beats: [{ title: "甲", visual: "场次甲。", seconds: 2 }] },
            { sceneKey: "b", environmentId: "env-b", beats: [{ title: "乙", visual: "场次乙。", seconds: 2 }] },
        ],
    });
    assert.equal(plan.segments.length, 2);
    for (const segment of plan.segments) {
        const environments = new Set(segment.shot_ids.map(id => plan.shots.find(shot => shot.id === id)!.scene_id));
        assert.equal(environments.size, 1, "一个 Clip 只能属于一个场次");
    }
});

test("同一输入重跑得到完全相同的 ID，换章节则变化", () => {
    const first = planChapterStoryboard(base);
    const second = planChapterStoryboard(base);
    assert.deepEqual(first.shots.map(shot => shot.id), second.shots.map(shot => shot.id));
    assert.deepEqual(first.segments.map(segment => segment.id), second.segments.map(segment => segment.id));
    const other = planChapterStoryboard({ ...base, chapterId: "EP-2" });
    assert.notDeepEqual(first.shots.map(shot => shot.id), other.shots.map(shot => shot.id));
});

test("只有台词没有说话人时不写对白，并给出诊断", () => {
    const plan = planChapterStoryboard({
        ...base,
        scenes: [{ ...base.scenes[0], beats: [{ title: "独白", visual: "他望着雨。", seconds: 2, dialogue: "这雨，怕是要下一夜。" }] }],
    });
    assert.equal(plan.shots[0].dialogue, undefined);
    assert.ok(plan.diagnostics.some(text => text.includes("没说话人")));
    const withSpeaker = planChapterStoryboard({
        ...base,
        scenes: [{ ...base.scenes[0], beats: [{ title: "独白", visual: "他望着雨。", seconds: 2, dialogue: "这雨，怕是要下一夜。", speaker: "陈九" }] }],
    });
    assert.deepEqual(withSpeaker.shots[0].dialogue, { speaker: "陈九", text: "这雨，怕是要下一夜。" });
});

test("提交载荷不带帧窗字段，Clip 覆盖本场全部镜头", () => {
    const plan = planChapterStoryboard(base);
    const ops = toSceneStoryboardOps(plan, new Map([["env-temple", "SCENE-1"]]));
    assert.equal(ops.length, 1);
    const [op] = ops;
    assert.equal(op.sceneId, "SCENE-1");
    for (const shot of op.shots) {
        assert.equal(Object.hasOwn(shot, "start_frame"), false);
        assert.equal(Object.hasOwn(shot, "end_frame"), false);
        assert.ok(Number.isInteger(shot.duration_frames));
    }
    for (const segment of op.segments) {
        for (const field of ["start_frame", "end_frame", "duration_frames", "generation_clip_duration"]) {
            assert.equal(Object.hasOwn(segment, field), false, `Clip 不得保存 ${field}`);
        }
        assert.ok(segment.shot_ids!.length > 0);
    }
    const covered = new Set(op.segments.flatMap(segment => segment.shot_ids as string[]));
    assert.equal(covered.size, op.shots.length);
});

test("台词随镜头进入 op.shots.dialogues（复数、{speaker,text}），无台词镜头不带空字段", () => {
    const plan = planChapterStoryboard({
        chapterId: "EP-DLG",
        scenes: [{ sceneKey: "s", environmentId: "env-庙", beats: [
            { title: "开口", visual: "陈九开口。", seconds: 3, speaker: "陈九", dialogue: "这雨怕是要下一夜。" },
            { title: "沉默", visual: "小红沉默。", seconds: 3 },
        ] }],
    });
    assert.deepEqual(plan.shots[0].dialogue, { speaker: "陈九", text: "这雨怕是要下一夜。" });
    const [op] = toSceneStoryboardOps(plan, new Map([["env-庙", "scene-1"]]));
    assert.deepEqual(op.shots[0].dialogues, [{ speaker: "陈九", text: "这雨怕是要下一夜。" }]);
    assert.equal(op.shots[0].source_scene_id, "scene-1", "镜头须显式归属剧本场次，否则后端整批拒绝");
    assert.equal(Object.hasOwn(op.shots[1], "dialogues"), false, "没有台词的镜头不应出现空字段");
});

test("结构性错误给出可定位的报错码", () => {
    assert.throws(() => planChapterStoryboard({ chapterId: "EP-1", scenes: [] }), /CHAPTER_STORYBOARD_EMPTY/);
    assert.throws(() => planChapterStoryboard({ chapterId: "EP-1", scenes: [{ sceneKey: "s", environmentId: "", beats: [] }] }), /CHAPTER_STORYBOARD_ENVIRONMENT/);
    assert.throws(() => planChapterStoryboard({ chapterId: "EP-1", scenes: [{ sceneKey: "s", environmentId: "env", beats: [{ title: "空", visual: "   ", seconds: 1 }] }] }), /CHAPTER_STORYBOARD_BEATS/);
});

test("shotInputs 精确覆盖本场每个镜头（后端硬校验要求键集合一致）", () => {
    const plan = planChapterStoryboard({
        chapterId: "EP-9",
        scenes: [{
            sceneKey: "s1",
            environmentId: "env-殿",
            beats: [
                { title: "甲", visual: "殿下跪着两个人。", seconds: 2 },
                { title: "乙", visual: "刀落，血溅在砖上。", seconds: 2 },
            ],
        }],
    });
    const ops = toSceneStoryboardOps(plan, new Map([["env-殿", "scene-9"]]));
    assert.equal(ops.length, 1);
    const op = ops[0];
    const ids = op.shots.map(shot => String(shot.id));
    assert.deepEqual(Object.keys(op.shotInputs).sort(), [...ids].sort());
    for (const id of ids) {
        const input = op.shotInputs[id] as Record<string, unknown>;
        assert.equal(input.keyframePolicy, "none");
        assert.deepEqual(input.assetIds, []);
    }
});

test("多个场次各出一个 op，sceneId 走映射", () => {
    const plan = planChapterStoryboard({
        chapterId: "EP-9",
        scenes: [
            { sceneKey: "a", environmentId: "env-山", beats: [{ title: "甲", visual: "山雨。", seconds: 2 }] },
            { sceneKey: "b", environmentId: "env-庙", beats: [{ title: "乙", visual: "庙门。", seconds: 2 }] },
        ],
    });
    const ops = toSceneStoryboardOps(plan, new Map([["env-山", "scene-a"], ["env-庙", "scene-b"]]));
    assert.deepEqual(ops.map(op => op.sceneId).sort(), ["scene-a", "scene-b"]);
    for (const op of ops) assert.equal(Object.keys(op.shotInputs).length, op.shots.length);
});

test("Shot.camera 是编译器要求的结构体，framing 与 editorial_reason 必须非空", () => {
    const plan = planChapterStoryboard({
        chapterId: "EP-CAM",
        scenes: [{ sceneKey: "s", environmentId: "env-庙", beats: [
            { title: "全景", visual: "全景，破庙在雨里。", camera: "全景缓推", seconds: 2 },
            { title: "特写", visual: "他眼眶发红。", camera: "特写，眼睫颤动", seconds: 2 },
            { title: "默认", visual: "他把册子塞进怀里。", seconds: 2 },
        ] }],
    });
    for (const shot of plan.shots) {
        assert.equal(typeof shot.camera, "object", "camera 必须是对象");
        assert.ok(shot.camera.framing, "framing 必填");
        assert.ok(shot.camera.editorial_reason.trim(), "editorial_reason 必填");
        assert.ok(["EWS", "WS", "FS", "MS", "MCU", "CU", "ECU"].includes(shot.camera.framing));
    }
    assert.equal(plan.shots[0].camera.framing, "WS");
    assert.equal(plan.shots[1].camera.framing, "CU");
    assert.equal(plan.shots[2].camera.framing, "MS", "认不出景别时退回中景");
});

test("Clip 的 mode 落在编译器枚举内，默认 T2VA，可显式覆盖为 Ref2VA", () => {
    const build = (executionMode?: "T2VA" | "Ref2VA") => planChapterStoryboard({
        chapterId: "EP-MODE",
        ...(executionMode ? { executionMode } : {}),
        scenes: [{ sceneKey: "s", environmentId: "env-庙", beats: [{ title: "一", visual: "雨落。", seconds: 3 }] }],
    });
    const allowed = ["T2VA", "I2VA", "FL2VA", "L2VA", "Ref2VA"];
    for (const plan of [build(), build("Ref2VA")]) {
        for (const segment of plan.segments) assert.ok(allowed.includes(segment.mode), `非法 mode: ${segment.mode}`);
    }
    assert.equal(build().segments[0].mode, "T2VA");
    assert.equal(build("Ref2VA").segments[0].mode, "Ref2VA");
});

test("op.shots[].characters 非空才写；shotInputs.assetIds 来自 beat.propIds，键集合一致且不含帧窗字段", () => {
    const plan = planChapterStoryboard({
        chapterId: "EP-REF",
        scenes: [{ sceneKey: "s", environmentId: "env-庙", beats: [
            { title: "甲", visual: "陈九拔刀。", seconds: 3, characterIds: ["CHAR-CHEN"], propIds: ["PROP-SWORD"], sceneId: "env-庙" },
            { title: "乙", visual: "小红沉默。", seconds: 3 },
        ] }],
    });
    const [op] = toSceneStoryboardOps(plan, new Map([["env-庙", "scene-ref"]]));
    // shot 级角色引用：非空才写，空镜不带该字段；scene_id 用 environmentId，不是 scene_registry.id。
    assert.deepEqual(op.shots[0].characters, ["CHAR-CHEN"]);
    assert.equal(Object.hasOwn(op.shots[1], "characters"), false);
    for (const shot of op.shots) {
        assert.equal(shot.scene_id, "env-庙", "scene_id 必须是 environmentId，否则 scene-storyboard.ts:56 拒绝");
        assert.equal(Object.hasOwn(shot, "assetIds"), false, "assetIds 只能出现在 shotInputs，不得塞进 shot");
        assert.equal(Object.hasOwn(shot, "start_frame"), false);
        assert.equal(Object.hasOwn(shot, "end_frame"), false);
        assert.ok(Number.isInteger(shot.duration_frames) && Number(shot.duration_frames) > 0);
    }
    // shotInputs 精确覆盖 + 道具资产 ID
    const ids = op.shots.map(shot => String(shot.id));
    assert.deepEqual(Object.keys(op.shotInputs).sort(), [...ids].sort());
    assert.deepEqual((op.shotInputs[ids[0]] as Record<string, unknown>).assetIds, ["PROP-SWORD"]);
    assert.deepEqual((op.shotInputs[ids[1]] as Record<string, unknown>).assetIds, []);
});

test("结构化引用改造不破坏 dialogues 回归：台词照旧进 op.shots.dialogues", () => {
    const plan = planChapterStoryboard({
        chapterId: "EP-REF-DLG",
        scenes: [{ sceneKey: "s", environmentId: "env-庙", beats: [
            { title: "开口", visual: "陈九开口。", seconds: 3, speaker: "陈九", dialogue: "这雨怕是要下一夜。", characterIds: ["CHAR-CHEN"], propIds: [] },
        ] }],
    });
    const [op] = toSceneStoryboardOps(plan, new Map([["env-庙", "scene-ref"]]));
    assert.deepEqual(op.shots[0].dialogues, [{ speaker: "陈九", text: "这雨怕是要下一夜。" }]);
    assert.deepEqual(op.shots[0].characters, ["CHAR-CHEN"]);
});
