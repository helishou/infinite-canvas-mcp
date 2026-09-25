import test from "node:test";
import assert from "node:assert/strict";

import { compareByNumber, isMissing, numberSorter, sortRows, stringSorter } from "./table-sort";

const rows = [
    { tool: "canvas_read", calls: 5, p95: 300 },
    { tool: "canvas_apply", calls: 1, p95: null },
    { tool: "assets_list", calls: 3, p95: 100 },
];

test("数值升序把有效值按小到大排", () => {
    assert.deepEqual([5, 1, 3].sort(numberSorter("ascend")), [1, 3, 5]);
});

test("数值降序把有效值按大到小排", () => {
    assert.deepEqual([5, 1, 3].sort(numberSorter("descend")), [5, 3, 1]);
});

test("缺失值恒在末尾，不随升降序翻转", () => {
    assert.deepEqual([null, 3, undefined, 1].sort(numberSorter("ascend")), [1, 3, null, undefined]);
    assert.deepEqual([null, 3, undefined, 1].sort(numberSorter("descend")), [3, 1, null, undefined]);
});

test("NaN 与非数值按缺失处理，不破坏排序稳定性", () => {
    assert.deepEqual([NaN, 2, "x", 1].sort(numberSorter("ascend")), [1, 2, NaN, "x"]);
});

test("两端都缺失视为相等", () => {
    assert.equal(compareByNumber(null, undefined), 0);
    assert.equal(compareByNumber(null, NaN), 0);
});

test("isMissing 覆盖 null/undefined/NaN/空串，不误伤 0", () => {
    assert.equal(isMissing(null), true);
    assert.equal(isMissing(undefined), true);
    assert.equal(isMissing(NaN), true);
    assert.equal(isMissing(""), true);
    assert.equal(isMissing(0), false);
    assert.equal(isMissing("assets_list"), false);
});

test("未选择排序时不改变顺序", () => {
    assert.deepEqual([3, 1, 2].sort(numberSorter(null)), [1, 2, 3]);
});

test("工具名按中文排序，缺失恒在末尾", () => {
    assert.deepEqual(["canvas_read", "canvas_apply", "assets_list"].sort(stringSorter), ["assets_list", "canvas_apply", "canvas_read"]);
    assert.equal(stringSorter(undefined, undefined), 0);
    assert.equal(stringSorter(null, "assets_list") > 0, true);
});

test("sortRows 升序按列排序", () => {
    assert.deepEqual(sortRows(rows, "calls", "ascend", numberSorter("ascend")).map((row) => row.calls), [1, 3, 5]);
});

test("sortRows 降序仍把缺失行留在末尾", () => {
    assert.deepEqual(sortRows(rows, "p95", "descend", numberSorter("ascend")).map((row) => row.p95), [300, 100, null]);
});

test("sortRows 不修改原数组", () => {
    const source = [...rows];
    sortRows(source, "calls", "descend", numberSorter("ascend"));
    assert.deepEqual(source, rows);
});

test("sortRows 无排序键或无方向时保持原顺序", () => {
    assert.deepEqual(sortRows(rows, null, "ascend", numberSorter("ascend")), rows);
    assert.deepEqual(sortRows(rows, "calls", null, numberSorter("ascend")), rows);
});
