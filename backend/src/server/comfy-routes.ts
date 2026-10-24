import path from "node:path";
import { projectModelCatalog } from "@basketikun/canvas-agent/runtime/model-catalog";
import type { Request, Response } from "express";

import { type ResolvedConfig } from "../config.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import type { Stores } from "../stores/types.js";
import type { BackendEventBus } from "../events.js";

/** ComfyUI Bridge 路由（总后台权威，Agent 变纯代理）。 */
export function registerComfyRoutes(ctx: { app: import("express").Express; stores: Stores; config: ResolvedConfig; events?: BackendEventBus; basePath?: string }, bridge: ComfyUiBackend) {
    const { app, stores, config } = ctx;
    const routePath = (value: string) => `${ctx.basePath || ""}${value}`;

    /** 模型清单短 TTL 缓存 + 在途合并：ComfyUI 不可达或 URL 变化时回退到实时读取，不缓存失败。 */
    const MODEL_CATALOG_TTL_MS = 5000;
    type ModelCatalog = Awaited<ReturnType<ComfyUiBackend["models"]>>;
    let modelCatalogUrl = "";
    let modelCatalogAt = 0;
    let modelCatalogValue: ModelCatalog | null = null;
    let modelCatalogInFlight: Promise<ModelCatalog> | null = null;
    const resetModelCatalogCache = () => { modelCatalogUrl = ""; modelCatalogAt = 0; modelCatalogValue = null; modelCatalogInFlight = null; };
    const loadModelCatalog = (): Promise<ModelCatalog> => {
        const url = bridge.getUrl();
        if (modelCatalogUrl === url && modelCatalogValue && Date.now() - modelCatalogAt <= MODEL_CATALOG_TTL_MS) return Promise.resolve(modelCatalogValue);
        if (modelCatalogUrl === url && modelCatalogInFlight) return modelCatalogInFlight;
        modelCatalogUrl = url;
        modelCatalogInFlight = bridge.models().then((catalog) => {
            modelCatalogValue = catalog;
            modelCatalogAt = Date.now();
            modelCatalogInFlight = null;
            return catalog;
        }, (error) => {
            modelCatalogInFlight = null;
            throw error;
        });
        return modelCatalogInFlight;
    };

    app.get(routePath("/comfy/status"), async (_req, res) => {
        res.json({ ok: true, ...(await bridge.status()) });
    });

    app.get(routePath("/comfy/models"), async (req, res) => {
        try {
            const catalog = await loadModelCatalog();
            const input = { ...req.query, categories: typeof req.query.categories === "string" ? req.query.categories.split(",") : req.query.categories };
            res.json({ ok: true, data: req.query.view ? projectModelCatalog(catalog, input) : catalog });
        } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });

    /** 代理 ComfyUI 媒体预览（/view） */
    app.get(routePath("/comfy/media"), async (req: Request, res: Response) => {
        const filename = String(req.query.filename || "");
        if (!filename || filename.includes("..") || filename.includes("\\")) return void res.status(400).json({ ok: false, error: "媒体文件名无效" });
        const query = new URLSearchParams({ filename, subfolder: String(req.query.subfolder || ""), type: String(req.query.type || "output") });
        const response = await fetch(`${bridge.getUrl()}/view?${query.toString()}`);
        if (!response.ok) return void res.status(response.status).end();
        const body = Buffer.from(await response.arrayBuffer());
        res.type(response.headers.get("content-type") || "application/octet-stream").send(body);
    });

    app.get(routePath("/comfy/config"), (_req, res) => res.json({ ok: true, url: bridge.getUrl(), localH3Direct: bridge.localH3DirectConfig() }));
    app.put(routePath("/comfy/config"), (req, res) => {
        const url = typeof req.body?.url === "string" ? bridge.setUrl(req.body.url) : bridge.getUrl();
        if (typeof req.body?.url === "string") resetModelCatalogCache();
        const localH3Direct = Object.prototype.hasOwnProperty.call(req.body || {}, "localH3RootDir") ? bridge.setLocalH3ComfyRoot(String(req.body.localH3RootDir || "")) : bridge.localH3DirectConfig();
        res.json({ ok: true, url, localH3Direct });
    });
    app.get(routePath("/comfy/presets"), (_req, res) => res.json({ ok: true, data: bridge.presets() }));

    app.post(routePath("/comfy/tasks"), async (req, res) => {
        let task;
        try {
            task = await bridge.run(
                String(req.body?.preset || ""), objectBody(req.body?.input), objectBody(req.body?.params),
                typeof req.body?.comfyUrl === "string" ? req.body.comfyUrl : undefined,
                typeof req.body?.clientTaskId === "string" && req.body.clientTaskId ? req.body.clientTaskId : undefined,
            );
        } catch (error) {
            const e = error as { code?: string };
            if (e.code === "TASK_HISTORY_PRUNED") return void res.status(410).json({ ok: false, code: "TASK_HISTORY_PRUNED", retryable: false, taskId: typeof req.body?.clientTaskId === "string" ? req.body.clientTaskId : null, error: "任务历史已被容量清理，不能复用已清理 ID" });
            throw error;
        }
        ctx.events?.publish({ type: "task.created", entityId: task.id, payload: task });
        res.status(202).json({
            ok: true,
            task,
        });
    });

    app.get(routePath("/comfy/tasks/:id"), (req, res) => {
        const taskId = String(req.params.id);
        const task = stores.tasks.get(taskId);
        if (!task) {
            // 已清理任务：返回 410 历史不可用，不是 404 不存在
            const tombstone = stores.tasks.getTombstone(taskId);
            if (tombstone) return void res.status(410).json({ ok: false, code: "TASK_HISTORY_PRUNED", retryable: false, taskId, terminalStatus: tombstone.terminalStatus, prunedAt: tombstone.prunedAt, error: "任务历史已被容量清理，原始结果不可恢复" });
            return void res.status(404).json({ ok: false, error: "task not found", code: "TASK_NOT_FOUND" });
        }
        if (!task.kind.startsWith("comfyui:") && task.kind !== "workflow") return void res.status(404).json({ ok: false, error: "task not found", code: "TASK_NOT_FOUND" });
        // backend 重启后遗留的 running 任务在此懒恢复（用 events 里的 promptId 重新挂观察循环）
        if ((task.status === "running" || task.status === "queued") && task.kind.startsWith("comfyui:")) bridge.resume(task.id);
        if (req.query.view === "summary") {
            return void res.json({ ok: true, task: {
                id: task.id, kind: task.kind, status: task.status, progress: task.progress,
                createdAt: task.createdAt, updatedAt: task.updatedAt,
                ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
                ...(task.projectId ? { projectId: task.projectId } : {}),
                ...(task.nodeId ? { nodeId: task.nodeId } : {}),
                ...(task.error ? { errorPreview: task.error.slice(0, 300) } : {}),
            } });
        }
        res.json({ ok: true, task, preview: bridge.getLivePreview(taskId) || null, events: stores.tasks.events(taskId, Number(req.query.after || 0)) });
    });

    app.post(routePath("/comfy/tasks/:id/cancel"), (req, res) => {
        const task = bridge.cancel(String(req.params.id));
        ctx.events?.publish({ type: "task.updated", entityId: task.id, payload: task });
        res.json({ ok: true, task });
    });

    /** ComfyUI 输出媒体落地到总后台 runtime-media（H3 分段合并结果等）。 */
    app.post(routePath("/comfy/materialize"), async (req, res) => {
        const url = String(req.body?.url || "");
        const name = path.basename(String(req.body?.name || `materialized-${Date.now()}.mp4`));
        try {
            const source = new URL(url);
            const response = await fetch(`${bridge.getUrl()}/view${source.search || ""}`);
            if (!response.ok) return void res.status(502).json({ ok: false, error: `读取 ComfyUI 媒体失败：HTTP ${response.status}` });
            const data = Buffer.from(await response.arrayBuffer());
            const media = stores.media.storeNamed(name, data, "video/mp4");
            res.status(201).json({ ok: true, media: { name: media.name, path: media.path, bytes: media.bytes, url: media.url } });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
}

function objectBody(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
