/**
 * C5 超长提示词精简重试单测：精简循环收敛/耗尽/无上限直通/不截断（对齐影策 condenseSegmentPrompt）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// 双 runner：vitest 验收与项目 node:test runner 共用同一份用例。
type TestFn = (name: string, fn: () => void | Promise<void>) => void;
let test: TestFn;
if ((process.env as Record<string, string | undefined>).VITEST) {
    // @ts-ignore vitest 由 npx 临时提供
    test = (await import("vitest")).test as unknown as TestFn;
} else {
    test = (await import("node:test")).default as unknown as TestFn;
}
import { DatabaseSync } from "node:sqlite";
import { DRAMA_PIPELINE_DDL } from "../database-schema.js";
import { DramaPipeline } from "./pipeline.js";
import { PipelineStore } from "./pipeline-store.js";
import { checkPromptLength } from "../canvas/model-video-capability.js";
import { buildSegmentCondensePrompt } from "@basketikun/canvas-agent/drama/segment-writer";

// condensePromptToLimit 不需要 HTTP；用真实临时 store 满足构造期的 hydrateGatesFromStore。
function withPipeline(fn: (p: DramaPipeline) => void | Promise<void>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-condense-"));
    const file = path.join(dir, "runtime.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(DRAMA_PIPELINE_DDL);
    raw.close();
    const store = new PipelineStore(file);
    const p = new DramaPipeline({ store, token: "t" });
    return Promise.resolve(fn(p)).finally(() => { p.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
}

const longText = "镜头描写台词参考图".repeat(20); // 180 字

test("无上限时直通，不调用 writer", () => withPipeline(async (p) => {
    let calls = 0;
    const r = await p.condensePromptToLimit(longText, undefined, async () => { calls += 1; return "x"; });
    assert.equal(r.text, longText);
    assert.equal(r.count, 0);
    assert.equal(calls, 0);
    assert.equal(r.check.ok, true);
}));

test("超限后逐步精简直至达标，返回精简文本与次数", () => withPipeline(async (p) => {
    const limit = 100;
    const r = await p.condensePromptToLimit(longText, limit, async (text) => text.slice(0, Math.ceil(Array.from(text).length * 0.6)));
    assert.equal(r.check.ok, true, "最终收敛到上限内");
    assert.ok(r.count >= 1 && r.count <= 3, `精简次数在上限内：${r.count}`);
    assert.ok(Array.from(r.text).length <= limit);
}));

test("精简无进展（变长/空）时提前停止", () => withPipeline(async (p) => {
    let calls = 0;
    const r = await p.condensePromptToLimit(longText, 50, async () => { calls += 1; return longText + "更多内容"; });
    assert.equal(calls, 1, "第一次精简反而变长即停，不做满 3 次");
    assert.equal(r.count, 0);
    assert.equal(r.text, longText, "保留原文，不截断");
}));

test("精简任务抛错时保留上一版，不崩", () => withPipeline(async (p) => {
    const r = await p.condensePromptToLimit(longText, 50, async () => { throw new Error("model down"); });
    assert.equal(r.text, longText);
    assert.equal(r.count, 0);
}));

test("耗尽尝试次数仍超限：保留最后一版供手动精简（不截断）", () => withPipeline(async (p) => {
    const limit = 10;
    let calls = 0;
    const r = await p.condensePromptToLimit(longText, limit, async (text) => {
        calls += 1;
        return text.slice(0, Math.max(1, Array.from(text).length - 1));
    });
    assert.equal(calls, 3);
    assert.equal(r.count, 3);
    assert.equal(r.check.ok, false);
    assert.equal(Array.from(r.text).length, 177, "保留最后一版（180-3），未截断到上限");
}));

test("精简提示词由真值组件生成：含实际字数/上限，且用参考图编号保留约束", () => {
    const prompt = buildSegmentCondensePrompt(longText, 100);
    assert.match(prompt, /180 个字符/);
    assert.match(prompt, /上限 100 个字符/);
    assert.match(prompt, /参考图N/);
    assert.match(prompt, /<prompt>/);
});

test("checkPromptLength 真值：超限给出 maxChars，未登记上限直通", () => {
    const over = checkPromptLength(longText, 100);
    assert.equal(over.ok, false);
    if (!over.ok) { assert.equal(over.maxChars, 100); assert.equal(over.chars, 180); }
    assert.equal(checkPromptLength(longText, undefined).ok, true);
});
