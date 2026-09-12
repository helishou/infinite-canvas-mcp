import type { Request, Response, Router } from "express";
import type { CanvasGenerationService } from "../canvas/generation-service.js";

/** 旧 H3 URL 仅保留协议兼容，执行仍进入 CanvasGenerationService。 */
export function registerCanvasH3RunRoutes(router: Router, service: CanvasGenerationService) {
    router.post("/canvas/h3/runs", async (req: Request, res: Response) => {
        try {
            const body = req.body || {};
            const result = await service.start({ ...body, mode: "video", operation: "h3-run" });
            res.status(201).json({ ok: true, task: result.task });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
}
