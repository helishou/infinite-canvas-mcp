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
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        database.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
