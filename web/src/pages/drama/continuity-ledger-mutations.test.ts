import assert from 'node:assert/strict';
import test from 'node:test';
import { appendContinuityChange } from './continuity-event-draft';
import { analyzeContinuityDeletion as analyze, applyContinuityDeletion as apply, continuityLedgerEntryId as key, restoreContinuityDeletion as restore, continuityFactStateValue, continuityLedgerFactDescriptions } from './continuity-ledger-mutations';
const shots = [{ id: 'S', timeline_id: 'T', story_order: 0, duration_frames: 72 }];
const source = { shots, subject_registry: [] };
const fixture = (): Record<string, any> => ({ contract_version: 2, facts: [{ id: 'F', allowed_values: ['a', 'b'] }], timelines: [{ id: 'T' }], initial: [{ timeline_id: 'T', fact_id: 'F', value: 'a' }], events: [], requirements: [], coverage: [] });
const input = { shotId: 'S', factId: 'F', frame: '12', after: 'b', reason: 'The object changes hands', sourceBlockId: 'B' };
function change(): Record<string, any> { let n = 0; return appendContinuityChange(fixture(), shots, input, 'reviewed-digest', () => `ID${++n}`, true).ledger; }
test('actual appended event deletes atomically without touching later state or unrelated evidence', () => {
 const ledger = change();
 ledger.events.push({ id: 'later', timeline_id: 'T', fact_id: 'F', shot_id: 'S', local_frame: 40, before: 'b', after: 'a' });
 ledger.coverage.push({ id: 'other', evidence_kind: 'unresolved_review', source_digest: 'old' });
 const before = structuredClone(ledger), analysis = analyze(source, ledger, 'events', 'ID1');
 assert.equal(analysis.allowed, true); assert.equal(analysis.removals.length, 3); assert.deepEqual(analysis.affectedShotIds, ['S']);
 const result = apply(source, ledger, 'events', 'ID1');
 assert.deepEqual(result.events, [before.events[1]]); assert.deepEqual(result.coverage, [before.coverage[1]]); assert.deepEqual(result.requirements, []); assert.deepEqual(ledger, before);
});
test('shared real append evidence refuses deletion and preserves all assertions and digest', () => {
 let n = 10; const ledger = appendContinuityChange(change(), shots, { ...input, frame: '24', after: 'a' }, 'reviewed-digest', () => `ID${++n}`, true).ledger;
 const before = structuredClone(ledger), analysis = analyze(source, ledger, 'events', 'ID1');
 assert.equal(analysis.code, 'shared_evidence'); assert.equal(analysis.allowed, false);
 assert.deepEqual(analysis.references.map(row => [row.collection, row.id]), [['coverage', 'ID2']]);
 assert.throws(() => apply(source, ledger, 'events', 'ID1'), /shared_evidence/); assert.deepEqual(ledger, before);
});
test('other facts/shots, mismatched evidence and shared requirements cannot be cascaded', () => {
 for (const patch of [{ fact_ids: ['F', 'OTHER'] }, { shot_ids: ['S', 'OTHER'] }, { evidence_kind: 'inherited_fact' }, { timeline_id: 'OTHER' }, { source_anchor: { block_id: 'OTHER' } }]) {
  const ledger = change(); Object.assign(ledger.coverage[0], patch); assert.equal(analyze(source, ledger, 'events', 'ID1').code, 'shared_evidence');
 }
 const ledger = change(); ledger.requirements[0].event_ids.push('OTHER'); assert.equal(analyze(source, ledger, 'events', 'ID1').code, 'shared_evidence');
});
test('unknown IDs and duplicate primary or dependent IDs are rejected', () => {
 const ledger = change(); assert.equal(analyze(source, ledger, 'events', 'unknown').code, 'missing');
 ledger.events.push({ ...ledger.events[0] }); assert.equal(analyze(source, ledger, 'events', 'ID1').code, 'ambiguous');
 ledger.events.pop(); ledger.requirements.push({ ...ledger.requirements[0] }); assert.equal(analyze(source, ledger, 'events', 'ID1').code, 'ambiguous');
});
test('initial composite identity has no delimiter collision and rejects duplicates', () => {
 const ledger = fixture(); ledger.initial = [{ timeline_id: 'A:B', fact_id: 'C', value: 'a' }, { timeline_id: 'A', fact_id: 'B:C', value: 'b' }];
 assert.notEqual(key('initial', ledger.initial[0]), key('initial', ledger.initial[1]));
 assert.deepEqual(apply(source, ledger, 'initial', ledger.initial[0]).initial, [ledger.initial[1]]);
 ledger.initial.push({ ...ledger.initial[0] }); assert.equal(analyze(source, ledger, 'initial', ledger.initial[0]).code, 'ambiguous');
});
test('fact deletion drops ledger-owned assertions while timeline references block deletion', () => {
 const ledger = change(); const factAnalysis = analyze(source, ledger, 'facts', 'F');
 assert.equal(factAnalysis.code, 'allowed'); assert.deepEqual(factAnalysis.affectedShotIds, ['S']);
 const analysis = analyze(source, ledger, 'timelines', 'T'); assert.equal(analysis.code, 'referenced'); assert.ok(analysis.references.some(row => row.collection === 'shots' && row.shotId === 'S'));
 assert.deepEqual(apply(source, ledger, 'facts', 'F').facts, []);
 assert.throws(() => apply(source, ledger, 'timelines', 'T'), /referenced/);
});
test('source fact consumers are reported as affected shots instead of blocking deletion', () => {
 const ledger = { ...fixture(), initial: [] };
 for (const shot of [{ ...shots[0], continuity_facts: ['F'] }, { ...shots[0], subject_usages: [{ subjectId: 'P', continuityFactIds: ['F'] }] }, { ...shots[0], subject_usages: [{ subjectId: 'P', stateRequirements: [{ factId: 'F', value: 'a' }] }] }]) {
  const analysis = analyze({ shots: [shot] }, ledger, 'facts', 'F'); assert.equal(analysis.code, 'allowed'); assert.deepEqual(analysis.affectedShotIds, ['S']);
 }
 assert.equal(analyze({ subject_registry: [{ id: 'P', pictureBindings: [{ id: 'PB', applicableState: { F: 'a' } }] }] }, ledger, 'facts', 'F').code, 'allowed');
 assert.equal(analyze(undefined, ledger, 'facts', 'F').code, 'allowed');
 assert.deepEqual(apply({}, ledger, 'facts', 'F').facts, []); assert.deepEqual(apply({}, { ...fixture(), initial: [] }, 'timelines', 'T').timelines, []);
});
test('sole supporting hold is protected while redundant holds remain editable', () => {
 const ledger = fixture(); ledger.requirements = [{ id: 'H', timeline_id: 'T', fact_id: 'F', shot_id: 'S', kind: 'hold', value: 'a' }];
 ledger.coverage = [{ id: 'C', timeline_id: 'T', evidence_kind: 'explicit_hold', fact_ids: ['F'], shot_ids: ['S'] }];
 assert.equal(analyze(source, ledger, 'requirements', 'H').code, 'referenced');
 ledger.requirements.push({ ...ledger.requirements[0], id: 'H2' }); assert.equal(apply(source, ledger, 'requirements', 'H').requirements.length, 1);
});
test('manual coverage and unresolved requirement removals do not fabricate replacements', () => {
 const ledger = change(); assert.deepEqual(apply(source, ledger, 'coverage', 'ID2').coverage, []); assert.deepEqual(apply(source, ledger, 'requirements', 'ID3').requirements, []);
 ledger.requirements.push({ id: 'U', kind: 'unresolved', reason: 'needs review' }); assert.equal(apply(source, ledger, 'requirements', 'U').requirements.length, 1);
});
test('application rechecks dependencies introduced after preview', () => {
 const ledger = change(); assert.equal(analyze(source, ledger, 'events', 'ID1').allowed, true); ledger.coverage[0].event_ids.push('new-event'); assert.throws(() => apply(source, ledger, 'events', 'ID1'), /shared_evidence/);
});

test('initial deletion exposes all timeline Shots without rewriting their authored state', () => {
 const ledger = change(), before = structuredClone(ledger);
 const analysis = analyze({ shots: [...shots, { id: 'NEXT', timeline_id: 'T' }, { id: 'UNRELATED', timeline_id: 'T2' }] }, ledger, 'initial', ledger.initial[0]);
 assert.equal(analysis.allowed, true); assert.deepEqual(analysis.affectedShotIds, ['S', 'NEXT']);
 const result = apply(source, ledger, 'initial', ledger.initial[0]); assert.deepEqual(result.events, before.events); assert.deepEqual(ledger, before);
});

test('restore returns only removed records and preserves intervening edits without mutating input', () => {
 const ledger = change(), deleted = apply(source, ledger, 'events', 'ID1');
 deleted.facts = [{ ...deleted.facts[0], display_name: 'Edited title' }];
 const removed = analyze(source, ledger, 'events', 'ID1').removals.map(item => ({ collection: item.collection, row: ledger[item.collection].find((row: Record<string, any>) => key(item.collection, row) === item.id) }));
 const before = structuredClone(deleted), result = restore(deleted, removed);
 assert.deepEqual(result.events, ledger.events); assert.deepEqual(result.coverage, ledger.coverage); assert.deepEqual(result.requirements, ledger.requirements);
 assert.equal(result.facts[0].display_name, 'Edited title'); assert.deepEqual(deleted, before);
});
test('restore rejects new same-ID rows and duplicate restoration payload atomically', () => {
 const ledger = change(), deleted = apply(source, ledger, 'events', 'ID1');
 const removed = [{ collection: 'events' as const, row: ledger.events[0] }];
 deleted.events.push({ ...ledger.events[0], after: 'new edit' }); const before = structuredClone(deleted);
 assert.throws(() => restore(deleted, removed), /ambiguous/); assert.deepEqual(deleted, before);
 deleted.events = []; assert.throws(() => restore(deleted, [...removed, ...removed]), /ambiguous/);
 const initial = ledger.initial[0]; assert.throws(() => restore(ledger, [{ collection: 'initial', row: initial }]), /ambiguous/);
});
test('restore optionally retains original positions while keeping later added rows', () => {
 const ledger = { ...fixture(), requirements: [{ id: 'new' }] };
 const result = restore(ledger, [{ collection: 'requirements', row: { id: 'b', timeline_id: 'T', fact_id: 'F', shot_id: 'S', kind: 'hold', value: 'a' }, index: 1 }, { collection: 'requirements', row: { id: 'a', timeline_id: 'T', fact_id: 'F', shot_id: 'S', kind: 'hold', value: 'a' }, index: 0 }]);
 assert.deepEqual(result.requirements.map((row: Record<string, any>) => row.id), ['a', 'b', 'new']);
});

const removedEvent = (ledger: Record<string, any>) => analyze(source, ledger, 'events', 'ID1').removals.map(item => ({ collection: item.collection, row: ledger[item.collection].find((row: Record<string, any>) => key(item.collection, row) === item.id) }));
test('undo rejects new same-block coverage even when the new event has a different position and all IDs differ', () => {
 const old = change(), removed = removedEvent(old); let n = 20;
 const current = appendContinuityChange(apply(source, old, 'events', 'ID1'), shots, { ...input, frame: '30' }, 'reviewed-digest', () => `NEW${++n}`, true).ledger;
 const before = structuredClone(current); assert.throws(() => restore(current, removed, source), /ambiguous/); assert.deepEqual(current, before);
});
test('undo rejects occupied event positions independently of evidence block and ID', () => {
 const old = change(), removed = removedEvent(old); let n = 20;
 const current = appendContinuityChange(apply(source, old, 'events', 'ID1'), shots, { ...input, sourceBlockId: 'OTHER' }, 'different-digest', () => `NEW${++n}`, true).ledger;
 const before = structuredClone(current); assert.throws(() => restore(current, removed, source), /ambiguous/); assert.deepEqual(current, before);
});
test('undo checks only restored rows for missing parents and accepts parents restored in the same operation', () => {
 const old = change(), removed = removedEvent(old);
 for (const group of ['facts', 'timelines']) { const current = apply(source, old, 'events', 'ID1'); current[group] = []; assert.throws(() => restore(current, removed, source), /missing/); }
 const current = apply(source, old, 'events', 'ID1'); assert.throws(() => restore(current, removed, { shots: [] }), /missing/);
 assert.throws(() => restore(current, removed.filter(item => item.collection !== 'events'), source), /missing/);
 current.facts = []; const result = restore(current, [...removed, { collection: 'facts', row: old.facts[0] }], source); assert.equal(result.events.length, 1);
 const initial = old.initial[0]; assert.throws(() => restore({ ...old, initial: [], facts: [] }, [{ collection: 'initial', row: initial }]), /missing/);
 const unrelatedDamage = { ...current, facts: old.facts, requirements: [{ id: 'bad', timeline_id: 'unknown', fact_id: 'unknown' }] };
 assert.equal(restore(unrelatedDamage, removed, source).requirements.length, 2);
});
test('undo detects equivalent local and absolute positions when source frame window is known', () => {
 const old = change(), removed = removedEvent(old), current = apply(source, old, 'events', 'ID1');
 current.events = [{ id: 'new', timeline_id: 'T', fact_id: 'F', shot_id: 'S', frame: 212 }];
 assert.throws(() => restore(current, removed, { shots: [{ ...shots[0], start_frame: 200 }] }), /ambiguous/);
});

test('restoring hold evidence requires its supporting hold, including one restored together', () => {
 const ledger = fixture(), evidence = { id: 'C', timeline_id: 'T', evidence_kind: 'explicit_hold', fact_ids: ['F'], shot_ids: ['S'], source_anchor: { block_id: 'B' } };
 const removed = [{ collection: 'coverage' as const, row: evidence }];
 assert.throws(() => restore(ledger, removed, source), /missing/);
 const requirement = { id: 'H', timeline_id: 'T', fact_id: 'F', shot_id: 'S', kind: 'hold', value: 'a' };
 assert.equal(restore(ledger, [...removed, { collection: 'requirements', row: requirement }], source).coverage.length, 1);
});

test('a new state value joins the fact enum with the description the save contract requires', () => {
 const fact = { id: 'F', allowed_values: ['a', 'b'], value_descriptions: { a: 'State A' } };
 const state = continuityFactStateValue(fact, ' c ');
 assert.deepEqual(state.allowed_values, ['a', 'b', 'c']);
 // A described value keeps its text; missing and new ones default to the value itself.
 assert.deepEqual(state.value_descriptions, { a: 'State A', b: 'b', c: 'c' });
 assert.equal(fact.allowed_values.length, 2, 'the fact is not mutated');
});

test('a new state value never duplicates an existing one or reintroduces the unknown sentinel', () => {
 const fact = { id: 'F', allowed_values: ['a'], value_descriptions: { a: 'State A' } };
 assert.deepEqual(continuityFactStateValue(fact, 'a').allowed_values, ['a']);
 assert.deepEqual(continuityFactStateValue(fact, 'unknown').allowed_values, ['a']);
 assert.deepEqual(continuityFactStateValue({ id: 'F' }, ' x '), { allowed_values: ['x'], value_descriptions: { x: 'x' } });
});

test('completing descriptions at save leaves a valid ledger untouched and repairs only what is missing', () => {
 const complete = { facts: [{ id: 'F', allowed_values: ['a'], value_descriptions: { a: 'State A' } }] };
 assert.equal(continuityLedgerFactDescriptions(complete), complete, 'a valid ledger keeps its identity');
 const broken: Record<string, any> = { facts: [{ id: 'F', allowed_values: ['a', 'b'], value_descriptions: { a: '   ' } }, { id: 'G', allowed_values: ['x'], value_descriptions: { x: 'State X' } }, 'ignored'] };
 const result = continuityLedgerFactDescriptions(broken);
 assert.deepEqual(result.facts[0].value_descriptions, { a: 'a', b: 'b' });
 assert.equal(result.facts[1], broken.facts[1], 'a described fact keeps its identity');
 assert.equal(result.facts[2], 'ignored', 'invalid rows survive the pass');
 assert.deepEqual(broken.facts[0].value_descriptions, { a: '   ' }, 'the input ledger is not mutated');
});
