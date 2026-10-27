import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { continuityTrackPoint } from './continuity-workbench-interaction';
const sourceText = readFileSync(new URL('./continuity-timeline-workbench.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('workbench.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function handler(name: string, context: Record<string, any>): (...args: any[]) => any {
    let expression = '';
    function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && ts.isArrowFunction(node.initializer)) expression = node.initializer.getText(ast);
        ts.forEachChild(node, visit);
    }
    visit(ast); assert.ok(expression);
    const js = ts.transpileModule(`const extracted = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
    return new Function('context', `with(context) { ${js}; return extracted; }`)(context);
}
function harness() {
    const selected: any[] = [], drafts: any[] = [], points: any[] = [], writes: any[] = [];
    const c: any = { disabled: false, changeDraft: undefined, creating: false, creatingRef: { current: false }, confirmedDraft: { current: false }, triggerElement: { current: null },
        continuityTrackPoint, continuityBlocksForShot: () => [{ id: 'B' }], continuityDefaultEvidenceBlockId: (blocks: any[]) => blocks.length === 1 ? blocks[0].id : '', source: {}, sourceBlocks: [], fullShots: [{ id: 'S' }],
        viewFor: () => ({ duration: 96, segments: [{ start: 12, end: 36, value: 'closed' }, { start: 36, end: 60, value: 'open' }], markers: [{ frame: 36, event: { id: 'E' } }] }),
        select: (...value: any[]) => selected.push(value), setInlinePoint: (value: any) => points.push(value), onChangeDraft: (value: any) => drafts.push(value), setCreating: (value: boolean) => writes.push(value),
    };
    return { c, selected, drafts, points, writes };
}
test('the track opens the exact clicked state or existing event without writing any ledger row', () => {
    const { c, selected, drafts, points } = harness(); const trigger = {};
    const open = handler('openTrack', c);
    open('F', 'S', trigger, 18 / 96);
    assert.deepEqual(selected.at(-1), ['F', 'S', undefined, 18]);
    assert.deepEqual(points.at(-1), { factId: 'F', shotId: 'S', frame: 18 });
    open('F', 'S', trigger, 36 / 96);
    assert.deepEqual(selected.at(-1), ['F', 'S', 'E', 36]);
    open('F', 'S', trigger, 8 / 96);
    assert.equal(selected.length, 2); assert.equal(drafts.length, 0); assert.equal(c.triggerElement.current, trigger);
});
test('inline create preselects unambiguous script evidence for the user to confirm, without inventing after-state or reason', () => {
    const { c, selected, drafts } = harness();
    handler('beginInlineChange', c)('F', 'S', 18);
    assert.deepEqual(selected, [['F', 'S', undefined, 18]]);
    assert.deepEqual(drafts, [{ factId: 'F', shotId: 'S', frame: '18', after: '', reason: '', sourceBlockId: 'B' }]);
});
test('disabled, absent and out-of-presence targets cannot start a change; another target cannot steal an unfinished form', () => {
    for (const patch of [{ disabled: true }, { creating: true }, { changeDraft: { shotId: 'original', reason: 'Keep me' } }, { viewFor: () => undefined }]) {
        const { c, selected, drafts } = harness(); Object.assign(c, patch);
        handler('beginInlineChange', c)('F', 'S', 18);
        assert.equal(selected.length, 0); assert.equal(drafts.length, 0);
    }
    const { c, selected, drafts } = harness();
    handler('beginInlineChange', c)('F', 'S', 60);
    assert.equal(drafts.length, 0);
    c.changeDraft = { shotId: 'original', reason: 'Keep me' };
    handler('openTrack', c)('OTHER', 'OTHER', {}, .5);
    assert.equal(selected.length, 0); assert.equal(c.changeDraft.reason, 'Keep me');
});
test('editing an event preserves authored before-state, ownership, evidence and the other collections', () => {
    const { c } = harness();
    const original = { events: [{ id: 'E', before: 'closed', after: 'open', timeline_id: 'T', shot_id: 'S', fact_id: 'F', source_anchor: { block_id: 'B' } }, { id: 'other' }], coverage: [{ source_digest: 'stale' }], requirements: [{ id: 'R' }], facts: [{ id: 'F' }], initial: [{ value: 'closed' }], timelines: [{ id: 'T' }] };
    c.event = original.events[0]; let next: any;
    c.records = (value: any) => value || [];
    c.actions = { update: (update: any) => { next = update(original); } };
    handler('updateEvent', c)({ local_frame: 50, after: 'unknown' });
    assert.deepEqual(next.events[0], { ...original.events[0], local_frame: 50, after: 'unknown' });
    for (const collection of ['coverage', 'requirements', 'facts', 'initial', 'timelines']) assert.equal(next[collection], original[collection as keyof typeof original]);
    assert.equal(next.events[1], original.events[1]);
    next = undefined; c.disabled = true; handler('updateEvent', c)({ after: 'open' }); assert.equal(next, undefined);
});
test('repeated confirmation uses one existing atomic creator and retains input after rejection', async () => {
    const { c, drafts, selected } = harness(); c.changeDraft = { factId: 'F', shotId: 'S', frame: '18', after: 'open', reason: 'Documented change', sourceBlockId: 'B' };
    let resolve!: (id?: string) => void, calls = 0;
    c.actions = { createEvent: () => { calls++; return new Promise<string | undefined>(done => { resolve = done; }); } };
    const submit = handler('submitChange', c), first = submit(), second = submit();
    assert.equal(calls, 1); resolve(undefined); await Promise.all([first, second]);
    assert.equal(drafts.length, 0); assert.equal(c.creatingRef.current, false);
    const retry = submit(); resolve('new-E'); await retry;
    assert.deepEqual(selected.at(-1), ['F', 'S', 'new-E', 18]); assert.deepEqual(drafts, [undefined]);
});
test('direct editor shares the original fields, guarded delete and parent draft, with one global save', () => {
    assert.match(sourceText, /renderEditor\(true\)/);
    assert.match(sourceText, /inlineOpen \? [\s\S]* : renderEditor\(false\)/);
    assert.match(sourceText, /onClick=\{deleteSelectedEvent\}/);
    assert.match(sourceText, /data-continuity-resume/);
    assert.doesNotMatch(sourceText, /<Button[^\n]*data-continuity-save-action/);
    assert.match(sourceText, /!inline && <details[^\n]*editTimelineInitial/);
    const close = handler('closeInline', { setInlinePoint: () => undefined, requestAnimationFrame: () => undefined });
    close(false); // Closing cannot call onChangeDraft or write the ledger.
});

test('deleting a switched or repositioned event keeps the resulting state card at that exact frame', () => {
    const { c, selected, points } = harness(); let removed: any;
    c.event = { id: 'switched' }; c.selected = { fact: { id: 'F' }, shot: { id: 'S' } };
    c.eventFrame = 50; c.selectedFrame = 18; c.actions = { deleteEvent: (value: any) => { removed = value; } };
    handler('deleteSelectedEvent', c)();
    assert.deepEqual(selected.at(-1), ['F', 'S', 'switched', 50]);
    assert.deepEqual(points.at(-1)({ factId: 'F', shotId: 'S', frame: 18 }), { factId: 'F', shotId: 'S', frame: 50 });
    assert.equal(removed, c.event);
    assert.match(sourceText, /onChange=\{eventId => selectMarker/);
});

test('growing on-track forms use the overlay alignment API, viewport-bound height and their own body scroll', () => {
    assert.match(sourceText, /placement="right" align=\{\{ offset: \[0, 0\] \}\} autoAdjustOverflow/);
    assert.match(sourceText, /requestAnimationFrame\(\(\) => inlinePopover\.current\?\.forceAlign\(\)\)/);
    assert.match(sourceText, /\[inlineOpen, Boolean\(changeDraft\), event\?\.id\]/);
    assert.match(sourceText, /continuityInlineReturnFocus\(triggerElement\.current, workbenchRoot\.current\)/);
    const styles = readFileSync(new URL('./continuity-timeline.css', import.meta.url), 'utf8');
    assert.match(styles, /max-height:min\(480px,calc\(100dvh - 64px\)\)/);
    assert.match(styles, /continuity-inline-body\{flex:1;min-height:0;overflow:auto/);
    assert.match(styles, /continuity-inline-editor>header\{[^}]*flex-shrink:0/);
    assert.match(styles, /continuity-inline-editor>footer\{flex-shrink:0/);
});
