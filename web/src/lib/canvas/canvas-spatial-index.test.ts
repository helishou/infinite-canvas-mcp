import assert from "node:assert/strict";
import test from "node:test";

import { buildCanvasSpatialIndex, queryCanvasSpatialIndex } from "./canvas-spatial-index";

const item = (id: string, left: number, top: number, width = 100, height = 100) => ({ id, left, top, width, height });

test("空间索引只返回相交元素并保持画布节点顺序", () => {
    const items = [item("first", 0, 0), item("second", 2000, 0), item("third", 100, 100)];
    const index = buildCanvasSpatialIndex(items, (value) => ({ left: value.left, top: value.top, right: value.left + value.width, bottom: value.top + value.height }));

    assert.deepEqual(queryCanvasSpatialIndex(index, { left: -20, top: -20, right: 400, bottom: 400 }).map((value) => value.id), ["first", "third"]);
    assert.deepEqual(queryCanvasSpatialIndex(index, { left: 1900, top: -20, right: 2200, bottom: 400 }).map((value) => value.id), ["second"]);
});

test("超大元素进入溢出桶，不会在建索引时创建海量格子", () => {
    const giant = item("giant", 0, 0, 10_000_000, 10_000_000);
    const index = buildCanvasSpatialIndex([giant], (value) => ({ left: value.left, top: value.top, right: value.left + value.width, bottom: value.top + value.height }));

    assert.equal(index.buckets.size, 0);
    assert.deepEqual(queryCanvasSpatialIndex(index, { left: 9_999_000, top: 9_999_000, right: 10_001_000, bottom: 10_001_000 }).map((value) => value.id), ["giant"]);
});

test("低倍率跨越大量空格时回退遍历条目，结果与常规查询一致", () => {
    const items = [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 8_000, y: 4_000 },
        { id: "c", x: 16_000, y: 8_000 },
    ];
    const index = buildCanvasSpatialIndex(items, (item) => ({ left: item.x, top: item.y, right: item.x + 100, bottom: item.y + 100 }));
    assert.deepEqual(queryCanvasSpatialIndex(index, { left: -1_000, top: -1_000, right: 30_000, bottom: 30_000 }).map((item) => item.id), ["a", "b", "c"]);
});
