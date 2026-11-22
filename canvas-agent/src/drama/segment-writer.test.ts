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
