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

test("global defaults do not create motion groups; explicit outgoing Clip choices do", () => {
    assert.equal(plans([{ id: "a", motionContextEnabled: false }, { id: "b" }], { motionContextEnabled: true })[0].continuation, undefined);
    assert.equal(plans([{ id: "a" }, { id: "b" }], { motionContextEnabled: true })[0].continuation, undefined);
    assert.equal(plans([{ id: "a", motionContextEnabled: true }, { id: "b" }], {})[0].continuation?.index, 2);
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

test("generate current at a Motion Context group head runs only its complete group", () => {
    const segments = [
        { id: "before", motionContextEnabled: false },
        { id: "b", motionContextEnabled: true, result: "old-b.mp4" },
        { id: "c", motionContextEnabled: true, result: "old-c.mp4" },
        { id: "d", motionContextEnabled: false, result: "old-d.mp4" },
        { id: "other", motionContextEnabled: true },
        { id: "last", motionContextEnabled: false },
    ];
    const result = plans(segments, {}, { runFromCurrent: false });
    assert.deepEqual(result.map(plan => plan.segmentId), ["b", "c", "d"]);
    assert.deepEqual(result.map(plan => plan.continuation?.index), [1, 2, 3]);
    assert.throws(() => plans(segments, {}, { skipCompleted: true }), /不能跳过已完成/);
    assert.deepEqual(plans(segments, {}, { runFromCurrent: true }).map(plan => plan.segmentId), ["b", "c", "d", "other", "last"]);
    assert.deepEqual(plans(segments, {}, { segmentId: "c" }).map(plan => plan.segmentId), ["c"]);
    assert.deepEqual(plans(segments, {}, { segmentId: "d" }).map(plan => plan.segmentId), ["d"]);
    assert.deepEqual(plans(segments, {}, { endSegmentId: "c" }).map(plan => plan.segmentId), ["b", "c"]);
});

test("automatic groups require explicit edges, and a terminal outgoing switch has no effect", () => {
    assert.deepEqual(plans([{ id: "b" }, { id: "c" }, { id: "d" }], { motionContextEnabled: true }).map(plan => plan.continuation), [undefined]);
    assert.deepEqual(plans([{ id: "b", motionContextEnabled: true }, { id: "c", motionContextEnabled: true }, { id: "d", motionContextEnabled: true }]).map(plan => plan.continuation?.index), [1, 2, 3]);
    assert.deepEqual(plans([{ id: "b", motionContextEnabled: false }, { id: "c" }], { motionContextEnabled: true }).map(plan => plan.segmentId), ["b"]);
    assert.deepEqual(plans([{ id: "b", motionContextEnabled: true }]).map(plan => plan.continuation), [undefined]);
});

test("single-Clip command executes the group sequentially in one parent and regenerates old results", async (t) => {
    const db = new BackendDatabase(':memory:');
    t.after(() => db.close());
    db.createCanvasProject({ id: 'auto-group', nodes: [{ id: 'h3', type: 'minimax-h3:video', metadata: { segments: [
        { id: 'a', mode: 't2v', prompt: 'A', motionContextEnabled: true, result: 'old-a.mp4' },
        { id: 'b', mode: 't2v', prompt: 'B', motionContextEnabled: true, result: 'old-b.mp4' },
        { id: 'c', mode: 't2v', prompt: 'C', motionContextEnabled: false },
        { id: 'outside', mode: 't2v', prompt: 'Outside', motionContextEnabled: false },
    ] } }], connections: [] });
    const stores = createStores(db);
    const submissions: Array<{ segmentId: unknown; run: string; index: number; group: string }> = [];
    const comfy = {
        async run(_preset: string, input: Record<string, unknown>, params: Record<string, unknown>, _url?: string, id?: string, onCreated?: (task: ReturnType<typeof stores.tasks.create>) => void) {
            const child = stores.tasks.create(id!, 'comfyui:minimax-h3', input, params);
            onCreated?.(child);
            submissions.push({ segmentId: (params.canvasBinding as Record<string, unknown>).segmentId, ...JSON.parse(String(params.continuationTask)) });
            const media = stores.media.store(Buffer.from('fake-video'), { name: `${child.id}.mp4`, mimeType: 'video/mp4', category: 'output' });
            return stores.tasks.update(child.id, { status: 'succeeded', progress: 1, result: { media: [{ url: stores.media.url(media), storageKey: media.storageKey, mimeType: 'video/mp4' }] } });
        },
    };
    const hub = { ready: () => false, queue: { select: () => 'local', unreserve() {} } };
    const runner = new CanvasH3Runner(stores, new BackendEventBus(), comfy as never, hub as never);
    for (const id of ['auto-first', 'auto-again']) {
        const input = { projectId: 'auto-group', nodeId: 'h3', segmentId: 'a', runFromCurrent: false };
        assert.deepEqual(runner.preview(input).clips.map(clip => clip.segmentId), ['a', 'b', 'c']);
        runner.start(input, id);
        for (let i = 0; i < 200 && !['succeeded', 'failed'].includes(stores.tasks.get(id)?.status || ''); i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(stores.tasks.get(id)?.status, 'succeeded', stores.tasks.get(id)?.error || 'group did not finish');
        assert.deepEqual(submissions.filter(item => item.run === id).map(item => [item.segmentId, item.index]), [['a', 1], ['b', 2], ['c', 3]]);
    }
    const clips = (db.getCanvasProject('auto-group')!.nodes[0].metadata as { segments: Record<string, unknown>[] }).segments;
    assert.deepEqual(clips.slice(0, 3).map(clip => clip.status), ['success', 'success', 'success']);
    assert.equal(clips[3].result, undefined);
    assert.equal(submissions.length, 6);
    assert.equal(new Set(submissions.map(item => item.group)).size, 1);
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
