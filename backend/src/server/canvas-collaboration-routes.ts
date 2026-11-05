import type { Express } from "express";
import type { BackendDatabase } from "../db.js";
import type { CanvasRealtimeHub } from "../canvas/realtime-hub.js";

export function registerCanvasCollaborationRoutes(
    app: Express,
    db: Pick<BackendDatabase, "getCanvasProjectRevision">,
    realtime: Pick<CanvasRealtimeHub, "participants">,
) {
    app.get("/canvas/projects/:id/collaboration", (req, res) => {
        const revision = db.getCanvasProjectRevision(req.params.id);
        if (revision === null) return void res.status(404).json({ ok: false, error: "画布不存在" });
        res.json({ ok: true, projectId: req.params.id, revision, participants: realtime.participants(req.params.id) });
    });
}
