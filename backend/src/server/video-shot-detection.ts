import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express, Request, Response } from "express";
import type { Stores } from "../stores/types.js";

const workerPath = fileURLToPath(new URL("../../workers/detect_video_scenes.py", import.meta.url));

export function registerVideoShotDetectionRoute(app: Express, stores: Stores, detect = detectVideoScenes) {
    app.get("/canvas/projects/:id/video/:nodeId/scene-cuts", async (req: Request, res: Response) => {
        const project = stores.projects.get(String(req.params.id));
        if (!project) return void res.status(404).json({ ok: false, error: "画布不存在" });

        const node = (project.nodes as Array<Record<string, any>>).find((item) => item.id === String(req.params.nodeId));
        if (!node || node.type !== "video") return void res.status(404).json({ ok: false, error: "视频节点不存在" });
        const metadata = node.metadata && typeof node.metadata === "object" ? node.metadata : {};
        const storageKey = typeof metadata.storageKey === "string" ? metadata.storageKey : mediaStorageKey(metadata.content);
        if (!storageKey) return void res.status(409).json({ ok: false, error: "视频尚未归档到 Backend 媒体库，无法进行本地镜头检测" });

        const media = stores.media.meta(storageKey);
        if (!media || !media.mimeType.startsWith("video/")) return void res.status(404).json({ ok: false, error: "视频媒体不存在或格式无效" });

        try {
            const result = await detect(media.filePath);
            res.json({ ok: true, cuts: result.cuts });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const missingDependency = message.includes("PySceneDetect is missing");
            res.status(missingDependency ? 503 : 422).json({ ok: false, error: message });
        }
    });
}

function mediaStorageKey(content: unknown): string {
    if (typeof content !== "string") return "";
    try {
        const url = new URL(content, "http://localhost");
        const match = /^\/media\/([^/]+)$/.exec(url.pathname);
        return match ? decodeURIComponent(match[1]) : "";
    } catch { return ""; }
}

export type DetectedVideoCut = { frame: number; time: number };

export async function detectVideoScenes(videoPath: string): Promise<{ cuts: DetectedVideoCut[] }> {
    const python = process.env.SCENEDETECT_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const { stdout, stderr, code } = await runPython(python, [workerPath, path.resolve(videoPath)]);
    if (code !== 0) throw new Error(stderr.trim() || `PySceneDetect exited with ${code}`);
    let output: unknown;
    try { output = JSON.parse(stdout); }
    catch { throw new Error("PySceneDetect 返回了无效结果"); }
    const cuts = (output as { cuts?: unknown })?.cuts;
    if (!Array.isArray(cuts) || cuts.some((cut) => !Number.isInteger(cut?.frame) || cut.frame < 0 || !Number.isFinite(cut?.time) || cut.time < 0)) {
        throw new Error("PySceneDetect 返回的镜头边界格式无效");
    }
    return { cuts };
}

function runPython(command: string, args: string[]) {
    return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", (error) => reject(new Error(`无法启动 Python 镜头检测：${error.message}`)));
        child.once("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? -1 }));
    });
}
