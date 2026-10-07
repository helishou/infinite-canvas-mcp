import assert from "node:assert/strict";
import test from "node:test";
import { CanvasH3Runner } from "./h3-runner.js";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { BackendEventBus } from "../events.js";

function plans(segments: Record<string, unknown>[], defaults: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
    const runner = new CanvasH3Runner({ settings: { get: () => defaults } } as never, {} as never, {} as never, {} as never);
    return (runner as unknown as { planNode(node: unknown, input: unknown): Array<{ segmentId: string; continuation?: { index: number } }> }).planNode(
        { id: "h3", metadata: { segments } },
        { projectId: "p", segmentId: "b", ...options },
    );
}

test("saved tail-frame selection prevents Clip 8 from seeking a latent resume task", () => {
    const segments = [
        ...Array.from({ length: 6 }, (_, i) => ({ id: `clip-${i}`, motionContextEnabled: false })),
        { id: "a", tailFrameContinuation: true, motionContextEnabled: false, result: "previous.mp4" },
        { id: "b", motionContextEnabled: false },
    ];
    assert.equal(plans(segments)[0].continuation, undefined);
    assert.equal(plans(segments, {}, { runFromCurrent: true, skipCompleted: true })[0].continuation, undefined);
});

test("explicit false blocks inherited motion while inherited true keeps a real continuation", () => {
    assert.equal(plans([{ id: "a", motionContextEnabled: false }, { id: "b" }], { motionContextEnabled: true })[0].continuation, undefined);
    assert.equal(plans([{ id: "a" }, { id: "b" }], { motionContextEnabled: true })[0].continuation?.index, 2);
});

test("tail-frame boundary splits groups instead of propagating legacy latent flags", () => {
    const result = plans([
        { id: "b", tailFrameContinuation: true, motionContextEnabled: false },
        { id: "c", motionContextEnabled: true },
        { id: "d", motionContextEnabled: false },
    ], {}, { runFromCurrent: true });
    assert.deepEqual(result.map(plan => plan.continuation?.index), [undefined, 1, 2]);
});

test("conflicting saved continuation values require a real edit", () => {
    assert.throws(() => plans([{ id: 'a', tailFrameContinuation: true, motionContextEnabled: true }, { id: 'b' }]), /保存值同时开启/);
});

test("preview detects the same missing predecessor latent task as submission, then clears after a saved disable", (t) => {
    const db = new BackendDatabase(':memory:');
    t.after(() => db.close());
    db.createCanvasProject({ id: 'p', nodes: [{ id: 'h3', type: 'minimax-h3:video', metadata: { segments: [
        { id: 'a', mode: 't2v', duration: 5, prompt: 'A bell.', tailFrameContinuation: false, motionContextEnabled: true, result: 'saved.mp4', resultStorageKey: 'video:previous' },
        { id: 'b', mode: 't2v', duration: 5, prompt: 'Another bell.', tailFrameContinuation: false, motionContextEnabled: false },
    ] } }], connections: [] });
    const stores = createStores(db);
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), {} as never, {} as never);
    const input = { projectId: 'p', nodeId: 'h3', segmentId: 'b' };
    const before = runner.preview(input);
    assert.equal(before.ready, false);
    assert.ok(before.diagnostics.some(issue => issue.code === 'H3_LATENT_RESUME_UNAVAILABLE' && issue.message.includes('找不到与上一段当前成片匹配')));
    assert.equal(stores.tasks.list({}).length, 0);
    stores.projects.applyOperations('p', undefined, [{ type: 'update_h3_segment', nodeId: 'h3', segmentId: 'a', patch: { motionContextEnabled: false } }]);
    const after = runner.preview(input);
    assert.equal(after.ready, true, JSON.stringify(after.diagnostics));
    assert.equal(stores.tasks.list({}).length, 0);
});

test("Backend transaction saves both continuation switches, broadcasts both and replays once", (t) => {
    const db = new BackendDatabase(':memory:');
    t.after(() => db.close());
    db.createCanvasProject({ id: 'p', nodes: [{ id: 'h3', type: 'minimax-h3:video', metadata: { segments: [{ id: 'a', tailFrameContinuation: true, motionContextEnabled: false, prompt: 'Original', result: 'saved.mp4', status: 'success' }] } }], connections: [] });
    const read = () => (db.getCanvasProject('p')!.nodes[0].metadata as { segments: Record<string, unknown>[] }).segments[0];
    for (const key of ['motionContextEnabled', 'tailFrameContinuation']) {
        const other = key === 'motionContextEnabled' ? 'tailFrameContinuation' : 'motionContextEnabled';
        const ops = [{ type: 'update_h3_segment', nodeId: 'h3', segmentId: 'a', patch: { [key]: true } }];
        const result = db.applyCanvasProjectOperations('p', undefined, ops, { operationId: `switch-${key}` });
        assert.equal(read()[key], true);
        assert.equal(read()[other], false);
        assert.equal(read().prompt, 'Original');
        assert.equal(read().result, 'saved.mp4');
        const delta = result.operations.find(op => op.type === 'update_h3_segment')!;
        assert.equal((delta.patch as Record<string, unknown>)[other], false);
        assert.equal(db.applyCanvasProjectOperations('p', undefined, ops, { operationId: `switch-${key}` }).revision, result.revision);
    }
});
