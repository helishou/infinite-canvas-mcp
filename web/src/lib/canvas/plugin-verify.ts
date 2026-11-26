import { APP_VERSION } from "@/constant/env";

// 校验远程插件包在安装前必须满足的两条约束：完整性(integrity)与宿主版本兼容(minAppVersion)。
// 摘取上游 v1.0.0 的"下载后先校验再求值"设计，落到本地单文件 JS 插件体系。

function parseIntegrity(integrity: string): { algo: "SHA-256"; hex: string } | null {
    if (!integrity.startsWith("sha256-")) return null;
    const b64 = integrity.slice("sha256-".length);
    try {
        const bin = atob(b64);
        const hex = Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
        return { algo: "SHA-256", hex };
    } catch {
        return null;
    }
}

// crypto.subtle 需要安全上下文(https/localhost)。非安全上下文或无该 API 时返回 null,
// 表示"无法校验"而非"校验失败",由调用方决定是否放行,避免离线 dev 环境直接装不上。
export async function sha256Hex(source: string): Promise<string | null> {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    try {
        const bytes = new TextEncoder().encode(source);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
        return null;
    }
}

export type IntegrityResult = { ok: boolean; reason?: "unsupported" | "mismatch" | "bad-format" };

// integrity 为空表示来源未提供校验值(如第三方 URL 安装),直接放行。
// 提供了但环境不支持校验时,放行并标记 unsupported,由 UI 决定是否提示。
export async function verifyIntegrity(source: string, integrity?: string): Promise<IntegrityResult> {
    if (!integrity) return { ok: true };
    const expected = parseIntegrity(integrity);
    if (!expected) return { ok: false, reason: "bad-format" };
    const actual = await sha256Hex(source);
    if (actual === null) return { ok: true, reason: "unsupported" };
    return actual === expected.hex ? { ok: true } : { ok: false, reason: "mismatch" };
}

// 解析版本:只取 major.minor.patch 的数字部分,忽略 prerelease 等后缀。
function versionParts(v: string): number[] {
    return v.split(".").slice(0, 3).map((part) => parseInt(part, 10) || 0);
}

// 宿主版本满足插件声明的最低版本才允许加载。minAppVersion 为空表示无约束。
export function isHostCompatible(minAppVersion?: string, hostVersion: string = APP_VERSION): boolean {
    if (!minAppVersion) return true;
    // dev 构建没有固定版本号,不做兼容拦截,避免本地开发装不上。
    if (!hostVersion || hostVersion === "dev") return true;
    const min = versionParts(minAppVersion);
    const host = versionParts(hostVersion);
    for (let i = 0; i < 3; i++) {
        const a = host[i] || 0;
        const b = min[i] || 0;
        if (a > b) return true;
        if (a < b) return false;
    }
    return true;
}
