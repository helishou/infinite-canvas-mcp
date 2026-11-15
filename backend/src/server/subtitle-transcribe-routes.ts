import type { Express, Request, Response } from "express";
import type { BackendEventBus } from "../events.js";
import { subtitleTranscribeCapability, type SubtitleTranscribeBackend } from "../runtime/subtitle-transcribe.js";

/**
 * Word-timestamp transcription for the "calibrate subtitles" delivery action.
 * Task polling reuses the existing `/agent/runtime/tasks/:id` endpoint (no prefix filter),
 * so this module only owns create / cancel / capability.
 */
export function registerSubtitleTranscribeRoutes(app: Express, transcriber: SubtitleTranscribeBackend, events?: BackendEventBus) {
    app.get("/agent/subtitle-transcribe/status", (_req, res) => res.json({ ok: true, available: true, ...transcriberStatus(transcriber) }));

    app.post("/agent/subtitle-transcribe/tasks", (req: Request, res: Response) => {
        const storageKeys = Array.isArray(req.body?.storageKeys) ? req.body.storageKeys.map(String) : [];
        const clientTaskId = String(req.body?.clientTaskId || "").trim();
        if (!storageKeys.length || !clientTaskId) return res.status(400).json({ ok: false, error: "storageKeys 与 clientTaskId 必填", code: "INVALID_SUBTITLE_TRANSCRIBE_INPUT" });
        try {
            const task = transcriber.start({
                storageKeys,
                ...(typeof req.body?.model === "string" ? { model: req.body.model } : {}),
                ...(typeof req.body?.language === "string" ? { language: req.body.language } : {}),
                ...(typeof req.body?.pythonPath === "string" ? { pythonPath: req.body.pythonPath } : {}),
                ...(typeof req.body?.modelDir === "string" ? { modelDir: req.body.modelDir } : {}),
                ...(typeof req.body?.fp16 === "boolean" ? { fp16: req.body.fp16 } : {}),
            }, clientTaskId);
            events?.publish({ type: "task.created", entityId: task.id, payload: task });
            return res.status(202).json({ ok: true, task });
        } catch (error) {
            return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error), code: "SUBTITLE_TRANSCRIBE_REJECTED" });
        }
    });

    app.post("/agent/subtitle-transcribe/tasks/:id/cancel", (req, res) => {
        const task = transcriber.cancel(req.params.id);
        events?.publish({ type: "task.updated", entityId: task.id, payload: task });
        res.json({ ok: true, task });
    });
}

function transcriberStatus(_transcriber: SubtitleTranscribeBackend) {
    // Capability is reported by the runtime module; keeping this thin avoids duplicating probe logic.
    return { kind: "subtitle-transcribe", ...subtitleTranscribeCapability() };
}
