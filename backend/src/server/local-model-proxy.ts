import type { Express, Request, Response } from "express";
import { isIP } from "node:net";

const MODEL_LIST_TIMEOUT_MS = 12_000;

function isLoopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1") return true;
    if (isIP(host) !== 4) return false;
    return Number(host.split(".")[0]) === 127;
}

/** Build the one upstream path this proxy is allowed to request. */
export function buildLocalModelsUrl(baseUrl: unknown): URL {
    if (typeof baseUrl !== "string" || !baseUrl.trim()) throw new Error("baseUrl 必须是本地模型服务地址");

    let url: URL;
    try {
        url = new URL(baseUrl.trim());
    } catch {
        throw new Error("baseUrl 不是有效的 URL");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("本地模型地址只允许 http/https，不得包含凭据、查询参数或片段");
    }
    if (!isLoopbackHost(url.hostname)) {
        throw new Error("模型列表代理只允许访问本机回环地址");
    }

    const basePath = url.pathname.replace(/\/+$/, "");
    const apiPath = basePath.toLowerCase().endsWith("/v1") ? basePath : `${basePath}/v1`;
    url.pathname = `${apiPath}/models`;
    return url;
}

/** 单个模型的详情地址（同一个回环限制，只是路径不同）。 */
export function buildLocalModelDetailUrl(baseUrl: unknown, model: unknown): URL {
    if (typeof model !== "string" || !model.trim()) throw new Error("model 必须是非空字符串");
    const url = buildLocalModelsUrl(baseUrl);
    url.pathname = `${url.pathname}/${encodeURIComponent(model.trim())}`;
    return url;
}

export function registerLocalModelProxyRoutes(app: Express, fetchUpstream: typeof fetch = fetch) {
    app.post("/api/local-models", async (req: Request, res: Response) => {
        const apiKey = req.body?.apiKey;
        if (typeof apiKey !== "string") {
            return void res.status(400).json({ ok: false, error: "apiKey 必须是字符串" });
        }

        let url: URL;
        try {
            url = buildLocalModelsUrl(req.body?.baseUrl);
        } catch (error) {
            return void res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "本地模型地址无效" });
        }

        try {
            const upstream = await fetchUpstream(url, {
                method: "GET",
                headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
                redirect: "error",
                signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
            });
            if (!upstream.ok) {
                const status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
                return void res.status(status).json({ ok: false, error: `本地模型服务读取列表失败（HTTP ${upstream.status}）` });
            }

            const payload = await upstream.json() as { data?: Array<{ id?: unknown; capability?: unknown }> };
            const models = Array.isArray(payload.data)
                ? [...new Set(payload.data.map((model) => model?.id).filter((id): id is string => typeof id === "string" && Boolean(id)))]
                    .sort((a, b) => a.localeCompare(b))
                : [];
            // models 保持标准形态（string[]）；items 额外带 capability，能读到的就用（例如 media-engine），
            // 读不到就交给前端按名字猜——不改变 /v1/models 的标准语义。
            const items = Array.isArray(payload.data)
                ? payload.data
                    .filter((model) => typeof model?.id === "string" && Boolean(model.id))
                    .map((model) => ({
                        name: String(model.id),
                        ...(typeof model.capability === "string" ? { capability: model.capability } : {}),
                    }))
                : [];
            return void res.json({ ok: true, models, items });
        } catch (error) {
            if (error instanceof DOMException && error.name === "TimeoutError") {
                return void res.status(504).json({ ok: false, error: "读取本地模型列表超时" });
            }
            return void res.status(502).json({ ok: false, error: "无法连接本地模型服务" });
        }
    });

    /**
     * 单个模型的能力/参数详情（GET /v1/models/{id}）。
     * 标准 OpenAI 只规定 id/object/created/owned_by，扩展字段（fields / parameter_spec）
     * 属于服务端能力上报，客户端拿不到就退化成常用参数，不影响标准协议。
     */
    app.post("/api/local-model-detail", async (req: Request, res: Response) => {
        const apiKey = req.body?.apiKey;
        if (typeof apiKey !== "string") return void res.status(400).json({ ok: false, error: "apiKey 必须是字符串" });
        let url: URL;
        try {
            url = buildLocalModelDetailUrl(req.body?.baseUrl, req.body?.model);
        } catch (error) {
            return void res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "本地模型地址无效" });
        }
        try {
            const upstream = await fetchUpstream(url, {
                method: "GET",
                headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
                redirect: "error",
                signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
            });
            if (!upstream.ok) {
                const status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
                return void res.status(status).json({ ok: false, error: `读取模型详情失败（HTTP ${upstream.status}）` });
            }
            const payload = await upstream.json() as Record<string, unknown>;
            return void res.json({
                ok: true,
                id: String(payload.id ?? req.body?.model ?? ""),
                fields: Array.isArray(payload.fields) ? payload.fields : [],
                parameterSpec: Array.isArray(payload.parameter_spec) ? payload.parameter_spec : [],
                standardParams: payload.standard_params ?? null,
            });
        } catch (error) {
            if (error instanceof DOMException && error.name === "TimeoutError") {
                return void res.status(504).json({ ok: false, error: "读取模型详情超时" });
            }
            return void res.status(502).json({ ok: false, error: "无法连接本地模型服务" });
        }
    });
}
