import assert from "node:assert/strict";
import test from "node:test";
import localforage from "localforage";

const buckets = new Map<string, Map<string, any>>();
const writes: string[] = [];
localforage.createInstance = (({ name }: { name: string }) => {
    const bucket = buckets.get(name) || new Map();
    buckets.set(name, bucket);
    return { getItem: async (key: string) => bucket.get(key) ?? null,
        setItem: async (key: string, value: any) => { writes.push(`save:${key}`); bucket.set(key, structuredClone(value)); return value; },
        removeItem: async (key: string) => { writes.push(`remove:${key}`); bucket.delete(key); },
        iterate: async (visit: (value: any, key: string) => void) => bucket.forEach(visit) };
}) as any;
const { getBackendUrl, getCanvasDraftSessionId } = await import("../../services/backend-api");
const base: any = { id: "recover", revision: 784, title: "fixture", createdAt: "", updatedAt: "", nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { segments: [{ id: "a", duration: 5 }, { id: "b", duration: 5 }] } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, globalPrompt: "", viewport: { x: 0, y: 0, k: 1 } };
const original = { operationId: "old-start", projectId: base.id, ownerId: getCanvasDraftSessionId(), backend: getBackendUrl(), order: 1, base, baseRevision: 784,
    rejected: "HTTP 400 INVALID_CLIP_FIELD: patch.start 不属于可编辑 Clip 配置",
    operations: [{ type: "update_h3_segment", nodeId: "h3", segmentId: "a", patch: { duration: 8, prompt: "保留原编辑" } }, { type: "update_h3_segment", nodeId: "h3", segmentId: "b", patch: { start: 8 } }] };
buckets.set("infinite-canvas-command-outbox", new Map([[original.operationId, structuredClone(original)]]));
let submissions: any[] = [];
let remote = structuredClone(base);
globalThis.fetch = (async (input: any, init: any) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/ops") && init.method === "POST") {
        const body = JSON.parse(init.body);
        submissions.push(body);
        remote = applyBackendCanvasDelta(remote, body.operations, remote.revision + 1);
        return Response.json({ ok: true, project: remote, revision: remote.revision });
    }
    if (path.includes("/ops/")) return Response.json({ ok: true, committed: false });
    if (path === "/canvas/folders") return Response.json({ ok: true, folders: [] });
    if (path === "/canvas/projects") return Response.json({ ok: true, projects: [remote] });
    return Response.json({ ok: true, project: remote });
}) as typeof fetch;
const { useCanvasStore, hydrateCanvasProjects, flushCanvasSyncNow, applyBackendCanvasDelta } = await import("./use-canvas-store");
const { useBackendStore } = await import("../use-backend-store");

test("多操作命令被 400 拒绝后整条 settle：草稿含全部操作原样保留，不拆分、不自动重放", async () => {
    try {
        useBackendStore.setState({ connected: true });
        await hydrateCanvasProjects();
        await flushCanvasSyncNow();
        const state = useCanvasStore.getState();
        // 确定性拒绝不把画布锁成冲突态，也不再显示"时间线恢复/重提"入口
        assert.equal(state.canvasConflicts.recover, undefined, "400 不再生成冲突记录");
        // 草稿连同被拒的两条操作一起 settle 保留，不会被拆成"可恢复部分"
        const settled = buckets.get("infinite-canvas-command-outbox")!.get(original.operationId);
        assert.ok(settled?.settled, "失败草稿保留且标记 settled");
        assert.deepEqual(settled.operations, original.operations, "整条命令的操作原样保留，不改写 Shot 源稿");
        assert.equal(settled.rejected, original.rejected, "真实拒因保留在草稿上");
        assert.equal(submissions.length, 0, "确定性拒绝不自动重放");
        assert.equal(remote.nodes[0].metadata.segments[0].prompt, undefined, "远端 Shot 未被本地编辑改写");
        assert.equal(remote.nodes[0].metadata.segments[1].start, undefined, "远端未接受被拒的 patch.start");
        await flushCanvasSyncNow();
        assert.equal(submissions.length, 0, "重复同步也不复活被拒命令");
        // 旧版本写进来的全局冲突锁，加载新代码后下一轮同步即自愈
        useCanvasStore.setState({ canvasConflicts: { recover: { message: original.rejected, reason: "rejected", revision: 784, pendingOperations: 2, conflictTargets: [], remoteProject: remote } } as any });
        await flushCanvasSyncNow();
        assert.equal(useCanvasStore.getState().canvasConflicts.recover, undefined, "遗留冲突锁已拆");
        assert.equal(submissions.length, 0, "拆锁不复活被拒命令");
        assert.ok(buckets.get("infinite-canvas-command-outbox")!.get(original.operationId)?.settled, "草稿未被删除");
    } finally { useBackendStore.setState({ connected: false }); }
});
