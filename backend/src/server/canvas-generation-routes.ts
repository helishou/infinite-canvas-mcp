import type { Request, Response, Router } from "express";
import type { CanvasGenerationCommand } from "@basketikun/canvas-agent/generation-contract";
import { CanvasGenerationService } from "../canvas/generation-service.js";

/** 画布生成唯一 HTTP 入口；所有来源都提交同一份 command。 */
export function registerCanvasGenerationRoutes(router: Router, service: CanvasGenerationService) {
    const submit = async (req: Request, res: Response, command: CanvasGenerationCommand) => {
        try {
            const result = await service.start(command);
            res.status(result.task ? 201 : 202).json({ ok: true, ...result });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    };
    router.post("/canvas/generation", (req: Request, res: Response) => submit(req, res, (req.body || {}) as CanvasGenerationCommand));
}
