/**
 * 一镜多句台词保真单测：buildSegmentDraft / buildSegmentWriterPrompt
 * 必须把同一镜头的 2–3 句台词逐句写进素材稿，而不是只取第一句。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildSegmentDraft, buildSegmentWriterPrompt, type SegmentWriterShot } from "./segment-writer.js";

const shot = (overrides: Partial<SegmentWriterShot> = {}): SegmentWriterShot => ({
    startSec: 0,
    endSec: 3,
    visual: "雪夜街道，主角撑伞远去",
    camera: "缓慢推镜",
    ...overrides,
});

const draftOf = (shots: SegmentWriterShot[]) => buildSegmentDraft(shots);
const linesOf = (draft: string) => draft.split("\n").filter(line => line.startsWith("台词："));

test("buildSegmentDraft：一镜三句台词逐句一行，全部保留且顺序不变", () => {
    const draft = draftOf([shot({
        dialogues: [
            { text: "第一句台词", speaker: "甲" },
            { text: "第二句台词", speaker: "乙" },
            { text: "第三句台词", speaker: "甲" },
        ],
    })]);
    assert.deepEqual(linesOf(draft), [
        "台词：甲：“第一句台词”",
        "台词：乙：“第二句台词”",
        "台词：甲：“第三句台词”",
    ]);
    assert.ok(!draft.includes("绝对无台词"), "有多句台词时不写「绝对无台词」");
});

test("buildSegmentDraft：一镜两句台词同样全进，单条 dialogue 兼容路径输出不变", () => {
    const multi = draftOf([shot({
        dialogues: [{ text: "你回来了。", speaker: "妻" }, { text: "我回来了。", speaker: "夫" }],
    })]);
    assert.deepEqual(linesOf(multi), ["台词：妻：“你回来了。”", "台词：夫：“我回来了。”"]);

    const single = draftOf([shot({ dialogue: "我等你", speaker: "甲" })]);
    assert.deepEqual(linesOf(single), ["台词：甲：“我等你”"], "旧单条路径逐字输出保持原样");
});

test("buildSegmentDraft：无台词才写「绝对无台词」；dialogues 优先且忽略空文本", () => {
    assert.deepEqual(linesOf(draftOf([shot()])), ["台词：绝对无台词"]);
    const mixed = draftOf([shot({
        dialogue: "旧单条",
        speaker: "旧人",
        dialogues: [
            { text: "逐字第一句", speaker: "甲" },
            { text: "   ", speaker: "乙" },
            { text: "逐字第三句" },
        ],
    })]);
    assert.deepEqual(linesOf(mixed), ["台词：甲：“逐字第一句”", "台词：“逐字第三句”"]);
    assert.ok(!mixed.includes("旧单条"), "存在有效 dialogues 时不回退到单条字段，避免重复输出");
});

test("buildSegmentDraft：多镜各镜台词独立成行，不串台、不截尾", () => {
    const draft = draftOf([
        shot({ startSec: 0, endSec: 2, dialogues: [{ text: "镜一一", speaker: "甲" }, { text: "镜一二", speaker: "乙" }] }),
        shot({ startSec: 2, endSec: 4, dialogues: [{ text: "镜二一", speaker: "丙" }, { text: "镜二二", speaker: "丁" }, { text: "镜二三", speaker: "丙" }] }),
    ]);
    assert.deepEqual(linesOf(draft), [
        "台词：甲：“镜一一”",
        "台词：乙：“镜一二”",
        "台词：丙：“镜二一”",
        "台词：丁：“镜二二”",
        "台词：丙：“镜二三”",
    ]);
    assert.equal(draft.match(/0\.0–2\.0秒/g)?.length, 1);
    assert.equal(draft.match(/2\.0–4\.0秒/g)?.length, 1);
});

test("buildSegmentWriterPrompt：writer 提示词的【本段素材稿】含全部台词行", () => {
    const { system, user } = buildSegmentWriterPrompt({
        index: 0,
        count: 1,
        title: "第一段",
        totalSec: 3,
        shots: [shot({
            dialogues: [
                { text: "第一句台词", speaker: "甲" },
                { text: "第二句台词", speaker: "乙" },
                { text: "第三句台词", speaker: "甲" },
            ],
        })],
    });
    assert.match(system, /分镜导演兼表演指导/);
    const draftSection = user.slice(user.indexOf("【本段素材稿】"));
    assert.deepEqual(linesOf(draftSection), [
        "台词：甲：“第一句台词”",
        "台词：乙：“第二句台词”",
        "台词：甲：“第三句台词”",
    ], "多句台词全部进入 writer 提示词，一句都不能丢");
});

// ==== 分镜可拍性字段必须进素材稿，否则等于白生成 ====
test("素材稿带出 action / imagePrompt / videoPrompt / sourceQuote", () => {
    const draft = buildSegmentDraft([{
        startSec: 0, endSec: 5,
        visual: "崇良拨开人群走到告示墙前",
        camera: "推",
        action: "揭下告示转身",
        imagePrompt: "崇良正面偏左站位，右手捏住黄纸下缘，正午顶光",
        videoPrompt: "0-2 秒拨开人群，2-5 秒揭榜",
        sourceQuote: "崇良一把揭下悬赏告示",
    }]);
    assert.ok(draft.includes("动作：揭下告示转身"), "动作必须进素材稿");
    assert.ok(draft.includes("起幅：崇良正面偏左站位"), "起幅画面必须进素材稿");
    assert.ok(draft.includes("镜内运动：0-2 秒拨开人群"), "镜内运动必须进素材稿");
    assert.ok(draft.includes("原文依据：崇良一把揭下悬赏告示"), "原文依据必须进素材稿");
});

test("缺少可拍字段时不输出空标签，只留画面与运镜", () => {
    const draft = buildSegmentDraft([{ startSec: 0, endSec: 4, visual: "崇良揭榜", camera: "固定" }]);
    assert.ok(draft.includes("运镜：固定"));
    assert.ok(draft.includes("画面：崇良揭榜"));
    assert.ok(!draft.includes("动作："));
    assert.ok(!draft.includes("起幅："));
    assert.ok(!draft.includes("镜内运动："));
    assert.ok(!draft.includes("原文依据："));
});

test("可拍字段与台词共存：台词逐字保留，不被新字段挤掉", () => {
    const draft = buildSegmentDraft([{
        startSec: 0, endSec: 6,
        visual: "崇良站在告示墙前",
        imagePrompt: "正午顶光，人群虚化",
        dialogues: [{ text: "我揭了这榜", speaker: "崇良" }, { text: "你当真要去？", speaker: "路人" }],
    }]);
    assert.ok(draft.includes("起幅：正午顶光"));
    assert.ok(draft.includes("台词：崇良：“我揭了这榜”"));
    assert.ok(draft.includes("台词：路人：“你当真要去？”"));
});
