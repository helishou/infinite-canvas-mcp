import type { Request, Response, Router } from "express";
import { CanvasImageDispatcher, type CanvasImageGenerationInput } from "../canvas/image-dispatcher.js";

export function registerCanvasGenerationRoutes(router: Router, dispatcher: CanvasImageDispatcher) {
    router.post("/canvas/image-generation", (req: Request, res: Response) => {
        try {
            const body = (req.body || {}) as CanvasImageGenerationInput;
            const result = dispatcher.start(body);
            res.json({ ok: true, ...result });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
}
