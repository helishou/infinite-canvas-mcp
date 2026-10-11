import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { patchSelectedSegment } from "../../../../plugins/canvas/minimax-h3/src/services/h3-segment-utils";
import { patchAllH3Clips } from "../../../../plugins/canvas/minimax-h3/src/services/h3-global-settings";
import { resolveH3Runtime } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { applyBackendCanvasDelta, diffCanvasProject, type CanvasProject } from "../../stores/canvas/use-canvas-store";

test("H3 control edit survives real diff, Backend save, receipt delta and refreshed read without changing other parameters", async (t) => {
    // Load the Node-only fixture at test runtime, outside the Web build graph.
    const fixturePath = "../../../../backend/src/db.ts";
    const { BackendDatabase } = await import(fixturePath);
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { segments: [
        { id: "a", start: 0, duration: 5, prompt: "first", motionContextEnabled: false },
        { id: "b", start: 5, duration: 5, prompt: "second", h3ParameterPolicy: "defaults", videoSteps: 99, motionContextEnabled: true },
    ] } }], connections: [] });
    const base = db.getCanvasProject("p") as unknown as CanvasProject;
    let optimistic = structuredClone(base);
    const ctx = {
        node: { id: "h3" }, getNode: () => optimistic.nodes[0],
        updateMetadata: (patch: Record<string, unknown>) => { optimistic = { ...optimistic, nodes: [{ ...optimistic.nodes[0], metadata: { ...optimistic.nodes[0].metadata, ...patch } }] }; },
    } as unknown as CanvasNodeContext;
    patchSelectedSegment(ctx, { selectedSegmentId: "b" }, { tailFrameContinuation: true });
    const operations = diffCanvasProject(base, optimistic);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].type, "update_h3_segment");
    assert.equal(operations[0].segmentId, "b");
    const fields = Object.keys(operations[0].patch as Record<string, unknown>);
    assert.deepEqual(new Set(fields), new Set(["tailFrameContinuation", "motionContextEnabled", "h3ParameterOverrides"]));
    const receipt = db.applyCanvasProjectOperations("p", Number(base.revision || 0), operations, { operationId: "edit-b" });
    const projected = applyBackendCanvasDelta(base, receipt.operations, receipt.revision);
    const refreshed = db.getCanvasProject("p") as unknown as CanvasProject;
    const stored = refreshed.nodes[0].metadata!.segments as Record<string, unknown>[];
    assert.deepEqual(projected.nodes[0].metadata!.segments, stored);
    assert.deepEqual(stored[0], base.nodes[0].metadata!.segments![0]);
    assert.equal(stored[1].motionContextEnabled, false);
    assert.equal(stored[1].tailFrameContinuation, true);
    assert.equal(stored[1].videoSteps, 99);
    assert.equal(stored[1].h3ParameterPolicy, "defaults");
    const effective = resolveH3Runtime(stored[1], {}, refreshed.nodes[0].metadata!, { videoSteps: 12 }).params;
    assert.equal(effective.steps, 12);
    assert.equal(effective.motionContextEnabled, stored[1].motionContextEnabled);
    assert.equal(db.applyCanvasProjectOperations("p", Number(base.revision || 0), operations, { operationId: "edit-b" }).revision, receipt.revision);
});

test("formal Clip continuation switches survive global editing, Backend delta and refreshed read", async (t) => {
    const fixturePath = "../../../../backend/src/db.ts";
    const { BackendDatabase } = await import(fixturePath);
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "formal", nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { segments: [
        { id: "a", start: 0, duration: 5, prompt: "first", tailFrameContinuation: false, motionContextEnabled: false, productionClipProjection: { targetId: "target-a", inputHash: "compiled-a" } },
        { id: "b", start: 5, duration: 5, prompt: "second", tailFrameContinuation: false, motionContextEnabled: false, productionClipProjection: { targetId: "target-b", inputHash: "compiled-b" } },
    ] } }], connections: [] });
    for (const [index, patch] of [{ tailFrameContinuation: true }, { tailFrameContinuation: false }, { motionContextEnabled: true }, { tailFrameContinuation: true }].entries()) {
        const base = db.getCanvasProject("formal") as unknown as CanvasProject;
        const metadata = base.nodes[0].metadata!;
        const update = patchAllH3Clips(metadata, metadata.segments as never, patch);
        const optimistic = { ...base, nodes: [{ ...base.nodes[0], metadata: { ...metadata, ...update } }] } as CanvasProject;
        const operations = diffCanvasProject(base, optimistic);
        for (const clip of update.segments) {
            const operation = operations.find(op => op.type === "update_h3_segment" && op.segmentId === clip.id);
            assert.ok(operation, `formal Clip ${clip.id} must emit its switch edit`);
            const field = Object.keys(patch)[0];
            assert.equal((operation.patch as Record<string, unknown>)[field], (patch as Record<string, unknown>)[field]);
        }
        const receipt = db.applyCanvasProjectOperations("formal", Number(base.revision || 0), operations, { operationId: `formal-global-${index}` });
        const refreshed = db.getCanvasProject("formal") as unknown as CanvasProject;
        const projected = applyBackendCanvasDelta(base, receipt.operations, receipt.revision);
        assert.deepEqual(projected.nodes[0].metadata, refreshed.nodes[0].metadata);
        const clips = refreshed.nodes[0].metadata!.segments as Record<string, unknown>[];
        for (const [clipIndex, clip] of clips.entries()) {
            assert.equal(clip.tailFrameContinuation, update.segments[clipIndex].tailFrameContinuation);
            assert.equal(clip.motionContextEnabled, update.segments[clipIndex].motionContextEnabled);
            assert.equal(clip.prompt, clipIndex ? "second" : "first");
            assert.deepEqual(clip.productionClipProjection, (metadata.segments as Record<string, unknown>[])[clipIndex].productionClipProjection);
        }
    }
});
