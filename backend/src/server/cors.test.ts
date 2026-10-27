import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { startServer } from "../server.js";

test("Backend 只向允许的网页来源暴露连接 token", async () => {
    const db = new BackendDatabase(":memory:");
    const allowedOrigin = "http://127.0.0.1:3001";
    const { app } = startServer(db, { url: "http://127.0.0.1", token: "test-secret", port: 0, origins: [allowedOrigin] });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
        const rejected = await fetch(`${url}/config`, { headers: { Origin: "https://evil.example" } });
        assert.equal(rejected.status, 403);
        assert.equal((await rejected.text()).includes("test-secret"), false);

        const allowed = await fetch(`${url}/config`, { headers: { Origin: allowedOrigin } });
        assert.equal(allowed.status, 200);
        assert.equal(allowed.headers.get("access-control-allow-origin"), allowedOrigin);
        assert.equal((await allowed.json() as { token: string }).token, "test-secret");

        const localProcess = await fetch(`${url}/config`);
        assert.equal(localProcess.status, 200);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
    }
});

test("开启局域网绑定(0.0.0.0)时，本机回环客户端不带密钥仍能读取 /config 密钥", async () => {
    const db = new BackendDatabase(":memory:");
    const allowedOrigin = "http://127.0.0.1:3001";
    const { app } = startServer(db, { url: "http://127.0.0.1", token: "secret-lan", port: 0, listenHost: "0.0.0.0", origins: [allowedOrigin] });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
        // 真·本机来源（socket 对端为回环），无 Bearer：修复后应直接披露，
        // 而不是像旧实现那样把本机也挡在「请手动提供后台密钥」后面。
        const local = await fetch(`${url}/config`, { headers: { Origin: allowedOrigin } });
        assert.equal(local.status, 200);
        assert.equal((await local.json() as { token: string }).token, "secret-lan");

        // 放宽本机披露不能削弱 CORS/来源边界：外部来源依旧被拒且不泄漏密钥。
        const foreign = await fetch(`${url}/config`, { headers: { Origin: "https://evil.example" } });
        assert.notEqual(foreign.status, 200);
        assert.equal((await foreign.text()).includes("secret-lan"), false);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
    }
});
