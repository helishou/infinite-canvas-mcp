import type { Request, Response, Router } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowStore } from "./store.js";
import type { WorkflowExecutor } from "./executor.js";
import type { WorkflowConfig } from "../db.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import {
  loadInstances,
  saveInstances,
  validateInstance,
} from "../comfyui/instances.js";

export function registerWorkflowRoutes(
  router: Router,
  store: WorkflowStore,
  executor: WorkflowExecutor,
  comfy?: ComfyUiBackend,
  onImported?: (name: string) => void | Promise<void>,
  onDeleted?: (name: string) => void | Promise<void>,
) {
  // 媒体字段（图片/音频/视频）必须显式传入，不允许带默认值（存量配置里
  // 可能残留工作流现成文件名当 default，运行时会当成已提供图片导致报错）。
  // 在读取/导出/保存/导入四个入口统一归一化，存量无需手动重导入即可修复。
  const normalizeWorkflowConfig = (config: WorkflowConfig): WorkflowConfig => {
    if (!config || !Array.isArray(config.fields)) return config;
    return {
      ...config,
      fields: config.fields.map((f) =>
        f.type === "image" || f.type === "audio" || f.type === "video"
          ? { ...f, default: undefined }
          : f,
      ),
    };
  };

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
      if (detail?.config) detail.config = normalizeWorkflowConfig(detail.config);
      res.json(detail);
    } catch (error) {
      res
        .status(404)
        .json({
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  // POST /api/workflows - 上传新工作流
  router.post("/api/workflows", async (req: Request, res: Response) => {
    try {
      const { name, workflow } = req.body as {
        name: string;
        workflow: Record<string, unknown>;
      };
      const result = await store.upload(name, workflow);
      await onImported?.(result.name);
      res.status(201).json(result);
    } catch (error) {
      res
        .status(400)
        .json({
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  // POST /api/workflows/import - 导入包含节点图与字段配置的完整工作流包
  router.post("/api/workflows/import", async (req: Request, res: Response) => {
    try {
      const { name, package: workflowPackage, exposeModel } = req.body as {
        name?: string;
        package?: Record<string, unknown>;
        exposeModel?: boolean;
      };
      const normalizedPackage = workflowPackage
        ? {
            ...workflowPackage,
            config: normalizeWorkflowConfig(
              (workflowPackage.config as WorkflowConfig) ?? {
                title: "",
                backend: "",
                operation: "",
                description: "",
                fields: [],
              },
            ),
          }
        : workflowPackage;
      const result = await store.importPackage(
        name || "workflow.json",
        normalizedPackage,
      );
      if (exposeModel !== false) await onImported?.(result.name);
      res.status(201).json(result);
    } catch (error) {
      res
        .status(400)
        .json({
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  // GET /api/workflows/:name/export - 导出节点图与字段配置
  router.get(
    "/api/workflows/:name/export",
    async (req: Request, res: Response) => {
      try {
        const name = decodeURIComponent(req.params.name as string);
        const pkg = await store.exportPackage(name);
        if (pkg?.config) pkg.config = normalizeWorkflowConfig(pkg.config);
        res.json(pkg);
      } catch (error) {
        res
          .status(404)
          .json({
            error: error instanceof Error ? error.message : String(error),
          });
      }
    },
  );

  // PUT /api/workflows/:name/config - 保存配置
  router.put(
    "/api/workflows/:name/config",
    async (req: Request, res: Response) => {
      try {
        const name = decodeURIComponent(req.params.name as string);
        const config = normalizeWorkflowConfig(req.body as WorkflowConfig);
        const result = await store.saveConfig(name, config);
        res.json(result);
      } catch (error) {
        res
          .status(400)
          .json({
            error: error instanceof Error ? error.message : String(error),
          });
      }
    },
  );

  router.put(
    "/api/workflows/:name/workflow",
    async (req: Request, res: Response) => {
      try {
        const name = decodeURIComponent(req.params.name as string);
        const result = await store.saveWorkflow(
          name,
          req.body as Record<string, unknown>,
        );
        res.json(result);
      } catch (error) {
        res
          .status(400)
          .json({
            error: error instanceof Error ? error.message : String(error),
          });
      }
    },
  );

  // DELETE /api/workflows/:name - 删除工作流
  router.delete("/api/workflows/:name", async (req: Request, res: Response) => {
    try {
      const name = decodeURIComponent(req.params.name as string);
      const result = await store.delete(name);
      await onDeleted?.(name);
      res.json(result);
    } catch (error) {
      res
        .status(400)
        .json({
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  // GET /api/workflows/:name/combo-options - 获取各节点 COMBO 输入选项
  router.get(
    "/api/workflows/:name/combo-options",
    async (req: Request, res: Response) => {
      try {
        const name = decodeURIComponent(req.params.name as string);
        if (!comfy)
          return res
            .status(503)
            .json({ options: {}, error: "ComfyUI backend not available" });
        const controller = new AbortController();
        req.on("close", () => controller.abort());
        const options = await store.getComboOptions(
          name,
          comfy,
          controller.signal,
        );
        res.json({ options });
      } catch (error) {
        res
          .status(500)
          .json({
            options: {},
            error: error instanceof Error ? error.message : String(error),
          });
      }
    },
  );

  // POST /api/workflows/:name/open-in-comfyui - 把该工作流的节点图写入 ComfyUI 实例的
  // user/default/workflows/（同名覆盖），并返回客户端地址供前端新开标签页。
  // 官方客户端没有 REST 端点能远程载入节点图，写文件是唯一可靠让它在 ComfyUI
  // File→Load 里出现的方式。根目录必须由用户在「运行环境 → ComfyUI 实例」里登记，
  // 不猜路径；未登记的本地实例报 no-root，非本机实例报 remote 由前端下载兜底。
  router.post(
    "/api/workflows/:name/open-in-comfyui",
    async (req: Request, res: Response) => {
      try {
        const name = decodeURIComponent(req.params.name as string);
        const detail = await store.get(name);
        const data = await loadInstances();
        const instance = (data.instances || []).find((addr) => addr.trim()) || "";
        if (!instance) return res.status(503).json({ ok: false, reason: "no-instance", error: "未配置 ComfyUI 实例" });
        const host = instance.split(":")[0];
        const url = `http://${instance}/`;
        if (host !== "127.0.0.1" && host !== "localhost") {
          return res.status(503).json({ ok: false, reason: "remote", url, error: "远程实例无法写入文件系统，请下载后在 ComfyUI 中导入" });
        }
        const root = data.roots?.[instance] || "";
        if (!root) return res.status(503).json({ ok: false, reason: "no-root", url, error: "未登记该实例的本机根目录：运行环境 → ComfyUI 实例管理" });
        try {
          await fs.access(path.join(root, "main.py"));
        } catch {
          return res.status(400).json({ ok: false, reason: "bad-root", url, error: `不是 ComfyUI 根目录（缺 main.py）：${root}` });
        }
        let file = path.basename(name).replace(/\\/g, "/");
        if (!file.endsWith(".json")) file += ".json";
        const workflowsDir = path.join(root, "user", "default", "workflows");
        await fs.mkdir(workflowsDir, { recursive: true });
        const target = path.join(workflowsDir, file);
        await fs.writeFile(target, JSON.stringify(detail.workflow, null, 2), "utf8");
        // 写盘只是保底；真正的「打开」是把节点图推给运行中的客户端载入。
        // 失败不阻断：ComfyUI 没跑或还没装伴生扩展时，文件依然在，File→Load 兜底。
        let pushed = false;
        let pushError = "";
        try {
          const resp = await fetch(`http://${instance}/infinite-canvas/open-workflow`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ graph: detail.workflow, title: file }),
            signal: AbortSignal.timeout(5000),
          });
          const json = await resp.json().catch(() => ({}));
          pushed = Boolean(json?.ok);
          if (!pushed) pushError = String(json?.error || `HTTP ${resp.status}`);
        } catch (err) {
          pushError = err instanceof Error ? err.message : String(err);
        }
        res.json({ ok: true, url, file, path: target, pushed, ...(pushed ? {} : { pushError }) });
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  // PUT /api/workflows/:name/title - 重命名显示标题
  router.put(
    "/api/workflows/:name/title",
    async (req: Request, res: Response) => {
      try {
        const name = decodeURIComponent(req.params.name as string);
        const { title } = req.body as { title?: string };
        if (!title || !title.trim()) {
          return res.status(400).json({ error: "名称不能为空" });
        }
        const result = await store.renameTitle(name, title.trim());
        res.json(result);
      } catch (error) {
        res
          .status(400)
          .json({
            error: error instanceof Error ? error.message : String(error),
          });
      }
    },
  );

  // POST /api/workflows/:name/run - 运行工作流
  router.post(
    "/api/workflows/:name/run",
    async (req: Request, res: Response) => {
      try {
        const name = decodeURIComponent(req.params.name as string);
        const body = (req.body || {}) as {
          fields?: Record<string, unknown>;
          config?: WorkflowConfig;
          clientTaskId?: string;
        };
        // config 是 WorkflowExecutor.run 第一个会用到的字段（processImageFields 读
        // config.fields），前端如果漏传会让 executor 立刻崩
        // "Cannot read properties of undefined (reading 'fields')"。
        // 给个空 config 兜底，等前端在 workflows 页面配完字段再传真 config。
        const config: WorkflowConfig = body.config ?? {
          title:
            name
              .split("/")
              .pop()
              ?.replace(/\.json$/, "") || name,
          backend: "",
          operation: "",
          description: "",
          fields: [],
        };
        const fields = body.fields ?? {};
        const detail = await store.get(name);
        const clientId = randomUUID();
        // 后台运行：立即返回 taskId，ComfyUI 执行在后台进行；前端轮询任务状态取结果。
        // 避免同步长连接被中断导致前端 "Failed to fetch" 而后端已提交 ComfyUI（重复点击堆积任务）。
        const { taskId } = await executor.runBackground(
          detail.workflow,
          config,
          fields,
          clientId,
          undefined,
          name,
          typeof body.clientTaskId === "string" && body.clientTaskId
            ? body.clientTaskId
            : undefined,
        );
        res.json({ taskId });
      } catch (error) {
        // 输出完整堆栈到 backend stdout（用户在前端只看到 error.message，
        // 实际 throw 位置在 stack 里）。用 console.error 而不是 logger，
        // 避免引入 logger 依赖。
        console.error("[workflows:run] failed", {
          name: req.params.name,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        res
          .status(500)
          .json({
            error: error instanceof Error ? error.message : String(error),
          });
      }
    },
  );

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
        if (err)
          return res.status(400).json({ ok: false, error: `${err}: ${item}` });
        const s = item
          .trim()
          .replace(/^https?:\/\//, "")
          .replace(/\/$/, "");
        if (!cleaned.includes(s)) cleaned.push(s);
      }
      if (cleaned.length === 0)
        return res
          .status(400)
          .json({ ok: false, error: "至少保留一个 ComfyUI 后端地址" });
      const incomingRoots = (req.body?.roots || {}) as Record<string, unknown>;
      const roots: Record<string, string> = {};
      for (const [key, value] of Object.entries(incomingRoots)) {
        if (typeof value === "string" && value.trim()) roots[key] = value.trim().replace(/\/+$/, "");
      }
      await saveInstances({ instances: cleaned, ...(Object.keys(roots).length ? { roots } : {}) });
      res.json({ ok: true, instances: cleaned, ...(Object.keys(roots).length ? { roots } : {}) });
    } catch (error) {
      res
        .status(500)
        .json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });
}
