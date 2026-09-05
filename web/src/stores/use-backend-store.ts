import { create } from "zustand";
import { backendHealth, discoverBackendToken, getBackendUrl } from "@/services/backend-api";
import { getBackendTokenShared, setBackendToken } from "@/lib/backend-token";

type BackendStore = {
    url: string;
    token: string;
    connected: boolean;
    checking: boolean;
    error: string;
    setConnection: (url: string, token?: string) => void;
    checkConnection: () => Promise<void>;
    reset: () => void;
};

let backendEvents: EventSource | null = null;
const seenBackendEventIds = new Set<string>();

// 本地总后台（127.0.0.1/localhost:17370）在浏览器直连时会经过系统代理，
// 而代理会截断长连接 SSE（net::ERR_INCOMPLETE_CHUNKED_ENCODING）。
// 检测到本地总后台时改走同源相对路径，由 Vite 开发服务器代理转发（Node 端，不经浏览器代理），
// 从而绕开代理对 SSE 的截断。非本地/远程总后台仍用绝对地址直连。
function isLocalBackendUrl(url: string): boolean {
    if (typeof window === "undefined") return false;
    try {
        const u = new URL(url);
        return (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === "17370";
    } catch {
        return false;
    }
}

function stopBackendEvents() {
    backendEvents?.close();
    backendEvents = null;
}

function startBackendEvents(url: string, token: string) {
    if (typeof window === "undefined" || !token) return;
    stopBackendEvents();
    const eventsUrl = isLocalBackendUrl(url)
        ? `/events?token=${encodeURIComponent(token)}`
        : `${url.replace(/\/$/, "")}/events?token=${encodeURIComponent(token)}`;
    const source = new EventSource(eventsUrl);
    backendEvents = source;
    const handleMessage = (message: MessageEvent<string>) => {
        try {
            const event = JSON.parse(message.data) as { id?: string; type?: string; entityId?: string; payload?: unknown };
            if (!event.id || seenBackendEventIds.has(event.id)) return;
            seenBackendEventIds.add(event.id);
            if (seenBackendEventIds.size > 500) seenBackendEventIds.delete(seenBackendEventIds.values().next().value as string);
            window.dispatchEvent(new CustomEvent("backend-event", { detail: event }));
        } catch { /* SSE 单条消息损坏时交给下一次快照恢复 */ }
    };
    for (const eventType of ["task.created", "task.updated", "task.completed", "task.failed", "generation-log.updated", "plugin.updated", "canvas.updated", "asset.updated"]) {
        source.addEventListener(eventType, handleMessage);
    }
    source.onerror = () => {
        if (useBackendStore.getState().connected) {
            stopBackendEvents();
            useBackendStore.setState({ connected: false, checking: false, error: `无法连接总后台 ${url}` });
        }
    };
}

function syncAgentEndpoint(url: string, token: string) {
    if (typeof window === "undefined") return;
    void import("@/stores/use-agent-store").then(({ useAgentStore }) => useAgentStore.getState().setAgentState({ url: `${url.replace(/\/$/, "")}/agent`, token }));
}

/** 总后台连接状态 store。自动在启动时检测连通性。 */
export const useBackendStore = create<BackendStore>((set, get) => ({
    url: getBackendUrl(),
    token: getBackendTokenShared(),
    connected: false,
    checking: true,
    error: "",

    setConnection: (url, token) => {
        const cleanUrl = url.replace(/\/$/, "");
        const nextToken = token || get().token;
        // 同步持久化，保证 backend-api.ts 的 getBackendUrl()/getBackendTokenShared() 取到最新值。
        try { localStorage.setItem("backend-url", cleanUrl); } catch { /* storage blocked */ }
        setBackendToken(nextToken);
        set({ url: cleanUrl, token: nextToken, error: "" });
        syncAgentEndpoint(cleanUrl, nextToken);
        void get().checkConnection();
    },

    checkConnection: async () => {
        set({ checking: true });
        const wasConnected = get().connected;
        const health = await backendHealth();
        if (!health.ok) {
            stopBackendEvents();
            set({ connected: false, checking: false, error: `无法连接总后台 ${getBackendUrl()}` });
            return;
        }
        // 后端 /config 是 token 权威来源，连接时以后端为准刷新，避免缓存旧 token 导致 401。
        const discovered = await discoverBackendToken();
        if (discovered.ok && discovered.token && discovered.token !== get().token) {
            setBackendToken(discovered.token);
            set({ token: discovered.token, checking: true });
            syncAgentEndpoint(getBackendUrl(), discovered.token);
            await get().checkConnection();
            return;
        }
        set({ connected: true, checking: false, error: "" });
        if (!wasConnected) window.dispatchEvent(new Event("backend-connected"));
        startBackendEvents(getBackendUrl(), get().token);
    },

    reset: () => { stopBackendEvents(); set({ connected: false, checking: false, error: "" }); },
}));

/** 启动时自动检测总后台连接。 */
export function initBackendConnection() {
    if (typeof window === "undefined") return;
    void useBackendStore.getState().checkConnection();
    // 周期性检测：已连接状态也必须持续探活，才能感知后台运行中途崩溃。
    setInterval(() => {
        void useBackendStore.getState().checkConnection();
    }, 10_000);
}
