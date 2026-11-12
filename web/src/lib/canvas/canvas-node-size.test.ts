import assert from "node:assert/strict";
import test from "node:test";

import { fitImageNodeSize, isAspectLockedImageNode } from "./canvas-node-size";

const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 0.001, message || `${actual} != ${expected}`);
const CONFIG = { defaultWidth: 420, defaultHeight: 540 };
const IMAGE = { defaultWidth: 340, defaultHeight: 240 };

test("竖图换横图后节点不会缩成一条", () => {
    // 智能节点默认 420×540，先换 9:16 图（按默认包围盒内接），再换 16:9 图。
    const portrait = fitImageNodeSize({ width: 420, height: 540, mediaWidth: 1080, mediaHeight: 1920, ...CONFIG });
    assert.ok(portrait);
    close(portrait.width, 303.75);
    close(portrait.height, 540);
    close(portrait.width * portrait.height, 303.75 * 540);

    const landscape = fitImageNodeSize({ width: portrait.width, height: portrait.height, mediaWidth: 1920, mediaHeight: 1080, ...CONFIG });
    assert.ok(landscape);
    close(landscape.width, portrait.height);
    close(landscape.height, portrait.width);
    // 内接缩放会得到 304×171；面积不变换形必须保住体量。
    assert.ok(landscape.width > 500 && landscape.height > 300, `${landscape.width}×${landscape.height}`);
});

test("换形保持面积并贴合新图比例", () => {
    const size = fitImageNodeSize({ width: 304, height: 540, mediaWidth: 1920, mediaHeight: 1080, ...CONFIG });
    assert.ok(size);
    close(size.width * size.height, 304 * 540);
    close(size.width / size.height, 1920 / 1080);
});

test("横图换竖图与竖图换横图对称", () => {
    const back = fitImageNodeSize({ width: 640, height: 360, mediaWidth: 1080, mediaHeight: 1920, ...CONFIG });
    assert.ok(back);
    close(back.width, 360);
    close(back.height, 640);
});

test("同比例再适配一次尺寸不变", () => {
    const first = fitImageNodeSize({ width: 420, height: 540, mediaWidth: 1920, mediaHeight: 1080, ...CONFIG });
    assert.ok(first);
    const second = fitImageNodeSize({ width: first.width, height: first.height, mediaWidth: 1920, mediaHeight: 1080, ...CONFIG });
    assert.ok(second);
    close(second.width, first.width);
    close(second.height, first.height);
});

test("仍占默认尺寸的新节点按内接适配，不越过占位", () => {
    const size = fitImageNodeSize({ width: 420, height: 540, mediaWidth: 1920, mediaHeight: 1080, ...CONFIG });
    assert.ok(size);
    close(size.width, 420);
    close(size.height, 236.25);
});

test("被旧算法缩小的节点在下次加载回到标准体量", () => {
    // 旧内接算法把 16:9 图压成 304×171；标准体量应为 420×236.25。
    const size = fitImageNodeSize({ width: 304, height: 171, mediaWidth: 1920, mediaHeight: 1080, ...CONFIG });
    assert.ok(size);
    close(size.width, 420);
    close(size.height, 236.25);
});

test("手动缩放过就只沿用当前面积，不再被默认包围盒抬升", () => {
    const size = fitImageNodeSize({ width: 200, height: 200, mediaWidth: 1920, mediaHeight: 1080, ...CONFIG, userSized: true });
    assert.ok(size);
    close(size.width * size.height, 200 * 200);
    close(size.width / size.height, 1920 / 1080);
});

test("手动缩放后即使尺寸正好是默认值也不回到内接", () => {
    const size = fitImageNodeSize({ width: 420, height: 540, mediaWidth: 1920, mediaHeight: 1080, ...CONFIG, userSized: true });
    assert.ok(size);
    close(size.width * size.height, 420 * 540);
    assert.ok(size.width > 420, `${size.width}`);
});

test("图片节点用自身默认包围盒判断内接", () => {
    const size = fitImageNodeSize({ width: 340, height: 240, mediaWidth: 1080, mediaHeight: 1920, ...IMAGE });
    assert.ok(size);
    close(size.width, 135);
    close(size.height, 240);
});

test("极端画幅把短边抬到手动缩放下限", () => {
    const size = fitImageNodeSize({ width: 120, height: 120, mediaWidth: 512, mediaHeight: 2048, ...CONFIG, userSized: true });
    assert.ok(size);
    close(Math.min(size.width, size.height), 120);
    close(size.width / size.height, 512 / 2048);
});

test("非法输入返回 null 而不是产出 NaN", () => {
    assert.equal(fitImageNodeSize({ width: 0, height: 540, mediaWidth: 1920, mediaHeight: 1080, ...CONFIG }), null);
    assert.equal(fitImageNodeSize({ width: 420, height: 540, mediaWidth: Number.NaN, mediaHeight: 1080, ...CONFIG }), null);
    assert.equal(fitImageNodeSize({ width: 420, height: 540, mediaWidth: 1920, mediaHeight: 0, ...CONFIG }), null);
});

test("智能图片节点与自由缩放图片节点的判定", () => {
    assert.equal(isAspectLockedImageNode({ type: "config", metadata: { smart: true } }), true);
    assert.equal(isAspectLockedImageNode({ type: "config", metadata: { smart: true, generationMode: "image" } }), true);
    assert.equal(isAspectLockedImageNode({ type: "config", metadata: { smart: true, generationMode: "video" } }), false);
    assert.equal(isAspectLockedImageNode({ type: "config", metadata: {} }), false);
    assert.equal(isAspectLockedImageNode({ type: "image", metadata: {} }), true);
    assert.equal(isAspectLockedImageNode({ type: "image", metadata: { freeResize: true } }), false);
    assert.equal(isAspectLockedImageNode({ type: "video", metadata: {} }), false);
});
