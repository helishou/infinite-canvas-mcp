import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";

test("shutdown flushes active reads and ends Backend and Agent SSE without waiting for keep-alive", async t => {
    const db = new BackendDatabase(":memory:");
    const { app, drainHttpConnections } = startServer(db, { url: "http://127.0.0.1", token: "test", port: 0, origins: [] });
    let releaseRead: () => void = () => {};
    let readStarted: () => void = () => {};
    const receivedRead = new Promise<void>(resolve => { readStarted = resolve; });
    app.get("/pending-read", (_req, res) => {
        releaseRead = () => res.json({ ok: true, data: "complete response" });
        readStarted();
    });
    app.get("/agent/events", (_req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.flushHeaders();
    });
    const server = app.listen(0, "127.0.0.1");
    server.keepAliveTimeout = 30_000;
    await once(server, "listening");
    t.after(() => { server.closeAllConnections(); server.close(); db.close(); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const streams = await Promise.all(["/events", "/agent/events"].map(path => fetch(url + path, { headers: { Authorization: "Bearer test" } })));
    for (const stream of streams) assert.equal(stream.status, 200);
    const pendingRead = fetch(url + "/pending-read", { headers: { Authorization: "Bearer test" } }).then(response => response.json());
    await receivedRead;
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    const startedAt = performance.now();
    drainHttpConnections();
    drainHttpConnections();
    releaseRead();
    assert.deepEqual(await pendingRead, { ok: true, data: "complete response" });
    await Promise.all(streams.map(stream => stream.text()));
    await closed;
    assert.equal(server.listening, false);
    assert.ok(performance.now() - startedAt < 2_000, "closing SSE must not wait for the HTTP keep-alive timeout");
});
