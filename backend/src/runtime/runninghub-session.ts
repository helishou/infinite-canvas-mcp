/**
 * RunningHub 网页会话的读取、校验与保存。
 *
 * 「把本地工作流上传到云端」必须走 RunningHub 网页端的接口：实测 OpenAPI Key 调用
 * `/api/workflow/create`、`/api/workflow/upload` 一律返回 412 TOKEN_INVALID，
 * 这些接口只认网页端登录令牌。令牌存在浏览器 Local Storage 的 `Rh-Accesstoken` 上，
 * 所以这里直接从本机浏览器里读用户已经登录的会话，避免让用户手工翻控制台。
 *
 * 令牌全程只在本机使用，也只用于向 RunningHub 站点发请求，不落进任何日志或任务事件。
 */
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SettingStore } from "../stores/types.js";

export type RunningHubSession = {
    accessToken: string;
    refreshToken?: string;
    /** JWT exp（秒）；缺失视为长期有效，由平台校验兜底。 */
    expiresAt?: number;
    source?: "browser" | "manual";
    updatedAt?: string;
};

export type RunningHubSessionStatus = {
    connected: boolean;
    source?: "browser" | "manual";
    expiresAt?: number;
    expired?: boolean;
    updatedAt?: string;
    /** 只回令牌前 8 位，便于确认取到的是哪次登录。 */
    tokenHint?: string;
};

export type RunningHubBrowserSession = {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    browser: string;
    /** 命中的浏览器 profile，便于失败时告诉用户去哪里登录。 */
    profile: string;
};

/**
 * 会话按站点分开存：`default` 用老键保持向后兼容，另两个站点各自一份。
 * 两个站点的登录令牌互不相通，混用会直接 412，所以不能共用一份。
 */
export function sessionKey(site: string): string {
    return site === "default" || !site ? "runninghub.session" : `runninghub.session.${site}`;
}
const ACCESS_KEY = "Rh-Accesstoken";
const REFRESH_KEY = "Rh-Refreshtoken";
const JWT = /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/g;
/** 单个 leveldb 文件超过这个体积就不读，避免把浏览器缓存整体搬进内存。 */
const MAX_LEVELDB_BYTES = 64 * 1024 * 1024;

export function readSession(settings: SettingStore, site = "default"): RunningHubSession {
    const stored = settings.get(sessionKey(site));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return { accessToken: "" };
    const record = stored as Record<string, unknown>;
    return {
        accessToken: String(record.accessToken || ""),
        refreshToken: typeof record.refreshToken === "string" ? record.refreshToken : undefined,
        expiresAt: Number.isFinite(Number(record.expiresAt)) ? Number(record.expiresAt) : undefined,
        source: record.source === "browser" || record.source === "manual" ? record.source : undefined,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
    };
}

export function writeSession(settings: SettingStore, patch: Partial<RunningHubSession>, site = "default"): RunningHubSession {
    const current = readSession(settings, site);
    const next: RunningHubSession = {
        accessToken: String(patch.accessToken ?? (current.accessToken || "")),
        refreshToken: patch.refreshToken ?? current.refreshToken,
        expiresAt: patch.expiresAt ?? current.expiresAt ?? jwtExpiry(patch.accessToken ?? current.accessToken),
        source: patch.source ?? current.source ?? "manual",
        updatedAt: new Date().toISOString(),
    };
    if (!next.accessToken) return clearSession(settings, site);
    settings.set(sessionKey(site), next);
    return next;
}

export function clearSession(settings: SettingStore, site = "default"): RunningHubSession {
    settings.set(sessionKey(site), { accessToken: "" });
    return { accessToken: "" };
}

export function sessionStatus(session: RunningHubSession): RunningHubSessionStatus {
    const connected = Boolean(session.accessToken);
    return {
        connected,
        source: session.source,
        expiresAt: session.expiresAt,
        expired: Boolean(session.expiresAt) && session.expiresAt! * 1000 <= Date.now(),
        updatedAt: session.updatedAt,
        tokenHint: connected ? session.accessToken.slice(0, 8) : undefined,
    };
}

/** 用只读接口确认令牌还能用：能列出自己的工作流才算连上。 */
export async function probeSession(baseUrl: string, token: string, signal?: AbortSignal): Promise<boolean> {
    if (!token) return false;
    try {
        const response = await fetch(`${sanitizeUrl(baseUrl)}/api/workflow/simpleList`, {
            method: "POST",
            headers: { "content-type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
            body: "{}",
            signal: signal ?? AbortSignal.timeout(20000),
        });
        if (!response.ok) return false;
        const body = await response.json() as Record<string, unknown>;
        return Number(body.code) === 0;
    } catch {
        return false;
    }
}

/**
 * 在本机浏览器的 Local Storage 里找已登录的 RunningHub 会话。
 * 直接读正在运行的浏览器数据库有锁风险，所以先复制到临时目录再解析。
 */
export async function collectBrowserSessions(): Promise<RunningHubBrowserSession[]> {
    const roots: Array<{ browser: string; dir: string }> = [];
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    roots.push({ browser: "Chrome", dir: path.join(local, "Google", "Chrome", "User Data") });
    roots.push({ browser: "Edge", dir: path.join(local, "Microsoft", "Edge", "User Data") });
    const work = path.join(os.tmpdir(), `infinite-canvas-rh-session-${process.pid}`);
    const found: RunningHubBrowserSession[] = [];
    try {
        for (const root of roots) {
            const profiles = await listProfiles(root.dir);
            for (const profile of profiles) {
                const leveldb = path.join(root.dir, profile, "Local Storage", "leveldb");
                const files = await listLevelDbFiles(leveldb);
                for (const file of files) {
                    const target = path.join(work, `${found.length}-${file.name}`);
                    try {
                        await mkdir(work, { recursive: true });
                        await copyFile(path.join(leveldb, file.name), target);
                        const bytes = await readFile(target);
                        for (const session of readTokens(bytes)) found.push({ ...session, browser: root.browser, profile });
                    } catch {
                        // 某个文件读不动不影响其它 profile；浏览器开着时数据库会被锁。
                    } finally {
                        await rm(target, { force: true });
                    }
                }
            }
        }
    } finally {
        await rm(work, { recursive: true, force: true });
    }
    // 同一次登录的令牌会散落在多个 SST 里；按过期时间倒序，保留最新的那些先试。
    return dedupeTokens(found);
}

async function listProfiles(userDataDir: string): Promise<string[]> {
    try {
        const entries = await readdir(userDataDir, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/.test(entry.name)))
            .map((entry) => entry.name);
    } catch {
        return [];
    }
}

async function listLevelDbFiles(leveldb: string): Promise<Array<{ name: string; size: number }>> {
    try {
        const entries = await readdir(leveldb);
        const files: Array<{ name: string; size: number }> = [];
        for (const name of entries) {
            if (!/\.(ldb|log)$/i.test(name)) continue;
            const info = await stat(path.join(leveldb, name));
            if (info.isFile() && info.size <= MAX_LEVELDB_BYTES) files.push({ name, size: info.size });
        }
        // 大文件通常是历史 SST，真正的活跃记录在最近的日志里；先读小的、新的。
        return files.sort((left, right) => left.size - right.size).slice(0, 60);
    } catch {
        return [];
    }
}

/** 从 leveldb 原始字节里抓 `Rh-Accesstoken` / `Rh-Refreshtoken` 后面的 JWT。 */
export function readTokens(bytes: Buffer): Array<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
    const decoded: Array<{ accessToken: string; refreshToken?: string; expiresAt?: number }> = [];
    let index = bytes.indexOf(ACCESS_KEY, 0, "utf8");
    while (index >= 0) {
        const window = bytes.subarray(index, Math.min(index + 2048, bytes.length)).toString("utf8");
        for (const token of window.match(JWT) || []) {
            if (!/^eyJ[A-Za-z0-9_-]+$/.test(token.split(".")[0])) continue;
            const expiresAt = jwtExpiry(token);
            if (!expiresAt) continue;
            decoded.push({ accessToken: token, refreshToken: readRefreshNear(bytes, index), expiresAt });
        }
        index = bytes.indexOf(ACCESS_KEY, index + 1, "utf8");
    }
    return decoded.sort((left, right) => (right.expiresAt || 0) - (left.expiresAt || 0));
}

/** 刷新令牌与访问令牌存在相邻记录里，取窗口内第一个可用的 JWT。 */
function readRefreshNear(bytes: Buffer, around: number): string | undefined {
    let index = bytes.indexOf(REFRESH_KEY, Math.max(0, around - 4096), "utf8");
    const limit = around + 8192;
    while (index >= 0 && index <= limit) {
        const window = bytes.subarray(index, Math.min(index + 2048, bytes.length)).toString("utf8");
        for (const token of window.match(JWT) || []) {
            if (/^eyJ[A-Za-z0-9_-]+$/.test(token.split(".")[0]) && token.length > 200) return token;
        }
        index = bytes.indexOf(REFRESH_KEY, index + 1, "utf8");
    }
    return undefined;
}

function dedupeTokens(sessions: RunningHubBrowserSession[]): RunningHubBrowserSession[] {
    const seen = new Set<string>();
    return sessions.filter((session) => {
        const key = session.accessToken;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** 解 JWT 的 exp；不是 JWT 或没有 exp 时返回 undefined。 */
export function jwtExpiry(token: string | undefined): number | undefined {
    if (!token) return undefined;
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    try {
        const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
        const exp = Number(JSON.parse(payload).exp);
        return Number.isFinite(exp) ? exp : undefined;
    } catch {
        return undefined;
    }
}

function sanitizeUrl(value: string) {
    try {
        const url = new URL(value.trim());
        return ["http:", "https:"].includes(url.protocol) ? url.toString().replace(/\/$/, "") : "";
    } catch {
        return "";
    }
}
