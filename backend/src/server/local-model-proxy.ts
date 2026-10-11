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

            const payload = await upstream.json() as { data?: Array<{ id?: unknown }> };
            const models = Array.isArray(payload.data)
                ? [...new Set(payload.data.map((model) => model?.id).filter((id): id is string => typeof id === "string" && Boolean(id)))]
                    .sort((a, b) => a.localeCompare(b))
                : [];
            return void res.json({ ok: true, models });
        } catch (error) {
            if (error instanceof DOMException && error.name === "TimeoutError") {
                return void res.status(504).json({ ok: false, error: "读取本地模型列表超时" });
            }
            return void res.status(502).json({ ok: false, error: "无法连接本地模型服务" });
        }
    });
}
