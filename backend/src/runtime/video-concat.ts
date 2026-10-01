import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { MEDIA_DIR } from "../config.js";
import type { RuntimeTask } from "../db.js";
import type { TaskStore } from "../stores/types.js";
import type { MediaStore } from "../stores/types.js";
import type { BackendEventBus } from "../events.js";

export function validateVideoTrimRange(start: unknown, end: unknown) {
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        throw new Error("视频裁剪时间无效：开始时间必须大于等于 0，结束时间必须大于开始时间");
    }
    return { start, end };
}

/** Backend 的 FFmpeg 视频拼接与裁剪服务；任务状态统一写入 TaskStore。 */
export class VideoConcatBackend {
    private readonly processes = new Map<string, ChildProcess>();
    private readonly executing = new Set<string>();
    constructor(private readonly tasks: TaskStore, private readonly ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", private readonly events?: BackendEventBus, private readonly media?: MediaStore) {}
    /** 拼接布局：sequence = 按顺序首尾相接（默认）；hstack = 横向并排（多路同屏）。 */
    private static layout(value: unknown): "sequence" | "hstack" { return value === "hstack" ? "hstack" : "sequence"; }
    status() { return new Promise<{ available: boolean; path: string; error?: string }>((resolve) => { const child = spawn(this.ffmpeg, ["-version"], { stdio: "ignore" }); child.once("error", (error) => resolve({ available: false, path: this.ffmpeg, error: error.message })); child.once("exit", (code) => resolve({ available: code === 0, path: this.ffmpeg, ...(code === 0 ? {} : { error: `ffmpeg exited with ${code}` }) })); }); }
    async run(videos: string[], output = "", longEdge: number | "auto" = "auto", clientTaskId?: string, parentTaskId?: string, layout: unknown = "sequence") {
        if (!videos.length) throw new Error("视频拼接至少需要一个视频"); if (videos.some((file) => !file.trim())) throw new Error("视频输入无效");
        const mode = VideoConcatBackend.layout(layout);
        if (mode === "hstack" && videos.length < 2) throw new Error("横向拼接至少需要两个视频");
        const existing = clientTaskId ? this.tasks.get(clientTaskId) : null;
        if (existing && (!["queued", "running"].includes(existing.status) || this.executing.has(existing.id))) return existing;
        const params = { output, longEdge, layout: mode, ...(parentTaskId ? { parentTaskId } : {}) };
        const task = existing || (clientTaskId ? this.tasks.create(clientTaskId, "video-concat", { videos }, params) : this.tasks.create("video-concat", { videos }, params));
        this.executing.add(task.id); void this.execute(task).catch((error) => this.fail(task.id, error)).finally(() => this.executing.delete(task.id)); return task;
    }
    async trim(storageKey: string, start: number, end: number, clientTaskId: string, parentTaskId: string) {
        validateVideoTrimRange(start, end);
        if (!this.media?.meta(storageKey)?.mimeType.startsWith("video/")) throw new Error("视频裁剪输入不是已归档的视频");
        const existing = this.tasks.get(clientTaskId);
        if (existing && (existing.kind !== "video-trim" || existing.input.storageKey !== storageKey || existing.params.start !== start || existing.params.end !== end || existing.params.parentTaskId !== parentTaskId)) {
            throw new Error("视频裁剪任务 ID 已用于不同输入");
        }
        if (existing && (!["queued", "running"].includes(existing.status) || this.executing.has(existing.id))) return existing;
        const task = existing || this.tasks.create(clientTaskId, "video-trim", { storageKey }, { start, end, parentTaskId });
        this.executing.add(task.id);
        void this.executeTrim(task).catch((error) => this.fail(task.id, error)).finally(() => this.executing.delete(task.id));
        return task;
    }

    private assertActive(id: string) {
        if (!["queued", "running"].includes(this.tasks.get(id)?.status || "")) throw new Error("视频裁剪任务已停止");
    }

    private async executeTrim(task: RuntimeTask) {
        this.update(task.id, { status: "running", progress: 0.05 });
        const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-video-trim-"));
        try {
            const input = path.join(directory, "input.mp4");
            const output = path.join(directory, "output.mp4");
            await writeFile(input, await this.media!.read(String(task.input.storageKey)));
            this.assertActive(task.id);
            const info = await this.probe(input);
            this.assertActive(task.id);
            const { start, end } = validateVideoTrimRange(task.params.start, task.params.end);
            if (!info.duration || start >= info.duration || end > info.duration + 0.001) throw new Error("视频裁剪范围超出视频时长，或无法读取视频时长（需要 ffprobe）");
            const duration = Math.min(end, info.duration) - start;
            await this.spawnFfmpeg(task.id, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-i", input,
                "-t", String(duration), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast",
                "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", output]);
            this.assertActive(task.id);
            const data = await readFile(output);
            this.assertActive(task.id);
            if (!data.length) throw new Error("视频裁剪没有生成有效媒体");
            const stored = this.media!.store(data, { name: "video-trim.mp4", mimeType: "video/mp4", category: "output",
                width: Math.ceil(info.width / 2) * 2, height: Math.ceil(info.height / 2) * 2, durationMs: Math.round(duration * 1000) });
            const media = { url: this.media!.url(stored), storageKey: stored.storageKey, mimeType: stored.mimeType,
                width: stored.width, height: stored.height, durationMs: stored.durationMs };
            this.update(task.id, { status: "succeeded", progress: 1, result: { media, start, end } });
            this.tasks.addEvent(task.id, "result", { media, start, end });
        } finally {
            this.processes.delete(task.id);
            await rm(directory, { recursive: true, force: true });
        }
    }
    cancel(id: string) {
        this.processes.get(id)?.kill();
        const task = this.tasks.cancel(id);
        this.events?.publish({ type: "task.updated", entityId: id, payload: task });
        return task;
    }
    private async execute(task: RuntimeTask) {
        this.update(task.id, { status: "running", progress: 0.05 });
        const temporaryFiles: string[] = [];
        try {
            const inputs = await Promise.all((task.input.videos as string[]).map((value, index) => this.resolveInput(value, task.id, index, temporaryFiles)));
            const output = String(task.params.output || path.join(MEDIA_DIR, `video-concat-${crypto.randomUUID()}.mp4`));
            await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
            const layout = VideoConcatBackend.layout(task.params.layout);
            if (layout === "hstack") await this.runHstackFfmpeg(task.id, inputs, output, Number(task.params.longEdge) || 0);
            else {
                const concatList = path.join(os.tmpdir(), `video-concat-${crypto.randomUUID()}.txt`);
                await writeFile(concatList, inputs.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
                temporaryFiles.push(concatList);
                await this.runFfmpeg(task.id, concatList, output, Number(task.params.longEdge) || 0);
            }
            const stored = this.media ? this.media.store(await readFile(output), { name: path.basename(output), mimeType: "video/mp4", category: "output" }) : null;
            const result = { path: output, longEdge: task.params.longEdge, layout, ...(stored ? { media: { url: this.media!.url(stored), storageKey: stored.storageKey, mimeType: stored.mimeType, filename: path.basename(output) } } : {}) };
            this.update(task.id, { status: "succeeded", progress: 1, result });
            this.tasks.addEvent(task.id, "result", result);
        } finally {
            this.processes.delete(task.id);
            await Promise.all(temporaryFiles.map((file) => rm(file, { force: true })));
        }
    }
    private async resolveInput(value: string, taskId: string, index: number, temporaryFiles: string[]) {
        try { await access(value); return value; } catch {}
        if (!this.media?.meta(value)) throw new Error(`视频输入不存在：${value}`);
        const file = path.join(os.tmpdir(), `video-concat-${taskId}-${index}.mp4`);
        await writeFile(file, await this.media.read(value));
        temporaryFiles.push(file);
        return file;
    }
    private runFfmpeg(taskId: string, list: string, output: string, longEdge: number) {
        const scale = longEdge > 0 ? ["-vf", `scale='if(gte(iw,ih),${longEdge},-2)':'if(gte(iw,ih),-2,${longEdge})'`] : [];
        const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, ...scale, "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", output];
        return this.spawnFfmpeg(taskId, args);
    }
    /**
     * 横向并排（hstack）多路视频：所有格子等高、保持各自宽高比，短片用末帧补齐到最长时长，
     * 音轨取第一路（对比弹窗里第一路才是有声的源视频）。
     * `longEdge` 在此布局下表示**每格的目标高度**（调用方一般传 720 / 1080），0 = 用第一路的原始高度。
     */
    private async runHstackFfmpeg(taskId: string, inputs: string[], output: string, cellHeight: number) {
        const probes = await Promise.all(inputs.map((file) => this.probe(file)));
        const height = Math.max(2, Math.round(cellHeight > 0 ? cellHeight : probes[0]?.height || 720));
        const total = Math.max(...probes.map((probe) => probe.duration), 0);
        const parts = inputs.map((_, index) => {
            // hstack 要求各格尺寸/帧率/时基一致，因此每路统一到 fps=30 + AVTB 时基；
            // scale=-2:H 保持各自宽高比只固定高度；tpad 让短片停在末帧补到最长时长。
            const chain = [`scale=-2:${height}`, "setsar=1", "fps=30", "settb=AVTB", "setpts=PTS-STARTPTS"];
            const pad = total - (probes[index]?.duration || 0);
            if (pad > 0.05) chain.push(`tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`);
            return `[${index}:v]${chain.join(",")}[v${index}]`;
        });
        const filter = [...parts, `${inputs.map((_, index) => `[v${index}]`).join("")}hstack=inputs=${inputs.length}[out]`].join(";");
        const args = ["-hide_banner", "-loglevel", "error", "-y", ...inputs.flatMap((file) => ["-i", file]), "-filter_complex", filter, "-map", "[out]", "-map", "0:a?", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-c:a", "aac", "-movflags", "+faststart", output];
        await this.spawnFfmpeg(taskId, args);
    }
    /** 读视频宽高与时长；ffprobe 缺失或解析失败时返回 0，由调用方走安全默认。 */
    private probe(file: string): Promise<{ width: number; height: number; duration: number }> {
        const binary = process.env.FFPROBE_PATH || this.ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
        const args = ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file];
        return new Promise((resolve) => {
            const child = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"] });
            let stdout = "";
            child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
            child.once("error", () => resolve({ width: 0, height: 0, duration: 0 }));
            child.once("exit", () => {
                try {
                    const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number }>; format?: { duration?: string } };
                    const video = (parsed.streams || []).find((stream) => stream.codec_type === "video");
                    resolve({ width: Number(video?.width) || 0, height: Number(video?.height) || 0, duration: Number(parsed.format?.duration) || 0 });
                } catch { resolve({ width: 0, height: 0, duration: 0 }); }
            });
        });
    }
    private spawnFfmpeg(taskId: string, args: string[]) {
        return new Promise<void>((resolve, reject) => {
            const child = spawn(this.ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
            this.processes.set(taskId, child);
            let stderr = "";
            child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
            child.once("error", reject);
            child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg 失败（${code}）：${stderr.trim().slice(0, 1000)}`)));
        });
    }
    private update(id: string, patch: Parameters<TaskStore["update"]>[1]) { const task = this.tasks.update(id, patch); this.events?.publish({ type: task.status === "succeeded" ? "task.completed" : task.status === "failed" ? "task.failed" : "task.updated", entityId: id, payload: task }); return task; }
    private fail(id: string, error: unknown) { if (this.tasks.get(id)?.status === "cancelled") return; const message = error instanceof Error ? error.message : String(error); this.update(id, { status: "failed", error: message }); this.tasks.addEvent(id, "error", { error: message }); }
}
