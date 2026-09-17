import assert from "node:assert/strict";
import test from "node:test";
import localforage from "localforage";

const cache = new Map<string, unknown>();
const writes: string[] = [];
let failCacheWrites = false;
const buckets = new Map<string, Map<string, unknown>>([["infinite-canvas-project-cache", cache]]);
localforage.createInstance = ((options: { name: string }) => {
    const bucket = buckets.get(options.name) || new Map<string, unknown>();
    buckets.set(options.name, bucket);
    return {
        getItem: async (key: string) => bucket.get(key) ?? null,
        setItem: async (key: string, value: unknown) => { if (bucket === cache) { if (failCacheWrites) throw new Error("测试缓存写入失败"); writes.push(key); } bucket.set(key, structuredClone(value)); return value; },
        removeItem: async (key: string) => { bucket.delete(key); },
        iterate: async (visit: (value: unknown, key: string) => void) => { bucket.forEach(visit); },
    };
}) as unknown as typeof localforage.createInstance;
const { useCanvasStore, hydrateCanvasProjects, ensureCanvasProjectLoaded, applyBackendCanvasEvent, flushCanvasSyncNow, diffCanvasProject } = await import("./use-canvas-store");
const { useBackendStore } = await import("../use-backend-store");
const { getBackendUrl, getCanvasDraftSessionId } = await import("../../services/backend-api");
const cacheKey = (id: string) => JSON.stringify([getBackendUrl(), getCanvasDraftSessionId(), id]);

test("普通生成节点运行中只提交用户字段，不夹带 Backend 瞬态状态", () => {
    const base = { id: "task-fields", title: "画布", createdAt: "", updatedAt: "", revision: 1, nodes: [{ id: "image", type: "image", title: "图", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { prompt: "旧", status: "loading", runtimeTaskId: "task-1", runProgress: 0.3 } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, globalPrompt: "", viewport: { x: 0, y: 0, k: 1 } } as any;
    const next = structuredClone(base);
    next.nodes[0].position = { x: 12, y: 18 };
    next.nodes[0].metadata = { prompt: "新", status: "success", runtimeTaskId: "", runProgress: 1, errorDetails: "旧窗口错误" };
    assert.deepEqual(diffCanvasProject(base, next), [{ type: "update_node", id: "image", patch: { position: { x: 12, y: 18 } }, metadata: { prompt: "新" } }]);
});

test("向既有画布批量导入新实体时生成细粒度节点和连线操作", () => {
    const base = { id: "bulk-import", title: "既有画布", createdAt: "", updatedAt: "", revision: 4, nodes: [{ id: "origin", type: "text", title: "原节点", position: { x: 0, y: 0 }, width: 240, height: 120, metadata: { content: "保留" } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, globalPrompt: "", viewport: { x: 0, y: 0, k: 1 } } as any;
    const image = { id: "image-a", type: "image", title: "导入图片", position: { x: 320, y: 0 }, width: 320, height: 180, metadata: { storageKey: "media/image-a.png" } };
    const prompt = { id: "prompt-a", type: "text", title: "导入提示词", position: { x: 320, y: 240 }, width: 280, height: 160, metadata: { content: "镜头提示词" } };
    const connection = { id: "connection-a", fromNodeId: "image-a", toNodeId: "prompt-a", role: "reference", order: 0 };
    const next = { ...structuredClone(base), nodes: [...base.nodes, image, prompt], connections: [connection] } as any;

    assert.deepEqual(diffCanvasProject(base, next), [
        { type: "add_node", id: "image-a", nodeType: "image", title: "导入图片", position: { x: 320, y: 0 }, width: 320, height: 180, metadata: { storageKey: "media/image-a.png" } },
        { type: "add_node", id: "prompt-a", nodeType: "text", title: "导入提示词", position: { x: 320, y: 240 }, width: 280, height: 160, metadata: { content: "镜头提示词" } },
        { type: "connect_nodes", id: "connection-a", fromNodeId: "image-a", toNodeId: "prompt-a", role: "reference", order: 0 },
    ]);
});

test("列表按需加载、重连保留未提交操作、冲突和远端删除可由用户决策", async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const project = { id: "p", title: "原名", createdAt: "2026-01-01", updatedAt: "2026-01-01", revision: 1, nodes: [{ id: "n", type: "text", title: "node", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "原内容" } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, globalPrompt: "", viewport: { x: 0, y: 0, k: 1 } };
    let remote = structuredClone(project);
    const foreignKey = JSON.stringify([getBackendUrl(), "another-window", "foreign"]);
    const otherBackendKey = JSON.stringify(["http://another-backend", getCanvasDraftSessionId(), "other-backend"]);
    cache.set(foreignKey, { project: { ...project, id: "foreign" }, base: project, queueVersion: 2 });
    cache.set(otherBackendKey, { project: { ...project, id: "other-backend" }, base: project, queueVersion: 2 });
    cache.set("legacy", { project: { ...project, id: "legacy" }, base: project });
    buckets.get("infinite-canvas-project-deletions")!.set(JSON.stringify([getBackendUrl(), "another-window", "deletions"]), ["p"]);
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
        assert.deepEqual(useCanvasStore.getState().projects.map((item) => item.id), ["p"]);
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
        await useCanvasStore.getState().adoptRemoteOnCanvasConflict("p");
        assert.equal(useCanvasStore.getState().projects[0].nodes[0].metadata?.content, "冲突内容");

        useCanvasStore.getState().renameProject("p", "删除前未保存的标题");
        applyBackendCanvasEvent({ type: "canvas.updated", entityId: "p", payload: { deleted: 1 } });
        assert.equal(useCanvasStore.getState().canvasConflicts.p.remoteDeleted, true);
        assert.equal(useCanvasStore.getState().projects.length, 1);
        await useCanvasStore.getState().adoptRemoteOnCanvasConflict("p");
        assert.equal(useCanvasStore.getState().projects.length, 0);
        await flushCanvasSyncNow();
        assert.ok(cache.has(foreignKey));
        assert.ok(cache.has(otherBackendKey));
        assert.ok(cache.has("legacy"));
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
    assert.ok(cache.has(cacheKey(first)));
    assert.ok(cache.has(cacheKey(second)));
    writes.length = 0;
    useCanvasStore.getState().renameProject(first, "edited");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(writes, [cacheKey(first)]);
    assert.ok([...buckets.get("infinite-canvas-command-outbox")!.values()].some((item) => (item as { projectId: string }).projectId === first));
    useCanvasStore.getState().deleteProjects([first, second]);
});

test("一个新项目缓存失败不会漏掉其余新项目的内存备份", async () => {
    const { canvasDraftPersistence } = await import("../../lib/canvas/canvas-draft-persistence");
    useBackendStore.setState({ connected: false });
    failCacheWrites = true;
    const first = useCanvasStore.getState().createProject("unsaved-first");
    const second = useCanvasStore.getState().createProject("unsaved-second");
    try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const records = canvasDraftPersistence.exportBackup().records;
        assert.ok(records.some((entry) => entry.projectId === first));
        assert.ok(records.some((entry) => entry.projectId === second));
    } finally { failCacheWrites = false; }
    await canvasDraftPersistence.retry();
    assert.ok(cache.has(cacheKey(first)));
    assert.ok(cache.has(cacheKey(second)));
    useCanvasStore.getState().deleteProjects([first, second]);
});
