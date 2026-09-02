import { spawn } from "node:child_process";
import type { RuntimeTask } from "../db.js";
import type { TaskStore } from "../stores/types.js";

/** Backend 唯一的视频拼接任务服务；任务状态统一写入 TaskStore。 */
export class VideoConcatBackend {
    constructor(private readonly tasks: TaskStore, private readonly ffmpeg = process.env.FFMPEG_PATH || "ffmpeg") {}
    status() { return new Promise<{ available: boolean; path: string; error?: string }>((resolve) => { const child = spawn(this.ffmpeg, ["-version"], { stdio: "ignore" }); child.once("error", (error) => resolve({ available: false, path: this.ffmpeg, error: error.message })); child.once("exit", (code) => resolve({ available: code === 0, path: this.ffmpeg, ...(code === 0 ? {} : { error: `ffmpeg exited with ${code}` }) })); }); }
    async run(videos: string[], output: string, longEdge: number | "auto" = "auto") {
        if (!videos.length) throw new Error("视频拼接至少需要一个视频"); if (!output.trim()) throw new Error("视频拼接缺少输出路径"); if (videos.some((file) => !file.trim())) throw new Error("视频输入路径无效");
        const task = this.tasks.create("video-concat", { videos }, { output, longEdge }); void this.execute(task).catch((error) => this.fail(task.id, error)); return task;
    }
    private execute(task: RuntimeTask) { return new Promise<void>((resolve, reject) => { this.tasks.update(task.id, { status: "running", progress: 0.05 }); const list = task.input.videos as string[]; const output = String(task.params.output); const args = ["-y", ...list.flatMap((file) => ["-i", file]), "-filter_complex", `${list.map((_, i) => `[${i}:v:0][${i}:a:0]`).join("")}concat=n=${list.length}:v=1:a=1[outv][outa]`, "-map", "[outv]", "-map", "[outa]", output]; const child = spawn(this.ffmpeg, args, { stdio: "ignore" }); child.once("error", reject); child.once("exit", (code) => { if (code !== 0) return reject(new Error(`ffmpeg exited with ${code}`)); const result = { path: output, longEdge: task.params.longEdge }; this.tasks.update(task.id, { status: "succeeded", progress: 1, result }); this.tasks.addEvent(task.id, "result", result); resolve(); }); }); }
    private fail(id: string, error: unknown) { const message = error instanceof Error ? error.message : String(error); this.tasks.update(id, { status: "failed", error: message }); this.tasks.addEvent(id, "error", { error: message }); }
}
