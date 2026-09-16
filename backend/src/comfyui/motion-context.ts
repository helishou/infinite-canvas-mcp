/**
 * MiniMax H3 Motion Context — Node.js 重写版
 *
 * 等价于 `workers/motion_context.py`，用 sharp + ffmpeg CLI 实现：
 * 1. ffprobe 取帧数
 * 2. ffmpeg -select 截尾部 N 帧（24fps, rgb24）
 * 3. sharp 逐帧 NEAREST 6 色噪声叠加（alpha ramp）
 * 4. ffmpeg 编码输出（libx264, yuv420p, +faststart）
 *
 * PRNG 使用 Task 1 验证过的 Random(1337)，逐帧严格等价 Python。
 */
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Random } from "./mt19937.js";

export interface MotionContextOptions {
    /** 截取尾部帧数，默认 22 */
    frames?: number;
    /** 噪声 alpha起始值，默认 0.45 */
    alpha?: number;
    /** 噪声 alpha 终值（最后 ramp 帧），默认 0.10 */
    alphaEnd?: number;
    /** alpha 渐变帧数，默认 3 */
    ramp?: number;
    /** RNG seed，默认 1337 */
    seed?: number;
}

/** Python 原版硬编码的 6 色 palette。 */
const PALETTE: [number, number, number][] = [
    [185, 115, 215], [115, 195, 140], [150, 148, 162],
    [205, 150, 192], [138, 182, 148], [160, 120, 175],
];

/** 核心实现：截取 previousVideo 尾部，加噪声，输出处理后视频。 */
export async function buildMotionContextClip(
    source: string,
    target: string,
    opts: MotionContextOptions = {},
): Promise<void> {
    const {
        frames: framesOpt = 22,
        alpha: alphaOpt = 0.45,
        alphaEnd: alphaEndOpt = 0.10,
        ramp: rampOpt = 3,
        seed = 1337,
    } = opts;

    // ── 参数边界 clamp（与 Python 一致） ────────────────────────────────
    const frames = Math.max(1, Math.min(56, framesOpt));
    const ramp = Math.max(0, Math.min(frames, rampOpt));
    const alpha = Math.max(0.0, Math.min(1.0, alphaOpt));
    const alphaEnd = Math.max(0.0, Math.min(alpha, alphaEndOpt));

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `canvas_h3_mc_${randomUUID().replace(/-/g, "").slice(0, 8)}_`));

    try {
        // ── Step 1: ffprobe 取帧数 ──────────────────────────────────
        const probe = await run("ffprobe", [
            "-v", "error", "-count_frames",
            "-show_streams", "-of", "json", source,
        ]);
        const streams: Array<{ codec_type?: string; nb_read_frames?: string; nb_frames?: string }> =
            JSON.parse(probe.stdout).streams ?? [];
        const video = streams.find((s) => s.codec_type === "video");
        const totalFrames = Math.max(1,
            parseInt(video?.nb_read_frames ?? video?.nb_frames ?? String(frames), 10));

        const actual = Math.min(frames, totalFrames);
        const start = Math.max(0, totalFrames - actual);

        // ── Step 2: ffmpeg 截取尾部帧（24fps, rgb24） ──────────────
        const framePattern = path.join(tmpDir, "frame_%05d.png");
        await run("ffmpeg", [
            "-hide_banner", "-loglevel", "error", "-y",
            "-i", source,
            "-vf", `select='gte(n,${start})',setpts=PTS-STARTPTS,fps=24`,
            "-frames:v", String(actual),
            "-pix_fmt", "rgb24",
            framePattern,
        ]);

        // ── Step 3: sharp 逐帧处理 ──────────────────────────────────
        const rng = new Random(seed);
        // 预生成 36×64 noiseBlock（2304 个 randrange(6) 索引）
        const noiseBlock: number[] = Array.from({ length: 36 * 64 }, () => rng.nextInt(6));

        const frameFiles = await fs.readdir(tmpDir);
        const sortedFrames = frameFiles
            .filter((f) => f.startsWith("frame_") && f.endsWith(".png"))
            .sort();

        for (let idx = 0; idx < sortedFrames.length; idx++) {
            const framePath = path.join(tmpDir, sortedFrames[idx]);

            // alpha ramp：从尾部 ramp 帧线性插值到 alphaEnd
            let curAlpha = alpha;
            if (ramp > 0 && idx >= actual - ramp) {
                const fromEnd = actual - 1 - idx;          // 0,1,2 at last 3 frames
                const t = (ramp - fromEnd) / ramp;          // 0.33, 0.67, 1.0
                curAlpha = alpha + (alphaEnd - alpha) * t;  // 线性插值
            }
            curAlpha = Math.max(0, Math.min(1, curAlpha));

            const buf = await fs.readFile(framePath);
            const base = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
            const { width, height } = base.info;

            // 构建 36×64 噪声小图（Nearest），然后 resize 到帧尺寸
            const noiseBuf = Buffer.alloc(36 * 64 * 3);
            for (let i = 0; i < 36 * 64; i++) {
                const [r, g, b] = PALETTE[noiseBlock[i]];
                noiseBuf[i * 3] = r;
                noiseBuf[i * 3 + 1] = g;
                noiseBuf[i * 3 + 2] = b;
            }
            const noiseResized = await sharp(noiseBuf, { raw: { width: 64, height: 36, channels: 3 } })
                .resize(width, height, { kernel: "nearest" })
                .toBuffer();

            // blend: pixel = base * (1-alpha) + noise * alpha
            const outBuf = Buffer.alloc(width * height * 3);
            for (let i = 0; i < width * height; i++) {
                const bi = i * 3;
                const ni = i * 3;
                const a = curAlpha;
                const na = 1 - a;
                outBuf[bi]     = Math.round(base.data[bi]     * na + noiseResized[ni]     * a);
                outBuf[bi + 1] = Math.round(base.data[bi + 1] * na + noiseResized[ni + 1] * a);
                outBuf[bi + 2] = Math.round(base.data[bi + 2] * na + noiseResized[ni + 2] * a);
            }

            await sharp(outBuf, { raw: { width, height, channels: 3 } })
                .png()
                .toFile(framePath);
        }

        // ── Step 4: ffmpeg 编码输出 ────────────────────────────────
        await fs.mkdir(path.dirname(target) || ".", { recursive: true });
        await run("ffmpeg", [
            "-hide_banner", "-loglevel", "error", "-y",
            "-framerate", "24",
            "-i", framePattern,
            "-c:v", "libx264", "-preset", "veryfast",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            target,
        ]);
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => { stdout += String(c); });
        child.stderr.on("data", (c) => { stderr += String(c); });
        child.on("error", (e) => reject(new Error(`${cmd} 启动失败：${e.message}`)));
        child.on("close", (code) =>
            code === 0 ? resolve({ stdout, stderr }) :
                reject(new Error(`${cmd} 失败(${code}): ${stderr.trim().slice(0, 500)}`))
        );
    });
}
