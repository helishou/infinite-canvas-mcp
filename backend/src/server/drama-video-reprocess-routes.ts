import { type Request, type Response, type Router } from "express";

import type { BackendDatabase } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { Stores } from "../stores/types.js";
import { findReprocessableVideo, reprocessSegmentVideo, VideoReprocessFailure } from "../drama/video-reprocess.js";

/** 影策 POST /dramas/:id/episodes/:episodeId/segments/:index/reprocess 的本地真端点。 */
export function registerDramaVideoReprocessRoutes(router: Router, db: BackendDatabase, stores: Stores, events?: BackendEventBus) {
    // 只读预览：前端据此决定「重跑后处理」按钮是否可用，不产生任何写入。
    router.get("/drama/episodes/:episodeId/segments/:segmentId/reprocess-video", (req: Request, res: Response) => {
        try {
            const candidate = findReprocessableVideo({ db, stores, events }, String(req.params.episodeId || ""), String(req.params.segmentId || ""));
            res.json({ ok: true, reprocessable: !candidate.alreadyReady, alreadyReady: candidate.alreadyReady, storageKey: candidate.storageKey, generationLogId: candidate.log.id, status: candidate.log.status });
        } catch (error) {
            if (error instanceof VideoReprocessFailure) {
                res.json({ ok: false, reprocessable: false, code: error.code, reason: error.message });
                return;
            }
            res.status(500).json({ ok: false, reprocessable: false, code: "REPROCESS_PREVIEW_FAILED", error: error instanceof Error ? error.message : String(error) });
        }
    });

    router.post("/drama/episodes/:episodeId/segments/:segmentId/reprocess-video", async (req: Request, res: Response) => {
        try {
            const result = await reprocessSegmentVideo(
                { db, stores, events },
                String(req.params.episodeId || ""),
                String(req.params.segmentId || ""),
            );
            res.json(result);
        } catch (error) {
            if (error instanceof VideoReprocessFailure) {
                res.status(error.status).json({ ok: false, code: error.code, error: error.message, ...error.details });
                return;
            }
            res.status(500).json({ ok: false, code: "REPROCESS_FAILED", error: error instanceof Error ? error.message : String(error) });
        }
    });
}
