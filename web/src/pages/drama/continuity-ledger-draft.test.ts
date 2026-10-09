import assert from "node:assert/strict";
import test from "node:test";
import { readContinuityLedgerDraft, rebaseContinuityLedger } from "./continuity-ledger-draft";
const ledger = { contract_version: 2, facts: [{ id: "F1", property: "position", value_descriptions: { outside: "Outside" } }], timelines: [{ id: "main" }], initial: [{ timeline_id: "main", fact_id: "F1", value: "outside" }], events: [], requirements: [], coverage: [] };
test("ledger drafts restore independently and keep damaged text marked for review", () => {
    const draft = readContinuityLedgerDraft(undefined, ledger);
    draft.value.facts[0].value_descriptions.outside = "Outside the window";
    assert.equal(draft.base.facts[0].value_descriptions.outside, "Outside");
    assert.equal(readContinuityLedgerDraft(JSON.stringify({ version: 1, ...draft }), ledger).value.facts[0].value_descriptions.outside, "Outside the window");
    assert.equal(readContinuityLedgerDraft("broken", ledger).invalid, true);
});
test("reviewed ledger edits retain unrelated remote facts and unedited fields", () => {
    const local = structuredClone(ledger), remote = structuredClone(ledger);
    local.facts[0].value_descriptions.outside = "Outside the window";
    remote.facts[0].property = "location";
    (remote.facts[0].value_descriptions as Record<string, string>).inside = "Inside the coop";
    remote.facts.push({ id: "F2", property: "egg", value_descriptions: { outside: "Nest" } });
    const merged = rebaseContinuityLedger(ledger, local, remote);
    assert.equal(merged.facts[0].property, "location");
    assert.equal(merged.facts[0].value_descriptions.outside, "Outside the window");
    assert.equal(merged.facts[0].value_descriptions.inside, "Inside the coop");
    assert.equal(merged.facts[1].id, "F2");
    assert.deepEqual(merged.initial, ledger.initial);
});
