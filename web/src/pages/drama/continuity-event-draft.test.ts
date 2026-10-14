import assert from 'node:assert/strict';
import test from 'node:test';
import { appendContinuityChange, continuityChangeFormInput, type ContinuityChangeInput } from './continuity-event-draft';
const shots = [{ id: 'S', timeline_id: 'T', story_order: 1, start_frame: 200, end_frame: 272, duration_frames: 72 }];
const fixture = (): Record<string, any> => ({ contract_version: 2, facts: [{ id: 'F', allowed_values: ['a', 'b'] }], timelines: [{ id: 'T' }], initial: [{ timeline_id: 'T', fact_id: 'F', value: 'a' }], events: [] as Record<string, any>[], requirements: [] as Record<string, any>[], coverage: [] as Record<string, any>[] });
const input: ContinuityChangeInput = { shotId: 'S', factId: 'F', frame: '36', after: 'b', reason: 'The object changes hands', sourceBlockId: 'B' };
let index = 0; const id = () => `new${++index}`;
test('inline and advanced creation append one atomic linked ledger change without mutating input', () => {
 const ledger = fixture(), before = structuredClone(ledger), result = appendContinuityChange(ledger, shots, input, 'digest', id, true);
 assert.deepEqual(ledger, before); assert.equal(result.ledger.events[0].before, 'a'); assert.equal(result.ledger.events[0].local_frame, 36);
 assert.equal(result.ledger.events[0].after, 'b'); assert.deepEqual(result.ledger.requirements[0].event_ids, [result.eventId]); assert.deepEqual(result.ledger.coverage[0].event_ids, [result.eventId]); assert.equal(result.ledger.coverage[0].source_digest, 'digest');
});
test('missing state cannot create partial records, while an empty reason or missing script evidence is allowed', () => {
 assert.throws(() => appendContinuityChange(fixture(), shots, { ...input, after: '' }, 'digest', id, true), /EVENT_FIELDS_REQUIRED/);
 assert.equal(appendContinuityChange(fixture(), shots, { ...input, reason: ' ' }, 'digest', id, true).ledger.events[0].reason, '');
 const result = appendContinuityChange(fixture(), shots, { ...input, sourceBlockId: '' }, undefined, id, true);
 assert.equal(result.ledger.events[0].source_anchor, undefined);
 assert.equal(result.ledger.requirements[0].source_anchor, undefined);
 assert.equal(result.ledger.coverage.length, 0);
});
test('empty, fractional and out-of-window positions are rejected', () => {
 for (const frame of ['', '-1', '2.5', '72']) assert.throws(() => appendContinuityChange(fixture(), shots, { ...input, frame }, 'digest', id, true), /INVALID_EVENT_FRAME/);
});
test('a second same-Shot event derives its before-state and extends existing reviewed coverage once', () => {
 const first = appendContinuityChange(fixture(), shots, input, 'digest', id, true);
 const second = appendContinuityChange(first.ledger, shots, { ...input, frame: '37', after: 'a' }, 'digest', id, true);
 assert.equal(second.ledger.events[1].before, 'b'); assert.equal(second.ledger.coverage.length, 1); assert.equal(second.ledger.coverage[0].event_ids.length, 2);
 assert.throws(() => appendContinuityChange(second.ledger, shots, input, 'digest', id, true), /EVENT_ANCHOR_OCCUPIED/);
});
test('stale evidence is not silently refreshed for other registered events', () => {
 const first = appendContinuityChange(fixture(), shots, input, 'old', id, true);
 assert.throws(() => appendContinuityChange(first.ledger, shots, { ...input, frame: '37' }, 'new', id, true), /EVENT_COVERAGE_REVIEW_REQUIRED/);
 assert.equal(first.ledger.coverage[0].source_digest, 'old');
});
test('legacy advanced creation retains absolute-frame anchors', () => {
 const result = appendContinuityChange(fixture(), shots, { ...input, frame: '236' }, 'digest', id, false);
 assert.equal(result.ledger.events[0].frame, 236); assert.equal(result.ledger.events[0].local_frame, undefined);
});

test('an omitted reason never blocks a change and is stored trimmed', () => {
 for (const reason of ['', ' ', '改']) assert.equal(appendContinuityChange(fixture(), shots, { ...input, reason }, 'digest', id, true).ledger.events[0].reason, reason.trim());
});

test('record-change task preserves the selected Shot/fact and starts inside its visible interval', () => {
 const ledger = fixture(); ledger.events.push({ shot_id: 'S', fact_id: 'F', local_frame: 12 });
 const form = continuityChangeFormInput(ledger, shots[0], 'F', 12);
 assert.deepEqual(form, { shotId: 'S', factId: 'F', frame: '13', after: '', reason: '', sourceBlockId: '' });
 assert.equal(ledger.events.length, 1);
});
