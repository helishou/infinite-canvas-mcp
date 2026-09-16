import assert from "node:assert/strict";
import test from "node:test";

import { needsViewportCull, VIEWPORT_CULL_SCREEN_MARGIN, VIEWPORT_CULL_ZOOM_RATIO, VIEWPORT_RENDER_SCREEN_PADDING, viewportRenderPadding } from "./canvas-viewport";

const at = (x: number, y: number, k = 1) => ({ x, y, k });

test("小幅移动不触发重算：拖动期间绝大多数帧应该零 React 渲染", () => {
    assert.equal(needsViewportCull(at(0, 0), at(40, 30)), false);
    assert.equal(needsViewportCull(at(0, 0), at(VIEWPORT_CULL_SCREEN_MARGIN - 1, 0)), false);
});

test("位移超过阈值后触发重算", () => {
    assert.equal(needsViewportCull(at(0, 0), at(VIEWPORT_CULL_SCREEN_MARGIN, 0)), true);
    assert.equal(needsViewportCull(at(0, 0), at(0, -VIEWPORT_CULL_SCREEN_MARGIN)), true);
});

test("位移按屏幕像素计：同样屏幕距离在任何缩放下行为一致", () => {
    // 屏幕位移 200px 未达阈值 —— k=1 / k=0.2 / k=0.05 必须都是「不重算」。
    // 回归：原实现按世界单位换算，k=0.2 时 200px 被放大成 1000 世界单位而误判为重算，
    // 这就是「缩得越小越卡」的根因（原阈值下 k=0.05 时平移 26px 就重算一次）。
    assert.equal(needsViewportCull(at(0, 0, 1), at(-200, 0, 1)), false);
    assert.equal(needsViewportCull(at(0, 0, 0.2), at(-200, 0, 0.2)), false);
    assert.equal(needsViewportCull(at(0, 0, 0.05), at(-200, 0, 0.05)), false);
    // 任意缩放下，超过阈值都必须触发。
    assert.equal(needsViewportCull(at(0, 0, 1), at(-VIEWPORT_CULL_SCREEN_MARGIN, 0, 1)), true);
    assert.equal(needsViewportCull(at(0, 0, 0.05), at(-VIEWPORT_CULL_SCREEN_MARGIN, 0, 0.05)), true);
    assert.equal(needsViewportCull(at(0, 0, 0.2), at(0, VIEWPORT_CULL_SCREEN_MARGIN, 0.2)), true);
});

test("缩放幅度够大时触发重算，微小抖动不触发", () => {
    assert.equal(needsViewportCull(at(0, 0, 1), at(0, 0, 1 + VIEWPORT_CULL_ZOOM_RATIO / 2)), false);
    assert.equal(needsViewportCull(at(0, 0, 1), at(0, 0, 1 + VIEWPORT_CULL_ZOOM_RATIO)), true);
    // 缩小同样算（视野变大，会有新节点进入）。
    assert.equal(needsViewportCull(at(0, 0, 1), at(0, 0, 1 - VIEWPORT_CULL_ZOOM_RATIO)), true);
});

test("渲染 padding 必须大于补重算阈值，否则补渲染会晚于空白出现", () => {
    assert.ok(VIEWPORT_RENDER_SCREEN_PADDING > VIEWPORT_CULL_SCREEN_MARGIN, `padding=${VIEWPORT_RENDER_SCREEN_PADDING} 应大于 margin=${VIEWPORT_CULL_SCREEN_MARGIN}`);
    // 换算成世界单位后（除以 k）两者的相对关系必须保持，否则低倍率下会露出空白。
    for (const k of [0.05, 0.2, 0.55, 1, 5]) {
        const marginWorld = VIEWPORT_CULL_SCREEN_MARGIN / k;
        assert.ok(viewportRenderPadding(k) > marginWorld, `k=${k} 时 padding=${viewportRenderPadding(k)} 应大于 margin=${marginWorld}`);
    }
});

test("裁剪 padding 随缩放成反比：缩小看全图时外扩范围跟着放大", () => {
    assert.equal(viewportRenderPadding(1), VIEWPORT_RENDER_SCREEN_PADDING);
    assert.equal(viewportRenderPadding(0.5), VIEWPORT_RENDER_SCREEN_PADDING * 2);
    // k=0.05 时世界单位外扩 = 400 / 0.05 = 8000，足以覆盖整块画布 —— 缩到很小时不再反复重算。
    assert.equal(viewportRenderPadding(0.05), VIEWPORT_RENDER_SCREEN_PADDING / 0.05);
    // 非法缩放要有兜底值，不能返回 Infinity / NaN。
    assert.equal(viewportRenderPadding(0), VIEWPORT_RENDER_SCREEN_PADDING);
    assert.equal(viewportRenderPadding(-1), VIEWPORT_RENDER_SCREEN_PADDING);
});

test("非法视口（k<=0）必须重算而不是静默跳过", () => {
    assert.equal(needsViewportCull(at(0, 0), at(0, 0, 0)), true);
    assert.equal(needsViewportCull(at(0, 0, 0), at(0, 0, 1)), true);
});
