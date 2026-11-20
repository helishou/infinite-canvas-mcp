import assert from "node:assert/strict";
import test from "node:test";
import localforage from "localforage";

const buckets = new Map<string, Map<string, any>>();
const writes: string[] = [];
localforage.createInstance = (({ name }: { name: string }) => {
    const bucket = buckets.get(name) || new Map(); buckets.set(name, bucket);
    return { getItem: async (key: string) => bucket.get(key) ?? null,
        setItem: async (key: string, value: any) => { writes.push(`save:${key}`); bucket.set(key, structuredClone(value)); return value; },
        removeItem: async (key: string) => { writes.push(`remove:${key}`); bucket.delete(key); },
        iterate: async (visit: (value: any, key: string) => void) => bucket.forEach(visit) };
}) as any;
const { getBackendUrl, getCanvasDraftSessionId } = await import("../../services/backend-api");
const base: any = { id: "formal-recover", revision: 5, title: "fixture", createdAt: "", updatedAt: "", nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { segments: [{ id: "clip", duration: 5, prompt: "Compiled prompt", storyboardDurations: { shot: 5 }, result: "historical.mp4", productionClipProjection: { inputHash: "compiled" } }] } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, globalPrompt: "", viewport: { x: 0, y: 0, k: 1 } };
const original = { operationId: "old-formal-edit", projectId: base.id, ownerId: getCanvasDraftSessionId(), backend: getBackendUrl(), order: 1, base, baseRevision: 5,
    rejected: "Backend POST /canvas/projects/formal-recover/ops failed: HTTP 400 字段 storyboardDurations 必须通过制作台 Shot 数据写入",
    operations: [{ type: "update_h3_segment", nodeId: "h3", segmentId: "clip", patch: { prompt: "Manual prompt", storyboardDurations: { shot: 7 } } }] };
const unrelated = { ...structuredClone(original), operationId: "unrelated-rejection", projectId: "unrelated", base: { ...structuredClone(base), id: "unrelated" }, rejected: "HTTP 400 INVALID_CLIP_FIELD: patch.promt 不属于可编辑 Clip 配置" };
buckets.set("infinite-canvas-command-outbox", new Map([[original.operationId, structuredClone(original)], [unrelated.operationId, unrelated]]));
const submissions: any[] = [];
let remote = structuredClone(base);
globalThis.fetch = (async (input: any, init: any) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/ops") && init.method === "POST") {
        const body = JSON.parse(init.body); submissions.push(body);
        remote = applyBackendCanvasDelta(remote, body.operations, remote.revision + 1);
        return Response.json({ ok: true, project: remote, revision: remote.revision });
    }
    if (path.includes("/ops/")) return Response.json({ ok: true, committed: false });
    if (path === "/canvas/folders") return Response.json({ ok: true, folders: [] });
    if (path === "/canvas/projects") return Response.json({ ok: true, projects: [remote, unrelated.base] });
    if (path === "/canvas/projects/unrelated") return Response.json({ ok: true, project: unrelated.base });
    return Response.json({ ok: true, project: remote });
}) as typeof fetch;
const { useCanvasStore, hydrateCanvasProjects, flushCanvasSyncNow, applyBackendCanvasDelta } = await import("./use-canvas-store");
const { useBackendStore } = await import("../use-backend-store");

test("旧草稿夹带正式字段被 400 拒绝后整条 settle：两个项目各自保留草稿与拒因，不自动重放", async () => {
    try {
        useBackendStore.setState({ connected: true });
        await hydrateCanvasProjects(); await flushCanvasSyncNow();
        const state = useCanvasStore.getState();
        // 确定性拒绝不再生成冲突记录，两个项目都不锁画布
        assert.equal(state.canvasConflicts[base.id], undefined, "400 不生成冲突记录");
        assert.equal(state.canvasConflicts.unrelated, undefined, "无关项目的 400 同样不生成冲突记录");
        const outbox = buckets.get("infinite-canvas-command-outbox")!;
        // 两条失败草稿都 settle 保留，各自记住真实拒因
        const settled = outbox.get(original.operationId);
        assert.ok(settled?.settled, "失败草稿保留且标记 settled");
        assert.equal(settled.rejected, original.rejected, "真实拒因保留在草稿上");
        assert.deepEqual(settled.operations, original.operations, "整条命令的操作原样保留");
        assert.ok(outbox.get(unrelated.operationId)?.settled, "无关项目草稿同样 settle 保留");
        assert.equal(submissions.length, 0, "确定性拒绝不自动重放");
        // 远端正式字段未被本地编辑改写
        const clip = remote.nodes[0].metadata.segments[0];
        assert.equal(clip.prompt, "Compiled prompt");
        assert.deepEqual(clip.storyboardDurations, { shot: 5 });
        assert.equal(clip.result, "historical.mp4");
        assert.equal(clip.productionClipProjection.inputHash, "compiled");
        await flushCanvasSyncNow();
        assert.equal(submissions.length, 0, "重复同步也不复活被拒命令");
        assert.ok(buckets.get("infinite-canvas-command-outbox")!.get(original.operationId)?.settled, "草稿未被删除");
    } finally { useBackendStore.setState({ connected: false }); }
});
