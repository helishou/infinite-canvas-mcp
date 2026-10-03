type Connection = { url: string; token: string };
let active: Connection | undefined;

export function defaultBackendUrl(): string {
    const configured = typeof window === "undefined" ? undefined : window.__RUNTIME_CONFIG__?.BACKEND_URL;
    const value = configured?.trim() || import.meta.env?.VITE_BACKEND_URL?.trim();
    return value ? new URL(value, window.location.origin).href.replace(/\/$/, "") : "http://127.0.0.1:17370";
}

export function normalizeBackendAddress(value: string) {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("后台地址填写 http/https 地址，可包含反向代理前缀，不包含密钥、查询参数或片段");
    return url.href.replace(/\/+$/, "");
}

export function backendConnection(): Connection {
    if (active) return active;
    let value: Partial<Connection> = {};
    try {
        value = JSON.parse(sessionStorage.getItem("backend-connection") || "null")
            || { url: localStorage.getItem("backend-url"), token: localStorage.getItem("backend-token") };
    } catch { /* 首次加载/存储不可用 */ }
    active = { url: value.url || defaultBackendUrl(), token: value.token || "" };
    // 固定本窗口连接；其他窗口切后台不能把在途操作发往另一数据库。
    try { sessionStorage.setItem("backend-connection", JSON.stringify(active)); } catch { /* storage blocked */ }
    return active;
}

export function persistBackendConnection(connection: Connection) {
    // 先写本窗口；失败交给界面显示，不能谎报已连接。
    sessionStorage.setItem("backend-connection", JSON.stringify(connection));
    try {
        localStorage.setItem("backend-url", connection.url);
        localStorage.setItem("backend-token", connection.token);
    } catch { /* 本窗口已保存，全局默认值为可选 */ }
}

export function updateBackendToken(token: string) {
    active = { ...backendConnection(), token };
    try { persistBackendConnection(active); } catch { /* 当前文档仍可使用内存凭证 */ }
}
