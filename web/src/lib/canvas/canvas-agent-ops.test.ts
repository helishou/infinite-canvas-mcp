/**
 * 整理布局（computeFlowLayout）回归测试。
 *
 * 运行（web 目录下，借 backend 的 tsx）：
 *   ../backend/node_modules/.bin/tsx --test src/lib/canvas/canvas-agent-ops.test.ts
 *
 * 覆盖两条曾经踩过的坑：
 * 1) 输出被拉到顶部：纵向按「层内序号顺排」时，输入在下方的链路，输出会堆在 anchorY 附近。
 * 2) 尺寸悬殊：同批节点高度差过大，整理后画布视觉杂乱。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { computeFlowLayout } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

const node = (id: string, type: string, x: number, y: number, width: number, height: number) =>
    ({ id, type, title: id, position: { x, y }, width, height, metadata: {} }) as unknown as CanvasNodeData;

const edge = (fromNodeId: string, toNodeId: string) =>
    ({ id: `${fromNodeId}->${toNodeId}`, fromNodeId, toNodeId }) as CanvasConnection;

const layoutOf = (nodes: CanvasNodeData[], connections: CanvasConnection[], normalizeSizes: boolean) =>
    computeFlowLayout({ nodes, connections, ids: nodes.map((item) => item.id), scopeEdges: true, anchorX: 0, anchorY: 0, normalizeSizes });

const centerOf = (pos: { y: number }, height: number) => pos.y + height / 2;

test("输出跟随输入：下方链的输出不会被拉到顶部", () => {
    const nodes = [
        node("inA", "image", 0, 0, 340, 240),
        node("outA", "video", 900, 0, 420, 236),
        node("inB", "image", 0, 600, 340, 240),
        node("outB", "video", 900, 600, 420, 236),
    ];
    const layout = layoutOf(nodes, [edge("inA", "outA"), edge("inB", "outB")], true);
    const outATop = layout.get("outA")!.y;
    const outBTop = layout.get("outB")!.y;
    // 两条链保持上下次序，且下链的输出中心与下链输入中心一致。
    assert.ok(outBTop > outATop, "下链应排在上链下方");
    assert.equal(Math.round(centerOf(layout.get("outB")!, 236) - centerOf(layout.get("inB")!, 240)), 0);
});

test("输入输出落在同一水平线：4 张参考图 → 4 个成片", () => {
    const step = 288;
    const inputs = [0, 1, 2, 3].map((index) => node(`img${index}`, "image", 0, index * step, 340, 240));
    const outputs = [0, 1, 2, 3].map((index) => node(`out${index}`, "video", 900, 0, 420, 236));
    const layout = layoutOf([...inputs, ...outputs], inputs.map((input, index) => edge(input.id, outputs[index].id)), true);
    inputs.forEach((input, index) => {
        const offset = centerOf(layout.get(outputs[index].id)!, 236) - centerOf(layout.get(input.id)!, 240);
        assert.equal(Math.round(offset), 0, `${input.id} → ${outputs[index].id} 应垂直居中对齐`);
    });
});

test("输入行距小于输出行距时不产生累积下漂", () => {
    const step = 150;
    const inputs = [0, 1, 2, 3].map((index) => node(`crowd-in${index}`, "image", 0, index * step, 200, 150));
    const outputs = [0, 1, 2, 3].map((index) => node(`crowd-out${index}`, "video", 900, 0, 420, 236));
    const layout = layoutOf([...inputs, ...outputs], inputs.map((input, index) => edge(input.id, outputs[index].id)), false);
    inputs.forEach((input, index) => {
        const offset = centerOf(layout.get(outputs[index].id)!, 236) - centerOf(layout.get(input.id)!, 150);
        assert.equal(Math.round(offset), 0, `第 ${index} 行输入输出应同行，不应逐行漂移`);
    });
});

test("尺寸归一化：组内最大高度不超过最小高度的两倍", () => {
    const nodes = [
        node("tiny", "image", 0, 0, 200, 100),
        node("normal", "image", 0, 0, 400, 240),
        node("huge", "image", 0, 0, 900, 500),
    ];
    const layout = layoutOf(nodes, [], true);
    const heights = nodes.map((item) => layout.get(item.id)?.height ?? item.height);
    assert.ok(Math.max(...heights) / Math.min(...heights) <= 2, `最大/最小 = ${Math.max(...heights) / Math.min(...heights)}`);
    // 宽高比不得改变。
    nodes.forEach((item) => {
        const pos = layout.get(item.id);
        if (!pos?.width || !pos.height) return;
        assert.ok(Math.abs(pos.width / pos.height - item.width / item.height) < 0.02, `${item.id} 宽高比应保持不变`);
    });
});

test("非画面节点不参与尺寸归一化", () => {
    const nodes = [
        node("img", "image", 0, 0, 400, 240),
        node("video", "video", 0, 0, 420, 236),
        node("note", "text", 0, 0, 300, 300),
        node("cfg", "config", 0, 0, 300, 400),
    ];
    const layout = layoutOf(nodes, [], true);
    assert.equal(layout.get("note")?.width, undefined);
    assert.equal(layout.get("cfg")?.height, undefined);
});

test("尺寸已合规时不产生尺寸写回", () => {
    const nodes = [node("a", "image", 0, 0, 400, 240), node("b", "image", 0, 0, 400, 220)];
    const layout = layoutOf(nodes, [], true);
    nodes.forEach((item) => {
        assert.equal(layout.get(item.id)?.width, undefined, `${item.id} 不应被改动`);
        assert.equal(layout.get(item.id)?.height, undefined, `${item.id} 不应被改动`);
    });
});

test("未开启归一化时不改动任何尺寸", () => {
    const nodes = [node("a", "image", 0, 0, 200, 100), node("b", "image", 0, 0, 900, 500)];
    const layout = layoutOf(nodes, [], false);
    nodes.forEach((item) => assert.equal(layout.get(item.id)?.width, undefined));
});
