/**
 * 新节点自动寻位（findFreeNodePosition）回归测试。
 *
 * 运行（web 目录下；web 自身没装 tsx，借 backend 的 loader）：
 *   node --import ../backend/node_modules/tsx/dist/loader.mjs --test src/lib/canvas/canvas-node-placement.test.ts
 *
 * 覆盖实际会被用户看到的三类问题：连续新建叠在同一个点、显式坐标撞车后跑到很远、视口内明明有空位却放到屏幕外。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { findFreeNodePosition, NODE_PLACEMENT_GAP, type PlacementRect } from "@/lib/canvas/canvas-node-placement";

const rect = (x: number, y: number, width: number, height: number, id?: string): PlacementRect & { id?: string } => ({ id, x, y, width, height });

/** 落位结果与所有障碍都保持 gap 净距。 */
const assertNoOverlap = (pos: { x: number; y: number }, size: { width: number; height: number }, obstacles: Array<PlacementRect & { id?: string }>) => {
    for (const obstacle of obstacles) {
        const overlapX = pos.x < obstacle.x + obstacle.width + NODE_PLACEMENT_GAP && pos.x + size.width + NODE_PLACEMENT_GAP > obstacle.x;
        const overlapY = pos.y < obstacle.y + obstacle.height + NODE_PLACEMENT_GAP && pos.y + size.height + NODE_PLACEMENT_GAP > obstacle.y;
        assert.ok(!(overlapX && overlapY), `新节点 (${pos.x}, ${pos.y}) 不应压住 ${obstacle.id ?? `${obstacle.x},${obstacle.y}`}`);
    }
};

test("期望位置空闲时原地落位", () => {
    const pos = findFreeNodePosition({
        desired: { x: 120, y: 80 },
        size: { width: 300, height: 200 },
        obstacles: [rect(1000, 1000, 300, 200, "far")],
    });
    assert.deepEqual(pos, { x: 120, y: 80 });
});

test("连续新建不会叠在一起：每次把上一个当成障碍再落位", () => {
    const size = { width: 300, height: 200 };
    const obstacles: Array<PlacementRect & { id?: string }> = [];
    const placed: Array<{ x: number; y: number }> = [];
    for (let index = 0; index < 6; index++) {
        const pos = findFreeNodePosition({ desired: { x: 0, y: 0 }, size, obstacles });
        placed.push(pos);
        obstacles.push(rect(pos.x, pos.y, size.width, size.height, `n${index}`));
    }
    placed.forEach((pos, index) => assertNoOverlap(pos, size, obstacles.slice(0, index)));
    assert.equal(new Set(placed.map((pos) => `${pos.x},${pos.y}`)).size, placed.length, "每次结果必须是不同的空位");
});

test("期望位置被占用时就近让开，不横向铺到很远", () => {
    const size = { width: 300, height: 200 };
    const obstacles = [rect(0, 0, 300, 200, "occupied")];
    const pos = findFreeNodePosition({ desired: { x: 0, y: 0 }, size, obstacles });
    assertNoOverlap(pos, size, obstacles);
    const distance = Math.hypot(pos.x, pos.y);
    assert.ok(distance <= Math.hypot(size.width + NODE_PLACEMENT_GAP, size.height + NODE_PLACEMENT_GAP) + 1, `应落在最近一圈，实际距离 ${distance}`);
    assert.ok(Math.abs(pos.x) <= size.width + NODE_PLACEMENT_GAP + 1 && Math.abs(pos.y) <= size.height + NODE_PLACEMENT_GAP + 1, "只挪动一个节点位，不横向铺开");
});

test("优先落在可见视口内：期望点在屏幕外时收进来", () => {
    const bounds = { x: 0, y: 0, width: 1200, height: 800 };
    const size = { width: 300, height: 200 };
    const pos = findFreeNodePosition({ desired: { x: -900, y: -700 }, size, obstacles: [], bounds });
    assert.ok(pos.x >= bounds.x && pos.y >= bounds.y, "落位坐标应在视口内");
    assert.ok(pos.x + size.width <= bounds.width && pos.y + size.height <= bounds.height, "节点应完整可见");
});

test("视口内的期望位置被占用时，换到视口内其它空位而不是去屏幕外", () => {
    const bounds = { x: 0, y: 0, width: 1000, height: 700 };
    const size = { width: 300, height: 200 };
    const obstacles = [rect(200, 200, 300, 200, "center")];
    const pos = findFreeNodePosition({ desired: { x: 200, y: 200 }, size, obstacles, bounds });
    assertNoOverlap(pos, size, obstacles);
    assert.ok(pos.x >= 0 && pos.y >= 0 && pos.x + size.width <= bounds.width && pos.y + size.height <= bounds.height, "仍应完整落在视口内");
});

test("视口挤满时才允许落到视口外，且依然不重叠", () => {
    const bounds = { x: 0, y: 0, width: 320, height: 220 };
    const size = { width: 300, height: 200 };
    const obstacles = [rect(0, 0, 300, 200, "filler")];
    const pos = findFreeNodePosition({ desired: { x: 0, y: 0 }, size, obstacles, bounds });
    assertNoOverlap(pos, size, obstacles);
});

test("尺寸悬殊：大节点不会压到附近的小节点", () => {
    const obstacles = [rect(0, 0, 120, 90, "small")];
    const size = { width: 900, height: 700 };
    const pos = findFreeNodePosition({ desired: { x: 0, y: 0 }, size, obstacles });
    assertNoOverlap(pos, size, obstacles);
});

test("excludeIds 排除自身：节点跟随自己原有位置时不把自己当成障碍", () => {
    const size = { width: 300, height: 200 };
    const obstacles = [rect(400, 300, 300, 200, "self"), rect(1200, 300, 300, 200, "other")];
    const pos = findFreeNodePosition({ desired: { x: 400, y: 300 }, size, obstacles, excludeIds: ["self"] });
    assert.deepEqual(pos, { x: 400, y: 300 });
});

test("gap 可调：紧凑模式只用更小的净距", () => {
    const size = { width: 300, height: 200 };
    const obstacles = [rect(0, 0, 300, 200, "occupied")];
    const tight = findFreeNodePosition({ desired: { x: 0, y: 0 }, size, obstacles, gap: 0 });
    assert.deepEqual(tight, { x: 0, y: 200 }, "gap=0 时应紧贴下侧");
    const loose = findFreeNodePosition({ desired: { x: 0, y: 0 }, size, obstacles, gap: 120 });
    assert.deepEqual(loose, { x: 0, y: 320 }, "gap=120 时按净距让开");
});

test("文档要求的净距默认值保持 48，与自动排布一致", () => {
    assert.equal(NODE_PLACEMENT_GAP, 48);
});
