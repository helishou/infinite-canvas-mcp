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

test("入队命令的 base 只带作用域内节点，不夹带整图", async () => {
    const huge = "z".repeat(200_000);
    const project = {
        id: "slim", title: "瘦身画布", createdAt: "2026-01-01", updatedAt: "2026-01-01", revision: 1,
        nodes: [
            { id: "target", type: "text", title: "要改的", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "旧" } },
            { id: "blob", type: "image", title: "巨无霸", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: huge } },
        ],
        connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines",
        showImageInfo: false, globalPrompt: "", viewport: { x: 0, y: 0, k: 1 },
    } as any;
    cache.set(cacheKey("slim"), { project, base: project, queueVersion: 2 });
    useBackendStore.setState({ connected: false });
    await hydrateCanvasProjects();
    // 本地快照只在首次 hydrate 读一次；同一测试进程内直接注入画布，等价于"已恢复的草稿"。
    useCanvasStore.getState().replaceProjects([project]);

    // updateProject 是 store 上真实存在的编辑入口，内部会调用 captureCanvasAction(before, project) → 入队一条命令。
    useCanvasStore.getState().updateProject("slim", {
        nodes: project.nodes.map((node: any) => node.id === "target" ? { ...node, metadata: { ...node.metadata, content: "新内容" } } : node),
    });

    // 入队落盘是异步的，等一次宏任务再读 outbox。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const outbox = buckets.get("infinite-canvas-command-outbox")!;
    const command = [...outbox.values()].find((value: any) => value?.projectId === "slim") as any;
    assert.ok(command, `应有一条待提交命令，实际入队 ${outbox.size} 条，画布 ${useCanvasStore.getState().projects.map((item) => item.id).join(",")}`);
    assert.equal(JSON.stringify(command.base).includes(huge), false, "命令 base 不得携带无关大节点");
    assert.equal(command.base.nodes.length, 1, "只应带目标节点");
    assert.equal(command.base.nodes[0].id, "target");
    assert.equal(command.base.v, 1, "应带版本标记以便运行时判别");
    assert.equal(typeof command.base.revision, "number");
    await flushCanvasSyncNow();
    useCanvasStore.getState().deleteProjects(["slim"]);
});

test("作用域基线与完整快照给出完全相同的冲突判定", async () => {
    const mod = await import("./use-canvas-store");
    const { buildCanvasConflictBaseline } = await import("../../lib/canvas/canvas-conflict-baseline");
    const full = {
        id: "c", title: "画布", revision: 1,
        nodes: [{ id: "n", type: "config", title: "配置", position: { x: 0, y: 0 }, width: 320, height: 240,
                  metadata: { prompt: "旧值", composerContent: "旧草稿", images: [{ id: "i", storageKey: "image:a" }],
                              segments: [{ id: "s", prompt: "段", status: "idle" }] } }],
        connections: [{ id: "k", fromNodeId: "n", toNodeId: "n", role: "reference", order: 0 }],
        chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, globalPrompt: "",
        viewport: { x: 0, y: 0, k: 1 },
    } as any;

    const cases: Array<{ name: string; ops: any[]; remote: any }> = [
        { name: "远端改了同一字段", ops: [{ type: "update_node", id: "n", metadata: { prompt: "本地" } }],
          remote: { ...structuredClone(full), nodes: [{ ...full.nodes[0], metadata: { ...full.nodes[0].metadata, prompt: "远端改过" } }] } },
        { name: "远端没改（应无冲突）", ops: [{ type: "update_node", id: "n", metadata: { prompt: "本地" } }], remote: structuredClone(full) },
        { name: "远端删了目标节点", ops: [{ type: "update_node", id: "n", metadata: { prompt: "本地" } }],
          remote: { ...structuredClone(full), nodes: [] } },
        { name: "重复 add_node", ops: [{ type: "add_node", id: "n", title: "重名" }], remote: structuredClone(full) },
        { name: "删连接", ops: [{ type: "delete_connections", ids: ["k"] }],
          remote: { ...structuredClone(full), connections: [{ id: "k", fromNodeId: "n", toNodeId: "n", role: "reference", order: 9 }] } },
        { name: "删连接但远端未改（应无冲突）", ops: [{ type: "delete_connections", ids: ["k"] }], remote: structuredClone(full) },
        { name: "update_project", ops: [{ type: "update_project", patch: { title: "新" } }],
          remote: { ...structuredClone(full), title: "远端改过" } },
        { name: "H3 段被远端改过", ops: [{ type: "update_h3_segment", nodeId: "n", segmentId: "s", patch: { prompt: "本地段" } }],
          remote: { ...structuredClone(full), nodes: [{ ...full.nodes[0], metadata: { ...full.nodes[0].metadata, segments: [{ id: "s", prompt: "远端段", status: "idle" }] } }] } },
        { name: "H3 段未被远端改（应无冲突）", ops: [{ type: "update_h3_segment", nodeId: "n", segmentId: "s", patch: { prompt: "本地段" } }], remote: structuredClone(full) },
    ];

    for (const item of cases) {
        const withFull = mod.detectCanvasConflicts(item.ops, item.remote, full);
        const withSlim = mod.detectCanvasConflicts(item.ops, item.remote, buildCanvasConflictBaseline(full, item.ops));
        assert.deepEqual(withSlim, withFull, `场景「${item.name}」判定结果必须一致`);
    }
});
