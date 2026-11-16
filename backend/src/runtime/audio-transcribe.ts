import fs from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { mediaToolPath } from "@basketikun/media-engine/runtime/media-tools";
import { parseWhisperJson, resolveWhisperRuntime, runProcess, type SubtitleTranscribeInput, type WhisperRuntime } from "./subtitle-transcribe.js";

/**
 * Short-form voice input transcription (microphone clip -> text).
 *
 * This is intentionally separate from SubtitleTranscribeBackend: that one consumes archived
 * video storageKeys and produces word-level timestamps for subtitle calibration, while this
 * one is a synchronous request that must never create a media asset, a project node or a task.
 * Both share the same local Whisper runtime resolution and JSON parsing.
 */
export const AUDIO_TRANSCRIBE_MAX_BYTES = 12 * 1024 * 1024;
export const AUDIO_TRANSCRIBE_MAX_SECONDS = 60;
/** Express body cap is deliberately higher so oversized uploads still return a JSON error. */
export const AUDIO_TRANSCRIBE_BODY_LIMIT = "16mb";

const DECODE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;
const WHISPER_TIMEOUT_MS = 180_000;
const WAV_BYTES_PER_SECOND = 32_000; // 16 kHz, mono, signed 16-bit PCM

const ALLOWED_MIME = new Set([
    "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/mp3",
    "audio/wav", "audio/x-wav", "audio/wave", "audio/flac", "audio/aac",
    "audio/x-m4a", "audio/opus", "video/webm", "application/octet-stream",
]);

const EXTENSION_BY_MIME: Record<string, string> = {
    "audio/webm": "webm", "video/webm": "webm", "audio/ogg": "ogg", "audio/opus": "ogg",
    "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac",
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
    "audio/wave": "wav", "audio/flac": "flac", "application/octet-stream": "bin",
};

export type AudioTranscribeErrorCode =
    | "INVALID_AUDIO_INPUT"
    | "AUDIO_TOO_LARGE"
    | "UNSUPPORTED_AUDIO_FORMAT"
    | "AUDIO_TOO_LONG"
    | "ASR_UNAVAILABLE"
    | "ASR_DECODE_FAILED"
    | "ASR_RUNTIME_UNAVAILABLE"
    | "ASR_TIMEOUT"
    | "ASR_RESULT_INVALID"
    | "ASR_FAILED";

export class AudioTranscribeError extends Error {
    constructor(message: string, readonly code: AudioTranscribeErrorCode, readonly status = 400) {
        super(message);
        this.name = "AudioTranscribeError";
    }
}

export type AudioTranscribeCapability = {
    ok: true;
    available: boolean;
    engine: "local-whisper";
    /** Actionable explanation when `available` is false. */
    reason?: string;
    pythonPath: string;
    model: string;
    modelPath?: string;
    modelDir?: string;
    ffmpeg: string;
    fp16: boolean;
    maxBytes: number;
    maxSeconds: number;
};

export type AudioTranscribeRequest = {
    buffer: Buffer;
    mimeType: string;
    /** UI locale hint ("zh-CN" / "en-US"); unknown values fall back to auto detection. */
    language?: string;
    model?: string;
    pythonPath?: string;
    modelDir?: string;
    fp16?: boolean;
};

export type AudioTranscribeResult = {
    ok: true;
    text: string;
    language: string;
    model: string;
    durationSeconds: number;
    noSpeechProbability: number;
};

function executableExists(command: string): boolean {
    // Bare commands resolve through PATH; the real failure is reported by the transcription request.
    if (!path.isAbsolute(command) && !/[\\/]/.test(command)) return true;
    try { return fs.statSync(command).isFile(); } catch { return false; }
}

/** Whisper resolves models from --model_dir or ~/.cache/whisper/<model>.pt. */
export function resolveLocalWhisperModel(runtime: WhisperRuntime): { modelPath?: string; modelDir?: string } {
    if (runtime.modelDir) {
        const candidate = path.join(runtime.modelDir, `${runtime.model}.pt`);
        try { if (fs.statSync(candidate).isFile()) return { modelPath: candidate, modelDir: runtime.modelDir }; } catch { /* fall through */ }
    }
    const cached = path.join(os.homedir(), ".cache", "whisper", `${runtime.model}.pt`);
    try { if (fs.statSync(cached).isFile()) return { modelPath: cached }; } catch { /* missing */ }
    return {};
}

/**
 * Capability is a cheap, honest file probe: no fake "available" flag when python, ffmpeg or
 * the model file is missing. Module import verification is left to the actual run, which
 * reports an actionable ASR_RUNTIME_UNAVAILABLE error.
 */
export function audioTranscribeCapability(overrides: Partial<SubtitleTranscribeInput> = {}): AudioTranscribeCapability {
    const runtime = resolveWhisperRuntime(overrides);
    const model = resolveLocalWhisperModel(runtime);
    const ffmpeg = mediaToolPath("ffmpeg");
    const base: AudioTranscribeCapability = {
        ok: true,
        available: true,
        engine: "local-whisper",
        pythonPath: runtime.pythonPath,
        model: runtime.model,
        ...(model.modelPath ? { modelPath: model.modelPath } : {}),
        ...(model.modelDir ? { modelDir: model.modelDir } : {}),
        ffmpeg,
        fp16: runtime.fp16,
        maxBytes: AUDIO_TRANSCRIBE_MAX_BYTES,
        maxSeconds: AUDIO_TRANSCRIBE_MAX_SECONDS,
    };
    if (!executableExists(runtime.pythonPath)) return { ...base, available: false, reason: `Whisper Python 不存在：${runtime.pythonPath}。请设置 WHISPER_PYTHON。` };
    if (!executableExists(ffmpeg)) return { ...base, available: false, reason: `ffmpeg 不存在：${ffmpeg}。` };
    if (!model.modelPath) return { ...base, available: false, reason: `未找到本地 Whisper 模型 ${runtime.model}.pt。请设置 WHISPER_MODEL_DIR，或把模型放到 ~/.cache/whisper/。` };
    return base;
}

/** Normalize a raw upload before any external process is spawned. */
export function validateAudioUpload(buffer: Buffer, mimeType: string): { mimeType: string; extension: string } {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new AudioTranscribeError("音频内容为空", "INVALID_AUDIO_INPUT");
    if (buffer.length > AUDIO_TRANSCRIBE_MAX_BYTES) throw new AudioTranscribeError(`音频超过 ${Math.round(AUDIO_TRANSCRIBE_MAX_BYTES / 1024 / 1024)}MB 上限`, "AUDIO_TOO_LARGE", 413);
    const normalized = String(mimeType || "").split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
    if (!ALLOWED_MIME.has(normalized)) throw new AudioTranscribeError(`不支持的音频格式：${normalized}`, "UNSUPPORTED_AUDIO_FORMAT");
    return { mimeType: normalized, extension: EXTENSION_BY_MIME[normalized] || "bin" };
}

/** Only pass a language Whisper actually knows; everything else uses auto detection. */
export function mapWhisperLanguage(language?: string): string | undefined {
    const value = String(language || "").trim().toLowerCase();
    if (!value || value === "auto") return undefined;
    if (value.startsWith("zh") || value === "chinese" || value === "cmn") return "Chinese";
    if (value.startsWith("en") || value === "english") return "English";
    return undefined;
}

function asTranscribeError(error: unknown, fallbackCode: AudioTranscribeErrorCode, fallbackStatus: number): AudioTranscribeError {
    if (error instanceof AudioTranscribeError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (/执行超过 .* 秒/.test(message)) return new AudioTranscribeError(message, "ASR_TIMEOUT", 504);
    if (/ENOENT|不是内部或外部命令|No module named whisper/i.test(message)) {
        return new AudioTranscribeError(`本机 Whisper 不可用。请设置 WHISPER_PYTHON 指向已安装 openai-whisper 的 python.exe。原始错误：${message}`, "ASR_RUNTIME_UNAVAILABLE", 503);
    }
    return new AudioTranscribeError(message, fallbackCode, fallbackStatus);
}

/** Transcribe one short audio clip. No media asset, task or project mutation is performed. */
export async function transcribeAudioClip(input: AudioTranscribeRequest): Promise<AudioTranscribeResult> {
    const { mimeType, extension } = validateAudioUpload(input.buffer, input.mimeType);
    const capability = audioTranscribeCapability();
    if (!capability.available) throw new AudioTranscribeError(capability.reason || "本机 ASR 通道不可用", "ASR_UNAVAILABLE", 503);

    const runtime = resolveWhisperRuntime({
        ...(input.model ? { model: input.model } : {}),
        ...(input.pythonPath ? { pythonPath: input.pythonPath } : {}),
        ...(input.modelDir ? { modelDir: input.modelDir } : {}),
        ...(typeof input.fp16 === "boolean" ? { fp16: input.fp16 } : {}),
    });
    const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-audio-transcribe-"));
    try {
        const sourcePath = path.join(directory, `input.${extension}`);
        const wavPath = path.join(directory, "audio.wav");
        const jsonPath = path.join(directory, "audio.json");
        await writeFile(sourcePath, input.buffer);

        let durationSeconds = 0;
        try {
            const probe = await runProcess(mediaToolPath("ffprobe"), ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", sourcePath], undefined, PROBE_TIMEOUT_MS);
            durationSeconds = Math.max(0, Number.parseFloat(probe.stdout.trim()));
        } catch { /* fall back to WAV byte count below */ }
        if (!Number.isFinite(durationSeconds)) durationSeconds = 0;
        if (durationSeconds > AUDIO_TRANSCRIBE_MAX_SECONDS) {
            throw new AudioTranscribeError(`录音超过 ${AUDIO_TRANSCRIBE_MAX_SECONDS} 秒上限`, "AUDIO_TOO_LONG", 413);
        }

        try {
            await runProcess(capability.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath], undefined, DECODE_TIMEOUT_MS);
        } catch (error) {
            throw asTranscribeError(error, "ASR_DECODE_FAILED", 400);
        }
        if (!durationSeconds) {
            const wavStat = await stat(wavPath);
            durationSeconds = Math.max(0, (wavStat.size - 44) / WAV_BYTES_PER_SECOND);
        }
        if (durationSeconds > AUDIO_TRANSCRIBE_MAX_SECONDS) {
            throw new AudioTranscribeError(`录音超过 ${AUDIO_TRANSCRIBE_MAX_SECONDS} 秒上限`, "AUDIO_TOO_LONG", 413);
        }

        const model = resolveLocalWhisperModel(runtime);
        const language = mapWhisperLanguage(input.language);
        const args = ["-m", "whisper", wavPath,
            "--model", runtime.model,
            ...(model.modelDir ? ["--model_dir", model.modelDir] : []),
            ...(language ? ["--language", language] : []),
            "--output_format", "json",
            "--output_dir", directory,
            "--fp16", runtime.fp16 ? "True" : "False",
            "--verbose", "False"];
        try {
            await runProcess(runtime.pythonPath, args, undefined, WHISPER_TIMEOUT_MS);
        } catch (error) {
            throw asTranscribeError(error, "ASR_FAILED", 500);
        }

        let parsed: ReturnType<typeof parseWhisperJson>;
        try {
            parsed = parseWhisperJson(JSON.parse(await readFile(jsonPath, "utf8")));
        } catch (error) {
            throw new AudioTranscribeError(`Whisper 已运行但未产出可解析的 JSON：${error instanceof Error ? error.message : String(error)}`, "ASR_RESULT_INVALID", 500);
        }
        return {
            ok: true,
            text: parsed.text.trim(),
            language: parsed.language,
            model: runtime.model,
            durationSeconds: Math.round(durationSeconds * 100) / 100,
            noSpeechProbability: parsed.noSpeechProbability,
        };
    } catch (error) {
        throw asTranscribeError(error, "ASR_DECODE_FAILED", 500);
    } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
}
