import assert from "node:assert/strict";
import test from "node:test";
import "@/i18n";
import { LOCAL_PROMPT_SOFT_LIMIT_CHARS, promptCharStats } from "./studio-detail-panel.js";

test("promptCharStats 按 Unicode 码点计数（对齐影策 Array.from / 后端 RuneCount）", () => {
    assert.deepEqual(promptCharStats(""), { sentChars: 0, overSoftLimit: false });
    assert.deepEqual(promptCharStats("你好，世界"), { sentChars: 5, overSoftLimit: false });
    // emoji / 增补平面按 1 个码点计，而不是 JS UTF-16 的 2 个 code unit。
    assert.equal(promptCharStats("🎬").sentChars, 1);
    assert.equal(promptCharStats("a🎬b").sentChars, 3);
    // <Picture N> 引用 token 是提交正文的一部分，照常计入（镜头 2 + "<Picture 1>" 11）。
    assert.equal(promptCharStats("镜头<Picture 1>").sentChars, 13);
});

test("promptCharStats 只在超过软上限时为 true，且软上限明确非模型能力", () => {
    assert.equal(LOCAL_PROMPT_SOFT_LIMIT_CHARS, 40_000);
    assert.deepEqual(promptCharStats("甲".repeat(LOCAL_PROMPT_SOFT_LIMIT_CHARS)), {
        sentChars: LOCAL_PROMPT_SOFT_LIMIT_CHARS,
        overSoftLimit: false,
    });
    assert.deepEqual(promptCharStats("甲".repeat(LOCAL_PROMPT_SOFT_LIMIT_CHARS + 1)), {
        sentChars: LOCAL_PROMPT_SOFT_LIMIT_CHARS + 1,
        overSoftLimit: true,
    });
    // 自定义上限便于验证边界，不改变默认软上限的「非模型能力」语义。
    assert.deepEqual(promptCharStats("abcd", 3), { sentChars: 4, overSoftLimit: true });
});
