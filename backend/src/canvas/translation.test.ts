import assert from "node:assert/strict";
import test from "node:test";
import { H3_PROMPT_TRANSLATION_SYSTEM_PROMPT, neutralizeQuotedDialogueReferences, parseH3TranslationBatchResponse, protectH3TranslationMarkers, runH3TranslationBatches } from "./translation.js";

test("H3 English translation preserves only actual dialogue", () => {
  assert.match(H3_PROMPT_TRANSLATION_SYSTEM_PROMPT, /Translate all Chinese text into English except the actual spoken dialogue payload/);
  assert.match(H3_PROMPT_TRANSLATION_SYSTEM_PROMPT, /This includes lyrics and explicitly quoted on-screen text/);
  assert.match(H3_PROMPT_TRANSLATION_SYSTEM_PROMPT, /preserve dialogue wrapped in tags such as <d>\[Chinese\]spoken words<\/d> exactly in its original language/);
});

test("H3 English translation preserves prompt structure and shot logic", () => {
  assert.match(H3_PROMPT_TRANSLATION_SYSTEM_PROMPT, /Do not change the actual shot logic/);
  assert.match(H3_PROMPT_TRANSLATION_SYSTEM_PROMPT, /Preserve the original meaning, facts, action, timing, constraints, and level of detail/);
  assert.match(H3_PROMPT_TRANSLATION_SYSTEM_PROMPT, /opaque tokens beginning ZXQH3LOCK.*Copy every token exactly once, unchanged, and in the same order/);
  assert.match(H3_PROMPT_TRANSLATION_SYSTEM_PROMPT, /Keep the section and paragraph layout/);
});

test("H3 translation protects structure and dialogue from model rewriting", () => {
  const source = "Camera: <Subject 2> pans at 00:01.250.\n<d>[Chinese]我等你 3 年。</d>\n[Shot 4] <scenetrans>fade</scenetrans>";
  const protectedPrompt = protectH3TranslationMarkers(source);
  assert.doesNotMatch(protectedPrompt.text, /<Subject 2>|00:01\.250|\[Chinese\]|我等你 3 年|\[Shot 4\]/);
  assert.equal((protectedPrompt.text.match(/ZXQH3LOCK/g) || []).length, 7);
  const translated = protectedPrompt.text;
  assert.equal(protectedPrompt.restore(translated), "Camera: <Subject 2> pans at 00:01.250.\n<d>[Chinese]我等你 3 年。</d>\n[Shot 4] <scenetrans>fade</scenetrans>");
  assert.doesNotThrow(() => protectedPrompt.restore(translated.replace(/ZXQH3LOCK[A-Z]+QXZ/, "")));
  assert.doesNotThrow(() => protectedPrompt.restore(`${translated} ZXQH3LOCKUNKNOWNQXZ`));
  const duplicated = translated.replace(/ZXQH3LOCK[A-Z]+QXZ/, token => `${token} ${token}`);
  assert.equal(protectedPrompt.restore(duplicated).split("Camera:").length - 1, 1);
});

test("quoted dialogue neutralization retains protected numbers before final validation", () => {
  const source = "She says “第3章” <d>[Chinese]第3章</d>";
  const neutralized = neutralizeQuotedDialogueReferences(source);
  assert.match(neutralized, /the line 3/);
  const protectedPrompt = protectH3TranslationMarkers(neutralized);
  const restored = protectedPrompt.restore(protectedPrompt.text);
  assert.deepEqual(restored.match(/\d+(?:\.\d+)?/g), source.match(/\d+(?:\.\d+)?/g));
  assert.match(restored, /<d>\[Chinese\]第3章<\/d>/);
});

test("H3 translation runs batches concurrently with no more than three prompts per model request", async () => {
  let active = 0;
  let maxActive = 0;
  const received: number[][] = [];
  const translated = await runH3TranslationBatches([1, 2, 3, 4, 5, 6, 7], async batch => {
    received.push(batch);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return batch.map(value => value * 10);
  });
  assert.deepEqual(received.map(batch => batch.length).sort(), [1, 3, 3]);
  assert.equal(maxActive, 3);
  assert.deepEqual(translated.flat().sort((a, b) => a - b), [10, 20, 30, 40, 50, 60, 70]);
  let siblingSettled = false;
  await assert.rejects(runH3TranslationBatches([1, 2, 3, 4], async batch => {
    if (batch[0] === 1) throw new Error("batch failed");
    await new Promise(resolve => setTimeout(resolve, 10));
    siblingSettled = true;
    return batch;
  }), /batch failed/);
  assert.equal(siblingSettled, true);
});

test("H3 translation accepts JSON surrounded by model presentation text", () => {
  const response = JSON.stringify({ translations: [{ id: "clip-1", text: "summary:\nA quiet street." }] });
  assert.deepEqual(parseH3TranslationBatchResponse(`:::writing{variant="standard"}\nHere is the translation:\n${response}\n:::`), [
    { id: "clip-1", text: "summary:\nA quiet street." },
  ]);
});

test("H3 translation accepts a text-field wrapper around the JSON response", () => {
  const response = JSON.stringify({ text: JSON.stringify({ translations: [{ id: "clip-2", text: "A slow pan." }] }) });
  assert.deepEqual(parseH3TranslationBatchResponse(response), [{ id: "clip-2", text: "A slow pan." }]);
});

test("H3 translation reports when the JSON batch is truncated or absent", () => {
  assert.throws(
    () => parseH3TranslationBatchResponse('{"translations":[{"id":"clip-3","text":"unfinished"'),
    /没有返回完整 JSON 批次/,
  );
});
