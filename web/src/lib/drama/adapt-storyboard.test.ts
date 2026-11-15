import assert from "node:assert/strict";
import test from "node:test";

import {
    buildPlan,
    draftFromParsed,
    draftToDemand,
    mergeWithNext,
    moveShot,
    patchShot,
    removeShot,
    shotIssues,
    splitShot,
    toBeats,
    toWriteOps,
    withReusedClipIds,
    promoteStoryboardToCanvas,
} from "./adapt-storyboard";

const parsed = {
    sceneName: "山神庙",
    timeOfDay: "夜",
    diagnostics: [],
    beats: [
        { title: "镜头 1", visual: "暴雨砸在破瓦上。", seconds: 2 },
        { title: "镜头 2", visual: "刀客推门而入。", seconds: 2, dialogue: "把册子留下。", speaker: "刀客" },
        { title: "镜头 3", visual: "少年抬起头。", seconds: 2 },
    ],
};

test("节拍转成可编辑行，台词与说话人带上", () => {
    const rows = draftFromParsed(parsed);
    assert.equal(rows.length, 3);
    assert.equal(rows[1].speaker, "刀客");
    assert.equal(rows[1].dialogue, "把册子留下。");
    assert.ok(rows.every(row => row.key.startsWith("row-")));
});

test("改、删、上下移动都返回新数组且不改原值", () => {
    const rows = draftFromParsed(parsed);
    const patched = patchShot(rows, rows[0].key, { seconds: 4 });
    assert.equal(patched[0].seconds, 4);
    assert.equal(rows[0].seconds, 2);

    const removed = removeShot(rows, rows[1].key);
    assert.equal(removed.length, 2);
    assert.equal(rows.length, 3);

    const moved = moveShot(rows, rows[2].key, -1);
    assert.equal(moved[1].key, rows[2].key);
    assert.equal(moved[0].key, rows[0].key);
    assert.equal(moveShot(rows, rows[0].key, -1)[0].key, rows[0].key, "越界移动原样返回");
});

test("拆镜在句号处切开，时长按字数比例分且总量守恒", () => {
    const rows = [{ ...draftFromParsed(parsed)[0], visual: "他推开门。屋里没有人。桌上放着一封信。", seconds: 6 }];
    const [first, second] = splitShot(rows, rows[0].key);
    assert.ok(first.visual.endsWith("。"));
    assert.ok(second.visual.length > 0);
    assert.equal(Math.round((first.seconds + second.seconds) * 2) / 2, 6);
    assert.notEqual(first.key, second.key);
});

test("合并下一镜：画面拼接、时长相加、台词只留第一镜", () => {
    const rows = draftFromParsed(parsed);
    const merged = mergeWithNext(rows, rows[1].key);
    assert.equal(merged.length, 2);
    assert.ok(merged[1].visual.includes("刀客推门而入") && merged[1].visual.includes("少年抬起头"));
    assert.equal(merged[1].seconds, 4);
    assert.equal(merged[1].speaker, "刀客");
});

test("toBeats 跳过空画面，缺说话人的台词不带出去", () => {
    const rows = [
        { key: "a", title: "甲", visual: "有画面。", camera: "", seconds: 2, dialogue: "台词。", speaker: "" },
        { key: "b", title: "乙", visual: "   ", camera: "", seconds: 2, dialogue: "", speaker: "" },
    ];
    const beats = toBeats(rows);
    assert.equal(beats.length, 1);
    assert.equal(beats[0].dialogue, undefined);
});

test("写稿 op：一段分镜 + 每句台词一个 utterance，帧窗在镜头内", () => {
    const plan = buildPlan({ chapterId: "EP-1", environmentId: "山神庙", rows: draftFromParsed(parsed), fps: 24 });
    const ops = toWriteOps({ plan, sceneId: "scene-1", environmentId: "山神庙", fps: 24 });
    const storyboard = ops.filter(op => op.type === "replace_director_scene_storyboard");
    const utterances = ops.filter(op => op.type === "set_director_shot_utterances");
    assert.equal(storyboard.length, 1);
    assert.equal(utterances.length, 1);
    assert.equal(utterances[0].speakerName, undefined, "XOR：只给 speakerName，不能同时给 id");
    const rowsUtterance = (utterances[0].utterances as Array<Record<string, unknown>>)[0];
    assert.equal(rowsUtterance.speakerName, "刀客");
    const shotFrames = (storyboard[0].shots as Array<Record<string, unknown>>)
        .find(shot => shot.id === utterances[0].shotId)!.duration_frames as number;
    assert.ok((rowsUtterance.localStartFrame as number) >= 0);
    assert.ok((rowsUtterance.localEndFrame as number) <= shotFrames);
    assert.ok((rowsUtterance.localEndFrame as number) > (rowsUtterance.localStartFrame as number));
});

test("复用原 Clip ID：数量一致时按序替换", () => {
    const plan = buildPlan({ chapterId: "EP-1", environmentId: "山神庙", rows: draftFromParsed(parsed), clipSeconds: 10 });
    assert.equal(plan.segments.length, 1, "先确认只有一个 Clip");
    const reused = withReusedClipIds(plan, ["clip-old-1"]);
    assert.deepEqual(reused.segments.map(segment => segment.id), ["clip-old-1"]);
    assert.deepEqual(reused.segments[0].shot_ids, plan.segments[0].shot_ids);
});

test("复用原 Clip ID：数量不一致时给出可操作的报错", () => {
    const plan = buildPlan({ chapterId: "EP-1", environmentId: "山神庙", rows: draftFromParsed(parsed), clipSeconds: 10 });
    assert.throws(() => withReusedClipIds(plan, ["a", "b"]), /SCENE_STORYBOARD_CLIPS/);
});

test("草案回写需求正文，含场景与镜头标记", () => {
    const demand = draftToDemand(draftFromParsed(parsed), { sceneName: "山神庙", timeOfDay: "夜" });
    assert.ok(demand.startsWith("【场景：山神庙】\n【时间：夜】"), "场景与时间各占一行，否则后端正则会把时间并入场景名");
    assert.equal((demand.match(/【镜头 \d+】/g) || []).length, 3);
    assert.ok(demand.includes("刀客：「把册子留下。」"));
});

test("体检标出空画面、缺说话人、非法时长", () => {
    const issues = shotIssues([
        { key: "a", title: "甲", visual: "", camera: "", seconds: 2, dialogue: "", speaker: "" },
        { key: "b", title: "乙", visual: "有画面", camera: "", seconds: 0, dialogue: "台词", speaker: "" },
    ]);
    assert.equal(issues.length, 3);
    assert.ok(issues.some(text => text.includes("没有画面描述")));
    assert.ok(issues.some(text => text.includes("没写说话人")));
    assert.ok(issues.some(text => text.includes("时长必须大于 0")));
});

test("接入画布：全部 ready 时跳过编译，直接准备并同步", async () => {
    const calls: string[] = [];
    const result = await promoteStoryboardToCanvas({
        segmentTargets: async () => [{ id: "segment:c1", status: "ready" }, { id: "segment:c2", status: "complete" }],
        publish: async () => { calls.push("publish"); return { publishedVersion: 1 }; },
        compile: async () => { calls.push("compile"); return { operationId: "op" }; },
        pollCompilation: async () => { calls.push("poll"); return { status: "succeeded", preparedId: "p" }; },
        applyCompilation: async () => { calls.push("apply"); },
        prepareTargets: async targets => { calls.push(`prepare:${targets.join(",")}`); },
        syncClips: async () => { calls.push("sync"); },
    });
    assert.equal(result.segments, 2);
    assert.ok(!calls.includes("publish"), "不应重新发布");
    assert.ok(!calls.includes("compile"));
    assert.deepEqual(calls.filter(c => c.startsWith("prepare")), ["prepare:segment:c1,segment:c2"]);
    assert.ok(calls.includes("sync"));
});

test("接入画布：未就绪时走 发布→编译→轮询→应用→再发布，然后准备同步", async () => {
    const calls: string[] = [];
    let rounds = 0;
    const result = await promoteStoryboardToCanvas({
        segmentTargets: async () => {
            rounds += 1;
            return rounds <= 1
                ? [{ id: "segment:c1", status: "blocked", blockers: ["缺少编译提示词"] }]
                : [{ id: "segment:c1", status: "ready" }];
        },
        publish: async () => { calls.push("publish"); return { publishedVersion: calls.filter(c => c === "publish").length }; },
        compile: async () => { calls.push("compile"); return { operationId: "op-1" }; },
        pollCompilation: async () => { calls.push("poll"); return { status: "succeeded", preparedId: "p-1" }; },
        applyCompilation: async preparedId => { calls.push(`apply:${preparedId}`); },
        prepareTargets: async () => { calls.push("prepare"); },
        syncClips: async () => { calls.push("sync"); },
    }, step => calls.push(`step:${step}`));
    assert.equal(result.segments, 1);
    assert.equal(calls.filter(c => c === "publish").length, 2, "apply 前后各发布一次");
    assert.ok(calls.includes("apply:p-1"));
    assert.ok(calls.includes("sync"));
});

test("接入画布：编译失败时给出阻塞原因", async () => {
    await assert.rejects(
        () => promoteStoryboardToCanvas({
            segmentTargets: async () => [{ id: "segment:c1", status: "blocked", blockers: ["x"] }],
            publish: async () => ({ publishedVersion: 1 }),
            compile: async () => ({ operationId: "op" }),
            pollCompilation: async () => ({ status: "blocked", blockedMessage: "提示词为空" }),
            applyCompilation: async () => {},
            prepareTargets: async () => {},
            syncClips: async () => {},
        }),
        /提示词为空/,
    );
});

test("接入画布：同步前仍有阻塞目标则报出第一条 blocker", async () => {
    await assert.rejects(
        () => promoteStoryboardToCanvas({
            segmentTargets: async () => [{ id: "segment:c1", status: "blocked", blockers: ["请选择图片模型"] }],
            publish: async () => ({ publishedVersion: 1 }),
            compile: async () => ({ operationId: "op" }),
            pollCompilation: async () => ({ status: "succeeded", preparedId: "p" }),
            applyCompilation: async () => {},
            prepareTargets: async () => {},
            syncClips: async () => {},
        }),
        /请选择图片模型/,
    );
});
