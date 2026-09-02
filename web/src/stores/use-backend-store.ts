import { create } from "zustand";
import { backendHealth, discoverBackendToken, getBackendToken, getBackendUrl, setBackendConnection } from "@/services/backend-api";

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
            if (event.type === "canvas.updated") void import("@/stores/canvas/use-canvas-store").then(({ hydrateCanvasProjects }) => hydrateCanvasProjects());
            if (event.type === "asset.updated") void import("@/stores/use-asset-store").then(({ hydrateAssets }) => hydrateAssets());
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
    token: getBackendToken(),
    connected: false,
    checking: true,
    error: "",

    setConnection: (url, token) => {
        const cleanUrl = url.replace(/\/$/, "");
        setBackendConnection(cleanUrl, token || get().token);
        set({ url: cleanUrl, token: token || get().token, error: "" });
        syncAgentEndpoint(cleanUrl, token || get().token);
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
            setBackendConnection(getBackendUrl(), discovered.token);
            set({ token: discovered.token, checking: true });
            syncAgentEndpoint(getBackendUrl(), discovered.token);
            await get().checkConnection();
            return;
        }
        if (!wasConnected) {
            const { migrateIndexDBToBackend } = await import("@/lib/backend-migration");
            const migration = await migrateIndexDBToBackend();
            if (!migration.success) {
                const error = `Backend 数据迁移失败：${migration.error || "未知错误"}`;
                console.warn("[backend-migration]", error);
                set({ connected: false, checking: false, error });
                return;
            }
        }
        set({ connected: true, checking: false, error: "" });
        if (!wasConnected) window.dispatchEvent(new Event("backend-connected"));
        startBackendEvents(getBackendUrl(), get().token);
    },

    reset: () => { stopBackendEvents(); set({ connected: false, checking: false, error: "" }); },
}));

/** 启动时自动检测总后台连接。首次连接时先完成一次性 IndexedDB 迁移。 */
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
