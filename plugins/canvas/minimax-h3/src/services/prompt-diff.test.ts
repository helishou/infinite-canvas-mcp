import test from "node:test";
import assert from "node:assert/strict";

import { diffPromptLines } from "./prompt-diff";

test("相同文本没有差异行", () => {
    assert.deepEqual(diffPromptLines("a\nb\nc", "a\nb\nc"), []);
});

test("CRLF 与结尾换行不产生伪差异", () => {
    assert.deepEqual(diffPromptLines("a\r\nb\r\n", "a\nb"), []);
});

test("单行替换保留上下文并标出两侧内容", () => {
    assert.deepEqual(diffPromptLines("标题\n旧正文\n结尾", "标题\n新正文\n结尾"), [
        { kind: "same", text: "标题" },
        { kind: "removed", text: "旧正文" },
        { kind: "added", text: "新正文" },
        { kind: "same", text: "结尾" },
    ]);
});

test("导演新增段落按 added 标记", () => {
    assert.deepEqual(diffPromptLines("A", "A\nB"), [
        { kind: "same", text: "A" },
        { kind: "added", text: "B" },
    ]);
});

test("远离改动的相同片段折叠为 gap", () => {
    const current = ["1", "2", "3", "4", "5", "6", "7", "旧", "9"].join("\n");
    const director = ["1", "2", "3", "4", "5", "6", "7", "新", "9"].join("\n");
    assert.deepEqual(diffPromptLines(current, director, 1), [
        { kind: "gap", count: 6 },
        { kind: "same", text: "7" },
        { kind: "removed", text: "旧" },
        { kind: "added", text: "新" },
        { kind: "same", text: "9" },
    ]);
});

test("超长文本退化为整体替换而不是丢行", () => {
    const current = Array.from({ length: 600 }, (_, index) => `旧-${index}`).join("\n");
    const director = Array.from({ length: 600 }, (_, index) => `新-${index}`).join("\n");
    const lines = diffPromptLines(current, director, 0);
    assert.equal(lines.length, 1200);
    assert.equal(lines.filter((line) => line.kind === "removed").length, 600);
    assert.equal(lines.filter((line) => line.kind === "added").length, 600);
});
