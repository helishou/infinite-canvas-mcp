import assert from "node:assert/strict";
import test from "node:test";

import { composeDemandText, parseDemandText } from "./demand-beats.js";

const SAMPLE = [
    "【场景：山神庙】【时间：夜】",
    "【镜头 1】",
    "暴雨砸在破庙屋顶，瓦片被掀开一角。少年抱着一卷湿透的账册缩在神像后。",
    "【镜头 2】",
    "庙门被推开，脚步声压着水渍靠近。",
    "刀客：「把册子留下，人可以走。」",
    "【镜头 3】",
    "少年手指扣进泥里。",
    "少年：「除非踩着我的尸体。」",
].join("\n");

test("解析场景、时间与三个镜头", () => {
    const result = parseDemandText(SAMPLE);
    assert.equal(result.sceneName, "山神庙");
    assert.equal(result.timeOfDay, "夜");
    assert.equal(result.beats.length, 3);
    assert.ok(result.beats[0].visual.includes("暴雨砸在破庙屋顶"));
    assert.ok(!result.beats[0].visual.includes("【镜头"));
});

test("台词与说话人从「名字：「台词」」里取出，且不留在画面描述里", () => {
    const result = parseDemandText(SAMPLE);
    assert.equal(result.beats[1].speaker, "刀客");
    assert.equal(result.beats[1].dialogue, "把册子留下，人可以走。");
    assert.equal(result.beats[1].visual, "庙门被推开，脚步声压着水渍靠近。");
    assert.ok(!result.beats[1].visual.includes("把册子留下"), "台词不得复述进 visual");
});

test("没写说话人的台词被丢弃并给诊断，不塞回画面描述", () => {
    const demand = ["【场景：街市】【时间：日】", "【镜头 1】", "人群散开。", "「他来了。」"].join("\n");
    const result = parseDemandText(demand);
    assert.equal(result.beats[0].dialogue, undefined);
    assert.ok(!result.beats[0].visual.includes("他来了"));
    assert.ok(result.diagnostics.some(text => text.includes("没写说话人")));
});

test("没有【镜头】标记时按段落分镜并提示", () => {
    const demand = ["【场景：渡口】【时间：晨】", "雾里有人撑船。", "船头挂着一盏灭了的灯。"].join("\n");
    const result = parseDemandText(demand);
    assert.equal(result.beats.length, 2);
    assert.ok(result.diagnostics.some(text => text.includes("按段落")));
    assert.equal(result.sceneName, "渡口");
});

test("超长镜头压到上限并提示拆分", () => {
    const long = "字".repeat(200);
    const result = parseDemandText(`【场景：殿】【时间：夜】\n【镜头 1】\n${long}`, { maxShotSeconds: 6 });
    assert.equal(result.beats[0].seconds, 6);
    assert.ok(result.diagnostics.some(text => text.includes("超过单镜上限")));
});

test("时长按字数估算并量化到 0.5 秒", () => {
    const result = parseDemandText(`【场景：殿】【时间：夜】\n【镜头 1】\n${"字".repeat(40)}`);
    assert.equal(result.beats[0].seconds, 5.5);
});

test("只有台词没有画面时补中性描述，不留空镜", () => {
    const demand = ["【场景：牢房】【时间：夜】", "【镜头 1】", "囚徒：「放我出去。」"].join("\n");
    const result = parseDemandText(demand);
    assert.equal(result.beats[0].visual, "人物近景，开口说话。");
    assert.equal(result.beats[0].speaker, "囚徒");
});

test("空正文抛错", () => {
    assert.throws(() => parseDemandText("   "), /DEMAND_BEATS_EMPTY/);
});

test("composeDemandText 与 parseDemandText 往返一致", () => {
    const first = parseDemandText(SAMPLE);
    const roundTrip = composeDemandText({ sceneName: first.sceneName, timeOfDay: first.timeOfDay, beats: first.beats });
    const second = parseDemandText(roundTrip);
    assert.equal(second.sceneName, first.sceneName);
    assert.equal(second.beats.length, first.beats.length);
    assert.deepEqual(second.beats.map(beat => beat.dialogue), first.beats.map(beat => beat.dialogue));
    assert.deepEqual(second.beats.map(beat => beat.speaker), first.beats.map(beat => beat.speaker));
});
