import assert from "node:assert/strict";
import test from "node:test";
import { reverseSyncPromptEdit, type PromptSourceMap } from "./prompt-reverse-sync.js";

function sourceMap(prompt: string): PromptSourceMap {
    const first = prompt.indexOf("A child watches quietly.");
    const second = prompt.indexOf("She asks about the egg.");
    return { version: 1, offsetUnit: "utf16", segmentId: "CLIP_1", sourceHash: "source-v1", promptHash: "prompt-v1", entries: [
        { start: first, end: first + "A child watches quietly.".length, sourceKind: "shot", sourceId: "SHOT_1", field: "visual", sourceText: "A child watches quietly.", sourceValue: "A child watches quietly.", sourceStart: 0, sourceEnd: "A child watches quietly.".length },
        { start: second, end: second + "She asks about the egg.".length, sourceKind: "utterance", sourceId: "UTTERANCE_1", field: "text", sourceText: "She asks about the egg.", sourceValue: "She asks about the egg.", sourceStart: 0, sourceEnd: "She asks about the egg.".length },
    ] };
}

test("one exact manual edit maps back to its source field", () => {
    const baseline = "summary:\\nA child watches quietly.\\nShe asks about the egg.";
    const edited = baseline.replace("watches quietly", "watches from outside");
    assert.deepEqual(reverseSyncPromptEdit(baseline, edited, sourceMap(baseline)), {
        changed: true, sourceKind: "shot", sourceId: "SHOT_1", field: "visual", value: "A child watches from outside.",
    });
});

test("a cross-Shot utterance fragment updates only its mapped source range", () => {
    const baseline = "summary:\nA child says <d>[English] the real egg</d>.";
    const fragment = "the real egg", sourceValue = "Look at the real egg";
    const promptStart = baseline.indexOf(fragment), sourceStart = sourceValue.indexOf(fragment);
    const map: PromptSourceMap = { version: 1, offsetUnit: "utf16", segmentId: "CLIP_1", sourceHash: "source-v1", promptHash: "prompt-v1", entries: [
        { start: promptStart, end: promptStart + fragment.length, sourceKind: "utterance", sourceId: "UTTERANCE_1", field: "text", sourceText: fragment,
            sourceValue, sourceStart, sourceEnd: sourceStart + fragment.length },
    ] };
    assert.equal(reverseSyncPromptEdit(baseline, baseline.replace(fragment, "the straw nest"), map).value, "Look at the straw nest");
});

test("edits outside mapped spans and edits spanning source fields remain unparsed", () => {
    const baseline = "summary:\\nA child watches quietly.\\nShe asks about the egg.";
    assert.throws(() => reverseSyncPromptEdit(baseline, baseline.replace("summary", "summary, no extra characters"), sourceMap(baseline)), { code: "PROMPT_REVERSE_SYNC_AMBIGUOUS" });
    const both = baseline.replace("quietly", "carefully").replace("egg", "nest");
    assert.throws(() => reverseSyncPromptEdit(baseline, both, sourceMap(baseline)), { code: "PROMPT_REVERSE_SYNC_AMBIGUOUS" });
});

test("a stale or incorrect SourceMap span cannot silently edit source", () => {
    const baseline = "summary:\\nA child watches quietly.\\nShe asks about the egg.";
    const map = sourceMap(baseline);
    map.entries[0].sourceText = "not the compiler span";
    assert.throws(() => reverseSyncPromptEdit(baseline, baseline.replace("quietly", "carefully"), map), { code: "PROMPT_REVERSE_SYNC_AMBIGUOUS" });
});
