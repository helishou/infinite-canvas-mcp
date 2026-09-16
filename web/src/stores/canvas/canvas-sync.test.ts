import assert from "node:assert/strict";
import test from "node:test";
import localforage from "localforage";

const cache = new Map<string, unknown>();
const writes: string[] = [];
localforage.createInstance = (() => ({
    setItem: async (key: string, value: unknown) => { writes.push(key); cache.set(key, value); return value; },
    removeItem: async (key: string) => { cache.delete(key); },
    iterate: async (visit: (value: unknown) => void) => { cache.forEach(visit); },
})) as unknown as typeof localforage.createInstance;
const { useCanvasStore, hydrateCanvasProjects, ensureCanvasProjectLoaded, applyBackendCanvasEvent, flushCanvasSyncNow } = await import("./use-canvas-store");
const { useBackendStore } = await import("../use-backend-store");

test("列表按需加载、重连保留未提交操作、冲突和远端删除可由用户决策", async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const project = { id: "p", title: "原名", createdAt: "2026-01-01", updatedAt: "2026-01-01", revision: 1, nodes: [{ id: "n", type: "text", title: "node", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "原内容" } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, globalPrompt: "", viewport: { x: 0, y: 0, k: 1 } };
    let remote = structuredClone(project);
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        const body = url.pathname === "/canvas/folders" ? { folders: [] }
            : url.pathname === "/canvas/projects" ? { projects: [{ ...remote, nodes: undefined, connections: undefined, nodeCount: 1, connectionCount: 0 }] }
            : { project: remote };
        return Response.json({ ok: true, ...body });
    }) as typeof fetch;
    try {
        useBackendStore.setState({ connected: true });
        await hydrateCanvasProjects();
        assert.equal(useCanvasStore.getState().projects[0].summary?.nodeCount, 1);
        assert.equal(requests.includes("/canvas/projects/p"), false);
        const loaded = await ensureCanvasProjectLoaded("p");
        assert.equal(loaded.summary, undefined);
        assert.equal(loaded.nodes.length, 1);
        assert.equal(requests.filter((path) => path === "/canvas/projects/p").length, 1);
        await ensureCanvasProjectLoaded("p");
        assert.equal(requests.filter((path) => path === "/canvas/projects/p").length, 1);

        useCanvasStore.getState().renameProject("p", "我的标题");
        remote = { ...remote, revision: 2, updatedAt: "2026-01-02", nodes: [{ ...remote.nodes[0], metadata: { content: "远端内容" } }] };
        await hydrateCanvasProjects();
        const merged = useCanvasStore.getState().projects[0];
        assert.equal(merged.title, "我的标题");
        assert.equal(merged.nodes[0].metadata?.content, "远端内容");

        useCanvasStore.getState().updateProject("p", { nodes: [{ ...merged.nodes[0], metadata: { content: "本地内容" } }] });
        remote = { ...remote, revision: 3, nodes: [{ ...remote.nodes[0], metadata: { content: "冲突内容" } }] };
        applyBackendCanvasEvent({ type: "canvas.updated", payload: remote });
        assert.ok(useCanvasStore.getState().canvasConflicts.p);
        assert.equal(useCanvasStore.getState().projects[0].nodes[0].metadata?.content, "本地内容");
        useCanvasStore.getState().adoptRemoteOnCanvasConflict("p");
        assert.equal(useCanvasStore.getState().projects[0].nodes[0].metadata?.content, "冲突内容");

        useCanvasStore.getState().renameProject("p", "删除前未保存的标题");
        applyBackendCanvasEvent({ type: "canvas.updated", entityId: "p", payload: { deleted: 1 } });
        assert.equal(useCanvasStore.getState().canvasConflicts.p.remoteDeleted, true);
        assert.equal(useCanvasStore.getState().projects.length, 1);
        useCanvasStore.getState().adoptRemoteOnCanvasConflict("p");
        assert.equal(useCanvasStore.getState().projects.length, 0);
        await flushCanvasSyncNow();
    } finally {
        useBackendStore.setState({ connected: false });
        globalThis.fetch = originalFetch;
    }
});

test("本地缓存按项目写入，编辑一个项目不会重写另一个项目", async () => {
    useBackendStore.setState({ connected: false });
    const first = useCanvasStore.getState().createProject("first");
    const second = useCanvasStore.getState().createProject("second");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(cache.has(first));
    assert.ok(cache.has(second));
    writes.length = 0;
    useCanvasStore.getState().renameProject(first, "edited");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(writes, [first]);
    useCanvasStore.getState().deleteProjects([first, second]);
});
