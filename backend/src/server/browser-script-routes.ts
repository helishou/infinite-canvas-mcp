import type { Request, Response, Router } from "express";

import { CanvasBrowserScriptDispatcher } from "../canvas/browser-script-dispatcher.js";

export function registerCanvasBrowserScriptRoutes(router: Router, dispatcher: CanvasBrowserScriptDispatcher) {
    router.post("/canvas/browser-tasks/:id/claim", (req: Request, res: Response) => {
        try { res.json({ ok: true, ...dispatcher.claim(String(req.params.id), workerId(req)) }); }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(/不存在/.test(message) ? 404 : 409).json({ ok: false, error: message });
        }
    });
    action(router, "checkpoint", req => dispatcher.checkpoint(String(req.params.id), workerId(req), claimToken(req), recordOf(req.body?.recovery)));
    action(router, "complete", (req) => dispatcher.complete(String(req.params.id), workerId(req), recordOf(req.body?.result), claimToken(req)));
    action(router, "fail", (req) => dispatcher.fail(String(req.params.id), workerId(req), String(req.body?.error || ""), claimToken(req), req.body?.terminalConfirmed === true, req.body?.notSubmitted === true));
    action(router, "release", (req) => dispatcher.release(String(req.params.id), workerId(req), claimToken(req), String(req.body?.error || "")));
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

function claimToken(req: Request) {
    const token = String(req.body?.claimToken || "").trim();
    if (!token) throw new Error("浏览器模型任务认领已失效，请刷新执行器");
    return token;
}
