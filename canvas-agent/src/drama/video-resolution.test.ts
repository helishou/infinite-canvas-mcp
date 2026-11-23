import assert from "node:assert/strict";
import test from "node:test";
import {
    DRAMA_VIDEO_ASPECT_RATIOS,
    DRAMA_VIDEO_RESOLUTION_TIERS,
    dramaVideoPixels,
    dramaVideoResolutionShortSide,
    dramaVideoResolutionToH3,
    formatDramaVideoResolution,
    isDramaVideoAspectRatio,
    isDramaVideoResolutionTier,
} from "./video-resolution.js";
import { estimateH3Dimensions } from "../plugins/minimax-h3/runtime-params.js";

test("档位与画幅常量对齐影策：480p/720p/1080p + 16:9/9:16", () => {
    assert.deepEqual([...DRAMA_VIDEO_RESOLUTION_TIERS], ["480p", "720p", "1080p"]);
    assert.deepEqual([...DRAMA_VIDEO_ASPECT_RATIOS], ["16:9", "9:16"]);
    assert.equal(isDramaVideoResolutionTier("720p"), true);
    assert.equal(isDramaVideoResolutionTier("4k"), false);
    assert.equal(isDramaVideoAspectRatio("9:16"), true);
    assert.equal(isDramaVideoAspectRatio("4:3"), false);
    assert.equal(dramaVideoResolutionShortSide("720P"), 720);
    assert.equal(dramaVideoResolutionShortSide("nope"), null);
});

test("档位+画幅联动：720p 横屏=1280x736，竖屏=736x1280（短边随画幅换向）", () => {
    const landscape = dramaVideoResolutionToH3("720p", "16:9")!;
    const portrait = dramaVideoResolutionToH3("720p", "9:16")!;
    assert.equal(landscape.aspectRatio, "16:9");
    assert.equal(portrait.aspectRatio, "9:16");
    assert.equal(landscape.megapixels, 0.9);
    assert.equal(portrait.megapixels, 0.9, "同档位总能像素相同，只是长宽互换");
    assert.match(landscape.size, /^1280x\d+$/);
    assert.match(portrait.size, /^\d+x1280$/);
    const [lw, lh] = landscape.size.split("x").map(Number);
    const [pw, ph] = portrait.size.split("x").map(Number);
    assert.equal(pw, lh, "竖屏宽 == 横屏高");
    assert.equal(ph, lw, "竖屏高 == 横屏宽");
});

test("档位单调：480p < 720p < 1080p 总能像素与短边递增；非法档位回退 null（不造假开关）", () => {
    const sizes = DRAMA_VIDEO_RESOLUTION_TIERS.map((tier) => dramaVideoResolutionToH3(tier, "16:9")!);
    assert.ok(sizes[0].megapixels < sizes[1].megapixels);
    assert.ok(sizes[1].megapixels < sizes[2].megapixels);
    assert.equal(sizes[2].megapixels, 2);
    assert.match(sizes[2].size, /^1920x\d+$/);
    assert.equal(dramaVideoResolutionToH3("4k", "16:9"), null);
    assert.deepEqual(dramaVideoResolutionToH3("720p", ""), sizes[1], "空画幅按横屏兜底");
    assert.match(formatDramaVideoResolution("720p", "9:16"), /^720p · \d+x1280$/);
});

test("换算结果就是 H3 一采真实尺寸：estimateH3Dimensions 的 grid 32 对齐", () => {
    for (const tier of DRAMA_VIDEO_RESOLUTION_TIERS) {
        for (const ratio of DRAMA_VIDEO_ASPECT_RATIOS) {
            const effective = dramaVideoResolutionToH3(tier, ratio)!;
            const [w, h] = effective.size.split("x").map(Number);
            assert.equal(w % 32, 0, `${tier}/${ratio} 宽按 32 对齐`);
            assert.equal(h % 32, 0, `${tier}/${ratio} 高按 32 对齐`);
            assert.equal(String(Math.min(w, h)), effective.resolution);
        }
    }
});

test("dramaVideoPixels：画幅+像素量换算宽高，与 estimateH3Dimensions 完全一致", () => {
    // 引擎「H3 展开流」只认 width/height，这层换算必须与库逐档对齐，否则面板与出片尺寸不符。
    for (const aspect of DRAMA_VIDEO_ASPECT_RATIOS) {
        for (const megapixels of [0.3, 0.4, 0.6, 0.8, 1.0, 1.5, 2.0]) {
            const mine = dramaVideoPixels(aspect, megapixels);
            const lib = estimateH3Dimensions({ aspectRatio: aspect, megapixels });
            assert.deepEqual(mine, lib ? { width: lib.width, height: lib.height } : null, `${aspect} ${megapixels}`);
        }
    }
});

test("dramaVideoPixels：16:9 出横版、9:16 出竖版，0.4MP 基准为 864x480", () => {
    const landscape = dramaVideoPixels("16:9", 0.4);
    assert.ok(landscape && landscape.width > landscape.height);
    assert.deepEqual(landscape, { width: 864, height: 480 });
    const portrait = dramaVideoPixels("9:16", 0.4);
    assert.ok(portrait && portrait.height > portrait.width);
    assert.deepEqual(portrait, { width: 480, height: 864 });
});

test("dramaVideoPixels：像素量缺省/非法按 0.4MP，画幅非法返回 null", () => {
    assert.deepEqual(dramaVideoPixels("16:9", undefined), { width: 864, height: 480 });
    assert.deepEqual(dramaVideoPixels("16:9", 0), { width: 864, height: 480 });
    assert.equal(dramaVideoPixels("", 0.4), null);
});
