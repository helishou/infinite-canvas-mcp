import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createLogger } from "../logger.js";
import { MEDIA_TOOLS_DIR } from "../config.js";

const logger = createLogger("media-tools");

/**
 * 媒体工具（ffmpeg / ffprobe）定位与探测。
 *
 * 为什么需要这一层：这两个二进制在 Windows 上通常解压在某个盘的独立目录里，
 * 并不在 PATH。此前各处写成 `process.env.FFMPEG_PATH || "ffmpeg"`，一旦 PATH 缺失，
 * spawn 直接 ENOENT —— 表现为「视频其实已经生成成功，任务却被判为失败」。
 *
 * 定位顺序：显式环境变量 → PATH 各目录 → 裸名交给系统。
 * 找不到时不抛错，只警告一次，让调用方按「工具不可用」降级，而不是把已经产出的媒体丢掉。
 */
export type MediaToolName = "ffmpeg" | "ffprobe";

const isWindows = process.platform === "win32";
const resolved = new Map<MediaToolName, string>();
const warned = new Set<MediaToolName>();

function envFor(name: MediaToolName): string {
    const value = name === "ffmpeg" ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
    return String(value || "").trim();
}

function isFile(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

/** 返回可执行的绝对路径；找不到时返回裸名（保持旧行为，由系统 PATH 兜底）。 */
export function mediaToolPath(name: MediaToolName): string {
    const cached = resolved.get(name);
    if (cached) return cached;

    const fileName = isWindows ? `${name}.exe` : name;
    const candidates: string[] = [];
    const explicit = envFor(name);
    if (explicit) candidates.push(explicit);
    // 只配了 FFMPEG_PATH 时，同目录的 ffprobe 视为可用候选。
    const ffmpegExplicit = envFor("ffmpeg");
    if (ffmpegExplicit) candidates.push(ffmpegExplicit.replace(/ffmpeg(\.exe)?$/i, `ffprobe$1`));
    // backend.json 的 mediaTools.ffmpegDir：不在 PATH 时的正式配置入口。
    if (MEDIA_TOOLS_DIR) candidates.push(path.join(MEDIA_TOOLS_DIR, fileName));
    for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
        if (dir.trim()) candidates.push(path.join(dir.trim(), fileName));
    }

    for (const candidate of candidates) {
        if (isFile(candidate)) {
            resolved.set(name, candidate);
            return candidate;
        }
    }

    if (!warned.has(name)) {
        warned.add(name);
        logger.warn(
            `未找到 ${name}，依赖它的能力会降级（媒体规格无法核验）。` +
            `请把 ${name} 所在目录加入 PATH，或设置 ${name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"} 指向可执行文件。`,
        );
    }
    resolved.set(name, name);
    return name;
}

export type MediaProbe = {
    width: number | null;
    height: number | null;
    durationMs: number | null;
};

/**
 * 读取媒体宽高与时长。工具缺失、文件损坏、超时都返回 null ——
 * 探测失败是「不可核验」，不是「媒体有问题」，调用方不得据此判定产物失败。
 */
export function probeMedia(file: string, timeoutMs = 8_000): Promise<MediaProbe | null> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: MediaProbe | null) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const child = spawn(
            mediaToolPath("ffprobe"),
            ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
            { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
        let output = "";
        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* already exited */ }
            finish(null);
        }, Math.max(1_000, timeoutMs));
        child.stdout.on("data", (chunk) => { output += String(chunk); });
        child.once("error", () => { clearTimeout(timer); finish(null); });
        child.once("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) return finish(null);
            try {
                const data = JSON.parse(output);
                const streams: any[] = Array.isArray(data?.streams) ? data.streams : [];
                const video = streams.find((s) => s?.codec_type === "video");
                const audio = streams.find((s) => s?.codec_type === "audio");
                const primary = video || audio;
                const duration = Number(data?.format?.duration ?? primary?.duration);
                finish({
                    width: Number(video?.width) > 0 ? Number(video.width) : null,
                    height: Number(video?.height) > 0 ? Number(video.height) : null,
                    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null,
                });
            } catch {
                finish(null);
            }
        });
    });
}

/** 媒体是否值得探测（视频/音频才有时长与编码尺寸）。 */
export function needsProbe(mimeType: string): boolean {
    return /^(video|audio)\//i.test(String(mimeType || ""));
}
