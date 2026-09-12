import type { Request, Response, Router } from "express";
import type { CanvasH3Runner } from "../canvas/h3-runner.js";

export function registerCanvasH3RunRoutes(router: Router, runner: CanvasH3Runner) {
    router.post("/canvas/h3/runs", (req: Request, res: Response) => {
        try {
            const body = req.body || {};
            const task = runner.start(body, typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() || undefined : undefined);
            res.status(201).json({ ok: true, task });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
}
