import assert from "node:assert/strict";
import test from "node:test";
import { buildStepInstruction, firstPendingStep, outlineStepStates, OUTLINE_WIZARD_STEPS, parseActLines, parseEpisodeLines, proposalLines, stepLocked } from "./planning-outline-steps";
import { dramaProductionPlanSchema } from "@basketikun/canvas-agent/drama/production-contract";

const emptyPlan = dramaProductionPlanSchema.parse({});

test("六步顺序固定：分集目录→角色→时空背景→故事线→三幕→结局", () => {
    assert.deepEqual([...OUTLINE_WIZARD_STEPS], ["episodes", "characters", "worldContext", "storyline", "threeActs", "ending"]);
});

test("完成状态由字段推导，空剧目停在第一步", () => {
    const states = outlineStepStates({ plan: emptyPlan, outline: "", episodeCount: 0, registryCharacters: 0 });
    assert.ok(states.every((state) => !state.done));
    assert.equal(firstPendingStep(states), "episodes");
});

test("前一步没写，后面锁着；写完依次解锁", () => {
    const stage1 = outlineStepStates({ plan: emptyPlan, outline: "", episodeCount: 3, registryCharacters: 0 });
    assert.equal(firstPendingStep(stage1), "characters");
    assert.equal(stepLocked(stage1, "worldContext"), true);
    assert.equal(stepLocked(stage1, "characters"), false);
    const stage2 = outlineStepStates({ plan: { ...emptyPlan, outlineDetail: { ...emptyPlan.outlineDetail, characters: ["沈云｜主角"] } }, outline: "", episodeCount: 3, registryCharacters: 0 });
    assert.equal(firstPendingStep(stage2), "worldContext");
});

test("共享制作里已有角色登记时，角色这步算完成", () => {
    const states = outlineStepStates({ plan: emptyPlan, outline: "", episodeCount: 1, registryCharacters: 4 });
    assert.equal(states.find((state) => state.key === "characters")?.done, true);
});

test("三幕要三段都写了才算完成", () => {
    const base = { worldContext: "民国", ending: "自首" };
    const two = outlineStepStates({ plan: { ...emptyPlan, outlineDetail: { ...emptyPlan.outlineDetail, ...base, threeActs: ["一", "二", ""] } }, outline: "线", episodeCount: 1, registryCharacters: 1 });
    assert.equal(two.find((state) => state.key === "threeActs")?.done, false);
    const three = outlineStepStates({ plan: { ...emptyPlan, outlineDetail: { ...emptyPlan.outlineDetail, ...base, threeActs: ["一", "二", "三"] } }, outline: "线", episodeCount: 1, registryCharacters: 1 });
    assert.equal(three.find((state) => state.key === "threeActs")?.done, true);
    assert.equal(firstPendingStep(three), null, "六步都写完就没有当前步");
    const noEnding = outlineStepStates({ plan: { ...emptyPlan, outlineDetail: { ...emptyPlan.outlineDetail, worldContext: "民国", threeActs: ["一", "二", "三"] } }, outline: "线", episodeCount: 1, registryCharacters: 1 });
    assert.equal(firstPendingStep(noEnding), "ending");
});

test("分集行能拆成集数、标题与简介", () => {
    assert.deepEqual(parseEpisodeLines("第1集｜雪夜客栈｜沈云入府\n第2集｜旧案卷宗｜线索指向陆沉"), [
        { episodeNumber: 1, title: "雪夜客栈", synopsis: "沈云入府" },
        { episodeNumber: 2, title: "旧案卷宗", synopsis: "线索指向陆沉" },
    ]);
    assert.deepEqual(parseEpisodeLines("第一集｜开场｜"), [{ episodeNumber: 1, title: "开场", synopsis: "" }]);
    assert.deepEqual(parseEpisodeLines("开场，沈云入府"), [{ episodeNumber: 1, title: "开场，沈云入府", synopsis: "" }]);
});

test("三幕行去掉前缀，多的行丢掉", () => {
    assert.deepEqual(parseActLines("第一幕｜建置\n第二幕｜对抗\n第三幕｜决断\n第四行不要"), ["建置", "对抗", "决断"]);
    assert.deepEqual(parseActLines("建置\n对抗"), ["建置", "对抗"]);
});

test("角色按行拆，空行与列表符号丢掉", () => {
    assert.deepEqual(proposalLines("- 沈云｜主角\n\n  · 陆沉｜对手 "), ["沈云｜主角", "陆沉｜对手"]);
});

test("生成口径写进补充要求，空补充不留下多余分号", () => {
    assert.equal(buildStepInstruction("fill", "standard", ""), "只在现有内容上补全缺失部分，保留已有的事实与措辞；按标准详略写");
    assert.equal(buildStepInstruction("rewrite", "brief", " 镜头别太长 "), "按原剧本重写这一步，可以覆盖现有内容；偏精简，宁可短也不凑字；镜头别太长");
});
