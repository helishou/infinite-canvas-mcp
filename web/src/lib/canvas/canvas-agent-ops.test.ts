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

test("无关节点分簇拉开：两条无连线链纵向间距明显大于块内行距", () => {
    const nodes = [
        node("inA", "image", 0, 0, 340, 240),
        node("outA", "video", 900, 0, 420, 236),
        node("inB", "image", 0, 600, 340, 240),
        node("outB", "video", 900, 600, 420, 236),
    ];
    const layout = layoutOf(nodes, [edge("inA", "outA"), edge("inB", "outB")], true);
    const gap = layout.get("inB")!.y - (layout.get("outA")!.y + 236);
    assert.ok(gap >= 100, `两条无关节点链的间距=${gap} 应明显大于块内行距(48)，一眼可分`);
});

test("连通节点聚拢：相连节点落在同一块且彼此靠近", () => {
    const nodes = [
        node("x", "image", 0, 0, 300, 200),
        node("y", "video", 0, 0, 300, 200),
        node("z", "video", 0, 0, 300, 200),
        node("iso", "text", 0, 0, 200, 120),
    ];
    const layout = layoutOf(nodes, [edge("x", "y"), edge("y", "z")], true);
    const clusterBottom = Math.max(layout.get("x")!.y, layout.get("y")!.y, layout.get("z")!.y) + 200;
    const isoTop = layout.get("iso")!.y;
    assert.ok(isoTop - clusterBottom >= 60, `孤立节点与连通簇间距=${isoTop - clusterBottom} 应被拉开`);
    assert.ok(Math.abs(centerOf(layout.get("x")!, 200) - centerOf(layout.get("z")!, 200)) < 60, "连通簇 x 与 z 应垂直接近（聚在同一块内）");
});

test("相连节点水平贴近：链上路相邻节点落在同一水平线", () => {
    const nodes = [0, 1, 2, 3, 4].map((i) => node(`n${i}`, "image", i * 400, i * 300, 300, 200));
    const layout = layoutOf(nodes, [0, 1, 2, 3].map((i) => edge(`n${i}`, `n${i + 1}`)), true);
    for (let i = 0; i < 4; i++) {
        const dy = Math.abs(centerOf(layout.get(`n${i}`)!, 200) - centerOf(layout.get(`n${i + 1}`)!, 200));
        assert.ok(dy < 1, `n${i}→n${i + 1} 应水平贴近（dy=${dy} 应≈0）`);
    }
});

const overlaps = (nodes: CanvasNodeData[], layout: Map<string, { x: number; y: number; width?: number; height?: number }>) => {
    const rects = nodes.map((n) => {
        const p = layout.get(n.id)!;
        return { id: n.id, x: p.x, y: p.y, w: p.width ?? n.width, h: p.height ?? n.height };
    });
    const bad: string[] = [];
    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i], b = rects[j];
            const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            if (ox > 0.5 && oy > 0.5) bad.push(`${a.id} <> ${b.id}`);
        }
    }
    return bad;
};

test("任意形状都不重叠：链/菱形/分叉/全连接/混合簇", () => {
    const shapes: Array<[CanvasNodeData[], CanvasConnection[]]> = [
        [[0, 1, 2, 3].map((i) => node(`c${i}`, "image", 0, 0, 300, 200)), [0, 1, 2].map((i) => edge(`c${i}`, `c${i + 1}`))],
        [[0, 1, 2, 3].map((i) => node(`d${i}`, "image", 0, 0, 300, 200)), [edge("d0", "d1"), edge("d0", "d2"), edge("d1", "d3"), edge("d2", "d3")]],
        [[0, 1, 2, 3].map((i) => node(`f${i}`, "image", 0, 0, 300, 200)), [edge("f0", "f1"), edge("f0", "f2"), edge("f0", "f3")]],
        [[0, 1, 2, 3].flatMap((i) => [node(`i${i}`, "image", 0, 0, 200, 120), node(`o${i}`, "image", 0, 0, 200, 120)]), [0, 1, 2, 3].flatMap((a) => [0, 1, 2, 3].map((b) => edge(`i${a}`, `o${b}`)))],
        [
            [node("x", "image", 0, 0, 200, 100), node("y", "image", 0, 0, 200, 100), node("z", "image", 0, 0, 200, 100), node("iso", "text", 0, 0, 400, 500), node("iso2", "text", 0, 0, 350, 450)],
            [edge("x", "y"), edge("y", "z")],
        ],
    ];
    shapes.forEach(([nodes, conns], idx) => {
        const layout = layoutOf(nodes, conns, true);
        const bad = overlaps(nodes, layout);
        assert.equal(bad.length, 0, `形状#${idx} 出现重叠: ${bad.join("; ")}`);
    });
});

test("相连节点两轴都靠近：菱形/分叉/链每条边的水平与垂直跨度都在一个节点尺寸量级", () => {
    const shapes: Array<[CanvasNodeData[], CanvasConnection[]]> = [
        [[0, 1, 2, 3].map((i) => node(`q${i}`, "image", 0, 0, 300, 200)), [edge("q0", "q1"), edge("q0", "q2"), edge("q1", "q3"), edge("q2", "q3")]],
        [[0, 1, 2, 3].map((i) => node(`r${i}`, "image", 0, 0, 300, 200)), [edge("r0", "r1"), edge("r0", "r2"), edge("r0", "r3")]],
        [[0, 1, 2, 3, 4].map((i) => node(`t${i}`, "image", 0, 0, 300, 200)), [0, 1, 2, 3].map((i) => edge(`t${i}`, `t${i + 1}`))],
    ];
    shapes.forEach(([nodes, conns], idx) => {
        const layout = layoutOf(nodes, conns, true);
        const center = (id: string) => { const p = layout.get(id)!; return { x: p.x + (p.width ?? 300) / 2, y: p.y + (p.height ?? 200) / 2 }; };
        conns.forEach((c) => {
            const a = center(c.fromNodeId), b = center(c.toNodeId);
            const dx = Math.round(Math.abs(a.x - b.x)), dy = Math.round(Math.abs(a.y - b.y));
            assert.ok(dx <= 520, `形状#${idx} ${c.fromNodeId}->${c.toNodeId} 水平跨度=${dx} 应在一个节点尺寸量级`);
            assert.ok(dy <= 520, `形状#${idx} ${c.fromNodeId}->${c.toNodeId} 垂直跨度=${dy} 应在一个节点尺寸量级`);
        });
    });
});

