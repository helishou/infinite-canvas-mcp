import assert from "node:assert/strict";
import test from "node:test";
import { useProductionWorkspaceStore } from "./use-production-workspace-store";
test("same-canvas owner refresh preserves a loaded production snapshot and editor state", () => {
    const store = useProductionWorkspaceStore;
    store.getState().setContext(null);
    const context: any = { role: "episode", canvasId: "canvas", owner: { kind: "episode", id: "episode" } };
    const production: any = { revision: 3, draft: { director: { source: { brief: "source" } } } };
    const readiness: any = { targets: [] };
    store.getState().setContext(context); store.getState().setSnapshot("episode", production, readiness); store.getState().setCommandBusy("episode", true);
    store.getState().setContext({ ...context, owner: { ...context.owner } });
    assert.equal(store.getState().production, production); assert.equal(store.getState().readiness, readiness); assert.equal(store.getState().commandBusy, true);
    store.getState().setContext({ ...context, canvasId: "other" });
    assert.equal(store.getState().production, null); assert.equal(store.getState().commandBusy, false);
    store.getState().setSnapshot("episode", production, readiness); store.getState().setContext(null); assert.equal(store.getState().production, null);
});
