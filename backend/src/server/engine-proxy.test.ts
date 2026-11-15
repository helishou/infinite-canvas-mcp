import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";

import { registerEngineProxy } from "./engine-proxy.js";
import type { CanvasEngineClient } from "../canvas/engine-client.js";

function start(stub: CanvasEngineClient | undefined) {
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    registerEngineProxy(app, () => stub);
    const server = http.createServer(app);
    return new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
        });
    });
}

/** 只实现代理需要的那一个方法，其余字段不参与断言。 */
function stubClient(seen: Array<{ url: string; method: string; body?: string }>): CanvasEngineClient {
    return {
        url: "http://engine.test",
        proxyFetch: async (url: string, init: { method: string; body?: string }) => {
            seen.push({ url, method: init.method, body: init.body });
            return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ ok: true })) };
        },
    } as unknown as CanvasEngineClient;
}

test("未配置引擎：status 报未启用，代理回 503 并带原因", async () => {
    const { base, close } = await start(undefined);
    try {
        const status = await (await fetch(`${base}/api/engine/status`)).json() as { enabled: boolean; url: string | null };
        assert.deepEqual(status, { enabled: false, url: null });
        const proxy = await fetch(`${base}/api/engine/api/workflows`);
        assert.equal(proxy.status, 503);
        assert.match(String((await proxy.json() as { error: { message: string } }).error.message), /未配置执行引擎/);
    } finally {
        await close();
    }
});

test("配置引擎：转发路径、去掉画布令牌、透传方法与 JSON 体", async () => {
    const seen: Array<{ url: string; method: string; body?: string }> = [];
    const { base, close } = await start(stubClient(seen));
    try {
        const status = await (await fetch(`${base}/api/engine/status`)).json() as { enabled: boolean; url: string };
        assert.equal(status.enabled, true);
        assert.equal(status.url, "http://engine.test");

        // GET：canvas 的 ?token= 不能带到引擎
        const listed = await fetch(`${base}/api/engine/api/workflows/index-tts.json?token=canvas-token`);
        assert.equal(listed.status, 200);
        assert.equal(seen[0].url, "http://engine.test/api/workflows/index-tts.json");
        assert.equal(seen[0].method, "GET");
        assert.equal(seen[0].body, undefined);

        // 保留业务查询参数，只剥 token
        await fetch(`${base}/api/engine/api/tasks?token=canvas-token&limit=5`);
        assert.equal(seen[1].url, "http://engine.test/api/tasks?limit=5");

        // POST：JSON 体原样转发
        await fetch(`${base}/api/engine/api/workflows/index-tts.json/title?token=canvas-token`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "改名·中文" }),
        });
        assert.equal(seen[2].method, "PUT");
        assert.equal(seen[2].url, "http://engine.test/api/workflows/index-tts.json/title");
        assert.deepEqual(JSON.parse(String(seen[2].body)), { title: "改名·中文" });
    } finally {
        await close();
    }
});
