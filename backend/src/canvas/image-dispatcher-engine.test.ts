import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { CanvasImageDispatcher } from "./image-dispatcher.js";
import { CanvasEngineClient } from "./engine-client.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

/** 只实现图片链路用到的三个端点的假引擎。 */
async function startFakeEngine(seen: Array<Record<string, unknown>>) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const json = (status: number, body: unknown) => {
                const text = JSON.stringify(body);
                res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
                res.end(text);
            };
            if (url.pathname.startsWith("/v1/models/")) {
                return json(200, {
                    id: "custom/pipe.json", title: "管线", run_target: "local",
                    fields: [
                        { id: "prompt", node: "1", input: "text", name: "提示词", type: "text", isPrompt: true },
                        { id: "width", node: "2", input: "width", name: "宽", type: "number" },
                        { id: "height", node: "2", input: "height", name: "高", type: "number" },
                    ],
                    image_input: { counts: [0, 1], field_ids: ["image1"] },
                });
            }
            if (url.pathname === "/v1/images/generations") {
                seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                return json(200, { created: 1, task_id: "engine-1", data: [{ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/media/image%3Aabc` }] });
            }
            if (url.pathname === "/media/image%3Aabc") {
                res.writeHead(200, { "content-type": "image/png", "content-length": String(PNG.length) });
                return res.end(PNG);
            }
            return json(404, { error: { message: "not found" } });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function makeDispatcher(engineUrl: string | undefined) {
    const db = new BackendDatabase(":memory:");
    const stores = createStores(db);
    stores.settings.set("ai.config", {
        channels: engineUrl
            ? [{ id: "eng", kind: "engine", baseUrl: engineUrl, models: [{ name: "pipe.json", capability: "image" }] }]
            : [],
    });
    // 父任务必须在跑，否则 assertNotCancelled/回写路径会当成已取消
    stores.tasks.create("canvas-parent", "canvas-image", {}, {});
    stores.tasks.update("canvas-parent", { status: "running" });
    const dispatcher = new CanvasImageDispatcher(
        { url: "http://127.0.0.1:17370", token: "t", port: 17370, origins: [] } as never,
        stores,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
    );
    return { db, stores, dispatcher };
}

test.skip("TODO(引擎渠道): 图片分发：配置引擎后走 /v1/images/generations，产物入库为画布媒体", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fake = await startFakeEngine(seen);
    const { db, stores, dispatcher } = makeDispatcher(fake.url);
    try {
        const result = await (dispatcher as unknown as {
            dispatchWorkflowViaEngine: (input: unknown, taskId: string, workflow: string) => Promise<{ taskId: string; media: Array<{ storageKey: string; url: string; mimeType: string }> }>;
        }).dispatchWorkflowViaEngine(
            {
                projectId: "p", nodeId: "n", model: "ch1::custom/pipe.json", prompt: "一只猫",
                params: { width: 768, height: 1024 }, references: [], loopInputImages: [],
            },
            "canvas-parent",
            "custom/pipe.json",
        );

        assert.equal(result.taskId, "canvas-parent");
        assert.equal(result.media.length, 1);
        assert.match(result.media[0].storageKey, /^(image|output):/);
        assert.equal(result.media[0].mimeType, "image/png");
        assert.deepEqual(await stores.media.read(result.media[0].storageKey), PNG, "产物应真的落在画布媒体库");

        assert.equal(seen.length, 1);
        assert.equal(seen[0].model, "custom/pipe.json");
        assert.equal(seen[0].prompt, "一只猫");
        assert.deepEqual(seen[0].fields, { prompt: "一只猫", width: 768, height: 1024 }, "画布只发字段值，不做图注入");
        assert.equal("images" in seen[0], false, "无参考图时不应带 images");
    } finally {
        db.close();
        await fake.close();
    }
});

test.skip("TODO(引擎渠道): 图片分发：未配置引擎时不走 HTTP 路径", () => {
    const { db, dispatcher } = makeDispatcher(undefined);
    try {
        const shouldUse = (dispatcher as unknown as { shouldDispatchToEngine: (input: unknown) => boolean }).shouldDispatchToEngine({ model: "ch1::custom/pipe.json" });
        assert.equal(shouldUse, false);
    } finally {
        db.close();
    }
});

test.skip("TODO(引擎渠道): 图片分发：蒙版编辑与 flux2-klein 仍回落本地执行器", () => {
    const { db, dispatcher } = makeDispatcher("http://127.0.0.1:9");
    try {
        const gate = (input: unknown) => (dispatcher as unknown as { shouldDispatchToEngine: (input: unknown) => boolean }).shouldDispatchToEngine(input);
        assert.equal(gate({ model: "ch1::custom/pipe.json", maskEdit: true }), false, "蒙版编辑要改本地图");
        assert.equal(gate({ model: "ch1::custom/Flux2-Klein.json" }), false, "klein 适配仍在画布侧");
        assert.equal(gate({ model: "ch1::custom/pipe.json" }), true);
    } finally {
        db.close();
    }
});

test.skip("TODO(引擎渠道): 引擎客户端用「现读设置」的函数注入：保存后立刻按新配置建客户端（不用重启）", () => {
    const db = new BackendDatabase(":memory:");
    try {
        const stores = createStores(db);
        let created = 0;
        const dispatcher = new CanvasImageDispatcher(
            { url: "http://127.0.0.1:17370", token: "t", port: 17370, origins: [] } as never,
            stores,
            {} as never, {} as never, {} as never, {} as never, undefined, undefined,
            () => {
                const client = CanvasEngineClient.fromSettings(stores.settings);
                if (client) created += 1;
                return client;
            },
        );
        const shouldDispatch = (dispatcher as unknown as { shouldDispatchToEngine: (input: unknown) => boolean }).shouldDispatchToEngine;
        // 还没配 → 不走引擎
        assert.equal(shouldDispatch.call(dispatcher, { model: "2.1", prompt: "x" }), false);
        // 设置页保存后（同一个 dispatcher 实例）立刻生效
        stores.settings.set("engine.config", { url: "http://127.0.0.1:8300", token: "" });
        assert.equal(shouldDispatch.call(dispatcher, { model: "2.1", prompt: "x" }), true);
        assert.ok(created >= 1);
        // 清空后立刻关闭
        stores.settings.set("engine.config", { url: "", token: "" });
        assert.equal(shouldDispatch.call(dispatcher, { model: "2.1", prompt: "x" }), false);
    } finally {
        db.close();
    }
});
