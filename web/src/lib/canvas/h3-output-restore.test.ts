import assert from "node:assert/strict";
import test from "node:test";
import { requestFormalH3OutputSelection } from "./h3-output-restore";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";

test("formal H3 output uses the existing history selection event and retains Clip inputs", (t) => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousState = useProductionWorkspaceStore.getState();
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { value: events, configurable: true });
    t.after(() => {
        if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
        useProductionWorkspaceStore.setState(previousState);
    });
    const node = { id: "h3", metadata: { segments: [{ id: "a", prompt: "current", productionClipProjection: { targetId: "SEG1" } }] } } as never;
    useProductionWorkspaceStore.setState({
        context: { role: "episode", canvasId: "canvas", owner: { kind: "episode", id: "episode" } },
        production: { draft: { director: { assets: {} }, clipGroups: [{ id: "SEG1", nodeId: "h3", segmentId: "a" }], keyframes: {}, shots: [] } } as never,
    });
    const captured: Array<Record<string, any>> = [];
    events.addEventListener("production-node-action", event => captured.push((event as CustomEvent).detail));
    const input = { nodeId: "h3", segmentId: "a", generationLogId: "log", storageKey: "video:old", settings: { prompt: "historical" } };
    assert.equal(requestFormalH3OutputSelection("canvas", node, input), true);
    assert.equal(captured[0].action, "select-result");
    assert.equal(captured[0].object.targetId, "SEG1");
    assert.equal(captured[0].object.segmentId, "a");
    assert.equal(captured[0].history.generationLogId, "log");
    assert.equal(captured[0].history.storageKey, "video:old");
    assert.equal(Object.hasOwn(captured[0], "settings"), false);
    assert.equal((node as any).metadata.segments[0].prompt, "current");
    assert.throws(() => requestFormalH3OutputSelection("canvas", node, { ...input, storageKey: undefined }));
    assert.throws(() => requestFormalH3OutputSelection("other-canvas", node, input));
    assert.throws(() => requestFormalH3OutputSelection("canvas", node, { ...input, segmentId: "missing" }));
    const ordinary = { id: "ordinary", metadata: { segments: [{ id: "a" }] } } as never;
    assert.equal(requestFormalH3OutputSelection("canvas", ordinary, { ...input, nodeId: "ordinary" }), false);
    assert.equal(captured.length, 1);
});
