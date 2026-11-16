import express, { type Express, type Request, type Response } from "express";

import {
    AUDIO_TRANSCRIBE_BODY_LIMIT,
    AudioTranscribeError,
    audioTranscribeCapability,
    transcribeAudioClip,
} from "../runtime/audio-transcribe.js";

/**
 * Voice-input ASR channel. Unlike subtitle calibration this is a single synchronous request:
 * the microphone clip is decoded and transcribed in a temp directory, then discarded. Nothing
 * is written to the media store, projects, tasks or the event bus.
 *
 * TEMPORARILY DISABLED: local Whisper reloads torch/model on every call (~20s) and holds GPU
 * memory during inference, which competes with ComfyUI on this machine. No python/ffmpeg process
 * is spawned while disabled. Re-enable together with VOICE_INPUT_ENABLED in creative-launch-pad.tsx
 * once a cloud ASR channel is wired up.
 */
const VOICE_ASR_ENABLED: boolean = false;
const VOICE_ASR_DISABLED_REASON = "语音输入已停用：本地 Whisper 冷启动慢且推理占用显存，等待接入云端 ASR 通道。";

export function registerAudioTranscribeRoutes(app: Express) {
    app.get("/agent/audio-transcribe/status", (_req: Request, res: Response) => {
        const capability = audioTranscribeCapability();
        if (!VOICE_ASR_ENABLED) {
            res.json({ ...capability, available: false, reason: VOICE_ASR_DISABLED_REASON });
            return;
        }
        res.json(capability);
    });

    app.post(
        "/agent/audio-transcribe",
        express.raw({ type: "*/*", limit: AUDIO_TRANSCRIBE_BODY_LIMIT }),
        async (req: Request, res: Response) => {
            if (!VOICE_ASR_ENABLED) {
                res.status(503).json({ ok: false, error: VOICE_ASR_DISABLED_REASON, code: "VOICE_ASR_DISABLED" });
                return;
            }
            const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
            const language = typeof req.headers["x-audio-language"] === "string" ? req.headers["x-audio-language"] : undefined;
            try {
                const result = await transcribeAudioClip({
                    buffer,
                    mimeType: String(req.headers["content-type"] || "application/octet-stream"),
                    ...(language ? { language } : {}),
                });
                res.json(result);
            } catch (error) {
                const failure = error instanceof AudioTranscribeError
                    ? error
                    : new AudioTranscribeError(error instanceof Error ? error.message : String(error), "ASR_FAILED", 500);
                res.status(failure.status).json({ ok: false, error: failure.message, code: failure.code });
            }
        },
    );
}
