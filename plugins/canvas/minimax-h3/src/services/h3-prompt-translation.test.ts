import assert from "node:assert/strict";
import test from "node:test";
import { planH3Translation, translateH3Prompt } from "./h3-prompt-translation";

const resultFor = (prompt: string, transform = (text: string) => text) => ({ text: JSON.stringify({ translations: JSON.parse(prompt).source.map((entry: { id: number; text: string }) => ({ id: entry.id, text: transform(entry.text) })) }) });

test("a 34k multiline prompt goes out in a single request and preserves source layout", async () => {
    const source = `subject_definitions:\r\n<Subject 1> is Alex.\r\n\r\ndetailed_description:\r\n${Array.from({ length: 49 }, (_, i) => `  [Shot ${i + 1}] <Picture 1> ${"Camera tracks the hero. ".repeat(30)}\t`).join("\r\n")}\r\n\r\noverall_soundscape: Final wind.\r\nnon_diegetic_music:\r\nN/A\r\n`;
    const calls: string[] = [];
    const translated = await translateH3Prompt(source, async (prompt, options) => {
        calls.push(prompt);
        assert.equal(options?.model, "configured-model");
        assert.equal(options?.log?.segmentId, "a");
        return resultFor(prompt, (text) => text.replaceAll("Camera tracks the hero.", "镜头跟随主角。").replace("Final wind.", "最终风声。"));
    }, { model: "configured-model", log: { taskMode: "翻译", segmentId: "a" } });
    assert.ok(source.length > 34000);
    assert.equal(calls.length, 1);
    assert.equal(translated, source.replaceAll("Camera tracks the hero.", "镜头跟随主角。").replace("Final wind.", "最终风声。"));
});

test("long lines stay whole in one record and round-trip losslessly", async () => {
    for (const source of ["Word ".repeat(3000), "😀".repeat(6000), "x".repeat(3995) + "<Picture 1>" + "y".repeat(4100)]) {
        const plan = planH3Translation(source);
        assert.equal(plan.records.length, 1);
        assert.ok(plan.records[0].text.length > 4000);
        assert.equal(await translateH3Prompt(source, async (prompt) => resultFor(prompt)), source);
        assert.ok(plan.records.every(({ text }) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(text)));
    }
});

test("unordered IDs and writing/fence wrappers from real channels preserve record identity", async () => {
    const source = "summary:\nFirst line.\nSecond line.\n";
    for (const wrap of [(text: string) => text, (text: string) => `\u0060\u0060\u0060json\n${text}\n\u0060\u0060\u0060`, (text: string) => `:::writing{variant="document" title="Translation" id="58391"}\n${text}\n:::`]) {
        assert.equal(await translateH3Prompt(source, async (prompt) => ({ text: wrap(JSON.stringify({ translations: JSON.parse(prompt).source.reverse() })) })), source);
    }
});

test("missing, duplicate, unknown and empty records fail without publishing a partial translation", async () => {
    for (const entries of [[{ id: 0, text: "A" }], [{ id: 0, text: "A" }, { id: 0, text: "B" }], [{ id: 0, text: "A" }, { id: 8, text: "B" }], [{ id: 0, text: "A" }, { id: 1, text: "" }]]) {
        await assert.rejects(translateH3Prompt("First.\nSecond.", async () => ({ text: JSON.stringify({ translations: entries }) })), /译文/);
    }
    await assert.rejects(translateH3Prompt("First.", async () => ({ text: "Not JSON" })), /译文/);
    await assert.rejects(translateH3Prompt("First.", async () => ({ text: "" })), /未返回内容/);
});

test("length notices and changed markers fail; quoted dialogue remains content", async () => {
    await assert.rejects(translateH3Prompt("First.", async () => ({ text: "（原文过长，超出单次回复长度限制，无法在单次回复中完整输出翻译。）" })), /长度限制说明/);
    await assert.rejects(translateH3Prompt("[Shot 1] <Subject 1> runs.", async (prompt) => resultFor(prompt, (text) => text.replace("Subject 1", "Subject 2"))), /改动了引用标签/);
    const dialogue = '<d>原文过长，超出长度限制，无法输出翻译。</d>';
    assert.equal(await translateH3Prompt(dialogue, async (prompt) => resultFor(prompt)), dialogue);
});

test("a failed or cancelled request is not retried automatically", async () => {
    const source = "Line text. ".repeat(900);
    let count = 0;
    await assert.rejects(translateH3Prompt(source, async () => { count++; throw new Error("channel unavailable"); }), /channel unavailable/);
    assert.equal(count, 1);
    const controller = new AbortController();
    await assert.rejects(translateH3Prompt(source, async (prompt) => { controller.abort(); return resultFor(prompt); }, { signal: controller.signal }), { name: "AbortError" });
});
