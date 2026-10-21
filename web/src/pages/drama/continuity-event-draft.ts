import { continuityEventAnchor } from './continuity-event-anchor';
type Row = Record<string, any>;
export const continuityReasonLength = (value: string) => Array.from(value.trim()).length;
export type ContinuityChangeInput = { shotId: string; factId: string; frame: string; after: string; reason: string; sourceBlockId: string };
/** 规范化摘要为准；同时携带旧格式，继续接受已按旧规则写入的覆盖行。 */
export type ContinuitySourceDigest = string | { digest: string; legacy?: string };
export const continuityDigestRef = (value?: ContinuitySourceDigest) => typeof value === 'string' ? { digest: value, accepted: [value] } : value ? { digest: value.digest, accepted: value.legacy ? [value.digest, value.legacy] : [value.digest] } : undefined;
/** Both editing surfaces use the same atomic six-collection ledger update. */
export function appendContinuityChange(ledger: Row, shots: Row[], input: ContinuityChangeInput, sourceDigest: ContinuitySourceDigest | undefined, makeId: () => string, local: boolean, persistLocal = local): { eventId: string; ledger: Row } {
    const shot = shots.find(row => row.id === input.shotId), fact = (ledger.facts || []).find((row: Row) => row.id === input.factId), digest = continuityDigestRef(sourceDigest);
    if (!shot || !fact || !input.after || !(input.after === 'unknown' || fact.allowed_values?.includes(input.after)) || Boolean(input.sourceBlockId) !== Boolean(digest?.digest)) throw new Error('EVENT_FIELDS_REQUIRED');
    if (!input.frame.trim()) throw new Error('INVALID_EVENT_FRAME');
    const state = continuityEventAnchor(ledger, shots, input.shotId, input.factId, Number(input.frame), local, persistLocal);
    const eventId = makeId(), timeline_id = shot.timeline_id, source_anchor = input.sourceBlockId ? { block_id: input.sourceBlockId } : undefined;
    const event = { id: eventId, timeline_id, fact_id: input.factId, shot_id: input.shotId, ...state.anchor, before: state.before, after: input.after, reason: input.reason.trim(), ...(source_anchor ? { source_anchor } : {}) };
    const coverage = [...(ledger.coverage || [])];
    if (!source_anchor) return { eventId, ledger: { ...ledger, events: [...(ledger.events || []), event], requirements: [...(ledger.requirements || []), { id: makeId(), timeline_id, shot_id: input.shotId, fact_id: input.factId, kind: 'change', event_ids: [eventId] }] } };
    const prior = coverage.find((row: Row) => row.source_anchor?.block_id === input.sourceBlockId && row.evidence_kind === 'explicit_change');
    if (prior && (!digest!.accepted.includes(String(prior.source_digest)) || prior.timeline_id !== timeline_id)) throw new Error('EVENT_COVERAGE_REVIEW_REQUIRED');
    const evidence = { id: prior?.id || makeId(), timeline_id, source_anchor, source_digest: digest!.digest, evidence_kind: 'explicit_change', fact_ids: [...new Set([...(prior?.fact_ids || []), input.factId])], event_ids: [...new Set([...(prior?.event_ids || []), eventId])], shot_ids: [...new Set([...(prior?.shot_ids || []), input.shotId])] };
    return { eventId, ledger: { ...ledger, events: [...(ledger.events || []), event], requirements: [...(ledger.requirements || []), { id: makeId(), timeline_id, shot_id: input.shotId, fact_id: input.factId, kind: 'change', event_ids: [eventId], source_anchor }], coverage: prior ? coverage.map((row: Row) => row.id === prior.id ? { ...prior, ...evidence } : row) : [...coverage, evidence] } };
}

/** A new form starts in the selected visible interval; no ledger row is created here. */
export function continuityChangeFormInput(ledger: Row, shot: Row, factId: string, visibleStart = 0): ContinuityChangeInput {
    const used = new Set((ledger.events || []).filter((row: Row) => row.shot_id === shot.id && row.fact_id === factId).map((row: Row) => row.local_frame));
    const last = Math.max(0, Number(shot.duration_frames) - 1);
    let frame = Math.min(last, Math.max(0, visibleStart));
    while (used.has(frame) && frame < last) frame++;
    return { shotId: String(shot.id), factId, frame: String(frame), after: "", reason: "", sourceBlockId: "" };
}
