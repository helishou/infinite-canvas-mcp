import path from "node:path";
import type { Request, Response } from "express";

import { type ResolvedConfig } from "../config.js";
import { engineTargets, probeEngineTarget, type EngineTarget } from "../engine-contract/workflow-catalog.js";
import type { Stores } from "../stores/types.js";
import type { BackendEventBus } from "../events.js";
import { resolveTaskLivePreview } from "../canvas/engine-preview.js";

/**
 * ComfyUI 控制台已下线：本地 8188 直连取消，能力归执行引擎 `comfyui2api`。
 *
 * 保留三类接口，形状不变，画布前端不用改：
 * 1. 状态 / 媒体桥 → 转发引擎或读引擎 /health 里的 ComfyUI 地址；
 * 2. 任务查询 → 读画布自己的任务库（任务 id 是画布的）；
 * 3. 已废弃的模型清单 / H3 预设 / 预设执行 / 地址配置 / 任务取消 → 410 + 迁移说明。
 *
 * 实时预览帧由引擎 `/api/tasks/{id}` 提供；画布任务与引擎任务是两套 id，这里不再混用。
 */
export function registerComfyRoutes(
    ctx: { app: import("express").Express; stores: Stores; config: ResolvedConfig; events?: BackendEventBus; basePath?: string },
    options: { resolveEngine?: () => EngineTarget[] } = {},
) {
    const { app, stores } = ctx;
    const routePath = (value: string) => `${ctx.basePath || ""}${value}`;
    const candidates = options.resolveEngine
        || (() => engineTargets((stores as unknown as { settings?: { get?: (key: string) => unknown } }).settings?.get?.("ai.config")));

    const engine = async (): Promise<EngineTarget | null> => probeEngineTarget(candidates());

    /** ComfyUI 自身地址（媒体桥拼 /view 用）；引擎 /health 里带这个字段。 */
    const comfyUrl = async (): Promise<string | null> => {
        const target = await engine();
        if (!target) return null;
        try {
            const response = await fetch(`${target.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
            if (!response.ok) return null;
            const body = (await response.json()) as { comfyui?: string };
            return body.comfyui ? String(body.comfyui).replace(/\/+$/, "") : null;
        } catch {
            return null;
        }
    };

    app.get(routePath("/comfy/status"), async (_req, res) => {
        const target = await engine();
        if (!target) return void res.json({ ok: true, connected: false, url: "", engine: null });
        const url = await comfyUrl();
        res.json({ ok: true, connected: Boolean(url), url: url || "", engine: target.baseUrl });
    });

    // 模型清单由引擎管理（/v1/models + 引擎界面），画布不再枚举 ComfyUI 文件。
    app.get(routePath("/comfy/models"), (_req, res) => {
        res.status(410).json({
            ok: false,
            code: "COMFY_CONSOLE_MOVED",
            error: "ComfyUI 模型清单已并入执行引擎：请用引擎界面或 GET /v1/models",
        });
    });

    // H3 预设随 H3 迁移为引擎「H3 展开流」模型后不再存在。
    app.get(routePath("/comfy/presets"), (_req, res) => {
        res.status(410).json({
            ok: false,
            code: "COMFY_CONSOLE_MOVED",
            error: "H3 预设已迁移为执行引擎的「H3 展开流」模型",
        });
    });

    app.get(routePath("/comfy/config"), async (_req, res) => {
        const target = await engine();
        const url = await comfyUrl();
        res.json({ ok: true, url: url || "", engine: target?.baseUrl || "", localH3Direct: false, releaseBeforeRepeat: false });
    });

    app.put(routePath("/comfy/config"), (_req, res) => {
        res.status(410).json({
            ok: false,
            code: "COMFY_CONSOLE_MOVED",
            error: "ComfyUI 地址与实例配置已迁移到执行引擎：请在引擎的「实例」页修改",
        });
    });

    // 预设执行已下线（原来会直接在画布进程里跑 ComfyUI 预设工作流）。
    app.post(routePath("/comfy/tasks"), (_req, res) => {
        res.status(410).json({
            ok: false,
            code: "COMFY_CONSOLE_MOVED",
            error: "本地 ComfyUI 预设执行已下线：请改用执行引擎提供的模型（/v1/*）",
        });
    });

    /** 任务列表：读画布自己的任务库（engine 任务由各自的执行器同步进来）。 */
    app.get(routePath("/comfy/tasks"), (req, res) => {
        const limit = Number(req.query.limit ?? 50);
        const status = typeof req.query.status === "string" ? req.query.status : undefined;
        const tasks = stores.tasks.list({
            ...(status ? { status: status as never } : {}),
            limit: Number.isFinite(limit) ? limit : 50,
        });
        res.json({ ok: true, task: tasks, data: tasks });
    });

    app.get(routePath("/comfy/tasks/:id"), async (req, res) => {
        const taskId = String(req.params.id);
        const task = stores.tasks.get(taskId);
        if (!task) {
            const tombstone = stores.tasks.getTombstone(taskId);
            if (tombstone) {
                return void res.status(410).json({
                    ok: false,
                    code: "TASK_HISTORY_PRUNED",
                    retryable: false,
                    taskId,
                    terminalStatus: tombstone.terminalStatus,
                    prunedAt: tombstone.prunedAt,
                    error: "任务历史已被容量清理，原始结果不可恢复",
                });
            }
            return void res.status(404).json({ ok: false, error: "task not found", code: "TASK_NOT_FOUND" });
        }
        if (req.query.view === "summary") {
            return void res.json({
                ok: true,
                task: {
                    id: task.id,
                    kind: task.kind,
                    status: task.status,
                    progress: task.progress,
                    createdAt: task.createdAt,
                    updatedAt: task.updatedAt,
                    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
                    ...(task.projectId ? { projectId: task.projectId } : {}),
                    ...(task.nodeId ? { nodeId: task.nodeId } : {}),
                    ...(task.error ? { errorPreview: task.error.slice(0, 300) } : {}),
                },
            });
        }
        // 实时预览帧现取自执行引擎（engine_submitted → /api/tasks/{id}）。
        res.json({ ok: true, task, preview: await resolveTaskLivePreview(stores, taskId), events: stores.tasks.events(taskId, Number(req.query.after || 0)) });
    });

    /**
     * 取消已下线。这里原先只把画布任务标成 cancelled，既不转发引擎、也不中断 ComfyUI，
     * 调用方拿到「已取消」而显卡照旧满载——是假取消。画布自己的任务各有取消通道
     * （H3 片段 → h3-runner.cancel，画布视频 → video-dispatcher.cancel），引擎任务走
     * `POST /v1/tasks/{id}/cancel`。这里统一回 410，避免再被当成取消通道使用。
     */
    app.post(routePath("/comfy/tasks/:id/cancel"), (_req, res) => {
        res.status(410).json({
            ok: false,
            code: "COMFY_CONSOLE_MOVED",
            error: "ComfyUI 控制台任务取消已下线：画布任务请在对应卡片上停止，引擎任务请调用 POST /v1/tasks/{id}/cancel",
        });
    });

    /** 代理 ComfyUI 媒体预览（/view） */
    app.get(routePath("/comfy/media"), async (req: Request, res: Response) => {
        const filename = String(req.query.filename || "");
        if (!filename || filename.includes("..") || filename.includes("\\")) return void res.status(400).json({ ok: false, error: "媒体文件名无效" });
        const base = await comfyUrl();
        if (!base) return void res.status(503).json({ ok: false, error: "ComfyUI 不可达" });
        const query = new URLSearchParams({
            filename,
            subfolder: String(req.query.subfolder || ""),
            type: String(req.query.type || "output"),
        });
        const response = await fetch(`${base}/view?${query.toString()}`);
        if (!response.ok) return void res.status(response.status).end();
        const body = Buffer.from(await response.arrayBuffer());
        res.type(response.headers.get("content-type") || "application/octet-stream").send(body);
    });

    /** ComfyUI 输出媒体落地到总后台 runtime-media（H3 分段合并结果等）。 */
    app.post(routePath("/comfy/materialize"), async (req, res) => {
        const url = String(req.body?.url || "");
        const name = path.basename(String(req.body?.name || `materialized-${Date.now()}.mp4`));
        try {
            const base = await comfyUrl();
            if (!base) return void res.status(503).json({ ok: false, error: "ComfyUI 不可达" });
            const source = new URL(url);
            const response = await fetch(`${base}/view${source.search || ""}`);
            if (!response.ok) return void res.status(502).json({ ok: false, error: `读取 ComfyUI 媒体失败：HTTP ${response.status}` });
            const data = Buffer.from(await response.arrayBuffer());
            const media = stores.media.storeNamed(name, data, "video/mp4");
            res.status(201).json({ ok: true, media: { name: media.name, path: media.path, bytes: media.bytes, url: media.url } });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
}
