/**
 * H3 段粒度 diff / 冲突检测回归测试。
 *
 * 运行（web 目录下，借 backend 的 tsx）：
 *   ../backend/node_modules/.bin/tsx --test src/stores/canvas/use-canvas-store.test.ts
 *
 * 覆盖：
 * 1) 同一 H3 节点上「编辑 segment A」与「更新节点级 metadata」不会被拍成一条 update_node.metadata.segments
 *    （之前会把整数组都带上，触发 409 / 写覆盖）。
 * 2) 同一 H3 节点上「segment A 改 prompt」与「segment B 改 status」能被拆成两条 update_h3_segment，
 *    不互相阻塞。
 * 3) detectCanvasConflicts 对 H3 段做 (nodeId, segmentId, field) 三元组检测，不会因为别的段被远端改
 *    就误报整节点冲突。
 * 4) update_node.metadata.segments 仍被 detectCanvasConflicts 视为非法 op（提示走细粒度）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyBackendCanvasDelta, diffCanvasProject, detectCanvasConflicts, isLocalProjectNewer, type CanvasProject } from "./use-canvas-store";

const VIEWPORT = { x: 0, y: 0, k: 1 };

function makeH3Node(id: string, segments: Array<Record<string, unknown>>, extras: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        type: "minimax-h3:video",
        title: "H3",
        position: { x: 0, y: 0 },
        width: 600,
        height: 400,
        metadata: { segments, ...extras },
    };
}

function makeProject(nodes: Array<Record<string, unknown>>, overrides: Partial<CanvasProject> = {}): CanvasProject {
    return {
        id: overrides.id || "p1",
        revision: overrides.revision || 1,
        title: overrides.title || "p1",
        createdAt: overrides.createdAt || "2026-01-01T00:00:00Z",
        updatedAt: overrides.updatedAt || "2026-01-01T00:00:00Z",
        nodes: nodes as unknown as CanvasProject["nodes"],
        connections: overrides.connections || [],
        chatSessions: overrides.chatSessions || [],
        activeChatId: overrides.activeChatId ?? null,
        backgroundMode: overrides.backgroundMode || "blank",
        showImageInfo: overrides.showImageInfo ?? false,
        globalPrompt: overrides.globalPrompt || "",
        viewport: overrides.viewport || VIEWPORT,
    };
}

test("H3：仅编辑 segment A 的 prompt，只产出一条 update_h3_segment，不动其它段", () => {
    const base = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "原 A", status: "idle" },
        { id: "s2", prompt: "原 B", status: "idle" },
    ])]);
    const next = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "新 A", status: "idle" },
        { id: "s2", prompt: "原 B", status: "idle" },
    ])]);
    const ops = diffCanvasProject(base, next);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].type, "update_h3_segment");
    assert.equal(ops[0].nodeId, "h3-1");
    assert.equal(ops[0].segmentId, "s1");
    assert.deepEqual(ops[0].patch, { prompt: "新 A" });
});

test("H3：编辑两个不同段，拆成两条 update_h3_segment；节点级 metadata 走 update_node", () => {
    const base = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "A", status: "idle" },
        { id: "s2", prompt: "B", status: "idle" },
    ], { notes: "old" })]);
    const next = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "A2", status: "idle" },
        { id: "s2", prompt: "B2", status: "loading" },
    ], { notes: "new" })]);
    const ops = diffCanvasProject(base, next);
    const segOps = ops.filter((op) => op.type === "update_h3_segment");
    const nodeOps = ops.filter((op) => op.type === "update_node");
    assert.equal(segOps.length, 2);
    const byId = new Map(segOps.map((op) => [op.segmentId, op]));
    assert.deepEqual(byId.get("s1")?.patch, { prompt: "A2" });
    assert.deepEqual(byId.get("s2")?.patch, { prompt: "B2" });
    assert.equal(nodeOps.length, 1);
    assert.deepEqual(nodeOps[0].metadata, { notes: "new" });
    // 关键：update_node.metadata 里不能再带 segments 字段
    assert.equal("segments" in (nodeOps[0].metadata as Record<string, unknown>), false);
});

test("H3：本地旧快照不能覆盖 Backend 的运行状态和产出", () => {
    // 注意：H3 节点的 metadata.materials 自 v4 起已迁出到 generation_logs.outputs_json，
    // 不再是 node.metadata 的字段；本测试只覆盖 status / content 字段的 sync 跳过逻辑。
    const baseNode = makeH3Node("h3-1", [
        { id: "s1", prompt: "开场", status: "loading", runtimeTaskId: "child-1", result: "", results: [] },
    ], { status: "loading", runtimeTaskId: "parent-1", content: "" });
    const base = makeProject([baseNode]);
    const staleNode = makeH3Node("h3-1", [
        { id: "s1", prompt: "开场", status: "success", runtimeTaskId: "", result: "old-video", results: [{ storageKey: "old-video" }] },
    ], { status: "success", runtimeTaskId: "", content: "old-video" });
    const stale = makeProject([staleNode]);
    assert.deepEqual(diffCanvasProject(base, stale), []);
});

test("H3：新增 segment 产 add_h3_segment；删除产 delete_h3_segment", () => {
    const base = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "A" },
        { id: "s2", prompt: "B" },
    ])]);
    const next = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "A" },
        { id: "s3", prompt: "新 C" },
    ])]);
    const ops = diffCanvasProject(base, next);
    assert.equal(ops.length, 2);
    const add = ops.find((op) => op.type === "add_h3_segment");
    const del = ops.find((op) => op.type === "delete_h3_segment");
    assert.ok(add, "应产 add_h3_segment");
    assert.ok(del, "应产 delete_h3_segment");
    assert.equal(add?.nodeId, "h3-1");
    assert.equal((add?.segment as Record<string, unknown>).id, "s3");
    assert.equal(del?.nodeId, "h3-1");
    assert.equal(del?.segmentId, "s2");
});

test("H3：本地不能删除 Backend 所有的运行字段", () => {
    const base = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "A", errorDetails: "旧错误" },
    ])]);
    const next = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "A" },
    ])]);
    assert.deepEqual(diffCanvasProject(base, next), []);
});

test("冲突检测：远端改了同段同字段 → 报冲突；远端改了同段不同字段 → 不报", () => {
    const base = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "A", status: "idle" },
    ])]);
    const remote = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "A", status: "loading" },
    ])]);
    const pendingOps = [{ type: "update_h3_segment", nodeId: "h3-1", segmentId: "s1", patch: { prompt: "A-new" } }];
    // 远端改了 status，本地改 prompt：字段不同，不应冲突
    assert.deepEqual(detectCanvasConflicts(pendingOps, remote, base), []);
    // 远端也改了 prompt：同字段冲突
    const remote2 = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "A-from-remote", status: "idle" },
    ])]);
    const conflicts = detectCanvasConflicts(pendingOps, remote2, base);
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0].detail, /prompt/);
});

test("冲突检测：远端改了别的段，本地改本段：不应误报本段冲突", () => {
    const base = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "A", status: "idle" },
        { id: "s2", prompt: "B", status: "idle" },
    ])]);
    const remote = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "A", status: "idle" },
        { id: "s2", prompt: "B-from-remote", status: "idle" },
    ])]);
    const pendingOps = [{ type: "update_h3_segment", nodeId: "h3-1", segmentId: "s1", patch: { status: "loading" } }];
    assert.deepEqual(detectCanvasConflicts(pendingOps, remote, base), []);
});

test("冲突检测：update_node.metadata.segments 仍视为非法 op", () => {
    const base = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "A" },
    ])]);
    const remote = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "A" },
    ])]);
    const pendingOps = [{
        type: "update_node",
        id: "h3-1",
        metadata: { segments: [{ id: "s1", prompt: "A" }] },
    }];
    const conflicts = detectCanvasConflicts(pendingOps, remote, base);
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0].detail, /segments/);
});

test("冲突检测：add_h3_segment 在远端已存在同 id → 报冲突", () => {
    const base = makeProject([makeH3Node("h3-1", [{ id: "s1", prompt: "A" }])]);
    const remote = makeProject([makeH3Node("h3-1", [{ id: "s1", prompt: "A" }, { id: "s2", prompt: "B" }])]);
    const pendingOps = [{ type: "add_h3_segment", nodeId: "h3-1", segment: { id: "s2", prompt: "本地新建" } }];
    const conflicts = detectCanvasConflicts(pendingOps, remote, base);
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0].detail, /已存在/);
});

test("冲突检测：delete_h3_segment 远端已删 → no-op，不报冲突", () => {
    const base = makeProject([makeH3Node("h3-1", [
        { id: "s1", prompt: "A" },
        { id: "s2", prompt: "B" },
    ])]);
    const remote = makeProject([makeH3Node("h3-1", [{ id: "s1", prompt: "A" }])]);
    const pendingOps = [{ type: "delete_h3_segment", nodeId: "h3-1", segmentId: "s2" }];
    assert.deepEqual(detectCanvasConflicts(pendingOps, remote, base), []);
});

test("刷新恢复：较新的网页本地快照优先保留，随后按远端 revision 同步", () => {
    const remote = makeProject([], { updatedAt: "2026-01-01T00:00:01.000Z" });
    const local = makeProject([makeH3Node("h3-1", [{ id: "s1", prompt: "网页刚改" }])], { updatedAt: "2026-01-01T00:00:02.000Z" });
    assert.equal(isLocalProjectNewer(local, remote), true);
    assert.equal(isLocalProjectNewer(remote, local), false);
});

test("刷新恢复：同一时间戳但内容不同不把不明快照当成网页编辑", () => {
    const remote = makeProject([], { updatedAt: "2026-01-01T00:00:01.000Z" });
    const local = makeProject([makeH3Node("h3-1", [{ id: "s1", prompt: "未知旧快照" }])], { updatedAt: "2026-01-01T00:00:01.000Z" });
    assert.equal(isLocalProjectNewer(local, remote), false);
});

test("刷新恢复：revision 更新后的远端不能被旧网页快照重新提交覆盖", () => {
    const remote = makeProject([], { revision: 2, updatedAt: "2026-01-01T00:00:02.000Z" });
    const stale = makeProject([makeH3Node("h3-1", [{ id: "s1", duration: 9 }])], { revision: 1, updatedAt: "2026-01-01T00:00:01.000Z" });
    assert.equal(isLocalProjectNewer(stale, remote), false);
});

test("刷新恢复：远端已推进但本地随后编辑，保留未提交网页修改", () => {
    const remote = makeProject([], { revision: 2, updatedAt: "2026-01-01T00:00:02.000Z" });
    const local = makeProject([makeH3Node("h3-1", [{ id: "s1", duration: 6 }])], { revision: 1, updatedAt: "2026-01-01T00:00:03.000Z" });
    assert.equal(isLocalProjectNewer(local, remote), true);
});

test("MCP 内容 diff 忽略浏览器视口变化", () => {
    const base = makeProject([]);
    const movedViewport = makeProject([], { viewport: { x: 480, y: -220, k: 0.72 } });
    assert.deepEqual(diffCanvasProject(base, movedViewport), []);
});

test("Backend 差量事件只回放节点和连线，保留当前页面 viewport", () => {
    const base = makeProject([], { revision: 3, viewport: { x: 120, y: -80, k: 0.65 } });
    const next = applyBackendCanvasDelta(base, [
        { type: "add_node", id: "image-1", nodeType: "image", title: "结果", position: { x: 96, y: 0 }, width: 340, height: 240, metadata: { url: "media-1" } },
        { type: "connect_nodes", id: "connection-1", fromNodeId: "source-1", toNodeId: "image-1" },
    ], 4, "2026-01-01T00:00:04Z");

    assert.equal(next.revision, 4);
    assert.equal(next.updatedAt, "2026-01-01T00:00:04Z");
    assert.deepEqual(next.viewport, base.viewport);
    assert.equal(next.nodes[0].id, "image-1");
    assert.equal((next.nodes[0].metadata as unknown as Record<string, unknown>)?.url, "media-1");
    assert.deepEqual(next.connections, [{ id: "connection-1", fromNodeId: "source-1", toNodeId: "image-1" }]);
    assert.deepEqual(base.nodes, []);
    assert.deepEqual(base.connections, []);
});

test("Backend 差量事件支持 metadata 删除和 H3 单段回放", () => {
    const base = makeProject([makeH3Node("h3-1", [{ id: "s1", prompt: "原文", status: "loading", runtimeTaskId: "task-1" }], { status: "loading", errorDetails: "旧错误" })], { revision: 7 });
    const next = applyBackendCanvasDelta(base, [
        { type: "update_node", id: "h3-1", metadata: { status: "success" }, metadataDelete: ["errorDetails"] },
        { type: "update_h3_segment", nodeId: "h3-1", segmentId: "s1", patch: { prompt: "新文", status: "success" }, patchDelete: ["runtimeTaskId"] },
    ], 8);
    const node = next.nodes[0];
    const metadata = node.metadata as unknown as Record<string, any>;
    const baseMetadata = base.nodes[0].metadata as unknown as Record<string, any>;

    assert.equal(metadata.status, "success");
    assert.equal("errorDetails" in metadata, false);
    assert.deepEqual(metadata.segments, [{ id: "s1", prompt: "新文", status: "success" }]);
    assert.equal(baseMetadata.status, "loading");
    assert.equal(baseMetadata.segments?.[0]?.prompt, "原文");
});
