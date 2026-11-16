import assert from "node:assert/strict";
import test from "node:test";
import { dramaProductionPlanSchema } from "@basketikun/canvas-agent/drama/production-contract";
import { NEW_DRAMA_STEPS, newDramaStepValid } from "./new-drama-wizard";

const plan = dramaProductionPlanSchema.parse({});
const base = { name: "", plan, styleMode: "none" as const, stylePrompt: "" };

test("第 1 步只认剧名", () => {
    assert.equal(newDramaStepValid(0, base), false);
    assert.equal(newDramaStepValid(0, { ...base, name: "雪夜当铺" }), true);
});

test("第 2 步：不用参考图就一定能过", () => {
    assert.equal(newDramaStepValid(1, { ...base, name: "x" }), true);
    // 选了上传却没文件 / 选了文生却没提示词，都不能过
    assert.equal(newDramaStepValid(1, { ...base, styleMode: "upload" }), false);
    assert.equal(newDramaStepValid(1, { ...base, styleMode: "prompt" }), false);
    assert.equal(newDramaStepValid(1, { ...base, styleMode: "prompt", stylePrompt: "国风水墨" }), true);
});

test("第 3 步永远可提交（模型可以留空走默认）", () => {
    assert.equal(newDramaStepValid(2, base), true);
    assert.equal(NEW_DRAMA_STEPS.length, 3);
});
