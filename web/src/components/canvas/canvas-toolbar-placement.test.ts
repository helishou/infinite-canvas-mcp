import assert from "node:assert/strict";
import test from "node:test";

import { overlapsNode, placeProductionCard } from "./canvas-toolbar-placement";

const CARD = { width: 280, height: 96 };
const CANVAS = { width: 1600, height: 900 };

test("右侧有空间时放右侧，且不压住节点自己", () => {
    const node = { left: 600, top: 400, width: 240, height: 180 };
    const { left, top } = placeProductionCard({ node, card: CARD, canvas: CANVAS });
    assert.equal(overlapsNode(left, top, CARD, node), false);
    assert.ok(left >= node.left + node.width, "应落在节点右侧");
});

test("右侧顶到边界时改放左侧", () => {
    const node = { left: 1300, top: 400, width: 240, height: 180 };
    const { left, top } = placeProductionCard({ node, card: CARD, canvas: CANVAS });
    assert.equal(overlapsNode(left, top, CARD, node), false);
    assert.ok(left + CARD.width <= node.left, "应落在节点左侧");
});

test("左右都没地方时放上方或下方，仍不压住节点", () => {
    // 节点横向铺满，两侧都放不下
    const node = { left: 100, top: 300, width: 1400, height: 200 };
    const { left, top } = placeProductionCard({ node, card: CARD, canvas: CANVAS });
    assert.equal(overlapsNode(left, top, CARD, node), false);
});

test("节点贴着画布顶部时不再压到节点内容上（旧实现会 clamp 到 72px 盖住节点）", () => {
    const node = { left: 100, top: 0, width: 1400, height: 200 };
    const { left, top } = placeProductionCard({ node, card: CARD, canvas: CANVAS });
    assert.equal(overlapsNode(left, top, CARD, node), false, `落点 ${left},${top} 不该与节点相交`);
    assert.ok(top >= node.top + node.height, "顶部放不下时应落到节点下方");
});

test("画布小到四边都放不下时，仍把卡片夹在画布内", () => {
    const node = { left: 0, top: 0, width: 400, height: 300 };
    const canvas = { width: 360, height: 260 };
    const { left, top } = placeProductionCard({ node, card: CARD, canvas });
    assert.ok(left >= 16 && left + CARD.width <= canvas.width - 16);
    assert.ok(top >= 16 && top + CARD.height <= canvas.height - 16);
});

test("结果取整，避免亚像素抖动", () => {
    const node = { left: 100.4, top: 200.6, width: 240.2, height: 180.8 };
    const { left, top } = placeProductionCard({ node, card: CARD, canvas: CANVAS });
    assert.equal(Number.isInteger(left), true);
    assert.equal(Number.isInteger(top), true);
});
