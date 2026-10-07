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

test("拒绝草稿刷新后不重提，明确恢复先持久化新命令再清旧记录", async () => {
    try {
        useBackendStore.setState({ connected: true });
        await hydrateCanvasProjects();
        await flushCanvasSyncNow();
        const conflict = useCanvasStore.getState().canvasConflicts.recover;
        assert.equal(conflict.reason, "rejected");
        assert.equal(conflict.canRecoverTimeline, true);
        assert.deepEqual(conflict.conflictTargets, []);
        assert.equal(submissions.length, 0);
        await flushCanvasSyncNow();
        assert.equal(submissions.length, 0);
        await useCanvasStore.getState().keepPendingOpsOnCanvasConflict(base.id);
        const outbox = buckets.get("infinite-canvas-command-outbox")!;
        const replacement = [...outbox.values()][0];
        assert.notEqual(replacement.operationId, original.operationId);
        assert.deepEqual(replacement.operations, [original.operations[0]]);
        assert.deepEqual(replacement.supersedes, [original.operationId]);
        assert.ok(writes.indexOf(`save:${replacement.operationId}`) < writes.indexOf(`remove:${original.operationId}`));
        await flushCanvasSyncNow();
        assert.equal(submissions.length, 1);
        assert.equal(submissions[0].operationId, replacement.operationId);
        assert.equal(outbox.size, 0);
        assert.equal(remote.nodes[0].metadata.segments[0].prompt, "保留原编辑");
        assert.equal(remote.nodes[0].metadata.segments[1].start, 8);
    } finally { useBackendStore.setState({ connected: false }); }
});
