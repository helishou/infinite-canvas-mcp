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

import { applyCanvasAgentOps, arrangeGroupMembers, computeFlowLayout } from "@/lib/canvas/canvas-agent-ops";
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

test("块间货架打包：若干孤立小节横向填进空位，不各占一整行", () => {
    // 主块宽 1248（600 + 48 + 600）。若孤立点各占一行，块高度会多出三行。
    const nodes = [
        node("m0", "image", 0, 0, 600, 400),
        node("m1", "video", 900, 0, 600, 400),
        ...["s0", "s1", "s2", "s3"].map((id, index) => node(id, "text", 0, 2000 + index * 200, 200, 160)),
    ];
    const layout = layoutOf(nodes, [edge("m0", "m1")], true);
    const ids = ["s0", "s1", "s2", "s3"];
    const tops = ids.map((id) => layout.get(id)!.y);
    assert.equal(new Set(tops).size, 1, `4 个孤立小节应排在同一行（实际 y=${tops.join(",")}）`);
    const xs = ids.map((id) => layout.get(id)!.x);
    assert.equal(new Set(xs).size, 4, `孤立小节应沿水平方向依次铺开而不重叠（实际 x=${xs.join(",")}）`);
    // 仍与主块保持可见间距，不会糊成一团。
    const mainBottom = layout.get("m0")!.y + 400;
    assert.ok(Math.min(...tops) - mainBottom >= 100, `换行后的孤立小节应与主块保持可见纵向间距（实际=${Math.min(...tops) - mainBottom}）`);
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

// 大图散架回归：力导向版本在 40+ 节点上被全局斥力撑成 11000 × 16800（节点面积占比仅 2.8%），
// 相连节点中心距中位数 1344（约 4 倍节点高），本该水平的链在画布上斜穿几屏。改为分层正交后不得复现。
const bigFanGraph = (chains: number, length: number) => {
    const nodes: CanvasNodeData[] = [];
    const conns: CanvasConnection[] = [];
    for (let c = 0; c < chains; c++) {
        let prev = "";
        for (let s = 0; s < length; s++) {
            const isMedia = s % 3 === 2;
            const id = `F${c}_${s}`;
            nodes.push(node(id, isMedia ? "image" : "text", 0, 0, isMedia ? 640 : 220, isMedia ? 360 : 300));
            if (prev) conns.push(edge(prev, id));
            prev = id;
        }
        conns.push(edge(prev, "sink"));
    }
    nodes.push(node("sink", "video", 0, 0, 420, 236));
    return { nodes, conns };
};

test("大图不散架：并联链 + 汇聚点整理后紧凑、链严格水平、无边被拉长", () => {
    const { nodes, conns } = bigFanGraph(6, 6);
    const layout = layoutOf(nodes, conns, true);
    const rect = (id: string) => { const p = layout.get(id)!; const n = nodes.find((item) => item.id === id)!; return { x: p.x, y: p.y, w: p.width ?? n.width, h: p.height ?? n.height }; };
    const center = (id: string) => { const r = rect(id); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };

    // 1) 不重叠
    assert.equal(overlaps(nodes, layout).length, 0);

    // 2) 紧凑：节点面积占包围盒至少 40%，不能散成大片留白。
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach((item) => { const r = rect(item.id); minX = Math.min(minX, r.x); minY = Math.min(minY, r.y); maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h); });
    const nodeArea = nodes.reduce((sum, item) => sum + rect(item.id).w * rect(item.id).h, 0);
    const ratio = nodeArea / ((maxX - minX) * (maxY - minY));
    assert.ok(ratio >= 0.4, `节点面积占比=${(ratio * 100).toFixed(1)}% 应 ≥ 40%（散架时只有 2.8%）`);

    // 3) 链上相邻节点同行（dy 只允许行内垂直居中的微差，不允许错开一整行）。
    for (let c = 0; c < 6; c++) {
        for (let s = 0; s < 5; s++) {
            const dy = Math.abs(center(`F${c}_${s}`).y - center(`F${c}_${s + 1}`).y);
            assert.ok(dy <= 40, `F${c}_${s}->F${c}_${s + 1} 应同行（dy=${Math.round(dy)} 应 ≤ 40，散架时会是一个行高量级）`);
        }
    }

    // 4) 任何相连节点都不允许被拉到几屏之外（水平跨度不超过一个节点宽量级）。
    conns.forEach((c) => {
        const dx = Math.abs(center(c.fromNodeId).x - center(c.toNodeId).x);
        assert.ok(dx <= 700, `${c.fromNodeId}->${c.toNodeId} 水平跨度=${Math.round(dx)} 应在 700 以内`);
    });
});

test("重复整理幂等：同一张图连点两次整理布局，坐标不再变化", () => {
    const { nodes, conns } = bigFanGraph(4, 5);
    const first = layoutOf(nodes, conns, true);
    const moved = nodes.map((item) => {
        const p = first.get(item.id)!;
        return { ...item, position: { x: p.x, y: p.y }, width: p.width ?? item.width, height: p.height ?? item.height };
    });
    const second = layoutOf(moved, conns, true);
    nodes.forEach((item) => {
        const a = first.get(item.id)!, b = second.get(item.id)!;
        assert.ok(Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01, `${item.id} 第二次整理后位置应不变`);
    });
});

test("环不产生空层污染坐标：a→b→c→a 三节点闭环", () => {
    const nodes = [node("a", "image", 0, 0, 300, 200), node("b", "image", 0, 0, 300, 200), node("c", "image", 0, 0, 300, 200)];
    const layout = layoutOf(nodes, [edge("a", "b"), edge("b", "c"), edge("c", "a")], true);
    nodes.forEach((item) => {
        const p = layout.get(item.id)!;
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${item.id} 坐标应为有限值（空层曾导致 NaN）`);
    });
    assert.deepEqual(overlaps(nodes, layout), []);
});

/** 相邻两节点之间的水平净空隙（从 from 的右边界到 to 的左边界）。 */
const clearOf = (
    layout: Map<string, { x: number; y: number; width?: number; height?: number }>,
    nodes: CanvasNodeData[],
    from: string,
    to: string,
) => {
    const fromWidth = layout.get(from)!.width ?? nodes.find((item) => item.id === from)!.width;
    return Math.round(layout.get(to)!.x - (layout.get(from)!.x + fromWidth));
};

test("宽节点不撑列：同层有超宽节点时，另一条窄链的相邻节点仍只隔一个 gap", () => {
    // 曾经的实现给「整层」一个统一 x，层宽取层内最大宽 —— 于是层里只要有一个宽节点，
    // 同层其它窄链后面都被留出同宽的死空白，有关系的两个节点被顶到 1400+ 之外。
    const nodes = [
        node("root", "image", 0, 0, 340, 240),
        node("wideA", "image", 400, 0, 1600, 240), node("wideB", "image", 2100, 0, 1600, 240),
        node("thinA", "image", 400, 400, 200, 150), node("thinB", "image", 700, 400, 200, 150),
        node("sink", "video", 3800, 200, 420, 236),
    ];
    const conns = [
        edge("root", "wideA"), edge("wideA", "wideB"), edge("wideB", "sink"),
        edge("root", "thinA"), edge("thinA", "thinB"), edge("thinB", "sink"),
    ];
    const layout = layoutOf(nodes, conns, false);
    assert.equal(clearOf(layout, nodes, "thinA", "thinB"), 48, "窄链相邻节点应恰好相隔一个 gap");
    assert.equal(clearOf(layout, nodes, "wideA", "wideB"), 48, "宽链自身也不应被撑开");
    assert.deepEqual(overlaps(nodes, layout), []);
});

test("短链汇入长链：短链整体右移贴住汇合点，链内间距不变", () => {
    // 汇聚点只能待在最长链末端右侧，短链末端本来会被落在很左边（实测净空隙 1452）。
    // 修正后从源点出发的纯链会整体右移去贴合汇合点，链内间距仍是 48。
    const nodes = [
        node("s1", "image", 0, 0, 340, 240), node("a1", "image", 400, 0, 420, 236),
        node("b1", "image", 900, 0, 420, 236), node("c1", "image", 1400, 0, 420, 236),
        node("d1", "image", 1900, 0, 420, 236),
        node("s2", "image", 0, 400, 340, 240), node("a2", "image", 400, 400, 420, 236),
        node("sink", "video", 2400, 200, 420, 236),
    ];
    const conns = [
        edge("s1", "a1"), edge("a1", "b1"), edge("b1", "c1"), edge("c1", "d1"), edge("d1", "sink"),
        edge("s2", "a2"), edge("a2", "sink"),
    ];
    const layout = layoutOf(nodes, conns, false);
    assert.equal(clearOf(layout, nodes, "a2", "sink"), 48, "短链末端应贴住汇合点（原先被留在 1452 之外）");
    assert.equal(clearOf(layout, nodes, "s2", "a2"), 48, "右移不应破坏短链内部间距");
    assert.equal(clearOf(layout, nodes, "d1", "sink"), 48, "长链末端与汇合点仍应贴住");
    assert.deepEqual(overlaps(nodes, layout), []);
});

test("共享输入不被推远：源点扇出后两条链都仍贴着源点", () => {
    // 反向收紧只放行「从源点出发、沿途无分支」的链。源点一旦扇出，整条链就不许动，
    // 否则为了贴汇合点会把「共享输入 → 各下游」的边推远（实测会从 1 处长边变成 2 处）。
    const nodes = [
        node("base", "image", 0, 0, 340, 240),
        node("vidA", "image", 400, 0, 420, 236), node("upA", "image", 900, 0, 420, 236),
        node("h3", "image", 400, 400, 420, 236), node("vidB", "image", 900, 400, 420, 236),
        node("upB", "image", 1400, 400, 420, 236),
        node("sink", "video", 1900, 200, 420, 236),
    ];
    const conns = [
        edge("base", "vidA"), edge("vidA", "upA"), edge("upA", "sink"),
        edge("base", "h3"), edge("h3", "vidB"), edge("vidB", "upB"), edge("upB", "sink"),
    ];
    const layout = layoutOf(nodes, conns, false);
    assert.equal(clearOf(layout, nodes, "base", "vidA"), 48, "共享输入到第一路下游应贴住");
    assert.equal(clearOf(layout, nodes, "base", "h3"), 48, "共享输入到第二路下游应贴住");
    assert.deepEqual(overlaps(nodes, layout), []);
});

test("尺寸缺失的节点按规格默认尺寸补齐：不会被当成 0×0 排到同一行", () => {
    // 旧数据 / 外部写入的节点可能没有 width/height（或为 0）。不补齐的话行高会塌成 0、
    // 相邻节点只隔一个 gap，而画布按真实渲染尺寸显示时就直接压在一起（实测重叠 300×52）。
    const nodes = [
        node("p", "image", 0, 0, 300, 200),
        { id: "q0", type: "image", title: "q0", position: { x: 400, y: 0 }, metadata: {} },
        { id: "q1", type: "image", title: "q1", position: { x: 400, y: 100 }, metadata: {} },
        node("q2", "video", 400, 200, 0, 0),
    ] as unknown as CanvasNodeData[];
    const layout = layoutOf(nodes, [edge("p", "q0"), edge("p", "q1"), edge("p", "q2")], true);
    // 尺寸本身有效的节点沿用原尺寸（不回传）；尺寸缺失 / 为 0 的节点必须被补成规格默认尺寸。
    (["q0", "q1", "q2"] as const).forEach((id) => {
        const p = layout.get(id)!;
        assert.ok((p.width ?? 0) > 0 && (p.height ?? 0) > 0, `${id} 应拿到兜底尺寸（当前 ${p.width}x${p.height}）`);
    });
    nodes.forEach((item) => {
        const p = layout.get(item.id)!;
        assert.ok((p.width ?? item.width) > 0 && (p.height ?? item.height) > 0, `${item.id} 参与排布的尺寸应为正数`);
    });
    assert.deepEqual(overlaps(nodes, layout), []);
});

test("不压到选区外的节点：重排结果整体让开旁边的未选中节点", () => {
    // 整理只重排选中的节点，锚点又是原选区左上角；一旦重排后的范围比原选区更大，
    // 就会盖到未选中的邻居上 —— 用户看到的就是「整理后节点重叠」。结果应整体平移让开。
    const nodes = [
        ...Array.from({ length: 8 }, (_, i) => node(`s${i}`, "image", (i % 4) * 260, Math.floor(i / 4) * 240, 300, 200)),
        node("out1", "image", 1100, 260, 300, 200),
        node("out2", "image", 300, 700, 300, 200),
    ];
    const conns = [edge("s0", "s1"), edge("s1", "s2")];
    const selectedIds = nodes.filter((item) => item.id !== "out1" && item.id !== "out2").map((item) => item.id);
    const layout = computeFlowLayout({
        nodes, connections: conns, ids: selectedIds, scopeEdges: true,
        anchorX: 0, anchorY: 0, normalizeSizes: true,
    });
    const rects = [...layout.entries()].map(([id, pos]) => {
        const item = nodes.find((node) => node.id === id)!;
        return { id, x: pos.x, y: pos.y, w: pos.width ?? item.width, h: pos.height ?? item.height };
    });
    const overlapOf = (
        a: { x: number; y: number; w: number; h: number },
        b: { x: number; y: number; w: number; h: number },
    ) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
    nodes.filter((item) => !layout.has(item.id)).forEach((item) => {
        const rect = { x: item.position.x, y: item.position.y, w: item.width, h: item.height };
        const hit = rects.find((other) => overlapOf(other, rect));
        assert.ok(!hit, `整理结果压住了未选中节点 ${item.id}（被 ${hit?.id} 压住）`);
    });
});

/** 整理一批选中的节点：ids 是选中节点，`useRegion` 对应画布入口的「整理后回到原区域」。 */
const arrangeSelected = (nodes: CanvasNodeData[], connections: CanvasConnection[], useRegion: boolean) => {
    const selected = nodes.filter((item) => item.type !== "blocker");
    const box = selected.reduce(
        (acc, item) => ({
            minX: Math.min(acc.minX, item.position.x),
            minY: Math.min(acc.minY, item.position.y),
            maxX: Math.max(acc.maxX, item.position.x + item.width),
            maxY: Math.max(acc.maxY, item.position.y + item.height),
        }),
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    );
    const layout = computeFlowLayout({
        nodes,
        connections,
        ids: selected.map((item) => item.id),
        scopeEdges: true,
        anchorX: box.minX,
        anchorY: box.minY,
        normalizeSizes: true,
        ...(useRegion ? { centerInPlace: true } : {}),
    });
    const rects = selected.map((item) => {
        const pos = layout.get(item.id)!;
        return { id: item.id, x: pos.x, y: pos.y, w: pos.width ?? item.width, h: pos.height ?? item.height };
    });
    const out = rects.reduce(
        (acc, rect) => ({
            minX: Math.min(acc.minX, rect.x),
            minY: Math.min(acc.minY, rect.y),
            maxX: Math.max(acc.maxX, rect.x + rect.w),
            maxY: Math.max(acc.maxY, rect.y + rect.h),
        }),
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    );
    return { layout, rects, box, out, centerDrift: { x: (out.minX + out.maxX) / 2 - (box.minX + box.maxX) / 2, y: (out.minY + out.maxY) / 2 - (box.minY + box.maxY) / 2 } };
};

test("整理选中的一部分：结果重心仍落在原选区中心", () => {
    // 锚点固定是选区左上角，整理后的形状又通常和原选区不同 —— 死锚左上角会让整块只朝右下方生长，
    // 用户看到的就是「整理完跑到了别的地方」。传 region 后结果应中心对齐回原选区。
    const nodes = [
        node("ref0", "image", 2400, 1800, 340, 240),
        node("ref1", "image", 2750, 1810, 340, 240),
        node("h3vid", "video", 2600, 2100, 420, 236),
        node("out", "video", 3100, 2090, 420, 236),
        node("note", "text", 2500, 2450, 300, 180),
    ];
    const conns = [edge("ref0", "h3vid"), edge("ref1", "h3vid"), edge("h3vid", "out")];
    const { centerDrift } = arrangeSelected(nodes, conns, true);
    assert.ok(Math.abs(centerDrift.x) < 1 && Math.abs(centerDrift.y) < 1, `重心漂移=${JSON.stringify(centerDrift)} 应≈0`);
});

test("孤立节点不排成细长一列：一堆无连接节点的形状贴近原选区", () => {
    // 货架换行判定曾把「上一块后的 tail gap」也算进行宽，于是每行的可用宽度凭空少一个 CLUSTER_GAP：
    // 实测选中 6 个 300×200 的孤立节点会被拉成 300×1800 的一列（原选区是 1060×680），看着就像搬了家。
    const nodes = Array.from({ length: 6 }, (_, i) => node(`g${i}`, "image", 1200 + (i % 3) * 260, 900 + Math.floor(i / 3) * 240, 300, 200));
    const { out, box } = arrangeSelected(nodes, [], true);
    assert.ok(out.maxX - out.minX >= 600, `整理后宽度=${Math.round(out.maxX - out.minX)} 应至少排得下两列（修复前只有 300）`);
    assert.ok(out.maxY - out.minY <= (box.maxY - box.minY) * 2, `整理后高度=${Math.round(out.maxY - out.minY)} 不应远超原选区高度 ${box.maxY - box.minY}`);
});

test("就近让开：上方有空位时不往下推整屏", () => {
    // 避让一度只往右 / 往下推：下方正好压着未选中节点时会被推到离原区域很远的地方。
    // 现在四个方向各求一次位移并取最短的，这里上方空着，应该就近往上抬。
    const nodes = [
        ...[0, 1, 2].map((i) => node(`p${i}`, "image", 3000 + i * 400, 1200, 300, 200)),
        node("below", "blocker", 3050, 1500, 1200, 400),
    ];
    const { rects, centerDrift } = arrangeSelected(nodes, [], true);
    const blocker = nodes.find((item) => item.id === "below")!;
    rects.forEach((rect) => {
        const clash =
            rect.x < blocker.position.x + blocker.width && rect.x + rect.w > blocker.position.x &&
            rect.y < blocker.position.y + blocker.height && rect.y + rect.h > blocker.position.y;
        assert.ok(!clash, `${rect.id} 压住了未选中节点 below`);
    });
    assert.ok(centerDrift.y < 0 && centerDrift.y > -500, `应就近往上抬（实际中心漂移 y=${Math.round(centerDrift.y)}，往下推会是 +1000 量级）`);
});

test("重复整理幂等（带 region）：连点两次整理布局坐标不再变化", () => {
    const nodes = [
        node("ref0", "image", 2400, 1800, 340, 240),
        node("ref1", "image", 2750, 1810, 340, 240),
        node("h3vid", "video", 2600, 2100, 420, 236),
        node("out", "video", 3100, 2090, 420, 236),
        node("note", "text", 2500, 2450, 300, 180),
        node("side", "blocker", 1200, 1200, 300, 200),
    ];
    const conns = [edge("ref0", "h3vid"), edge("ref1", "h3vid"), edge("h3vid", "out")];
    const first = arrangeSelected(nodes, conns, true);
    const moved = nodes.map((item) => {
        const pos = first.layout.get(item.id);
        if (!pos) return item;
        return { ...item, position: { x: pos.x, y: pos.y }, width: pos.width ?? item.width, height: pos.height ?? item.height };
    });
    const second = arrangeSelected(moved, conns, true);
    nodes.filter((item) => first.layout.has(item.id)).forEach((item) => {
        const a = first.layout.get(item.id)!;
        const b = second.layout.get(item.id)!;
        assert.ok(Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01, `${item.id} 第二次整理后位置应不变`);
    });
});

/** 组关系走 metadata.groupId（成员指向所属组节点），与画布运行时一致。 */
const groupedNode = (id: string, type: string, x: number, y: number, width: number, height: number, groupId?: string) =>
    ({ id, type, title: id, position: { x, y }, width, height, metadata: groupId ? { groupId } : {} }) as unknown as CanvasNodeData;

/** 直接按 ids 整理，等价于画布「整理布局」入口（scopeEdges + centerInPlace）。 */
const arrange = (nodes: CanvasNodeData[], connections: CanvasConnection[], ids: string[]) => {
    const positionOf = (id: string) => nodes.find((item) => item.id === id)!.position;
    const layout = computeFlowLayout({
        nodes,
        connections,
        ids,
        scopeEdges: true,
        anchorX: Math.min(...ids.map((id) => positionOf(id).x)),
        anchorY: Math.min(...ids.map((id) => positionOf(id).y)),
        normalizeSizes: true,
        centerInPlace: true,
    });
    const rectOf = (id: string) => {
        const item = nodes.find((node) => node.id === id)!;
        const pos = layout.get(id)!;
        return { x: pos.x, y: pos.y, width: pos.width ?? item.width, height: pos.height ?? item.height };
    };
    return { layout, rectOf };
};

const containsBox = (outer: ReturnType<ReturnType<typeof arrange>["rectOf"]>, inner: typeof outer) =>
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5;

const groupFixture = () => {
    const members = [
        groupedNode("m1", "image", 1060, 1080, 300, 200, "g1"),
        groupedNode("m2", "image", 1400, 1080, 300, 200, "g1"),
        groupedNode("m3", "text", 1200, 1350, 280, 160, "g1"),
    ];
    return { group: groupedNode("g1", "group", 1000, 1000, 760, 480), members, outside: node("out", "video", 1900, 1150, 420, 236) };
};

/** 跑一组 agent ops（等价于画布 Cache → Backend 之外的本地应用路径）。 */
const applyOps = (nodes: CanvasNodeData[], ops: Parameters<typeof applyCanvasAgentOps>[1], selectedNodeIds: string[] = []) =>
    applyCanvasAgentOps({ projectId: "p1", title: "画布", nodes, connections: [], selectedNodeIds }, ops);

test("生成组：组框包住所有被选中的节点，成员的 groupId 指向新组", () => {
    const nodes = [node("a", "image", 100, 100, 300, 200), node("b", "text", 500, 360, 280, 160), node("out", "video", 900, 100, 420, 236)];
    const { nodes: next, selectedNodeIds } = applyOps(nodes, [{ type: "create_group", memberIds: ["a", "b"] }]);
    const group = next.find((item) => item.type === "group");
    assert.ok(group, "应生成一个新组节点");
    assert.equal(selectedNodeIds.length, 1);
    assert.equal(selectedNodeIds[0], group!.id);
    // 组 = 成员包围盒 + 内边距；成员只要在内缩一个边距的范围内，就一定是被覆盖的。
    ["a", "b"].forEach((id) => {
        const member = next.find((item) => item.id === id)!;
        assert.equal(member.metadata?.groupId, group!.id, `${id} 应归属新组`);
        assert.ok(
            member.position.x >= group!.position.x
                && member.position.y >= group!.position.y
                && member.position.x + member.width <= group!.position.x + group!.width
                && member.position.y + member.height <= group!.position.y + group!.height,
            `组应覆盖 ${id}`,
        );
    });
    const untouched = next.find((item) => item.id === "out")!;
    assert.equal(untouched.metadata?.groupId, undefined, "未选中的节点不该被拉进组");
    // 层级由 DOM 顺序决定（同 z-index 下后者在上），组排在成员后面就会盖住成员的点击与拖动。
    const memberIndex = Math.min(...["a", "b"].map((id) => next.findIndex((item) => item.id === id)));
    assert.ok(next.findIndex((item) => item.id === group!.id) < memberIndex, "组应排在自己的成员之前（渲染在成员下面）");
});

test("生成组：成员离开旧组后，旧组按剩余成员收紧，成员被搬空则删除旧组", () => {
    const { group, members } = groupFixture();
    const nodes = [group, ...members, node("free", "text", 1800, 1080, 280, 160)];
    // 把 m1、m2 从旧组搬进新组：旧组只剩 m3，框应收紧到 m3；连同 m3 一起搬走时旧组空壳要删掉。
    const parted = applyOps(nodes, [{ type: "create_group", memberIds: ["m1", "m2"] }]).nodes;
    const kept = parted.find((item) => item.id === "g1")!;
    const left = parted.find((item) => item.id === "m3")!;
    assert.ok(left.position.x >= kept.position.x && left.position.x + left.width <= kept.position.x + kept.width, "旧组应收紧到剩余成员");
    assert.ok(kept.width < group.width, "旧组宽度应变小");
    assert.equal(parted.find((item) => item.id === "m1")!.metadata?.groupId !== "g1", true);

    const emptied = applyOps(nodes, [{ type: "create_group", memberIds: ["m1", "m2", "m3"] }]).nodes;
    assert.equal(emptied.some((item) => item.id === "g1"), false, "成员被搬空的旧组应删除，不留空壳");
});

test("生成组：组不套组，选中的组节点不会被收进新组", () => {
    const { group, members } = groupFixture();
    const nodes = [group, ...members];
    const next = applyOps(nodes, [{ type: "create_group", memberIds: ["g1", "m1", "m2"] }]).nodes;
    const created = next.find((item) => item.type === "group" && item.id !== "g1")!;
    assert.equal(next.find((item) => item.id === "g1")!.metadata?.groupId, undefined, "已有的组不应变成新组的成员");
    ["m1", "m2"].forEach((id) => assert.equal(next.find((item) => item.id === id)!.metadata?.groupId, created.id, `${id} 应归属新组`));
    // 只有组节点被选中时没有任何可用成员，不该凭空生成一个空组。
    const onlyGroup = applyOps(nodes, [{ type: "create_group", memberIds: ["g1"] }]).nodes;
    assert.equal(onlyGroup.length, nodes.length, "没有可用成员时不生成组");
});

test("组整理后仍覆盖自己的成员", () => {
    // 组是容器：之前组和成员被当成互不相干的两块各排各的，组跑到别处、成员也被排走。
    // 现在组不参与分层排布，成员落位后组框按「成员包围盒 + 内边距」重新生成 —— 覆盖关系是构造性成立的。
    const { group, members, outside } = groupFixture();
    const nodes = [group, ...members, outside];
    const { rectOf } = arrange(nodes, [edge("m1", "m2"), edge("m2", "out")], ["g1", "m1", "m2", "m3", "out"]);
    const box = rectOf("g1");
    members.forEach((member) => assert.ok(containsBox(box, rectOf(member.id)), `整理后组应覆盖成员 ${member.id}`));
});

test("只选中成员：整组跟着一起整理，组仍覆盖全部成员", () => {
    // 选中组里的某个成员去整理时，若不带上它所属的组，这个成员就会被排到组外 —— 组再也覆盖不住它。
    const { group, members, outside } = groupFixture();
    const nodes = [group, ...members, outside];
    const { layout, rectOf } = arrange(nodes, [edge("m1", "out")], ["m1", "out"]);
    assert.ok(layout.has("g1"), "选了成员就该带上它所属的组");
    assert.ok(layout.has("m2") && layout.has("m3"), "同组其它成员应随组一起排布");
    const box = rectOf("g1");
    members.forEach((member) => assert.ok(containsBox(box, rectOf(member.id)), `组应覆盖成员 ${member.id}`));
});

test("嵌套组：内层组先包住自己的成员，外层组再包住内层组", () => {
    const inner = groupedNode("g2", "group", 1100, 1150, 600, 400, "g1");
    const innerMembers = [groupedNode("i1", "image", 1150, 1250, 300, 200, "g2"), groupedNode("i2", "image", 1500, 1250, 300, 200, "g2")];
    const outerMember = groupedNode("m1", "image", 1060, 1080, 300, 200, "g1");
    const outer = groupedNode("g1", "group", 1000, 1000, 760, 480);
    const nodes = [outer, inner, ...innerMembers, outerMember];
    const { rectOf } = arrange(nodes, [], ["g1"]);
    const innerBox = rectOf("g2");
    const outerBox = rectOf("g1");
    innerMembers.forEach((member) => assert.ok(containsBox(innerBox, rectOf(member.id)), `内层组应覆盖 ${member.id}`));
    assert.ok(containsBox(outerBox, innerBox), "外层组应覆盖内层组");
    assert.ok(containsBox(outerBox, rectOf("m1")), "外层组应覆盖自己的直属成员");
});

test("空组没有成员可包：仍按普通节点参与排布", () => {
    const nodes = [groupedNode("gEmpty", "group", 1000, 1000, 760, 480), node("out", "video", 1900, 1150, 420, 236)];
    const { layout } = arrange(nodes, [], ["gEmpty", "out"]);
    const pos = layout.get("gEmpty")!;
    assert.ok(Number.isFinite(pos.x) && Number.isFinite(pos.y), "空组也应拿到有效坐标");
    assert.deepEqual(overlaps(nodes, layout), []);
});

test("重复整理幂等（含组）：组框重新生成后第二次坐标不再变化", () => {
    const { group, members, outside } = groupFixture();
    const nodes = [group, ...members, outside];
    const ids = ["g1", "m1", "m2", "m3", "out"];
    const first = arrange(nodes, [edge("m1", "m2"), edge("m2", "out")], ids);
    const moved = nodes.map((item) => {
        const pos = first.layout.get(item.id);
        if (!pos) return item;
        return { ...item, position: { x: pos.x, y: pos.y }, width: pos.width ?? item.width, height: pos.height ?? item.height };
    });
    const second = arrange(moved, [edge("m1", "m2"), edge("m2", "out")], ids);
    ids.forEach((id) => {
        const a = first.layout.get(id)!;
        const b = second.layout.get(id)!;
        assert.ok(Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01, `${id} 第二次整理后位置应不变`);
    });
});

/** 组内整理（工具栏「整理」）的输入：一个组框 + 若干带 groupId 的成员。 */
const arrangeGroup = (group: CanvasNodeData, members: CanvasNodeData[]) => {
    const nodes = [group, ...members];
    const layout = arrangeGroupMembers(group, nodes);
    return { nodes, layout, rectOf: (id: string) => layout.get(id)! };
};

const ratioOf = (size: { width: number; height: number }) => size.width / size.height;

test("组内整理：成员尺寸收进相近带宽，图片保持原宽高比，全部落在组框内", () => {
    const group = groupedNode("g1", "group", 0, 0, 1200, 900);
    const members = [
        groupedNode("m1", "image", 100, 100, 400, 300, "g1"),
        groupedNode("m2", "image", 600, 120, 300, 200, "g1"),
        groupedNode("m3", "video", 150, 500, 800, 300, "g1"),
    ];
    const { layout, rectOf } = arrangeGroup(group, members);
    const box = { x: group.position.x, y: group.position.y, width: group.width, height: group.height };
    members.forEach((member) => {
        const rect = rectOf(member.id);
        assert.ok(rect, `${member.id} 应该有排布结果`);
        assert.ok(containsBox(box, rect), `${member.id} 应排在组框范围内`);
        // 等比缩放：宽高比与整理前一致（四舍五入误差按 1% 容忍）。
        assert.ok(Math.abs(ratioOf(rect) - ratioOf(member)) / ratioOf(member) < 0.01, `${member.id} 宽高比应保持不变`);
    });
    // 相近尺寸：最大高度不应超过最小高度的两倍（与整理布局同一档带宽）。
    const heights = members.map((member) => rectOf(member.id).height);
    assert.ok(Math.max(...heights) <= Math.min(...heights) * 2, `尺寸应被收进相近档位，实际 ${heights.join("/")}`);
    // 顺序：原视觉第一行的 m1/m2 排在第二行的 m3 上方，行内按左到右。
    assert.equal(rectOf("m3").y > rectOf("m1").y, true, "原视觉顺序应保持：m3 在 m1/m2 下方");
    assert.equal(rectOf("m2").x > rectOf("m1").x, true, "同一行内应按左到右排列");
    // 成员之间不重叠。
    for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
            const a = rectOf(members[i].id);
            const b = rectOf(members[j].id);
            const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
            assert.equal(overlap, false, `${members[i].id} 与 ${members[j].id} 不应重叠`);
        }
    }
    assert.equal(layout.size, members.length);
});

test("组内整理：组框装不下时整体等比缩小，仍然不溢出组框", () => {
    const group = groupedNode("g1", "group", 500, 500, 800, 400);
    const members = [0, 1, 2].map((index) => groupedNode(`m${index}`, "image", 520 + index * 420, 560, 400, 300, "g1"));
    const { rectOf } = arrangeGroup(group, members);
    const box = { x: group.position.x, y: group.position.y, width: group.width, height: group.height };
    members.forEach((member) => {
        const rect = rectOf(member.id);
        assert.ok(rect.width < member.width && rect.height < member.height, `${member.id} 应被缩小以适配组框`);
        assert.ok(containsBox({ ...box, width: box.width + 6, height: box.height + 6 }, rect), `${member.id} 缩小后不应溢出组框`);
        assert.ok(Math.abs(ratioOf(rect) - ratioOf(member)) / ratioOf(member) < 0.02, `${member.id} 缩小后宽高比应保持`);
    });
});

test("组内整理：不因换行把成员缩过头（竖图 + 横图混排）", () => {
    // 按「当前规划的超标比例」一步缩到底会把这三个节点缩到原尺寸的 1/3；
    // 二分「能装下的最大比例」后应保留 6 成上下，组框大而成员被缩成缩略图是明显的体验倒退。
    const group = groupedNode("g1", "group", 0, 0, 1000, 700);
    const members = [
        groupedNode("v1", "image", 40, 60, 300, 600, "g1"),
        groupedNode("h1", "video", 400, 60, 640, 360, "g1"),
        groupedNode("v2", "image", 40, 700, 400, 800, "g1"),
    ];
    const { rectOf } = arrangeGroup(group, members);
    assert.ok(rectOf("h1").width > 640 * 0.5, `横图不应被缩过头，实际 ${rectOf("h1").width}`);
    assert.ok(rectOf("v2").height > 800 * 0.5, `竖图不应被缩过头，实际 ${rectOf("v2").height}`);
    const box = { x: 0, y: 0, width: 1000, height: 700 };
    members.forEach((member) => assert.ok(containsBox(box, rectOf(member.id)), `${member.id} 应排在组框内`));
});

test("组内整理：重复执行结果不变（幂等），非画面节点不被缩放", () => {
    const group = groupedNode("g1", "group", 0, 0, 1200, 900);
    const members = [
        groupedNode("m1", "image", 100, 100, 400, 300, "g1"),
        groupedNode("m2", "image", 600, 120, 300, 200, "g1"),
        groupedNode("t1", "text", 120, 700, 280, 160, "g1"),
    ];
    const first = arrangeGroup(group, members);
    // 文本节点保持原尺寸，只被挪位置。
    const text = first.rectOf("t1");
    assert.equal(text.width, 280);
    assert.equal(text.height, 160);
    const moved = first.nodes.map((item) => {
        const rect = first.layout.get(item.id);
        return rect ? { ...item, position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height } : item;
    });
    const second = arrangeGroupMembers(moved.find((item) => item.id === "g1")!, moved);
    members.forEach((member) => {
        const a = first.layout.get(member.id)!;
        const b = second.get(member.id)!;
        assert.equal(b.x, a.x, `${member.id} 第二次整理 x 应不变`);
        assert.equal(b.y, a.y, `${member.id} 第二次整理 y 应不变`);
        assert.equal(b.width, a.width, `${member.id} 第二次整理宽度应不变`);
        assert.equal(b.height, a.height, `${member.id} 第二次整理高度应不变`);
    });
});


