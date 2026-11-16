import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonBlock, normalizeTopicProposal, pickDefaultTextModel } from "./topic-proposal.js";

test("能从带代码块的模型回包里抠出 JSON", () => {
    const text = "好的，结果如下：\n```json\n{\"themes\":[\"悬疑\"],\"episodes\":24}\n```\n以上。";
    assert.deepEqual(extractJsonBlock(text), { themes: ["悬疑"], episodes: 24 });
    assert.equal(extractJsonBlock("完全不是 JSON"), null);
});

test("模型给的近义词/简写会落回选项表，编出来的值不会进 schema", () => {
    const topic = normalizeTopicProposal({
        themes: ["悬疑", "仙侠悬疑", "第三个应该被丢掉"],
        tones: ["悲情", "暗黑"],
        gender: "女频",
        age: "青少年",
        ending: "OE",
        language: "中文",
        artStyle: "国风",
        episodes: 999,
        episodeMinutes: 3,
        logline: "守灯人替妹镇灯",
    });
    assert.deepEqual(topic.themes, ["悬疑"]);
    assert.deepEqual(topic.tones, ["暗黑"]);
    assert.equal(topic.gender, "女性");
    assert.equal(topic.age, "少年");
    assert.equal(topic.ending, "OE 开放结局");
    assert.equal(topic.artStyle, "国风水墨", "「国风」这种简写要吸附到第一个真实画风");
    assert.equal(topic.episodes, 200, "集数夹到 200");
    assert.equal(topic.episodeMinutes, 3);
    assert.equal(topic.logline, "守灯人替妹镇灯");
});

test("缺字段时给空值而不是乱填", () => {
    const topic = normalizeTopicProposal({});
    assert.deepEqual(topic.themes, []);
    assert.deepEqual(topic.tones, []);
    assert.equal(topic.gender, "");
    assert.equal(topic.episodes, 0);
    assert.equal(topic.episodeMinutes, 0);
});

test("默认文本模型取第一个登记为 text 的模型，而不是 channels[0]", () => {
    const config = {
        channels: [
            { id: "audio-ch", models: [{ name: "IndexTTS", capability: "audio" }] },
            { id: "text-ch", models: [{ name: "deepseek", capability: "text" }] },
        ],
    };
    assert.equal(pickDefaultTextModel(config), "text-ch::deepseek");
    assert.equal(pickDefaultTextModel({ channels: [] }), "");
});
