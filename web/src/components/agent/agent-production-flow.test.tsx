import assert from "node:assert/strict";
import test from "node:test";
import { STAGE_SUBSTEPS, productionFlowRows } from "./agent-production-flow";
import { PRODUCTION_STAGE_KEYS } from "../../pages/drama/production-progress";

test("六段制作阶段就是源稿阶段枚举，不另立一套", () => {
    assert.deepEqual([...PRODUCTION_STAGE_KEYS], ["script", "assets", "spatial", "shots", "keyframes", "clips"]);
    for (const key of PRODUCTION_STAGE_KEYS) assert.ok(STAGE_SUBSTEPS[key].length >= 4, `${key} 缺子步`);
});

test("没有阶段游标（老项目/未初始化）就不显示，不假装从第一步开始", () => {
    assert.deepEqual(productionFlowRows(null, [], true), []);
    assert.deepEqual(productionFlowRows(undefined, [], true), []);
});

test("父行按游标给状态，当前阶段展开它自己的子步", () => {
    const rows = productionFlowRows({ current: "shots", done: ["script", "assets", "spatial"] }, ["正在拆镜头", "正在定景别与运镜"], true);
    const parents = rows.filter((row) => row.depth === 0);
    assert.deepEqual(parents.map((row) => row.tone), ["done", "done", "done", "running", "pending", "pending"]);
    assert.equal(parents[3].labelKey, "drama.production.progress.stage.shots");
    const subs = rows.filter((row) => row.depth === 1);
    assert.equal(subs.length, STAGE_SUBSTEPS.shots.length);
    assert.deepEqual(subs.map((row) => row.index), STAGE_SUBSTEPS.shots.map((_, index) => `4.${index + 1}`));
    assert.equal(subs[2].tone, "running", "只提到景别、没有完成词，算进行中");
});

test("不在跑的时候只显示父行，不拿历史文案冒充子步进度", () => {
    const rows = productionFlowRows({ current: "clips", done: ["script"] }, ["编译完成"], false);
    assert.ok(rows.every((row) => row.depth === 0));
});

test("越序跳过的阶段靠 done 反映，不在界面上自行推断", () => {
    const rows = productionFlowRows({ current: "clips", done: ["script", "keyframes"], note: "跳过资产" }, [], false);
    assert.deepEqual(rows.map((row) => row.tone), ["done", "pending", "pending", "pending", "done", "running"]);
});

