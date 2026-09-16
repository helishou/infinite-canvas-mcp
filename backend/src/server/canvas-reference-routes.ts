import type { Request, Response, Router } from "express";

import { CanvasReferenceService } from "../canvas/reference-service.js";

export function registerCanvasReferenceRoutes(router: Router, service: CanvasReferenceService) {
    router.get("/canvas/projects/:id/reference-assets", (req: Request, res: Response) => {
        try { res.json({ ok: true, assets: service.list(String(req.params.id || "")) }); }
        catch (error) { res.status(400).json({ ok: false, error: messageOf(error) }); }
    });
    router.post("/canvas/projects/:id/reference-assets", (req: Request, res: Response) => {
        try { res.status(201).json({ ok: true, asset: service.upsert(String(req.params.id || ""), recordOf(req.body)) }); }
        catch (error) { res.status(400).json({ ok: false, error: messageOf(error) }); }
    });
    router.delete("/canvas/projects/:id/reference-assets/:assetId", (req: Request, res: Response) => {
        try { res.json({ ok: true, deleted: service.remove(String(req.params.id || ""), String(req.params.assetId || "")) ? 1 : 0 }); }
        catch (error) { res.status(400).json({ ok: false, error: messageOf(error) }); }
    });
    router.post("/canvas/projects/:id/reference-validation", (req: Request, res: Response) => {
        try {
            const body = recordOf(req.body);
            res.json({ ok: true, validation: service.validate(String(req.params.id || ""), String(body.nodeId || ""), String(body.segmentId || "")) });
        } catch (error) { res.status(400).json({ ok: false, error: messageOf(error) }); }
    });
}

function recordOf(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
