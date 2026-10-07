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

test("后端哈希异常拒绝草稿不自动重试，明确恢复后保存编辑且不解除其他拒绝", async () => {
    try {
        useBackendStore.setState({ connected: true });
        await hydrateCanvasProjects(); await flushCanvasSyncNow();
        const conflict = useCanvasStore.getState().canvasConflicts[base.id];
        assert.equal(conflict.reason, "rejected");
        assert.equal(conflict.canRetryBackendFailure, true);
        assert.equal(useCanvasStore.getState().canvasConflicts.unrelated.canRetryBackendFailure, false);
        await useCanvasStore.getState().keepPendingOpsOnCanvasConflict("unrelated");
        assert.deepEqual(buckets.get("infinite-canvas-command-outbox")!.get(unrelated.operationId), unrelated);
        await flushCanvasSyncNow(); assert.equal(submissions.length, 0);
        await useCanvasStore.getState().keepPendingOpsOnCanvasConflict(base.id);
        const outbox = buckets.get("infinite-canvas-command-outbox")!;
        const replacement = [...outbox.values()].find(command => command.projectId === base.id);
        assert.notEqual(replacement.operationId, original.operationId);
        assert.deepEqual(replacement.operations, original.operations);
        assert.deepEqual(replacement.supersedes, [original.operationId]);
        assert.ok(writes.indexOf(`save:${replacement.operationId}`) < writes.indexOf(`remove:${original.operationId}`));
        await flushCanvasSyncNow();
        assert.equal(submissions.length, 1); assert.equal(outbox.size, 1);
        assert.equal(outbox.has(unrelated.operationId), true);
        assert.equal(submissions[0].operationId, replacement.operationId);
        const clip = remote.nodes[0].metadata.segments[0];
        assert.equal(clip.prompt, "Manual prompt");
        assert.deepEqual(clip.storyboardShots, original.operations[0].patch.storyboardShots);
        assert.equal(clip.result, "historical.mp4");
        assert.equal(clip.productionClipProjection.inputHash, "compiled");
    } finally { useBackendStore.setState({ connected: false }); }
});

