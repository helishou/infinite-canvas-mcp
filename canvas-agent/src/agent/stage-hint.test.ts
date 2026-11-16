import assert from "node:assert/strict";
import test from "node:test";
import { withDramaStageContext } from "./stage-hint.js";

test("有阶段块时拼在用户请求前面，模型先看到阶段", () => {
    const out = withDramaStageContext("帮我写第 3 集", "## 当前剧目阶段\n下一步：写第 3 集剧本");
    assert.match(out, /^## 当前剧目阶段/);
    assert.match(out, /用户请求：帮我写第 3 集$/);
});

test("没有阶段块时不加噪声，提示词保持原样", () => {
    assert.equal(withDramaStageContext("帮我写第 3 集", ""), "帮我写第 3 集");
    assert.equal(withDramaStageContext("原样", "   "), "原样");
});
