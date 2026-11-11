import assert from "node:assert/strict";
import test from "node:test";
import { syncContinuationBoundaries } from "./continuation-sync.js";

const formal = (id: string, targetId: string, extra: Record<string, unknown> = {}) => ({
    id, productionClipProjection: { targetId }, tailFrameContinuation: true, motionContextEnabled: false, videoContinuation: false, ...extra,
});
const local = (id: string) => ({ id, title: "local clip" });

function port(props: { owner?: Record<string, unknown>; revision?: number; fail?: string } = {}) {
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    return {
        calls,
        get: async (path: string) => {
            calls.push({ method: "GET", path });
            if (path.includes("/production-context")) return { ok: true, context: { owner: props.owner ?? { kind: "episode", id: "ep-1" } } };
            if (path.includes("/production?view=summary")) return { ok: true, production: { revision: props.revision ?? 7 } };
            throw new Error(`unexpected GET ${path}`);
        },
        post: async (path: string, body?: unknown) => {
            calls.push({ method: "POST", path, body });
            if (props.fail) throw new Error(props.fail);
            return { ok: true, production: { revision: 8 } };
        },
    };
}

test("把画布续接配置写回制作台相邻 Clip 的 boundary", async () => {
    const segments = [formal("s1", "clip-a"), local("s2"), formal("s3", "clip-b", { tailFrameContinuation: false, motionContextEnabled: true })];
    const p = port();
    const receipt = await syncContinuationBoundaries(p as any, { projectId: "canvas-1", segments: segments as any, segmentIds: ["s1", "s3"], operationId: "op-1" });
    assert.deepEqual(receipt.boundaries, [
        { from: "clip-a", to: "clip-b", tailFrame: true, motionContext: false, videoContinuation: false },
    ]);
    assert.deepEqual(receipt.skipped, [{ segmentId: "s3", reason: "NO_NEXT_FORMAL_CLIP" }]);
    // 只发一次写请求，与画布操作共用同一 operationId 命名空间。
    const post = p.calls.find(call => call.method === "POST")!;
    assert.equal(post.path, "/drama/episodes/ep-1/production/ops");
    assert.equal(post.body.operationId, "op-1:continuation");
    assert.equal(post.body.expectedRevision, 7);
    assert.deepEqual(post.body.ops, [{
        type: "set_director_boundary",
        boundary: { from: "clip-a", to: "clip-b", tailFrame: true, motionContext: false, videoContinuation: false, reason: "由 H3 Clip 设置保存续段衔接" },
    }]);
    assert.equal(receipt.revision, 8);
});

test("本地 Clip 与画布末尾不构成边界，未投影段只记跳过", async () => {
    const segments = [local("s1"), formal("s2", "clip-a"), local("s3")];
    const p = port();
    const receipt = await syncContinuationBoundaries(p as any, { projectId: "canvas-1", segments: segments as any, segmentIds: ["s1", "s2"], operationId: "op-2" });
    assert.deepEqual(receipt.boundaries, []);
    assert.deepEqual(receipt.skipped, [
        { segmentId: "s1", reason: "NOT_FORMAL_CLIP" },
        { segmentId: "s2", reason: "NO_NEXT_FORMAL_CLIP" },
    ]);
    assert.equal(p.calls.length, 0, "没有任何边界时不应读取或写入制作台");
});

test("制作台写失败只回报执，不影响已提交的画布结果", async () => {
    const p = port({ fail: "连续性边界必须连接相邻 Segment" });
    const receipt = await syncContinuationBoundaries(p as any, {
        projectId: "canvas-1", segments: [formal("s1", "clip-a"), formal("s2", "clip-z")] as any, segmentIds: ["s1"], operationId: "op-3",
    });
    assert.equal(receipt.boundaries.length, 0);
    assert.match(String(receipt.error), /连续性边界必须连接相邻 Segment/);
});

test("后端未提供通用读写口时静默跳过", async () => {
    const receipt = await syncContinuationBoundaries({}, {
        projectId: "canvas-1", segments: [formal("s1", "clip-a"), formal("s2", "clip-b")] as any, segmentIds: ["s1"], operationId: "op-4",
    });
    assert.deepEqual(receipt, { boundaries: [], skipped: [] });
});

test("场景/画布 owner 也能定位制作台路由", async () => {
    const p = port({ owner: { kind: "scene", id: "scene-9" } });
    await syncContinuationBoundaries(p as any, {
        projectId: "canvas-1", segments: [formal("s1", "clip-a"), formal("s2", "clip-b")] as any, segmentIds: ["s1"], operationId: "op-5",
    });
    assert.ok(p.calls.some(call => call.method === "POST" && call.path === "/drama/scenes/scene-9/production/ops"));
});
