import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Request } from "express";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";
import { applyNetworkSettings, isLocalConnection, NETWORK_SETTINGS_KEY, parseNetworkSettings } from "./connection-routes.js";

test("仅实际本机 socket、Host 和网页来源都属于本机时允许自动密钥发现", () => {
    const req = (remoteAddress: string, host: string, origin?: string) => ({ socket: { remoteAddress }, headers: { host, origin, "x-forwarded-for": "127.0.0.1" } }) as unknown as Pick<Request, "socket" | "headers">;
    assert.equal(isLocalConnection(req("127.0.0.1", "localhost:17370")), true);
    assert.equal(isLocalConnection(req("::ffff:127.0.0.1", "127.0.0.1:17370", "http://localhost:3001")), true);
    assert.equal(isLocalConnection(req("192.168.1.22", "localhost:17370")), false);
    assert.equal(isLocalConnection(req("127.0.0.1", "192.168.1.22:17370")), false);
    assert.equal(isLocalConnection(req("127.0.0.1", "localhost:17370", "http://192.168.1.22:3001")), false);
});

test("来源只接受准确 origin，保留本机入口，不支持路径/通配符/内嵌凭证", () => {
    for (const origin of ["*", "https://user:secret@example.com", "http://x/path", "http://x?token=secret", "file:///tmp", "http://x#foo"]) {
        assert.throws(() => parseNetworkSettings({ lanEnabled: true, origins: [origin] }));
    }
    assert.throws(() => parseNetworkSettings({ lanEnabled: "true", origins: [] }));
    const value = parseNetworkSettings({ lanEnabled: false, origins: [" http://192.168.1.10:3001/ "] });
    assert.deepEqual(value.origins, ["http://127.0.0.1:3001", "http://localhost:3001", "http://192.168.1.10:3001"]);
});

test("远端必须持有密钥；主机设置存 SQLite 等待重启，不热开放或向远端返回密钥", async () => {
    const db = new BackendDatabase(":memory:");
    const origin = "http://192.168.1.10:3001";
    const config = { url: "http://127.0.0.1", token: "test-secret", port: 0, listenHost: "127.0.0.1" as const, origins: ["http://localhost:3001", origin] };
    const { app } = startServer(db, config);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (path: string, method = "GET", remote = false, auth = true, body?: unknown) => fetch(base + path, { method, headers: { ...(auth ? { Authorization: "Bearer test-secret" } : {}), ...(remote ? { Origin: origin } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
        const denied = await call("/config", "GET", true, false);
        assert.equal(denied.status, 401);
        assert.equal((await denied.text()).includes("test-secret"), false);
        assert.equal((await call("/config", "GET", true)).status, 200);
        assert.equal((await call("/config", "GET", false, false)).status, 200);
        assert.equal((await call("/connection", "GET", true, false)).status, 401);
        const remote = await (await call("/connection", "GET", true)).json() as { canConfigure: boolean };
        assert.equal(remote.canConfigure, false);
        assert.equal(JSON.stringify(remote).includes("test-secret"), false);
        const settings = { lanEnabled: true, origins: [origin] };
        assert.equal((await call("/connection", "PUT", true, true, settings)).status, 403);
        const saved = await (await call("/connection", "PUT", false, true, settings)).json() as { restartRequired: boolean; current: { lanEnabled: boolean } };
        assert.equal(saved.restartRequired, true);
        assert.equal(saved.current.lanEnabled, false);
        assert.equal(config.listenHost, "127.0.0.1");
        const next = structuredClone(config);
        applyNetworkSettings(next, db.getSetting(NETWORK_SETTINGS_KEY));
        assert.equal(next.listenHost, "0.0.0.0");
        assert.ok(next.origins.includes(origin));
        const before = db.getSetting(NETWORK_SETTINGS_KEY);
        assert.equal((await call("/connection", "PUT", false, true, { lanEnabled: true, origins: ["*"] })).status, 400);
        assert.deepEqual(db.getSetting(NETWORK_SETTINGS_KEY), before);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
    }
});

test("局域网模式即使经过本机反向代理也不能匿名发现密钥", async () => {
    const db = new BackendDatabase(":memory:");
    const { app } = startServer(db, { url: "http://127.0.0.1", token: "secret", port: 0, listenHost: "0.0.0.0", origins: ["http://localhost:3001"] });
    // 只在隔离测试的 loopback 上监听，模拟代理的本机 socket，不实际开放主机网络。
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/config`;
        const response = await fetch(base);
        assert.equal(response.status, 401);
        assert.equal((await response.text()).includes("secret"), false);
        assert.equal((await fetch(base, { headers: { Authorization: "Bearer secret" } })).status, 200);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
    }
});
