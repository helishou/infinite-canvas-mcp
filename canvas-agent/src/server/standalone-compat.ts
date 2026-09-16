import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";

type BackendConfig = { url?: string; token?: string };

/** 旧 canvas-agent 命令的兼容壳：只转发请求，不创建 SQLite/ComfyUI/任务运行时。 */
export function startStandaloneCompat() {
    const backend = readBackendConfig();
    const port = Number(process.env.PORT) || 17371;
    const app = express();
    app.disable("x-powered-by");
    app.use(express.raw({ type: "*/*", limit: "50mb" }));
    app.use(async (req, res) => {
        try {
            const target = new URL(mapPath(req.originalUrl || "/"), backend.url);
            const headers = new Headers();
            for (const [key, value] of Object.entries(req.headers)) if (key.toLowerCase() !== "host" && typeof value === "string") headers.set(key, value);
            headers.set("authorization", `Bearer ${backend.token}`);
            const response = await fetch(target, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body as BodyInit });
            res.status(response.status);
            response.headers.forEach((value, key) => { if (![ "content-encoding", "content-length", "transfer-encoding" ].includes(key)) res.setHeader(key, value); });
            if (response.body) return void Readable.fromWeb(response.body as never).pipe(res);
            res.end();
        } catch (error) {
            if (!res.headersSent) res.status(502).json({ ok: false, error: `Backend 不可用：${error instanceof Error ? error.message : String(error)}` });
        }
    });
    const server = app.listen(port, "127.0.0.1", () => console.log(`canvas-agent compatibility proxy: http://127.0.0.1:${port} → ${backend.url}/agent`));
    return server;
}

function mapPath(original: string) {
    const parsed = new URL(original, "http://127.0.0.1");
    if (["/health", "/config"].includes(parsed.pathname)) return `${parsed.pathname}${parsed.search}`;
    if (parsed.pathname === "/events" || parsed.pathname.startsWith("/agent/")) parsed.pathname = `/agent${parsed.pathname === "/events" ? "/events" : parsed.pathname.slice("/agent".length)}`;
    else parsed.pathname = `/agent${parsed.pathname}`;
    return `${parsed.pathname}${parsed.search}`;
}

function readBackendConfig(): { url: string; token: string } {
    const file = path.join(os.homedir(), ".infinite-canvas", "backend.json");
    let config: BackendConfig = {};
    try { config = JSON.parse(fs.readFileSync(file, "utf8")) as BackendConfig; } catch { /* backend will return a useful connection error */ }
    return { url: String(config.url || "http://127.0.0.1:17370").replace(/\/$/, ""), token: String(config.token || process.env.INFINITE_CANVAS_BACKEND_TOKEN || "") };
}
