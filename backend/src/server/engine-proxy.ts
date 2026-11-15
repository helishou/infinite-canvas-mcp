import type { Express, Request, Response } from "express";
import type { CanvasEngineClient } from "../canvas/engine-client.js";

/**
 * 画布后端 → 独立执行引擎的管理面代理（`/api/engine/*`）。
 *
 * 为什么要代理而不是让前端直连：引擎要求 Bearer 令牌，令牌只应留在服务端；
 * 前端只要把工作流管理请求的基址从 `/api` 换成 `/api/engine` 就能用引擎控制台那套接口。
 * 只代理 `/api/*`（工作流库、任务），生成仍走 dispatcher 的 `/v1/*`，不走这里。
 */
export function registerEngineProxy(app: Express, current: () => CanvasEngineClient | undefined) {
    app.get("/api/engine/status", (_req: Request, res: Response) => {
        const engine = current();
        res.json({ enabled: Boolean(engine), url: engine?.url ?? null });
    });

    app.use("/api/engine", async (req: Request, res: Response) => {
        const engine = current();
        if (!engine) {
            res.status(503).json({ error: { message: "未配置执行引擎（设置 engine.url 或环境变量 CANVAS_ENGINE_URL）" } });
            return;
        }
        const suffix = req.originalUrl.replace(/^\/api\/engine/, "").replace(/([?&])token=[^&]*&?/, "$1").replace(/[?&]$/, "");
        const target = `${engine.url}${suffix.startsWith("/") ? "" : "/"}${suffix}`;
        const method = (req.method || "GET").toUpperCase();
        const hasBody = !["GET", "HEAD", "DELETE"].includes(method) && req.body !== undefined;
        try {
            const response = await engine.proxyFetch(target, {
                method,
                ...(hasBody ? { body: JSON.stringify(req.body), contentType: "application/json" } : {}),
            });
            res.status(response.status);
            res.setHeader("content-type", response.contentType);
            res.end(response.body);
        } catch (error) {
            res.status(502).json({ error: { message: `执行引擎请求失败：${error instanceof Error ? error.message : String(error)}` } });
        }
    });
}
