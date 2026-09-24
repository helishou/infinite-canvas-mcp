import assert from "node:assert/strict";
import test from "node:test";
import { buildCanvasConflictBaseline, isCanvasConflictBaseline, CANVAS_CONFLICT_BASELINE_VERSION } from "./canvas-conflict-baseline";

const project = {
    id: "p1", title: "婚书未烬·第1集", revision: 42, createdAt: "2026-01-01", updatedAt: "2026-01-02",
    nodes: [
        { id: "n1", type: "config", title: "生图", position: { x: 1, y: 2 }, width: 320, height: 240,
          metadata: { prompt: "镜头1", segments: [{ id: "s1", prompt: "段1", status: "idle" }],
                      images: [{ id: "i1", storageKey: "image:aa", generationSnapshot: { big: "x".repeat(5000) } }] } },
        { id: "n2", type: "text", title: "未被触碰", position: { x: 9, y: 9 }, width: 100, height: 100,
          metadata: { content: "y".repeat(20000) } },
    ],
    connections: [
        { id: "c1", fromNodeId: "n1", toNodeId: "n2", role: "reference", order: 0 },
        { id: "c2", fromNodeId: "n2", toNodeId: "n1", role: "reference", order: 1 },
    ],
    chatSessions: [{ id: "s1" }], activeChatId: "s1", backgroundMode: "lines", showImageInfo: false,
    globalPrompt: "", viewport: { x: 0, y: 0, k: 1 }, selectedNodeIds: ["n1"],
} as any;

test("只带 op 作用域内的节点，值原样保留（含 segments 与 generationSnapshot）", () => {
    const ops = [{ type: "update_node", id: "n1", metadata: { prompt: "新" } }];
    const base = buildCanvasConflictBaseline(project, ops);

    assert.equal(base.v, CANVAS_CONFLICT_BASELINE_VERSION);
    assert.equal(base.id, "p1");
    assert.equal(base.title, "婚书未烬·第1集");
    assert.equal(base.revision, 42, "revision 必须保留（冷启动恢复依赖它）");
    assert.equal(base.nodes.length, 1);
    assert.equal(base.nodes[0].id, "n1");
    // 值原样：segments 结构完整（H3 细粒度 op 要按字段比对）
    assert.deepEqual(base.nodes[0].metadata.segments, [{ id: "s1", prompt: "段1", status: "idle" }]);
    assert.equal(base.nodes[0].metadata.images[0].generationSnapshot.big.length, 5000, "作用域内的值不得被改写");
    // 未被 op 触碰的节点绝不出现（体积在这里省下来）
    assert.equal(base.nodes.some((node: any) => node.id === "n2"), false);
    assert.equal(JSON.stringify(base).includes("y".repeat(100)), false);
    assert.ok(JSON.stringify(base).length < 7000, `不该带无关节点，实际 ${JSON.stringify(base).length}`);
});

test("按 op 类型收窄连接与项目字段", () => {
    const del = buildCanvasConflictBaseline(project, [{ type: "delete_connections", ids: ["c1"] }]);
    assert.deepEqual(del.connections, [{ id: "c1", fromNodeId: "n1", toNodeId: "n2", role: "reference", order: 0 }]);
    assert.equal(del.connections.some((c: any) => c.id === "c2"), false);

    const upd = buildCanvasConflictBaseline(project, [{ type: "update_project", patch: { title: "新名" } }]);
    assert.equal(upd.title, "婚书未烬·第1集", "须保留旧值供比对");
    assert.equal(upd.nodes.length, 0);
    assert.equal(upd.connections.length, 0);
});

test("H3 段 op 带上 nodeId 指向的节点", () => {
    const base = buildCanvasConflictBaseline(project, [{ type: "update_h3_segment", nodeId: "n1", segmentId: "s1", patch: { prompt: "改" } }]);
    assert.equal(base.nodes.length, 1);
    assert.equal(base.nodes[0].id, "n1");
    assert.deepEqual(base.nodes[0].metadata.segments, [{ id: "s1", prompt: "段1", status: "idle" }]);
});

test("add_node / delete_node 也按 op.id 收窄", () => {
    assert.equal(buildCanvasConflictBaseline(project, [{ type: "delete_node", id: "n1" }]).nodes.length, 1);
    assert.equal(buildCanvasConflictBaseline(project, [{ type: "add_node", id: "n9" }]).nodes.length, 0);
});

test("运行时判别新旧格式", () => {
    const slim = buildCanvasConflictBaseline(project, [{ type: "update_node", id: "n1", metadata: { prompt: "x" } }]);
    assert.equal(isCanvasConflictBaseline(slim), true);
    assert.equal(isCanvasConflictBaseline(project), false, "完整画布不带 v 标记");
    assert.equal(isCanvasConflictBaseline(undefined), false);
    assert.equal(isCanvasConflictBaseline(null), false);
});

test("不修改入参且不保留原对象引用（可安全落盘）", () => {
    const before = JSON.stringify(project);
    const base = buildCanvasConflictBaseline(project, [{ type: "update_node", id: "n1", metadata: { prompt: "x" } }]);
    assert.equal(JSON.stringify(project), before);
    assert.notEqual(base.nodes[0], project.nodes[0], "应复制，避免后续编辑串改基线");
});
