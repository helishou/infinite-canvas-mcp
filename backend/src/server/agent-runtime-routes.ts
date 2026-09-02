import type { Express, Request, Response } from "express";
import type { Stores } from "../stores/types.js";
import type { RunningHubBackend } from "../runtime/runninghub.js";
import type { VideoConcatBackend } from "../runtime/video-concat.js";
import type { BackendEventBus } from "../events.js";

/** Agent 兼容运行时路由，实际任务由 Backend 服务和 TaskStore 承担。 */
export function registerAgentRuntimeRoutes(app: Express, stores: Stores, runningHub: RunningHubBackend, videoConcat: VideoConcatBackend, events?: BackendEventBus) {
    app.get("/agent/runninghub/status", (_req, res) => res.json({ ok: true, ...runningHub.status() }));
    app.get("/agent/runninghub/config", (_req, res) => res.json({ ok: true, config: mask(runningHub.getConfig()) }));
    app.put("/agent/runninghub/config", (req, res) => res.json({ ok: true, config: mask(runningHub.setConfig(req.body || {})) }));
    app.post("/agent/runninghub/tasks", async (req, res) => { const task = await runningHub.run(objectBody(req.body?.input), objectBody(req.body?.params)); events?.publish({ type: "task.created", entityId: task.id, payload: task }); res.status(202).json({ ok: true, task }); });
    app.get("/agent/runninghub/tasks/:id", (req, res) => taskResponse(req.params.id, "runninghub:", stores, req, res));
    app.post("/agent/runninghub/tasks/:id/cancel", (req, res) => { const task = runningHub.cancel(req.params.id); events?.publish({ type: "task.updated", entityId: task.id, payload: task }); res.json({ ok: true, task }); });
    app.get("/agent/ffmpeg/status", async (_req, res) => res.json({ ok: true, ...(await videoConcat.status()) }));
    app.post("/agent/video-concat/tasks", async (req, res) => { const task = await videoConcat.run(Array.isArray(req.body?.videos) ? req.body.videos.map(String) : [], String(req.body?.output || ""), req.body?.longEdge === "auto" || req.body?.longEdge === undefined ? "auto" : Number(req.body.longEdge)); events?.publish({ type: "task.created", entityId: task.id, payload: task }); res.status(202).json({ ok: true, task }); });
    app.get("/agent/runtime/tasks/:id", (req, res) => taskResponse(req.params.id, "", stores, req, res));
}

function taskResponse(id: string, prefix: string, stores: Stores, req: Request, res: Response) {
    const task = stores.tasks.get(id); if (!task || (prefix && !task.kind.startsWith(prefix))) return res.status(404).json({ ok: false, error: "task not found" });
    return res.json({ ok: true, task, events: stores.tasks.events(id, Number(req.query.after || 0)) });
}
function objectBody(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function mask<T extends Record<string, unknown>>(config: T): T { return { ...config, ...(config.apiKey ? { apiKey: "********" } : {}), ...(config.walletApiKey ? { walletApiKey: "********" } : {}) }; }
