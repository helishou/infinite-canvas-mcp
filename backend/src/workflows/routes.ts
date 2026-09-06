import type { Request, Response, Router } from "express";
import { randomUUID } from "node:crypto";
import type { WorkflowStore } from "./store.js";
import type { WorkflowExecutor } from "./executor.js";
import type { WorkflowConfig } from "../db.js";
import { loadInstances, saveInstances, validateInstance } from "../comfyui/instances.js";

export function registerWorkflowRoutes(
    router: Router,
    store: WorkflowStore,
    executor: WorkflowExecutor,
) {
    // GET /api/workflows - 列出所有工作流
    router.get("/api/workflows", async (_req: Request, res: Response) => {
        const workflows = await store.list();
        res.json({ workflows });
    });

    // GET /api/workflows/:name - 获取单个工作流（含 config）
    router.get("/api/workflows/:name", async (req: Request, res: Response) => {
        try {
            const name = decodeURIComponent(req.params.name as string);
            const detail = await store.get(name);
            res.json(detail);
        } catch (error) {
            res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });

    // POST /api/workflows - 上传新工作流
    router.post("/api/workflows", async (req: Request, res: Response) => {
        try {
            const { name, workflow } = req.body as { name: string; workflow: Record<string, unknown> };
            const result = await store.upload(name, workflow);
            res.status(201).json(result);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });

    // PUT /api/workflows/:name/config - 保存配置
    router.put("/api/workflows/:name/config", async (req: Request, res: Response) => {
        try {
            const name = decodeURIComponent(req.params.name as string);
            const config = req.body as WorkflowConfig;
            const result = await store.saveConfig(name, config);
            res.json(result);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });

    // DELETE /api/workflows/:name - 删除工作流
    router.delete("/api/workflows/:name", async (req: Request, res: Response) => {
        try {
            const name = decodeURIComponent(req.params.name as string);
            const result = await store.delete(name);
            res.json(result);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });

    // POST /api/workflows/:name/run - 运行工作流
    router.post("/api/workflows/:name/run", async (req: Request, res: Response) => {
        try {
            const name = decodeURIComponent(req.params.name as string);
            const body = (req.body || {}) as { fields?: Record<string, unknown>; config?: WorkflowConfig };
            // config 是 WorkflowExecutor.run 第一个会用到的字段（processImageFields 读
            // config.fields），前端如果漏传会让 executor 立刻崩
            // "Cannot read properties of undefined (reading 'fields')"。
            // 给个空 config 兜底，等前端在 workflows 页面配完字段再传真 config。
            const config: WorkflowConfig = body.config ?? {
                title: name.split('/').pop()?.replace(/\.json$/, "") || name,
                backend: "",
                operation: "",
                description: "",
                fields: [],
            };
            const fields = body.fields ?? {};
            const detail = await store.get(name);
            const clientId = randomUUID();
            const result = await executor.run(detail.workflow, config, fields, clientId, undefined, name);
            res.json(result);
        } catch (error) {
            // 输出完整堆栈到 backend stdout（用户在前端只看到 error.message，
            // 实际 throw 位置在 stack 里）。用 console.error 而不是 logger，
            // 避免引入 logger 依赖。
            console.error("[workflows:run] failed", {
                name: req.params.name,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
            res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });

    // GET /api/comfyui/instances - 列出所有 ComfyUI 实例
    router.get("/api/comfyui/instances", async (_req: Request, res: Response) => {
        const data = await loadInstances();
        res.json(data);
    });

    // PUT /api/comfyui/instances - 保存 ComfyUI 实例列表
    router.put("/api/comfyui/instances", async (req: Request, res: Response) => {
        try {
            const instances: string[] = req.body?.instances ?? [];
            const cleaned: string[] = [];
            for (const item of instances) {
                const err = validateInstance(item);
                if (err) return res.status(400).json({ ok: false, error: `${err}: ${item}` });
                const s = item.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
                if (!cleaned.includes(s)) cleaned.push(s);
            }
            if (cleaned.length === 0) return res.status(400).json({ ok: false, error: "至少保留一个 ComfyUI 后端地址" });
            await saveInstances({ instances: cleaned });
            res.json({ ok: true, instances: cleaned });
        } catch (error) {
            res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
}
