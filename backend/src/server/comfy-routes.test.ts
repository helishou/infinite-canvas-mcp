import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";

import type { ComfyUiBackend } from "../comfyui/bridge.js";
import type { Stores } from "../stores/types.js";
import type { ResolvedConfig } from "../config.js";
import { registerComfyRoutes } from "./comfy-routes.js";

function mockBridge(modelsCalls: { count: number }) {
    let url = "http://comfy.example";
    return {
        models: async () => { modelsCalls.count += 1; return { loras: ["a.safetensors"], checkpoints: ["b.safetensors"] }; },
        getUrl: () => url,
        setUrl: (next: string) => { url = next; return url; },
        status: async () => ({ online: false }),
    } as unknown as ComfyUiBackend;
}

function buildApp(bridge: ComfyUiBackend) {
    const app = express();
    app.use(express.json());
    registerComfyRoutes({ app, stores: {} as Stores, config: { url: "", token: "", port: 0, origins: [] } as ResolvedConfig }, bridge);
    return app;
}

test("comfy/models 命中短 TTL 缓存时不重复读取清单，URL 变化后失效", async () => {
    const calls = { count: 0 };
    const app = buildApp(mockBridge(calls));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
        const first = await (await fetch(`${base}/comfy/models`)).json() as { ok: boolean; data: { loras: string[] } };
        assert.equal(first.ok, true);
        assert.deepEqual(first.data.loras, ["a.safetensors"]);
        assert.equal(calls.count, 1);

        // TTL 内第二次请求走缓存，不重新读取
        await (await fetch(`${base}/comfy/models`)).json();
        assert.equal(calls.count, 1);

        // 切换 ComfyUI URL 后缓存失效，下一次请求重新读取
        const switched = await (await fetch(`${base}/comfy/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://other.example" }) })).json() as { ok: boolean; url: string };
        assert.equal(switched.ok, true);
        assert.equal(switched.url, "http://other.example");
        await (await fetch(`${base}/comfy/models`)).json();
        assert.equal(calls.count, 2);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("comfy/models 在途并发请求合并为一次读取", async () => {
    const calls = { count: 0 };
    let resolveModels: ((catalog: unknown) => void) | undefined;
    const bridge = {
        models: () => new Promise((resolve) => { calls.count += 1; resolveModels = resolve as (c: unknown) => void; }),
        getUrl: () => "http://comfy.example",
        setUrl: (next: string) => next,
        status: async () => ({ online: false }),
    } as unknown as ComfyUiBackend;
    const app = buildApp(bridge);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
        const pending = [fetch(`${base}/comfy/models`), fetch(`${base}/comfy/models`), fetch(`${base}/comfy/models`)];
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        assert.equal(calls.count, 1);
        resolveModels!({ loras: ["a.safetensors"], checkpoints: [] });
        const results = await Promise.all(pending);
        assert.equal(calls.count, 1);
        for (const response of results) {
            assert.equal(response.status, 200);
            assert.equal((await response.json() as { ok: boolean }).ok, true);
        }
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("comfy/models 读取失败不缓存，下一次请求重新读取", async () => {
    const calls = { count: 0 };
    const bridge = {
        models: async () => { calls.count += 1; if (calls.count === 1) throw new Error("comfy 暂时不可达"); return { loras: [] }; },
        getUrl: () => "http://comfy.example",
        setUrl: (next: string) => next,
        status: async () => ({ online: false }),
    } as unknown as ComfyUiBackend;
    const app = buildApp(bridge);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
        const failed = await (await fetch(`${base}/comfy/models`)).json() as { ok: boolean; error: string };
        assert.equal(failed.ok, false);
        assert.match(failed.error, /comfy 暂时不可达/);
        assert.equal(calls.count, 1);

        // 失败没有产生缓存：下一次请求重新读取并成功
        const retry = await (await fetch(`${base}/comfy/models`)).json() as { ok: boolean };
        assert.equal(retry.ok, true);
        assert.equal(calls.count, 2);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
