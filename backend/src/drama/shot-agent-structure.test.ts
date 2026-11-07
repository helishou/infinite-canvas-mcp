import assert from "node:assert/strict";
import test from "node:test";
import { combatIssues, performanceIssues, shotStructureIssues } from "./shot-agent-structure.js";

const combat = {
    force_source: "左脚蹬地", trajectory: "向前短弧", contact: "刃压盾沿", resistance: "盾面向下导走",
    impact_hold: "接触帧停两帧", transfer: "盾退入肩阻尼", recoil: "肘回折",
};
const performance = {
    tracks: {
        gaze: { cue: "视线从钥匙移到空掌" }, breath: { cue: "吸到一半停住" }, shoulder: { cue: "左肩下沉" },
        body_hands: { cue: "拇指松开钥匙环" }, dialogue: { cue: "低声承认上次的拒绝" },
    },
};

test("武戏七层齐备通过", () => {
    assert.deepEqual(combatIssues({}, { combat }), []);
});

test("武戏缺层被拒并列出缺项", () => {
    const { recoil: _drop, ...partial } = combat;
    const issues = combatIssues({}, { combat: partial });
    assert.equal(issues[0].code, "SHOT_COMBAT_STRUCTURE");
    assert.match(issues[0].message, /recoil/);
});

test("文戏五轨齐备通过", () => {
    assert.deepEqual(performanceIssues({}, { performance }), []);
});

test("文戏缺轨被拒并列出缺项", () => {
    const partial = { tracks: { ...performance.tracks, dialogue: { cue: "" } } };
    const issues = performanceIssues({}, { performance: partial });
    assert.equal(issues[0].code, "SHOT_PERFORMANCE_STRUCTURE");
    assert.match(issues[0].message, /dialogue/);
});

test("features.combat 判定走七层，已存载荷可与补丁合并", () => {
    assert.deepEqual(shotStructureIssues({ features: { combat: true }, combat }, {}), []);
    assert.equal(shotStructureIssues({ features: { combat: true } }, {}).length, 1);
});

test("同一镜混写两侧结构被拒", () => {
    const issues = shotStructureIssues({ features: { combat: true } }, { combat, performance });
    assert.ok(issues.some(issue => issue.code === "SHOT_STRUCTURE_MIXED"));
});
