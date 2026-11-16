import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendDatabase } from "./db.js";
import { startServer } from "./server.js";
import { createStores } from "./stores/index.js";

test("结构化前端设置统一读写 SQLite", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "infinite-canvas-settings-"));
    const database = new BackendDatabase(path.join(dir, "runtime.sqlite"));
    const stores = createStores(database);
    stores.settings.set("frontend.settings", { locale: "zh-CN" });
    const { app, events } = startServer(database, { url: "http://127.0.0.1", token: "test-token", port: 0, origins: ["*"] }, { stores });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const request = (pathname: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${pathname}`, {
        ...init,
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json", ...init?.headers },
    });

    try {
        const initial = await request("/settings");
        assert.equal(initial.status, 200);
        assert.deepEqual((await initial.json() as { settings: unknown }).settings, { locale: "zh-CN" });

        const updated = await request("/settings/data/webdav", { method: "PUT", body: JSON.stringify({ value: { url: "https://dav.example" } }) });
        assert.equal(updated.status, 200);
        assert.deepEqual(stores.settings.get("webdav.config"), { url: "https://dav.example" });
        assert.equal(events.since().at(-1)?.entityId, "webdav.config");

        const loaded = await request("/settings/data/webdav");
        assert.deepEqual((await loaded.json() as { value: unknown }).value, { url: "https://dav.example" });

        const unknown = await request("/settings/data/unknown");
        assert.equal(unknown.status, 404);

        // 执行引擎：设置页写 engine.config，engine-client 立即按新值生效（不用重启）
        const engineSaved = await request("/settings/data/engine", { method: "PUT", body: JSON.stringify({ value: { url: "http://127.0.0.1:8300", token: "" } }) });
        assert.equal(engineSaved.status, 200);
        assert.deepEqual(stores.settings.get("engine.config"), { url: "http://127.0.0.1:8300", token: "" });

        const engineLoaded = await request("/settings/data/engine");
        assert.deepEqual((await engineLoaded.json() as { value: unknown }).value, { url: "http://127.0.0.1:8300", token: "" });

        // 状态接口：未开探测时只回开关与地址
        const status = await request("/api/engine/status");
        assert.equal(status.status, 200);
        const statusBody = await status.json() as { enabled: boolean; url: string | null };
        assert.equal(statusBody.enabled, true);
        assert.equal(statusBody.url, "http://127.0.0.1:8300");
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        database.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("执行引擎「测试连接」：真打引擎 /health 与 /v1/models（用假引擎验路由与回包）", async () => {
    const http = await import("node:http");
    const fake = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const send = (payload: unknown) => {
            const text = JSON.stringify(payload);
            res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
            res.end(text);
        };
        if (url.pathname === "/health") return send({ ok: true });
        if (url.pathname === "/v1/models") return send({ object: "list", data: [{ id: "a" }, { id: "b" }] });
        return send({});
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const fakePort = (fake.address() as AddressInfo).port;
    const dir = mkdtempSync(path.join(tmpdir(), "infinite-canvas-engine-"));
    const database = new BackendDatabase(path.join(dir, "runtime.sqlite"));
    const stores = createStores(database);
    const { app } = startServer(database, { url: "http://127.0.0.1", token: "test-token", port: 0, origins: ["*"] }, { stores });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const call = (pathname: string) => fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { Authorization: "Bearer test-token" } });
    try {
        const probed = await call(`/api/engine/status?probe=1&url=http://127.0.0.1:${fakePort}`);
        const body = await probed.json() as { ok: boolean; models?: number; target: string };
        assert.equal(probed.status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.models, 2, "应能数到假引擎的模型数");
        assert.equal(body.target, `http://127.0.0.1:${fakePort}`);

        const failed = await (await call("/api/engine/status?probe=1&url=http://127.0.0.1:1")).json() as { ok: boolean; error?: string };
        assert.equal(failed.ok, false);
        assert.ok(failed.error);
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await new Promise<void>((resolve) => fake.close(() => resolve()));
        database.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
