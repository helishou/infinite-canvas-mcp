import { create } from "zustand";
import { backendHealth, discoverBackendToken, getBackendUrl } from "@/services/backend-api";
import { setBackendToken } from "@/lib/backend-token";

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
let checkLock = false;

function stopBackendEvents() {
    backendEvents?.close();
    backendEvents = null;
}

function startBackendEvents(url: string, token: string) {
    if (typeof window === "undefined" || !token) return;
    stopBackendEvents();
    const source = new EventSource(`${url.replace(/\/$/, "")}/events?token=${encodeURIComponent(token)}`);
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
}

function syncAgentEndpoint(url: string, token: string) {
    if (typeof window === "undefined") return;
    void import("@/stores/use-agent-store").then(({ useAgentStore }) => useAgentStore.getState().setAgentState({ url: `${url.replace(/\/$/, "")}/agent`, token }));
}

/** 总后台连接状态 store。自动在启动时检测连通性。 */
export const useBackendStore = create<BackendStore>((set, get) => ({
    url: getBackendUrl(),
    token: "",
    connected: false,
    checking: true,
    error: "",

    setConnection: (url, token) => {
        const cleanUrl = url.replace(/\/$/, "");
        const newToken = token || get().token;
        setBackendToken(newToken);
        set({ url: cleanUrl, token: newToken, error: "" });
        syncAgentEndpoint(cleanUrl, newToken);
        void get().checkConnection();
    },

    checkConnection: async () => {
        if (checkLock) return;
        checkLock = true;
        set({ checking: true });
        const wasConnected = get().connected;

        const health = await backendHealth();
        if (!health.ok) {
            stopBackendEvents();
            set({ connected: false, checking: false, error: `无法连接总后台 ${getBackendUrl()}` });
            checkLock = false;
            return;
        }

        // ── 阶段2：获取 token ──────────────────────────────────────────────
        // 如果 token 未知，先从 /config 获取后再重新检测健康状态。
        if (!get().token) {
            const discovered = await discoverBackendToken();
            if (discovered.ok && discovered.token) {
                setBackendToken(discovered.token);
                set({ token: discovered.token });
                syncAgentEndpoint(getBackendUrl(), discovered.token);
            }
        }

        // ── 阶段3：确认连接并启动 SSE ────────────────────────────────────
        set({ connected: true, checking: false, error: "" });
        if (!wasConnected) window.dispatchEvent(new Event("backend-connected"));
        startBackendEvents(getBackendUrl(), get().token);
        checkLock = false;
    },

    reset: () => { stopBackendEvents(); set({ connected: false, checking: false, error: "" }); },
}));

/** 启动时自动检测总后台连接。 */
export function initBackendConnection() {
    if (typeof window === "undefined") return;
    void useBackendStore.getState().checkConnection();
    // 周期性重连检测
    setInterval(() => {
        if (!useBackendStore.getState().connected) {
            void useBackendStore.getState().checkConnection();
        }
    }, 10_000);
}
