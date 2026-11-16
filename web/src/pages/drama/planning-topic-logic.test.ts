import assert from "node:assert/strict";
import test from "node:test";
import { dramaProductionPlanSchema } from "@basketikun/canvas-agent/drama/production-contract";
import { PLANNING_STEPS, nextPlanningStep, planningStepStates, topicFromLegacy, toggleThemes, toggleValue } from "./planning-topic-logic";

const emptyPlan = dramaProductionPlanSchema.parse({});

test("题材最多两个，再点第三个顶掉最早的，重复点取消", () => {
    assert.deepEqual(toggleThemes([], "甜宠"), ["甜宠"]);
    assert.deepEqual(toggleThemes(["甜宠", "复仇"], "穿越"), ["复仇", "穿越"]);
    assert.deepEqual(toggleThemes(["甜宠", "复仇"], "甜宠"), ["复仇"]);
});

test("多选字段是开关语义", () => {
    assert.deepEqual(toggleValue(["甜", "虐"], "爽"), ["甜", "虐", "爽"]);
    assert.deepEqual(toggleValue(["甜", "虐"], "甜"), ["虐"]);
});

test("老数据里的题材文字会变成第一个选项，不丢内容", () => {
    const legacy = { ...emptyPlan.topic, theme: "古装言情", audience: "女性" };
    const next = topicFromLegacy(legacy);
    assert.deepEqual(next.themes, ["古装言情"]);
    assert.equal(next.gender, "女性");
});

test("步骤都是六步且顺序固定", () => {
    assert.deepEqual(PLANNING_STEPS, ["topic", "outline", "script", "assets", "shots", "package"]);
});

test("空剧目的下一步是选题，分镜与导演包永远不算完成", () => {
    const states = planningStepStates({ topic: emptyPlan.topic, outline: "", worldContext: "", episodeCount: 0, episodesWithScript: 0, assetCount: 0 });
    assert.equal(nextPlanningStep(states), "topic");
    assert.equal(states.find((state) => state.key === "shots")?.done, false);
    assert.equal(states.find((state) => state.key === "package")?.done, false);
});

test("选题只看题材；大纲要故事线加时空背景；剧本要每集都有简介", () => {
    const topic = { ...emptyPlan.topic, themes: ["悬疑"] };
    let states = planningStepStates({ topic, outline: "故事线", worldContext: "", episodeCount: 2, episodesWithScript: 0, assetCount: 0 });
    assert.equal(states.find((state) => state.key === "topic")?.done, true);
    assert.equal(states.find((state) => state.key === "outline")?.done, false, "缺时空背景不算写完大纲");
    assert.equal(states.find((state) => state.key === "script")?.done, false, "还有集没写剧本大纲，剧本这步不算完成");
    assert.equal(nextPlanningStep(states), "outline");

    states = planningStepStates({ topic, outline: "故事线", worldContext: "民国", episodeCount: 2, episodesWithScript: 2, assetCount: 3 });
    // 分镜不会因为「分集已有画布」变绿：它只在分集制作里有真实镜头，剧目级只当入口。
    assert.deepEqual(states.map((state) => state.done), [true, true, true, true, false, false]);
    assert.equal(nextPlanningStep(states), "shots", "剧本写完后下一步是去分集做分镜");
});

test("分镜和导演包指向分集制作，其余留在剧目页签", () => {
    const states = planningStepStates({ topic: emptyPlan.topic, outline: "", worldContext: "", episodeCount: 0, episodesWithScript: 0, assetCount: 0 });
    const target = Object.fromEntries(states.map((state) => [state.key, state.target]));
    assert.deepEqual(target, { topic: "tab", outline: "tab", script: "tab", assets: "tab", shots: "episode", package: "episode" });
});
