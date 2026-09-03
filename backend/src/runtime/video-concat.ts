import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { MEDIA_DIR } from "../config.js";
import type { RuntimeTask } from "../db.js";
import type { TaskStore } from "../stores/types.js";
import type { MediaStore } from "../stores/types.js";
import type { BackendEventBus } from "../events.js";

/** Backend 唯一的视频拼接任务服务；任务状态统一写入 TaskStore。 */
export class VideoConcatBackend {
    private readonly processes = new Map<string, ChildProcess>();
    constructor(private readonly tasks: TaskStore, private readonly ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", private readonly events?: BackendEventBus, private readonly media?: MediaStore) {}
    status() { return new Promise<{ available: boolean; path: string; error?: string }>((resolve) => { const child = spawn(this.ffmpeg, ["-version"], { stdio: "ignore" }); child.once("error", (error) => resolve({ available: false, path: this.ffmpeg, error: error.message })); child.once("exit", (code) => resolve({ available: code === 0, path: this.ffmpeg, ...(code === 0 ? {} : { error: `ffmpeg exited with ${code}` }) })); }); }
    async run(videos: string[], output = "", longEdge: number | "auto" = "auto") {
        if (!videos.length) throw new Error("视频拼接至少需要一个视频"); if (videos.some((file) => !file.trim())) throw new Error("视频输入无效");
        const task = this.tasks.create("video-concat", { videos }, { output, longEdge }); void this.execute(task).catch((error) => this.fail(task.id, error)); return task;
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
            const concatList = path.join(os.tmpdir(), `video-concat-${crypto.randomUUID()}.txt`);
            await writeFile(concatList, inputs.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
            temporaryFiles.push(concatList);
            await this.runFfmpeg(task.id, concatList, output, Number(task.params.longEdge) || 0);
            const stored = this.media ? this.media.store(await readFile(output), { name: path.basename(output), mimeType: "video/mp4", category: "output" }) : null;
            const result = { path: output, longEdge: task.params.longEdge, ...(stored ? { media: { url: this.media!.url(stored), storageKey: stored.storageKey, mimeType: stored.mimeType, filename: path.basename(output) } } : {}) };
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
