import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { CanvasEngineClient, EngineRequestError, importEngineMedia } from "./engine-client.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

/** 假执行引擎：只实现 /v1/models/{id}、/v1/images/generations、/media/{key}。 */
async function startFakeEngine() {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
            calls.push({ path: url.pathname, body });
            const send = (status: number, payload: unknown, type = "application/json") => {
                const text = type === "application/json" ? JSON.stringify(payload) : String(payload);
                res.writeHead(status, { "content-type": type, "content-length": String(Buffer.byteLength(text)) });
                res.end(text);
            };
            if (url.pathname === "/v1/models/pipe.json") {
                return send(200, {
                    id: "pipe.json", title: "管线", run_target: "local", output_nodes: ["9"],
                    fields: [{ id: "prompt", node: "1", input: "text", name: "提示词", type: "text", isPrompt: true }],
                    image_input: { counts: [0, 1], field_ids: ["image1"] },
                });
            }
            if (url.pathname === "/v1/images/generations") {
                return send(200, {
                    created: 1,
                    task_id: "engine-task-1",
                    data: [{ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/media/output%3Aabc` }],
                });
            }
            if (url.pathname === "/media/output%3Aabc" || url.pathname === "/media/output:abc") {
                res.writeHead(200, { "content-type": "image/png", "content-length": String(PNG.length) });
                return res.end(PNG);
            }
            if (url.pathname.endsWith("/cancel")) return send(200, { id: "engine-task-1", status: "cancelled" });
            return send(404, { error: { message: "not found" } });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        calls,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

test("引擎客户端：读模型能力、发图片请求、取消任务", async () => {
    const fake = await startFakeEngine();
    try {
        const client = new CanvasEngineClient(fake.url, "secret");
        const info = await client.modelInfo("pipe.json");
        assert.equal(info.id, "pipe.json");
        assert.deepEqual(info.fields.map((field) => field.id), ["prompt"]);
        assert.deepEqual(info.imageInput.counts, [0, 1]);
        assert.deepEqual(info.imageInput.fieldIds, ["image1"]);

        const started = await client.generateImages({ model: "pipe.json", prompt: "一只猫", fields: { prompt: "一只猫" }, images: ["data:image/png;base64,AAA"] });
        assert.equal(started.taskId, "engine-task-1");
        assert.equal(started.media.length, 1);
        const request = fake.calls.find((call) => call.path === "/v1/images/generations")?.body as Record<string, unknown>;
        assert.equal(request.model, "pipe.json");
        assert.deepEqual(request.fields, { prompt: "一只猫" });
        assert.deepEqual(request.images, ["data:image/png;base64,AAA"]);

        await client.cancel("engine-task-1");
        assert.ok(fake.calls.some((call) => call.path === "/v1/tasks/engine-task-1/cancel"));

        const missing = await client.modelInfo("nope.json").catch((error) => error);
        assert.ok(missing instanceof EngineRequestError);
        assert.equal((missing as EngineRequestError).status, 404);
    } finally {
        await fake.close();
    }
});

test("引擎客户端：未配置 engine.url 时不启用", () => {
    const db = new BackendDatabase(":memory:");
    const previous = { url: process.env.CANVAS_ENGINE_URL, token: process.env.CANVAS_ENGINE_TOKEN };
    delete process.env.CANVAS_ENGINE_URL;
    delete process.env.CANVAS_ENGINE_TOKEN;
    try {
        const stores = createStores(db);
        assert.equal(CanvasEngineClient.fromSettings(stores.settings), null);
        // 环境变量（部署方显式选择）也能启用
        process.env.CANVAS_ENGINE_URL = "http://127.0.0.1:8189";
        assert.equal(CanvasEngineClient.fromSettings(stores.settings)?.url, "http://127.0.0.1:8189");
        // 设置项优先于环境变量
        stores.settings.set("engine.url", "http://127.0.0.1:9000/");
        stores.settings.set("engine.token", "t");
        const client = CanvasEngineClient.fromSettings(stores.settings);
        assert.ok(client);
        assert.equal(client!.url, "http://127.0.0.1:9000");
    } finally {
        if (previous.url === undefined) delete process.env.CANVAS_ENGINE_URL; else process.env.CANVAS_ENGINE_URL = previous.url;
        if (previous.token === undefined) delete process.env.CANVAS_ENGINE_TOKEN; else process.env.CANVAS_ENGINE_TOKEN = previous.token;
        db.close();
    }
});

test("引擎产物落回画布媒体库：下载后再入库，下游拿本地 storageKey", async () => {
    const fake = await startFakeEngine();
    const db = new BackendDatabase(":memory:");
    try {
        const stores = createStores(db);
        const imported = await importEngineMedia(stores.media, [{ url: `${fake.url}/media/output%3Aabc`, mime_type: "image/png", filename: "o.png" }]);
        assert.equal(imported.length, 1);
        assert.equal(imported[0].mimeType, "image/png");
        assert.ok(/^(image|output):/.test(imported[0].storageKey), "落库后必须是画布自己的 storageKey");
        assert.notEqual(imported[0].storageKey, "output:abc", "不能沿用引擎的 storageKey");
        assert.equal(imported[0].url, stores.media.url({ storageKey: imported[0].storageKey } as never));
        assert.deepEqual(await stores.media.read(imported[0].storageKey), PNG);
    } finally {
        db.close();
        await fake.close();
    }
});
