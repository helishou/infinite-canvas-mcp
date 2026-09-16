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
