import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { ResolvedConfig } from "../config.js";

type CanvasPeer = {
    projectId: string;
    clientId: string;
    label: string;
    color: string;
    cursor?: { x: number; y: number };
    selectedNodeIds: string[];
};

/**
 * 画布瞬时协作通道。只传光标、选区和拖动预览等 presence，绝不写 SQLite，
 * 也不占用 canvas revision；持久化修改仍统一走 /canvas/projects/:id/ops。
 */
export class CanvasRealtimeHub {
    private readonly sockets = new Map<WebSocket, CanvasPeer>();
    private readonly wss = new WebSocketServer({ noServer: true });

    constructor(private readonly config: ResolvedConfig) {}

    attach(server: Server) {
        server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
    }

    close() {
        for (const socket of this.sockets.keys()) socket.close();
        this.wss.close();
    }

    private upgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
        const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
        if (url.pathname !== "/canvas/realtime") return;
        const projectId = String(url.searchParams.get("projectId") || "").trim();
        const clientId = String(url.searchParams.get("clientId") || "").trim();
        if (url.searchParams.get("token") !== this.config.token || !projectId || !clientId) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }
        const peer: CanvasPeer = {
            projectId,
            clientId: clientId.slice(0, 128),
            label: String(url.searchParams.get("label") || "浏览器画布").slice(0, 80),
            color: String(url.searchParams.get("color") || "#0f766e").slice(0, 24),
            selectedNodeIds: [],
        };
        this.wss.handleUpgrade(request, socket, head, (webSocket) => this.connect(webSocket, peer));
    }

    private connect(socket: WebSocket, peer: CanvasPeer) {
        this.sockets.set(socket, peer);
        socket.on("message", (data) => this.receive(socket, data));
        socket.on("close", () => {
            const current = this.sockets.get(socket);
            this.sockets.delete(socket);
            if (current) this.broadcastPresence(current.projectId);
        });
        socket.on("error", () => socket.close());
        this.broadcastPresence(peer.projectId);
    }

    private receive(socket: WebSocket, data: RawData) {
        const peer = this.sockets.get(socket);
        if (!peer) return;
        let message: Record<string, unknown>;
        try { message = JSON.parse(data.toString()) as Record<string, unknown>; }
        catch { return; }
        if (message.type !== "presence") return;
        const cursor = message.cursor && typeof message.cursor === "object" && !Array.isArray(message.cursor) ? message.cursor as Record<string, unknown> : null;
        const x = Number(cursor?.x);
        const y = Number(cursor?.y);
        peer.cursor = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
        peer.selectedNodeIds = Array.isArray(message.selectedNodeIds) ? message.selectedNodeIds.map(String) : [];
        this.broadcastPresence(peer.projectId);
    }

    private broadcastPresence(projectId: string) {
        const participants = [...this.sockets.values()].filter((peer) => peer.projectId === projectId);
        const payload = JSON.stringify({ type: "presence", projectId, participants });
        for (const [socket, peer] of this.sockets) {
            if (peer.projectId === projectId && socket.readyState === WebSocket.OPEN) socket.send(payload);
        }
    }
}
