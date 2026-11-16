import type { Express, Request, Response } from "express";
import type { Stores } from "../stores/types.js";
import { createRunningHubProxy } from "../engine-contract/runninghub-proxy.js";
import { engineTargets } from "../engine-contract/workflow-catalog.js";
import type { VideoConcatBackend } from "../engine-contract/video-concat.js";
import type { BackendEventBus } from "../events.js";

/** Agent 兼容运行时路由，实际任务由 Backend 服务和 TaskStore 承担。 */
export function registerAgentRuntimeRoutes(app: Express, stores: Stores, videoConcat: VideoConcatBackend, events?: BackendEventBus) {
    // RunningHub 的管理接口统一代理到执行引擎（画布不再自带 RH 客户端）。
    // 引擎里同一份实现负责会话、档案、发布与任务，画布只做路径翻译。
    const resolveEngine = () => engineTargets((stores as unknown as { settings?: { get?: (key: string) => unknown } }).settings?.get?.("ai.config"));
    // express 5 的 path-to-regexp v8 不再接受裸 `*`，通配段必须命名（`*splat`）。
    app.all("/agent/runninghub/*splat", createRunningHubProxy(resolveEngine as never));
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
    return res.json({ ok: true, task, preview: null, events: stores.tasks.events(id, Number(req.query.after || 0)) });
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
