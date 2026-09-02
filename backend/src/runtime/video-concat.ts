import { spawn } from "node:child_process";
import type { RuntimeTask } from "../db.js";
import type { TaskStore } from "../stores/types.js";
import type { MediaStore } from "../stores/types.js";
import type { BackendEventBus } from "../events.js";

/** Backend 唯一的视频拼接任务服务；任务状态统一写入 TaskStore。 */
export class VideoConcatBackend {
    constructor(private readonly tasks: TaskStore, private readonly ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", private readonly events?: BackendEventBus, private readonly media?: MediaStore) {}
    status() { return new Promise<{ available: boolean; path: string; error?: string }>((resolve) => { const child = spawn(this.ffmpeg, ["-version"], { stdio: "ignore" }); child.once("error", (error) => resolve({ available: false, path: this.ffmpeg, error: error.message })); child.once("exit", (code) => resolve({ available: code === 0, path: this.ffmpeg, ...(code === 0 ? {} : { error: `ffmpeg exited with ${code}` }) })); }); }
    async run(videos: string[], output: string, longEdge: number | "auto" = "auto") {
        if (!videos.length) throw new Error("视频拼接至少需要一个视频"); if (!output.trim()) throw new Error("视频拼接缺少输出路径"); if (videos.some((file) => !file.trim())) throw new Error("视频输入路径无效");
        const task = this.tasks.create("video-concat", { videos }, { output, longEdge }); void this.execute(task).catch((error) => this.fail(task.id, error)); return task;
    }
    private execute(task: RuntimeTask) { return new Promise<void>((resolve, reject) => { this.update(task.id, { status: "running", progress: 0.05 }); const list = task.input.videos as string[]; const output = String(task.params.output); const args = ["-y", ...list.flatMap((file) => ["-i", file]), "-filter_complex", `${list.map((_, i) => `[${i}:v:0][${i}:a:0]`).join("")}concat=n=${list.length}:v=1:a=1[outv][outa]`, "-map", "[outv]", "-map", "[outa]", output]; const child = spawn(this.ffmpeg, args, { stdio: "ignore" }); child.once("error", reject); child.once("exit", (code) => { void (async () => { if (code !== 0) throw new Error(`ffmpeg exited with ${code}`); const stored = this.media ? this.media.store(await import("node:fs/promises").then(({ readFile }) => readFile(output)), { name: output, mimeType: "video/mp4" }) : null; const result = { path: output, longEdge: task.params.longEdge, ...(stored ? { media: { url: this.media!.url(stored), storageKey: stored.storageKey, mimeType: stored.mimeType, filename: output } } : {}) }; this.update(task.id, { status: "succeeded", progress: 1, result }); this.tasks.addEvent(task.id, "result", result); })().then(resolve, reject); }); }); }
    private update(id: string, patch: Parameters<TaskStore["update"]>[1]) { const task = this.tasks.update(id, patch); this.events?.publish({ type: task.status === "succeeded" ? "task.completed" : task.status === "failed" ? "task.failed" : "task.updated", entityId: id, payload: task }); return task; }
    private fail(id: string, error: unknown) { const message = error instanceof Error ? error.message : String(error); this.update(id, { status: "failed", error: message }); this.tasks.addEvent(id, "error", { error: message }); }
}
