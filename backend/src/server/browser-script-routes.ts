import type { Request, Response, Router } from "express";

import { CanvasBrowserScriptDispatcher } from "../canvas/browser-script-dispatcher.js";

export function registerCanvasBrowserScriptRoutes(router: Router, dispatcher: CanvasBrowserScriptDispatcher) {
    action(router, "claim", (req) => dispatcher.claim(String(req.params.id), workerId(req)));
    action(router, "complete", (req) => dispatcher.complete(String(req.params.id), workerId(req), recordOf(req.body?.result)));
    action(router, "fail", (req) => dispatcher.fail(String(req.params.id), workerId(req), String(req.body?.error || "")));
    action(router, "release", (req) => dispatcher.release(String(req.params.id), workerId(req)));
}

function action(router: Router, name: string, run: (req: Request) => unknown) {
    router.post(`/canvas/browser-tasks/:id/${name}`, (req: Request, res: Response) => {
        try { res.json({ ok: true, task: run(req) }); }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(/不存在/.test(message) ? 404 : 409).json({ ok: false, error: message });
        }
    });
}

function workerId(req: Request) {
    const value = String(req.body?.workerId || "").trim();
    if (!value) throw new Error("workerId 必填");
    return value;
}
function recordOf(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
