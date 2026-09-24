type Connection = { url: string; token: string };
let active: Connection | undefined;

export function backendConnection(): Connection {
    if (active) return active;
    let value: Partial<Connection> = {};
    try {
        value = JSON.parse(sessionStorage.getItem("backend-connection") || "null")
            || { url: localStorage.getItem("backend-url"), token: localStorage.getItem("backend-token") };
    } catch { /* 首次加载/存储不可用 */ }
    active = { url: value.url || "http://127.0.0.1:17370", token: value.token || "" };
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
