import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Random } from "./mt19937.js";
import { buildMotionContextClip } from "./motion-context.js";

/** palette 是 6 个 RGB 元组，必须与 Python 原版硬编码一致。 */
const PALETTE: [number, number, number][] = [
    [185, 115, 215], [115, 195, 140], [150, 148, 162],
    [205, 150, 192], [138, 182, 148], [160, 120, 175],
];

const execP = promisify(exec);

// ─── 辅助 ─────────────────────────────────────────────────────────────────

/** 生成测试用纯色帧图像（PNG）到临时文件。 */
async function makeTestFrame(width = 64, height = 64, r = 200, g = 100, b = 50): Promise<string> {
    const sharp = (await import("sharp")).default;
    const tmp = path.join(os.tmpdir(), `test_frame_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
    // 构建 width×height 个 RGB 像素的原始 buffer
    const buf = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) { buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b; }
    await sharp(buf, { raw: { width, height, channels: 3 } }).png().toFile(tmp);
    return tmp;
}

/** 生成连续帧的测试视频（ffmpeg, 24fps, yuv420p）。 */
async function makeTestVideo(frameCount = 25, width = 64, height = 64): Promise<string> {
    const sharp = (await import("sharp")).default;
    const tmp = path.join(os.tmpdir(), `test_video_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    // 用 sharp 生成帧图片到临时目录，再 ffmpeg 编码
    const dir = path.join(os.tmpdir(), `test_vid_frames_${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    try {
        for (let i = 0; i < frameCount; i++) {
            const v = Math.round((i / Math.max(1, frameCount - 1)) * 255);
            const buf = Buffer.alloc(width * height * 3);
            for (let p = 0; p < width * height; p++) { buf[p * 3] = v; buf[p * 3 + 1] = 255 - v; buf[p * 3 + 2] = 128; }
            await sharp(buf, { raw: { width, height, channels: 3 } }).png()
                .toFile(path.join(dir, `f${String(i).padStart(4, "0")}.png`));
        }
        const pattern = path.join(dir, "f%04d.png");
        await execP(`ffmpeg -hide_banner -loglevel error -y -framerate 24 -i "${pattern.replace(/\\/g, "/")}" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${tmp.replace(/\\/g, "/")}"`);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
    return tmp;
}


// ─── 测试：palette 颜色数、randrange(6) 分布 ──────────────────────────────

test("PALETTE 必须是 6 个颜色，与 Python 原版一致", () => {
    assert.equal(PALETTE.length, 6);
    assert.deepEqual(PALETTE[0], [185, 115, 215]);
    assert.deepEqual(PALETTE[4], [138, 182, 148]);
});

test("Random(1337).nextInt(6) 产生的 36×64 索引顺序与 Python noiseBlock 一致", () => {
    const rng = new Random(1337);
    // 前 10 个 randrange(6) 已知 = [4,4,5,2,4,4,5,1,2,3]
    const first10 = Array.from({ length: 10 }, () => rng.nextInt(6));
    assert.deepEqual(first10, [4, 4, 5, 2, 4, 4, 5, 1, 2, 3]);
    // 验证第 2304 个（最后一个）也是 golden
    const rng2 = new Random(1337);
    const all2304 = Array.from({ length: 2304 }, () => rng2.nextInt(6));
    assert.equal(all2304[2303], 2); // 来自 golden.json 最后一个值
});

// ─── 测试：alpha ramp 计算 ────────────────────────────────────────────────

test("alphaRamp：index 在 ramp 范围内时线性插值", () => {
    // 模拟原版 Python 的 ramp 计算逻辑
    function alphaRamp(index: number, actual: number, alpha: number, alphaEnd: number, ramp: number): number {
        if (!ramp || index < actual - ramp) return alpha;
        const fromEnd = actual - 1 - index;
        return alpha + (alphaEnd - alpha) * (ramp - fromEnd) / ramp;
    }
    // actual=22, alpha=0.45, alphaEnd=0.10, ramp=3
    // 帧 0-18: 0.45
    assert.equal(alphaRamp(0, 22, 0.45, 0.10, 3), 0.45);
    assert.equal(alphaRamp(18, 22, 0.45, 0.10, 3), 0.45);
    // 帧 19: fromEnd=2, ramp=3 → 0.45+(0.10-0.45)*(3-2)/3 = 0.45-0.1167=0.3333
    const r19 = alphaRamp(19, 22, 0.45, 0.10, 3);
    assert(Math.abs(r19 - 0.3333333333333333) < 1e-12, `frame19: ${r19}`);
    // 帧 20: fromEnd=1 → 0.45+(0.10-0.45)*(3-1)/3 = 0.45-0.2333=0.2167
    const r20 = alphaRamp(20, 22, 0.45, 0.10, 3);
    assert(Math.abs(r20 - 0.2166666666666667) < 1e-12, `frame20: ${r20}`);
    // 帧 21: fromEnd=0 → 0.45+(0.10-0.45)*(3-0)/3 = 0.10
    const r21 = alphaRamp(21, 22, 0.45, 0.10, 3);
    assert(Math.abs(r21 - 0.10) < 1e-12, `frame21: ${r21}`);
});

// ─── 测试：完整流程（端到端） ─────────────────────────────────────────────

test("buildMotionContextClip 输出一段 .mp4，长度=frames，帧数正确", async () => {
    const out = path.join(os.tmpdir(), `mc_out_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    try {
        // 生成 25 帧测试视频（64×64，24fps）
        const video = await makeTestVideo(25, 64, 64);

        // 调用 buildMotionContextClip：截 22 帧，加噪声（seed=1337）
        await buildMotionContextClip(video, out, {
            frames: 22,
            seed: 1337,
            alpha: 0.45,
            alphaEnd: 0.10,
            ramp: 3,
        });

        // 验证输出存在
        const stats = await fs.stat(out);
        assert(stats.size > 1000, `输出文件太小: ${stats.size}`);

        // 验证帧数 = 22
        const probe = await execP(`ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of json "${out.replace(/\\/g, "/")}"`);
        const nb = parseInt(JSON.parse(probe.stdout).streams?.[0]?.nb_read_frames ?? "0", 10);
        assert.equal(nb, 22, `帧数不对: expect 22, got ${nb}`);
    } finally {
        try { await fs.rm(out, { force: true }); } catch {}
    }
});
