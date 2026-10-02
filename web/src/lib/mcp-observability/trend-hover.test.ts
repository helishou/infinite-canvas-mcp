import test from "node:test";
import assert from "node:assert/strict";

import { clientToViewBox, trendHoverIndex } from "./trend-hover";

const chart = { width: 900, height: 300, padLeft: 64, padRight: 64 };

test("viewBox 被拉伸时屏幕坐标仍命中正确数据点", () => {
    // 容器实际渲染 450px 宽（缩放 0.5），数据点 0 的屏幕位置是 64 * 0.5 = 32。
    const rect = { left: 100, top: 50, width: 450, height: 150 };
    const probe = clientToViewBox(rect, chart, rect.left + 32, rect.top + 100);
    assert.equal(trendHoverIndex(probe.x, 3, chart), 0);

    // 命中最后一个数据点：viewBox x = 900 - 64 = 836 → 屏幕 418。
    const last = clientToViewBox(rect, chart, rect.left + 418, rect.top + 100);
    assert.equal(trendHoverIndex(last.x, 3, chart), 2);
});

test("落在绘图区之外不命中", () => {
    assert.equal(trendHoverIndex(10, 3, chart), -1);
    assert.equal(trendHoverIndex(890, 3, chart), -1);
    assert.equal(trendHoverIndex(450, 0, chart), -1);
});

test("单数据点只有落在绘图区宽度内才命中", () => {
    assert.equal(trendHoverIndex(450, 1, chart), 0);
    assert.equal(trendHoverIndex(10, 1, chart), -1);
    assert.equal(trendHoverIndex(890, 1, chart), -1);
});
