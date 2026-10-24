import type { Express, Request, Response } from "express";
import type { Stores } from "../stores/types.js";
import type { RunningHubBackend } from "../runtime/runninghub.js";
import type { VideoConcatBackend } from "../runtime/video-concat.js";
import type { BackendEventBus } from "../events.js";

/** Agent 兼容运行时路由，实际任务由 Backend 服务和 TaskStore 承担。 */
export function registerAgentRuntimeRoutes(app: Express, stores: Stores, runningHub: RunningHubBackend, videoConcat: VideoConcatBackend, events?: BackendEventBus) {
    app.get("/agent/runninghub/status", (_req, res) => res.json({ ok: true, ...runningHub.status(), workflowTaskReplaySafe: true }));
    app.get("/agent/runninghub/config", (_req, res) => res.json({ ok: true, config: mask(runningHub.getConfig()) }));
    app.put("/agent/runninghub/config", (req, res) => res.json({ ok: true, config: mask(runningHub.setConfig(req.body || {})) }));
    app.post("/agent/runninghub/workflow/inspect", async (req, res) => res.json({ ok: true, ...(await runningHub.inspectWorkflow(typeof req.body?.workflowId === "string" ? req.body.workflowId : undefined, siteOf(req))) }));
    // 网页会话：上传工作流走 RunningHub 网页端接口，需要登录令牌而不是 OpenAPI Key。两套站点各一份。
    app.get("/agent/runninghub/session", (req, res) => res.json({ ok: true, session: runningHub.sessionStatus(siteOf(req)) }));
    app.put("/agent/runninghub/session", async (req, res) => res.json({ ok: true, session: await runningHub.setSessionToken(typeof req.body?.accessToken === "string" ? req.body.accessToken : "", siteOf(req)) }));
    app.delete("/agent/runninghub/session", (req, res) => res.json({ ok: true, session: runningHub.disconnectSession(siteOf(req)) }));
    app.post("/agent/runninghub/session/browser-import", async (req, res) => res.json({ ok: true, session: await runningHub.importBrowserSession(siteOf(req)) }));
    // 本地节点图 → 云端工作流；拿到 workflowId 后自动建档，返回档案。站点缺省时跟随运行环境链路。
    app.post("/agent/runninghub/workflows/upload", async (req, res) => res.json({ ok: true, ...(await runningHub.publishLocalWorkflow({
        name: typeof req.body?.name === "string" ? req.body.name : undefined,
        graph: objectBody(req.body?.graph),
        // 原始 UI 格式（nodes/links）：RunningHub 编辑器只认这个，API 格式解析不出节点。
        uiWorkflow: req.body?.uiWorkflow && typeof req.body.uiWorkflow === "object" && !Array.isArray(req.body.uiWorkflow) ? req.body.uiWorkflow as Record<string, unknown> : undefined,
        site: siteOf(req),
    })) }));
    app.get("/agent/runninghub/workflows", (_req, res) => res.json({ ok: true, workflows: runningHub.listWorkflowProfiles() }));
    app.put("/agent/runninghub/workflows/:id", (req, res) => res.json({ ok: true, workflow: runningHub.saveWorkflowProfile({ ...objectBody(req.body), id: String(req.params.id) }) }));
    app.delete("/agent/runninghub/workflows/:id", (req, res) => res.json({ ok: true, deleted: runningHub.removeWorkflowProfile(String(req.params.id)) }));
    app.get("/agent/runninghub/workflows/:id/tasks", (req, res) => res.json({ ok: true, tasks: runningHub.listWorkflowTasks(String(req.params.id)) }));
    app.post("/agent/runninghub/workflows/:id/resync", async (req, res) => res.json({ ok: true, workflow: await runningHub.refreshProfileGraph(String(req.params.id)) }));
    app.post("/agent/runninghub/workflows/:id/run", async (req, res) => { const task = await runningHub.runWorkflow(String(req.params.id), objectBody(req.body?.input), objectBody(req.body?.values), objectBody(req.body?.params), typeof req.body?.clientTaskId === "string" && req.body.clientTaskId.trim() ? req.body.clientTaskId.trim() : undefined); events?.publish({ type: "task.created", entityId: task.id, payload: task }); res.status(202).json({ ok: true, task }); });
      app.get("/agent/runninghub/tasks/:id", (req, res) => { runningHub.resume(req.params.id); return taskResponse(req.params.id, "runninghub:", stores, req, res); });
    app.post("/agent/runninghub/tasks/:id/cancel", (req, res) => { const task = runningHub.cancel(req.params.id); events?.publish({ type: "task.updated", entityId: task.id, payload: task }); res.json({ ok: true, task }); });
    app.get("/agent/ffmpeg/status", async (_req, res) => res.json({ ok: true, ...(await videoConcat.status()) }));
    app.post("/agent/video-concat/tasks", async (req, res) => { const task = await videoConcat.run(Array.isArray(req.body?.videos) ? req.body.videos.map(String) : [], String(req.body?.output || ""), req.body?.longEdge === "auto" || req.body?.longEdge === undefined ? "auto" : Number(req.body.longEdge), undefined, undefined, req.body?.layout); events?.publish({ type: "task.created", entityId: task.id, payload: task }); res.status(202).json({ ok: true, task }); });
    app.post("/agent/video-concat/tasks/:id/cancel", (req, res) => { const task = videoConcat.cancel(req.params.id); events?.publish({ type: "task.updated", entityId: task.id, payload: task }); res.json({ ok: true, task }); });
    app.post("/agent/video-audio-extract/tasks", async (req, res) => {
        const storageKey = String(req.body?.storageKey || "").trim();
        const clientTaskId = String(req.body?.clientTaskId || "").trim();
        const projectId = String(req.body?.projectId || "").trim();
        const nodeId = String(req.body?.nodeId || "").trim();
        if (!storageKey || !clientTaskId || !projectId || !nodeId) return res.status(400).json({ ok: false, error: "storageKey、clientTaskId、projectId 与 nodeId 必填", code: "INVALID_AUDIO_EXTRACTION_INPUT" });
        const task = await videoConcat.extractAudio(storageKey, String(req.body?.name || "video"), clientTaskId, projectId, nodeId);
        events?.publish({ type: "task.created", entityId: task.id, payload: task });
        res.status(202).json({ ok: true, task });
    });
    app.post("/agent/video-audio-extract/tasks/:id/cancel", (req, res) => { const task = videoConcat.cancel(req.params.id); events?.publish({ type: "task.updated", entityId: task.id, payload: task }); res.json({ ok: true, task }); });
    app.get("/agent/runtime/tasks/:id", (req, res) => taskResponse(req.params.id, "", stores, req, res));
}

function taskResponse(id: string, prefix: string, stores: Stores, req: Request, res: Response) {
    const task = stores.tasks.get(id); if (!task || (prefix && !task.kind.startsWith(prefix))) return res.status(404).json({ ok: false, error: "task not found", code: "TASK_NOT_FOUND" });
    return res.json({ ok: true, task, events: stores.tasks.events(id, Number(req.query.after || 0)) });
}
function objectBody(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/** 站点既可以从 query 传（GET/DELETE），也可以从 body 传（PUT/POST）。 */
function siteOf(req: Request): "default" | "ai" | "cn" {
    const raw = typeof req.query?.site === "string" ? req.query.site : typeof req.body?.site === "string" ? req.body.site : "";
    return raw === "ai" || raw === "cn" ? raw : "default";
}
function mask<T extends Record<string, unknown>>(config: T): T {
    const keys = objectBody(config.siteApiKeys);
    return { ...config, ...(config.apiKey ? { apiKey: "********" } : {}), ...(config.walletApiKey ? { walletApiKey: "********" } : {}), ...(Object.keys(keys).length ? { siteApiKeys: { ...keys, ...(keys.ai ? { ai: "********" } : {}), ...(keys.cn ? { cn: "********" } : {}) } } : {}) } as T;
}
