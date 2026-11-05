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
const base: any = { id: "backend-recover", revision: 5, title: "fixture", createdAt: "", updatedAt: "", nodes: [{ id: "h3", type: "minimax-h3:video", metadata: { segments: [{ id: "clip", duration: 5, prompt: "Compiled prompt", result: "historical.mp4", productionClipProjection: { inputHash: "compiled" } }] } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, globalPrompt: "", viewport: { x: 0, y: 0, k: 1 } };
const original = { operationId: "old-backend-edit", projectId: base.id, ownerId: getCanvasDraftSessionId(), backend: getBackendUrl(), order: 1, base, baseRevision: 5,
    rejected: 'Backend POST /canvas/projects/backend-recover/ops failed: HTTP 400 The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined',
    operations: [{ type: "update_h3_segment", nodeId: "h3", segmentId: "clip", patch: { prompt: "Manual prompt", storyboardShots: [{ id: "shot", duration: 5 }] } }] };
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

test("确定性 400 明确失败：保留草稿但不锁画布，旧版本遗留的冲突锁自动拆掉", async () => {
    try {
        useBackendStore.setState({ connected: true });
        await hydrateCanvasProjects(); await flushCanvasSyncNow();
        const state = useCanvasStore.getState();
        assert.equal(state.canvasConflicts[base.id], undefined, "400 不再把整张画布锁成冲突态");
        assert.equal(state.canvasConflicts.unrelated, undefined);
        const outbox = buckets.get("infinite-canvas-command-outbox")!;
        assert.ok(outbox.get(original.operationId)?.settled, "失败草稿保留且标记 settled");
        assert.ok(outbox.get(unrelated.operationId)?.settled);
        assert.equal(submissions.length, 0, "确定性拒绝不自动重放");
        // 旧版本写进内存/持久化的全局冲突锁，加载新代码后下一轮同步即自愈。
        useCanvasStore.setState({ canvasConflicts: { [base.id]: { message: "HTTP 400 update_h3_segment CAS 失败", reason: "rejected", revision: 5, pendingOperations: 1, conflictTargets: [], remoteProject: remote } } as any });
        await flushCanvasSyncNow();
        assert.equal(useCanvasStore.getState().canvasConflicts[base.id], undefined, "遗留冲突锁已拆");
        assert.equal(submissions.length, 0, "拆锁不复活被拒命令");
        assert.equal(outbox.get(original.operationId)?.settled !== undefined, true, "失败草稿未被删除");
    } finally { useBackendStore.setState({ connected: false }); }
});

