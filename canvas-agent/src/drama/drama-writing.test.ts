import assert from "node:assert/strict";
import test from "node:test";
import { dramaProductionPlanSchema } from "./production-contract.js";

test("老剧目没有写作字段时按空值补全，既有设置原样保留", () => {
    const plan = dramaProductionPlanSchema.parse({ imageModel: "general", h3Model: "video", requirements: "要求" });
    assert.equal(plan.sourceScript, "");
    assert.deepEqual(plan.topic.themes, []);
    assert.deepEqual(plan.topic.tones, []);
    assert.equal(plan.topic.gender, "");
    assert.equal(plan.topic.episodes, 0);
    assert.equal(plan.topic.artStyle, "");
    assert.equal(plan.topic.theme, "", "老字段保留，读旧数据不丢");
    assert.deepEqual(plan.outlineDetail, { worldContext: "", threeActs: [], ending: "", characters: [] });
    assert.equal(plan.outlineModel, "");
    assert.equal(plan.imageModel, "general");
    assert.equal(plan.h3Model, "video");
    assert.equal(plan.requirements, "要求");
});

test("原剧本、选题、大纲三段能存能回读，缺项各自补空", () => {
    const saved = dramaProductionPlanSchema.parse({
        sourceScript: "第一场 夜 内 客栈",
        topic: { theme: "悬疑", sellingPoint: "三分钟一个反转" },
        outlineDetail: { worldContext: "民国十二年", threeActs: ["起", "承", "转"], ending: "女主自首，卡点停在警察进门", characters: ["沈云｜主角", "陆沉｜对手"] },
    });
    assert.equal(saved.outlineModel, "");
    assert.deepEqual(saved.outlineDetail.characters, ["沈云｜主角", "陆沉｜对手"]);
    assert.equal(saved.topic.theme, "悬疑");
    assert.equal(saved.topic.audience, "");
    assert.equal(saved.topic.differentiation, "");
    assert.deepEqual(saved.outlineDetail.threeActs, ["起", "承", "转"]);
    const reloaded = dramaProductionPlanSchema.parse(JSON.parse(JSON.stringify(saved)));
    assert.equal(reloaded.sourceScript, "第一场 夜 内 客栈");
    assert.equal(reloaded.outlineDetail.ending, "女主自首，卡点停在警察进门");
});

test("写作字段不接受未登记的子字段，避免悄悄多出一套结构", () => {
    assert.equal(dramaProductionPlanSchema.safeParse({ topic: { unexpected: "x" } }).success, false);
    assert.equal(dramaProductionPlanSchema.safeParse({ outlineDetail: { unexpected: "x" } }).success, false);
});
