import assert from "node:assert/strict";
import test from "node:test";
import { createProductionEditing, registerProductionPromptEditor, sourceSegmentForCanvasClip } from "./production-editing";
import type { CanvasNodeData } from "@/types/canvas";
const input = { nodeId: "H3", segmentId: "canvas-clip", prompt: "A changed action.", artifactId: "ART", sourceHash: "source", basePromptHash: "prompt" };
const node = (): CanvasNodeData => ({ id: "H3", type: "minimax-h3:video", title: "H3", position: { x: 0, y: 0 }, width: 500, height: 400,
    metadata: { segments: [{ id: "canvas-clip", productionClipProjection: { promptAssemblyVersion: 2, artifactId: "ART", sourceHash: "source", promptHash: "prompt" } }] } });
test("SDK reverse synchronization awaits canvas persistence and receives an explicit editor receipt", async () => {
    const order: string[] = [], current = node();
    const remove = registerProductionPromptEditor("canvas", async request => { order.push("edit"); assert.deepEqual(request, input); return { sourceSaved: true }; });
    try {
        const service = createProductionEditing("canvas", () => current, async () => { order.push("flush"); });
        assert.deepEqual(await service.reverseSyncPrompt(input), { sourceSaved: true });
        assert.deepEqual(order, ["flush", "edit"]);
    } finally { remove(); }
});
test("missing editors and changed compiled identities fail visibly without a source write", async () => {
    const current = node(), service = createProductionEditing("missing", () => current, async () => {});
    await assert.rejects(service.reverseSyncPrompt(input), /PRODUCTION_EDITOR_NOT_READY/);
    await assert.rejects(service.reverseSyncPrompt({ ...input, basePromptHash: "stale" }), /PROMPT_REVERSE_SYNC_BASELINE_MISMATCH/);
});
test("an old editor cleanup cannot unregister a newer owner binding", async () => {
    const older = registerProductionPromptEditor("replacement", async () => ({ sourceSaved: false }));
    const newer = registerProductionPromptEditor("replacement", async () => ({ sourceSaved: true }));
    older();
    try { assert.equal((await createProductionEditing("replacement", () => node(), async () => {}).reverseSyncPrompt(input)).sourceSaved, true); }
    finally { newer(); }
});
test("canvas node and physical Clip identity resolve to the authoritative source Segment ID", () => {
    assert.equal(sourceSegmentForCanvasClip([{ id: "SOURCE_C4", nodeId: "H3", segmentId: "canvas-clip" }], "H3", "canvas-clip"), "SOURCE_C4");
    assert.throws(() => sourceSegmentForCanvasClip([{ id: "SOURCE_C4", nodeId: "OTHER", segmentId: "canvas-clip" }], "H3", "canvas-clip"), /TARGET_MISMATCH/);
});
