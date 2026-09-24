import { BackendApiError, getBackendUrl, getCanvasCollaborationClient, request } from "@/services/backend-api";
import { getBackendTokenShared } from "@/lib/backend-token";
import { applyBackendCanvasEvent, flushCanvasSyncNow, getCanvasAcknowledgedRevision, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { reconnectCanvasTexts } from "./canvas-text";
import { getCanvasTextPresence, type CanvasTextSelection } from "@/lib/canvas/canvas-text-presence";

export type CanvasPeer = {
    clientId: string; connectionId: string; label: string; color: string;
    cursor?: { x: number; y: number }; selectedNodeIds: string[];
    drag?: Array<{ nodeId: string; position: { x: number; y: number } }>;
    textSelection?: CanvasTextSelection | null;
    focused?: boolean;
};
export type CanvasPresenceInput = Pick<CanvasPeer, "cursor" | "selectedNodeIds" | "drag" | "textSelection" | "focused">;

export function connectCanvasRealtime(projectId: string, onPeers: (peers: CanvasPeer[]) => void, onError: (error: string) => void) {
    const client = getCanvasCollaborationClient();
    let disposed = false;
    let socket: WebSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1_000;
    let acknowledgedRevision = -1;
    let peers = new Map<string, CanvasPeer>();
    const textPresence = getCanvasTextPresence(projectId);
    // 切到 Codex 或其他应用时页面仍是用户打开的画布；只有标签页/窗口不可见时才取消默认目标。
    const isVisible = () =>
        typeof document !== "undefined" && document.visibilityState === "visible";
    let presence: CanvasPresenceInput = {
        selectedNodeIds: [],
        textSelection: textPresence.getLocal(),
        focused: isVisible(),
    };
    const emitPeers = () => {
        const values = [...peers.values()];
        textPresence.receive(values.filter((peer) => peer.clientId !== client.clientId));
        onPeers(values);
    };
    const flush = () => {
        sendTimer = undefined;
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "presence", ...presence }));
    };
    const syncFocus = (forceFocused = false) => {
        const focused = forceFocused || isVisible();
        if (presence.focused === focused && !forceFocused) return;
        presence = { ...presence, focused };
        if (!sendTimer) sendTimer = setTimeout(flush, 0);
    };
    const onWindowFocus = () => { if (isVisible()) syncFocus(true); };
    const onVisibilityChange = () => syncFocus();
    const acknowledge = () => {
        const revision = getCanvasAcknowledgedRevision(projectId);
        if (socket?.readyState === WebSocket.OPEN && revision !== acknowledgedRevision) {
            socket.send(JSON.stringify({ type: "ack", revision }));
            acknowledgedRevision = revision;
        }
    };
    const unsubscribe = useCanvasStore.subscribe(acknowledge);
    const unsubscribeText = textPresence.onLocal(() => {
        presence = { ...presence, textSelection: textPresence.getLocal() };
        if (!sendTimer) sendTimer = setTimeout(flush, 50);
    });
    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const retry = () => {
        if (disposed) return;
        const delay = retryDelay * (0.8 + Math.random() * 0.2);
        retryDelay = Math.min(retryDelay * 2, 30_000);
        retryTimer = setTimeout(() => { void open(); }, delay);
    };
    const open = async () => {
        // 浏览器不暴露 WebSocket 握手 HTTP 状态；先鉴权以区分不可重试错误。
        try { await request("GET", `/canvas/projects/${encodeURIComponent(projectId)}/collaboration`); }
        catch (error) {
            if (disposed) return;
            if (error instanceof BackendApiError && [401, 403, 404].includes(error.status)) {
                onError(error.status === 404 ? "画布不存在" : "协作连接鉴权失败，请检查后台地址、来源白名单和令牌");
                return;
            }
            onError("协作连接已断开，正在重连");
            retry();
            return;
        }
        if (disposed) return;
        const backend = new URL(getBackendUrl());
        const local = import.meta.env.DEV && ["127.0.0.1", "localhost"].includes(backend.hostname) && backend.port === "17370";
        const endpoint = new URL("/canvas/realtime", local ? location.origin : backend.origin);
        endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        endpoint.searchParams.set("token", getBackendTokenShared());
        endpoint.searchParams.set("projectId", projectId);
        endpoint.searchParams.set("clientId", client.clientId);
        endpoint.searchParams.set("label", client.label);
        const current = new WebSocket(endpoint);
        socket = current;
        current.addEventListener("open", () => {
            if (disposed) return;
            retryDelay = 1_000;
            acknowledgedRevision = -1;
            onError("");
            current.send(JSON.stringify({ type: "subscribe", afterRevision: getCanvasAcknowledgedRevision(projectId) }));
            flush();
            void flushCanvasSyncNow();
            void reconnectCanvasTexts(projectId);
        });
        current.addEventListener("message", (event) => {
            if (disposed || current !== socket) return;
            try {
                const value = JSON.parse(String(event.data));
                if (!value || typeof value !== "object") return;
                if (value.type === "canvas.event") applyBackendCanvasEvent(value.event);
                else if (value.type === "canvas.sync") {
                    if (value.reset && value.project) {
                        applyBackendCanvasEvent({ type: "canvas.updated", entityId: projectId, revision: value.revision, payload: value.project });
                        void reconnectCanvasTexts(projectId);
                    }
                    else for (const commit of value.commits || []) applyBackendCanvasEvent({ type: "canvas.updated", entityId: projectId, revision: commit.revision, operationId: commit.operationId, source: commit.source, payload: { operations: commit.operations, updatedAt: commit.updatedAt } });
                } else if (value.type === "presence" && Array.isArray(value.participants)) {
                    peers = new Map(value.participants.map((peer: CanvasPeer) => [peer.connectionId, peer]));
                    emitPeers();
                } else if (value.type === "presence.peer" && value.peer?.connectionId) {
                    peers.set(value.peer.connectionId, value.peer);
                    emitPeers();
                } else if (value.type === "presence.leave") {
                    peers.delete(value.connectionId);
                    emitPeers();
                } else if (value.type === "canvas.error") onError(String(value.message));
                acknowledge();
            } catch (error) { onError(error instanceof Error ? error.message : "协作消息无法处理"); }
        });
        current.addEventListener("close", () => {
            if (disposed || current !== socket) return;
            peers.clear(); emitPeers();
            onError("协作连接已断开，正在重连");
            retry();
        });
    };
    void open();
    return {
        update: (patch: Partial<CanvasPresenceInput>) => {
            presence = { ...presence, ...patch };
            if (!sendTimer) sendTimer = setTimeout(flush, 50);
        },
        close: () => {
            disposed = true;
            unsubscribe();
            unsubscribeText();
            window.removeEventListener("focus", onWindowFocus);
            document.removeEventListener("visibilitychange", onVisibilityChange);
            clearTimeout(retryTimer); clearTimeout(sendTimer);
            socket?.close(); peers.clear(); emitPeers();
        },
    };
}
