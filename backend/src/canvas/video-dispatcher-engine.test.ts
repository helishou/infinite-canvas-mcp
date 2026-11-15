import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { CanvasVideoDispatcher } from "./video-dispatcher.js";
import { CanvasEngineClient } from "./engine-client.js";

const MP4 = Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex");

/** 假引擎：模型详情 + 异步视频任务 + 带鉴权的媒体下载。 */
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
            const authorized = String(req.headers.authorization ?? "") === "Bearer t0ken";
            if (url.pathname.startsWith("/v1/models/")) {
                return json(200, {
                    id: "custom/pipe.json", title: "视频管线", run_target: "local",
                    fields: [
                        { id: "prompt", node: "1", input: "text", name: "提示词", type: "text", isPrompt: true },
                        { id: "image1", node: "2", input: "image", name: "首帧", type: "image" },
                        { id: "video1", node: "3", input: "file", name: "参考视频", type: "text" },
                    ],
                    output_nodes: ["9"],
                    image_input: { counts: [0, 1], field_ids: ["image1"] },
                    media_inputs: { images: ["image1"], videos: ["video1"], audios: [] },
                });
            }
            if (url.pathname === "/v1/videos" && req.method === "POST") {
                seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                return json(202, { id: "engine-video-1", object: "video", status: "queued" });
            }
            if (url.pathname === "/v1/videos/engine-video-1") {
                return json(200, {
                    id: "engine-video-1", object: "video", status: "succeeded", progress: 1,
                    urls: [`http://127.0.0.1:${(server.address() as { port: number }).port}/media/video%3Aabc`],
                    media: [{ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/media/video%3Aabc`, storage_key: "video:abc", mime_type: "video/mp4", filename: "o.mp4" }],
                });
            }
            if (url.pathname === "/media/video%3Aabc") {
                if (!authorized) return json(401, { error: { message: "鉴权失败" } });
                res.writeHead(200, { "content-type": "video/mp4", "content-length": String(MP4.length) });
                return res.end(MP4);
            }
            return json(404, { error: { message: "not found" } });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function makeDispatcher(engineUrl?: string) {
    const db = new BackendDatabase(":memory:");
    const stores = createStores(db);
    stores.tasks.create("canvas-video-parent", "canvas-video", {}, {});
    stores.tasks.update("canvas-video-parent", { status: "running" });
    const dispatcher = new CanvasVideoDispatcher(
        stores,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        engineUrl ? new CanvasEngineClient(engineUrl, "t0ken") : undefined,
    );
    return { db, stores, dispatcher };
}

test("视频分发：走 /v1/videos 异步协议，字段与媒体槽由引擎提供，产物入库为画布媒体", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fake = await startFakeEngine(seen);
    const { db, stores, dispatcher } = makeDispatcher(fake.url);
    try {
        const plan = {
            kind: "workflow" as const,
            workflow: "custom/pipe.json",
            input: {
                projectId: "p", nodeId: "n", model: "ch1::custom/pipe.json",
                prompt: "镜头推进", seconds: "6.5", size: "1280x720",
                references: [], videoReferences: [], audioReferences: [],
                params: { 步数: 8 },
            },
        };
        const media = await (dispatcher as unknown as {
            dispatchVideoViaEngine: (plan: unknown, taskId: string) => Promise<Record<string, unknown>>;
        }).dispatchVideoViaEngine(plan, "canvas-video-parent");

        assert.equal(media.mimeType, "video/mp4");
        assert.match(String(media.storageKey), /^(video|output):/);
        assert.deepEqual(await stores.media.read(String(media.storageKey)), MP4, "产物应真的落在画布媒体库");

        assert.equal(seen.length, 1);
        assert.equal(seen[0].model, "custom/pipe.json");
        assert.equal(seen[0].prompt, "镜头推进");
        assert.equal(seen[0].seconds, "6.5", "秒数透传给引擎，由它按 durationTarget 注入");
        assert.equal(seen[0].size, "1280x720");
        assert.equal((seen[0].fields as Record<string, unknown>).步数, 8, "手填字段原样透传");
        assert.equal((seen[0].fields as Record<string, unknown>).prompt, "镜头推进");
    } finally {
        db.close();
        await fake.close();
    }
});

test("视频分发：未配置引擎时 plan 不进入引擎分支", () => {
    const { db, dispatcher } = makeDispatcher(undefined);
    try {
        const hasClient = (dispatcher as unknown as { engineClient?: unknown }).engineClient;
        assert.equal(hasClient, undefined);
    } finally {
        db.close();
    }
});
