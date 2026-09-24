import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import type { BackendDatabase } from "../db.js";
import type { BackendEventBus } from "../events.js";
import type { ResolvedConfig } from "../config.js";
import { textTargetSchema } from "@basketikun/canvas-agent/schemas";

const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const presence = z.object({
    type: z.literal("presence"), cursor: point.nullish(), selectedNodeIds: z.array(z.string()),
    drag: z.array(z.object({ nodeId: z.string(), position: point })).optional(),
    textSelection: z.object({ target: textTargetSchema, documentId: z.string().min(1), anchor: z.string().min(1), head: z.string().min(1) }).nullish(),
    // 焦点只用于选择 MCP 的默认画布，不写入项目快照或 revision。
    focused: z.boolean().optional(),
});
type CanvasPeer = {
    projectId: string; clientId: string; connectionId: string; label: string; color: string;
    selectedNodeIds: string[]; cursor?: z.infer<typeof point>; drag?: z.infer<typeof presence>["drag"];
    textSelection?: z.infer<typeof presence>["textSelection"];
    focused: boolean; focusSequence: number;
    revision: number; missedPongs: number;
};
const colors = ["#0f766e", "#b45309", "#be123c", "#1d4ed8", "#6d28d9", "#3f6212"];

/** 持久增量只能来自 SQLite 提交；临时光标/选区/拖动预览不写数据库。 */
export class CanvasRealtimeHub {
    private readonly sockets = new Map<WebSocket, CanvasPeer>();
    private readonly wss = new WebSocketServer({ noServer: true });
    private readonly heartbeat: ReturnType<typeof setInterval>;
    private readonly unsubscribe: () => void;
    private readonly pendingPeers = new Set<CanvasPeer>();
    private flushTimer?: ReturnType<typeof setTimeout>;
    private focusSequence = 0;

    constructor(private readonly config: ResolvedConfig, private readonly db: BackendDatabase, events: BackendEventBus) {
        this.unsubscribe = events.subscribe((event) => {
            if (event.type !== "canvas.updated") return;
            for (const [socket, peer] of this.sockets) {
                if (!event.entityId || event.entityId === peer.projectId) this.send(socket, { type: "canvas.event", event });
            }
        });
        this.heartbeat = setInterval(() => {
            for (const [socket, peer] of this.sockets) {
                if (peer.missedPongs >= 2) { socket.close(1001, "heartbeat timeout"); continue; }
                peer.missedPongs++;
                if (socket.readyState === WebSocket.OPEN) socket.ping();
            }
        }, 15_000);
        this.heartbeat.unref();
    }

    attach(server: Server) {
        server.on("upgrade", (request, socket, head) => this.upgrade(request, socket as Socket, head));
    }

    participants(projectId: string) {
        return [...this.sockets.values()].filter((peer) => peer.projectId === projectId).map((peer) => this.publicPeer(peer));
    }

    /** 浏览器当前打开且最近聚焦的画布；这是临时默认上下文，不属于 MCP 会话状态。 */
    focusedProjectId() {
        const peers = [...this.sockets.values()];
        const focused = peers.filter((peer) => peer.focused);
        const focusedProject = focused.sort((a, b) => b.focusSequence - a.focusSequence)[0]?.projectId;
        if (focusedProject) return focusedProject;
        const connectedProjects = [...new Set(peers.map((peer) => peer.projectId))];
        return connectedProjects.length === 1 ? connectedProjects[0] : null;
    }

    close() {
        this.unsubscribe();
        clearInterval(this.heartbeat);
        clearTimeout(this.flushTimer);
        for (const socket of this.sockets.keys()) socket.close(1001, "server shutting down");
        this.wss.close();
    }

    private upgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
        const url = new URL(request.url || "/", "http://localhost");
        if (url.pathname !== "/canvas/realtime") { socket.destroy(); return; }
        const projectId = url.searchParams.get("projectId") || "";
        const clientId = url.searchParams.get("clientId") || "";
        const denied = request.headers.origin && !this.config.origins.includes(request.headers.origin);
        const status = denied ? 403 : url.searchParams.get("token") !== this.config.token ? 401 : !projectId || !clientId ? 400 : this.db.getCanvasProjectRevision(projectId) === null ? 404 : 0;
        if (status) {
            socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
            return;
        }
        const hash = [...clientId].reduce((value, char) => (value * 31 + char.charCodeAt(0)) | 0, 0);
        const peer: CanvasPeer = { projectId, clientId, connectionId: randomUUID(), label: url.searchParams.get("label") || "浏览器画布", color: colors[Math.abs(hash) % colors.length], selectedNodeIds: [], focused: false, focusSequence: 0, revision: 0, missedPongs: 0 };
        this.wss.handleUpgrade(request, socket, head, (ws) => this.connect(ws, peer));
    }

    private connect(socket: WebSocket, peer: CanvasPeer) {
        this.sockets.set(socket, peer);
        socket.on("pong", () => { peer.missedPongs = 0; });
        socket.on("message", (data) => this.receive(socket, data));
        socket.on("close", () => {
            this.sockets.delete(socket);
            this.pendingPeers.delete(peer);
            this.broadcast(peer.projectId, { type: "presence.leave", projectId: peer.projectId, connectionId: peer.connectionId });
        });
        socket.on("error", () => socket.terminate());
        this.send(socket, { type: "presence", projectId: peer.projectId, participants: this.participants(peer.projectId) });
        this.broadcast(peer.projectId, { type: "presence.peer", projectId: peer.projectId, peer: this.publicPeer(peer) }, socket);
    }

    private receive(socket: WebSocket, data: RawData) {
        const peer = this.sockets.get(socket);
        if (!peer) return;
        let message: unknown;
        try { message = JSON.parse(data.toString()); } catch { return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) return;
        const record = message as Record<string, unknown>;
        if (record.type === "subscribe") {
            try { this.send(socket, { type: "canvas.sync", ...this.db.readCanvasChanges(peer.projectId, Number(record.afterRevision)) }); }
            catch (error) { this.send(socket, { type: "canvas.error", message: error instanceof Error ? error.message : String(error) }); }
            return;
        }
        if (record.type === "ack" && Number.isSafeInteger(record.revision) && Number(record.revision) >= peer.revision) {
            peer.revision = Math.min(Number(record.revision), this.db.getCanvasProjectRevision(peer.projectId) ?? 0);
            return;
        }
        const parsed = presence.safeParse(message);
        if (!parsed.success) return;
        peer.cursor = parsed.data.cursor || undefined;
        peer.selectedNodeIds = parsed.data.selectedNodeIds;
        peer.drag = parsed.data.drag;
        peer.textSelection = parsed.data.textSelection || undefined;
        if (parsed.data.focused !== undefined) {
            peer.focused = parsed.data.focused;
            if (peer.focused) peer.focusSequence = ++this.focusSequence;
        }
        this.pendingPeers.add(peer);
        if (!this.flushTimer) this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            for (const changed of this.pendingPeers) this.broadcast(changed.projectId, { type: "presence.peer", projectId: changed.projectId, peer: this.publicPeer(changed) });
            this.pendingPeers.clear();
        }, 50);
    }

    private send(socket: WebSocket, payload: unknown) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    }

    private publicPeer({ missedPongs: _, focusSequence: __, ...peer }: CanvasPeer) {
        return peer;
    }

    private broadcast(projectId: string, payload: unknown, except?: WebSocket) {
        for (const [socket, peer] of this.sockets) if (peer.projectId === projectId && socket !== except) this.send(socket, payload);
    }
}
