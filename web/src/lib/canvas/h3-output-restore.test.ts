import assert from "node:assert/strict";
import test from "node:test";
import { requestFormalH3OutputSelection } from "./h3-output-restore";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

test("formal H3 output uses the existing history selection event and retains Clip inputs", async (t) => {
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
    events.addEventListener("production-node-action", event => { event.preventDefault(); captured.push((event as CustomEvent).detail); });
    const input = { nodeId: "h3", segmentId: "a", generationLogId: "log", storageKey: "video:old", settings: { prompt: "historical" } };
    assert.equal(await requestFormalH3OutputSelection("canvas", node, input), true);
    assert.equal(captured[0].action, "select-result");
    assert.equal(captured[0].object.targetId, "SEG1");
    assert.equal(captured[0].object.segmentId, "a");
    assert.equal(captured[0].history.generationLogId, "log");
    assert.equal(captured[0].history.storageKey, "video:old");
    assert.equal(Object.hasOwn(captured[0], "settings"), false);
    assert.equal((node as any).metadata.segments[0].prompt, "current");
    await assert.rejects(requestFormalH3OutputSelection("canvas", node, { ...input, storageKey: undefined }));
    await assert.rejects(requestFormalH3OutputSelection("other-canvas", node, input));
    await assert.rejects(requestFormalH3OutputSelection("canvas", node, { ...input, segmentId: "missing" }));
    const ordinary = { id: "ordinary", metadata: { segments: [{ id: "a" }] } } as never;
    assert.equal(await requestFormalH3OutputSelection("canvas", ordinary, { ...input, nodeId: "ordinary" }), false);
    assert.equal(captured.length, 1);
});

test("formal H3 output selected from the canvas resolves its production owner and commits the reviewed result", async (t) => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousFetch = globalThis.fetch;
    const previousSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const previousProductionState = useProductionWorkspaceStore.getState();
    const previousCanvasState = useCanvasStore.getState();
    const values = new Map<string, string>();
    const storage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear() };
    const events = new EventTarget() as EventTarget & { location: Record<string, string>; localStorage: typeof storage };
    events.location = { protocol: "http:", hostname: "localhost", port: "", origin: "http://localhost", href: "http://localhost/" };
    events.localStorage = storage;
    Object.defineProperty(globalThis, "window", { value: events, configurable: true });
    Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    useProductionWorkspaceStore.setState({ context: null, production: null });
    const node = { id: "h3", type: "minimax-h3:video", title: "Clip", metadata: { segments: [{ id: "a", productionClipProjection: { targetId: "SEG1" } }] } };
    const project = (revision: number) => ({ id: "canvas", title: "fixture", revision, createdAt: "", updatedAt: "", nodes: [node], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, globalPrompt: "", viewport: { x: 0, y: 0, k: 1 } });
    const production = { episodeId: "episode", revision: 4, draft: { director: { assets: {} }, clipGroups: [{ id: "SEG1", nodeId: "h3", segmentId: "a" }], keyframes: {}, shots: [] } };
    const operations: Array<Record<string, any>> = [];
    let projectReads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/canvas/projects/canvas/production-context") return Response.json({ ok: true, context: { role: "episode", canvasId: "canvas", owner: { kind: "episode", id: "episode" } } });
        if (url.pathname === "/drama/episodes/episode/production" && init?.method === "GET") return Response.json({ ok: true, production });
        if (url.pathname === "/canvas/projects/canvas" && init?.method === "GET") return Response.json({ ok: true, project: project(++projectReads > 1 ? 6 : 5) });
        if (url.pathname === "/drama/episodes/episode/production/ops" && init?.method === "POST") {
            const body = JSON.parse(String(init.body || "{}")); operations.push(...body.ops);
            return Response.json({ ok: true, production: { ...production, revision: 5 } });
        }
        throw new Error(`Unexpected Backend request: ${init?.method || "GET"} ${url.pathname}`);
    }) as typeof fetch;
    t.after(async () => {
        await new Promise(resolve => setTimeout(resolve, 280));
        if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
        if (previousSessionStorage) Object.defineProperty(globalThis, "sessionStorage", previousSessionStorage); else Reflect.deleteProperty(globalThis, "sessionStorage");
        if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage); else Reflect.deleteProperty(globalThis, "localStorage");
        globalThis.fetch = previousFetch;
        useProductionWorkspaceStore.setState(previousProductionState);
        useCanvasStore.setState(previousCanvasState);
    });
    const input = { nodeId: "h3", segmentId: "a", generationLogId: "log", storageKey: "video:old", settings: {} };
    assert.equal(await requestFormalH3OutputSelection("canvas", node as never, input), true);
    assert.equal(operations.length, 1);
    assert.deepEqual(operations[0], { type: "select_director_result", targetKind: "segment", targetId: "SEG1", nodeId: "h3", generationLogId: "log", storageKey: "video:old", canvasRevision: 5 });
});
