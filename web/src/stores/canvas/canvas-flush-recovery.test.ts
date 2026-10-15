import assert from "node:assert/strict";
import test from "node:test";
import localforage from "localforage";

const buckets = new Map<string, Map<string, any>>();
localforage.createInstance = (({ name }: { name: string }) => {
    const bucket = buckets.get(name) || new Map();
    buckets.set(name, bucket);
    return {
        getItem: async (key: string) => bucket.get(key) ?? null,
        setItem: async (key: string, value: any) => { bucket.set(key, structuredClone(value)); return value; },
        removeItem: async (key: string) => { bucket.delete(key); },
        iterate: async (visit: (value: any, key: string) => void) => bucket.forEach(visit),
    };
}) as any;
const { getBackendUrl, getCanvasDraftSessionId } = await import("../../services/backend-api");
const cacheKey = (id: string) => JSON.stringify([getBackendUrl(), getCanvasDraftSessionId(), id]);
const shape = (id: string, revision: number) => ({
    id, revision, title: `画布 ${id}`, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    nodes: [{ id: "h3", type: "minimax-h3:video", title: "H3", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { segments: [{ id: "clip", duration: 5 }] } }],
    connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, globalPrompt: "", viewport: { x: 0, y: 0, k: 1 },
}) as any;
const healthy = shape("flush-healthy", 1);
const broken = shape("flush-broken", 1);
// 列表首次读取失败：模拟启动瞬间后端抖动 / 未连上，hydration 从未成功过一次。
let failList = true;
globalThis.fetch = (async (input: any) => {
    const path = new URL(String(input)).pathname;
    if (path === "/canvas/projects" && failList) return Response.json({ error: "后端抖动" }, { status: 500 });
    if (path === "/canvas/folders") return Response.json({ ok: true, folders: [] });
    if (path === "/canvas/projects") return Response.json({
        ok: true,
        projects: [healthy, { ...broken, revision: 2 }].map((project) => ({ ...project, nodes: undefined, connections: undefined, nodeCount: 1, connectionCount: 0 })),
    });
    // 单个画布详情读取失败：不能让整页 hydration 陪葬。
    if (path === "/canvas/projects/flush-broken") return Response.json({ error: "详情读取失败" }, { status: 500 });
    return Response.json({ ok: true, project: healthy });
}) as typeof fetch;
const { useCanvasStore, hydrateCanvasProjects, flushCanvasProjectBeforeGeneration } = await import("./use-canvas-store");
const { useBackendStore } = await import("../use-backend-store");

test("首次同步失败后，生成入口补一次 hydration，而不是永久报画布未加载", async () => {
    try {
        useBackendStore.setState({ connected: true });
        await hydrateCanvasProjects();
        assert.equal(useCanvasStore.getState().projects.some((item) => item.id === healthy.id), false);
        // 旧行为：hydration 是一次性开关，这里会永久抛「画布尚未完成加载，请稍后再生成」。
        failList = false;
        await flushCanvasProjectBeforeGeneration(healthy.id);
        assert.equal(useCanvasStore.getState().projects.find((item) => item.id === healthy.id)?.summary?.nodeCount, 1);
    } finally { useBackendStore.setState({ connected: false }); }
});

test("单个画布详情读取失败不阻断整页同步，其他画布仍可提交生成", async () => {
    buckets.set("infinite-canvas-project-cache", new Map([[cacheKey(broken.id), { project: broken, base: broken, queueVersion: 2 }]]));
    try {
        useBackendStore.setState({ connected: true });
        const fresh = await import("./use-canvas-store?project-failure=" + Date.now()) as typeof import("./use-canvas-store");
        await fresh.hydrateCanvasProjects();
        await fresh.flushCanvasProjectBeforeGeneration(healthy.id);
        const projects = fresh.useCanvasStore.getState().projects;
        assert.equal(projects.find((item) => item.id === healthy.id)?.summary?.nodeCount, 1);
        assert.equal(projects.find((item) => item.id === broken.id)?.nodes.length, 1, "详情失败的画布应保留本地副本");
    } finally {
        useBackendStore.setState({ connected: false });
        buckets.get("infinite-canvas-project-cache")!.delete(cacheKey(broken.id));
    }
});
