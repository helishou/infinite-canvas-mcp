import assert from "node:assert/strict";
import test from "node:test";
import { dialogueKey, isStoryboardMetaKey, missingDialogue, quotedLines, uniqueDialogue } from "./dialogue-check.js";

test("dialogueKey 只保留文字与数字，忽略标点、空白、大小写", () => {
    assert.equal(dialogueKey("你好，世界！"), "你好世界");
    assert.equal(dialogueKey("  Hello, World! 123 "), "helloworld123");
    assert.equal(dialogueKey("「台词」——（一）"), "台词一");
});

test("quotedLines 提取中文引号/直角引号/英文引号台词，去重并过滤元指令", () => {
    assert.deepEqual(
        quotedLines('陈九说：「这雨怕是要下一夜，明天未必停。」小红低声说『你别走，我还有话没说完。』'),
        ["这雨怕是要下一夜，明天未必停。", "你别走，我还有话没说完。"],
    );
    assert.deepEqual(quotedLines('He said "I will stay here" and 她说“我不走了”。'), ["I will stay here", "我不走了"]);
    // 重复台词只算一次
    assert.deepEqual(quotedLines('他说「你好吗？」她又说「你好吗？」'), ["你好吗？"]);
    // 「出场人物」是剧本元字段，不是台词
    assert.deepEqual(quotedLines('备注写着「出场人物」，陈九说「这雨怕是要下一夜」。'), ["这雨怕是要下一夜"]);
    // 短引号（无句读）是强调或专有名词，不算台词
    assert.deepEqual(quotedLines('所谓的“天才”其实只是用功。'), []);
    assert.equal(isStoryboardMetaKey("第3场"), true);
    assert.deepEqual(uniqueDialogue(["同一个台词。", "同一个台词。"]), ["同一个台词。"]);
});

test("逐字保留：镜头台词与原文一致时 missing 为空", () => {
    const source = quotedLines('陈九说：「这雨怕是要下一夜，明天未必停。」小红说『你别走，我还有话没说完。』');
    assert.deepEqual(source, ["这雨怕是要下一夜，明天未必停。", "你别走，我还有话没说完。"]);
    assert.deepEqual(missingDialogue(source, source), []);
});

test("长句拆镜：按顺序拼接后逐字出现，不算缺失", () => {
    const line = "我今天一定要把这件事查个水落石出";
    const shotDialogues = ["我今天一定要把", "这件事查个水落石出"];
    assert.deepEqual(missingDialogue([line], shotDialogues), []);
});

test("漏一句：missing 精确包含被删掉的那句", () => {
    const source = ["第一句台词，不能丢。", "第二句台词，也不能丢。"];
    assert.deepEqual(missingDialogue(source, ["第一句台词，不能丢。"]), ["第二句台词，也不能丢。"]);
});

test("无台词 shot：原文引号台词全部 missing", () => {
    const source = quotedLines('陈九说：「这雨怕是要下一夜，明天未必停。」小红说『你别走，我还有话没说完。』');
    assert.deepEqual(source.length, 2);
    assert.deepEqual(missingDialogue(source, []), source);
});
