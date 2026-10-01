import assert from "node:assert/strict";
import test from "node:test";
import { pluginMcp } from "./mcp.js";

function fixture() {
    const project: any = { id: "prepared-project", revision: 4, nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { segments: Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, prompt: "😀 Stable prose. ".repeat(200) + "hidden jade", duration: 8, taskMode: "t2va", status: "idle", continuityOut: "hidden jade", timeline: [{ start: 0, end: 8, action: "Lift sleeve", camera: "Fixed" }] })) } }], connections: [] };
    let source: any = { formatVersion: 1, projectId: project.id, nodeId: "h3", expectedRevision: 4, items: project.nodes[0].metadata.segments.slice(0, 2).map((s: any) => ({ segmentId: s.id, before: { prompt: s.prompt, continuityOut: s.continuityOut }, update: { segmentId: s.id, patch: { prompt: s.prompt.replace("hidden jade", "visible sleeve"), continuityOut: "visible sleeve" } } })) };
    const plans = new Map<string, any>();
    const calls: any[] = [];
    const receipts = new Map<string, any>();
    const backend: any = { preparedH3Updates: {
        readSource: async () => ({ value: structuredClone(source), bytes: JSON.stringify(source).length, sha256: "a".repeat(64) }),
        save: async (plan: any) => { const id = `test-plan-${plans.size}`; plans.set(id, structuredClone(plan)); return id; },
        read: async (id: string) => { if (!plans.has(id)) throw new Error("unknown preparedId"); return structuredClone(plans.get(id)); },
        discard: async (id: string) => { plans.delete(id); },
    }, applyCanvasOperations: async (_id: string, operations: any[], rev: number, opId: string, strict: boolean) => {
        assert.equal(strict, true);
        if (receipts.has(opId)) return structuredClone(receipts.get(opId));
        assert.equal(rev, project.revision);
        calls.push(structuredClone(operations));
        for (const op of operations) if (op.type === "update_h3_segment") Object.assign(project.nodes[0].metadata.segments.find((s: any) => s.id === op.segmentId), op.patch);
        project.revision++;
        const result = { project: structuredClone(project), revision: project.revision };
        receipts.set(opId, result); return result;
    } };
    const context: any = { backend, getCanvasProject: async () => structuredClone(project) };
    const handlers = pluginMcp.createHandler(context);
    assert.equal(typeof handlers.h3_prepare_clip_updates, "function", "native file preparation handler must exist");
    const prepare = () => handlers.h3_prepare_clip_updates!({ projectId: project.id, nodeId: "h3", filePath: "isolated.json", fileSha256: "a".repeat(64) }, context);
    const apply = (id: string, extra: any = {}) => handlers.h3_update_clips!({ projectId: project.id, nodeId: "h3", preparedId: id, ...extra }, context);
    return { project, source, plans, calls, handlers, context, prepare, apply };
}

test("file plan freezes two targets, previews without writes and commits by short handle once", async () => {
    const f = fixture(), before = structuredClone(f.project);
    const prepared: any = await f.prepare();
    assert.equal(prepared.count, 2);
    assert.equal(prepared.applied, false);
    assert.equal(f.calls.length, 0);
    assert.equal(prepared.revision, 4);
    assert.ok(prepared.preparedId);
    assert.equal(prepared.selection[0].fields.prompt, "edits");
    assert.equal(prepared.selection[0].fields.continuityOut, "patch");
    assert.ok(JSON.stringify(prepared).length < 6000);
    f.source.items[0].update.patch.prompt = "changed after preparation";
    const preview: any = await f.apply(prepared.preparedId, { dryRun: true });
    assert.equal(preview.applied, false);
    assert.deepEqual(f.project, before);
    const receipt: any = await f.apply(prepared.preparedId);
    assert.equal(receipt.count, 2);
    assert.equal(receipt.revision, 5);
    assert.equal(f.calls.length, 1);
    assert.equal(f.project.nodes[0].metadata.segments[0].prompt, before.nodes[0].metadata.segments[0].prompt.replace("hidden jade", "visible sleeve"));
    assert.deepEqual(f.project.nodes[0].metadata.segments[2], before.nodes[0].metadata.segments[2]);
    const replay: any = await f.apply(prepared.preparedId);
    assert.equal(replay.revision, 5);
    assert.equal(f.calls.length, 1);
    assert.equal(replay.operationId, receipt.operationId);
});

test("file preparation rejects stale before fields and forbidden runtime writes before freezing", async () => {
    const f = fixture();
    f.source.items[1].before.prompt = "stale";
    await assert.rejects(f.prepare(), /基线|before/);
    assert.equal(f.plans.size, 0);
    f.source.items[1].before.prompt = f.project.nodes[0].metadata.segments[1].prompt;
    f.source.items[1].update.patch.status = "queued";
    await assert.rejects(f.prepare(), /禁止|基线/);
    assert.equal(f.plans.size, 0);
    assert.equal(f.calls.length, 0);
});

test("prepared handle cannot override its target, revision or updates", async () => {
    const f = fixture(), plan: any = await f.prepare();
    await assert.rejects(f.apply(plan.preparedId, { updates: [{ segmentId: "s0", patch: { title: "bad" } }] }), /preparedId|互斥/);
    await assert.rejects(f.apply(plan.preparedId, { expectedRevision: 99 }), /revision|版本/);
    await assert.rejects(f.handlers.h3_update_clips!({ projectId: f.project.id, nodeId: "other", preparedId: plan.preparedId }, f.context), /目标|nodeId/);
    assert.equal(f.calls.length, 0);
});

test("preview refuses a newer revision and never silently rebases an immutable plan", async () => {
    const f = fixture(), plan: any = await f.prepare();
    f.project.revision++;
    await assert.rejects(f.apply(plan.preparedId, { dryRun: true }), /版本|revision/);
    assert.equal(f.calls.length, 0);
});

test("explicit discard removes only the requested plan", async () => {
    const f = fixture(), p: any = await f.prepare(), q: any = await f.prepare();
    await f.handlers.h3_discard_clip_updates!({ projectId: f.project.id, nodeId: "h3", preparedId: p.preparedId }, f.context);
    await assert.rejects(f.apply(p.preparedId), /unknown/);
    assert.ok(f.plans.has(q.preparedId));
    assert.equal(f.calls.length, 0);
});

test("default file contract protects spoken dialogue and timeline boundaries", async () => {
    const f = fixture();
    f.source.items[0].update.patch.prompt += "<d>unapproved dialogue</d>";
    await assert.rejects(f.prepare(), /对白/);
    assert.equal(f.plans.size, 0);
    f.source.items[0].update.patch.prompt = f.source.items[0].before.prompt.replace("hidden jade", "visible sleeve");
    f.source.items[0].before.timeline = f.project.nodes[0].metadata.segments[0].timeline;
    f.source.items[0].update.patch.timeline = [{ start: 0, end: 7, action: "Lift sleeve", camera: "Fixed" }];
    await assert.rejects(f.prepare(), /时间码|timing/);
    assert.equal(f.calls.length, 0);
});
