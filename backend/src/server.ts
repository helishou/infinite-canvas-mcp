import express, { type NextFunction, type Request, type Response, type Express } from "express";
import fs from "node:fs";
import path from "node:path";

import { type ResolvedConfig, DATA_DIR, ensureDataDirs, loadRootConfig, saveRootConfig, loadFrontendSettings, type FrontendSettings } from "./config.js";
import type {
    Asset, AssetFolder, CanvasFolder, CanvasProject,
    GenerationLog, GenerationLogStatus, RuntimeTask, RuntimeTaskStatus,
} from "./db.js";
import type { ComfyUiBackend } from "./comfyui/bridge.js";
import { createLogger } from "./logger.js";
import { createStores } from "./stores/index.js";
import type { GenerationLogInput, LogDeleteScope, Stores } from "./stores/types.js";
import { BackendEventBus } from "./events.js";
import type { CanvasOperation } from "./canvas/project-ops.js";
import { diagnoseCanvasProject } from "./canvas/project-diagnostics.js";
import { detectLineInset, type DetectLineInsetParams } from "./canvas/image-split-detect.js";
import { CANVAS_TASKS_PATH, CANVAS_TASK_ROUTE, canvasTaskActionRoute } from "@basketikun/canvas-agent/generation-api";

const logger = createLogger("backend");

/** startServer 的可选依赖（comfy 路由由 index.ts 单独挂载）。 */
export type ServerDeps = {
    comfy?: ComfyUiBackend;
    events?: BackendEventBus;
    stores?: Stores;
    cancelTask?: (task: RuntimeTask) => RuntimeTask;
    retryTask?: (task: RuntimeTask) => RuntimeTask | Promise<RuntimeTask>;
};

/** 启动总后台 HTTP 服务，返回 Express app（listen 由 index.ts 负责）。 */
export function startServer(db: Parameters<typeof createStores>[0], config: ResolvedConfig, deps: ServerDeps = {}) {
    const stores: Stores = deps.stores ?? createStores(db);
    const events = deps.events ?? new BackendEventBus();
    const app = express();
    const FRONTEND_SETTINGS_KEY = "frontend.settings";
    const STRUCTURED_SETTING_KEYS = new Map([
        ["webdav", "webdav.config"],
        ["prompt-sources", "prompt.sources"],
        ["custom-prompts", "prompts.custom"],
        ["image-workbench-references", "image-workbench.references"],
    ]);
    if (stores.settings.get(FRONTEND_SETTINGS_KEY) === undefined) {
        const legacy = loadFrontendSettings();
        if (Object.keys(legacy).length) stores.settings.set(FRONTEND_SETTINGS_KEY, legacy);
    }
    app.disable("x-powered-by");
    app.use(express.json({ limit: "100mb" }));

    // ── CORS ─────────────────────────────────────────────────────────────
    // Allow-Headers 走 reflect 模式：把预检请求里的
    // Access-Control-Request-Headers 原样回给 Access-Control-Allow-Headers。
    // 这样新加自定义 header（x-media-* 之类）不用每次都改这里。
    // 注意：reflect 模式要求 Allow-Origin 是 echo（不能 *），
    // 且 Allow-Credentials 必须是 true。
    const CORS_ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
    // reflect 之外保留一组明确白名单（防止浏览器没发 Request-Headers
    // 时，比如简单 GET 请求没有预检，Allow-Headers 还是空）。
    const CORS_ALLOWED_HEADERS_DEFAULT = "Content-Type, Authorization, x-media-name, x-media-width, x-media-height, x-media-duration-ms, x-media-category";
    app.use((req: Request, res: Response, next: NextFunction) => {
        const origins = config.origins ?? ["*"];
        const origin = req.headers.origin;
        if (origin && (origins.includes("*") || origins.includes(origin))) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Access-Control-Allow-Credentials", "true");
            res.setHeader("Vary", "Origin");
        }
        res.setHeader("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS);
        // 预检请求：reflect 客户端请求的 header；非预检：给默认白名单
        const requestHeaders = req.headers["access-control-request-headers"];
        res.setHeader(
            "Access-Control-Allow-Headers",
            typeof requestHeaders === "string" && requestHeaders ? requestHeaders : CORS_ALLOWED_HEADERS_DEFAULT,
        );
        // OPTIONS 预检请求直接返回，不进入后续 middleware（auth 等会拦截）。
        if (req.method === "OPTIONS") { res.status(204).end(); return; }
        next();
    });

    // ── Token 鉴权（/health 和 /config 免鉴权） ────────────────────────
    app.use((req: Request, res: Response, next: NextFunction) => {
        const url = req.url!.split("?")[0];
        if (url === "/health" || url === "/config") return next();
        // 只读媒体端点免 token：本地单用户开发 backend 的 CORS 已 `*`，且媒体 URL 内嵌的
        // token 会在 backend 重启后失效，豁免后可避免历史产物在 token 轮换后 401 而“消失”。
        // 仅豁免 GET 读取类端点，写入类（如 POST /runtime/media）仍受 token 保护。
        if (url === "/media" || url.startsWith("/media/") || url.startsWith("/runtime/media-file")) return next();
        const token = req.query.token as string | undefined
            || req.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (token !== config.token) {
            return void res.status(401).json({ ok: false, error: "invalid token" });
        }
        next();
    });

    // ── 请求日志 ─────────────────────────────────────────────────────────
    app.use((req: Request, res: Response, next: NextFunction) => {
        const startedAt = Date.now();
        res.on("finish", () => {
            if (req.method === "OPTIONS" || res.statusCode < 400) return;
            logger.warn(`${req.method} ${req.url}`, { status: res.statusCode, durationMs: Date.now() - startedAt });
        });
        next();
    });

    // ── 公共路由 ─────────────────────────────────────────────────────────
    app.get("/health", (_req, res) => {
        res.json({ ok: true, protocolVersion: 1, node: process.version, pid: process.pid });
    });
    app.get("/config", (_req, res) => {
        res.json({ ok: true, protocolVersion: 1, url: config.url, token: config.token, hasToken: true });
    });
    app.get("/data-dir", (_req, res) => {
        const root = loadRootConfig();
        res.json({ ok: true, dataDir: DATA_DIR, configuredDataDir: root.dataDir || null });
    });
    app.post("/data-dir", (req, res) => {
        const { dataDir } = req.body as { dataDir?: string };
        if (dataDir !== undefined) {
            if (!path.isAbsolute(dataDir)) return void res.status(400).json({ ok: false, error: "dataDir 必须是绝对路径" });
            const root = loadRootConfig();
            root.dataDir = dataDir.trim() || undefined;
            saveRootConfig(root);
            // 重新解析 DATA_DIR（动态更新运行时的路径常量）。
            // 注意：已有数据文件仍在旧目录，新路径在 backend 重启后生效。
            // 如需迁移数据，需手动移动文件并更新路径。
        }
        const root = loadRootConfig();
        res.json({ ok: true, dataDir: DATA_DIR, configuredDataDir: root.dataDir || null });
    });
    // ── Frontend settings ───────────────────────────────────────────────
    app.get("/settings", (_req, res) => {
        res.json({ ok: true, settings: stores.settings.get(FRONTEND_SETTINGS_KEY) || {} });
    });
    app.patch("/settings", (req, res) => {
        const patch = req.body as Partial<FrontendSettings>;
        if (!patch || typeof patch !== "object") {
            return void res.status(400).json({ ok: false, error: "请求体必须是对象" });
        }
        const current = stores.settings.get(FRONTEND_SETTINGS_KEY);
        const settings = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}), ...patch };
        stores.settings.set(FRONTEND_SETTINGS_KEY, settings);
        events.publish({ type: "settings.updated", entityId: FRONTEND_SETTINGS_KEY, payload: { synced: true } });
        res.json({ ok: true, settings });
    });
    app.get("/settings/data/:scope", (req, res) => {
        const key = STRUCTURED_SETTING_KEYS.get(String(req.params.scope || ""));
        if (!key) return void res.status(404).json({ ok: false, error: "未知设置域" });
        res.json({ ok: true, value: stores.settings.get(key) ?? null });
    });
    app.put("/settings/data/:scope", (req, res) => {
        const key = STRUCTURED_SETTING_KEYS.get(String(req.params.scope || ""));
        if (!key) return void res.status(404).json({ ok: false, error: "未知设置域" });
        if (!Object.prototype.hasOwnProperty.call(req.body || {}, "value")) return void res.status(400).json({ ok: false, error: "value 必填" });
        stores.settings.set(key, req.body.value);
        events.publish({ type: "settings.updated", entityId: key, payload: { synced: true } });
        res.json({ ok: true, value: req.body.value });
    });
    const AI_CONFIG_KEY = "ai.config";
    app.get("/settings/ai-config", (_req, res) => {
        res.json({ ok: true, config: stores.settings.get(AI_CONFIG_KEY) || null });
    });
    app.put("/settings/ai-config", (req, res) => {
        const config = req.body?.config;
        if (!config || typeof config !== "object" || Array.isArray(config)) return void res.status(400).json({ ok: false, error: "AI 配置必须是对象" });
        stores.settings.set(AI_CONFIG_KEY, config);
        events.publish({ type: "settings.updated", entityId: AI_CONFIG_KEY, payload: { synced: true } });
        res.json({ ok: true });
    });

    // H3 默认参数是 Backend 权威设置；浏览器 localStorage 只用于一次性迁移。
    const H3_DEFAULTS_KEY = "plugin:minimax-h3:defaults:v1";
    app.get("/plugins/minimax-h3/defaults", (_req, res) => {
        res.json({ ok: true, defaults: stores.settings.get(H3_DEFAULTS_KEY) || null });
    });
    app.put("/plugins/minimax-h3/defaults", (req, res) => {
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return void res.status(400).json({ ok: false, error: "defaults 必须是对象" });
        const settings = { ...(req.body as Record<string, unknown>) };
        if (settings.videoSteps === undefined && settings.steps !== undefined) settings.videoSteps = settings.steps;
        delete settings.steps;
        stores.settings.set(H3_DEFAULTS_KEY, settings);
        events.publish({ type: "settings.updated", entityId: H3_DEFAULTS_KEY, payload: settings });
        res.json({ ok: true, defaults: settings });
    });
    app.delete("/plugins/minimax-h3/defaults", (_req, res) => {
        stores.settings.delete(H3_DEFAULTS_KEY);
        events.publish({ type: "settings.updated", entityId: H3_DEFAULTS_KEY, payload: null });
        res.json({ ok: true, defaults: null });
    });

    // ── Runtime status ────────────────────────────────────────────────
    app.get("/runtime/status", async (_req, res) => {
        const extra: Record<string, unknown> = { sqlite: true, node: process.version };
        if (deps.comfy) extra.comfyui = await deps.comfy.status();
        res.json({ ok: true, ...extra });
    });
    app.get("/events", (req, res) => {
        res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        let closed = false;
        const write = (event: import("./events.js").BackendEvent) => {
            if (closed) return;
            // 客户端（浏览器）断连后写已关闭的 socket 会抛 EPIPE，吞掉以免崩进程。
            try { res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }
            catch { closed = true; clearInterval(heartbeat); unsubscribe(); }
        };
        const heartbeat = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); } }, 15_000);
        const unsubscribe = events.subscribe(write);
        const cleanup = () => { closed = true; clearInterval(heartbeat); unsubscribe(); };
        req.on("close", cleanup);
        res.on("error", cleanup);
    });

    // ── Canvas projects ──────────────────────────────────────────────────
    app.get("/canvas/projects", (_req, res) => {
        res.json({ ok: true, projects: stores.projects.list() });
    });
    app.put("/canvas/projects", (req, res) => {
        const body = req.body as { projects?: CanvasProject[] };
        const projects = Array.isArray(body.projects)
            ? body.projects.filter((p): p is CanvasProject => p && typeof p === "object" && !Array.isArray(p) && !!p.id)
            : [];
        const result = stores.projects.replaceAll(projects);
        events.publishCanvasSnapshot({ payload: { projects: result } });
        res.json({ ok: true, projects: result });
    });
    app.post("/canvas/projects", (req, res) => {
        const project = req.body as CanvasProject;
        if (!project?.id) return void res.status(400).json({ ok: false, error: "project.id 必填" });
        const result = stores.projects.upsert(project);
        events.publishCanvasSnapshot({ entityId: result.id, revision: Number(result.revision || 0), payload: result });
        res.status(201).json({ ok: true, project: result });
    });
    app.post("/canvas/projects/:id/ops", (req, res) => {
        const expectedRevision = req.body?.expectedRevision === undefined ? undefined : Number(req.body.expectedRevision);
        const operations = Array.isArray(req.body?.operations) ? req.body.operations as CanvasOperation[] : [];
        if (!operations.length) return void res.status(400).json({ ok: false, error: "operations 不能为空" });
        try {
            const result = db.applyCanvasProjectOperations(req.params.id, expectedRevision, operations);
            events.publishCanvasDelta({ entityId: result.project.id, revision: result.revision, operations: result.operations, operationResults: result.operationResults, updatedAt: String(result.project.updatedAt || "") });
            res.json({ ok: true, projectId: result.project.id, revision: result.revision, operationResults: result.operationResults, project: result.project });
        } catch (error) {
            const value = error as Error & { code?: string; project?: CanvasProject; revision?: number };
            if (value.code === "REVISION_CONFLICT") return void res.status(409).json({ ok: false, error: value.message, projectId: req.params.id, revision: value.revision, project: value.project });
            if (value.message.startsWith("画布不存在:")) return void res.status(404).json({ ok: false, error: value.message });
            res.status(400).json({ ok: false, error: value.message || String(error) });
        }
    });
    app.delete("/canvas/projects/:id", (req, res) => {
        const deleted = stores.projects.delete(req.params.id);
        events.publishCanvasSnapshot({ entityId: req.params.id, payload: { deleted } });
        res.json({ ok: true, deleted });
    });
    // ── H3 节点历史运行产物（按需取，替代 metadata.materials 字段）──
    app.get("/canvas/projects/:id/nodes/:nodeId/materials", (req, res) => {
        const projectId = req.params.id;
        const nodeId = req.params.nodeId;
        if (!stores.projects.get(projectId)) return void res.status(404).json({ ok: false, error: `画布不存在: ${projectId}` });
        const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
        const segmentId = typeof req.query.segmentId === "string" ? req.query.segmentId : undefined;
        const materials = stores.projects.getH3NodeMaterials(projectId, nodeId, limit, segmentId);
        res.json({ ok: true, projectId, nodeId, materials });
    });
    app.get("/canvas/folders", (_req, res) => {
        res.json({ ok: true, folders: stores.canvasFolders.list() });
    });
    app.post("/canvas/folders", (req, res) => {
        const folder = req.body as CanvasFolder;
        if (!folder?.id) return void res.status(400).json({ ok: false, error: "folder.id 必填" });
        const result = stores.canvasFolders.upsert(folder);
        events.publishCanvasFolder({ entityId: result.id, payload: result });
        res.status(201).json({ ok: true, folder: result });
    });
    app.delete("/canvas/folders/:id", (req, res) => {
        const deleted = stores.canvasFolders.delete(req.params.id);
        events.publishCanvasFolder({ entityId: req.params.id, payload: { deleted } });
        res.json({ ok: true, deleted });
    });
    // ── Image split: auto-detect 切分线宽度 ───────────────────────────────
    app.post("/canvas/image-split/detect-line-inset", async (req, res) => {
        const body = req.body as { dataUrl?: string; rows?: number; columns?: number; horizontalLines?: number[]; verticalLines?: number[] };
        if (!body.dataUrl) return void res.status(400).json({ ok: false, error: "需要提供 dataUrl" });
        if (typeof body.rows !== "number" || typeof body.columns !== "number") {
            return void res.status(400).json({ ok: false, error: "rows / columns 必填" });
        }
        const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(String(body.dataUrl));
        if (!match) return void res.status(400).json({ ok: false, error: "dataUrl 必须是 base64 data URL" });
        const buffer = Buffer.from(match[1], "base64");
        const params: DetectLineInsetParams = {
            rows: Math.max(1, Math.floor(body.rows)),
            columns: Math.max(1, Math.floor(body.columns)),
            horizontalLines: Array.isArray(body.horizontalLines) ? body.horizontalLines.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : undefined,
            verticalLines: Array.isArray(body.verticalLines) ? body.verticalLines.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : undefined,
        };
        try {
            const result = await detectLineInset(buffer, params);
            res.json({ ok: true, ...result });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ ok: false, error: message });
        }
    });
    app.get("/canvas/projects/:id/diagnostics", (req, res) => {
        const project = stores.projects.get(req.params.id);
        if (!project) return void res.status(404).json({ ok: false, error: `画布不存在: ${req.params.id}` });
        res.json({ ok: true, projectId: project.id, revision: Number(project.revision || 0), issues: diagnoseCanvasProject(project, stores) });
    });

    // ── Assets ───────────────────────────────────────────────────────────
    app.get("/canvas/assets", (req, res) => {
        const kind = req.query.kind as string | undefined;
        const folderId = req.query.folderId as string | undefined;
        res.json({ ok: true, assets: stores.assets.list({ kind, folderId }), folders: stores.assets.folders() });
    });
    app.put("/canvas/assets", (req, res) => {
        const body = req.body as { assets?: Asset[]; folders?: AssetFolder[] };
        const assets = Array.isArray(body.assets)
            ? body.assets.filter((a): a is Asset => a && typeof a === "object" && !Array.isArray(a) && !!a.id)
            : [];
        const folders = Array.isArray(body.folders)
            ? body.folders.filter((f): f is AssetFolder => f && typeof f === "object" && !Array.isArray(f) && !!f.id)
            : [];
        stores.assets.replaceAll(assets, folders);
        const result = { assets: stores.assets.list(), folders: stores.assets.folders() };
        events.publish({ type: "asset.updated", payload: result });
        res.json({ ok: true, ...result });
    });
    app.post("/canvas/assets", (req, res) => {
        const asset = req.body as Asset;
        if (!asset?.id) return void res.status(400).json({ ok: false, error: "asset.id 必填" });
        const result = stores.assets.upsert(asset);
        events.publish({ type: "asset.updated", entityId: result.id, payload: result });
        res.status(201).json({ ok: true, asset: result });
    });
    app.patch("/canvas/assets/:id", (req, res) => {
        const current = stores.assets.get(req.params.id);
        if (!current) return void res.status(404).json({ ok: false, error: "asset not found" });
        const next = { ...current, ...(req.body as Partial<Asset>), id: current.id, updatedAt: new Date().toISOString() };
        const result = stores.assets.upsert(next);
        events.publish({ type: "asset.updated", entityId: result.id, payload: result });
        res.json({ ok: true, asset: result });
    });
    app.delete("/canvas/assets/:id", (req, res) => {
        const deleted = stores.assets.delete(req.params.id);
        events.publish({ type: "asset.updated", entityId: req.params.id, payload: { deleted } });
        res.json({ ok: true, deleted });
    });

    // ── Asset folders ────────────────────────────────────────────────────
    app.post("/canvas/assets/folders", (req, res) => {
        const folder = req.body as AssetFolder;
        if (!folder?.id) return void res.status(400).json({ ok: false, error: "folder.id 必填" });
        const result = stores.assets.upsertFolder(folder);
        events.publish({ type: "asset.updated", entityId: result.id, payload: result });
        res.status(201).json({ ok: true, folder: result });
    });
    app.delete("/canvas/assets/folders/:id", (req, res) => {
        const deleted = stores.assets.deleteFolder(req.params.id);
        events.publish({ type: "asset.updated", entityId: req.params.id, payload: { deleted } });
        res.json({ ok: true, deleted });
    });

    // ── Media ────────────────────────────────────────────────────────────
    /** 上传媒体（JSON 兼容入口；新代码优先使用 /media/upload-binary） */
    app.post("/media/upload", (req, res) => {
        const body = req.body as { name?: string; dataUrl?: string; storageKey?: string; width?: number; height?: number; durationMs?: number; category?: "input" | "output" | "library" };
        if (!body.dataUrl) return void res.status(400).json({ ok: false, error: "需要提供 dataUrl（base64 data URL）" });
        try {
            const media = stores.media.storeDataUrl(String(body.dataUrl), body.name || "media.bin", {
                storageKey: body.storageKey,
                category: body.category,
                width: body.width ?? null, height: body.height ?? null, durationMs: body.durationMs ?? null,
            });
            res.status(201).json({
                ok: true,
                media: {
                    storageKey: media.storageKey,
                    url: stores.media.url(media),
                    mimeType: media.mimeType,
                    bytes: media.bytes,
                    width: media.width,
                    height: media.height,
                    durationMs: media.durationMs,
                },
            });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    /** 上传媒体二进制，避免工作流和本地素材在浏览器与后台之间转 base64。 */
    app.post("/media/upload-binary", express.raw({ type: "*/*", limit: "100mb" }), (req, res) => {
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const encodedName = String(req.headers["x-media-name"] || "media.bin");
        const name = decodeURIComponent(encodedName);
        const mimeType = String(req.headers["content-type"] || "application/octet-stream").split(";", 1)[0];
        const categoryHeader = String(req.headers["x-media-category"] || "input");
        const category = categoryHeader === "output" || categoryHeader === "library" ? categoryHeader : "input";
        const storageKeyHeader = String(req.headers["x-media-storage-key"] || "").trim();
        if (!body.length) return void res.status(400).json({ ok: false, error: "媒体内容为空" });
        try {
            const media = stores.media.store(body, {
                name,
                mimeType,
                category,
                storageKey: storageKeyHeader || undefined,
                width: Number(req.headers["x-media-width"]) || null,
                height: Number(req.headers["x-media-height"]) || null,
                durationMs: Number(req.headers["x-media-duration-ms"]) || null,
            });
            res.status(201).json({ ok: true, media: { storageKey: media.storageKey, url: stores.media.url(media), mimeType: media.mimeType, bytes: media.bytes, width: media.width, height: media.height, durationMs: media.durationMs } });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    /** 代理读取媒体文件。视频必须支持 Range，浏览器才能按需缓冲和 seek，避免整段读入内存后播放卡顿。 */
    app.get("/media/:storageKey", async (req, res) => {
        const storageKey = decodeURIComponent(req.params.storageKey);
        const media = stores.media.meta(storageKey);
        if (!media) return void res.status(404).json({ ok: false, error: "media not found" });
        try {
            res.setHeader("Cache-Control", "private, max-age=3600");
            res.setHeader("Content-Type", media.mimeType);
            res.setHeader("Accept-Ranges", "bytes");
            const bytes = fs.statSync(media.filePath).size;
            const range = req.headers.range;
            if (!range) {
                res.setHeader("Content-Length", String(bytes));
                fs.createReadStream(media.filePath).pipe(res);
                return;
            }
            const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
            if (!match) {
                res.setHeader("Content-Range", `bytes */${bytes}`);
                return void res.status(416).end();
            }
            const suffixLength = match[1] ? 0 : Number(match[2]);
            const start = match[1] ? Number(match[1]) : Math.max(0, bytes - suffixLength);
            const end = match[1] ? (match[2] ? Math.min(Number(match[2]), bytes - 1) : bytes - 1) : bytes - 1;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= bytes || end < start) {
                res.setHeader("Content-Range", `bytes */${bytes}`);
                return void res.status(416).end();
            }
            res.status(206);
            res.setHeader("Content-Range", `bytes ${start}-${end}/${bytes}`);
            res.setHeader("Content-Length", String(end - start + 1));
            fs.createReadStream(media.filePath, { start, end }).pipe(res);
        } catch {
            res.status(404).json({ ok: false, error: "媒体文件丢失" });
        }
    });

    /** 删除媒体文件 */
    app.delete("/media/:storageKey", (req, res) => {
        const storageKey = decodeURIComponent(req.params.storageKey);
        if (!stores.media.meta(storageKey)) return void res.status(404).json({ ok: false, error: "media not found" });
        res.json({ ok: true, deleted: stores.media.delete(storageKey) });
    });

    // ── runtime media（H3 ref 落地 / 兼容旧 Agent /runtime/media*） ──────
    app.post("/runtime/media", (req, res) => {
        const name = String(req.body?.name || "media.bin");
        const dataUrl = String(req.body?.dataUrl || "");
        const storageKey = req.body?.storageKey ? String(req.body.storageKey) : undefined;
        try {
            // 复用后端已有的媒体：避免把本就在后端的文件再 base64 下载→重传（H3 串 clip 的
            // previousVideo 即此情形——上一段视频后端刚生成完，前端却原路下载回来再传一次，
            // 体积暴涨触发 413）。传 storageKey 时直接返回本地路径，不再解码 dataUrl。
            if (storageKey) {
                const meta = stores.media.meta(decodeURIComponent(storageKey));
                if (!meta) return void res.status(404).json({ ok: false, error: `media not found: ${storageKey}` });
                return void res.status(201).json({
                    ok: true,
                    media: {
                        id: meta.storageKey,
                        path: meta.filePath,
                        name: path.basename(name),
                        mimeType: meta.mimeType,
                        bytes: meta.bytes,
                        url: stores.media.url(meta),
                    },
                });
            }
            const media = stores.media.storeDataUrl(dataUrl, name);
            res.status(201).json({ ok: true, media: { id: media.storageKey, path: media.path, name: path.basename(name), mimeType: media.mimeType, bytes: media.bytes, url: stores.media.url(media) } });
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.get("/runtime/media-file", (req, res) => {
        try {
            const name = String(req.query.name || req.query.file || "");
            const data = stores.media.readNamed(name);
            res.setHeader("Cache-Control", "private, max-age=3600");
            res.type("application/octet-stream").send(data);
        } catch (error) {
            res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    // ── Generation logs ──────────────────────────────────────────────────
    app.get("/plugins/mcp", (_req, res) => {
        res.json({ ok: true, declarations: db.listPluginDeclarations() });
    });
    app.put("/plugins/mcp", (req, res) => {
        const declarations = Array.isArray(req.body?.declarations) ? req.body.declarations : [];
        const result = db.replacePluginDeclarations(declarations);
        // 声明是完整快照：卸载/移除的插件必须从权威清单删除；清理放在成功 upsert 后。
        if (result.length) db.db.prepare(`DELETE FROM plugin_declarations WHERE id NOT IN (${result.map(() => "?").join(",")})`).run(...result.map((item) => item.id));
        else db.db.prepare("DELETE FROM plugin_declarations").run();
        events.publish({ type: "plugin.updated", payload: { declarations: result } });
        res.json({ ok: true, declarations: result });
    });

    app.get("/plugins/installed", (_req, res) => {
        const plugins = db.getSetting("plugins.installed");
        res.json({ ok: true, plugins: Array.isArray(plugins) ? plugins : [] });
    });
    app.put("/plugins/installed", (req, res) => {
        const plugins = Array.isArray(req.body?.plugins) ? req.body.plugins.filter((item: unknown) => item && typeof item === "object" && !Array.isArray(item)) : [];
        db.setSetting("plugins.installed", plugins);
        res.json({ ok: true, plugins });
    });
    app.get("/plugins/storage", (req, res) => {
        const pluginId = String(req.query.pluginId || "").trim();
        const key = String(req.query.key || "").trim();
        if (!pluginId || !key) return void res.status(400).json({ ok: false, error: "pluginId 和 key 必填" });
        res.json({ ok: true, value: db.getSetting(`plugin.storage.${pluginId}.${key}`) ?? null });
    });
    app.put("/plugins/storage", (req, res) => {
        const pluginId = String(req.body?.pluginId || "").trim();
        const key = String(req.body?.key || "").trim();
        if (!pluginId || !key) return void res.status(400).json({ ok: false, error: "pluginId 和 key 必填" });
        db.setSetting(`plugin.storage.${pluginId}.${key}`, req.body?.value);
        res.json({ ok: true });
    });
    app.delete("/plugins/storage", (req, res) => {
        const pluginId = String(req.query.pluginId || "").trim();
        const key = String(req.query.key || "").trim();
        if (!pluginId || !key) return void res.status(400).json({ ok: false, error: "pluginId 和 key 必填" });
        db.db.prepare("DELETE FROM runtime_settings WHERE key = ?").run(`plugin.storage.${pluginId}.${key}`);
        res.json({ ok: true });
    });

    app.get("/prompts/cache", (req, res) => {
        const sourceId = String(req.query.sourceId || "").trim();
        if (!sourceId) return void res.status(400).json({ ok: false, error: "sourceId 必填" });
        res.json({ ok: true, cache: db.getSetting(`prompt.cache.${sourceId}`) ?? null });
    });
    app.put("/prompts/cache", (req, res) => {
        const sourceId = String(req.body?.sourceId || "").trim();
        const cache = req.body?.cache;
        if (!sourceId || !cache || typeof cache !== "object" || Array.isArray(cache)) return void res.status(400).json({ ok: false, error: "sourceId 和有效 cache 必填" });
        db.setSetting(`prompt.cache.${sourceId}`, cache);
        res.json({ ok: true });
    });

    app.get("/generation-logs", (req, res) => {
        const projectId = req.query.projectId as string | undefined;
        const nodeId = req.query.nodeId as string | undefined;
        const status = ["queued", "running", "success", "failed", "cancelled"].includes(req.query.status as string)
            ? req.query.status as GenerationLogStatus : undefined;
        const limit = Number(req.query.limit || 500);
        res.json({ ok: true, logs: stores.logs.list({
            projectId, nodeId, status, limit, offset: Number(req.query.offset || 0),
            segmentId: typeof req.query.segmentId === "string" ? req.query.segmentId : undefined,
            runtimeTaskId: typeof req.query.runtimeTaskId === "string" ? req.query.runtimeTaskId : undefined,
            platform: typeof req.query.platform === "string" ? req.query.platform : undefined,
            model: typeof req.query.model === "string" ? req.query.model : undefined,
            from: typeof req.query.from === "string" ? req.query.from : undefined,
            to: typeof req.query.to === "string" ? req.query.to : undefined,
        }) });
    });
    app.post("/generation-logs", (req, res) => {
        const body = req.body as GenerationLogInput;
        if (!body.projectId || !body.platform || !body.startedAt) {
            return void res.status(400).json({ ok: false, error: "projectId、platform、startedAt 为必填项" });
        }
        const log = stores.logs.create(body);
        events.publish({ type: "generation-log.updated", entityId: log.id, payload: log });
        res.status(201).json({ ok: true, log });
    });
    app.patch("/generation-logs/:id", (req, res) => {
        try {
            const log = stores.logs.update(req.params.id, req.body);
            events.publish({ type: "generation-log.updated", entityId: log.id, payload: log });
            res.json({ ok: true, log });
        } catch (error) {
            res.status(404).json({ ok: false, error: (error as Error).message });
        }
    });
    app.delete("/generation-logs", (req, res) => {
        const options: LogDeleteScope = {};
        if (req.query.id) options.id = String(req.query.id);
        if (req.query.projectId) options.projectId = String(req.query.projectId);
        if (req.query.nodeId) options.nodeId = String(req.query.nodeId);
        if (!options.id && !options.projectId && !options.nodeId) {
            return void res.status(400).json({ ok: false, error: "删除日志必须指定范围" });
        }
        res.json({ ok: true, deleted: stores.logs.delete(options) });
    });
    app.delete("/generation-logs/:id", (req, res) => {
        res.json({ ok: true, deleted: stores.logs.delete({ id: req.params.id }) });
    });

    // ── Tasks ────────────────────────────────────────────────────────────
    app.get(CANVAS_TASKS_PATH, (req, res) => {
        const status = typeof req.query.status === "string" ? req.query.status : undefined;
        const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
        const model = typeof req.query.model === "string" ? req.query.model : undefined;
        const scope = ["all", "canvas", "image", "video"].includes(String(req.query.scope)) ? String(req.query.scope) as "all" | "canvas" | "image" | "video" : undefined;
        const list = (value: unknown) => typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
        const taskId = typeof req.query.taskId === "string" ? req.query.taskId : "";
        const tasks = taskId
            ? (stores.tasks.get(taskId) ? [stores.tasks.get(taskId)!] : [])
            : stores.tasks.list({
                status: status as RuntimeTaskStatus | undefined,
                kind,
                model,
                scope,
                projectId: typeof req.query.projectId === "string" ? req.query.projectId : undefined,
                nodeIds: list(req.query.nodeIds),
                segmentIds: list(req.query.segmentIds),
                limit: Number(req.query.limit || 500),
                offset: Number(req.query.offset || 0),
            });
        res.json({ ok: true, tasks });
    });
    app.get(CANVAS_TASK_ROUTE, (req, res) => {
        const task = stores.tasks.get(req.params.id);
        if (!task) return void res.status(404).json({ ok: false, error: "task not found" });
        res.json({ ok: true, task, events: stores.tasks.events(req.params.id, Number(req.query.after || 0)) });
    });
    app.post(CANVAS_TASKS_PATH, (req, res) => {
        const body = req.body as { kind?: string; clientTaskId?: string; input?: Record<string, unknown>; params?: Record<string, unknown> };
        if (!body.kind) return void res.status(400).json({ ok: false, error: "kind 必填" });
        const task = body.clientTaskId
            ? stores.tasks.create(body.clientTaskId, body.kind, body.input || {}, body.params || {})
            : stores.tasks.create(body.kind, body.input || {}, body.params || {});
        events.publish({ type: "task.created", entityId: task.id, payload: task });
        res.status(201).json({ ok: true, task });
    });
    app.patch(CANVAS_TASK_ROUTE, (req, res) => {
        const patch = req.body as { status?: RuntimeTaskStatus; progress?: number; result?: Record<string, unknown> | null; error?: string | null };
        try {
            const task = stores.tasks.update(req.params.id, patch);
            events.publish({ type: task.status === "succeeded" ? "task.completed" : task.status === "failed" ? "task.failed" : "task.updated", entityId: task.id, payload: task });
            res.json({ ok: true, task });
        } catch (error) {
            res.status(404).json({ ok: false, error: (error as Error).message });
        }
    });
    app.post(canvasTaskActionRoute("cancel"), (req, res) => {
        try {
            const taskId = String(req.params.id);
            const current = stores.tasks.get(taskId);
            if (!current) return void res.status(404).json({ ok: false, error: "task not found" });
            const task = deps.cancelTask ? deps.cancelTask(current) : stores.tasks.cancel(taskId);
            events.publish({ type: "task.updated", entityId: task.id, payload: task });
            res.json({ ok: true, task });
        } catch (error) {
            res.status(409).json({ ok: false, error: (error as Error).message });
        }
    });
    app.post(canvasTaskActionRoute("retry"), async (req, res) => {
        try {
            const current = stores.tasks.get(String(req.params.id));
            if (!current) return void res.status(404).json({ ok: false, error: "task not found" });
            if (!deps.retryTask) return void res.status(409).json({ ok: false, error: `任务类型 ${current.kind} 没有注册重试执行器` });
            const task = await deps.retryTask(current);
            events.publish({ type: "task.created", entityId: task.id, payload: task });
            res.status(201).json({ ok: true, task, parentTaskId: current.id });
        } catch (error) {
            res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    registerBackendErrorHandler(app);

    return { app: app as Express, stores, events };
}

/** 在调用方挂载额外路由后再次安装，确保挂载路由也返回统一 JSON 错误。 */
export function registerBackendErrorHandler(app: Express) {
    type HttpError = Error & { status?: number };
    app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
        const status = (error as HttpError).status || 500;
        logger.error(error.message, { stack: error.stack });
        res.status(status).json({ ok: false, error: error.message });
    });
}
