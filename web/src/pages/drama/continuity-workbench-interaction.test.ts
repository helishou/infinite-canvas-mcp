import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { continuityChangeInputHint, continuityDraftFocusTarget, continuityTrackPoint, continuityTrackInsertFrame, continuityInlineReturnFocus, continuityRowInsertTarget, continuitySecondLabel } from './continuity-workbench-interaction';
const complete = { shotId: 'S', factId: 'F', frame: '12', after: 'known', reason: '明确登记发生变化', sourceBlockId: 'B' };
test('draft focus follows entry, confirmation and cancellation without moving on edits', () => {
    assert.equal(continuityDraftFocusTarget(false, true, false), '[data-continuity-frame-slider]');
    assert.equal(continuityDraftFocusTarget(true, false, true), '[data-continuity-save-action]');
    assert.equal(continuityDraftFocusTarget(true, false, false), '[data-continuity-add-here]');
    assert.equal(continuityDraftFocusTarget(true, true, false), undefined);
    assert.equal(continuityDraftFocusTarget(false, false, false), undefined);
});
test('disabled confirmation explains the first existing unmet requirement', () => {
    assert.equal(continuityChangeInputHint(complete, 'Frame is occupied')?.text, 'Frame is occupied');
    assert.equal(continuityChangeInputHint({ ...complete, after: '' }, '')?.key, 'hintChooseAfter');
    assert.equal(continuityChangeInputHint({ ...complete, reason: '' }, ''), undefined);
    assert.equal(continuityChangeInputHint({ ...complete, sourceBlockId: '' }, ''), undefined);
    assert.equal(continuityChangeInputHint(complete, ''), undefined);
    assert.equal(continuityChangeInputHint(undefined, ''), undefined);
});
test('rendered controls connect focus and hints, and state-cell speech uses the visible interval', () => {
    const workbench = readFileSync(new URL('./continuity-timeline-workbench.tsx', import.meta.url), 'utf8');
    const fields = readFileSync(new URL('./continuity-event-fields.tsx', import.meta.url), 'utf8');
    const panel = readFileSync(new URL('./continuity-panel.tsx', import.meta.url), 'utf8');
    assert.match(workbench, /aria-describedby=\{draftHintId\}/);
    assert.match(workbench, /id=\{changeDraft \? draftHintId : undefined\}/);
    assert.match(panel, /data-continuity-save-action/);
    assert.match(fields, /data-continuity-frame-slider/);
    assert.match(workbench, /data-continuity-add-here/);
    assert.match(workbench, /aria-label=\{`[^\n]*display\.value\(fact\.id, view\.segments\[0\]\?\.value\)/);
});

function track() {
    return { duration: 96, segments: [{ start: 12, end: 36, value: 'closed', windowStart: 12 }, { start: 36, end: 60, value: 'open', windowStart: 12 }, { start: 72, end: 96, value: 'open', windowStart: 72 }], markers: [{ frame: 36, event: { id: 'E' } }] } as Parameters<typeof continuityTrackPoint>[0];
}
test('point editing reports the clicked state, not the final state, and preserves event identity', () => {
    assert.deepEqual(continuityTrackPoint(track(), 18 / 96), { frame: 18, value: 'closed', eventId: undefined });
    assert.deepEqual(continuityTrackPoint(track(), 36 / 96), { frame: 36, value: 'open', eventId: 'E' });
    assert.deepEqual(continuityTrackPoint(track()), { frame: 12, value: 'closed', eventId: undefined });
    assert.equal(continuityTrackPoint(track(), 35.9 / 96)?.frame, 35);
});
test('half-open presence gaps remain inert, while the final pixel clamps to the final frame', () => {
    for (const frame of [0, 11, 60, 71]) assert.equal(continuityTrackPoint(track(), frame / 96), undefined);
    assert.equal(continuityTrackPoint(track(), 1)?.frame, 95);
    assert.equal(continuityTrackPoint(track(), Infinity), undefined);
    assert.equal(continuityTrackPoint({ ...track(), segments: [] }), undefined);
    assert.equal(continuityTrackPoint({ ...track(), duration: 0 }, .5), undefined);
});
test('explicit add stays in visible windows and refuses fully occupied visible frames', () => {
    const view = track();
    assert.equal(continuityTrackInsertFrame(view), 12);
    view.segments = [{ start: 12, end: 14, value: 'closed', windowStart: 12 }, { start: 72, end: 74, value: 'open', windowStart: 72 }];
    view.markers = [12, 13, 72].map(frame => ({ frame, event: { id: String(frame) } })) as typeof view.markers;
    assert.equal(continuityTrackInsertFrame(view), 73);
    view.markers.push({ ...view.markers[0], frame: 73 });
    assert.equal(continuityTrackInsertFrame(view), undefined);
});

test('a shot-local position reads as seconds with a safe frame-rate fallback', () => {
    assert.equal(continuitySecondLabel(24, 24), '1.0');
    assert.equal(continuitySecondLabel(0, 24), '0.0');
    assert.equal(continuitySecondLabel(30, 25), '1.2');
    assert.equal(continuitySecondLabel(12, 0), '0.5');
    assert.equal(continuitySecondLabel(12, NaN), '0.5');
});

test('the row-level add targets the first visible Shot that still has a free change frame', () => {
    const free = { duration: 96, segments: [{ start: 12, end: 36, windowStart: 12, value: 'open' }], markers: [] };
    const full = { duration: 96, segments: [{ start: 12, end: 13, windowStart: 12, value: 'open' }], markers: [{ frame: 12, event: { id: 'E' } }] };
    assert.deepEqual(continuityRowInsertTarget([{ shotId: 'S1', view: full }, { shotId: 'S2', view: free }]), { shotId: 'S2', frame: 12 });
    assert.deepEqual(continuityRowInsertTarget([{ shotId: 'S1', view: free }]), { shotId: 'S1', frame: 12 });
    assert.equal(continuityRowInsertTarget([{ shotId: 'S1', view: full }, { shotId: 'S2', view: { duration: 96, segments: [], markers: [] } }]), undefined);
    assert.equal(continuityRowInsertTarget([]), undefined);
});

test('closing a retained draft prioritizes resume over earlier disabled tracks, and otherwise restores its real trigger', () => {
    const active = { isConnected: true, matches: () => false, getClientRects: () => [{}] } as unknown as HTMLElement;
    const disabled = { ...active, matches: () => true } as unknown as HTMLElement;
    const detached = { ...active, isConnected: false } as unknown as HTMLElement;
    const hidden = { ...active, getClientRects: () => [] } as unknown as HTMLElement;
    const resume = {} as HTMLElement, track = {} as HTMLElement;
    const queries: string[] = [];
    const root = { querySelector: (selector: string) => { queries.push(selector); return selector.startsWith('[data-continuity-resume]') ? resume : track; } } as unknown as HTMLElement;
    assert.equal(continuityInlineReturnFocus(active, root), active);
    assert.equal(queries.length, 0);
    for (const trigger of [disabled, detached, hidden, null]) assert.equal(continuityInlineReturnFocus(trigger, root), resume);
    assert.ok(queries.every(selector => selector === '[data-continuity-resume]:not(:disabled)'));
    const noDraft = { querySelector: (selector: string) => selector.startsWith('[data-continuity-track]') ? track : null } as unknown as HTMLElement;
    assert.equal(continuityInlineReturnFocus(null, noDraft), track);
});
