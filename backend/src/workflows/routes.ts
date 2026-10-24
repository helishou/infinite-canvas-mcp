import type { Request, Response, Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowStore } from "./store.js";
import type { WorkflowExecutor } from "./executor.js";
import type { WorkflowConfig } from "../db.js";
import type { ComfyUiBackend } from "../comfyui/bridge.js";
import { convertComfyWorkflowToApi } from "./comfyui-workflow-conversion.js";
import { findUiWorkflowFile } from "./ui-workflow-file.js";
import {
  loadInstances,
  saveInstances,
  validateInstance,
} from "../comfyui/instances.js";

type LocalComfyWorkflowFile = { id: string; instance: string; relativePath: string; name: string; bytes: number; modifiedAt: string };

function localInstanceRoot(roots: Record<string, string> | undefined, instance: string) {
  for (const [address, root] of Object.entries(roots || {})) {
    const normalized = address.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (normalized === instance) return root;
  }
  return "";
}

/**
 * 按工作流名在本机 ComfyUI 工作流目录里找**原始 UI 格式** JSON（带 nodes 数组）。
 * 本地库里存的是转好的 API 格式，上传到 RunningHub 等「编辑器生态」时必须用 UI 原件，
 * 否则平台解析不出节点、跑不了。
 * 库名与磁盘文件名不完全一致（副本 `(1)` 后缀）时的回退匹配在 ui-workflow-file.ts。
 */
async function findUiWorkflowJson(name: string): Promise<Record<string, unknown> | null> {
  try {
    const data = await loadInstances();
    for (const rawAddress of data.instances || []) {
      const instance = rawAddress.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
      if (!/^(?:localhost|127\.0\.0\.1):\d+$/.test(instance)) continue;
      const root = localInstanceRoot(data.roots, instance);
      if (!root) continue;
      const hit = await findUiWorkflowFile(path.join(root, "user", "default", "workflows"), name);
      if (hit) return hit;
    }
  } catch {
    /* 实例配置读不到就当作没有 UI 原件 */
  }
  return null;
}

async function localComfyWorkflowFiles(): Promise<LocalComfyWorkflowFile[]> {
  const data = await loadInstances();
  const files: LocalComfyWorkflowFile[] = [];
  for (const rawAddress of data.instances || []) {
    const instance = rawAddress.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (!/^(?:localhost|127\.0\.0\.1):\d+$/.test(instance)) continue;
    const root = localInstanceRoot(data.roots, instance);
    if (!root) continue;
    try { await fs.access(path.join(root, "main.py")); } catch { continue; }
    const workflowsDir = path.join(root, "user", "default", "workflows");
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) { await visit(absolutePath); continue; }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json") || entry.name.toLowerCase().endsWith(".config.json")) continue;
        const stat = await fs.stat(absolutePath).catch(() => undefined);
        if (!stat) continue;
        const relativePath = path.relative(workflowsDir, absolutePath).split(path.sep).join("/");
        files.push({ id: JSON.stringify([instance, relativePath]), instance, relativePath, name: entry.name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
      }
    };
    await visit(workflowsDir);
  }
  return files.sort((a, b) => a.name.localeCompare(b.name) || a.instance.localeCompare(b.instance) || a.relativePath.localeCompare(b.relativePath));
}

async function readLocalComfyWorkflow(instance: string, relativePath: string) {
  const selected = (await localComfyWorkflowFiles()).find((item) => item.instance === instance && item.relativePath === relativePath);
  if (!selected) throw new Error("所选工作流已不存在或不在已登记的本机 ComfyUI 工作流目录中，请刷新列表");
  const data = await loadInstances();
  const root = localInstanceRoot(data.roots, instance);
  const workflowsDir = path.resolve(root, "user", "default", "workflows");
  const absolutePath = path.resolve(workflowsDir, ...relativePath.split("/"));
  const rel = path.relative(workflowsDir, absolutePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("工作流路径无效");
  const realWorkflowsDir = await fs.realpath(workflowsDir);
  const realFilePath = await fs.realpath(absolutePath);
  const realRel = path.relative(realWorkflowsDir, realFilePath);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) throw new Error("工作流文件必须位于 ComfyUI 工作流目录内");
  const raw = await fs.readFile(realFilePath, "utf8");
  return { selected, raw, sha256: createHash("sha256").update(raw, "utf8").digest("hex") };
}

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

  // Only enumerate files under roots explicitly registered for local ComfyUI instances.
  router.get("/api/comfyui/local-workflows", async (_req: Request, res: Response) => {
    try {
      res.json({ workflows: await localComfyWorkflowFiles() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/workflows/import-comfyui", async (req: Request, res: Response) => {
    try {
      const instance = typeof req.body?.instance === "string" ? req.body.instance : "";
      const relativePath = typeof req.body?.relativePath === "string" ? req.body.relativePath : "";
      const { selected, raw, sha256 } = await readLocalComfyWorkflow(instance, relativePath);
      const workflow = convertComfyWorkflowToApi(JSON.parse(raw));
      const existing = new Set((await store.list()).map((item) => item.name.toLocaleLowerCase()));
      const sourceName = path.basename(relativePath);
      const extension = path.extname(sourceName) || ".json";
      const stem = path.basename(sourceName, extension);
      let name = sourceName;
      for (let suffix = 2; existing.has(`custom/${name}`.toLocaleLowerCase()) || existing.has(name.toLocaleLowerCase()); suffix += 1) name = `${stem} (${suffix})${extension}`;
      const result = await store.upload(name, workflow);
      await store.saveSourceLink(result.name, { instance: selected.instance, relativePath: selected.relativePath, syncedSha256: sha256, syncedAt: new Date().toISOString() });
      await onImported?.(result.name);
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/workflows/:name/sync-comfyui", async (req: Request, res: Response) => {
    try {
      const name = decodeURIComponent(req.params.name as string);
      const detail = await store.get(name);
      const source = detail.source;
      if (!source) return res.status(409).json({ error: "该工作流没有记录 ComfyUI 原流来源" });
      const { raw, sha256 } = await readLocalComfyWorkflow(source.instance, source.relativePath);
      const workflow = convertComfyWorkflowToApi(JSON.parse(raw));
      await store.saveWorkflow(name, workflow);
      const updatedSource = { ...source, syncedSha256: sha256, syncedAt: new Date().toISOString() };
      await store.saveSourceLink(name, updatedSource);
      await onImported?.(name);
      res.json({ name, source: updatedSource });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // GET /api/workflows/:name - 获取单个工作流（含 config）
  router.get("/api/workflows/:name", async (req: Request, res: Response) => {
    try {
      const name = decodeURIComponent(req.params.name as string);
      const detail = await store.get(name);
      if (detail?.config) detail.config = normalizeWorkflowConfig(detail.config);
      if (detail.source) {
        try {
          const { sha256 } = await readLocalComfyWorkflow(detail.source.instance, detail.source.relativePath);
          detail.source.syncState = sha256 === detail.source.syncedSha256 ? "current" : "changed";
        } catch {
          detail.source.syncState = "missing";
        }
      }
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
        // 附带原始 UI 格式（有的话）：上传到 RunningHub 网页端必须用 UI 格式，API 格式编辑器解析不了。
        const uiWorkflow = await findUiWorkflowJson(name);
        res.json(uiWorkflow ? { ...pkg, uiWorkflow } : pkg);
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
