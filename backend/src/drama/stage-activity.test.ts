import assert from "node:assert/strict";
import test from "node:test";
import { recordStageActivity, resetStageActivity, stageActivityOf } from "./stage-activity.js";

test("写策划字段记到对应阶段，读类工具什么都不记", () => {
    resetStageActivity();
    recordStageActivity("d1", "drama_update_planning", { dramaId: "d1", outline: "全剧故事线" });
    assert.equal(stageActivityOf("d1")?.stage, "outline");
    resetStageActivity();
    recordStageActivity("d1", "drama_stage_status", { dramaId: "d1" });
    assert.equal(stageActivityOf("d1"), null);
});

test("过期动作不再提示，跨剧目互不干扰", () => {
    resetStageActivity();
    const now = Date.now();
    recordStageActivity("d1", "drama_update_episode", { dramaId: "d1", fullPlot: "场1" });
    assert.equal(stageActivityOf("d1", now + 60_000)?.label, "正在写剧本");
    assert.equal(stageActivityOf("d1", now + 10 * 60_000), null);
    assert.equal(stageActivityOf("d2"), null);
});
