import assert from "node:assert/strict";
import test from "node:test";
import { buildChapterDemandPrompt, fallbackChapterDemand, parseChapterDemand } from "./chapter-demand.js";
import { planChapterStoryboard } from "./chapter-storyboard.js";

const environments = [{ id: "env-temple", name: "破庙" }, { id: "env-street", name: "长街" }];

test("提示词带上环境清单、JSON 结构与时长上限", () => {
    const { system, user } = buildChapterDemandPrompt({ chapterTitle: "第二章 破庙", chapterBody: "雨夜。", environments });
    assert.ok(system.includes("env-temple｜破庙"));
    assert.ok(system.includes("1–5"));
    assert.ok(system.includes("【镜头 N】"));
    assert.ok(user.includes("第二章 破庙"));
    assert.ok(user.includes("雨夜。"));
});

test("解析容忍 ```json 围栏与前后闲聊", () => {
    const reply = [
        "好的，这是分镜草案：",
        "```json",
        JSON.stringify({
            demand: "【场景：破庙】【时间：夜】\n【镜头 1】\n推门。",
            scenes: [{ sceneKey: "temple", environmentId: "env-temple", beats: [{ title: "推门", visual: "推门。", seconds: 2, dialogue: "有人么？", speaker: "陈九" }] }],
        }),
        "```",
        "以上。",
    ].join("\n");
    const draft = parseChapterDemand(reply, { environments });
    assert.equal(draft.scenes.length, 1);
    assert.equal(draft.scenes[0].environmentId, "env-temple");
    assert.equal(draft.scenes[0].beats[0].dialogue, "有人么？");
    assert.ok(draft.demand.includes("【镜头 1】"));
});

test("模型瞎编 environmentId 时直接拒绝", () => {
    const reply = JSON.stringify({ demand: "【场景：X】", scenes: [{ sceneKey: "x", environmentId: "env-made-up", beats: [{ title: "一", visual: "画面" }] }] });
    assert.throws(() => parseChapterDemand(reply, { environments }), /CHAPTER_DEMAND_ENVIRONMENT/);
});

test("缺场次/缺画面/缺 demand 分别给出报错码", () => {
    assert.throws(() => parseChapterDemand(JSON.stringify({ demand: "x", scenes: [] })), /CHAPTER_DEMAND_SCENES/);
    assert.throws(() => parseChapterDemand(JSON.stringify({ scenes: [] })), /CHAPTER_DEMAND_EMPTY/);
    assert.throws(() => parseChapterDemand(JSON.stringify({ demand: "x", scenes: [{ environmentId: "env-temple", beats: [{ title: "空" }] }] }), { environments }), /CHAPTER_DEMAND_BEATS/);
    assert.throws(() => parseChapterDemand("没有 JSON"), /CHAPTER_DEMAND_JSON/);
});

test("兜底把原文按段落搬成镜头占位，且 demand 带齐标记", () => {
    const body = Array.from({ length: 5 }, (_, index) => `第${index + 1}段正文，${"雨".repeat(80)}`).join("\n\n");
    const draft = fallbackChapterDemand({ chapterTitle: "第二章", chapterBody: body, environmentId: "env-temple", sceneName: "破庙" });
    assert.ok(draft.scenes[0].beats.length >= 5);
    assert.ok(draft.demand.startsWith("【场景：破庙】"));
    assert.equal((draft.demand.match(/【镜头 \d+】/g) || []).length, draft.scenes[0].beats.length);
    const plan = planChapterStoryboard({ chapterId: "EP-1", scenes: draft.scenes });
    assert.ok(plan.shots.length >= 5);
    assert.ok(plan.segments.length >= 1);
});

test("兜底拒绝空正文与空环境", () => {
    assert.throws(() => fallbackChapterDemand({ chapterTitle: "t", chapterBody: "  ", environmentId: "env-temple" }), /CHAPTER_DEMAND_BEATS/);
    assert.throws(() => fallbackChapterDemand({ chapterTitle: "t", chapterBody: "有字", environmentId: "" }), /CHAPTER_DEMAND_ENVIRONMENT/);
});
