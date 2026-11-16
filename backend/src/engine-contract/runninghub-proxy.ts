/**
 * RunningHub 管理接口的代理层。
 *
 * 画布不再自己实现 RunningHub 客户端（那部分 1454 行代码属于执行引擎）：
 * `/agent/runninghub/*` 只做路径翻译，转发到 `comfyui2api` 的 `/api/runninghub/*`。
 * 真正跑任务的执行也归引擎，画布侧只保留编排。
 */

import { probeEngineTarget } from "./workflow-catalog.js";

export type ProxyTarget = { baseUrl: string; token?: string };

type Mode = "GET" | "PUT" | "POST" | "DELETE";

/** 画布 agent 路径 → 引擎路径（用 ":id" 占位，转发时按位置替换）。 */
const ROUTES: Array<{ match: RegExp; method: Mode | "*"; to: (id: string) => { path: string; method?: Mode } }> = [
    { match: /^status$/, method: "*", to: () => ({ path: "/api/runninghub", method: "GET" }) },
    // 引擎的 GET /api/runninghub 一次返回 {config,status}，画布老接口只取 config
    { match: /^config$/, method: "GET", to: () => ({ path: "/api/runninghub", method: "GET" }) },
    { match: /^config$/, method: "PUT", to: () => ({ path: "/api/runninghub/config", method: "PUT" }) },
    { match: /^session$/, method: "GET", to: () => ({ path: "/api/runninghub/session", method: "GET" }) },
    { match: /^session$/, method: "POST", to: () => ({ path: "/api/runninghub/session", method: "POST" }) },
    { match: /^session$/, method: "DELETE", to: () => ({ path: "/api/runninghub/session", method: "DELETE" }) },
    { match: /^workflow\/inspect$/, method: "*", to: () => ({ path: "/api/runninghub/inspect", method: "POST" }) },
    { match: /^workflows$/, method: "GET", to: () => ({ path: "/api/runninghub/profiles", method: "GET" }) },
    { match: /^workflows\/upload$/, method: "*", to: () => ({ path: "/api/runninghub/publish", method: "POST" }) },
    { match: /^workflows\/([^/]+)$/, method: "PUT", to: (id) => ({ path: "/api/runninghub/profiles", method: "PUT" }) },
    { match: /^workflows\/([^/]+)$/, method: "DELETE", to: (id) => ({ path: `/api/runninghub/profiles/${id}`, method: "DELETE" }) },
    { match: /^workflows\/([^/]+)\/resync$/, method: "*", to: (id) => ({ path: `/api/runninghub/profiles/${id}/graph`, method: "GET" }) },
    { match: /^workflows\/([^/]+)\/apply-local-fields$/, method: "*", to: (id) => ({ path: `/api/runninghub/profiles/${id}/apply-fields`, method: "POST" }) },
];

/** 画布独有的旧路径：引擎没有对应实现，明确告知而不是 404。 */
const RETIRED: Array<{ match: RegExp; reason: string }> = [
    { match: /^workflows\/([^/]+)\/run$/, reason: "RunningHub 任务执行已迁移到执行引擎，请在引擎界面运行" },
    { match: /^session\/browser-import$/, reason: "浏览器会话导入已迁移到执行引擎" },
    { match: /^workflows\/([^/]+)\/tasks$/, reason: "RunningHub 任务列表已迁移到执行引擎" },
    { match: /^tasks\//, reason: "RunningHub 任务查询已迁移到执行引擎" },
];

export function runningHubProxyPaths() {
    return { routes: ROUTES, retired: RETIRED };
}

/**
 * 返回 express 处理函数：把 `/agent/runninghub/<rest>` 转发到引擎。
 * 引擎没实现的方法原样回传状态码与响应体，避免画布再猜一遍协议。
 */
export function createRunningHubProxy(candidates: () => ProxyTarget[], probe?: () => Promise<ProxyTarget | null>) {
    return async function handle(req: any, res: any) {
        // app.all("/agent/runninghub/*") 里 req.path 仍是完整路径，先去掉前缀
        const raw = String(req.params?.[0] ?? req.path ?? "");
        const rest = raw.replace(/^\/agent\/runninghub\/?/, "").replace(/^\/+/, "");
        const method = String(req.method || "GET").toUpperCase() as Mode;

        const retired = RETIRED.find((item) => item.match.test(rest));
        if (retired) {
            res.status(410).json({ ok: false, code: "RUNNINGHUB_MOVED", error: retired.reason });
            return;
        }

        const rule = ROUTES.find((item) => item.match.test(rest) && (item.method === "*" || item.method === method));
        if (!rule) {
            res.status(404).json({ ok: false, error: `未知的 RunningHub 接口：${method} /${rest}` });
            return;
        }

        const id = (rest.match(/^workflows\/([^/]+)/)?.[1] || "").trim();
        const target = rule.to(encodeURIComponent(id));
        const engine = probe ? (await probe()) : await probeEngineTarget(candidates());
        if (!engine) {
            res.status(503).json({ ok: false, error: "找不到可用的执行引擎渠道，无法访问 RunningHub" });
            return;
        }
        const url = `${engine.baseUrl}${target.path}`;
        try {
            const response = await fetch(url, {
                method: target.method || method,
                headers: {
                    ...(engine.token ? { authorization: `Bearer ${engine.token}` } : {}),
                    ...(req.body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
            });
            const text = await response.text();
            res.status(response.status).type("application/json").send(text || "{}");
        } catch (error) {
            res.status(502).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    };
}
