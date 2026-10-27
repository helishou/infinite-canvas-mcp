import assert from 'node:assert/strict';
import test from 'node:test';
import { continuityCoverageDigestValue, projectedContinuityBlock } from './continuity-source-digest';
import { appendContinuityChange } from './continuity-event-draft';
import { appendContinuityExemption, appendContinuityHold } from './continuity-ledger-evidence';

test('coverage digest ignores display fields, missing text and line-ending differences', () => {
    const block = { id: 'B', kind: 'action', text: '他抬头' };
    assert.deepEqual(projectedContinuityBlock({ id: 'B', kind: 'action', text: '他抬头  \r\n', display_note: 'highlight', note: 'private', bounds: { x: 1 } }), block);
    assert.deepEqual(continuityCoverageDigestValue('scene', { id: 'B' }), { scene_id: 'scene', block: { id: 'B', text: '' } });
});

const shots = [{ id: 'S', timeline_id: 'T', story_order: 1, start_frame: 200, end_frame: 272, duration_frames: 72 }];
const input = { shotId: 'S', factId: 'F', frame: '36', after: 'b', reason: '', sourceBlockId: 'B' };
function fixture(evidenceKind = 'explicit_change'): Record<string, any> {
    return {
        contract_version: 2, facts: [{ id: 'F', allowed_values: ['a', 'b'] }], timelines: [{ id: 'T' }],
        initial: [{ timeline_id: 'T', fact_id: 'F', value: 'a' }], events: [], requirements: [],
        coverage: [{ id: 'C', timeline_id: 'T', source_anchor: { block_id: 'B' }, source_digest: 'stored', evidence_kind: evidenceKind, fact_ids: [], event_ids: [], shot_ids: ['S'], rule: 'dialogue_without_state_change', reason: 'Documented review reason', review_ref: 'review' }],
    };
}

test('a coverage row merges only when the recomputed digest matches', () => {
    const result = appendContinuityChange(fixture(), shots, input, 'stored', () => 'E', true);
    assert.equal(result.ledger.coverage.length, 1);
    assert.equal(result.ledger.coverage[0].source_digest, 'stored');
    assert.throws(() => appendContinuityChange(fixture(), shots, input, 'other', () => 'E', true), /EVENT_COVERAGE_REVIEW_REQUIRED/);
});

test('hold and exemption reject stored rows whose digest differs', () => {
    const hold = appendContinuityHold(fixture('explicit_hold'), shots, { timelineId: 'T', shotId: 'S', factId: 'F', blockId: 'B', digest: 'stored' }, () => 'H', true);
    assert.equal(hold.coverage[0].source_digest, 'stored');
    assert.throws(() => appendContinuityHold(fixture('explicit_hold'), shots, { timelineId: 'T', shotId: 'S', factId: 'F', blockId: 'B', digest: 'other' }, () => 'H', true), /EVENT_COVERAGE_REVIEW_REQUIRED/);
    const exemption = { timelineId: 'T', shotId: 'S', blockId: 'B', digest: 'stored', reason: 'Documented review reason', reviewRef: 'review' };
    assert.equal(appendContinuityExemption(fixture('not_applicable_with_rule'), shots, exemption, () => 'X').coverage[0].source_digest, 'stored');
    assert.throws(() => appendContinuityExemption(fixture('not_applicable_with_rule'), shots, { ...exemption, digest: 'other' }, () => 'X'), /EVENT_COVERAGE_REVIEW_REQUIRED/);
});
