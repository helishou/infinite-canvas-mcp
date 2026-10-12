import { continuityEventAnchor } from './continuity-event-anchor';
import { continuityReasonLength } from './continuity-event-draft';
type Row = Record<string, any>;
export const normalizedContinuityValues = (text: string) => [...new Set(text.split(/[,，\n]/).map(value => value.trim()).filter(value => value && value !== 'unknown'))];
function withCoverage(ledger: Row, row: Row) {
    const coverage: Row[] = ledger.coverage || [];
    const prior = coverage.find(item => item.source_anchor?.block_id === row.source_anchor?.block_id && item.evidence_kind === row.evidence_kind);
    if (!prior) return { ...ledger, coverage: [...coverage, row] };
    if (prior.timeline_id !== row.timeline_id || prior.source_digest !== row.source_digest || row.evidence_kind === 'not_applicable_with_rule' && (prior.reason !== row.reason || prior.review_ref !== row.review_ref || prior.rule !== row.rule)) throw new Error('EVENT_COVERAGE_REVIEW_REQUIRED');
    const merged = { ...prior };
    for (const key of ['fact_ids', 'event_ids', 'shot_ids']) merged[key] = [...new Set([...(prior[key] || []), ...(row[key] || [])])];
    return { ...ledger, coverage: coverage.map(item => item.id === prior.id ? merged : item) };
}
export function appendContinuityHold(ledger: Row, shots: Row[], input: { timelineId: string; shotId: string; factId: string; blockId: string; digest: string }, makeId: () => string, local: boolean) {
    const shot = shots.find(row => row.id === input.shotId);
    if (!shot || shot.timeline_id !== input.timelineId || !input.blockId || !input.digest || !(ledger.facts || []).some((row: Row) => row.id === input.factId)) throw new Error('EVENT_FIELDS_REQUIRED');
    if (!(ledger.initial || []).some((row: Row) => row.timeline_id === input.timelineId && row.fact_id === input.factId)) throw new Error('EVENT_INITIAL_STATE_MISSING');
    const state = continuityEventAnchor(ledger, shots, input.shotId, input.factId, local ? 0 : Number(shot.start_frame), local);
    const source_anchor = { block_id: input.blockId };
    const next = withCoverage(ledger, { id: makeId(), timeline_id: input.timelineId, source_anchor, source_digest: input.digest, evidence_kind: 'explicit_hold', fact_ids: [input.factId], event_ids: [], shot_ids: [input.shotId] });
    return { ...next, requirements: [...(ledger.requirements || []), { id: makeId(), timeline_id: input.timelineId, shot_id: input.shotId, fact_id: input.factId, kind: 'hold', value: state.before, source_anchor }] };
}
export function appendContinuityExemption(ledger: Row, shots: Row[], input: { timelineId: string; shotId: string; blockId: string; digest: string; reason: string; reviewRef: string }, makeId: () => string) {
    const shot = shots.find(row => row.id === input.shotId);
    if (!shot || shot.timeline_id !== input.timelineId || !input.blockId || !input.digest || continuityReasonLength(input.reason) < 8 || !input.reviewRef.trim()) throw new Error('EVENT_FIELDS_REQUIRED');
    return withCoverage(ledger, { id: makeId(), timeline_id: input.timelineId, source_anchor: { block_id: input.blockId }, source_digest: input.digest, evidence_kind: 'not_applicable_with_rule', fact_ids: [], event_ids: [], shot_ids: [input.shotId], rule: 'dialogue_without_state_change', reason: input.reason.trim(), review_ref: input.reviewRef.trim() });
}
