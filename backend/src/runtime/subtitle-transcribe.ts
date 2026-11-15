import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import type { RuntimeTask } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { MediaStore, TaskStore } from "../stores/types.js";
import { mediaToolPath } from "@basketikun/media-engine/runtime/media-tools";

/** Word-level timestamps are the only thing the calibration layer consumes; segment text stays diagnostic. */
export type TranscriptWord = {
    word: string;
    start: number;
    end: number;
    probability: number;
};

export type ClipTranscript = {
    storageKey: string;
    /** Real media duration, independent of the authored Shot window. */
    durationSeconds: number;
    text: string;
    language: string;
    noSpeechProbability: number;
    words: TranscriptWord[];
    warnings: string[];
};

export type SubtitleTranscribeResult = {
    transcripts: ClipTranscript[];
    model: string;
    language: string;
    pythonPath: string;
    modelDir?: string;
};

export type SubtitleTranscribeInput = {
    storageKeys: string[];
    model?: string;
    language?: string;
    pythonPath?: string;
    modelDir?: string;
    fp16?: boolean;
};

export type WhisperRuntime = {
    pythonPath: string;
    model: string;
    language: string;
    fp16: boolean;
    modelDir?: string;
};

const MAX_CLIPS = 64;
const WAV_BYTES_PER_SECOND = 32000; // 16 kHz, mono, signed 16-bit PCM
const COMMON_PYTHON_CANDIDATES = [
    process.env.WHISPER_PYTHON,
    process.env.COMFYUI_PYTHON,
    "D:/ComfyUIV16/python/python.exe",
    "D:/ComfyUI/python/python.exe",
    "C:/ComfyUI/python/python.exe",
].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
const COMMON_MODEL_DIR_CANDIDATES = [
    process.env.WHISPER_MODEL_DIR,
    "D:/ComfyUIV16/ComfyUI/models/stt/whisper",
    "D:/ComfyUI/models/stt/whisper",
    "C:/ComfyUI/models/stt/whisper",
].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

function firstExisting(candidates: readonly string[]): string | undefined {
    return candidates.find(candidate => {
        try { return fs.statSync(candidate).isFile(); } catch { return false; }
    });
}

function firstDirectory(candidates: readonly string[]): string | undefined {
    return candidates.find(candidate => {
        try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
    });
}

/**
 * Resolve the local Whisper runtime without hard-coding one machine: explicit settings/env win,
 * then common ComfyUI installs, then bare `python`. Missing python is reported as an actionable
 * error by the task itself, never silently downgraded to fake timestamps.
 */
export function resolveWhisperRuntime(overrides: Partial<SubtitleTranscribeInput> = {}): WhisperRuntime {
    const pythonPath = (overrides.pythonPath || "").trim() || firstExisting(COMMON_PYTHON_CANDIDATES) || (process.platform === "win32" ? "python.exe" : "python3");
    const modelDir = (overrides.modelDir || "").trim() || firstDirectory(COMMON_MODEL_DIR_CANDIDATES);
    return {
        pythonPath,
        model: (overrides.model || process.env.WHISPER_MODEL || "base").trim() || "base",
        language: (overrides.language || process.env.WHISPER_LANGUAGE || "Chinese").trim() || "Chinese",
        fp16: typeof overrides.fp16 === "boolean" ? overrides.fp16 : String(process.env.WHISPER_FP16 || "True").toLowerCase() !== "false",
        ...(modelDir ? { modelDir } : {}),
    };
}

export function subtitleTranscribeCapability() {
    return { ...resolveWhisperRuntime(), ffmpeg: mediaToolPath("ffmpeg"), ffprobe: mediaToolPath("ffprobe") };
}

function num(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** Parse the openai-whisper `--output_format json --word_timestamps True` payload. */
export function parseWhisperJson(raw: unknown): Pick<ClipTranscript, "text" | "language" | "noSpeechProbability" | "words"> {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const segments = Array.isArray(value.segments) ? value.segments : [];
    const words: TranscriptWord[] = [];
    for (const segment of segments) {
        if (!segment || typeof segment !== "object") continue;
        const list = (segment as Record<string, unknown>).words;
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (!entry || typeof entry !== "object") continue;
            const word = entry as Record<string, unknown>;
            const label = String(word.word ?? "").trim();
            const start = num(word.start), end = num(word.end);
            if (!label || !(end >= start) || start < 0) continue;
            words.push({ word: label, start, end, probability: Math.max(0, Math.min(1, num(word.probability))) });
        }
    }
    const noSpeech = segments.map(segment => segment && typeof segment === "object" ? num((segment as Record<string, unknown>).no_speech_prob) : 0);
    const noSpeechProbability = noSpeech.length ? noSpeech.reduce((sum, item) => sum + item, 0) / noSpeech.length : 0;
    return {
        text: String(value.text ?? ""),
        language: String(value.language ?? ""),
        noSpeechProbability,
        words,
    };
}

function runProcess(command: string, args: readonly string[], onSpawn?: (child: ChildProcess) => void): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        onSpawn?.(child);
        let stdout = "", stderr = "";
        child.stdout?.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-64_000); });
        child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-64_000); });
        child.once("error", error => reject(error));
        child.once("exit", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(command)} 退出码 ${code}: ${stderr.slice(-600) || stdout.slice(-600)}`)));
    });
}

/** Backend-owned transcription tasks: real video audio -> word timestamps, never a guessed timeline. */
export class SubtitleTranscribeBackend {
    private readonly processes = new Map<string, ChildProcess>();
    private readonly executing = new Set<string>();

    constructor(private readonly tasks: TaskStore, private readonly media?: MediaStore, private readonly events?: BackendEventBus) {}

    start(input: SubtitleTranscribeInput, clientTaskId: string) {
        const storageKeys = [...new Set((Array.isArray(input.storageKeys) ? input.storageKeys : []).map(String).map(item => item.trim()).filter(Boolean))];
        if (!storageKeys.length) throw new Error("字幕校准需要至少一个已生成的视频");
        if (storageKeys.length > MAX_CLIPS) throw new Error(`一次最多校准 ${MAX_CLIPS} 段视频，当前 ${storageKeys.length} 段`);
        const runtime = resolveWhisperRuntime(input);
        const normalized = { storageKeys, model: runtime.model, language: runtime.language, ...(runtime.modelDir ? { modelDir: runtime.modelDir } : {}), pythonPath: runtime.pythonPath, fp16: runtime.fp16 };
        const existing = this.tasks.get(clientTaskId);
        if (existing) {
            if (existing.kind !== "subtitle-transcribe" || JSON.stringify(existing.input) !== JSON.stringify(normalized)) throw new Error("字幕校准任务 ID 已用于不同输入");
            if (!(["queued", "running"].includes(existing.status)) || this.executing.has(existing.id)) return existing;
        }
        const task = existing || this.tasks.create(clientTaskId, "subtitle-transcribe", normalized, {});
        this.executing.add(task.id);
        void this.execute(task, normalized).catch(error => this.fail(task.id, error)).finally(() => this.executing.delete(task.id));
        return task;
    }

    cancel(id: string) {
        this.processes.get(id)?.kill();
        const task = this.tasks.cancel(id);
        this.events?.publish({ type: "task.updated", entityId: id, payload: task });
        return task;
    }

    private update(id: string, patch: { status?: "queued" | "running" | "succeeded" | "failed" | "cancelled"; progress?: number; result?: Record<string, unknown>; error?: string }) {
        const task = this.tasks.update(id, patch);
        this.events?.publish({ type: "task.updated", entityId: id, payload: task });
        return task;
    }

    private fail(id: string, error: unknown) {
        const current = this.tasks.get(id);
        if (!current || ["succeeded", "failed", "cancelled"].includes(current.status)) return;
        const message = error instanceof Error ? error.message : String(error);
        this.update(id, { status: "failed", error: message });
        this.tasks.addEvent(id, "error", { error: message });
    }

    private assertActive(id: string) {
        if (!["queued", "running"].includes(this.tasks.get(id)?.status || "")) throw new Error("字幕校准任务已停止");
    }

    private async execute(task: RuntimeTask, input: SubtitleTranscribeInput & { storageKeys: string[] }) {
        const runtime = resolveWhisperRuntime(input);
        const ffmpeg = mediaToolPath("ffmpeg");
        const ffprobe = mediaToolPath("ffprobe");
        const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-subtitle-transcribe-"));
        this.update(task.id, { status: "running", progress: 0.02 });
        try {
            const transcripts: ClipTranscript[] = [];
            for (const [index, storageKey] of input.storageKeys.entries()) {
                this.assertActive(task.id);
                const meta = this.media?.meta(storageKey);
                if (!meta) throw new Error(`媒体不存在或已删除：${storageKey}`);
                if (!String(meta.mimeType || "").startsWith("video/")) throw new Error(`字幕校准输入不是视频：${storageKey}`);
                const videoPath = path.join(directory, `clip-${index}.video`);
                const wavPath = path.join(directory, `clip-${index}.wav`);
                const jsonPath = path.join(directory, `clip-${index}.json`);
                await writeFile(videoPath, await this.media!.read(storageKey));
                this.assertActive(task.id);
                const warnings: string[] = [];
                let durationSeconds = 0;
                try {
                    const probe = await runProcess(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", videoPath], child => this.processes.set(task.id, child));
                    durationSeconds = Math.max(0, Number.parseFloat(probe.stdout.trim()));
                } catch {
                    warnings.push("ffprobe 未能读取视频时长，回退到 WAV 字节长度估算");
                }
                if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) durationSeconds = 0;
                await runProcess(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath], child => this.processes.set(task.id, child));
                this.assertActive(task.id);
                if (!durationSeconds) {
                    const wavStat = await stat(wavPath);
                    durationSeconds = Math.max(0, (wavStat.size - 44) / WAV_BYTES_PER_SECOND);
                }
                const args = ["-m", "whisper", wavPath,
                    "--model", runtime.model,
                    ...(runtime.modelDir ? ["--model_dir", runtime.modelDir] : []),
                    "--language", runtime.language,
                    "--word_timestamps", "True",
                    "--output_format", "json",
                    "--output_dir", directory,
                    "--fp16", runtime.fp16 ? "True" : "False",
                    "--verbose", "False"];
                try {
                    await runProcess(runtime.pythonPath, args, child => this.processes.set(task.id, child));
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (/ENOENT|不是内部或外部命令|No module named whisper/i.test(message)) {
                        throw new Error(`本机 Whisper 不可用（${runtime.pythonPath}）。请设置 WHISPER_PYTHON 指向已安装 openai-whisper 的 python.exe，或在请求中传 pythonPath。原始错误：${message}`);
                    }
                    throw error;
                }
                this.assertActive(task.id);
                let parsed: ReturnType<typeof parseWhisperJson>;
                try {
                    parsed = parseWhisperJson(JSON.parse(await readFile(jsonPath, "utf8")));
                } catch (error) {
                    throw new Error(`Whisper 已运行但未产出可解析的词级时间戳 JSON：${error instanceof Error ? error.message : String(error)}`);
                }
                if (!parsed.words.length) warnings.push("未识别到任何词级时间戳，该段将不会改写字幕时间线");
                if (parsed.noSpeechProbability > 0.5) warnings.push(`音频很可能不含清晰语音（no_speech_prob=${parsed.noSpeechProbability.toFixed(2)}），识别结果不可信`);
                const lowProbability = parsed.words.filter(word => word.probability < 0.2).length;
                if (parsed.words.length && lowProbability / parsed.words.length > 0.5) warnings.push(`${lowProbability}/${parsed.words.length} 个词置信度低于 0.2，建议换用更大的 Whisper 模型`);
                transcripts.push({ storageKey, durationSeconds, ...parsed, warnings });
                this.update(task.id, { progress: 0.02 + 0.94 * ((index + 1) / input.storageKeys.length) });
                this.tasks.addEvent(task.id, "progress", { completed: index + 1, total: input.storageKeys.length, storageKey, words: parsed.words.length });
            }
            const result: SubtitleTranscribeResult = {
                transcripts,
                model: runtime.model,
                language: runtime.language,
                pythonPath: runtime.pythonPath,
                ...(runtime.modelDir ? { modelDir: runtime.modelDir } : {}),
            };
            this.update(task.id, { status: "succeeded", progress: 1, result: { ...result } as unknown as Record<string, unknown> });
            this.tasks.addEvent(task.id, "result", { clips: transcripts.length, words: transcripts.reduce((sum, item) => sum + item.words.length, 0) });
        } finally {
            this.processes.delete(task.id);
            await rm(directory, { recursive: true, force: true });
        }
    }
}
