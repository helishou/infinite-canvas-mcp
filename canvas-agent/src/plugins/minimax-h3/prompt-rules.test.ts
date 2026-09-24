import assert from "node:assert/strict";
import test from "node:test";
import { formatShotTimestamp, promptDetails, stripDuplicateTransition, validateDefinitionCoverage, validatePromptReferences, validateShotTimeline, visualReferenceTags } from "./prompt-rules.js";

test("清理仅作用于生成资料，保留描述与视觉标签", () => {
    assert.deepEqual(visualReferenceTags(["character-group", "character_turnaround", "blue coat", "blue coat"]), ["blue coat"]);
    assert.deepEqual(promptDetails(["年轻女性，黑色长发。; character-group, character_turnaround;", "冰蓝灰斗篷。", "冰蓝灰斗篷."]), ["年轻女性，黑色长发", "冰蓝灰斗篷"]);
    assert.deepEqual(promptDetails(["Cold daylight; eyes open", "A character_turnaround chart hangs on the wall."]), ["Cold daylight", "eyes open", "A character_turnaround chart hangs on the wall"]);
});

test("统一时间格式，拒绝非法秒位、倒序及超出片长的切镜", () => {
    assert.equal(formatShotTimestamp("0:05.2"), "00:05.200");
    assert.equal(formatShotTimestamp("5s"), "00:05.000");
    assert.equal(formatShotTimestamp("00:65"), "");
    assert.doesNotThrow(() => validateShotTimeline([{}, { switchTime: "" }], 10));
    assert.throws(() => validateShotTimeline([{}, { switchTime: "", preciseCut: true }], 10), /精准切镜/u);
    for (const time of ["bad", "0", "10", "11"]) {
        assert.throws(() => validateShotTimeline([{}, { switchTime: time }], 10));
    }
    assert.doesNotThrow(() => validateShotTimeline([{}, {}, { switchTime: "5" }], 10));
    assert.throws(() => validateShotTimeline([{}, { switchTime: "5" }, { switchTime: "4" }], 10));
    assert.throws(() => validateShotTimeline([{}, { switchTime: "5" }, { switchTime: "5" }], 10));
    assert.doesNotThrow(() => validateShotTimeline([{}, { switchTime: "5" }], 10));
});

test("删除重复切镜前缀时保留目标画面、正文和原台词", () => {
    const description = 'The shot hard-cuts. The shot hard-cuts to the hand close-up. He says: <d>[Chinese] 别动。</d>';
    assert.equal(stripDuplicateTransition(description, "cut"), 'the hand close-up. He says: <d>[Chinese] 别动。</d>');
    const other = 'The shot cross-dissolves to snow. <d>[English] The shot hard-cuts.</d>';
    assert.equal(stripDuplicateTransition(other, "cut"), other);
    assert.equal(stripDuplicateTransition('The shot continues moving toward the door.', "continuous"), 'The shot continues moving toward the door.');
});

test("校验实际引用而不误报台词中的字面标签", () => {
    const refs = [{ type: "image", bindingId: "picture" }, { type: "audio", bindingId: "voice" }];
    assert.doesNotThrow(() => validatePromptReferences('<Subject 1> <Picture 1> <Audio 1> {{ref:voice}} <d>[English] <Picture 9></d>', refs, 1));
    for (const text of ["<Subject 2>", "<Picture 0>", "<Picture 2>", "<Video 1>", "{{ref:missing}}", "<Audio 2>"]) {
        assert.throws(() => validatePromptReferences(text, refs, 1));
    }
});

test("身份来源图无需重复定义，独立引用必须有对应 retention", () => {
    const subjects = [{ pictures: ["<Picture 2>"] }];
    const refs = [{ tag: "<Picture 1>" }, { tag: "<Picture 2>" }];
    const definitions = '<Subject 1> is the woman in <Picture 2>.\n<Picture 1> is a storyboard.';
    const retention = '<Subject 1>: fully_preserved\n<Picture 1>: fully_preserved';
    assert.doesNotThrow(() => validateDefinitionCoverage(subjects, refs, definitions, retention));
    assert.throws(() => validateDefinitionCoverage(subjects, refs, definitions, '<Subject 1>: fully_preserved'));
    assert.throws(() => validateDefinitionCoverage([], refs, definitions, retention));
});
