import assert from "node:assert/strict";
import test from "node:test";
import { selectCompactUpdate, assertPreparedInvariants } from "./prepared-updates.js";
import { buildNarrativeEditPatch } from "./narrative-edits.js";

for (const [label, before, after] of [
    ["unicode deletion", "😀 stable ".repeat(80) + "hide this", "😀 stable ".repeat(80)],
    ["insertion in middle", "Long stable sentence. ".repeat(80) + "abcdef", "Long stable sentence. ".repeat(80) + "abc😀def"],
    ["prepend", "Stable prose. ".repeat(80), "😀" + "Stable prose. ".repeat(80)],
    ["append", "Stable prose. ".repeat(80), "Stable prose. ".repeat(80) + "😀"],
    ["empty original", "", "new"],
    ["all deleted", "remove", ""],
    ["repeated ambiguous anchor", "aaaaaaaa", "aaa😀aaaaa"],
    ["complete rewrite", "old text", "completely new text"],
] as const) {
    test(`compact field expression exactly preserves requested ${label}`, () => {
        const { update } = selectCompactUpdate({ prompt: before }, { segmentId: "s", patch: { prompt: after } }, { prompt: after });
        const output = { ...(update as any).patch, ...((update as any).edits ? buildNarrativeEditPatch({ prompt: before }, (update as any).edits, (update as any).patch || {}, { remaining: 20 }).patch : {}) };
        assert.equal(output.prompt, after);
        assert.ok(!((update as any).edits && (update as any).patch?.prompt !== undefined));
    });
}

test("a dense short rewrite selects patch rather than forcing dozens of edits", () => {
    const original = { segmentId: "s", edits: Array.from({ length: 30 }, (_, i) => ({ field: "prompt", find: `x${i}`, replace: `y${i}`, expectedMatches: 1 })) };
    const selected = selectCompactUpdate({ prompt: "old" }, original, { prompt: "new" });
    assert.equal(selected.fields.prompt, "patch");
    assert.deepEqual(selected.update, { segmentId: "s", patch: { prompt: "new" } });
});

test("invariants require explicit allowChanges for authorized dialogue or timing edits", () => {
    const old = { id: "s", prompt: "0.0-8.0s <d>old</d>", duration: 8, timeline: [{ start: 0, end: 8 }] };
    const next = { ...old, prompt: "0.0-9.0s <d>new</d>", duration: 9, timeline: [{ start: 0, end: 9 }] };
    assert.throws(() => assertPreparedInvariants({}, [old], [next]), /对白/);
    assert.throws(() => assertPreparedInvariants({ allowChanges: ["dialogue"] }, [old], [next]), /时间码/);
    assert.doesNotThrow(() => assertPreparedInvariants({ allowChanges: ["dialogue", "timing"] }, [old], [next]));
});
