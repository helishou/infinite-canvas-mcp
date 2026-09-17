import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { CanvasRealtimeHub } from "./realtime-hub.js";

test("文本选区只广播同项目，不写文档或 revision；清除和离线及时移除", { timeout: 10_000 }, async () => {
    const db = new BackendDatabase(":memory:"), events = new BackendEventBus();
    db.createCanvasProject({ id: "p", nodes: [], connections: [], globalPrompt: "正文" });
    db.createCanvasProject({ id: "other", nodes: [], connections: [] });
    const before = db.getCanvasProject("p"), commits = db.readCanvasChanges("p", 0);
    const server = createServer();
    const hub = new CanvasRealtimeHub({ url: "http://localhost", port: 0, token: "test", origins: [] }, db, events);
    hub.attach(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const sockets: WebSocket[] = [];
    const connect = async (projectId: string, clientId: string) => {
        const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/canvas/realtime?token=test&projectId=${projectId}&clientId=${clientId}`);
        sockets.push(socket);
        const messages: Record<string, any>[] = [];
        const listeners = new Set<() => void>();
        socket.on("message", (raw) => { messages.push(JSON.parse(raw.toString())); listeners.forEach((listener) => listener()); });
        await once(socket, "open");
        return { socket, messages, wait: (predicate: (message: Record<string, any>) => boolean) => new Promise<Record<string, any>>((resolve) => {
            const check = () => { const message = messages.find(predicate); if (message) { listeners.delete(check); resolve(message); } };
            listeners.add(check); check();
        }) };
    };
    try {
        const a = await connect("p", "a"), b = await connect("p", "b"), c = await connect("other", "c");
        const textSelection = { target: { field: "globalPrompt" }, documentId: "doc", anchor: "relative-a", head: "relative-b" };
        a.socket.send(JSON.stringify({ type: "presence", selectedNodeIds: [], textSelection, revision: 999, color: "forged-color" }));
        const remote = await b.wait((message) => message.type === "presence.peer" && message.peer.clientId === "a" && message.peer.textSelection);
        assert.deepEqual(remote.peer.textSelection, textSelection);
        assert.notEqual(remote.peer.color, "forged-color");
        assert.equal(remote.peer.revision, 0);
        assert.equal(c.messages.some((message) => message.peer?.textSelection), false);
        a.socket.send(JSON.stringify({ type: "presence", selectedNodeIds: [], textSelection: null, cursor: { x: 7, y: 8 } }));
        await b.wait((message) => message.peer?.clientId === "a" && message.peer.cursor?.x === 7 && !message.peer.textSelection);
        a.socket.close();
        await b.wait((message) => message.type === "presence.leave" && message.connectionId === remote.peer.connectionId);
        assert.equal(hub.participants("p").some((peer) => peer.clientId === "a"), false);
        assert.deepEqual(db.getCanvasProject("p"), before);
        assert.deepEqual(db.readCanvasChanges("p", 0), commits);
        assert.equal(events.since().length, 0);
    } finally {
        sockets.forEach((socket) => socket.terminate()); hub.close();
        await new Promise<void>((resolve) => server.close(() => resolve())); db.close();
    }
});
