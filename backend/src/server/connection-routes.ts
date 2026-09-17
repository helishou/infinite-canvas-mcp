import os from "node:os";
import type { Express, Request } from "express";
import type { ResolvedConfig } from "../config.js";
import type { SettingStore } from "../stores/types.js";

export const NETWORK_SETTINGS_KEY = "backend.network";
const localOrigins = ["http://127.0.0.1:3001", "http://localhost:3001"];
const loopback = (host: string) => ["localhost", "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"].includes(host);

/** 不信任 Forwarded/X-Forwarded-*；远端来源不能借本机代理自动取得密钥。 */
export function isLocalConnection(req: Pick<Request, "socket" | "headers">) {
    if (!loopback(req.socket.remoteAddress || "")) return false;
    try {
        return loopback(new URL(`http://${req.headers.host || ""}`).hostname)
            && (!req.headers.origin || loopback(new URL(req.headers.origin).hostname));
    } catch { return false; }
}

export function parseNetworkSettings(value: unknown): { lanEnabled: boolean; origins: string[] } {
    const input = value as { lanEnabled?: unknown; origins?: unknown } | null;
    if (typeof input?.lanEnabled !== "boolean" || !Array.isArray(input.origins)) throw new Error("请提供局域网开关与允许的网页来源列表");
    const origins = input.origins.map((value) => {
        if (typeof value !== "string") throw new Error("网页来源必须是完整的 http/https 地址");
        const url = new URL(value.trim());
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("网页来源只填写协议、主机与端口，不含路径、密钥或通配符");
        return url.origin;
    });
    return { lanEnabled: input.lanEnabled, origins: [...new Set([...localOrigins, ...origins])] };
}

export function applyNetworkSettings(config: ResolvedConfig, value: unknown) {
    if (value === undefined) return;
    const settings = parseNetworkSettings(value);
    config.listenHost = settings.lanEnabled ? "0.0.0.0" : "127.0.0.1";
    config.origins = settings.origins;
}

export function registerConnectionRoutes(app: Express, config: ResolvedConfig, settings: SettingStore) {
    const current = { lanEnabled: config.listenHost === "0.0.0.0", origins: config.origins };
    const state = (req: Request) => {
        const configured = settings.get(NETWORK_SETTINGS_KEY) ?? current;
        return { ok: true, current, configured, canConfigure: isLocalConnection(req),
            restartRequired: JSON.stringify(configured) !== JSON.stringify(current),
            addresses: [...new Set(Object.values(os.networkInterfaces()).flatMap((entries) => (entries || []).filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => `http://${entry.address}:${config.port}`)))],
        };
    };
    app.get("/connection", (req, res) => res.json(state(req)));
    app.put("/connection", (req, res) => {
        if (!isLocalConnection(req)) return void res.status(403).json({ ok: false, error: "请在后台所在电脑的 localhost 页面修改监听设置" });
        try {
            settings.set(NETWORK_SETTINGS_KEY, parseNetworkSettings(req.body));
            res.json(state(req));
        } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
}
