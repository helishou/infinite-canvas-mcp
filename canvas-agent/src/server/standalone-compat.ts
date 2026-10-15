import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import express, { type Express } from "express";

type BackendConfig = { url?: string; token?: string };
type CompatBackend = { url: string; token: string };
type CompatOptions = { readyWaitMs?: number; pollIntervalMs?: number; healthTimeoutMs?: number };

const DEFAULT_READY_WAIT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;

/** 旧 canvas-agent 命令的兼容壳：只转发请求，不创建 SQLite/ComfyUI/任务运行时。 */
export function startStandaloneCompat() {
    const port = Number(process.env.PORT) || 17371;
    const server = createStandaloneCompatServer(readBackendConfig(), port);
    server.once("listening", () => console.log(`canvas-agent compatibility proxy: http://127.0.0.1:${port} → ${readBackendConfig().url}/agent`));
    return server;
}

/** Exported for local HTTP contract tests; production still uses the configured fixed proxy port. */
export function createStandaloneCompatServer(backend: CompatBackend, port = 17371, options: CompatOptions = {}) {
    const app = createStandaloneCompatApp(backend, options);
    const server = app.listen(port, "127.0.0.1");
    server.once("close", () => (app.locals as { stopCompatHealthPolling?: () => void }).stopCompatHealthPolling?.());
    return server;
}

export function createStandaloneCompatApp(backend: CompatBackend, options: CompatOptions = {}): Express {
    const readyWaitMs = options.readyWaitMs ?? DEFAULT_READY_WAIT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    const normalizedBackend = { ...backend, url: backend.url.replace(/\/$/, "") };
    const app = express();
    app.disable("x-powered-by");
    app.use(express.raw({ type: "*/*", limit: "50mb" }));

    let ready = false;
    let checkedAt = 0;
    let probeInFlight: Promise<boolean> | undefined;
    const probe = (force = false): Promise<boolean> => {
        if (!force && checkedAt && Date.now() - checkedAt < pollIntervalMs) return Promise.resolve(ready);
        if (probeInFlight) return probeInFlight;
        probeInFlight = (async () => {
            try {
                const response = await fetch(new URL("/health", normalizedBackend.url), {
                    headers: { authorization: `Bearer ${normalizedBackend.token}` },
                    signal: AbortSignal.timeout(healthTimeoutMs),
                });
                if (!response.ok) return false;
                const status = await response.json().catch(() => null) as { ok?: unknown } | null;
                return status?.ok === true;
            } catch {
                return false;
            }
        })().then(value => {
            ready = value;
            checkedAt = Date.now();
            return value;
        }).finally(() => { probeInFlight = undefined; });
        return probeInFlight;
    };
    const poll = setInterval(() => { void probe(true); }, pollIntervalMs);
    poll.unref();
    void probe(true);
    (app.locals as Record<string, unknown>).stopCompatHealthPolling = () => clearInterval(poll);

    const waitUntilReady = async () => {
        const deadline = Date.now() + readyWaitMs;
        while (Date.now() < deadline) {
            if (await probe()) return true;
            const remaining = deadline - Date.now();
            if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
        }
        return probe(true);
    };

    app.use(async (req, res) => {
        if (!await waitUntilReady()) {
            res.setHeader("Retry-After", "1");
            return void res.status(503).json({ ok: false, code: "BACKEND_RELOADING", error: `Backend 重载中，等待 ${readyWaitMs}ms 后仍未就绪；稍后可沿原 operationId/taskId 恢复。` });
        }

        let requestForwarded = false;
        try {
            const target = new URL(mapPath(req.originalUrl || "/"), normalizedBackend.url);
            const headers = new Headers();
            for (const [key, value] of Object.entries(req.headers)) if (key.toLowerCase() !== "host" && typeof value === "string") headers.set(key, value);
            headers.set("authorization", `Bearer ${normalizedBackend.token}`);
            requestForwarded = true;
            const response = await fetch(target, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body as BodyInit });
            res.status(response.status);
            response.headers.forEach((value, key) => { if (!["content-encoding", "content-length", "transfer-encoding"].includes(key)) res.setHeader(key, value); });
            if (response.body) return void Readable.fromWeb(response.body as never).pipe(res);
            res.end();
        } catch (error) {
            if (res.headersSent) return;
            const outcomeUnknown = requestForwarded && !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase());
            res.setHeader("Retry-After", "1");
            return void res.status(503).json({
                ok: false,
                code: outcomeUnknown ? "BACKEND_OUTCOME_UNKNOWN" : "BACKEND_RELOADING",
                ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
                error: outcomeUnknown
                    ? `Backend 在接收 ${req.method} 请求后断开；结果未知。请沿原 operationId/taskId 查询回执，不要创建新 ID 重发。 (${error instanceof Error ? error.message : String(error)})`
                    : `Backend 重载期间暂不可用；请稍后读取原状态。 (${error instanceof Error ? error.message : String(error)})`,
            });
        }
    });
    return app;
}

function mapPath(original: string) {
    const parsed = new URL(original, "http://127.0.0.1");
    if (["/health", "/config"].includes(parsed.pathname)) return `${parsed.pathname}${parsed.search}`;
    if (parsed.pathname === "/events" || parsed.pathname.startsWith("/agent/")) parsed.pathname = `/agent${parsed.pathname === "/events" ? "/events" : parsed.pathname.slice("/agent".length)}`;
    else parsed.pathname = `/agent${parsed.pathname}`;
    return `${parsed.pathname}${parsed.search}`;
}

function readBackendConfig(): CompatBackend {
    const file = path.join(os.homedir(), ".infinite-canvas", "backend.json");
    let config: BackendConfig = {};
    try { config = JSON.parse(fs.readFileSync(file, "utf8")) as BackendConfig; } catch { /* backend will return a useful connection error */ }
    return { url: String(config.url || "http://127.0.0.1:17370").replace(/\/$/, ""), token: String(config.token || process.env.INFINITE_CANVAS_BACKEND_TOKEN || "") };
}
