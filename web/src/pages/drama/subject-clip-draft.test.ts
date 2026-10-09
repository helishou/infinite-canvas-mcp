import assert from "node:assert/strict";
import test from "node:test";
import { readClipPartitionDraft } from "./subject-clip-draft";

test("Clip boundary edits survive reopening and source changes are marked without replacing the draft", () => {
    const draft = { base: "version-one", cuts: ["S1\0S2"], profileChoices: { "S1|S2": "C1" } };
    const raw = JSON.stringify(draft);
    assert.deepEqual(readClipPartitionDraft(raw, "version-one"), { draft, invalid: false, sourceChanged: false });
    const refreshed = readClipPartitionDraft(raw, "version-two");
    assert.equal(refreshed.sourceChanged, true);
    assert.deepEqual(refreshed.draft, draft);
});
test("damaged Clip draft fields are rejected rather than treated as a saved grouping", () => {
    for (const raw of ["{", "null", JSON.stringify({ base: "v1", cuts: [null], profileChoices: {} }), JSON.stringify({ base: "v1", cuts: [], profileChoices: [] })]) {
        assert.deepEqual(readClipPartitionDraft(raw, "v1"), { draft: undefined, invalid: true, sourceChanged: false });
    }
});
