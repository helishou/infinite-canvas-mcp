import assert from "node:assert/strict";
import test from "node:test";
import { planningPrompt } from "./planning-director-prompt";

test("提示词带上剧目身份，agent 才知道写哪一部", () => {
    const text = planningPrompt("topic", { dramaId: "d1", name: "七绝残蟒" });
    assert.match(text, /七绝残蟒/);
    assert.match(text, /dramaId=d1/);
    assert.match(text, /drama_get_planning/);
    assert.match(text, /drama_update_planning/);
});

test("剧本这一步把还没写的集号写进提示词，不让 agent 自己猜范围", () => {
    const text = planningPrompt("script", { dramaId: "d1", name: "X", pendingEpisodes: [4, 5, 10] });
    assert.match(text, /4、5、10/);
    assert.match(text, /drama_update_episode/);
});

test("没有待写集时不多嘴，也不出现空的集号列表", () => {
    const text = planningPrompt("script", { dramaId: "d1", name: "X", pendingEpisodes: [] });
    assert.doesNotMatch(text, /还没写剧本的集号/);
});

test("四步各有各的任务说明，不共用一句话", () => {
    const texts = (["source", "topic", "outline", "script"] as const).map((scope) => planningPrompt(scope, { dramaId: "d", name: "n" }));
    assert.equal(new Set(texts).size, 4);
    assert.match(texts[1], /选题/);
    assert.match(texts[2], /三幕/);
});
