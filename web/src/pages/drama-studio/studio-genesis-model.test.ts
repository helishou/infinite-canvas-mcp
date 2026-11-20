import test from "node:test";
import assert from "node:assert/strict";
import {
    formatGenesisCount,
    deriveGenesisSteps,
    deriveGenesisCopy,
    genesisStepState,
    type StudioGenesisInput,
} from "./studio-genesis-model";
import type { StudioProductionState } from "./use-studio-data";

const production = (overrides: Partial<StudioProductionState> = {}): StudioProductionState => ({
    status: "running",
    stage: "plan",
    pauseReason: "",
    planCursor: 0,
    plannedCount: 0,
    chapterCount: 0,
    doneCount: 0,
    ...overrides,
});

const input = (overrides: Partial<StudioGenesisInput> = {}): StudioGenesisInput => ({
    productionState: production(),
    paused: false,
    chapterTruth: null,
    bibleReady: false,
    episodeCount: 0,
    firstSampleReady: false,
    ...overrides,
});

test("formatCount 对齐影策：万 / 十万 / 千分位，负数不出现", () => {
    assert.equal(formatGenesisCount(0), "0");
    assert.equal(formatGenesisCount(1234), "1,234");
    assert.equal(formatGenesisCount(12_345), "1.2万");
    assert.equal(formatGenesisCount(123_456), "12万");
    assert.equal(formatGenesisCount(-1), "0");
});

test("四步文案逐字对齐影策 + 第一步字数只取章节真值", () => {
    const steps = deriveGenesisSteps(input({ chapterTruth: { count: 12, wordCount: 34567 } }));
    assert.deepEqual(steps.map((s) => s.label), [
        "读取小说 · 12 章 3.5万 字",
        "建立作品圣经：角色、道具、场景与画面规则",
        "分集改编：每集开场钩子与结尾悬念",
        "第 1 集样片：剧本、段提示词与段视频",
    ]);
    assert.deepEqual(steps.map((s) => s.key), ["read", "bible", "adapt", "sample"]);
});

test("无章节真值时不编造 0 字：退到 productionState 的章数，再退到纯「读取小说」", () => {
    const byPlan = deriveGenesisSteps(input({ productionState: production({ chapterCount: 8 }) }));
    assert.equal(byPlan[0].label, "读取小说 · 8 章");
    const none = deriveGenesisSteps(input());
    assert.equal(none[0].label, "读取小说");
});

test("圣经完成判定吃 bibleReady 真值；未完成时 active，完成后交给分集改编 active", () => {
    const before = deriveGenesisSteps(input());
    assert.equal(before[1].done, false);
    assert.equal(before[1].active, true);
    assert.equal(before[2].active, false);
    const after = deriveGenesisSteps(input({ bibleReady: true }));
    assert.equal(after[1].done, true);
    assert.equal(after[1].active, false);
    assert.equal(after[2].active, true);
});

test("分集改编 done 只认真实集数，第 1 集样片 done 只认成片真值", () => {
    const steps = deriveGenesisSteps(input({ bibleReady: true, episodeCount: 3, firstSampleReady: true }));
    assert.equal(steps[2].done, true);
    assert.equal(steps[2].active, false);
    assert.equal(steps[3].done, true);
    assert.equal(steps[3].active, false, "影策第 4 步从不 active");
});

test("暂停态：draft 文案「准备好就可以开始 / 开始制作」，非 draft「制作已暂停 / 继续制作」", () => {
    const draft = deriveGenesisCopy(input({ paused: true }));
    assert.equal(draft.paused, true);
    assert.equal(draft.icon, "pause");
    assert.equal(draft.heading, "准备好就可以开始");
    assert.match(draft.description, /点击右上角“开始制作”/);

    const paused = deriveGenesisCopy(input({
        paused: true,
        episodeCount: 2,
        productionState: production({ stage: "produce", pauseReason: "等待你放行样片，" }),
    }));
    assert.equal(paused.draft, false);
    assert.equal(paused.heading, "制作已暂停");
    assert.equal(paused.description, "等待你放行样片，点击右上角“继续制作”。");

    const running = deriveGenesisCopy(input());
    assert.equal(running.icon, "orb");
    assert.equal(running.heading, "正在把小说改编成短剧");
    assert.match(running.description, /进度会在服务端继续/);
});

test("step 渲染态：暂停时 active 降级为 idle，done 不受影响", () => {
    const steps = deriveGenesisSteps(input({ bibleReady: false }));
    assert.equal(genesisStepState(steps[0], false), "done");
    assert.equal(genesisStepState(steps[1], false), "active");
    assert.equal(genesisStepState(steps[1], true), "idle");
});
