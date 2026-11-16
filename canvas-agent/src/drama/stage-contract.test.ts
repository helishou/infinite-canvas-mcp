import assert from "node:assert/strict";
import test from "node:test";
import {
    dramaCurrentStage,
    dramaNextAction,
    dramaStageStates,
    DRAMA_STAGE_SKILLS,
    stageForToolCall,
    renderDramaStageContext,
    type DramaStageInput,
} from "./stage-contract.js";

const episode = (episodeNumber: number, patch: Partial<DramaStageInput["episodes"][number]> = {}) => ({
    episodeNumber,
    fullPlot: "",
    synopsis: "",
    stage: null,
    ...patch,
});

const base = (patch: Partial<DramaStageInput> = {}): DramaStageInput => ({
    topic: { themes: [], logline: "", episodes: 0 },
    outline: "",
    outlineDetail: {},
    episodes: [],
    assetCount: 0,
    ...patch,
});

const full = (): DramaStageInput => base({
    topic: { themes: ["悬疑"], logline: "一句话故事", episodes: 3, artStyle: "古风写实" },
    outline: "全剧故事线",
    outlineDetail: { worldContext: "古代县城", threeActs: ["一", "二", "三"], ending: "HE", characters: ["林晚"] },
    episodes: [
        episode(1, { fullPlot: "场1｜…", stage: { current: "clips", done: ["script", "assets", "spatial", "shots", "keyframes"] } }),
        episode(2, { fullPlot: "场1｜…", stage: { current: "clips", done: ["script", "assets", "spatial", "shots", "keyframes"] } }),
        episode(3, { fullPlot: "场1｜…", stage: { current: "clips", done: ["script", "assets", "spatial", "shots", "keyframes"] } }),
    ],
    assetCount: 4,
});

test("空剧目停在选题，并且缺口点名具体字段", () => {
    const states = dramaStageStates(base());
    const next = dramaNextAction(states);
    assert.equal(next.stage, "topic");
    assert.ok(next.gaps.includes("还没有选题题材"));
    assert.equal(dramaCurrentStage(states), "topic");
});

test("选题齐了大纲没齐 → 当前大纲，缺口是缺的那几段", () => {
    const states = dramaStageStates(base({ topic: { themes: ["悬疑"], logline: "一句话", episodes: 3 }, outline: "故事线" }));
    const next = dramaNextAction(states);
    assert.equal(next.stage, "outline");
    assert.deepEqual(next.gaps, ["缺时空背景", "三幕与节奏不满三幕", "缺结局和卡点"]);
});

test("剧本阶段按集算进度，未写的集逐条报集号", () => {
    const states = dramaStageStates(base({
        topic: { themes: ["悬疑"], logline: "一句话", episodes: 3 },
        outline: "故事线",
        outlineDetail: { worldContext: "县城", threeActs: ["一", "二", "三"], ending: "HE" },
        episodes: [episode(1, { fullPlot: "场1" }), episode(2), episode(3)],
    }));
    const script = states.find(state => state.key === "script")!;
    assert.equal(script.done, false);
    assert.equal(script.doneCount, 1);
    assert.equal(script.total, 3);
    assert.deepEqual(script.gaps, ["第 2 集还没写剧本大纲", "第 3 集还没写剧本大纲"]);
});

test("资产/分镜/视频只看分集既有游标，没游标就算没做", () => {
    const states = dramaStageStates(base({
        topic: { themes: ["悬疑"], logline: "一句话", episodes: 2 },
        outline: "故事线",
        outlineDetail: { worldContext: "县城", threeActs: ["一", "二", "三"], ending: "HE" },
        episodes: [episode(1, { fullPlot: "场1", stage: { current: "shots", done: ["script", "assets"] } }), episode(2, { fullPlot: "场1" })],
        assetCount: 2,
    }));
    assert.equal(states.find(state => state.key === "assets")!.doneCount, 1);
    assert.equal(states.find(state => state.key === "shots")!.done, false);
    assert.deepEqual(states.find(state => state.key === "video")!.gaps, ["第 1 集还没有成片段落", "第 2 集还没有成片段落"]);
});

test("六段都完成时不再给假阶段，直接指向制作台", () => {
    const states = dramaStageStates(full());
    assert.equal(dramaCurrentStage(states), null);
    const next = dramaNextAction(states);
    assert.equal(next.stage, null);
    assert.match(next.line, /制作台/);
});

test("阶段块写清六段状态、缺口和固定两行", () => {
    const states = dramaStageStates(full());
    const block = renderDramaStageContext({ dramaName: "雪夜当铺", dramaId: "d1", states });
    assert.match(block, /雪夜当铺（dramaId=d1）/);
    assert.match(block, /1\. topic — 完成/);
    assert.match(block, /回复末尾固定两行/);
});

test("每段都绑定了真实存在的技能路径", () => {
    for (const [key, meta] of Object.entries(DRAMA_STAGE_SKILLS)) {
        assert.match(meta.path, /^\.agents\/skills\//, key);
        assert.ok(meta.skill.length > 0);
    }
});

test("从工具调用反推阶段：策划写回、剧本、资产、分镜、出片各有落点", () => {
    assert.equal(stageForToolCall("drama_update_planning", { topic: {} })?.stage, "topic");
    assert.equal(stageForToolCall("drama_update_planning", { outline: "x" })?.stage, "outline");
    assert.equal(stageForToolCall("drama_update_planning", { outlineDetail: {} })?.stage, "outline");
    assert.equal(stageForToolCall("drama_update_episode", { fullPlot: "场1" })?.stage, "script");
    assert.equal(stageForToolCall("production_create_asset", {})?.stage, "assets");
    assert.equal(stageForToolCall("production_edit_shot", {})?.stage, "shots");
    assert.equal(stageForToolCall("canvas_generate_video", {})?.stage, "video");
});

test("读类工具不算在干活", () => {
    for (const tool of ["drama_stage_status", "drama_get_planning", "drama_get_episode", "production_get"]) {
        assert.equal(stageForToolCall(tool, {}), null, tool);
    }
});
