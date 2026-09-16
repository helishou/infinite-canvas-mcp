/**
 * 切分图片自动识别线宽的回归测试。
 * 直接用 sharp 合成测试图，避免依赖外部素材。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import sharp from "sharp";

import { detectLineInset, type DetectLineInsetParams } from "./image-split-detect.js";

/** 合成一张 N×M 宫格图，cells 用深灰底，cell 之间留 N px 白色分隔带。 */
async function makeGridImage({ cellColor, dividerColor, cellSize, dividerSize, rows, columns }: {
    cellColor: { r: number; g: number; b: number };
    dividerColor: { r: number; g: number; b: number };
    cellSize: number;
    dividerSize: number;
    rows: number;
    columns: number;
}): Promise<Buffer> {
    const cellStride = cellSize + dividerSize;
    const width = columns * cellSize + (columns - 1) * dividerSize;
    const height = rows * cellSize + (rows - 1) * dividerSize;
    const channels = 3;
    const data = Buffer.alloc(width * height * channels);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            // 是否落在分隔带
            const col = x % cellStride;
            const row = y % cellStride;
            const inDividerX = col >= cellSize;
            const inDividerY = row >= cellSize;
            const inDivider = inDividerX || inDividerY;
            const c = inDivider ? dividerColor : cellColor;
            const offset = (y * width + x) * channels;
            data[offset] = c.r;
            data[offset + 1] = c.g;
            data[offset + 2] = c.b;
        }
    }
    return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

test("detectLineInset：2x2 + 4px 白色分隔线，识别为 4", async () => {
    const buffer = await makeGridImage({
        cellColor: { r: 50, g: 50, b: 50 },
        dividerColor: { r: 245, g: 245, b: 245 },
        cellSize: 200,
        dividerSize: 4,
        rows: 2,
        columns: 2,
    });
    const params: DetectLineInsetParams = { rows: 2, columns: 2, horizontalLines: [0.498], verticalLines: [0.498] };
    const result = await detectLineInset(buffer, params);
    assert.equal(result.lineInset, 4, `expected 4 got ${result.lineInset}`);
    assert.equal(result.confidence, 1);
    assert.equal(result.samples.horizontal.length, 1);
    assert.equal(result.samples.vertical.length, 1);
});

test("detectLineInset：3x3 网格 + 6px 黑底白线，全局 confidence=1、inset=6", async () => {
    const buffer = await makeGridImage({
        cellColor: { r: 30, g: 30, b: 30 },
        dividerColor: { r: 240, g: 240, b: 240 },
        cellSize: 150,
        dividerSize: 6,
        rows: 3,
        columns: 3,
    });
    const params: DetectLineInsetParams = {
        rows: 3,
        columns: 3,
        horizontalLines: [1 / 3, 2 / 3],
        verticalLines: [1 / 3, 2 / 3],
    };
    const result = await detectLineInset(buffer, params);
    assert.equal(result.lineInset, 6);
    assert.equal(result.confidence, 1);
    assert.equal(result.samples.horizontal.length, 2);
    assert.equal(result.samples.vertical.length, 2);
});

test("detectLineInset：连续图（无分隔线）→ lineInset=0、confidence=0", async () => {
    const width = 400;
    const height = 400;
    const channels = 3;
    const data = Buffer.alloc(width * height * channels, 100);
    const buffer = await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
    const params: DetectLineInsetParams = {
        rows: 2,
        columns: 2,
        horizontalLines: [0.5],
        verticalLines: [0.5],
    };
    const result = await detectLineInset(buffer, params);
    assert.equal(result.lineInset, 0);
    assert.equal(result.confidence, 0);
});

test("detectLineInset：用户切分线略偏真实分隔线 2px 也能找到", async () => {
    const buffer = await makeGridImage({
        cellColor: { r: 50, g: 50, b: 50 },
        dividerColor: { r: 240, g: 240, b: 240 },
        cellSize: 200,
        dividerSize: 4,
        rows: 2,
        columns: 2,
    });
    // 真实分隔线在 0.5，cell 中点 0.5；用户拖到 0.495（偏 2px）— 应仍能识别
    const params: DetectLineInsetParams = {
        rows: 2,
        columns: 2,
        horizontalLines: [0.495],
        verticalLines: [0.495],
    };
    const result = await detectLineInset(buffer, params);
    assert.equal(result.lineInset, 4);
    assert.equal(result.confidence, 1);
});

test("detectLineInset：4 条线 3 个识别成功 1 个失败 → confidence=0.75 + median", async () => {
    // 3x3 网格 → 2 横 2 竖共 4 条线
    const buffer = await makeGridImage({
        cellColor: { r: 50, g: 50, b: 50 },
        dividerColor: { r: 240, g: 240, b: 240 },
        cellSize: 200,
        dividerSize: 8,
        rows: 3,
        columns: 3,
    });
    // 用户额外加了一条奇怪的"切分线"，但它不在图上的任何分隔位置上 → 找不到分隔带
    const params: DetectLineInsetParams = {
        rows: 3,
        columns: 3,
        horizontalLines: [1 / 3, 2 / 3, 0.1], // 最后一条对应位置没有 8px 分隔带
        verticalLines: [1 / 3, 2 / 3],
    };
    const result = await detectLineInset(buffer, params);
    // 找到 4 条：2 横 2 竖
    assert.equal(result.samples.horizontal.length, 2);
    assert.equal(result.samples.vertical.length, 2);
    assert.equal(result.confidence, 4 / 5);
    assert.equal(result.lineInset, 8);
});
