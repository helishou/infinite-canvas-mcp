import assert from "node:assert/strict";
import test from "node:test";

import { unresolvedClipReferenceTokens } from "./canvas-text-reference-tags";

test("普通智能生成提示词保留 Picture 标签原文，H3 Clip 才提示缺失引用", () => {
    const prompt = "以 <Picture 1> 为剑仙，<Picture 2> 为女妖";
    assert.deepEqual(unresolvedClipReferenceTokens(prompt, new Set(), false), []);
    assert.deepEqual(unresolvedClipReferenceTokens(prompt, new Set(["<picture 1>"]), true), ["<Picture 2>"]);
});
